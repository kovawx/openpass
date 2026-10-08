export function getBackupSchedule(settings: {
  enableAutoBackup?: boolean;
  nextBackupTime?: string | null;
  backupFrequency?: string;
  cloudBackupSettings?: { enabled?: boolean };
}, now = Date.now()) {
  const cloud = settings.cloudBackupSettings?.enabled === true;
  if (!cloud && settings.enableAutoBackup !== true) return null;
  const next = settings.nextBackupTime ? Date.parse(settings.nextBackupTime) : NaN;
  const localDelay = settings.enableAutoBackup === true
    ? Number.isFinite(next) ? Math.max(1, Math.ceil((next - now) / 60000)) : 1 : Infinity;
  return { delayInMinutes: Math.min(localDelay, cloud ? 1 : 60),
    periodInMinutes: cloud || settings.backupFrequency === 'every5min' ? 5 : 60 };
}
