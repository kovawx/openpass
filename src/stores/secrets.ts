import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useAuthStore } from './auth';
import CryptoUtils from '@/utils/crypto';
import { recordSecretDeletion } from '@/utils/syncMerge';
import { showToast } from '@/utils/ui';
import {
  buildSecretIdentity,
  checkBackupCompatibility,
  createBackupData,
  decryptBackupData,
  getBackupEncryptionSettings,
  migrateBackupData,
  validateBackupData
} from '@/utils/backup';

export interface Secret {
  id: string;
  secret: string;
  site: string;
  name?: string;
  digits?: number;
  period?: number;
  algorithm?: string;
  createdAt?: string;
  updatedAt?: string;
  importedAt?: string;
}

export const useSecretStore = defineStore('secrets', () => {
  const secrets = ref<Secret[]>([]);
  const loading = ref(false);
  const searchQuery = ref('');

  async function loadSecrets() {
    loading.value = true;

    try {
      const authStore = useAuthStore();
      const result = await chrome.storage.local.get<{
        encryptedSecrets?: string;
        secrets?: Secret[];
      }>(['encryptedSecrets', 'secrets']);

      if (typeof result.encryptedSecrets === 'string' && authStore.sessionKey) {
        const decrypted = await CryptoUtils.decrypt(result.encryptedSecrets, authStore.sessionKey);
        const parsed = JSON.parse(decrypted);
        secrets.value = Array.isArray(parsed) ? parsed : [];
      } else if (Array.isArray(result.secrets)) {
        secrets.value = result.secrets;
      } else {
        secrets.value = [];
      }

      // 如果没有 encryptedSecrets 但有 sessionKey，生成一个用于自动备份快速路径
      if (authStore.sessionKey && typeof result.encryptedSecrets !== 'string' && secrets.value.length > 0) {
        console.log('[SecretStore] 自动生成 encryptedSecrets 用于自动备份快速路径');
        await saveSecrets();
      }

      if (!Array.isArray(result.secrets) && secrets.value.length > 0) {
        console.warn('[SecretStore] storage 中 secrets 格式异常，正在修复...');
        const plainSecrets = secrets.value.map((secret) => ({ ...secret }));
        await chrome.storage.local.set({
          secrets: plainSecrets,
          sitesList: plainSecrets.map((secret) => ({ site: secret.site }))
        });
      }
    } catch (error) {
      console.error('加载密钥失败:', error);
      showToast('加载密钥失败', 'error');
      secrets.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function saveSecrets(options: { triggerSnapshot?: boolean } = {}) {
    const authStore = useAuthStore();

    if (!Array.isArray(secrets.value)) {
      console.error('[SecretStore] secrets 不是数组，强制修复');
      secrets.value = [];
    }

    // 脱离 Vue 响应式代理，转为纯数组再写入 storage。
    // 直接写入 reactive 代理对象会被 chrome.storage 序列化破坏数组结构（变对象），
    // 进而在 popup / store 间触发"格式异常"自愈循环。
    const plainSecrets = secrets.value.map((secret) => ({ ...secret }));
    const sitesList = plainSecrets.map((secret) => ({ site: secret.site }));
    const data: {
      secrets: Secret[];
      sitesList: Array<{ site: string }>;
      encryptedSecrets?: string;
      encryptedSecretsForBackup?: string;
    } = {
      secrets: plainSecrets,
      sitesList
    };

    if (authStore.sessionKey) {
      data.encryptedSecrets = await CryptoUtils.encrypt(
        JSON.stringify(plainSecrets),
        authStore.sessionKey
      );

      const encryptionSettings = await getBackupEncryptionSettings();
      if (
        encryptionSettings.enableBackupEncryption &&
        !encryptionSettings.useMasterPasswordForBackup &&
        encryptionSettings.encryptedBackupPassword
      ) {
        try {
          const backupPassword = await CryptoUtils.decrypt(
            encryptionSettings.encryptedBackupPassword,
            authStore.sessionKey
          );
          data.encryptedSecretsForBackup = await CryptoUtils.encrypt(
            JSON.stringify(plainSecrets),
            backupPassword
          );
        } catch {
          console.error('[SecretStore] 无法更新 encryptedSecretsForBackup');
        }
      }
    }

    await chrome.storage.local.set(data);

    if (options.triggerSnapshot) {
      const result = await chrome.runtime.sendMessage({
        action: 'createChangeBackup',
        secrets: plainSecrets
      });
      if (result?.error) throw new Error(result.error);
    }
  }

  async function addSecret(secretData: Omit<Secret, 'id' | 'createdAt' | 'updatedAt'>) {
    const newSecret: Secret = {
      ...secretData,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    secrets.value.push(newSecret);
    await saveSecrets({ triggerSnapshot: true });
    showToast('密钥已添加', 'success');
    return newSecret;
  }

  async function updateSecret(id: string, updates: Partial<Secret>) {
    const index = secrets.value.findIndex((secret) => secret.id === id);
    if (index === -1) {
      return;
    }

    secrets.value[index] = {
      ...secrets.value[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };

    await saveSecrets({ triggerSnapshot: true });
    showToast('密钥已更新', 'success');
  }

  async function deleteSecret(id: string) {
    await recordSecretDeletion(id);
    secrets.value = secrets.value.filter((secret) => secret.id !== id);
    await saveSecrets({ triggerSnapshot: true });
    showToast('密钥已删除', 'success');
  }

  function getFilteredSecrets() {
    if (!searchQuery.value) {
      return secrets.value;
    }

    const query = searchQuery.value.toLowerCase();
    return secrets.value.filter((secret) =>
      secret.site.toLowerCase().includes(query) ||
      secret.name?.toLowerCase().includes(query) ||
      secret.secret.toLowerCase().includes(query)
    );
  }

  function searchSecrets(query: string) {
    if (!query) {
      return secrets.value;
    }

    const lowerQuery = query.toLowerCase();
    return secrets.value.filter((secret) =>
      secret.site.toLowerCase().includes(lowerQuery) ||
      secret.name?.toLowerCase().includes(lowerQuery) ||
      secret.secret.toLowerCase().includes(lowerQuery)
    );
  }

  function getSecretById(id: string) {
    return secrets.value.find((secret) => secret.id === id);
  }

  async function exportSecrets(password?: string): Promise<Blob> {
    const data = await createBackupData(secrets.value, password);
    const json = JSON.stringify(data, null, 2);
    return new Blob([json], { type: 'application/json' });
  }

  async function importSecrets(file: File, password?: string): Promise<number> {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const validation = validateBackupData<Secret>(parsed);

    if (!validation.valid || !validation.data) {
      throw new Error(validation.error || '无效的备份文件格式');
    }

    let backupData = validation.data;

    if (validation.encrypted) {
      if (!password) {
        throw new Error('请输入备份解密密码');
      }

      const decryptedSecrets = await decryptBackupData(backupData, password);
      backupData = {
        ...backupData,
        encrypted: false,
        encryptedData: undefined,
        secrets: decryptedSecrets,
        count: decryptedSecrets.length
      };
    }

    const compatibility = checkBackupCompatibility(backupData.appVersion || '0.0.0');
    if (!compatibility.compatible) {
      throw new Error(compatibility.message);
    }

    if (compatibility.level === 'warning') {
      backupData = migrateBackupData(backupData);
    }

    const importedSecrets = Array.isArray(backupData.secrets) ? backupData.secrets : [];
    const existingSecrets = new Set(secrets.value.map(buildSecretIdentity));
    let count = 0;

    for (const secret of importedSecrets) {
      const normalizedSecret: Secret = {
        ...secret,
        id: secret.id || crypto.randomUUID(),
        secret: String(secret.secret || '').trim().toUpperCase().replace(/\s/g, ''),
        site: String(secret.site || '').trim().toLowerCase(),
        digits: typeof secret.digits === 'number' ? secret.digits : 6
      };

      const secretIdentity = buildSecretIdentity(normalizedSecret);
      if (!existingSecrets.has(secretIdentity)) {
        secrets.value.push(normalizedSecret);
        existingSecrets.add(secretIdentity);
        count += 1;
      }
    }

    if (count > 0) {
      await saveSecrets({ triggerSnapshot: true });
    }

    return count;
  }

  return {
    secrets,
    loading,
    searchQuery,
    loadSecrets,
    saveSecrets,
    addSecret,
    updateSecret,
    deleteSecret,
    getFilteredSecrets,
    searchSecrets,
    getSecretById,
    exportSecrets,
    importSecrets
  };
});
