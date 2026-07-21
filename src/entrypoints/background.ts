import jsQR from 'jsqr';
import { TOTP } from 'otpauth';
import {
  type BackupData,
  createBackupData,
  getBackupEncryptionSettings,
  resolveStoredBackupPassword,
  saveBackupSnapshot
} from '@/utils/backup';
import {
  UNSELECTED_BACKUP_LOCATION_LABEL,
  createBackupFilename,
  getBackupDirectoryAccessError,
  getCustomBackupLocationLabel,
  type BackupDirectoryWriteResult
} from '@/utils/backupDestination';
import { installGlobalRuntimeErrorListeners } from '@/utils/runtimeErrors';
import {
  downloadLatestBackupFromS3,
  isCloudBackupConflict,
  testS3CloudBackupConnection,
  uploadBackupToS3
} from '@/utils/s3CloudBackup';
import { isSiteMatched, parseUrl } from '@/utils/domainMatch';
import { parseOtpAuth } from '@/utils/otpAuth';
import {
  createScanRegions,
  getQrScanErrorMessage,
  normalizeQrBounds,
  type NormalizedRect
} from '@/utils/qrScan';

type BackupFrequency = 'every5min' | 'daily' | 'weekly' | 'monthly';

interface StoredSecret {
  secret: string;
  site: string;
  name?: string;
  digits?: number;
}

type PendingSecret = StoredSecret;

interface QrCandidate {
  secret: PendingSecret;
  rect: NormalizedRect;
}

interface SiteListItem {
  site: string;
}

const BACKUP_DB_NAME = 'OpenPassBackupDB';
const BACKUP_DB_VERSION = 1;
const BACKUP_HANDLE_STORE = 'handles';
const AUTO_BACKUP_ALARM_NAME = 'openpass-auto-backup';
const CLOUD_BACKUP_RETRY_ALARM_NAME = 'openpass-cloud-backup-retry';
const CLOUD_BACKUP_RETRY_MINUTES = [5, 15, 60, 180];

const BACKUP_INTERVALS: Record<BackupFrequency, number> = {
  every5min: 5 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000
};

export default defineBackground(() => {
  installGlobalRuntimeErrorListeners('background', self as unknown as {
    addEventListener: (
      type: 'error' | 'unhandledrejection',
      listener: (event: any) => void
    ) => void;
  });

  // SessionKey 内存缓存，供自动备份解密使用
  let cachedSessionKey: string | null = null;
  let cloudBackupInFlight: Promise<unknown> | null = null;

  // 启动时自动修复 secrets 结构
  (async () => {
    const result = await chrome.storage.local.get<{
      secrets?: StoredSecret[];
      encryptedSecrets?: string;
    }>(['secrets', 'encryptedSecrets']);
    if (!Array.isArray(result.secrets)) {
      console.warn('[Background] secrets 格式异常，尝试修复');
      // 如果存在 encryptedSecrets，等待用户解锁后修复
      // 如果没有数据，则初始化为空数组
      if (!result.encryptedSecrets) {
        await chrome.storage.local.set({ secrets: [], sitesList: [] });
      }
    }
  })();

  // 创建右键菜单
  chrome.runtime.onInstalled.addListener((details) => {
    chrome.contextMenus.create({
      id: 'parseQRCode',
      title: '扫描页面二维码',
      contexts: ['all']
    });

    // 创建自动备份定时器
    void syncAutoBackupAlarm().catch((error) => {
      console.error('OpenPass: 初始化自动备份定时器失败', error);
    });

    // 首次安装时自动打开管理页面
    if (details.reason === 'install') {
      const url = chrome.runtime.getURL('options.html');
      chrome.tabs.create({ url });
    }
  });

  // 监听右键菜单点击
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'parseQRCode') {
      return;
    }
    void startQrScan(tab);
  });

  /** 若 secret.site 不是域名（含点+TLD），则替换为页面主域名。 */
  function resolveSiteFromPage(secret: PendingSecret, tab?: chrome.tabs.Tab) {
    const site = (secret.site || '').trim();
    if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(site)) {
      return;
    }
    if (!tab?.url) {
      return;
    }
    const info = parseUrl(tab.url);
    if (info) {
      secret.site = info.mainDomain;
    }
  }

  async function checkSetupComplete(): Promise<boolean> {
    const result = await chrome.storage.local.get<{ isSetupComplete?: boolean }>(['isSetupComplete']);
    return result.isSetupComplete === true;
  }

  async function openBackupDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(BACKUP_DB_NAME, BACKUP_DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(BACKUP_HANDLE_STORE)) {
          db.createObjectStore(BACKUP_HANDLE_STORE);
        }
      };
    });
  }

  async function getStoredBackupHandle(): Promise<FileSystemDirectoryHandle | null> {
    const db = await openBackupDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(BACKUP_HANDLE_STORE, 'readonly');
      const store = transaction.objectStore(BACKUP_HANDLE_STORE);
      const request = store.get('backupDirectory');

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  async function writeBackupToDirectory(backupData: unknown): Promise<BackupDirectoryWriteResult> {
    try {
      const handle = await getStoredBackupHandle();
      if (!handle) {
        return {
          success: false,
          error: getBackupDirectoryAccessError('no-handle')!,
          needAuth: true,
          locationLabel: UNSELECTED_BACKUP_LOCATION_LABEL
        };
      }

      const permission = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'prompt';

      if (permission !== 'granted') {
        return {
          success: false,
          error: getBackupDirectoryAccessError(permission)!,
          needAuth: true
        };
      }

      const filename = createBackupFilename(
        typeof backupData === 'object' && backupData !== null && 'encrypted' in backupData &&
          (backupData as { encrypted?: boolean }).encrypted === true
      );

      const fileHandle = await handle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(backupData, null, 2));
      await writable.close();

      return {
        success: true,
        filename,
        locationLabel: getCustomBackupLocationLabel(handle.name, filename)
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '写入备份目录失败'
      };
    }
  }

  async function scanQrImage(imageUrl: string, crop?: NormalizedRect): Promise<QrCandidate[]> {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Screenshot decode failed: ${response.status}`);
    const imageBitmap = await createImageBitmap(await response.blob());

    try {
      const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context unavailable');
      ctx.drawImage(imageBitmap, 0, 0);

      const candidates = new Map<string, QrCandidate>();
      for (const [x, y, width, height] of createScanRegions(canvas.width, canvas.height, crop)) {
        const safeWidth = Math.min(width, canvas.width - x);
        const safeHeight = Math.min(height, canvas.height - y);
        if (safeWidth <= 0 || safeHeight <= 0) continue;

        const imageData = ctx.getImageData(x, y, safeWidth, safeHeight);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'attemptBoth'
        });
        const secret = code?.data ? parseOtpAuth(code.data) : null;
        if (!code || !secret || candidates.has(secret.secret)) continue;

        const points = Object.values(code.location);
        candidates.set(secret.secret, {
          secret,
          rect: normalizeQrBounds(points, x, y, canvas.width, canvas.height)
        });
      }
      return [...candidates.values()];
    } finally {
      imageBitmap.close();
    }
  }

  async function captureTab(tab: chrome.tabs.Tab) {
    if (typeof tab.windowId !== 'number') throw new Error('无法确定当前窗口');
    return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  }

  async function sendToTab(tab: chrome.tabs.Tab, message: Record<string, unknown>) {
    if (typeof tab.id !== 'number') throw new Error('无法确定当前标签页');
    return chrome.tabs.sendMessage(tab.id, message);
  }

  async function acceptQrSecret(secret: PendingSecret, tab: chrome.tabs.Tab) {
    resolveSiteFromPage(secret, tab);
    await storePendingSecret(secret, tab);
    await chrome.action.openPopup();
  }

  async function startQrScan(tab?: chrome.tabs.Tab, crop?: NormalizedRect) {
    try {
      const setupComplete = await checkSetupComplete();
      if (!setupComplete) {
        showNotification('请先设置主密码', '点击扩展图标开始设置');
        return;
      }

      if (!tab) {
        [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      }
      if (!tab) {
        throw new Error('未找到可扫描的浏览器窗口，请先切换到要扫描的普通网页后重试');
      }

      const candidates = await scanQrImage(await captureTab(tab), crop);
      if (candidates.length === 1) {
        await acceptQrSecret(candidates[0].secret, tab);
        return;
      }

      if (candidates.length > 1) {
        await sendToTab(tab, { action: 'showQrCandidates', candidates });
        return;
      }

      await sendToTab(tab, {
        action: 'startQrSelection',
        message: crop ? '选区内未识别到 TOTP 二维码，请重新框选' : '未自动识别到二维码，请框选二维码区域'
      });
    } catch (error) {
      console.error('OpenPass: 页面二维码扫描失败', error);
      showNotification('二维码扫描失败', getQrScanErrorMessage(error));
    }
  }

  async function storePendingSecret(secret: PendingSecret, tab?: chrome.tabs.Tab) {
    let pageUrl = '';
    if (tab && tab.url) {
      pageUrl = tab.url;
    }

    if (!secret.site && pageUrl) {
      secret.site = pageUrl;
    }

    await chrome.storage.local.set({ pendingSecret: secret });
  }

  function showNotification(title: string, message: string) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message
    });
  }

  // 消息监听
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startQrScan') {
      void startQrScan(sender.tab).then(
        () => sendResponse({ success: true }),
        (error) => sendResponse({ error: (error as Error).message })
      );
      return true;
    }

    if (request.action === 'scanQrSelection' && sender.tab) {
      void startQrScan(sender.tab, request.rect as NormalizedRect).then(
        () => sendResponse({ success: true }),
        (error) => sendResponse({ error: (error as Error).message })
      );
      return true;
    }

    if (request.action === 'selectQrCandidate' && sender.tab) {
      void acceptQrSecret(request.secret as PendingSecret, sender.tab).then(
        () => sendResponse({ success: true }),
        (error) => sendResponse({ error: (error as Error).message })
      );
      return true;
    }

    if (request.action === 'generateCode') {
      (async () => {
        try {
          const totp = new TOTP({
            secret: request.secret,
            algorithm: 'SHA1',
            digits: request.digits || 6,
            period: 30
          });
          const code = totp.generate();
          const time = Math.floor(Date.now() / 1000);
          const remainingSeconds = 30 - (time % 30);
          sendResponse({ code, remainingSeconds });
        } catch (error) {
          sendResponse({ error: (error as Error).message });
        }
      })();
      return true;
    }

    // 缓存 sessionKey，供用户解锁时写入
    if (request.action === 'cacheSessionKey') {
      cachedSessionKey = request.sessionKey || null;
      if (cachedSessionKey) {
        void syncLatestLocalSnapshot().catch((error) => {
          console.error('OpenPass: 解锁后重试云端备份失败', error);
        });
      }
      sendResponse({ success: true });
      return true;
    }

    // 获取缓存的 sessionKey，供自动备份使用
    if (request.action === 'getCachedSessionKey') {
      sendResponse({ sessionKey: cachedSessionKey });
      return true;
    }

    // 测试自动备份
    if (request.action === 'testAutoBackup') {
      (async () => {
        console.log('[AutoBackup] 手动触发自动备份测试');
        sendResponse(await handleAutoBackup(true));
      })();
      return true;
    }

    if (request.action === 'testCloudBackupConnection') {
      void (async () => {
        try {
          const sessionKey = await getValidSessionKey();
          if (!sessionKey) throw new Error('请先解锁 OpenPass');
          sendResponse(await testS3CloudBackupConnection(sessionKey));
        } catch (error) {
          sendResponse({ error: error instanceof Error ? error.message : '云端连接测试失败' });
        }
      })();
      return true;
    }

    if (request.action === 'syncLatestCloudBackup') {
      void syncLatestLocalSnapshot(true).then(
        (result) => sendResponse({ success: true, result }),
        (error) => sendResponse({ error: error instanceof Error ? error.message : '云端同步失败' })
      );
      return true;
    }

    if (request.action === 'restoreLatestCloudBackup') {
      void (async () => {
        try {
          const sessionKey = await getValidSessionKey();
          if (!sessionKey) throw new Error('请先解锁 OpenPass');
          const backupData = await downloadLatestBackupFromS3<StoredSecret>(sessionKey);
          sendResponse({ success: true, backupData });
        } catch (error) {
          sendResponse({ error: error instanceof Error ? error.message : '云端恢复失败' });
        }
      })();
      return true;
    }

    if (request.action === 'checkSetup') {
      (async () => {
        const setupComplete = await checkSetupComplete();
        sendResponse({ setupComplete });
      })();
      return true;
    }

    if (request.action === 'getSecrets') {
      (async () => {
        try {
          const setupComplete = await checkSetupComplete();
          if (!setupComplete) {
            sendResponse({ error: 'not_setup' });
            return;
          }

          const result = await chrome.storage.local.get<{
            encryptedSecrets?: string;
            secrets?: StoredSecret[];
          }>(['encryptedSecrets', 'secrets']);

          // 优先尝试用缓存的 sessionKey 解密
          if (typeof result.encryptedSecrets === 'string' && cachedSessionKey) {
            const CryptoUtils = await import('../utils/crypto');
            const decrypted = await CryptoUtils.default.decrypt(result.encryptedSecrets, cachedSessionKey);
            const secrets = JSON.parse(decrypted);
            sendResponse({ secrets });
          } else if (typeof result.encryptedSecrets === 'string' && typeof request.sessionKey === 'string') {
            const CryptoUtils = await import('../utils/crypto');
            const decrypted = await CryptoUtils.default.decrypt(result.encryptedSecrets, request.sessionKey);
            const secrets = JSON.parse(decrypted);
            sendResponse({ secrets });
          } else if (Array.isArray(result.secrets)) {
            sendResponse({ secrets: result.secrets });
          } else {
            sendResponse({ secrets: [] });
          }
        } catch (error) {
          sendResponse({ error: (error as Error).message });
        }
      })();
      return true;
    }
  });

  // Badge 更新
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
      updateBadgeForTab(tabId, tab.url);
    }
  });

  chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab && tab.url) {
        updateBadgeForTab(activeInfo.tabId, tab.url);
      }
    });
  });

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && (changes.secrets || changes.encryptedSecrets || changes.sitesList)) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];
        if (activeTab?.url && typeof activeTab.id === 'number') {
          updateBadgeForTab(activeTab.id, activeTab.url);
        }
      });
    }

    if (
      namespace === 'local' &&
      (changes.enableAutoBackup || changes.backupFrequency || changes.nextBackupTime)
    ) {
      void syncAutoBackupAlarm().catch((error) => {
        console.error('OpenPass: 同步自动备份定时器失败', error);
      });
    }

    if (namespace === 'local' && changes.backupSnapshots) {
      void syncLatestLocalSnapshot().catch((error) => {
        console.error('OpenPass: 本地快照自动同步到云端失败', error);
      });
    }
  });

  // 自动备份定时器
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === AUTO_BACKUP_ALARM_NAME) {
      await handleAutoBackup();
    }
    if (alarm.name === CLOUD_BACKUP_RETRY_ALARM_NAME) {
      await syncLatestLocalSnapshot(true).catch((error) => {
        console.error('OpenPass: 云端备份重试失败', error);
      });
    }
  });

  function getBackupInterval(frequency?: BackupFrequency) {
    return BACKUP_INTERVALS[frequency ?? 'weekly'] ?? BACKUP_INTERVALS.weekly;
  }

  function getAutoBackupDelayInMinutes(nextBackupTime?: string | null) {
    if (!nextBackupTime) {
      return 60;
    }

    const nextTime = new Date(nextBackupTime).getTime();
    if (!Number.isFinite(nextTime)) {
      return 1;
    }

    const minutesUntilNextBackup = Math.ceil((nextTime - Date.now()) / (60 * 1000));
    return Math.max(1, minutesUntilNextBackup);
  }

  async function syncAutoBackupAlarm() {
    const settings = await chrome.storage.local.get<{
      enableAutoBackup?: boolean;
      nextBackupTime?: string;
    }>(['enableAutoBackup', 'nextBackupTime']);

    await chrome.alarms.clear(AUTO_BACKUP_ALARM_NAME);

    if (settings.enableAutoBackup !== true) {
      return;
    }

    chrome.alarms.create(AUTO_BACKUP_ALARM_NAME, {
      delayInMinutes: getAutoBackupDelayInMinutes(settings.nextBackupTime),
      periodInMinutes: 60
    });
  }

  async function getValidSessionKey() {
    if (cachedSessionKey) {
      return cachedSessionKey;
    }

    const [localResult, sessionResult] = await Promise.all([
      chrome.storage.local.get<{ sessionExpiresAt?: number }>(['sessionExpiresAt']),
      chrome.storage.session.get<{ sessionKey?: string }>(['sessionKey'])
    ]);

    if (
      typeof localResult.sessionExpiresAt === 'number' &&
      Date.now() > localResult.sessionExpiresAt
    ) {
      await chrome.storage.session.remove(['sessionKey']);
      cachedSessionKey = null;
      return null;
    }

    if (typeof sessionResult.sessionKey === 'string') {
      cachedSessionKey = sessionResult.sessionKey;
      return cachedSessionKey;
    }

    return null;
  }

  async function syncLatestLocalSnapshot(force = false) {
    if (cloudBackupInFlight) return cloudBackupInFlight;

    cloudBackupInFlight = (async () => {
      const result = await chrome.storage.local.get<{
        cloudBackupSettings?: { enabled?: boolean };
        cloudBackupStatus?: Record<string, unknown>;
        cloudBackupLastLocalTimestamp?: string;
        backupSnapshots?: Array<{
          data: BackupData<StoredSecret>;
          timestamp: string;
        }>;
      }>([
        'cloudBackupSettings',
        'cloudBackupStatus',
        'cloudBackupLastLocalTimestamp',
        'backupSnapshots'
      ]);

      if (result.cloudBackupSettings?.enabled !== true) return { skipped: 'disabled' };
      const latest = Array.isArray(result.backupSnapshots) ? result.backupSnapshots[0] : undefined;
      if (!latest?.data) throw new Error('没有可同步的本地快照，请先执行一次备份');
      if (!force && result.cloudBackupLastLocalTimestamp === latest.timestamp) {
        return { skipped: 'already-synced' };
      }

      const sessionKey = await getValidSessionKey();
      if (!sessionKey) {
        await chrome.storage.local.set({
          cloudBackupStatus: {
            ...(result.cloudBackupStatus || {}),
            state: 'pending',
            message: '本地快照已保存，解锁 OpenPass 后将自动上传'
          }
        });
        return { skipped: 'locked' };
      }

      try {
        const uploaded = await uploadBackupToS3(latest.data, sessionKey);
        await chrome.alarms.clear(CLOUD_BACKUP_RETRY_ALARM_NAME);
        await chrome.storage.local.set({
          cloudBackupLastLocalTimestamp: latest.timestamp,
          cloudBackupRetryCount: 0
        });
        return uploaded;
      } catch (error) {
        if (!isCloudBackupConflict(error)) {
          const retryState = await chrome.storage.local.get<{ cloudBackupRetryCount?: number }>([
            'cloudBackupRetryCount'
          ]);
          const retryCount = Math.min(
            typeof retryState.cloudBackupRetryCount === 'number'
              ? retryState.cloudBackupRetryCount + 1
              : 1,
            CLOUD_BACKUP_RETRY_MINUTES.length
          );
          await chrome.storage.local.set({ cloudBackupRetryCount: retryCount });
          chrome.alarms.create(CLOUD_BACKUP_RETRY_ALARM_NAME, {
            delayInMinutes: CLOUD_BACKUP_RETRY_MINUTES[retryCount - 1]
          });
        }
        throw error;
      }
    })();

    try {
      return await cloudBackupInFlight;
    } finally {
      cloudBackupInFlight = null;
    }
  }

  async function decryptStoredSecrets(encryptedSecrets: string, sessionKey: string) {
    const CryptoUtils = await import('../utils/crypto');
    const decrypted = await CryptoUtils.default.decrypt(encryptedSecrets, sessionKey);
    const parsed: unknown = JSON.parse(decrypted);
    return Array.isArray(parsed) ? (parsed as StoredSecret[]) : [];
  }

  async function resolveAutoBackupSecrets(
    settings: { encryptedSecrets?: string; secrets?: StoredSecret[] },
    sessionKey: string | null
  ) {
    if (typeof settings.encryptedSecrets === 'string' && sessionKey) {
      try {
        return await decryptStoredSecrets(settings.encryptedSecrets, sessionKey);
      } catch (error) {
        console.error('OpenPass: 自动备份解密失败，尝试使用明文缓存', error);
      }
    }

    return Array.isArray(settings.secrets) ? settings.secrets : [];
  }

  function createMasterPasswordEncryptedBackup(
    encryptedSecrets: string,
    count: number
  ): BackupData<StoredSecret> {
    return {
      format: 'openpass-backup',
      formatVersion: 1,
      appVersion: chrome.runtime.getManifest().version || '0.0.0',
      exportTime: new Date().toISOString(),
      exportPlatform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
      count,
      encrypted: true,
      encryptedData: encryptedSecrets,
      encryptionVersion: 1,
      kdf: 'PBKDF2',
      kdfIterations: 100000
    };
  }

  function createCustomPasswordEncryptedBackup(
    encryptedSecretsForBackup: string,
    count: number
  ): BackupData<StoredSecret> {
    return {
      format: 'openpass-backup',
      formatVersion: 1,
      appVersion: chrome.runtime.getManifest().version || '0.0.0',
      exportTime: new Date().toISOString(),
      exportPlatform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
      count,
      encrypted: true,
      encryptedData: encryptedSecretsForBackup,
      encryptionVersion: 1,
      kdf: 'PBKDF2',
      kdfIterations: 100000
    };
  }

   function getStoredSecretCount(settings: {
     secrets?: StoredSecret[];
     sitesList?: SiteListItem[];
     encryptedSecrets?: string;
     encryptedSecretsForBackup?: string;
   }) {
     if (Array.isArray(settings.secrets)) {
       return settings.secrets.length;
     }

     if (Array.isArray(settings.sitesList)) {
       return settings.sitesList.length;
     }

     // 如果有 encryptedSecrets 或 encryptedSecretsForBackup 说明至少有一个加密密钥
     return typeof settings.encryptedSecrets === 'string' || typeof settings.encryptedSecretsForBackup === 'string' ? 1 : 0;
   }

  async function handleAutoBackup(force = false): Promise<{
    success: boolean;
    message?: string;
    error?: string;
  }> {
    try {
      if (!force) {
        const checkResult = await checkBackupNeeded();
        if (!checkResult.needed) {
          return { success: false, error: '尚未到下一次自动备份时间' };
        }
      }

      const settings = await chrome.storage.local.get<{
        enableAutoBackup?: boolean;
        backupFrequency?: BackupFrequency;
        enableLocalSnapshot?: boolean;
        enableDirectoryBackup?: boolean;
        encryptedSecrets?: string;
        encryptedSecretsForBackup?: string;
        secrets?: StoredSecret[];
        sitesList?: SiteListItem[];
      }>([
        'enableAutoBackup',
        'backupFrequency',
        'enableLocalSnapshot',
        'enableDirectoryBackup',
        'encryptedSecrets',
        'encryptedSecretsForBackup',
        'secrets',
        'sitesList'
      ]);

      if (settings.enableAutoBackup !== true) {
        return { success: false, error: '自动备份未启用' };
      }

       const sessionKey = await getValidSessionKey();
       const encryptionSettings = await getBackupEncryptionSettings();
       let backupCount = 0;
       let backupData: BackupData<StoredSecret>;

        const isMasterPasswordFastPath =
          encryptionSettings.useMasterPasswordForBackup &&
          typeof settings.encryptedSecrets === 'string';
        const isCustomPasswordFastPath =
          encryptionSettings.enableBackupEncryption &&
          !encryptionSettings.useMasterPasswordForBackup &&
          typeof settings.encryptedSecretsForBackup === 'string';

        console.log('[AutoBackup] ========== 自动备份检查 ==========');
        console.log('[AutoBackup] 自动备份已启用:', settings.enableAutoBackup);
        console.log('[AutoBackup] 加密设置 - enableBackupEncryption:', encryptionSettings.enableBackupEncryption);
        console.log('[AutoBackup] 加密设置 - useMasterPasswordForBackup:', encryptionSettings.useMasterPasswordForBackup);
        console.log('[AutoBackup] encryptedSecrets 存在:', typeof settings.encryptedSecrets === 'string');
        console.log('[AutoBackup] encryptedSecretsForBackup 存在:', typeof settings.encryptedSecretsForBackup === 'string');
        console.log('[AutoBackup] sessionKey 存在:', !!sessionKey);
        console.log('[AutoBackup] isMasterPasswordFastPath:', isMasterPasswordFastPath);
        console.log('[AutoBackup] isCustomPasswordFastPath:', isCustomPasswordFastPath);
        console.log('[AutoBackup] =========================================');

        // 快速路径：复用已加密的数据，不需要sessionKey，即使会话过期也能备份
        if (isMasterPasswordFastPath) {
          console.log('[AutoBackup] 使用主密码快速路径');
          backupCount = getStoredSecretCount(settings);
          backupData = createMasterPasswordEncryptedBackup(
            settings.encryptedSecrets!,
            backupCount
          );
        } else if (isCustomPasswordFastPath) {
          console.log('[AutoBackup] 使用自定义密码快速路径');
          backupCount = getStoredSecretCount(settings);
          backupData = createCustomPasswordEncryptedBackup(
            settings.encryptedSecretsForBackup!,
            backupCount
          );
        } else {
          const secrets = await resolveAutoBackupSecrets(settings, sessionKey);
          if (secrets.length === 0) {
            return { success: false, error: '没有可备份的密钥' };
          }

          const backupPassword = await resolveStoredBackupPassword(
            sessionKey,
            encryptionSettings
          );

          if (encryptionSettings.enableBackupEncryption && !backupPassword) {
            console.warn('[AutoBackup] 缺少备份密码，跳过');
            showNotification('自动备份跳过', '请先解锁 OpenPass 或检查备份加密设置');
            return { success: false, error: '请先解锁 OpenPass 或检查备份加密设置' };
          }

          backupCount = secrets.length;
          backupData = await createBackupData(secrets, backupPassword);
        }

       let savedSnapshot = false;
       let directoryResult: BackupDirectoryWriteResult | undefined;

       if (settings.enableLocalSnapshot !== false) {
         await saveBackupSnapshot(backupData);
         savedSnapshot = true;
       }

       if (settings.enableDirectoryBackup) {
         directoryResult = await writeBackupToDirectory(backupData);
       }

       // 如果快速路径备份计数为0，仍然需要更新下一次备份时间
       const hasAnySuccess = savedSnapshot || (directoryResult?.success === true);
       const isFastPathWithZeroCount = 
         (isMasterPasswordFastPath || isCustomPasswordFastPath) && backupCount === 0;
       
       if (!hasAnySuccess && !isFastPathWithZeroCount) {
         if (directoryResult?.error) {
           showNotification('自动备份失败', directoryResult.error);
         }
         return { success: false, error: directoryResult?.error || '没有可用的备份目标' };
       }

       if (settings.enableDirectoryBackup && directoryResult?.success !== true) {
         const error = directoryResult?.error || '未生成目录备份文件';
         showNotification(
           savedSnapshot ? '自动备份部分完成' : '自动备份失败',
           savedSnapshot ? `本地快照已保存；目录备份失败：${error}` : error
         );
         return { success: false, error: `目录备份失败：${error}` };
       }

       const interval = getBackupInterval(settings.backupFrequency);
       const now = new Date();

       await chrome.storage.local.set({
         lastBackupTime: now.toISOString(),
         nextBackupTime: new Date(now.getTime() + interval).toISOString()
       });

       const messages = [];
       if (isMasterPasswordFastPath || isCustomPasswordFastPath) {
         messages.push('[快速路径] 无需解锁');
       }
       if (savedSnapshot) {
         messages.push(`已备份 ${backupCount} 个密钥到本地快照`);
       }
       if (directoryResult?.success) {
         messages.push(`已写入 ${directoryResult.locationLabel ?? directoryResult.filename}`);
       }

      if (messages.length > 0) {
        showNotification('自动备份完成', messages.join('；'));
      }
      return { success: true, message: messages.join('；') || '自动备份完成' };
    } catch (error) {
      console.error('OpenPass: 自动备份失败', error);
      showNotification('自动备份失败', (error as Error).message);
      return { success: false, error: (error as Error).message };
    }
  }

  async function checkBackupNeeded() {
    const settings = await chrome.storage.local.get<{
      enableAutoBackup?: boolean;
      backupFrequency?: BackupFrequency;
      lastBackupTime?: string;
      nextBackupTime?: string;
    }>([
      'enableAutoBackup',
      'backupFrequency',
      'lastBackupTime',
      'nextBackupTime'
    ]);

    if (settings.enableAutoBackup !== true) {
      return { needed: false, reason: 'disabled' };
    }

    if (settings.nextBackupTime) {
      const nextBackupTime = new Date(settings.nextBackupTime).getTime();
      if (!Number.isFinite(nextBackupTime) || Date.now() >= nextBackupTime) {
        return { needed: true, reason: 'due' };
      }

      return { needed: false, reason: 'not_due' };
    }

    if (!settings.lastBackupTime) {
      return { needed: true, reason: 'never' };
    }

    const interval = getBackupInterval(settings.backupFrequency);
    const lastBackup = new Date(settings.lastBackupTime);
    const elapsed = Date.now() - lastBackup.getTime();

    if (elapsed >= interval) {
      return { needed: true, reason: 'overdue' };
    }

    return { needed: false, reason: 'not_due' };
  }

  // 扩展启动时检查备份
  chrome.runtime.onStartup.addListener(async () => {
    await syncAutoBackupAlarm();
  });

  // 扩展更新时检查备份
  chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') return;

    await syncAutoBackupAlarm();
  });

  function safeSetBadge(tabId: number, text: string, color: string | null = null) {
    chrome.action.setBadgeText({ tabId, text }, () => {
      if (chrome.runtime.lastError) {
        return;
      }
    });
    if (color) {
      chrome.action.setBadgeBackgroundColor({ tabId, color }, () => {
        if (chrome.runtime.lastError) {
          return;
        }
      });
    }
  }

  async function updateBadgeForTab(tabId: number, url: string) {
    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
      safeSetBadge(tabId, '');
      return;
    }

    const result = await chrome.storage.local.get<{
      sitesList?: SiteListItem[];
      secrets?: StoredSecret[];
    }>(['sitesList', 'secrets']);
    let sites = Array.isArray(result.sitesList) ? result.sitesList : [];
    if (sites.length === 0 && Array.isArray(result.secrets)) {
      sites = result.secrets.map((secret) => ({ site: secret.site }));
    }

    const urlInfo = parseUrl(url);
    if (!urlInfo) {
      safeSetBadge(tabId, '');
      return;
    }

    let matchCount = 0;
    for (const item of sites) {
      if (isSiteMatched(urlInfo, item.site)) {
        matchCount++;
      }
    }

    if (matchCount > 0) {
      safeSetBadge(tabId, matchCount.toString(), '#4f46e5');
    } else {
      safeSetBadge(tabId, '');
    }
  }
});


