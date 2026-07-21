<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useSecretStore } from '@/stores/secrets';
import { useAuthStore } from '@/stores/auth';
import { useAutoBackup, type DirectoryInfo } from '@/composables/useAutoBackup';
import { getErrorMessage } from '@/utils/error';
import { showToast } from '@/utils/ui';
import CryptoUtils from '@/utils/crypto';
import {
  getBackupEncryptionSettings,
  resolveStoredBackupPassword
} from '@/utils/backup';
import { getBackupDirectoryAuthorizationAction } from '@/utils/backupDestination';
import {
  DEFAULT_CLOUD_BACKUP_SETTINGS,
  DEFAULT_CLOUD_BACKUP_STATUS,
  getCloudEndpointOriginPattern,
  loadCloudBackupSettings,
  loadCloudBackupStatus,
  saveCloudBackupConfiguration,
  type CloudBackupSettings,
  type CloudBackupStatus
} from '@/utils/cloudBackupSettings';

const secretStore = useSecretStore();
const authStore = useAuthStore();
const autoBackup = useAutoBackup();

const isInitialized = ref(false);

const enableAutoBackup = ref(false);
const backupFrequency = ref<'every5min' | 'daily' | 'weekly' | 'monthly'>('weekly');
const enableLocalSnapshot = ref(true);
const enableDirectoryBackup = ref(false);
const lastBackupTime = ref<string | null>(null);
const nextBackupTime = ref<string | null>(null);

const directoryInfo = ref<DirectoryInfo>({
  hasHandle: false,
  name: null,
  permission: 'no-handle',
  locationLabel: '尚未选择（建议 Downloads/OpenPass）'
});

const showPasswordModal = ref(false);
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const passwordError = ref('');

const enableBackupEncryption = ref(false);
const useMasterPasswordForBackup = ref(true);
const backupPassword = ref('');
const backupPasswordConfirm = ref('');
const backupPasswordError = ref('');

const backingUp = ref(false);
const authorizingDirectory = ref(false);
const cloudSettings = ref<CloudBackupSettings>({ ...DEFAULT_CLOUD_BACKUP_SETTINGS });
const cloudStatus = ref<CloudBackupStatus>({ ...DEFAULT_CLOUD_BACKUP_STATUS });
const cloudAccessKeyId = ref('');
const cloudSecretAccessKey = ref('');
const cloudSessionToken = ref('');
const cloudPassword = ref('');
const cloudPasswordConfirm = ref('');
const savingCloud = ref(false);
const testingCloud = ref(false);
const syncingCloud = ref(false);
const restoringCloud = ref(false);

onMounted(async () => {
  await loadAllSettings();
});

async function loadAllSettings() {
  await autoBackup.loadSettings();
  enableAutoBackup.value = autoBackup.settings.value.enableAutoBackup;
  backupFrequency.value = autoBackup.settings.value.backupFrequency;
  enableLocalSnapshot.value = autoBackup.settings.value.enableLocalSnapshot;
  enableDirectoryBackup.value = autoBackup.settings.value.enableDirectoryBackup;
  lastBackupTime.value = autoBackup.settings.value.lastBackupTime;
  nextBackupTime.value = autoBackup.settings.value.nextBackupTime;

  directoryInfo.value = await autoBackup.getDirectoryInfo();
  if (enableDirectoryBackup.value && directoryInfo.value.permission !== 'granted') {
    enableDirectoryBackup.value = false;
    await autoBackup.saveSettings({ enableDirectoryBackup: false });
  }

  const encryptionResult = await getBackupEncryptionSettings();
  enableBackupEncryption.value = encryptionResult.enableBackupEncryption;
  useMasterPasswordForBackup.value = encryptionResult.useMasterPasswordForBackup;
  cloudSettings.value = await loadCloudBackupSettings();
  cloudStatus.value = await loadCloudBackupStatus();

  isInitialized.value = true;
}

const formattedLastBackupTime = computed(() => {
  if (!lastBackupTime.value) return '从未备份';

  const lastDate = new Date(lastBackupTime.value);
  const now = new Date();
  const diffMs = now.getTime() - lastDate.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));

  if (diffDays > 0) return `${diffDays} 天前`;
  if (diffHours > 0) return `${diffHours} 小时前`;
  return '刚刚';
});

const formattedNextBackupTime = computed(() => {
  if (!enableAutoBackup.value) return '-';
  if (!nextBackupTime.value) return '待执行';

  const nextDate = new Date(nextBackupTime.value);
  const now = new Date();
  const diffMs = nextDate.getTime() - now.getTime();

  if (diffMs <= 0) return '待执行';

  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  const diffHours = Math.floor((diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

  if (diffDays > 0) return `${diffDays} 天后`;
  if (diffHours > 0) return `${diffHours} 小时后`;
  return '即将';
});

async function saveBackupSettings() {
  await autoBackup.saveSettings({
    enableAutoBackup: enableAutoBackup.value,
    backupFrequency: backupFrequency.value,
    enableLocalSnapshot: enableLocalSnapshot.value,
    enableDirectoryBackup: enableDirectoryBackup.value
  });

  if (!enableAutoBackup.value) {
    nextBackupTime.value = null;
    await autoBackup.clearAlarm();
    return;
  }

  const interval = autoBackup.getBackupInterval(backupFrequency.value);
  const last = lastBackupTime.value ? new Date(lastBackupTime.value) : new Date();
  const next = new Date(last.getTime() + interval);
  nextBackupTime.value = next.toISOString();
  await autoBackup.saveSettings({ nextBackupTime: nextBackupTime.value });
  await autoBackup.setupAlarm();
}

const formattedCloudStatus = computed(() => {
  const labels: Record<CloudBackupStatus['state'], string> = {
    disabled: '未启用',
    idle: '等待首次同步',
    pending: '等待解锁后上传',
    syncing: '同步中',
    success: '同步成功',
    conflict: '存在并发冲突',
    error: '同步失败'
  };
  return labels[cloudStatus.value.state];
});

async function handleDirectoryBackupToggle() {
  if (!enableDirectoryBackup.value) {
    await saveBackupSettings();
    return;
  }

  authorizingDirectory.value = true;

  try {
    const action = getBackupDirectoryAuthorizationAction(
      directoryInfo.value.hasHandle,
      directoryInfo.value.permission
    );

    if (action !== 'ready') {
      const result = await autoBackup.selectDirectory();

      directoryInfo.value = await autoBackup.getDirectoryInfo();

      if (!result.success || directoryInfo.value.permission !== 'granted') {
        enableDirectoryBackup.value = false;
        await saveBackupSettings();
        const reason = result.error || '请完成目录写入授权';
        showToast(
          `目录备份未启用：${reason}`,
          result.error === '已取消选择' ? 'warning' : 'error'
        );
        return;
      }
    }

    await saveBackupSettings();
    showToast(`已授权 ${directoryInfo.value.locationLabel}，目录备份已启用`, 'success');
  } catch (error) {
    enableDirectoryBackup.value = false;
    await saveBackupSettings();
    showToast(`目录备份未启用：${getErrorMessage(error, '授权失败')}`, 'error');
  } finally {
    authorizingDirectory.value = false;
  }
}

async function saveEncryptionSettings() {
  await chrome.storage.local.set({
    enableBackupEncryption: enableBackupEncryption.value,
    useMasterPasswordForBackup: useMasterPasswordForBackup.value
  });

  if (!enableBackupEncryption.value || useMasterPasswordForBackup.value) {
    await chrome.storage.local.remove(['encryptedSecretsForBackup']);
  }

  if (enableBackupEncryption.value) {
    showToast(
      useMasterPasswordForBackup.value
        ? '已启用备份加密，将使用主密码'
        : '已启用备份加密，请保存自定义备份密码',
      'success'
    );
  } else {
    showToast('已禁用备份加密', 'success');
  }
}

async function saveBackupPassword() {
  if (!backupPassword.value) {
    backupPasswordError.value = '请输入备份密码';
    return;
  }

  if (backupPassword.value.length < 6) {
    backupPasswordError.value = '密码至少需要 6 个字符';
    return;
  }

  if (backupPassword.value !== backupPasswordConfirm.value) {
    backupPasswordError.value = '两次输入的密码不一致';
    return;
  }

  try {
    if (!authStore.sessionKey) {
      backupPasswordError.value = '请先重新验证主密码';
      return;
    }

    const { hash, salt } = await CryptoUtils.createMasterPasswordHash(backupPassword.value);
    const encryptedBackupPassword = await CryptoUtils.encrypt(
      backupPassword.value,
      authStore.sessionKey
    );

    const storageData: Record<string, string> = {
      backupPasswordHash: hash,
      backupPasswordSalt: salt,
      encryptedBackupPassword
    };

    if (secretStore.secrets.length > 0) {
      storageData.encryptedSecretsForBackup = await CryptoUtils.encrypt(
        JSON.stringify(secretStore.secrets),
        backupPassword.value
      );
    }

    await chrome.storage.local.set(storageData);

    backupPasswordError.value = '';
    backupPassword.value = '';
    backupPasswordConfirm.value = '';
    showToast('备份密码已保存', 'success');
  } catch {
    backupPasswordError.value = '保存失败';
  }
}

async function handleSelectDirectory() {
  const result = await autoBackup.selectDirectory();

  if (result.success) {
    directoryInfo.value = await autoBackup.getDirectoryInfo();
    showToast('目录选择成功', 'success');
  } else if (result.error) {
    showToast(result.error, 'error');
  }
}

async function handleRequestPermission() {
  const result = await autoBackup.requestPermission();

  if (result.success) {
    directoryInfo.value = await autoBackup.getDirectoryInfo();
    showToast('授权成功', 'success');
  } else if (result.error) {
    showToast(result.error, 'error');
  }
}

async function handleBackupNow() {
  if (secretStore.secrets.length === 0) {
    showToast('没有可备份的密钥', 'warning');
    return;
  }

  backingUp.value = true;
  try {
    let password: string | undefined;

    if (enableBackupEncryption.value) {
      const encryptionSettings = await getBackupEncryptionSettings();
      password = await resolveStoredBackupPassword(authStore.sessionKey, encryptionSettings);

      if (!password) {
        showToast(
          encryptionSettings.useMasterPasswordForBackup
            ? '请先验证主密码'
            : '请先在设置中保存备份密码，并保持当前已解锁',
          'error'
        );
        return;
      }
    }

    const results = await autoBackup.performBackup(secretStore.secrets, { password });
    lastBackupTime.value = autoBackup.settings.value.lastBackupTime;
    nextBackupTime.value = autoBackup.settings.value.nextBackupTime;

    const messages = [];
    if (results.snapshot) messages.push('本地快照已保存');
    if (results.directory?.success) messages.push('目录备份成功');
    if (messages.length > 0) showToast(messages.join('，'), 'success');
    if (results.directory && !results.directory.success) {
      showToast(`目录备份失败：${results.directory.error || '未生成备份文件'}`, 'error');
    }
  } finally {
    backingUp.value = false;
  }
}

async function testAutoBackup() {
  const settings = await chrome.storage.local.get([
    'enableBackupEncryption',
    'useMasterPasswordForBackup',
    'encryptedBackupPassword',
    'encryptedSecrets',
    'encryptedSecretsForBackup',
    'secrets'
  ]);

  console.log('[测试] 备份加密设置检查:', {
    enableBackupEncryption: settings.enableBackupEncryption,
    useMasterPasswordForBackup: settings.useMasterPasswordForBackup,
    hasEncryptedBackupPassword: typeof settings.encryptedBackupPassword === 'string',
    hasEncryptedSecrets: typeof settings.encryptedSecrets === 'string',
    hasEncryptedSecretsForBackup: typeof settings.encryptedSecretsForBackup === 'string',
    secretsCount: Array.isArray(settings.secrets) ? settings.secrets.length : 0
  });

  // 触发 background 中的自动备份检查
  try {
    const result = await chrome.runtime.sendMessage({ action: 'testAutoBackup' });
    if (result?.success) {
      showToast(result.message || '自动备份测试完成', 'success');
    } else {
      showToast(result?.error || '自动备份测试未执行', 'error');
    }
  } catch (error) {
    showToast('触发失败: ' + (error as Error).message, 'error');
  }
}

async function refreshCloudStatus() {
  cloudStatus.value = await loadCloudBackupStatus();
}

async function saveCloudSettings() {
  if (!authStore.sessionKey) {
    showToast('请先解锁 OpenPass', 'error');
    return;
  }
  if (cloudPassword.value !== cloudPasswordConfirm.value) {
    showToast('两次输入的云端加密密码不一致', 'error');
    return;
  }

  savingCloud.value = true;
  try {
    const origin = getCloudEndpointOriginPattern(cloudSettings.value.endpoint);
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) throw new Error('未获得 S3 Endpoint 访问权限');

    cloudSettings.value = await saveCloudBackupConfiguration(
      cloudSettings.value,
      {
        accessKeyId: cloudAccessKeyId.value.trim(),
        secretAccessKey: cloudSecretAccessKey.value,
        sessionToken: cloudSessionToken.value.trim() || undefined,
        cloudPassword: cloudPassword.value
      },
      authStore.sessionKey
    );
    if (cloudSettings.value.enabled && !enableLocalSnapshot.value) {
      enableLocalSnapshot.value = true;
      await autoBackup.saveSettings({ enableLocalSnapshot: true });
    }
    cloudSecretAccessKey.value = '';
    cloudSessionToken.value = '';
    cloudPassword.value = '';
    cloudPasswordConfirm.value = '';
    await refreshCloudStatus();
    showToast('云端备份配置已加密保存', 'success');
  } catch (error) {
    showToast(getErrorMessage(error, '保存云端备份配置失败'), 'error');
  } finally {
    savingCloud.value = false;
  }
}

async function disableCloudBackup() {
  cloudSettings.value.enabled = false;
  await chrome.storage.local.set({
    cloudBackupSettings: cloudSettings.value,
    cloudBackupStatus: { ...cloudStatus.value, state: 'disabled', message: null }
  });
  await refreshCloudStatus();
  showToast('云端备份已停用，远端对象未删除', 'success');
}

async function testCloudConnection() {
  testingCloud.value = true;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'testCloudBackupConnection' });
    if (result?.error) throw new Error(result.error);
    showToast(result?.exists ? '连接成功，已找到云端备份' : '连接成功，尚无云端备份', 'success');
  } catch (error) {
    showToast(getErrorMessage(error, '云端连接失败'), 'error');
  } finally {
    testingCloud.value = false;
  }
}

async function syncCloudNow() {
  syncingCloud.value = true;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'syncLatestCloudBackup' });
    if (result?.error) throw new Error(result.error);
    await refreshCloudStatus();
    showToast('最新本地快照已同步到云端', 'success');
  } catch (error) {
    await refreshCloudStatus();
    showToast(getErrorMessage(error, '云端同步失败'), 'error');
  } finally {
    syncingCloud.value = false;
  }
}

async function restoreCloudLatest() {
  if (!confirm('从云端最新备份导入密钥？现有密钥不会被删除，重复项会跳过。')) return;
  restoringCloud.value = true;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'restoreLatestCloudBackup' });
    if (result?.error || !result?.backupData) {
      throw new Error(result?.error || '云端未返回有效备份');
    }

    let password: string | undefined;
    if (result.backupData.encrypted) {
      const encryptionSettings = await getBackupEncryptionSettings();
      password = await resolveStoredBackupPassword(authStore.sessionKey, encryptionSettings);
      if (!password) throw new Error('当前备份密码不可用，请先检查备份加密设置');
    }

    const file = new File([JSON.stringify(result.backupData)], 'openpass-cloud-restore.json', {
      type: 'application/json'
    });
    let count: number;
    try {
      count = await secretStore.importSecrets(file, password);
    } catch (error) {
      if (!result.backupData.encrypted) throw error;
      const manualPassword = prompt('当前备份密码无法解密，请输入创建这份备份时使用的密码');
      if (!manualPassword) throw error;
      count = await secretStore.importSecrets(file, manualPassword);
    }
    showToast(count > 0 ? `已从云端导入 ${count} 个密钥` : '云端备份没有新的密钥', 'success');
  } catch (error) {
    showToast(getErrorMessage(error, '云端恢复失败'), 'error');
  } finally {
    restoringCloud.value = false;
  }
}

function openPasswordModal() {
  currentPassword.value = '';
  newPassword.value = '';
  confirmPassword.value = '';
  passwordError.value = '';
  showPasswordModal.value = true;
}

async function changePassword() {
  if (!currentPassword.value || !newPassword.value || !confirmPassword.value) {
    passwordError.value = '请填写所有字段';
    return;
  }

  if (newPassword.value !== confirmPassword.value) {
    passwordError.value = '新密码两次输入不一致';
    return;
  }

  if (newPassword.value.length < 6) {
    passwordError.value = '新密码至少需要 6 个字符';
    return;
  }

  try {
    const result = await chrome.storage.local.get<{
      masterPasswordHash?: string;
      masterPasswordSalt?: string;
    }>(['masterPasswordHash', 'masterPasswordSalt']);

    if (!result.masterPasswordHash || !result.masterPasswordSalt) {
      passwordError.value = '系统错误';
      return;
    }

    const isValid = await CryptoUtils.verifyMasterPassword(
      currentPassword.value,
      result.masterPasswordHash,
      result.masterPasswordSalt
    );

    if (!isValid) {
      passwordError.value = '当前密码错误';
      return;
    }

    const newHash = await CryptoUtils.createMasterPasswordHash(newPassword.value);
    const secretsResult = await chrome.storage.local.get<{
      encryptedSecrets?: string;
      encryptedBackupPassword?: string;
      encryptedCloudBackupSecrets?: string;
    }>(['encryptedSecrets', 'encryptedBackupPassword', 'encryptedCloudBackupSecrets']);

    let nextEncryptedBackupPassword =
      typeof secretsResult.encryptedBackupPassword === 'string'
        ? secretsResult.encryptedBackupPassword
        : null;
    let nextEncryptedCloudBackupSecrets =
      typeof secretsResult.encryptedCloudBackupSecrets === 'string'
        ? secretsResult.encryptedCloudBackupSecrets
        : null;

    if (nextEncryptedBackupPassword) {
      const decryptedBackupPassword = await CryptoUtils.decrypt(
        nextEncryptedBackupPassword,
        currentPassword.value
      );
      nextEncryptedBackupPassword = await CryptoUtils.encrypt(
        decryptedBackupPassword,
        newPassword.value
      );
    }

    if (nextEncryptedCloudBackupSecrets) {
      const decryptedCloudSecrets = await CryptoUtils.decrypt(
        nextEncryptedCloudBackupSecrets,
        currentPassword.value
      );
      nextEncryptedCloudBackupSecrets = await CryptoUtils.encrypt(
        decryptedCloudSecrets,
        newPassword.value
      );
    }

    if (typeof secretsResult.encryptedSecrets === 'string') {
      const decrypted = await CryptoUtils.decrypt(
        secretsResult.encryptedSecrets,
        currentPassword.value
      );
      const newEncrypted = await CryptoUtils.encrypt(decrypted, newPassword.value);
      await chrome.storage.local.set({
        masterPasswordHash: newHash.hash,
        masterPasswordSalt: newHash.salt,
        encryptedSecrets: newEncrypted,
        encryptedBackupPassword: nextEncryptedBackupPassword,
        encryptedCloudBackupSecrets: nextEncryptedCloudBackupSecrets
      });
    } else {
      await chrome.storage.local.set({
        masterPasswordHash: newHash.hash,
        masterPasswordSalt: newHash.salt,
        encryptedBackupPassword: nextEncryptedBackupPassword,
        encryptedCloudBackupSecrets: nextEncryptedCloudBackupSecrets
      });
    }

    await authStore.createSession(newPassword.value);
    showPasswordModal.value = false;
    showToast('主密码已更新', 'success');
  } catch (error) {
    passwordError.value = `修改失败: ${getErrorMessage(error)}`;
  }
}

async function clearAllSecrets() {
  const confirmation = prompt('请输入 "DELETE" 确认清空所有密钥');
  if (confirmation !== 'DELETE') return;

  try {
    secretStore.secrets = [];
    await secretStore.saveSecrets();
    await chrome.storage.local.remove(['backupSnapshots']);
    showToast('所有密钥已清空', 'success');
  } catch (error) {
    showToast(`清空失败: ${getErrorMessage(error)}`, 'error');
  }
}

async function resetAllData() {
  const confirmation = prompt('请输入 "RESET" 确认重置所有数据');
  if (confirmation !== 'RESET') return;

  try {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    await autoBackup.removeHandle();
    showToast('所有数据已重置', 'success');
    window.location.reload();
  } catch (error) {
    showToast(`重置失败: ${getErrorMessage(error)}`, 'error');
  }
}
</script>

<template>
  <div class="settings-page">
    <header class="page-header">
      <h1>设置</h1>
    </header>

    <div class="page-content">
      <!-- 主密码设置 -->
      <div class="settings-section">
        <h3>主密码</h3>
        <p class="settings-desc">主密码用于保护密钥数据和管理页面访问。</p>
        <button class="btn-secondary" @click="openPasswordModal">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          修改主密码
        </button>
      </div>

      <!-- 备份加密设置 -->
      <div class="settings-section">
        <h3>备份加密</h3>
        <p class="settings-desc">启用后导出的备份文件将加密保存，导入时需要输入密码解密。</p>

        <div class="settings-item">
          <div class="settings-item-info">
            <span class="settings-item-label">启用备份加密</span>
            <span class="settings-item-desc">导出备份时加密密钥数据</span>
          </div>
          <label class="toggle">
            <input v-model="enableBackupEncryption" type="checkbox" @change="saveEncryptionSettings">
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div v-if="enableBackupEncryption" class="settings-subsection">
          <div class="settings-item">
            <div class="settings-item-info">
              <span class="settings-item-label">使用主密码作为备份密码</span>
              <span class="settings-item-desc">启用后将使用主密码加密备份，无需单独记忆</span>
            </div>
            <label class="toggle">
              <input v-model="useMasterPasswordForBackup" type="checkbox" @change="saveEncryptionSettings">
              <span class="toggle-slider"></span>
            </label>
          </div>

          <!-- 自定义备份密码 -->
          <div v-if="!useMasterPasswordForBackup" class="custom-password-section">
            <div class="form-group">
              <label>备份密码</label>
              <input v-model="backupPassword" type="password" class="form-input" placeholder="输入备份密码">
            </div>
            <div class="form-group">
              <label>确认备份密码</label>
              <input v-model="backupPasswordConfirm" type="password" class="form-input" placeholder="再次输入备份密码">
            </div>
            <p v-if="backupPasswordError" class="form-error">{{ backupPasswordError }}</p>
            <button class="btn-secondary" @click="saveBackupPassword">保存备份密码</button>
          </div>
        </div>
      </div>

      <!-- 自动备份设置 -->
      <div class="settings-section">
        <h3>自动备份</h3>
        <p class="settings-desc">定期检查并自动备份密钥数据，防止数据丢失。</p>

        <div class="settings-item">
          <div class="settings-item-info">
            <span class="settings-item-label">启用自动备份</span>
            <span class="settings-item-desc">距离上次备份超过设定间隔时自动创建备份</span>
          </div>
          <label class="toggle">
            <input v-model="enableAutoBackup" type="checkbox" @change="saveBackupSettings">
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div v-if="enableAutoBackup" class="settings-subsection">
          <!-- 备份频率 -->
          <div class="form-group">
            <label>备份频率</label>
            <select v-model="backupFrequency" class="form-select" @change="saveBackupSettings">
              <option value="every5min">每 5 分钟 (测试)</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
          </div>

          <!-- 本地快照 -->
          <div class="settings-item">
            <div class="settings-item-info">
              <span class="settings-item-label">本地快照</span>
              <span class="settings-item-desc">在浏览器中保留最近 5 个备份版本</span>
            </div>
            <label class="toggle">
              <input v-model="enableLocalSnapshot" type="checkbox" @change="saveBackupSettings">
              <span class="toggle-slider"></span>
            </label>
          </div>

          <!-- 目录备份 -->
          <div class="settings-item">
            <div class="settings-item-info">
              <span class="settings-item-label">自动保存到本地目录</span>
              <span class="settings-item-desc">开启时会立即要求选择目录并授权，授权成功后才会启用</span>
            </div>
            <label class="toggle">
              <input
                v-model="enableDirectoryBackup"
                type="checkbox"
                :disabled="authorizingDirectory"
                @change="handleDirectoryBackupToggle"
              >
              <span class="toggle-slider"></span>
            </label>
          </div>

          <!-- 目录状态和选择 -->
          <div v-if="enableDirectoryBackup" class="directory-section">
            <div class="directory-status">
              <div class="directory-info">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 19a2 2 0 0 0-2 2H4a2 2 0 0 0-2-2V5a2 2 0 0 0 2-2h5l2 3h9a2 2 0 0 0 2 2z"></path>
                </svg>
                <span>{{ directoryInfo.hasHandle ? `已选择: ${directoryInfo.locationLabel}` : directoryInfo.locationLabel }}</span>
              </div>
              <button class="btn-secondary btn-sm" @click="handleSelectDirectory">
                {{ directoryInfo.hasHandle ? '更换目录' : '选择备份目录并授权' }}
              </button>
            </div>

            <!-- 权限状态 -->
            <div v-if="directoryInfo.hasHandle" class="permission-status">
              <template v-if="directoryInfo.permission === 'granted'">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-green-500">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                <span class="text-green-600">已授权，可自动写入</span>
              </template>
              <template v-else-if="directoryInfo.permission === 'prompt'">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-yellow-500">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                  <line x1="12" y1="9" x2="12" y2="13"></line>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
                <span class="text-yellow-600">需要授权才能写入</span>
                <button class="btn-secondary btn-sm" @click="handleRequestPermission">授权</button>
              </template>
              <template v-else-if="directoryInfo.permission === 'denied'">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-red-500">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="15" y1="9" x2="9" y2="15"></line>
                  <line x1="9" y1="9" x2="15" y2="15"></line>
                </svg>
                <span class="text-red-600">权限被拒绝，请重新选择</span>
              </template>
            </div>
            <div v-else class="permission-status">
              <span class="text-yellow-600">尚未授权目录，自动备份不会生成文件</span>
            </div>
          </div>

          <!-- 备份时间信息 -->
          <div class="backup-info">
            <div class="info-item">
              <span class="info-label">上次备份</span>
              <span class="info-value" :title="lastBackupTime ? new Date(lastBackupTime).toLocaleString('zh-CN') : ''">
                {{ formattedLastBackupTime }}
              </span>
            </div>
            <div class="info-item">
              <span class="info-label">下次备份</span>
              <span class="info-value" :class="{ 'text-yellow-600': formattedNextBackupTime === '待执行' }">
                {{ formattedNextBackupTime }}
              </span>
            </div>
          </div>

          <!-- 立即备份 -->
          <div class="button-group">
            <button class="btn-secondary" :disabled="backingUp" @click="handleBackupNow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="17 8 12 3 7 8"></polyline>
                <line x1="12" y1="3" x2="12" y2="15"></line>
              </svg>
              {{ backingUp ? '备份中...' : '立即备份' }}
            </button>
            <button class="btn-secondary" @click="testAutoBackup">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20V10M12 10L6 16M12 10L18 16"></path>
                <path d="M22 12C22 17.5228 17.5228 22 12 22M2 12C2 6.47715 6.47715 2 12 2"></path>
              </svg>
              测试自动备份
            </button>
          </div>
        </div>
      </div>

      <!-- S3 云端备份 -->
      <div class="settings-section">
        <h3>S3 / OSS 云端备份</h3>
        <p class="settings-desc">
          本地快照成功后自动上传。凭据由主密码加密保存，备份内容使用独立密码整体加密。
        </p>

        <div class="settings-item">
          <div class="settings-item-info">
            <span class="settings-item-label">启用云端备份</span>
            <span class="settings-item-desc">停用不会删除任何远端对象</span>
          </div>
          <label class="toggle">
            <input v-model="cloudSettings.enabled" type="checkbox">
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="cloud-grid">
          <div class="form-group cloud-wide">
            <label>S3 Endpoint</label>
            <input v-model="cloudSettings.endpoint" type="url" class="form-input" placeholder="https://s3.example.com">
          </div>
          <div class="form-group">
            <label>Bucket</label>
            <input v-model="cloudSettings.bucket" type="text" class="form-input" placeholder="openpass-backup">
          </div>
          <div class="form-group">
            <label>Region</label>
            <input v-model="cloudSettings.region" type="text" class="form-input" placeholder="us-east-1">
          </div>
          <div class="form-group">
            <label>对象前缀</label>
            <input v-model="cloudSettings.prefix" type="text" class="form-input" placeholder="openpass">
          </div>
          <div class="form-group">
            <label>Access Key ID</label>
            <input v-model="cloudAccessKeyId" type="text" class="form-input" autocomplete="off">
          </div>
          <div class="form-group">
            <label>Secret Access Key</label>
            <input v-model="cloudSecretAccessKey" type="password" class="form-input" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label>Session Token（可选）</label>
            <input v-model="cloudSessionToken" type="password" class="form-input" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label>云端加密密码</label>
            <input v-model="cloudPassword" type="password" class="form-input" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label>确认云端加密密码</label>
            <input v-model="cloudPasswordConfirm" type="password" class="form-input" autocomplete="new-password">
          </div>
        </div>

        <label class="cloud-checkbox">
          <input v-model="cloudSettings.forcePathStyle" type="checkbox">
          使用 Path-style 地址（MinIO 与多数兼容 OSS 推荐）
        </label>

        <div class="cloud-status">
          <strong>{{ formattedCloudStatus }}</strong>
          <span v-if="cloudStatus.message">{{ cloudStatus.message }}</span>
          <span v-if="cloudStatus.lastSuccessAt">
            上次成功：{{ new Date(cloudStatus.lastSuccessAt).toLocaleString('zh-CN') }}
          </span>
        </div>

        <div class="button-group cloud-actions">
          <button class="btn-primary" :disabled="savingCloud" @click="saveCloudSettings">
            {{ savingCloud ? '保存中...' : '加密保存配置' }}
          </button>
          <button class="btn-secondary" :disabled="testingCloud" @click="testCloudConnection">
            {{ testingCloud ? '测试中...' : '测试连接' }}
          </button>
          <button class="btn-secondary" :disabled="syncingCloud" @click="syncCloudNow">
            {{ syncingCloud ? '同步中...' : '同步最新快照' }}
          </button>
          <button class="btn-secondary" :disabled="restoringCloud" @click="restoreCloudLatest">
            {{ restoringCloud ? '恢复中...' : '从云端恢复' }}
          </button>
          <button v-if="cloudSettings.enabled" class="btn-secondary" @click="disableCloudBackup">
            停用
          </button>
        </div>
      </div>

      <!-- 危险操作 -->
      <div class="settings-section danger-zone">
        <h3>危险操作</h3>
        <p class="settings-desc">以下操作不可撤销，请谨慎使用</p>

        <div class="settings-item danger-item">
          <div class="settings-item-info">
            <span class="settings-item-label">清空所有密钥</span>
            <span class="settings-item-desc">删除所有密钥和备份快照，保留其他设置</span>
          </div>
          <button class="btn-danger" @click="clearAllSecrets">清空密钥</button>
        </div>

        <div class="settings-item danger-item">
          <div class="settings-item-info">
            <span class="settings-item-label">重置所有数据</span>
            <span class="settings-item-desc">删除所有数据并恢复到初始状态</span>
          </div>
          <button class="btn-danger" @click="resetAllData">重置数据</button>
        </div>
      </div>
    </div>

    <!-- 修改密码模态框 -->
    <div v-if="showPasswordModal" class="modal">
      <div class="modal-overlay" @click="showPasswordModal = false"></div>
      <div class="modal-content">
        <div class="modal-header">
          <h3>修改主密码</h3>
          <button class="modal-close" @click="showPasswordModal = false">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <form class="modal-form" @submit.prevent="changePassword">
          <div class="form-group">
            <label>当前密码</label>
            <input
              v-model="currentPassword"
              type="password"
              class="form-input"
              placeholder="输入当前主密码"
            >
          </div>
          <div class="form-group">
            <label>新密码</label>
            <input v-model="newPassword" type="password" class="form-input" placeholder="输入新的主密码">
          </div>
          <div class="form-group">
            <label>确认新密码</label>
            <input v-model="confirmPassword" type="password" class="form-input" placeholder="再次输入新的主密码">
          </div>
          <p v-if="passwordError" class="form-error">{{ passwordError }}</p>
          <div class="modal-footer">
            <button type="button" class="btn-secondary" @click="showPasswordModal = false">取消</button>
            <button type="submit" class="btn-primary">确认修改</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 32px;
  background: #ffffff;
  border-bottom: 1px solid #e2e8f0;
}

.page-header h1 {
  font-size: 24px;
  font-weight: 600;
}

.page-content {
  flex: 1;
  padding: 24px 32px;
  overflow-y: auto;
}

.settings-section {
  background: #ffffff;
  padding: 24px;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  margin-bottom: 24px;
}

.settings-section h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}

.settings-desc {
  font-size: 13px;
  color: #64748b;
  margin-bottom: 16px;
}

.settings-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid #e2e8f0;
}

.settings-item:last-child {
  border-bottom: none;
}

.settings-item-info {
  flex: 1;
}

.settings-item-label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: #1e293b;
  margin-bottom: 2px;
}

.settings-item-desc {
  font-size: 12px;
  color: #64748b;
}

.settings-subsection {
  margin-top: 12px;
  padding: 16px;
  background: #f8fafc;
  border-radius: 8px;
}

.custom-password-section {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #e2e8f0;
}

.form-group {
  margin-bottom: 12px;
}

.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: #1e293b;
  margin-bottom: 6px;
}

.form-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 14px;
  background: #ffffff;
}

.form-input:focus {
  outline: none;
  border-color: #4f46e5;
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}

.form-select {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 14px;
  background: #ffffff;
  cursor: pointer;
}

.form-error {
  font-size: 13px;
  color: #ef4444;
  margin-top: 8px;
}

/* Toggle Switch */
.toggle {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  flex-shrink: 0;
}

.toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #cbd5e1;
  transition: 0.3s;
  border-radius: 24px;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: 0.3s;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.toggle input:checked + .toggle-slider {
  background-color: #4f46e5;
}

.toggle input:checked + .toggle-slider:before {
  transform: translateX(20px);
}

.toggle input:disabled + .toggle-slider {
  cursor: wait;
  opacity: 0.65;
}

/* Directory Section */
.directory-section {
  margin-top: 12px;
  padding: 12px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}

.directory-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.directory-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #64748b;
}

.permission-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 13px;
}

/* Backup Info */
.backup-info {
  display: flex;
  gap: 24px;
  padding: 12px 16px;
  background: #f8fafc;
  border-radius: 8px;
  margin-top: 16px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-label {
  font-size: 12px;
  color: #64748b;
}

.info-value {
  font-size: 14px;
  font-weight: 500;
  color: #1e293b;
}

/* Buttons */
.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  background: #4f46e5;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-primary:hover {
  background: #4338ca;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.button-group {
  display: flex;
  gap: 12px;
}

.button-group .btn-secondary {
  flex: 1;
  justify-content: center;
}

.cloud-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.cloud-wide {
  grid-column: 1 / -1;
}

.cloud-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  color: #475569;
  font-size: 13px;
}

.cloud-status {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 16px;
  padding: 12px;
  border-radius: 8px;
  background: #f8fafc;
  color: #475569;
  font-size: 13px;
}

.cloud-status strong {
  color: #0f172a;
}

.cloud-actions {
  flex-wrap: wrap;
  margin-top: 16px;
}

.cloud-actions button {
  min-width: 132px;
}

.btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  background: #ffffff;
  color: #1e293b;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-secondary:hover {
  background: #f8fafc;
  border-color: #4f46e5;
  color: #4f46e5;
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 12px;
}

.btn-danger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  background: #ef4444;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-danger:hover {
  background: #dc2626;
}

/* Danger Zone */
.danger-zone {
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.danger-zone h3 {
  color: #ef4444;
}

.danger-item {
  border-bottom-color: rgba(239, 68, 68, 0.2);
}

/* Modal */
.modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
}

.modal-content {
  position: relative;
  background: #ffffff;
  border-radius: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  width: 90%;
  max-width: 400px;
  max-height: 90vh;
  overflow-y: auto;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #e2e8f0;
}

.modal-header h3 {
  font-size: 18px;
  font-weight: 600;
}

.modal-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  color: #94a3b8;
  transition: all 0.2s;
}

.modal-close:hover {
  background: #f8fafc;
  color: #1e293b;
}

.modal-form {
  padding: 20px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 20px;
}

@media (max-width: 720px) {
  .cloud-grid {
    grid-template-columns: 1fr;
  }

  .cloud-wide {
    grid-column: auto;
  }
}

/* Utility */
.text-green-500 { color: #10b981; }
.text-green-600 { color: #059669; }
.text-yellow-500 { color: #f59e0b; }
.text-yellow-600 { color: #d97706; }
.text-red-500 { color: #ef4444; }
.text-red-600 { color: #dc2626; }
</style>


