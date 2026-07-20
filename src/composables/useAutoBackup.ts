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
  type BackupDirectoryWriteResult
} from '@/utils/backupDestination';
import { getErrorMessage } from '@/utils/error';

export interface BackupSettings {
  enableAutoBackup: boolean;
  backupFrequency: 'every5min' | 'daily' | 'weekly' | 'monthly';
  enableLocalSnapshot: boolean;
  enableDirectoryBackup: boolean;
  backupDirectory: string;
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
const ALARM_NAME = 'openpass-auto-backup';

export function useAutoBackup() {
  const settings = ref<BackupSettings>({
    enableAutoBackup: false,
    backupFrequency: 'weekly',
    enableLocalSnapshot: true,
    enableDirectoryBackup: false,
    backupDirectory: '',
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
      lastBackupTime?: string;
      nextBackupTime?: string;
    }>([
      'enableAutoBackup',
      'backupFrequency',
      'enableLocalSnapshot',
      'enableDirectoryBackup',
      'backupDirectory',
      'lastBackupTime',
      'nextBackupTime'
    ]);

    settings.value = {
      enableAutoBackup: result.enableAutoBackup === true,
      backupFrequency: result.backupFrequency ?? 'weekly',
      enableLocalSnapshot: result.enableLocalSnapshot !== false,
      enableDirectoryBackup: result.enableDirectoryBackup === true,
      backupDirectory: typeof result.backupDirectory === 'string' ? result.backupDirectory : '',
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
    await chrome.alarms.clear(ALARM_NAME);
    const nextBackupTime = settings.value.nextBackupTime
      ? new Date(settings.value.nextBackupTime).getTime()
      : Number.NaN;
    const delayInMinutes = Number.isFinite(nextBackupTime)
      ? Math.max(1, Math.ceil((nextBackupTime - Date.now()) / (60 * 1000)))
      : 60;

    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes,
      periodInMinutes: 60
    });
  }

  async function clearAlarm() {
    await chrome.alarms.clear(ALARM_NAME);
    settings.value.nextBackupTime = null;
    await saveSettings({ nextBackupTime: null });
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
      request.onsuccess = () => resolve();
    });
  }

  async function getStoredHandle(): Promise<FileSystemDirectoryHandle | null> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get('backupDirectory');

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  async function removeHandle() {
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete('backupDirectory');

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async function selectDirectory(): Promise<{ success: boolean; name?: string; error?: string }> {
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
      if (error instanceof Error && error.name === 'AbortError') {
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
    const handle = await getStoredHandle();
    if (!handle) {
      return { success: false, error: '未选择备份目录' };
    }

    try {
      const permission = await handle.requestPermission?.({ mode: 'readwrite' });
      return { success: permission === 'granted' };
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
      directory?: BackupDirectoryWriteResult;
    } = {
      snapshot: false,
      directory: undefined
    };

    if (settings.value.enableLocalSnapshot) {
      await saveSnapshot(backupData);
      results.snapshot = true;
    }

    if (settings.value.enableDirectoryBackup) {
      results.directory = await writeToDirectory(backupData);
    }

    const allEnabledTargetsSucceeded =
      (!settings.value.enableLocalSnapshot || results.snapshot) &&
      (!settings.value.enableDirectoryBackup || results.directory?.success === true);

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
