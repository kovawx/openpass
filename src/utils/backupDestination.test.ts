import { describe, expect, it } from 'vitest';
import { createBackupFilename, getBackupDirectoryAccessError } from './backupDestination';

describe('backup destination', () => {
  it('requires an explicitly selected and authorized directory', () => {
    expect(getBackupDirectoryAccessError('no-handle')).toContain('选择并授权');
    expect(getBackupDirectoryAccessError('prompt')).toContain('重新授权');
    expect(getBackupDirectoryAccessError('denied')).toContain('重新选择');
    expect(getBackupDirectoryAccessError('granted')).toBeNull();
  });

  it('keeps encrypted backup filenames distinguishable', () => {
    expect(createBackupFilename(false)).toMatch(/^openpass-backup-.+\.json$/);
    expect(createBackupFilename(true)).toMatch(/^openpass-backup-.+-encrypted\.json$/);
  });
});
