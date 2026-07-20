export const UNSELECTED_BACKUP_LOCATION_LABEL = '尚未选择（建议 Downloads/OpenPass）';

export interface BackupDirectoryWriteResult {
  success: boolean;
  filename?: string;
  error?: string;
  needAuth?: boolean;
  locationLabel?: string;
}

export type BackupDirectoryPermission = PermissionState | 'no-handle';

export function getBackupDirectoryAccessError(
  permission: BackupDirectoryPermission
): string | null {
  if (permission === 'granted') return null;
  if (permission === 'no-handle') return '请先在设置中选择并授权备份目录';
  if (permission === 'denied') return '备份目录权限已被拒绝，请在设置中重新选择目录';
  return '备份目录需要重新授权，请打开设置完成授权';
}

export function createBackupFilename(encrypted: boolean): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const suffix = encrypted ? '-encrypted' : '';
  return `openpass-backup-${timestamp}${suffix}.json`;
}

export function getCustomBackupLocationLabel(directoryName: string, filename?: string): string {
  return filename ? `${directoryName}/${filename}` : directoryName;
}
