export const UNSELECTED_BACKUP_LOCATION_LABEL = '尚未选择（建议 Downloads/OpenPass）';
export const DEFAULT_BACKUP_DOWNLOAD_DIRECTORY = 'OpenPass';
export type BackupFileDestination = 'downloads' | 'directory';

export function getBackupFileSettings(settings: {
  backupFileDestination?: unknown;
  backupDownloadDirectory?: unknown;
  backupDirectory?: unknown;
  enableDirectoryBackup?: unknown;
}) {
  // Preserve existing custom directories. Changing destinations requires an
  // explicit user action; a permission failure must never redirect the backup.
  const destination: BackupFileDestination = settings.backupFileDestination === 'directory' ||
    (settings.backupFileDestination !== 'downloads' && (settings.enableDirectoryBackup === true ||
      (typeof settings.backupDirectory === 'string' && settings.backupDirectory !== '')))
    ? 'directory' : 'downloads';
  return {
    backupFileDestination: destination,
    backupDownloadDirectory: typeof settings.backupDownloadDirectory === 'string'
      ? settings.backupDownloadDirectory : DEFAULT_BACKUP_DOWNLOAD_DIRECTORY
  };
}

export function normalizeBackupDownloadDirectory(value: string): string {
  const directory = value.trim().replaceAll('\\', '/');
  if (!directory || directory.startsWith('/') || directory.split('/').some(part =>
    !part || part === '.' || part === '..' || /[:<>"|?*]/.test(part) || [...part].some(char => char.charCodeAt(0) < 32))) {
    throw new Error('请输入下载目录下的相对子目录，不能使用绝对路径或 ..');
  }
  return directory;
}

export function getDownloadBackupLocationLabel(directory: string) {
  return `浏览器下载目录/${directory}`;
}

export interface BackupDirectoryWriteResult {
  success: boolean;
  filename?: string;
  error?: string;
  needAuth?: boolean;
  locationLabel?: string;
  needDownloadPermission?: boolean;
}

export type BackupDirectoryPermission = PermissionState | 'no-handle';
export type BackupDirectoryAuthorizationAction = 'ready' | 'request-permission' | 'select-directory';

export function getBackupDirectoryAuthorizationAction(
  hasHandle: boolean,
  permission: BackupDirectoryPermission
): BackupDirectoryAuthorizationAction {
  if (hasHandle && permission === 'granted') return 'ready';
  if (hasHandle && permission === 'prompt') return 'request-permission';
  return 'select-directory';
}

export function getBackupDirectoryAccessError(
  permission: BackupDirectoryPermission
): string | null {
  if (permission === 'granted') return null;
  if (permission === 'no-handle') return '请先在设置中选择并授权备份目录';
  if (permission === 'denied') return '备份目录权限已被拒绝，请在设置中重新选择目录';
  return '备份目录需要重新授权，请打开设置完成授权';
}

export function createBackupFilename(encrypted: boolean): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -1);
  const suffix = encrypted ? '-encrypted' : '';
  return `openpass-backup-${timestamp}-${crypto.randomUUID().slice(0, 8)}${suffix}.json`;
}

export function getCustomBackupLocationLabel(directoryName: string, filename?: string): string {
  return filename ? `${directoryName}/${filename}` : directoryName;
}

export async function writeBackupToDownloads(
  backupData: unknown,
  directory: string
): Promise<BackupDirectoryWriteResult> {
  let locationLabel: string | undefined;
  try {
    const relativeDirectory = normalizeBackupDownloadDirectory(directory);
    locationLabel = getDownloadBackupLocationLabel(relativeDirectory);
    if (!chrome.downloads?.download || !await chrome.permissions.contains({ permissions: ['downloads'] })) {
      return { success: false, needDownloadPermission: true, locationLabel,
        error: '请在设置中首次启用下载备份权限，之后无需重复授权目录' };
    }
    const filename = createBackupFilename(
      typeof backupData === 'object' && backupData !== null && 'encrypted' in backupData && backupData.encrypted === true
    );
    // Register before starting: a small data URL can finish before download()
    // resolves. search() also covers a completed/interrupted event racing the ID.
    let id: number | undefined;
    let actualLocation: string | undefined;
    let resolveCompletion!: (result: BackupDirectoryWriteResult) => void;
    const completed = new Promise<BackupDirectoryWriteResult>(resolve => { resolveCompletion = resolve; });
    const finish = (success: boolean, error?: string) => resolveCompletion({ success, filename,
      locationLabel: actualLocation || `${locationLabel}/${filename}`, ...(error ? { error } : {}) });
    const changed = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== id) return;
      if (delta.filename?.current) actualLocation = delta.filename.current;
      if (delta.state?.current === 'complete') finish(true);
      else if (delta.state?.current === 'interrupted' || delta.error?.current) {
        finish(false, `备份文件下载中断：${delta.error?.current || 'interrupted'}`);
      }
    };
    chrome.downloads.onChanged.addListener(changed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      id = await chrome.downloads.download({
        url: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(backupData, null, 2))}`,
        filename: `${relativeDirectory}/${filename}`, saveAs: false, conflictAction: 'uniquify'
      });
      const [item] = await chrome.downloads.search({ id });
      if (item?.filename) actualLocation = item.filename;
      if (item?.state === 'complete') finish(true);
      else if (item?.state === 'interrupted') finish(false, `备份文件下载中断：${item.error || 'interrupted'}`);
      timer = setTimeout(() => finish(false, '备份文件下载尚未完成，请检查浏览器下载记录'), 20000);
      return await completed;
    } finally {
      if (timer) clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(changed);
    }
  } catch (error) {
    return { success: false, locationLabel, error: error instanceof Error ? error.message : '写入下载备份失败' };
  }
}
