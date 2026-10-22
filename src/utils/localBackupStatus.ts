export interface LocalBackupStatus {
  state: 'idle' | 'success' | 'partial' | 'error';
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastSnapshotAt: string | null;
  lastFileAt: string | null;
  error: string | null;
  locationLabel: string | null;
  needAuth: boolean;
  nextRetryAt: string | null;
}

export const DEFAULT_LOCAL_BACKUP_STATUS: LocalBackupStatus = {
  state: 'idle', lastAttemptAt: null, lastSuccessAt: null, lastSnapshotAt: null,
  lastFileAt: null, error: null, locationLabel: null, needAuth: false, nextRetryAt: null
};

export async function loadLocalBackupStatus(): Promise<LocalBackupStatus> {
  const { localBackupStatus } = await chrome.storage.local.get<{ localBackupStatus?: Partial<LocalBackupStatus> }>(['localBackupStatus']);
  return { ...DEFAULT_LOCAL_BACKUP_STATUS, ...localBackupStatus };
}

export async function recordLocalBackupResult(result: {
  success: boolean; snapshot: boolean; fileEnabled: boolean; fileSuccess?: boolean;
  needAuth?: boolean; error?: string; locationLabel?: string; snapshotAt?: string;
}, frequency: string): Promise<{ status: LocalBackupStatus; notify: boolean }> {
  const previous = await loadLocalBackupStatus();
  const now = new Date().toISOString();
  const status: LocalBackupStatus = {
    ...previous,
    state: result.success ? 'success' : result.snapshot || result.fileSuccess ? 'partial' : 'error',
    lastAttemptAt: now,
    lastSuccessAt: result.success ? now : previous.lastSuccessAt,
    lastSnapshotAt: result.snapshot ? result.snapshotAt || now : previous.lastSnapshotAt,
    lastFileAt: result.fileEnabled && result.fileSuccess ? now : previous.lastFileAt,
    error: result.success ? null : result.error || '备份失败',
    locationLabel: result.locationLabel || previous.locationLabel,
    needAuth: result.needAuth === true,
    // Five-minute tests retry at their own cadence; normal schedules retry in
    // fifteen minutes without advancing the full-success timestamp.
    nextRetryAt: result.success ? null : new Date(Date.now() + (frequency === 'every5min' ? 5 : 15) * 60000).toISOString()
  };
  await chrome.storage.local.set({ localBackupStatus: status });
  return { status, notify: result.success || previous.state !== status.state || previous.error !== status.error };
}

export async function clearLocalBackupRetry() {
  const result = await chrome.runtime.sendMessage({ action: 'clearLocalBackupRetry' });
  if (result?.error) throw new Error(result.error);
}

// Called under the background vault lock so clearing a retry cannot overwrite
// the completion status of a backup that is already running.
export async function resetLocalBackupRetry() {
  const status = await loadLocalBackupStatus();
  await chrome.storage.local.set({ localBackupStatus: { ...status, nextRetryAt: null } });
}
