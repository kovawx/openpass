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
  createBackupFilename,
  getCustomBackupLocationLabel,
  writeBackupToDefaultDownloads,
  type BackupDirectoryWriteResult
} from '@/utils/backupDestination';
import { installGlobalRuntimeErrorListeners } from '@/utils/runtimeErrors';
import { isSiteMatched, parseUrl } from '@/utils/domainMatch';

type BackupFrequency = 'every5min' | 'daily' | 'weekly' | 'monthly';

interface StoredSecret {
  secret: string;
  site: string;
  name?: string;
  digits?: number;
}

type PendingSecret = StoredSecret;

interface SiteListItem {
  site: string;
}

const BACKUP_DB_NAME = 'OpenPassBackupDB';
const BACKUP_DB_VERSION = 1;
const BACKUP_HANDLE_STORE = 'handles';
const AUTO_BACKUP_ALARM_NAME = 'openpass-auto-backup';

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
        // 创建右键菜单（常驻：任何上下文都可见——二维码可能被包裹成 link/img/canvas
    // 等各种元素，用 all 避免漏掉某种上下文；点击走 captureVisibleTab 截屏，与右键
    // 的具体元素无关）
    chrome.contextMenus.create({
      id: 'parseQRCode',
      title: '识别并添加',
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
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== 'parseQRCode') {
      return;
    }

    const setupComplete = await checkSetupComplete();
    if (!setupComplete) {
      showNotification('请先设置主密码', '点击扩展图标开始设置');
      return;
    }

    // 解析二维码来源（混合策略，全部复用 parseQRFromImageUrl）：
    // 1) <img> 有 srcUrl：优先取原始图——原始资源是高清干净的，比截屏的屏幕渲染
    //    分辨率可靠（截屏可能被缩放/压低 DPI 导致 QR 模块糊掉而解码失败）。
    //    支持 http(s) / data: / blob: 等。
    // 2) canvas / 无 srcUrl / srcUrl 解码失败：用 captureVisibleTab 截取当前可见页面。
    const sources: Array<() => Promise<string | null>> = [];
    if (info.srcUrl) {
      const srcUrl = info.srcUrl;
      sources.push(async () => srcUrl);
    }
    if (tab && typeof tab.windowId === 'number') {
      const windowId = tab.windowId;
      sources.push(async () => {
        try {
          return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        } catch (error) {
          console.error('OpenPass: 截取页面失败', error);
          return null;
        }
      });
    }

    let secret: PendingSecret | null = null;
    for (const getSource of sources) {
      const source = await getSource();
      if (!source) continue;
      try {
        secret = await parseQRFromImageUrl(source);
      } catch (error) {
        // 单个来源解码抛错（如跨域 fetch 被拦），尝试下一个来源
        console.warn('OpenPass: 该来源解码失败，尝试下一个', error);
        continue;
      }
      if (secret) break;
    }

    if (secret) {
      // 提取到的站点不是域名（如 issuer 是 "GitHub" 之类的名字或为空）时，
      // 用当前页面主域名替换，保证后续站点匹配生效。
      resolveSiteFromPage(secret, tab);
      await storePendingSecret(secret, tab);
      chrome.action.openPopup();
    } else if (sources.length === 0) {
      showNotification('识别失败', '无法确定当前窗口');
    } else {
      showNotification('识别失败', '未检测到有效的 TOTP 二维码');
    }
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
        return writeBackupToDefaultDownloads(backupData);
      }

      let permission = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'prompt';
      if (permission === 'prompt') {
        permission = (await handle.requestPermission?.({ mode: 'readwrite' })) ?? 'denied';
      }

      if (permission !== 'granted') {
        return {
          success: false,
          error: permission === 'denied' ? '权限被拒绝，请重新授权备份目录' : '需要授权写入权限',
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
        locationLabel: getCustomBackupLocationLabel(handle.name, filename),
        usesDefaultPath: false
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '写入备份目录失败'
      };
    }
  }

  async function parseQRFromImageUrl(url: string) {
    try {
      let blob;

      if (url.startsWith('data:')) {
        const response = await fetch(url);
        blob = await response.blob();
      } else {
        const response = await fetch(url, { mode: 'cors' });
        blob = await response.blob();
      }

      const imageBitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('2D canvas context unavailable');
      }
      ctx.drawImage(imageBitmap, 0, 0);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert'
      });

      if (code && code.data) {
        return parseOTPAuthUrl(code.data);
      }
      return null;
    } catch (error) {
      console.error('解析 QR 码失败', error);
      throw error;
    }
  }

  function parseOTPAuthUrl(data: string) {
    if (/^[A-Z2-7]+=*$/i.test(data.trim())) {
      return {
        secret: data.trim().toUpperCase().replace(/\s/g, ''),
        site: '',
        name: ''
      };
    }

    if (data.startsWith('otpauth://')) {
      try {
        const url = new URL(data);
        const params = new URLSearchParams(url.search);
        const secret = params.get('secret');
        if (!secret) return null;

        const issuer = params.get('issuer') || '';
        const account = decodeURIComponent(url.pathname.split('/').pop() || '');

        let site = issuer;
        if (!site && account.includes(':')) {
          site = account.split(':')[0];
        }

        return {
          secret: secret.toUpperCase(),
          site: site.toLowerCase(),
          name: issuer || account.replace(/.*:/, '')
        };
      } catch {
        return null;
      }
    }
    return null;
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
        await handleAutoBackup();
        sendResponse({ success: true });
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
  });

  // 自动备份定时器
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === AUTO_BACKUP_ALARM_NAME) {
      await handleAutoBackup();
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

  async function handleAutoBackup() {
    try {
      const checkResult = await checkBackupNeeded();
      if (!checkResult.needed) return;

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

      if (settings.enableAutoBackup !== true) return;

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
            settings.encryptedSecrets,
            backupCount
          );
        } else if (isCustomPasswordFastPath) {
          console.log('[AutoBackup] 使用自定义密码快速路径');
          backupCount = getStoredSecretCount(settings);
          backupData = createCustomPasswordEncryptedBackup(
            settings.encryptedSecretsForBackup,
            backupCount
          );
        } else {
          const secrets = await resolveAutoBackupSecrets(settings, sessionKey);
          if (secrets.length === 0) return;

          const backupPassword = await resolveStoredBackupPassword(
            sessionKey,
            encryptionSettings
          );

          if (encryptionSettings.enableBackupEncryption && !backupPassword) {
            console.warn('[AutoBackup] 缺少备份密码，跳过');
            showNotification('自动备份跳过', '请先解锁 OpenPass 或检查备份加密设置');
            return;
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
         return;
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
    } catch (error) {
      console.error('OpenPass: 自动备份失败', error);
      showNotification('自动备份失败', (error as Error).message);
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


