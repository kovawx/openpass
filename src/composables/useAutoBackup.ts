import { ref } from 'vue';
import {
  createBackupData,
  saveBackupSnapshot,
  type BackupData,
  type BackupSecretLike
} from '@/utils/backup';
import {
  UNSELECTED_BACKUP_LOCATION_LABEL,
  createBackupFilename,
  getBackupDirectoryAccessError,
  getCustomBackupLocationLabel,
  getBackupFileSettings,
  writeBackupToDownloads,
  type BackupFileDestination,
  type BackupDirectoryWriteResult
} from '@/utils/backupDestination';
import { getErrorMessage } from '@/utils/error';
import { recordLocalBackupResult } from '@/utils/localBackupStatus';

export interface BackupSettings {
  enableAutoBackup: boolean;
  backupFrequency: 'every5min' | 'daily' | 'weekly' | 'monthly';
  enableLocalSnapshot: boolean;
  enableDirectoryBackup: boolean;
  backupDirectory: string;
  backupFileDestination: BackupFileDestination;
  backupDownloadDirectory: string;
  lastBackupTime: string | null;
  nextBackupTime: string | null;
}

export interface DirectoryInfo {
  hasHandle: boolean;
  name: string | null;
  permission: 'granted' | 'prompt' | 'denied' | 'no-handle';
  locationLabel: string;
}

interface BackupSnapshot<T = BackupSecretLike> {
  data: BackupData<T>;
  timestamp: string;
  count: number;
}

const DB_NAME = 'OpenPassBackupDB';
const DB_VERSION = 1;
const STORE_NAME = 'handles';

export function useAutoBackup() {
  // Load the handle when displaying directory status so a later click can request
  // permission immediately, without waiting for IndexedDB and losing activation.
  let directoryHandle: FileSystemDirectoryHandle | null = null;
  const settings = ref<BackupSettings>({
    enableAutoBackup: false,
    backupFrequency: 'weekly',
    enableLocalSnapshot: true,
    enableDirectoryBackup: false,
    backupDirectory: '',
    ...getBackupFileSettings({}),
    lastBackupTime: null,
    nextBackupTime: null
  });

  async function loadSettings(): Promise<BackupSettings> {
    const result = await chrome.storage.local.get<{
      enableAutoBackup?: boolean;
      backupFrequency?: BackupSettings['backupFrequency'];
      enableLocalSnapshot?: boolean;
      enableDirectoryBackup?: boolean;
      backupDirectory?: string;
      backupFileDestination?: string;
      backupDownloadDirectory?: string;
      lastBackupTime?: string;
      nextBackupTime?: string;
    }>([
      'enableAutoBackup',
      'backupFrequency',
      'enableLocalSnapshot',
      'enableDirectoryBackup',
      'backupDirectory',
      'backupFileDestination', 'backupDownloadDirectory',
      'lastBackupTime',
      'nextBackupTime'
    ]);

    settings.value = {
      enableAutoBackup: result.enableAutoBackup === true,
      backupFrequency: result.backupFrequency ?? 'weekly',
      enableLocalSnapshot: result.enableLocalSnapshot !== false,
      enableDirectoryBackup: result.enableDirectoryBackup === true,
      backupDirectory: typeof result.backupDirectory === 'string' ? result.backupDirectory : '',
      ...getBackupFileSettings(result),
      lastBackupTime: typeof result.lastBackupTime === 'string' ? result.lastBackupTime : null,
      nextBackupTime: typeof result.nextBackupTime === 'string' ? result.nextBackupTime : null
    };

    return settings.value;
  }

  async function saveSettings(newSettings: Partial<BackupSettings>) {
    settings.value = { ...settings.value, ...newSettings };

    await chrome.storage.local.set({
      enableAutoBackup: settings.value.enableAutoBackup,
      backupFrequency: settings.value.backupFrequency,
      enableLocalSnapshot: settings.value.enableLocalSnapshot,
      enableDirectoryBackup: settings.value.enableDirectoryBackup,
      backupDirectory: settings.value.backupDirectory,
      backupFileDestination: settings.value.backupFileDestination,
      backupDownloadDirectory: settings.value.backupDownloadDirectory,
      lastBackupTime: settings.value.lastBackupTime,
      nextBackupTime: settings.value.nextBackupTime
    });
  }

  function getBackupInterval(frequency: BackupSettings['backupFrequency']): number {
    switch (frequency) {
      case 'every5min':
        return 5 * 60 * 1000;
      case 'daily':
        return 24 * 60 * 60 * 1000;
      case 'weekly':
        return 7 * 24 * 60 * 60 * 1000;
      case 'monthly':
        return 30 * 24 * 60 * 60 * 1000;
      default:
        return 7 * 24 * 60 * 60 * 1000;
    }
  }

  async function setupAlarm() {
    const result = await chrome.runtime.sendMessage({ action: 'updateBackupSchedule' });
    if (result?.error) throw new Error(result.error);
  }

  async function clearAlarm() {
    settings.value.nextBackupTime = null;
    await saveSettings({ nextBackupTime: null });
    await setupAlarm();
  }

  async function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
    });
  }

  async function saveHandle(handle: FileSystemDirectoryHandle) {
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(handle, 'backupDirectory');

      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => {
        directoryHandle = handle;
        db.close();
        resolve();
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error ?? new Error('保存备份目录失败'));
      };
    });
  }

  async function getStoredHandle(): Promise<FileSystemDirectoryHandle | null> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get('backupDirectory');

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        directoryHandle = request.result || null;
        resolve(directoryHandle);
      };
      transaction.oncomplete = () => db.close();
    });
  }

  async function removeHandle() {
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete('backupDirectory');

      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => {
        directoryHandle = null;
        db.close();
        resolve();
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error ?? new Error('移除备份目录失败'));
      };
    });
  }

  async function selectDirectory(): Promise<{ success: boolean; name?: string; error?: string }> {
    let directorySelected = false;
    try {
      if (!('showDirectoryPicker' in window)) {
        return {
          success: false,
          error: '浏览器不支持选择目录，请使用 Chrome 86 或更高版本'
        };
      }

      const handle = await window.showDirectoryPicker({
        mode: 'readwrite',
        id: 'openpass-backup-dir'
      });
      directorySelected = true;

      const permission = (await handle.requestPermission?.({ mode: 'readwrite' })) ??
        (await handle.queryPermission?.({ mode: 'readwrite' })) ??
        'denied';
      if (permission !== 'granted') {
        return { success: false, error: '未获得目录写入权限' };
      }

      await saveHandle(handle);
      await chrome.storage.local.set({ backupDirectory: handle.name });
      settings.value.backupDirectory = handle.name;

      return { success: true, name: handle.name };
    } catch (error) {
      if (!directorySelected && error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: '已取消选择' };
      }

      return { success: false, error: getErrorMessage(error) };
    }
  }

  async function getDirectoryInfo(): Promise<DirectoryInfo> {
    const handle = await getStoredHandle();

    if (!handle) {
      return {
        hasHandle: false,
        name: null,
        permission: 'no-handle',
        locationLabel: UNSELECTED_BACKUP_LOCATION_LABEL
      };
    }

    try {
      const permission = await handle.queryPermission?.({ mode: 'readwrite' });
      return {
        hasHandle: true,
        name: handle.name,
        permission: permission ?? 'prompt',
        locationLabel: getCustomBackupLocationLabel(handle.name)
      };
    } catch {
      return {
        hasHandle: true,
        name: handle.name,
        permission: 'prompt',
        locationLabel: getCustomBackupLocationLabel(handle.name)
      };
    }
  }

  async function requestPermission(): Promise<{ success: boolean; error?: string }> {
    try {
      const handle = directoryHandle ?? await getStoredHandle();
      if (!handle) {
        return { success: false, error: '未选择备份目录' };
      }
      const permission = await handle.requestPermission?.({ mode: 'readwrite' });
      if (permission === 'granted') return { success: true };
      return { success: false, error: '未获得目录写入权限，请重新选择目录并允许写入' };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  }

  async function writeToDirectory<T extends BackupSecretLike>(
    backupData: BackupData<T>
  ): Promise<BackupDirectoryWriteResult> {
    try {
      const handle = await getStoredHandle();

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

      const filename = createBackupFilename(backupData.encrypted);
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
      return { success: false, error: getErrorMessage(error) };
    }
  }

  async function saveSnapshot<T extends BackupSecretLike>(backupData: BackupData<T>) {
    return saveBackupSnapshot(backupData);
  }

  async function getSnapshots() {
    const result = await chrome.storage.local.get<{ backupSnapshots?: BackupSnapshot[] }>([
      'backupSnapshots'
    ]);
    return Array.isArray(result.backupSnapshots) ? result.backupSnapshots : [];
  }

  async function createBackup<T extends BackupSecretLike>(
    secrets: T[],
    options: { password?: string } = {}
  ) {
    return createBackupData(secrets, options.password);
  }

  async function performBackup<T extends BackupSecretLike>(
    secrets: T[],
    options: { password?: string } = {}
  ) {
    const backupData = await createBackup(secrets, options);
    const results: {
      snapshot: boolean;
      snapshotError?: string;
      directory?: BackupDirectoryWriteResult;
    } = {
      snapshot: false,
      directory: undefined
    };

    if (settings.value.enableLocalSnapshot) {
      try {
        await saveSnapshot(backupData);
        results.snapshot = true;
      } catch (error) { results.snapshotError = getErrorMessage(error, '保存快照失败'); }
    }

    if (settings.value.enableDirectoryBackup) {
      results.directory = settings.value.backupFileDestination === 'downloads'
        ? await writeBackupToDownloads(backupData, settings.value.backupDownloadDirectory)
        : await writeToDirectory(backupData);
    }

    const allEnabledTargetsSucceeded = (settings.value.enableLocalSnapshot || settings.value.enableDirectoryBackup) &&
      (!settings.value.enableLocalSnapshot || results.snapshot) &&
      (!settings.value.enableDirectoryBackup || results.directory?.success === true);
    await recordLocalBackupResult({
      success: allEnabledTargetsSucceeded, snapshot: results.snapshot,
      fileEnabled: settings.value.enableDirectoryBackup, fileSuccess: results.directory?.success,
      needAuth: results.directory?.needAuth || results.directory?.needDownloadPermission,
      error: [results.snapshotError ? `本地快照失败：${results.snapshotError}` : '', results.directory?.error || ''].filter(Boolean).join('；') ||
        (!allEnabledTargetsSucceeded ? '请至少启用一个备份目标' : undefined),
      locationLabel: results.directory?.locationLabel
    }, settings.value.backupFrequency);

    if (allEnabledTargetsSucceeded) {
      const now = new Date().toISOString();
      const interval = getBackupInterval(settings.value.backupFrequency);
      const nextBackup = new Date(Date.now() + interval).toISOString();

      await saveSettings({
        lastBackupTime: now,
        nextBackupTime: nextBackup
      });

      if (settings.value.enableAutoBackup) {
        await setupAlarm();
      }
    }

    return results;
  }

  return {
    settings,
    loadSettings,
    saveSettings,
    getBackupInterval,
    setupAlarm,
    clearAlarm,
    selectDirectory,
    getDirectoryInfo,
    requestPermission,
    writeToDirectory,
    saveSnapshot,
    getSnapshots,
    createBackup,
    performBackup,
    removeHandle
  };
}
