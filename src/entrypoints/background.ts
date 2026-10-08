import jsQR from 'jsqr';
import CryptoUtils from '@/utils/crypto';
import { getBackupSchedule } from '@/utils/backupSchedule';
import { decodeRestoreBackup, planRestore, type RestoreMode } from '@/utils/restore';
import { generateOtp, normalizeOtpSettings } from '@/utils/otp';
import { readVault, writeVault, normalizeVaultSecrets, mergeHotpCounters, applyHotpCounters,
  prepareDeviceOtpState, readDeviceOtpVault, writeDeviceOtpCounters, assertDeviceOtpAccess, toOtpAccount, migrateLegacyVault, type VaultSecret } from '@/utils/vault';
import { getValidSessionKey, requireSessionKey, assertSessionKey, SESSION_ALARM } from '@/utils/session';
import {
  type BackupData,
  createBackupData,
  validateBackupData,
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
import { installGlobalRuntimeErrorListeners, type ErrorEventTarget } from '@/utils/runtimeErrors';
import {
  getBackupSyncMetadata,
  loadSecretTombstones,
  getOrCreateSyncDeviceId,
  getSecretTimestamp,
  mergeSyncState,
  type SyncSecretLike
} from '@/utils/syncMerge';
import {
  applyCloudBackupRetention,
  downloadCloudBackupVersion,
  deleteCloudBackupVersions,
  downloadLatestBackupFromS3,
  downloadLatestBackupStateFromS3,
  isCloudBackupConflict,
  listCloudBackupVersions,
  testS3CloudBackupConnection,
  uploadBackupToS3
} from '@/utils/s3CloudBackup';
import { isSiteMatched, parseUrl, matchSecrets } from '@/utils/domainMatch';
import { parseOtpAuth } from '@/utils/otpAuth';
import {
  createScanRegions,
  getQrScanErrorMessage,
  normalizeQrBounds,
  type NormalizedRect
} from '@/utils/qrScan';

type BackupFrequency = 'every5min' | 'daily' | 'weekly' | 'monthly';

type StoredSecret = VaultSecret;
type PendingSecret = Omit<VaultSecret, 'id'>;

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
const CLOUD_BACKUP_PULL_ALARM_NAME = 'openpass-cloud-backup-pull';
const CLOUD_BACKUP_RETRY_MINUTES = [5, 15, 60, 180];

const BACKUP_INTERVALS: Record<BackupFrequency, number> = {
  every5min: 5 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000
};

export default defineBackground(() => {
  installGlobalRuntimeErrorListeners('background', self as unknown as ErrorEventTarget);

  // 所有密钥写入及云端合并串行处理，逐次验证会话。
  let vaultOperation: Promise<unknown> = Promise.resolve();
  function withVaultLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = vaultOperation.then(operation);
    vaultOperation = result.catch(() => {});
    return result;
  }
  const isTrustedPage = (sender: chrome.runtime.MessageSender) =>
    sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));

  let cloudBackupInFlight: Promise<unknown> | null = null;
  let cloudPullInFlight: Promise<unknown> | null = null;
  let backupScheduleUpdate: Promise<void> = Promise.resolve();

  void Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  ]).catch((error) => console.error('OpenPass: 限制存储访问失败', error));

  // 升级时已有管理会话可直接初始化免密副本，不要求用户再输一次密码。
  void withVaultLock(async () => {
    const key = await getValidSessionKey();
    if (!key) return;
    const state = await chrome.storage.local.get(['encryptedSecrets', 'deviceOtpEnabled', 'deviceOtpRevision', 'encryptedDeviceOtpSecrets']);
    if (state.deviceOtpEnabled === false || typeof state.encryptedSecrets !== 'string' ||
        (state.deviceOtpRevision === state.encryptedSecrets && typeof state.encryptedDeviceOtpSecrets === 'string')) return;
    const deviceOtpState = await prepareDeviceOtpState(await readVault(key), state.encryptedSecrets);
    await assertSessionKey(key);
    const current = await chrome.storage.local.get(['encryptedSecrets']);
    if (current.encryptedSecrets !== state.encryptedSecrets) return;
    await chrome.storage.local.set(deviceOtpState);
    await notifyVaultChanged();
  }).catch((error) => console.error('OpenPass: 初始化验证码免密失败', error));

  async function notifyVaultChanged() {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(async (tab) => {
      if (typeof tab.id !== 'number') return;
      try { await chrome.tabs.sendMessage(tab.id, { action: 'vaultChanged' }); } catch { /* 未注入内容脚本 */ }
    }));
  }

  async function syncSessionAlarm() {
    await chrome.alarms.clear(SESSION_ALARM);
    if (!await getValidSessionKey()) return;
    const { sessionExpiresAt } = await chrome.storage.local.get<{ sessionExpiresAt: number }>(['sessionExpiresAt']);
    await chrome.alarms.create(SESSION_ALARM, { when: sessionExpiresAt });
  }
  void syncSessionAlarm().catch(console.error);
  void syncAutoBackupAlarm().catch(console.error);

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

      await requireSessionKey();
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
        message: crop ? '选区内未识别到 OTP 二维码，请重新框选' : '未自动识别到二维码，请框选二维码区域'
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

    await requireSessionKey();
    await chrome.storage.session.set({ pendingSecret: secret });
  }

  function showNotification(title: string, message: string) {
    void chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message
    }).catch((error) => console.warn('OpenPass: 通知失败', error));
  }

  // 消息监听
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const contentActions = ['getSecrets', 'generateCode', 'consumeCode', 'startQrScan', 'scanQrSelection', 'selectQrCandidate', 'checkSetup'];
    if (!isTrustedPage(sender) && !contentActions.includes(request.action)) {
      sendResponse({ error: '该操作仅允许在 OpenPass 扩展页面执行' });
      return;
    }
    if (request.action === 'migrateVaultForUnlock') {
      void withVaultLock(async () => {
        const state = await chrome.storage.local.get(['masterPasswordHash', 'masterPasswordSalt']);
        if (typeof request.password !== 'string' || !await CryptoUtils.verifyMasterPassword(request.password,
          String(state.masterPasswordHash), String(state.masterPasswordSalt))) throw new Error('主密码错误');
        await migrateLegacyVault(request.password);
        return { success: true };
      }).then(sendResponse, (error) => sendResponse({ error: error.message }));
      return true;
    }
    if (request.action === 'setDeviceOtpEnabled') {
      void withVaultLock(async () => {
        const key = await requireSessionKey();
        if (typeof request.enabled !== 'boolean') throw new Error('免密设置格式无效');
        const secrets = await readVault(key);
        const { encryptedSecrets } = await chrome.storage.local.get<{ encryptedSecrets?: string }>(['encryptedSecrets']);
        if (!encryptedSecrets) await writeVault(secrets, key, { deviceOtpEnabled: request.enabled });
        else {
          const state = await prepareDeviceOtpState(secrets, encryptedSecrets, request.enabled);
          await assertSessionKey(key);
          await chrome.storage.local.set(state);
        }
        await notifyVaultChanged();
        return { success: true };
      }).then(sendResponse, (error) => sendResponse({ error: error.message }));
      return true;
    }
    if (request.action === 'changeMasterPassword') {
      void withVaultLock(async () => {
        const key = await requireSessionKey();
        const state = await chrome.storage.local.get(['masterPasswordHash', 'masterPasswordSalt',
          'encryptedSecrets', 'encryptedBackupPassword', 'encryptedCloudBackupSecrets', 'encryptedPendingSecret', 'backupSnapshots']);
        if (typeof request.currentPassword !== 'string' || typeof request.password !== 'string' || request.password.length < 6 ||
          !await CryptoUtils.verifyMasterPassword(request.currentPassword, String(state.masterPasswordHash), String(state.masterPasswordSalt))) {
          throw new Error('当前密码错误或新密码格式无效');
        }
        const password = request.password as string;
        const updates: Record<string, unknown> = {};
        for (const field of ['encryptedSecrets', 'encryptedBackupPassword', 'encryptedCloudBackupSecrets', 'encryptedPendingSecret']) {
          if (typeof state[field] === 'string') updates[field] = await CryptoUtils.encrypt(await CryptoUtils.decrypt(state[field] as string, key), password);
        }
        if (Array.isArray(state.backupSnapshots)) {
          updates.backupSnapshots = await Promise.all(state.backupSnapshots.map(async (snapshot) => {
            if (!snapshot.data?.encryptedData) return snapshot;
            try {
              const data = await CryptoUtils.decrypt(snapshot.data.encryptedData, key);
              return { ...snapshot, data: { ...snapshot.data, encryptedData: await CryptoUtils.encrypt(data, password) } };
            } catch { return snapshot; } // 独立密码或历史密码快照保持原样，可手动输入旧密码恢复。
          }));
        }
        const verifier = await CryptoUtils.createMasterPasswordHash(password);
        if (typeof updates.encryptedSecrets === 'string') {
          Object.assign(updates, await prepareDeviceOtpState(await readVault(key), updates.encryptedSecrets));
        }
        await assertSessionKey(key);
        await chrome.storage.local.set({ ...updates, masterPasswordHash: verifier.hash, masterPasswordSalt: verifier.salt });
        await chrome.storage.session.set({ sessionKey: password });
        conflictReview = null;
        return { success: true };
      }).then(sendResponse, (error) => sendResponse({ error: error.message }));
      return true;
    }
    if (request.action === 'prepareVaultClear' || request.action === 'clearVault' || request.action === 'prepareCloudVersionDelete' || request.action === 'deleteCloudBackupVersion' || request.action === 'resetLocalData') {
      void withVaultLock(async () => {
        if (request.action === 'prepareVaultClear') return prepareVaultClear(request.scope);
        if (request.action === 'clearVault') return clearVault(request.token, request.confirmation);
        const key = await requireSessionKey();
        if (request.action === 'resetLocalData') {
          if (request.confirmation !== 'RESET') throw new Error('请明确确认重置本机数据');
          await chrome.storage.local.set({ cloudBackupSettings: { enabled: false } });
          await chrome.alarms.clear(CLOUD_BACKUP_RETRY_ALARM_NAME);
          await chrome.storage.session.clear(); await chrome.storage.local.clear();
          clearReview = null; cloudDeleteReview = null; conflictReview = null;
          return { success: true };
        }
        const context = await chrome.storage.local.get(['cloudBackupSettings', 'encryptedCloudBackupSecrets']);
        const config = JSON.stringify([context.cloudBackupSettings, context.encryptedCloudBackupSecrets]);
        if (request.action === 'prepareCloudVersionDelete') {
          if (typeof request.key !== 'string') throw new Error('无效的云端版本');
          const version = (await listCloudBackupVersions(key)).find(entry => entry.key === request.key);
          if (!version || version.current) throw new Error('版本不存在或为受保护的当前同步版本');
          await assertCloudContext(key, config);
          cloudDeleteReview = { token: globalThis.crypto.randomUUID(), expires: Date.now() + 300000, key: version.key, config };
          return { success: true, token: cloudDeleteReview.token };
        }
        const review = cloudDeleteReview;
        if (!review || review.token !== request.token || review.expires < Date.now() || request.confirmation !== 'DELETE') throw new Error('请重新确认删除所选云端版本');
        await assertCloudContext(key, review.config);
        const result = await deleteCloudBackupVersions([review.key], key, () => assertCloudContext(key, review.config));
        if (result.failed.length) throw new Error(result.failed[0].error);
        cloudDeleteReview = null;
        return { success: true, deleted: result.deleted };
      }).then(sendResponse, (error) => sendResponse({ error: error.message }));
      return true;
    }
    if (request.action === 'restoreVault' || request.action === 'compareCloudConflict' || request.action === 'resolveCloudConflict') {
      void withVaultLock(async () => {
        if (request.action === 'restoreVault') return restoreVault(request.backupData, request.mode, request.password);
        if (request.action === 'compareCloudConflict') return compareCloudConflict();
        return resolveCloudConflict(request.token, request.choice);
      }).then(sendResponse, (error) => sendResponse({ error: error.message }));
      return true;
    }
    if (request.action === 'saveVault') {
      void withVaultLock(async () => {
        const key = await requireSessionKey();
        const current = await readVault(key);
        if (typeof request.expectedSecrets !== 'string' || request.expectedSecrets !== JSON.stringify(current)) {
          throw new Error('密钥已被其他页面或设备更新，请刷新后重新操作');
        }
        const next = normalizeVaultSecrets(request.secrets).map((entry) => {
          const previous = current.find((record) => record.id === entry.id && record.secret === entry.secret);
          const result = entry.type === 'hotp' && previous?.type === 'hotp'
            ? { ...entry, counter: Math.max(entry.counter ?? 0, previous.counter ?? 0) } : entry;
          if (!previous || JSON.stringify(result) !== JSON.stringify(previous)) {
            result.updatedAt = new Date(Math.max(Date.now(), getSecretTimestamp(result), previous ? getSecretTimestamp(previous) : 0) + 1).toISOString();
          }
          return result;
        });
        const removed = current.filter((entry) => !next.some((record) => record.id === entry.id));
        const tombstones = await loadSecretTombstones();
        const deletedAt = new Date(Math.max(Date.now(), ...removed.map(getSecretTimestamp)) + 1).toISOString();
        const deviceId = await getOrCreateSyncDeviceId();
        const removedIds = new Set(removed.map((entry) => entry.id));
        const nextTombstones = [...tombstones.filter((entry) => !removedIds.has(entry.id)),
          ...removed.map(({ id }) => ({ id, deletedAt, deviceId }))];
        await writeVault(next, key, { secretTombstones: nextTombstones });
        if (request.triggerSnapshot) {
          const settings = await getBackupEncryptionSettings();
          const password = await resolveStoredBackupPassword(key, settings) || key;
          await saveBackupSnapshot(await createBackupData(await readVault(key), password));
        }
        return { success: true, secrets: await readVault(key) };
      }).then(sendResponse, (error) => sendResponse({ error: error.message }));
      return true;
    }

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

    if (request.action === 'generateCode' || request.action === 'consumeCode') {
      void withVaultLock(async () => {
        const key = await getValidSessionKey();
        const device = key ? null : await readDeviceOtpVault();
        const secrets = key ? await readVault(key) : device!.secrets;
        let secret = typeof request.id === 'string' ? secrets.find((entry) => entry.id === request.id) : undefined;
        if (!secret && isTrustedPage(sender) && typeof request.secret === 'string' && request.action === 'generateCode') {
          if (!key) throw new Error('编辑密钥需要先解锁 OpenPass');
          secret = { ...normalizeOtpSettings(request), id: '', site: '', secret: request.secret };
        }
        if (!secret) throw new Error('密钥不存在');
        if (!isTrustedPage(sender)) {
          const page = sender.url ? parseUrl(sender.url) : null;
          if (!page || !isSiteMatched(page, secret.site)) throw new Error('当前页面与密钥站点不匹配');
        }
        const result = generateOtp(secret.secret, secret);
        if (request.action === 'consumeCode' && secret.type === 'hotp') {
          secret.counter = (secret.counter ?? 0) + 1;
          secret.updatedAt = new Date().toISOString();
          if (key) {
            await writeVault(secrets, key);
            await saveBackupSnapshot(await createBackupData(secrets, key));
          } else {
            device!.context = await writeDeviceOtpCounters(secrets, device!.context);
          }
        }
        if (key) await assertSessionKey(key);
        else await assertDeviceOtpAccess(device!.context);
        return result;
      }).then(sendResponse, (error) => sendResponse({ error: error.message }));
      return true;
    }

    if (request.action === 'sessionChanged') {
      void (async () => {
        await syncSessionAlarm();
        await notifyVaultChanged();
        if (await getValidSessionKey()) void synchronizeCloudState().catch(console.error);
        return { success: true };
      })().then(sendResponse, (error) => sendResponse({ error: error.message }));
      return true;
    }

    // 测试自动备份
    if (request.action === 'updateBackupSchedule') {
      void syncAutoBackupAlarm().then(() => sendResponse({ success: true }),
        (error) => sendResponse({ error: error.message }));
      return true;
    }
    if (request.action === 'testAutoBackup') {
      (async () => {
        sendResponse(await withVaultLock(() => handleAutoBackup(true)));
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

    if (request.action === 'createChangeBackup') {
      void (async () => {
        try {
          const sessionKey = await getValidSessionKey();
          if (!sessionKey) throw new Error('请先解锁 OpenPass');
          const secrets = await readVault(sessionKey);
          const encryptionSettings = await getBackupEncryptionSettings();
          const backupPassword = await resolveStoredBackupPassword(sessionKey, encryptionSettings);
          if (encryptionSettings.enableBackupEncryption && !backupPassword) {
            throw new Error('无法获取备份密码');
          }
          await saveBackupSnapshot(await createBackupData(secrets, backupPassword || sessionKey));
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ error: error instanceof Error ? error.message : '创建同步快照失败' });
        }
      })();
      return true;
    }

    if (request.action === 'syncLatestCloudBackup') {
      void synchronizeCloudState(true).then(
        (result) => sendResponse(typeof result === 'object' && result !== null && 'skipped' in result &&
          (result.skipped === 'locked' || result.skipped === 'disabled')
          ? { error: result.skipped === 'locked' ? '请先解锁 OpenPass' : '云端同步未启用' }
          : { success: true, result }),
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

    if (request.action === 'listCloudBackupVersions') {
      void (async () => {
        try {
          const sessionKey = await getValidSessionKey();
          if (!sessionKey) throw new Error('请先解锁 OpenPass');
          sendResponse({
            success: true,
            versions: await listCloudBackupVersions(sessionKey)
          });
        } catch (error) {
          sendResponse({ error: error instanceof Error ? error.message : '读取历史版本失败' });
        }
      })();
      return true;
    }

    if (request.action === 'restoreCloudBackupVersion') {
      void (async () => {
        try {
          const sessionKey = await getValidSessionKey();
          if (!sessionKey) throw new Error('请先解锁 OpenPass');
          if (typeof request.key !== 'string') throw new Error('无效的历史版本标识');
          const backupData = await downloadCloudBackupVersion<StoredSecret>(
            request.key,
            sessionKey
          );
          sendResponse({ success: true, backupData });
        } catch (error) {
          sendResponse({ error: error instanceof Error ? error.message : '历史版本恢复失败' });
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
      void (async () => {
        const key = await getValidSessionKey();
        if (!key) {
          try {
            const { secrets } = await readDeviceOtpVault();
            return { locked: true, otpAvailable: true,
              secrets: (isTrustedPage(sender) ? secrets : matchSecrets(sender.url || '', secrets)).map(toOtpAccount) };
          } catch (error) {
            return { secrets: [], locked: true, otpAvailable: false, message: (error as Error).message };
          }
        }
        const secrets = await readVault(key);
        if (isTrustedPage(sender)) return { secrets, locked: false };
        return { locked: false, secrets: matchSecrets(sender.url || '', secrets)
          .map(({ id, site, name, type, digits, period, algorithm, counter }) => ({ id, site, name, type, digits, period, algorithm, counter })) };
      })().then(sendResponse, (error) => sendResponse({ error: error.message, secrets: [] }));
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
    if ((namespace === 'local' && (changes.encryptedSecrets || changes.encryptedDeviceOtpSecrets || changes.deviceOtpEnabled || changes.sessionExpiresAt)) ||
        (namespace === 'session' && changes.sessionKey)) {
      void notifyVaultChanged().catch(console.error);
    }
    if (namespace === 'local' && changes.sessionExpiresAt) void syncSessionAlarm().catch(console.error);

    if (namespace === 'local' && (changes.secrets || changes.encryptedSecrets || changes.sitesList)) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) return;
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
      void synchronizeCloudState().catch((error) => {
        console.error('OpenPass: 本地快照双向同步失败', error);
      });
    }

    if (namespace === 'local' && changes.cloudBackupSettings) {
      void (async () => {
        await syncAutoBackupAlarm();
        await synchronizeCloudState();
        const sessionKey = await getValidSessionKey();
        const enabled = (changes.cloudBackupSettings.newValue as { enabled?: boolean } | undefined)
          ?.enabled;
        if (sessionKey && enabled === true) await applyCloudBackupRetention(sessionKey);
      })().catch((error) => {
        console.error('OpenPass: 应用云端同步配置失败', error);
      });
    }
  });

  // 自动备份定时器
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === SESSION_ALARM) { await getValidSessionKey(); await notifyVaultChanged(); }
    if (alarm.name === AUTO_BACKUP_ALARM_NAME) {
      await runBackupCycle();
    }
    if (alarm.name === CLOUD_BACKUP_RETRY_ALARM_NAME) {
      await synchronizeCloudState(true).catch((error) => {
        console.error('OpenPass: 云端备份重试失败', error);
      });
    }
  });

  function getBackupInterval(frequency?: BackupFrequency) {
    return BACKUP_INTERVALS[frequency ?? 'weekly'] ?? BACKUP_INTERVALS.weekly;
  }

  function syncAutoBackupAlarm() {
    const result = backupScheduleUpdate.then(updateBackupAlarm);
    backupScheduleUpdate = result.catch(() => {});
    return result;
  }
  async function updateBackupAlarm() {
    const settings = await chrome.storage.local.get<{
      enableAutoBackup?: boolean;
      nextBackupTime?: string;
      backupFrequency?: string;
      cloudBackupSettings?: { enabled?: boolean };
    }>(['enableAutoBackup', 'nextBackupTime', 'backupFrequency', 'cloudBackupSettings']);
    await chrome.alarms.clear(AUTO_BACKUP_ALARM_NAME);
    await chrome.alarms.clear(CLOUD_BACKUP_PULL_ALARM_NAME);
    const schedule = getBackupSchedule(settings);
    if (schedule) await chrome.alarms.create(AUTO_BACKUP_ALARM_NAME, schedule);
  }
  async function runBackupCycle() {
    const { enableAutoBackup } = await chrome.storage.local.get(['enableAutoBackup']);
    if (enableAutoBackup === true) await withVaultLock(() => handleAutoBackup());
    await synchronizeCloudState().catch((error) => console.error('OpenPass: 备份任务云端同步失败', error));
  }

  async function syncLatestLocalSnapshot(
    force = false,
    expectedLatestETag?: string | null
  ) {
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
      if (result.cloudBackupStatus?.state === 'conflict') throw new Error('请先解决云端冲突');
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
        const uploaded = await uploadBackupToS3(
          latest.data,
          sessionKey,
          expectedLatestETag
        );
        await applyCloudBackupRetention(sessionKey, uploaded.snapshotKey);
        await chrome.alarms.clear(CLOUD_BACKUP_RETRY_ALARM_NAME);
        await chrome.storage.local.set({
          cloudBackupLastLocalTimestamp: latest.timestamp,
          cloudBackupLastPulledETag: uploaded.etag,
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

  type SyncStoredSecret = StoredSecret & SyncSecretLike;

  function normalizeSecretsForSync(
    secrets: StoredSecret[],
    fallbackTime: string
  ): SyncStoredSecret[] {
    return secrets
      .filter((secret) => typeof secret.secret === 'string' && typeof secret.site === 'string')
      .map((secret) => {
        const createdAt = secret.createdAt || secret.importedAt || fallbackTime;
        return {
          ...secret,
          id: secret.id || globalThis.crypto.randomUUID(),
          createdAt,
          updatedAt: secret.updatedAt || createdAt
        };
      });
  }

  async function persistMergedSyncState(
    secrets: SyncStoredSecret[],
    tombstones: Awaited<ReturnType<typeof loadSecretTombstones>>,
    sessionKey: string,
    hotpCounters?: Record<string, number>
  ) {
    const encryptionSettings = await getBackupEncryptionSettings();
    const backupPassword = await resolveStoredBackupPassword(sessionKey, encryptionSettings);
    if (encryptionSettings.enableBackupEncryption && !backupPassword) {
      throw new Error('无法解密备份密码，已停止多设备同步');
    }

    const saved = await writeVault(secrets, sessionKey, { secretTombstones: tombstones, hotpCounters });
    await saveBackupSnapshot(await createBackupData(saved, backupPassword || sessionKey));
  }

  async function synchronizeCloudState(force = false) {
    if (cloudPullInFlight) return cloudPullInFlight;
    cloudPullInFlight = withVaultLock(async () => {
      const state = await chrome.storage.local.get(['cloudBackupSettings', 'cloudBackupStatus', 'cloudBackupLastPulledETag', 'encryptedCloudBackupSecrets']);
      if (!(state.cloudBackupSettings as { enabled?: boolean })?.enabled) return { skipped: 'disabled' };
      if ((state.cloudBackupStatus as { state?: string })?.state === 'conflict') {
        throw new Error('云端存在并发冲突，请先比较并选择保留方式');
      }
      const key = await getValidSessionKey();
      if (!key) {
        await chrome.storage.local.set({ cloudBackupStatus: { ...(state.cloudBackupStatus as object), state: 'pending', message: '等待解锁后同步' } });
        return { skipped: 'locked' };
      }
      const config = JSON.stringify([state.cloudBackupSettings, state.encryptedCloudBackupSecrets]);
      const local = normalizeSecretsForSync(await readVault(key), '1970-01-01T00:00:00.000Z');
      const localTombstones = await loadSecretTombstones();
      let remote;
      try { remote = await downloadLatestBackupStateFromS3<StoredSecret>(key); }
      catch (error) {
        if (!(error instanceof Error) || error.name !== 'CloudBackupNotFound') throw error;
        remote = null;
      }
      await assertCloudContext(key, config);
      if (remote && !remote.etag) throw new Error('S3 未返回 ETag，无法安全同步');
      if (remote && !force && remote.etag === state.cloudBackupLastPulledETag) {
        return syncLatestLocalSnapshot(false, remote.etag);
      }
      const settings = await getBackupEncryptionSettings();
      const password = await resolveStoredBackupPassword(key, settings);
      const remoteSecrets = remote ? await decodeRestoreBackup(remote.backupData, [password || key, key]) : [];
      const merged = mergeSyncState(local, localTombstones,
        normalizeSecretsForSync(remoteSecrets, remote?.backupData.exportTime || new Date().toISOString()),
        remote?.backupData.sync?.tombstones ?? []);
      const metadata = await getBackupSyncMetadata();
      const adjusted = await applyHotpCounters(merged.secrets, mergeHotpCounters(metadata.hotpCounters, remote?.backupData.sync?.hotpCounters));
      const backup = await createBackupData(adjusted.secrets, password || key);
      backup.sync = { ...metadata, tombstones: merged.tombstones, hotpCounters: adjusted.counters };
      // 先条件上传；412 或网络失败时不覆盖本地数据。
      const uploaded = await uploadBackupToS3(backup, key, remote?.etag ?? null);
      await assertCloudContext(key, config);
      await persistMergedSyncState(adjusted.secrets, merged.tombstones, key, adjusted.counters);
      const snapshots = await chrome.storage.local.get<{ backupSnapshots?: Array<{ timestamp: string }> }>(['backupSnapshots']);
      await chrome.storage.local.set({ cloudBackupLastPulledETag: uploaded.etag,
        cloudBackupLastLocalTimestamp: snapshots.backupSnapshots?.[0]?.timestamp,
        cloudBackupRetryCount: 0 });
      await chrome.alarms.clear(CLOUD_BACKUP_RETRY_ALARM_NAME);
      await applyCloudBackupRetention(key, uploaded.snapshotKey);
      return { merged: merged.changed, count: merged.secrets.length };
    });
    try { return await cloudPullInFlight; }
    catch (error) {
      const { cloudBackupStatus } = await chrome.storage.local.get<{ cloudBackupStatus?: Record<string, unknown> }>(['cloudBackupStatus']);
      if (!isCloudBackupConflict(error) && cloudBackupStatus?.state !== 'conflict') {
        await chrome.storage.local.set({ cloudBackupStatus: { ...cloudBackupStatus, state: 'error',
          message: error instanceof Error ? error.message : '多设备同步失败' } });
      }
      if (!isCloudBackupConflict(error) && cloudBackupStatus?.state !== 'conflict') {
        const retryState = await chrome.storage.local.get<{ cloudBackupRetryCount?: number }>(['cloudBackupRetryCount']);
        const retryCount = Math.min((retryState.cloudBackupRetryCount ?? 0) + 1, CLOUD_BACKUP_RETRY_MINUTES.length);
        await chrome.storage.local.set({ cloudBackupRetryCount: retryCount });
        await chrome.alarms.create(CLOUD_BACKUP_RETRY_ALARM_NAME, { delayInMinutes: CLOUD_BACKUP_RETRY_MINUTES[retryCount - 1] });
      }
      throw error;
    } finally { cloudPullInFlight = null; }
  }

  async function assertCloudContext(key: string, config: string) {
    await assertSessionKey(key);
    const { cloudBackupSettings, encryptedCloudBackupSecrets } = await chrome.storage.local.get(['cloudBackupSettings', 'encryptedCloudBackupSecrets']);
    if (JSON.stringify([cloudBackupSettings, encryptedCloudBackupSecrets]) !== config) throw new Error('云端配置已变更，请重新同步');
  }

  let clearReview: { token: string; expires: number; scope: 'local' | 'cloud'; revision: unknown;
    config: string; etag: string | null; secrets: StoredSecret[];
    tombstones: Awaited<ReturnType<typeof loadSecretTombstones>>; historyKeys: string[] } | null = null;
  let cloudDeleteReview: { token: string; expires: number; key: string; config: string } | null = null;
  async function prepareVaultClear(scope: string) {
    if (scope !== 'local' && scope !== 'cloud') throw new Error('请选择清理范围');
    const key = await requireSessionKey();
    const state = await chrome.storage.local.get(['encryptedSecrets', 'cloudBackupSettings', 'encryptedCloudBackupSecrets']);
    const config = JSON.stringify([state.cloudBackupSettings, state.encryptedCloudBackupSecrets]);
    const local = await readVault(key);
    let remote: StoredSecret[] = [];
    let etag: string | null = null;
    let tombstones = await loadSecretTombstones();
    let historyKeys: string[] = [];
    if (scope === 'cloud') {
      const cloud = await downloadLatestBackupStateFromS3<StoredSecret>(key, true).catch((error) => {
        if (error.name === 'CloudBackupNotFound') return null;
        throw error;
      });
      if (cloud && !cloud.etag) throw new Error('云端未返回同步版本，不能安全清理');
      etag = cloud?.etag ?? null;
      const settings = await getBackupEncryptionSettings();
      const password = await resolveStoredBackupPassword(key, settings);
      remote = cloud ? await decodeRestoreBackup(cloud.backupData, [password || key, key]) : [];
      tombstones = mergeSyncState(local, tombstones, remote, cloud?.backupData.sync?.tombstones || []).tombstones;
      historyKeys = (await listCloudBackupVersions(key)).map(version => version.key);
      await assertCloudContext(key, config);
    }
    clearReview = { token: globalThis.crypto.randomUUID(), expires: Date.now() + 300000, scope,
      revision: state.encryptedSecrets, config, etag, secrets: [...local, ...remote], tombstones, historyKeys };
    return { success: true, token: clearReview.token, localCount: local.length, remoteCount: remote.length,
      historyCount: historyKeys.length, bucket: (state.cloudBackupSettings as { bucket?: string })?.bucket,
      prefix: (state.cloudBackupSettings as { prefix?: string })?.prefix };
  }
  async function clearVault(token: string, confirmation: string) {
    const key = await requireSessionKey();
    const review = clearReview;
    if (!review || review.token !== token || review.expires < Date.now()) throw new Error('确认已失效，请重新检查清理范围');
    if (confirmation !== (review.scope === 'cloud' ? 'DELETE CLOUD' : 'DELETE')) throw new Error('请输入正确的确认文字');
    const state = await chrome.storage.local.get(['encryptedSecrets', 'cloudBackupSettings']);
    if (state.encryptedSecrets !== review.revision) throw new Error('密钥已变更，请重新检查清理范围');
    await assertCloudContext(key, review.config);
    if (review.scope === 'local') {
      const settings = state.cloudBackupSettings as object | undefined;
      await chrome.storage.local.set({ cloudBackupSettings: { ...settings, enabled: false },
        cloudBackupStatus: { state: 'disabled', message: '仅清理本机，云端数据已保留' } });
      await chrome.alarms.clear(CLOUD_BACKUP_RETRY_ALARM_NAME);
      await writeVault([], key, { secretTombstones: [] });
      await chrome.storage.local.remove(['backupSnapshots', 'cloudBackupLastLocalTimestamp', 'cloudBackupLastPulledETag']);
      clearReview = null;
      return { success: true, scope: 'local' };
    }
    const plan = planRestore(review.secrets, [], review.tombstones, 'replace', await getOrCreateSyncDeviceId());
    const tombstones = mergeSyncState([], plan.tombstones, [], []).tombstones;
    const backup = await createBackupData([], key);
    backup.sync = { ...await getBackupSyncMetadata(), tombstones };
    // Commit the empty state conditionally before clearing local data or deleting reviewed history.
    const uploaded = await uploadBackupToS3(backup, key, review.etag, true);
    await assertCloudContext(key, review.config);
    await writeVault([], key, { secretTombstones: tombstones });
    await chrome.storage.local.remove(['backupSnapshots', 'cloudBackupLastLocalTimestamp']);
    const baseline = await saveBackupSnapshot(backup);
    await chrome.storage.local.set({ cloudBackupLastPulledETag: uploaded.etag,
      cloudBackupLastLocalTimestamp: baseline[0]?.timestamp });
    clearReview = null;
    const cleanup = await deleteCloudBackupVersions(review.historyKeys, key, () => assertCloudContext(key, review.config)).catch((error) => ({
      deleted: 0, failed: [{ key: '', error: error.message }] }));
    const warning = cleanup.failed.length ? `密钥已清空，但部分云端历史删除失败：${cleanup.failed[0].error}` : null;
    return { success: true, scope: 'cloud', deleted: cleanup.deleted, warning };
  }

  async function restoreVault(backup: unknown, mode: RestoreMode, manualPassword?: string) {
    const key = await requireSessionKey();
    const settings = await getBackupEncryptionSettings();
    const password = await resolveStoredBackupPassword(key, settings);
    const incoming = await decodeRestoreBackup(backup, [manualPassword || '', password || key, key]);
    const current = await readVault(key);
    const plan = planRestore(current, incoming, await loadSecretTombstones(), mode, await getOrCreateSyncDeviceId());
    await saveBackupSnapshot(await createBackupData(current, key));
    await persistMergedSyncState(plan.secrets, plan.tombstones, key, validateBackupData(backup).data?.sync?.hotpCounters);
    return { success: true, count: plan.secrets.length };
  }

  let conflictReview: { token: string; revision: unknown; config: string; etag: string;
    local: StoredSecret[]; remote: StoredSecret[]; hotpCounters?: Record<string, number>; tombstones: Awaited<ReturnType<typeof loadSecretTombstones>> } | null = null;

  async function compareCloudConflict() {
    const key = await requireSessionKey();
    const context = await chrome.storage.local.get(['cloudBackupSettings', 'encryptedCloudBackupSecrets']);
    const config = JSON.stringify([context.cloudBackupSettings, context.encryptedCloudBackupSecrets]);
    const remote = await downloadLatestBackupStateFromS3<StoredSecret>(key);
    if (!remote.etag) throw new Error('S3 未返回 ETag，无法安全解决并发冲突');
    const settings = await getBackupEncryptionSettings();
    const password = await resolveStoredBackupPassword(key, settings);
    const remoteSecrets = await decodeRestoreBackup(remote.backupData, [password || key, key]);
    await assertCloudContext(key, config);
    const local = await readVault(key);
    const state = await chrome.storage.local.get(['encryptedSecrets', 'cloudBackupSettings']);
    conflictReview = { token: globalThis.crypto.randomUUID(), revision: state.encryptedSecrets,
      config, etag: remote.etag, local, remote: remoteSecrets,
      tombstones: remote.backupData.sync?.tombstones ?? [], hotpCounters: remote.backupData.sync?.hotpCounters };
    const ids = new Set([...local, ...remoteSecrets].map((entry) => entry.id));
    return { token: conflictReview.token, localCount: local.length, remoteCount: remoteSecrets.length,
      differences: [...ids].flatMap((id) => {
        const left = local.find((entry) => entry.id === id);
        const right = remoteSecrets.find((entry) => entry.id === id);
        if (JSON.stringify(left) === JSON.stringify(right)) return [];
        return [{ id, local: left ? { site: left.site, name: left.name, counter: left.counter, updatedAt: left.updatedAt } : null,
          remote: right ? { site: right.site, name: right.name, counter: right.counter, updatedAt: right.updatedAt } : null,
          keyChanged: !!left && !!right && left.secret !== right.secret }];
      }) };
  }

  async function resolveCloudConflict(token: string, choice: string) {
    const key = await requireSessionKey();
    const review = conflictReview;
    if (!review || token !== review.token || !['local', 'remote', 'merge'].includes(choice)) throw new Error('请重新比较冲突');
    const state = await chrome.storage.local.get(['encryptedSecrets']);
    if (state.encryptedSecrets !== review.revision) throw new Error('本地数据已变更，请重新比较');
    await assertCloudContext(key, review.config);
    const localTombstones = await loadSecretTombstones();
    const merged = mergeSyncState(review.local, localTombstones, review.remote, review.tombstones);
    const plan = choice === 'merge' ? merged : planRestore(
      [...review.remote, ...review.local],
      choice === 'local' ? review.local : review.remote,
      merged.tombstones, 'replace', await getOrCreateSyncDeviceId());
    // 提交前保留本地密文；只用比较时读取的 ETag 更新 latest。
    await saveBackupSnapshot(await createBackupData(review.local, key));
    const metadata = await getBackupSyncMetadata();
    const adjusted = await applyHotpCounters(plan.secrets, mergeHotpCounters(metadata.hotpCounters, review.hotpCounters));
    const backup = await createBackupData(adjusted.secrets, key);
    backup.sync = { ...metadata, tombstones: plan.tombstones, hotpCounters: adjusted.counters };
    const uploaded = await uploadBackupToS3(backup, key, review.etag);
    await assertCloudContext(key, review.config);
    await persistMergedSyncState(adjusted.secrets, plan.tombstones, key, adjusted.counters);
    await chrome.storage.local.set({ cloudBackupLastPulledETag: uploaded.etag });
    conflictReview = null;
    await applyCloudBackupRetention(key, uploaded.snapshotKey);
    return { success: true, count: plan.secrets.length };
  }

  async function resolveAutoBackupSecrets(_settings: unknown, sessionKey: string | null) {
    return sessionKey ? readVault(sessionKey) : [];
  }

  async function createMasterPasswordEncryptedBackup(
    encryptedSecrets: string,
    count: number
  ): Promise<BackupData<StoredSecret>> {
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
      kdfIterations: 100000,
      sync: await getBackupSyncMetadata()
    };
  }

  async function createCustomPasswordEncryptedBackup(
    encryptedSecretsForBackup: string,
    count: number
  ): Promise<BackupData<StoredSecret>> {
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
      kdfIterations: 100000,
      sync: await getBackupSyncMetadata()
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


        // 快速路径：复用已加密的数据，不需要sessionKey，即使会话过期也能备份
        if (isMasterPasswordFastPath) {
          backupCount = getStoredSecretCount(settings);
          backupData = await createMasterPasswordEncryptedBackup(
            settings.encryptedSecrets!,
            backupCount
          );
        } else if (isCustomPasswordFastPath) {
          backupCount = getStoredSecretCount(settings);
          backupData = await createCustomPasswordEncryptedBackup(
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
    await runBackupCycle();
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
