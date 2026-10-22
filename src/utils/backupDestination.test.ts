import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBackupFilename,
  getBackupDirectoryAccessError,
  getBackupDirectoryAuthorizationAction,
  getBackupFileSettings,
  normalizeBackupDownloadDirectory,
  writeBackupToDownloads
} from './backupDestination';

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

  it('requires authorization before directory backup can be enabled', () => {
    expect(getBackupDirectoryAuthorizationAction(true, 'granted')).toBe('ready');
    expect(getBackupDirectoryAuthorizationAction(true, 'prompt')).toBe('request-permission');
    expect(getBackupDirectoryAuthorizationAction(true, 'denied')).toBe('select-directory');
    expect(getBackupDirectoryAuthorizationAction(false, 'no-handle')).toBe('select-directory');
  });
});

describe('background download backups', () => {
  const listeners = new Set<(delta: chrome.downloads.DownloadDelta) => void>();
  const download = vi.fn();
  const search = vi.fn();
  const contains = vi.fn();
  beforeEach(() => {
    listeners.clear(); vi.clearAllMocks();
    download.mockResolvedValue(7);
    search.mockResolvedValue([{ id: 7, state: 'complete' }]);
    contains.mockResolvedValue(true);
    vi.stubGlobal('chrome', {
      permissions: { contains }, downloads: { download, search, onChanged: {
        addListener: (listener: (delta: chrome.downloads.DownloadDelta) => void) => listeners.add(listener),
        removeListener: (listener: (delta: chrome.downloads.DownloadDelta) => void) => listeners.delete(listener)
      } }
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('defaults new configurations to downloads while preserving every legacy custom directory', () => {
    expect(getBackupFileSettings({})).toEqual({ backupFileDestination: 'downloads', backupDownloadDirectory: 'OpenPass' });
    expect(getBackupFileSettings({ backupDirectory: 'existing' }).backupFileDestination).toBe('directory');
    expect(getBackupFileSettings({ enableDirectoryBackup: true }).backupFileDestination).toBe('directory');
    expect(getBackupFileSettings({ backupDirectory: 'existing', backupFileDestination: 'downloads' }).backupFileDestination).toBe('downloads');
  });
  it('validates relative subdirectories before requesting a download', async () => {
    expect(normalizeBackupDownloadDirectory(' Work\\OpenPass ')).toBe('Work/OpenPass');
    for (const value of ['', '../private', '/tmp/backup', 'C:\\backup', 'a/../b', 'a//b', 'a/./b']) {
      await expect(writeBackupToDownloads({}, value)).resolves.toMatchObject({ success: false });
    }
    expect(download).not.toHaveBeenCalled();
  });
  it('requires optional download permission once and never redirects to a custom directory', async () => {
    contains.mockResolvedValue(false);
    expect(await writeBackupToDownloads({}, 'OpenPass')).toMatchObject({ success: false, needDownloadPermission: true });
    expect(download).not.toHaveBeenCalled();
  });
  it('saves encrypted data without a file chooser and handles completion before the ID is returned', async () => {
    const data = { encrypted: true, encryptedData: 'fixture-encrypted-data' };
    expect(await writeBackupToDownloads(data, 'Work/OpenPass')).toMatchObject({ success: true });
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ saveAs: false, conflictAction: 'uniquify', filename: expect.stringMatching(/^Work\/OpenPass\//) }));
    expect(JSON.parse(decodeURIComponent(download.mock.calls[0][0].url.split(',')[1]))).toEqual(data);
    expect(listeners.size).toBe(0);
  });
  it('waits for complete, ignores unrelated downloads, and returns interruptions as failures', async () => {
    search.mockResolvedValue([{ id: 7, state: 'in_progress' }]);
    let settled = false;
    const pending = writeBackupToDownloads({}, 'OpenPass').then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(search).toHaveBeenCalled());
    for (const listener of listeners) listener({ id: 8, state: { current: 'complete' } });
    await Promise.resolve(); expect(settled).toBe(false);
    for (const listener of listeners) listener({ id: 7, state: { current: 'interrupted' }, error: { current: 'FILE_NO_SPACE' } });
    expect(await pending).toMatchObject({ success: false, error: expect.stringContaining('FILE_NO_SPACE') });
    expect(listeners.size).toBe(0);
  });
  it('reports the actual downloaded location returned by the browser', async () => {
    search.mockResolvedValue([{ id: 7, state: 'complete', filename: '/actual-downloads/OpenPass/backup.json' }]);
    expect(await writeBackupToDownloads({}, 'OpenPass')).toMatchObject({
      success: true, locationLabel: '/actual-downloads/OpenPass/backup.json'
    });
  });
  it('reports missing completion and releases its event listener on timeout', async () => {
    vi.useFakeTimers(); search.mockResolvedValue([{ id: 7, state: 'in_progress' }]);
    const pending = writeBackupToDownloads({}, 'OpenPass');
    await vi.advanceTimersByTimeAsync(20001);
    expect(await pending).toMatchObject({ success: false, error: expect.stringContaining('尚未完成') });
    expect(listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('never overwrites files from simultaneous backups in the same second', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
    const names = new Set(Array.from({ length: 10 }, () => createBackupFilename(true)));
    expect(names.size).toBe(10);
  });
});
