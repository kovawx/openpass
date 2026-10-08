import { describe, expect, it } from 'vitest';
import { getBackupSchedule } from './backupSchedule';
describe('shared backup scheduling', () => {
  const now = Date.parse('2026-10-08T00:00:00Z');
  it('keeps cloud synchronization running when scheduled local backup is disabled', () => {
    expect(getBackupSchedule({ enableAutoBackup: false, cloudBackupSettings: { enabled: true } }, now))
      .toEqual({ delayInMinutes: 1, periodInMinutes: 5 });
    expect(getBackupSchedule({ enableAutoBackup: false, cloudBackupSettings: { enabled: false } }, now)).toBeNull();
  });
  it('uses one schedule for both destinations without postponing cloud work until a weekly local backup', () => {
    expect(getBackupSchedule({ enableAutoBackup: true, backupFrequency: 'weekly',
      nextBackupTime: '2026-10-15T00:00:00Z', cloudBackupSettings: { enabled: true } }, now))
      .toEqual({ delayInMinutes: 1, periodInMinutes: 5 });
  });
  it('supports five minute local backups and checks overdue or absent timestamps promptly', () => {
    expect(getBackupSchedule({ enableAutoBackup: true, backupFrequency: 'every5min',
      nextBackupTime: '2026-10-08T00:04:00Z' }, now)).toEqual({ delayInMinutes: 4, periodInMinutes: 5 });
    expect(getBackupSchedule({ enableAutoBackup: true, nextBackupTime: 'invalid' }, now)?.delayInMinutes).toBe(1);
  });
});
