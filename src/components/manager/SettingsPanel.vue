<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { useSecretStore, type Secret } from '@/stores/secrets';
import { useAuthStore } from '@/stores/auth';
import { useAutoBackup, type DirectoryInfo } from '@/composables/useAutoBackup';
import { getErrorMessage } from '@/utils/error';
import { showToast } from '@/utils/ui';
import CryptoUtils from '@/utils/crypto';
import { restoreBackupInManager } from '@/utils/restoreClient';
import type { RestoreMode } from '@/utils/restore';
import {
  type BackupData,
  getBackupEncryptionSettings,
  resolveStoredBackupPassword
} from '@/utils/backup';
import { getBackupDirectoryAuthorizationAction } from '@/utils/backupDestination';
import {
  DEFAULT_CLOUD_BACKUP_SETTINGS,
  DEFAULT_CLOUD_BACKUP_STATUS,
  getCloudEndpointOriginPatterns,
  getCloudPasswordChoice,
  loadCloudBackupSettings,
  loadCloudBackupSecrets,
  loadCloudBackupStatus,
  saveCloudBackupConfiguration,
  type CloudBackupSettings,
  type CloudBackupStatus
} from '@/utils/cloudBackupSettings';

const secretStore = useSecretStore();
const authStore = useAuthStore();
const autoBackup = useAutoBackup();

const isInitialized = ref(false);
const deviceOtpEnabled = ref(true);
const savingDeviceOtp = ref(false);

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
const cloudPasswordChoice = ref<'saved' | 'master' | 'custom'>('master');
const hasStoredCloudCredentials = ref(false);
const storedCloudPasswordMode = ref<'master' | 'custom' | null>(null);
const cloudConfigExpanded = ref(true);
const cloudActionError = ref('');
const savingCloud = ref(false);
const togglingCloud = ref(false);
const testingCloud = ref(false);
const syncingCloud = ref(false);
const restoringCloud = ref(false);
const loadingCloudVersions = ref(false);
const cloudVersionsLoaded = ref(false);
const cloudVersionsError = ref('');
const cloudVersionPage = ref(1);
const deletingCloudVersionKey = ref<string | null>(null);
const cloudDeleteDialog = ref<HTMLDialogElement | null>(null);
const cloudDeleteVersion = ref<(typeof cloudVersions.value)[number] | null>(null);
const cloudDeleteError = ref('');
const cloudDeleteConfirmation = ref('');
const cloudDeleteToken = ref('');
const preparingCloudDelete = ref(false);
const clearDialog = ref<HTMLDialogElement | null>(null);
const clearScope = ref<'local' | 'cloud'>('local');
const clearConfirmation = ref('');
const clearError = ref('');
const preparingClear = ref(false);
const clearingVault = ref(false);
const clearReview = ref<{ token: string; localCount: number; remoteCount: number; historyCount: number; bucket?: string; prefix?: string } | null>(null);
const CLOUD_VERSIONS_PER_PAGE = 5;
const restoringCloudVersionKey = ref<string | null>(null);
const cloudVersions = ref<Array<{
  key: string;
  lastModified: string | null;
  size: number;
  etag: string | null;
  current?: boolean;
}>>([]);
const cloudVersionPageCount = computed(() => Math.max(1, Math.ceil(cloudVersions.value.length / CLOUD_VERSIONS_PER_PAGE)));
const visibleCloudVersions = computed(() => cloudVersions.value.slice(
  (cloudVersionPage.value - 1) * CLOUD_VERSIONS_PER_PAGE, cloudVersionPage.value * CLOUD_VERSIONS_PER_PAGE
));
const cloudBusy = computed(() => savingCloud.value || syncingCloud.value || testingCloud.value || togglingCloud.value || clearingVault.value || deletingCloudVersionKey.value !== null);

function handleCloudStatusChange(changes: Record<string, chrome.storage.StorageChange>, area: chrome.storage.AreaName) {
  if (area === 'local' && changes.cloudBackupStatus) {
    const next = changes.cloudBackupStatus.newValue;
    cloudStatus.value = { ...DEFAULT_CLOUD_BACKUP_STATUS, ...(typeof next === 'object' && next !== null ? next : {}) };
  }
}

async function refreshCloudPasswordChoice() {
  const stored = hasStoredCloudCredentials.value && authStore.sessionKey
    ? await loadCloudBackupSecrets(authStore.sessionKey) : null;
  storedCloudPasswordMode.value = stored?.cloudPasswordMode || null;
  cloudPasswordChoice.value = getCloudPasswordChoice(stored, authStore.sessionKey);
}

onMounted(async () => {
  chrome.storage.onChanged.addListener(handleCloudStatusChange);
  try { await loadAllSettings(); }
  catch (error) { showToast(getErrorMessage(error, '加载设置失败'), 'error'); }
});
onUnmounted(() => chrome.storage.onChanged.removeListener(handleCloudStatusChange));

async function loadAllSettings() {
  const deviceOtp = await chrome.storage.local.get<{ deviceOtpEnabled?: boolean }>(['deviceOtpEnabled']);
  deviceOtpEnabled.value = deviceOtp.deviceOtpEnabled !== false;
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
  const cloudCredentials = await chrome.storage.local.get<{ encryptedCloudBackupSecrets?: string }>([
    'encryptedCloudBackupSecrets'
  ]);
  hasStoredCloudCredentials.value = typeof cloudCredentials.encryptedCloudBackupSecrets === 'string';
  cloudConfigExpanded.value = !hasStoredCloudCredentials.value;
  await refreshCloudPasswordChoice();

  isInitialized.value = true;
  if (hasStoredCloudCredentials.value) await loadCloudVersions();
}

async function saveDeviceOtpSettings() {
  savingDeviceOtp.value = true;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'setDeviceOtpEnabled', enabled: deviceOtpEnabled.value });
    if (result?.error || !result?.success) throw new Error(result?.error || '免密设置保存失败');
    showToast(deviceOtpEnabled.value ? '日常验证码已开启免密' : '日常验证码已改为解锁后使用', 'success');
  } catch (error) {
    deviceOtpEnabled.value = !deviceOtpEnabled.value;
    showToast(getErrorMessage(error), 'error');
  } finally { savingDeviceOtp.value = false; }
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
    pending: '等待解锁后同步',
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
  if (savingCloud.value) return;
  if (cloudPasswordChoice.value === 'custom' && cloudPassword.value !== cloudPasswordConfirm.value) {
    showToast('两次输入的云端加密密码不一致', 'error');
    return;
  }

  savingCloud.value = true;
  cloudActionError.value = '';
  let configurationSaved = false;
  try {
    const granted = await chrome.permissions.request({
      origins: getCloudEndpointOriginPatterns(cloudSettings.value)
    });
    if (!granted) throw new Error('未获得 S3 Endpoint 访问权限');

    const storedSecrets = hasStoredCloudCredentials.value
      ? await loadCloudBackupSecrets(authStore.sessionKey)
      : null;
    cloudSettings.value = await saveCloudBackupConfiguration(
      cloudSettings.value,
      {
        accessKeyId: cloudAccessKeyId.value.trim() || storedSecrets?.accessKeyId || '',
        secretAccessKey: cloudSecretAccessKey.value || storedSecrets?.secretAccessKey || '',
        sessionToken: cloudSessionToken.value.trim() || storedSecrets?.sessionToken,
        cloudPassword: cloudPasswordChoice.value === 'saved'
          ? storedSecrets?.cloudPassword || '' : cloudPassword.value,
        cloudPasswordMode: cloudPasswordChoice.value === 'saved'
          ? storedSecrets?.cloudPasswordMode : undefined
      },
      authStore.sessionKey,
      cloudPasswordChoice.value
    );
    hasStoredCloudCredentials.value = true;
    configurationSaved = true;
    await refreshCloudPasswordChoice();
    if (cloudSettings.value.enabled && !enableLocalSnapshot.value) {
      enableLocalSnapshot.value = true;
      await autoBackup.saveSettings({ enableLocalSnapshot: true });
    }
    cloudAccessKeyId.value = '';
    cloudSecretAccessKey.value = '';
    cloudSessionToken.value = '';
    cloudPassword.value = '';
    cloudPasswordConfirm.value = '';
    await refreshCloudStatus();
    await synchronizeCloud();
    showToast('配置已保存，云端同步完成', 'success');
  } catch (error) {
    cloudActionError.value = `${configurationSaved ? '配置已保存，但同步未完成：' : ''}${getErrorMessage(error, '保存云端备份配置失败')}`;
    showToast(cloudActionError.value, 'error');
  } finally {
    savingCloud.value = false;
  }
}

async function disableCloudBackup() {
  togglingCloud.value = true;
  try {
    cloudSettings.value.enabled = false;
    await chrome.storage.local.set({
      cloudBackupSettings: cloudSettings.value,
      cloudBackupStatus: { ...cloudStatus.value, state: 'disabled', message: null }
    });
    await refreshCloudStatus();
    showToast('云端同步已停用，本地数据和远端密文均已保留', 'success');
  } catch (error) {
    cloudSettings.value.enabled = true;
    showToast(getErrorMessage(error, '停用云端同步失败'), 'error');
  } finally {
    togglingCloud.value = false;
  }
}

async function handleCloudSyncToggle() {
  if (!cloudSettings.value.enabled) {
    await disableCloudBackup();
    return;
  }
  if (!hasStoredCloudCredentials.value) return;

  togglingCloud.value = true;
  try {
    const granted = await chrome.permissions.request({
      origins: getCloudEndpointOriginPatterns(cloudSettings.value)
    });
    if (!granted) throw new Error('未获得 S3 Endpoint 访问权限');
    await chrome.storage.local.set({
      cloudBackupSettings: cloudSettings.value,
      cloudBackupStatus: { ...cloudStatus.value, state: 'idle', message: null }
    });
    await refreshCloudStatus();
    showToast('云端同步已重新启用', 'success');
  } catch (error) {
    cloudSettings.value.enabled = false;
    showToast(getErrorMessage(error, '启用云端同步失败'), 'error');
  } finally {
    togglingCloud.value = false;
  }
}

async function testCloudConnection() {
  testingCloud.value = true;
  cloudActionError.value = '';
  try {
    const granted = await chrome.permissions.request({ origins: getCloudEndpointOriginPatterns(cloudSettings.value) });
    if (!granted) throw new Error('未获得云端地址访问权限');
    const result = await chrome.runtime.sendMessage({ action: 'testCloudBackupConnection' });
    if (result?.error) throw new Error(result.error);
    showToast(result?.exists ? '连接成功，已找到云端备份' : '连接成功，尚无云端备份', 'success');
  } catch (error) {
    cloudActionError.value = getErrorMessage(error, '云端连接失败');
    showToast(cloudActionError.value, 'error');
  } finally {
    testingCloud.value = false;
  }
}

async function synchronizeCloud() {
  syncingCloud.value = true;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'syncLatestCloudBackup' });
    if (result?.error || !result?.success) throw new Error(result?.error || '云端同步未完成');
    await refreshCloudStatus();
    await loadCloudVersions();
  } finally {
    await refreshCloudStatus();
    syncingCloud.value = false;
  }
}

async function syncCloudNow() {
  cloudActionError.value = '';
  try {
    const granted = await chrome.permissions.request({ origins: getCloudEndpointOriginPatterns(cloudSettings.value) });
    if (!granted) throw new Error('未获得云端地址访问权限');
    await synchronizeCloud(); showToast('多设备双向同步完成', 'success');
  }
  catch (error) {
    cloudActionError.value = getErrorMessage(error, '云端同步失败');
    showToast(cloudActionError.value, 'error');
  }
}

const cloudRestoreMode = ref<RestoreMode>('merge');
const conflictComparison = ref<{ token: string; localCount: number; remoteCount: number;
  differences: Array<{ id: string; local: { site: string; name?: string; counter?: number; updatedAt?: string } | null;
  remote: { site: string; name?: string; counter?: number; updatedAt?: string } | null; keyChanged: boolean }> } | null>(null);
const resolvingConflict = ref(false);
async function compareConflict() {
  resolvingConflict.value = true;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'compareCloudConflict' });
    if (result?.error) throw new Error(result.error);
    conflictComparison.value = result;
  } catch (error) { showToast(getErrorMessage(error), 'error'); }
  finally { resolvingConflict.value = false; }
}
async function resolveConflict(choice: 'local' | 'remote' | 'merge') {
  if (!conflictComparison.value) return;
  if (!confirm('应用所选冲突处理方式？操作前会保存本地加密快照。')) return;
  resolvingConflict.value = true;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'resolveCloudConflict', choice, token: conflictComparison.value.token });
    if (result?.error) throw new Error(result.error);
    conflictComparison.value = null;
    await secretStore.loadSecrets();
    showToast('冲突已解决', 'success');
  } catch (error) { conflictComparison.value = null; showToast(getErrorMessage(error), 'error'); }
  finally { await refreshCloudStatus(); resolvingConflict.value = false; }
}
async function importCloudBackupData(backupData: BackupData<Secret>) {
  const result = await restoreBackupInManager(backupData, cloudRestoreMode.value);
  if (result) await secretStore.loadSecrets();
  return result;
}

async function restoreCloudLatest() {
  restoringCloud.value = true;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'restoreLatestCloudBackup' });
    if (result?.error || !result?.backupData) {
      throw new Error(result?.error || '云端未返回有效备份');
    }

    const restored = await importCloudBackupData(result.backupData);
    if (restored) showToast(`恢复完成，当前共 ${restored.count} 个密钥`, 'success');
  } catch (error) {
    showToast(getErrorMessage(error, '云端恢复失败'), 'error');
  } finally {
    restoringCloud.value = false;
  }
}

async function loadCloudVersions() {
  loadingCloudVersions.value = true;
  cloudVersionsError.value = '';
  try {
    const result = await chrome.runtime.sendMessage({ action: 'listCloudBackupVersions' });
    if (result?.error || !result?.success) throw new Error(result?.error || '读取云端历史版本失败');
    cloudVersions.value = Array.isArray(result?.versions) ? result.versions : [];
    cloudVersionsLoaded.value = true;
    cloudVersionPage.value = Math.min(cloudVersionPage.value, cloudVersionPageCount.value);
  } catch (error) {
    cloudVersionsError.value = getErrorMessage(error, '读取云端历史版本失败');
  } finally {
    loadingCloudVersions.value = false;
  }
}

async function restoreCloudVersion(version: (typeof cloudVersions.value)[number]) {
  restoringCloudVersionKey.value = version.key;
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'restoreCloudBackupVersion',
      key: version.key
    });
    if (result?.error || !result?.backupData) {
      throw new Error(result?.error || '云端未返回有效历史版本');
    }
    const restored = await importCloudBackupData(result.backupData);
    if (restored) showToast(`恢复完成，当前共 ${restored.count} 个密钥`, 'success');
  } catch (error) {
    showToast(getErrorMessage(error, '历史版本恢复失败'), 'error');
  } finally {
    restoringCloudVersionKey.value = null;
  }
}

function formatCloudObjectSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
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
    const result = await chrome.runtime.sendMessage({ action: 'changeMasterPassword',
      currentPassword: currentPassword.value, password: newPassword.value });
    if (result?.error || !result?.success) throw new Error(result?.error || '修改密码失败');
    await authStore.createSession(newPassword.value);
    showPasswordModal.value = false;
    showToast('主密码已更新', 'success');
  } catch (error) {
    passwordError.value = `修改失败: ${getErrorMessage(error)}`;
  }
}

async function clearAllSecrets() {
  clearScope.value = 'local'; clearReview.value = null;
  clearError.value = ''; clearConfirmation.value = '';
  await nextTick(); clearDialog.value?.showModal();
}
async function prepareClear() {
  preparingClear.value = true; clearError.value = ''; clearReview.value = null; clearConfirmation.value = '';
  try {
    const result = await chrome.runtime.sendMessage({ action: 'prepareVaultClear', scope: clearScope.value });
    if (result?.error || !result?.success) throw new Error(result?.error || '读取清理范围失败');
    clearReview.value = result;
  } catch (error) { clearError.value = getErrorMessage(error); }
  finally { preparingClear.value = false; }
}
function changeClearScope() { clearReview.value = null; clearConfirmation.value = ''; clearError.value = ''; }
async function confirmClear() {
  if (!clearReview.value || clearingVault.value) return;
  clearingVault.value = true; clearError.value = '';
  try {
    const result = await chrome.runtime.sendMessage({ action: 'clearVault', token: clearReview.value.token, confirmation: clearConfirmation.value });
    if (result?.error || !result?.success) throw new Error(result?.error || '清理失败');
    await secretStore.loadSecrets(); await loadAllSettings();
    clearDialog.value?.close();
    cloudActionError.value = result.warning || '';
    showToast(result.warning || (result.scope === 'cloud' ? '本机和云端密钥已清空，所确认的云端历史已删除' : '本机密钥已清空，云端数据已保留，云同步已停用'), result.warning ? 'warning' : 'success');
  } catch (error) { clearError.value = getErrorMessage(error); }
  finally { clearingVault.value = false; }
}
async function selectCloudDelete(version: (typeof cloudVersions.value)[number]) {
  if (version.current || cloudBusy.value) return;
  cloudDeleteVersion.value = version; cloudDeleteError.value = ''; cloudDeleteConfirmation.value = '';
  cloudDeleteToken.value = ''; preparingCloudDelete.value = true;
  await nextTick(); cloudDeleteDialog.value?.showModal();
  try {
    const result = await chrome.runtime.sendMessage({ action: 'prepareCloudVersionDelete', key: version.key });
    if (result?.error || !result?.success) throw new Error(result?.error || '检查版本失败');
    cloudDeleteToken.value = result.token;
  } catch (error) { cloudDeleteError.value = getErrorMessage(error); }
  finally { preparingCloudDelete.value = false; }
}
async function deleteCloudVersion() {
  if (!cloudDeleteVersion.value || deletingCloudVersionKey.value !== null) return;
  deletingCloudVersionKey.value = cloudDeleteVersion.value.key; cloudDeleteError.value = '';
  try {
    const result = await chrome.runtime.sendMessage({ action: 'deleteCloudBackupVersion', token: cloudDeleteToken.value, confirmation: cloudDeleteConfirmation.value });
    if (result?.error || !result?.success) throw new Error(result?.error || '删除云端版本失败');
    await loadCloudVersions(); cloudDeleteDialog.value?.close(); showToast('所选云端历史快照已删除', 'success');
  } catch (error) { cloudDeleteError.value = getErrorMessage(error); }
  finally { deletingCloudVersionKey.value = null; }
}

async function resetAllData() {
  const confirmation = prompt('仅重置本机数据和配置，云端备份保留。请输入 "RESET" 确认');
  if (confirmation !== 'RESET') return;

  try {
    const result = await chrome.runtime.sendMessage({ action: 'resetLocalData', confirmation });
    if (result?.error || !result?.success) throw new Error(result?.error || '重置失败');
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
      <section class="settings-section security-section" aria-labelledby="security-heading">
        <h3 id="security-heading">主密码与免密</h3>
        <p class="settings-desc">管理操作需要解锁，日常验证码可直接使用。</p>
        <div class="security-items">
          <div class="settings-item password-row">
            <div class="settings-item-info">
              <span class="settings-item-label">主密码</span>
              <span class="settings-item-desc">用于管理密钥、导出备份和更改设置。</span>
            </div>
            <button class="btn-secondary" @click="openPasswordModal">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
              修改主密码
            </button>
          </div>
          <div class="settings-item">
            <div class="settings-item-info">
              <span class="settings-item-label">日常验证码免密</span>
              <span class="settings-item-desc">匹配、查看、复制和填充无需主密码，重启浏览器后仍可使用。</span>
            </div>
            <div class="security-toggle-control">
              <span class="security-toggle-status" role="status">{{ savingDeviceOtp ? '保存中…' : deviceOtpEnabled ? '已开启' : '已关闭' }}</span>
              <label class="toggle">
                <input v-model="deviceOtpEnabled" type="checkbox" role="switch" aria-label="日常验证码免密" :aria-checked="deviceOtpEnabled" :disabled="!isInitialized || savingDeviceOtp" @change="saveDeviceOtpSettings">
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>
        <p class="security-note">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 7v1"></path>
          </svg>
          与他人共用浏览器时，可关闭免密，仅在解锁后使用验证码。
        </p>
      </section>

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
        <p class="settings-desc">按设定频率创建本地快照或目录备份。S3 / OSS 云端同步独立运行，无需开启此项。</p>

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
        <h3>S3 / OSS 多设备同步</h3>
        <p class="settings-desc">
          开启后，在解锁、密钥变更时及每 5 分钟自动同步。锁定时等待解锁，无需同时开启自动备份。
        </p>

        <div class="settings-item">
          <div class="settings-item-info">
            <span class="settings-item-label">启用云端同步</span>
            <span class="settings-item-desc">
              {{ !cloudSettings.enabled
                ? '当前仅使用本地存储与本地备份'
                : cloudStatus.state === 'disabled'
                  ? '填写并保存配置后生效'
                  : '已启用自动双向同步与密文历史版本' }}
            </span>
          </div>
          <label class="toggle">
            <input
              v-model="cloudSettings.enabled"
              type="checkbox"
              :disabled="togglingCloud"
              @change="handleCloudSyncToggle"
            >
            <span class="toggle-slider"></span>
          </label>
        </div>

        <button
          v-if="cloudSettings.enabled" class="cloud-config-toggle" type="button"
          :aria-expanded="cloudConfigExpanded" aria-controls="cloud-configuration" @click="cloudConfigExpanded = !cloudConfigExpanded">
          <span>
            <strong>{{ hasStoredCloudCredentials ? '已保存的云端配置' : '配置云端同步' }}</strong>
            <span v-if="hasStoredCloudCredentials">{{ cloudSettings.bucket }} / {{ cloudSettings.prefix }} · {{ storedCloudPasswordMode === 'master' ? '主密码加密' : '独立密码加密' }}</span>
          </span>
          <span>{{ cloudConfigExpanded ? '收起配置' : '编辑配置' }}</span>
        </button>
        <div v-if="cloudSettings.enabled" v-show="cloudConfigExpanded" id="cloud-configuration" class="cloud-form" :aria-busy="savingCloud">
          <fieldset class="cloud-fields" :disabled="savingCloud">
            <legend>存储位置</legend>
            <div class="cloud-grid">
              <div class="form-group cloud-wide">
                <label for="cloud-endpoint">S3 Endpoint</label>
                <input id="cloud-endpoint" v-model="cloudSettings.endpoint" type="url" class="form-input" placeholder="https://s3.example.com">
                <p class="cloud-credential-hint">阿里云 OSS 使用 https://s3.oss-地域.aliyuncs.com，保存时自动转换普通 OSS 地址并使用 Bucket 子域名。</p>
              </div>
              <div class="form-group">
                <label for="cloud-bucket">Bucket</label>
                <input id="cloud-bucket" v-model="cloudSettings.bucket" type="text" class="form-input" placeholder="openpass-backup">
              </div>
              <div class="form-group">
                <label for="cloud-region">Region</label>
                <input id="cloud-region" v-model="cloudSettings.region" type="text" class="form-input" placeholder="us-east-1">
              </div>
              <div class="form-group cloud-wide">
                <label for="cloud-prefix">对象前缀</label>
                <input id="cloud-prefix" v-model="cloudSettings.prefix" type="text" class="form-input" placeholder="openpass">
              </div>
            </div>
            <label class="cloud-checkbox">
              <input v-model="cloudSettings.forcePathStyle" type="checkbox">
              <span>使用 Path-style 地址（MinIO 常用；阿里云 OSS 请关闭）</span>
            </label>
          </fieldset>

          <fieldset class="cloud-fields" :disabled="savingCloud">
            <legend>版本保留</legend>
            <div class="cloud-grid">
              <div class="form-group">
                <label for="cloud-max-versions">最多保留版本</label>
                <input id="cloud-max-versions" v-model.number="cloudSettings.retentionMaxVersions" type="number" min="1" max="200" class="form-input">
              </div>
              <div class="form-group">
                <label for="cloud-retention-days">最长保留天数</label>
                <input id="cloud-retention-days" v-model.number="cloudSettings.retentionDays" type="number" min="1" max="3650" class="form-input">
              </div>
            </div>
          </fieldset>

          <fieldset class="cloud-fields" :disabled="savingCloud">
            <legend>访问凭据</legend>
            <p v-if="hasStoredCloudCredentials" class="cloud-credential-hint">
              凭据已加密保存，各字段留空时沿用已保存值。
            </p>
            <div class="cloud-grid">
              <div class="form-group">
                <label for="cloud-access-key">Access Key ID</label>
                <input id="cloud-access-key" v-model="cloudAccessKeyId" type="text" class="form-input" autocomplete="off" :placeholder="hasStoredCloudCredentials ? '留空沿用已保存值' : ''">
              </div>
              <div class="form-group">
                <label for="cloud-secret-key">Secret Access Key</label>
                <input id="cloud-secret-key" v-model="cloudSecretAccessKey" type="password" class="form-input" autocomplete="new-password" :placeholder="hasStoredCloudCredentials ? '留空沿用已保存值' : ''">
              </div>
              <div class="form-group cloud-wide">
                <label for="cloud-session-token">Session Token（可选）</label>
                <input id="cloud-session-token" v-model="cloudSessionToken" type="password" class="form-input" autocomplete="new-password">
              </div>
            </div>
          </fieldset>

          <fieldset class="cloud-fields" :disabled="savingCloud">
            <legend>备份加密</legend>
            <div class="cloud-choice-row">
              <div class="form-group">
                <label for="cloud-password-choice">云端加密密码</label>
                <select id="cloud-password-choice" v-model="cloudPasswordChoice" class="form-select cloud-select">
                  <option v-if="hasStoredCloudCredentials" value="saved">{{ storedCloudPasswordMode === 'master' ? '沿用原主密码' : '沿用已保存独立密码' }}</option>
                  <option value="master">使用当前主密码</option>
                  <option value="custom">使用独立密码</option>
                </select>
              </div>
              <p class="cloud-help">
                {{ cloudPasswordChoice === 'master'
                  ? '复用当前解锁的主密码，无需再次输入。其他设备连接此备份时使用同一密码。'
                  : cloudPasswordChoice === 'saved'
                    ? '沿用创建备份时的密码。修改主密码不会改变云端密码，已有版本仍可恢复。'
                    : '单独设置云端密码，其他设备连接此备份时也需使用此密码。' }}
              </p>
            </div>
            <div v-if="cloudPasswordChoice === 'custom'" class="cloud-grid">
              <div class="form-group">
                <label for="cloud-password">独立密码</label>
                <input id="cloud-password" v-model="cloudPassword" type="password" class="form-input" autocomplete="new-password" placeholder="至少 8 个字符">
              </div>
              <div class="form-group">
                <label for="cloud-password-confirm">确认独立密码</label>
                <input id="cloud-password-confirm" v-model="cloudPasswordConfirm" type="password" class="form-input" autocomplete="new-password">
              </div>
            </div>
          </fieldset>
        </div>

        <div v-if="cloudSettings.enabled && cloudStatus.state !== 'disabled'" class="cloud-status">
          <strong>{{ formattedCloudStatus }}</strong>
          <span v-if="cloudStatus.message">{{ cloudStatus.message }}</span>
          <span v-if="cloudStatus.lastSuccessAt">
            上次上传：{{ new Date(cloudStatus.lastSuccessAt).toLocaleString('zh-CN') }}
          </span>
          <span v-if="cloudStatus.lastPullAt">
            上次拉取：{{ new Date(cloudStatus.lastPullAt).toLocaleString('zh-CN') }}
          </span>
          <span v-if="cloudStatus.lastRetentionAt">
            上次清理：{{ new Date(cloudStatus.lastRetentionAt).toLocaleString('zh-CN') }}
          </span>
          <span v-if="cloudStatus.lastRetentionError" class="cloud-warning">
            历史清理失败：{{ cloudStatus.lastRetentionError }}
          </span>
        </div>

        <div v-if="cloudSettings.enabled && cloudStatus.state === 'conflict'" class="cloud-history">
          <p>自动同步已暂停。比较当前两端数据后选择保留方式。</p>
          <button class="btn-secondary" :disabled="resolvingConflict" @click="compareConflict">比较本地与云端</button>
          <template v-if="conflictComparison">
            <p>本地 {{ conflictComparison.localCount }} 个 · 云端 {{ conflictComparison.remoteCount }} 个</p>
            <div v-for="entry in conflictComparison.differences" :key="entry.id" class="cloud-history-item">
              <div>
                <strong>{{ entry.local?.name || entry.remote?.name || entry.local?.site || entry.remote?.site }}</strong>
                <span>本地：{{ entry.local ? `${entry.local.site} · ${entry.local.updatedAt || '时间未知'}` : '不存在' }}</span>
                <span>云端：{{ entry.remote ? `${entry.remote.site} · ${entry.remote.updatedAt || '时间未知'}` : '不存在' }}</span>
                <span v-if="entry.keyChanged">密钥内容不同</span>
                <span v-if="entry.local?.counter !== entry.remote?.counter">计数器：{{ entry.local?.counter ?? '-' }} / {{ entry.remote?.counter ?? '-' }}</span>
              </div>
            </div>
            <div class="button-group">
              <button class="btn-secondary" :disabled="resolvingConflict" @click="resolveConflict('local')">保留本地</button>
              <button class="btn-secondary" :disabled="resolvingConflict" @click="resolveConflict('remote')">保留云端</button>
              <button class="btn-primary" :disabled="resolvingConflict" @click="resolveConflict('merge')">自动合并两端</button>
            </div>
          </template>
        </div>
        <div v-if="cloudSettings.enabled" class="button-group cloud-actions">
          <button v-if="cloudConfigExpanded" class="btn-primary" :disabled="cloudBusy" @click="saveCloudSettings">
            {{ savingCloud ? syncingCloud ? '保存完成，同步中...' : '保存中...' : hasStoredCloudCredentials ? '保存并同步' : '加密保存并启用' }}
          </button>
          <button
            v-if="cloudStatus.state !== 'disabled'"
            class="btn-secondary"
            :disabled="cloudBusy || !hasStoredCloudCredentials"
            @click="testCloudConnection"
          >
            {{ testingCloud ? '测试中...' : '测试连接' }}
          </button>
          <button
            v-if="cloudStatus.state !== 'disabled'"
            class="btn-secondary"
            :disabled="cloudBusy || !hasStoredCloudCredentials"
            @click="syncCloudNow"
          >
            {{ syncingCloud ? '同步中...' : '立即双向同步' }}
          </button>

        </div>
        <p v-if="cloudActionError" class="cloud-action-error" role="alert">{{ cloudActionError }}</p>

        <div
          v-if="hasStoredCloudCredentials"
          class="cloud-history"
        >
          <div class="cloud-history-header">
            <div>
              <strong>云端历史版本<span v-if="cloudVersionsLoaded && !cloudVersionsError" class="cloud-version-count">{{ cloudVersions.length }} 个版本</span></strong>
              <p>每次同步生成不可变密文版本，超出数量或天数限制后自动清理。</p>
            </div>
            <button class="btn-secondary" :disabled="loadingCloudVersions" @click="loadCloudVersions">
              {{ loadingCloudVersions ? '读取中...' : '刷新版本' }}
            </button>
          </div>
          <div class="cloud-restore-toolbar">
            <div class="form-group">
              <label for="cloud-restore-mode">版本恢复方式</label>
              <select id="cloud-restore-mode" v-model="cloudRestoreMode" class="form-select cloud-select" :disabled="restoringCloud || restoringCloudVersionKey !== null">
                <option value="merge">合并导入</option>
                <option value="replace">替换回滚</option>
              </select>
            </div>
            <p class="cloud-help">
              {{ cloudRestoreMode === 'merge' ? '保留当前其他记录，合并所选版本。' : '用所选版本替换当前记录，恢复前保存本地快照。' }}
            </p>
            <button class="btn-secondary" :disabled="restoringCloud || restoringCloudVersionKey !== null" @click="restoreCloudLatest">
              {{ restoringCloud ? '恢复中...' : '恢复最新版本' }}
            </button>
          </div>
          <div v-if="loadingCloudVersions" class="cloud-history-empty" role="status">正在读取云端历史版本...</div>
          <div v-else-if="cloudVersionsError" class="cloud-history-empty cloud-history-error" role="alert">
            <strong>云端版本读取失败</strong><span>{{ cloudVersionsError }}</span>
            <button class="btn-secondary" @click="loadCloudVersions">重新读取</button>
          </div>
          <div v-else-if="cloudVersions.length === 0" class="cloud-history-empty">
            <strong>{{ cloudVersionsLoaded ? '云端暂无历史版本' : '等待读取云端版本' }}</strong>
            <span>同步完成后，备份版本会显示在这里。</span>
          </div>
          <div v-for="version in cloudVersionsError ? [] : visibleCloudVersions" :key="version.key" class="cloud-history-item">
            <div>
              <strong>
                {{ version.lastModified ? new Date(version.lastModified).toLocaleString('zh-CN') : '时间未知' }}
              </strong>
              <span>{{ formatCloudObjectSize(version.size) }} · {{ version.key.split('/').pop() }} <em v-if="version.current" class="cloud-current-badge">当前同步版本</em></span>
            </div>
            <div class="cloud-version-actions">
            <button
              class="btn-secondary"
              :disabled="cloudBusy || restoringCloud || restoringCloudVersionKey !== null"
              @click="restoreCloudVersion(version)"
            >
              {{ restoringCloudVersionKey === version.key ? '恢复中...' : '恢复此版本' }}
            </button>
            <button class="btn-secondary cloud-delete-button" :disabled="version.current || cloudBusy || restoringCloud || restoringCloudVersionKey !== null" :title="version.current ? '当前同步版本受保护，不能删除' : '仅删除此历史快照，不影响当前密钥'" @click="selectCloudDelete(version)">删除</button>
            </div>
          </div>
          <nav v-if="!cloudVersionsError && cloudVersionPageCount > 1" class="cloud-pagination" aria-label="云端版本分页">
            <span>共 {{ cloudVersions.length }} 个版本，每页 {{ CLOUD_VERSIONS_PER_PAGE }} 个</span>
            <div>
              <button class="btn-secondary" :disabled="loadingCloudVersions || cloudVersionPage === 1" @click="cloudVersionPage--">上一页</button>
              <span>{{ cloudVersionPage }} / {{ cloudVersionPageCount }}</span>
              <button class="btn-secondary" :disabled="loadingCloudVersions || cloudVersionPage === cloudVersionPageCount" @click="cloudVersionPage++">下一页</button>
            </div>
          </nav>
        </div>
      </div>

      <!-- 危险操作 -->
      <div class="settings-section danger-zone">
        <h3>危险操作</h3>
        <p class="settings-desc">以下操作不可撤销，请谨慎使用</p>

        <div class="settings-item danger-item">
          <div class="settings-item-info">
            <span class="settings-item-label">清空所有密钥</span>
            <span class="settings-item-desc">先选择清理范围；默认仅清理本机并停用云同步，保留云端备份</span>
          </div>
          <button class="btn-danger" :disabled="cloudBusy || restoringCloud || restoringCloudVersionKey !== null" @click="clearAllSecrets">清空密钥</button>
        </div>

        <div class="settings-item danger-item">
          <div class="settings-item-info">
            <span class="settings-item-label">重置所有数据</span>
            <span class="settings-item-desc">清除本机数据和配置，不主动删除云端备份</span>
          </div>
          <button class="btn-danger" @click="resetAllData">重置数据</button>
        </div>
      </div>
    </div>

    <dialog ref="clearDialog" class="management-dialog" aria-labelledby="clear-dialog-title" @cancel="(clearingVault || preparingClear) && $event.preventDefault()">
      <h3 id="clear-dialog-title">选择清理范围</h3>
      <div class="clear-options">
        <label><input v-model="clearScope" type="radio" value="local" :disabled="clearingVault || preparingClear" @change="changeClearScope"><span><strong>仅清理本机（默认）</strong><small>清空本机密钥及快照，停用云同步。云端备份和其他设备保持不变。</small></span></label>
        <label><input v-model="clearScope" type="radio" value="cloud" :disabled="!hasStoredCloudCredentials || clearingVault || preparingClear" @change="changeClearScope"><span><strong>同时清理云端</strong><small>删除会传播到其他设备，并删除本次确认的云端历史备份。保留空的最新同步版本和索引。</small></span></label>
      </div>
      <button class="btn-secondary" :disabled="preparingClear || clearingVault" @click="prepareClear">{{ preparingClear ? '检查中…' : '检查清理范围' }}</button>
      <div v-if="clearReview" class="clear-review">
        <p>本机：{{ clearReview.localCount }} 个密钥</p>
        <p v-if="clearScope === 'cloud'">云端 {{ clearReview.bucket }} / {{ clearReview.prefix }}：{{ clearReview.remoteCount }} 个密钥、{{ clearReview.historyCount }} 份历史备份</p>
        <label for="clear-confirmation">输入 {{ clearScope === 'cloud' ? 'DELETE CLOUD' : 'DELETE' }} 确认</label>
        <input id="clear-confirmation" v-model="clearConfirmation" class="form-input" :disabled="clearingVault" autocomplete="off">
      </div>
      <p v-if="clearError" class="form-error" role="alert">{{ clearError }}</p>
      <div class="management-dialog-actions">
        <button class="btn-secondary" :disabled="clearingVault || preparingClear" autofocus @click="clearDialog?.close()">取消</button>
        <button class="btn-danger" :disabled="clearingVault || preparingClear || !clearReview || clearConfirmation !== (clearScope === 'cloud' ? 'DELETE CLOUD' : 'DELETE')" @click="confirmClear">{{ clearingVault ? '清理中…' : '确认清理' }}</button>
      </div>
    </dialog>
    <dialog ref="cloudDeleteDialog" class="management-dialog" aria-labelledby="cloud-delete-title" @cancel="(preparingCloudDelete || deletingCloudVersionKey !== null) && $event.preventDefault()">
      <h3 id="cloud-delete-title">删除所选云端历史快照</h3>
      <p>{{ cloudDeleteVersion?.lastModified ? new Date(cloudDeleteVersion.lastModified).toLocaleString('zh-CN') : '时间未知' }}</p>
      <p class="cloud-delete-key">{{ cloudDeleteVersion?.key }}</p>
      <p>仅删除此历史快照，不影响当前密钥和其他版本；删除后无法从此快照恢复。</p>
      <label for="cloud-delete-confirmation">输入 DELETE 确认</label>
      <input id="cloud-delete-confirmation" v-model="cloudDeleteConfirmation" class="form-input" :disabled="deletingCloudVersionKey !== null" autocomplete="off">
      <p v-if="cloudDeleteError" class="form-error" role="alert">{{ cloudDeleteError }}</p>
      <div class="management-dialog-actions">
        <button class="btn-secondary" :disabled="preparingCloudDelete || deletingCloudVersionKey !== null" autofocus @click="cloudDeleteDialog?.close()">取消</button>
        <button class="btn-danger" :disabled="!cloudDeleteToken || preparingCloudDelete || cloudDeleteConfirmation !== 'DELETE' || deletingCloudVersionKey !== null" @click="deleteCloudVersion">{{ preparingCloudDelete ? '检查中…' : deletingCloudVersionKey !== null ? '删除中…' : '确认删除' }}</button>
      </div>
    </dialog>

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
.management-dialog { margin: auto; width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 48px); padding: 24px; border: 1px solid #e2e8f0; border-radius: 14px; color: #1e293b; box-shadow: 0 20px 60px #0f172a33; }
.management-dialog::backdrop { background: #0f172a66; }
.management-dialog h3 { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
.management-dialog p, .management-dialog label { font-size: 13px; line-height: 1.7; }
.management-dialog p { margin: 12px 0; }
.management-dialog label { display: block; margin-bottom: 8px; }
.management-dialog-actions, .cloud-version-actions { display: flex; gap: 12px; justify-content: flex-end; }
.management-dialog-actions { margin-top: 24px; }
.clear-options { display: grid; gap: 12px; margin-bottom: 20px; }
.clear-options label { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border: 1px solid #e2e8f0; border-radius: 8px; }
.clear-options label:has(input:checked) { border-color: #4f46e5; background: #eef2ff; }
.clear-options input { margin-top: 5px; accent-color: #4f46e5; }
.clear-options small { display: block; color: #64748b; margin-top: 4px; font-size: 12px; }
.clear-review { padding: 12px; margin-top: 16px; background: #f8fafc; border-radius: 8px; }
.cloud-delete-key { overflow-wrap: anywhere; color: #64748b; }
.cloud-current-badge { font-size: 11px; font-style: normal; color: #4f46e5; }
.cloud-delete-button { color: #dc2626; }
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

.security-section > .settings-desc {
  margin-bottom: 4px;
}

.security-items .settings-item {
  gap: 24px;
  padding: 16px 0;
}

.security-items .settings-item-info {
  min-width: 0;
}

.security-items .btn-secondary {
  flex-shrink: 0;
  padding: 8px 14px;
}

.security-toggle-control {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 12px;
}

.security-toggle-status {
  min-width: 48px;
  font-size: 12px;
  color: #64748b;
  text-align: right;
}

.security-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 4px 0 0;
  padding: 10px 12px;
  border-radius: 6px;
  background: #f8fafc;
  color: #64748b;
  font-size: 12px;
  line-height: 1.6;
}

.security-note svg {
  flex-shrink: 0;
  margin-top: 1px;
}

@media (max-width: 640px) {
  .security-items .settings-item {
    gap: 12px;
  }

  .security-items .password-row {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .security-items .password-row .settings-item-info {
    flex-basis: 100%;
  }

  .security-toggle-control {
    gap: 8px;
  }
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

.form-input:focus,
.form-select:focus-visible {
  outline: none;
  border-color: #4f46e5;
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}

.form-select {
  appearance: none;
  width: 100%;
  min-height: 42px;
  padding: 10px 38px 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 14px;
  background: #ffffff;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%2364748b' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  line-height: 20px;
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

.toggle input:focus-visible + .toggle-slider {
  outline: 2px solid #4f46e5;
  outline-offset: 3px;
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

.cloud-form {
  margin-top: 20px;
}

.cloud-config-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  margin-top: 16px;
  padding: 14px 16px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
  color: #475569;
  text-align: left;
  font-size: 13px;
  cursor: pointer;
}

.cloud-config-toggle > span:first-child {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
  overflow-wrap: anywhere;
}

.cloud-config-toggle strong { color: #0f172a; }
.cloud-config-toggle > span:last-child { flex-shrink: 0; color: #4f46e5; }
.cloud-config-toggle:focus-visible { outline: 2px solid #4f46e5; outline-offset: 2px; }
.cloud-action-error { margin: 12px 0 0; color: #b91c1c; font-size: 13px; overflow-wrap: anywhere; }

.cloud-pagination,
.cloud-pagination > div {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.cloud-pagination {
  justify-content: space-between;
  margin-top: 16px;
  color: #64748b;
  font-size: 13px;
}

.cloud-pagination .btn-secondary { padding: 8px 12px; }
.cloud-version-count { margin-left: 10px; color: #64748b; font-size: 12px; font-weight: 400; }

.cloud-fields {
  min-width: 0;
  margin: 0 0 24px;
  padding: 0;
  border: 0;
}

.cloud-fields + .cloud-fields {
  padding-top: 20px;
  border-top: 1px solid #e2e8f0;
}

.cloud-fields legend {
  float: left;
  width: 100%;
  margin-bottom: 12px;
  color: #0f172a;
  font-size: 14px;
  font-weight: 600;
}

.cloud-fields > .cloud-grid,
.cloud-fields > .cloud-choice-row,
.cloud-fields > .cloud-credential-hint {
  clear: both;
}

.cloud-choice-row,
.cloud-restore-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 280px) minmax(0, 1fr);
  align-items: end;
  gap: 16px;
}

.cloud-restore-toolbar {
  grid-template-columns: minmax(0, 240px) minmax(0, 1fr) auto;
}

.cloud-choice-row .form-group,
.cloud-restore-toolbar .form-group {
  margin-bottom: 0;
}

.cloud-choice-row .cloud-help,
.cloud-restore-toolbar .cloud-help {
  padding-bottom: 9px;
}

.cloud-select {
  width: 100%;
  max-width: 100%;
}

.cloud-choice-row .form-group,
.cloud-restore-toolbar .form-group {
  min-width: 0;
  max-width: 100%;
}

.cloud-help {
  flex: 1 1 240px;
  margin: 0;
  color: #64748b;
  font-size: 13px;
  line-height: 1.6;
}

.cloud-restore-toolbar {
  margin-top: 16px;
  padding: 16px;
  border-radius: 8px;
  background: #f8fafc;
}

.cloud-restore-toolbar .form-group {
  margin-bottom: 0;
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

.cloud-credential-hint {
  margin: 0;
  color: #64748b;
  font-size: 12px;
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

.cloud-warning {
  color: #b45309;
}

.cloud-actions {
  flex-wrap: wrap;
  margin-top: 16px;
}

.cloud-actions .btn-secondary {
  flex: 0 0 auto;
}

.cloud-actions button {
  min-width: 132px;
}

.cloud-history {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid #e2e8f0;
}

.cloud-history-header,
.cloud-history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.cloud-history-header button,
.cloud-history-item button {
  flex-shrink: 0;
  white-space: nowrap;
}

.cloud-history-header p,
.cloud-history-empty {
  margin: 4px 0 0;
  color: #64748b;
  font-size: 13px;
}

.cloud-history-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  min-height: 100px;
  margin-top: 16px;
  padding: 20px;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  text-align: center;
}

.cloud-history-error { color: #b91c1c; }

@media (max-width: 900px) {
  .cloud-choice-row,
  .cloud-restore-toolbar { grid-template-columns: minmax(0, 1fr); align-items: start; }
  .cloud-choice-row .cloud-help,
  .cloud-restore-toolbar .cloud-help { padding-bottom: 0; }
  .cloud-restore-toolbar .btn-secondary { justify-self: start; }
}

.cloud-history-item {
  margin-top: 10px;
  padding: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}

.cloud-history-item > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}
.cloud-history-item > div:first-child { flex: 1 1 200px; }
.cloud-history-item > .cloud-version-actions { flex-direction: row; flex-shrink: 0; gap: 8px; }
.cloud-version-actions button { padding: 8px 12px; }
.cloud-history-item .cloud-delete-button { color: #dc2626; }
@media (max-width: 900px) {
  .cloud-history-item { flex-wrap: wrap; }
  .cloud-history-item > .cloud-version-actions { margin-left: auto; }
}

.cloud-history-item span {
  overflow: hidden;
  color: #64748b;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
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
