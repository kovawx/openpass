import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { useAuthStore } from './auth';
import { readVault, type VaultSecret } from '@/utils/vault';
import { requireSessionKey } from '@/utils/session';
import { showToast } from '@/utils/ui';
import {
  buildSecretIdentity,
  checkBackupCompatibility,
  createBackupData,
  decryptBackupData,
  migrateBackupData,
  validateBackupData
} from '@/utils/backup';

export type Secret = VaultSecret;

export const useSecretStore = defineStore('secrets', () => {
  const secrets = ref<Secret[]>([]);
  const loading = ref(false);
  let savedState = '[]';
  const searchQuery = ref('');

  const authStore = useAuthStore();
  watch(() => authStore.sessionKey, (key) => { if (!key) secrets.value = []; });

  async function loadSecrets() {
    loading.value = true;
    try {
      secrets.value = await authStore.checkSession() ? await readVault() : [];
      savedState = JSON.stringify(secrets.value);
    } catch (error) {
      secrets.value = [];
      showToast((error as Error).message || '加载密钥失败', 'error');
    } finally {
      loading.value = false;
    }
  }

  async function saveSecrets(options: { triggerSnapshot?: boolean } = {}) {
    await requireSessionKey();
    try {
      const result = await chrome.runtime.sendMessage({
        action: 'saveVault', secrets: secrets.value.map((secret) => ({ ...secret })), expectedSecrets: savedState,
        triggerSnapshot: options.triggerSnapshot === true
      });
      if (result?.error || !result?.success) throw new Error(result?.error || '保存失败');
      secrets.value = result.secrets;
      savedState = JSON.stringify(result.secrets);
    } catch (error) { await loadSecrets(); throw error; }
  }

  async function addSecret(secretData: Omit<Secret, 'id' | 'createdAt' | 'updatedAt'>) {
    const newSecret: Secret = {
      ...secretData,
      id: globalThis.crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    secrets.value.push(newSecret);
    await saveSecrets({ triggerSnapshot: true });
    showToast('密钥已添加', 'success');
    return newSecret;
  }

  async function updateSecret(id: string, updates: Partial<Secret>, expected?: Secret) {
    const index = secrets.value.findIndex((secret) => secret.id === id);
    if (index === -1) {
      throw new Error('此密钥已被删除，请刷新后重新操作');
    }

    if (expected && JSON.stringify(expected) !== JSON.stringify(secrets.value[index])) {
      throw new Error('此密钥已更新，请关闭编辑窗口后重新打开');
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
        id: secret.id || globalThis.crypto.randomUUID(),
        secret: String(secret.secret || '').trim().toUpperCase().replace(/\s/g, ''),
        site: String(secret.site || '').trim().toLowerCase(),
        digits: typeof secret.digits === 'number' ? secret.digits : 6
      };

      const secretIdentity = buildSecretIdentity(normalizedSecret);
      if (!existingSecrets.has(secretIdentity)) {
        if (secrets.value.some((entry) => entry.id === normalizedSecret.id)) normalizedSecret.id = globalThis.crypto.randomUUID();
        normalizedSecret.importedAt = new Date().toISOString();
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
