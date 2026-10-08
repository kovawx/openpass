import { beforeEach, describe, expect, it, vi } from 'vitest';
import CryptoUtils from './crypto';
import { normalizeVaultSecrets, readVault, writeVault } from './vault';
import type { VaultSecret } from './vault';
import { mergeSyncState } from './syncMerge';

const transport = vi.hoisted(() => ({ download: vi.fn(), upload: vi.fn(), retention: vi.fn(), versions: vi.fn(), deleteVersions: vi.fn() }));
vi.mock('./s3CloudBackup', () => ({
  downloadLatestBackupStateFromS3: transport.download,
  uploadBackupToS3: transport.upload,
  applyCloudBackupRetention: transport.retention,
  isCloudBackupConflict: (error: Error) => error.name === 'CloudBackupConflict',
  downloadLatestBackupFromS3: vi.fn(), downloadCloudBackupVersion: vi.fn(),
  listCloudBackupVersions: transport.versions, deleteCloudBackupVersions: transport.deleteVersions, testS3CloudBackupConnection: vi.fn()
}));
const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
function area(values: Map<string, unknown>) {
  return {
    get: async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, values.get(key)])),
    set: async (updates: Record<string, unknown>) => { Object.entries(updates).forEach(([key, value]) => values.set(key, value)); },
    remove: async (keys: string[]) => { keys.forEach((key) => values.delete(key)); },
    clear: async () => { values.clear(); },
    setAccessLevel: vi.fn().mockResolvedValue(undefined)
  };
}
interface TestResponse { error?: string; success?: boolean; count?: number; code?: string; locked?: boolean; otpAvailable?: boolean; message?: string; token?: string; secrets?: Array<Record<string, unknown>> }
let listener: (message: Record<string, unknown>, sender: chrome.runtime.MessageSender, respond: (result: TestResponse) => void) => unknown;
const trusted = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
const page = { id: 'test-extension', url: 'https://example.com/login' };
const secret: VaultSecret = { id: 'one', site: 'example.com', secret: 'JBSWY3DPEHPK3PXP', type: 'hotp', counter: 0 };
function message(value: Record<string, unknown>, sender: chrome.runtime.MessageSender = trusted): Promise<TestResponse> {
  return new Promise((resolve) => listener(value, sender, resolve));
}
async function putSecrets(value: VaultSecret[]) {
  local.set('encryptedSecrets', await CryptoUtils.encrypt(JSON.stringify(normalizeVaultSecrets(value)), 'password'));
}
function backup(value: VaultSecret[]) {
  return { format: 'openpass-backup', formatVersion: 1, appVersion: '0.2.1', exportTime: '2026-10-07T00:00:00Z',
    count: value.length, encrypted: false, secrets: value };
}
beforeEach(async () => {
  vi.resetModules(); local.clear(); session.clear();
  transport.download.mockReset(); transport.upload.mockReset(); transport.retention.mockReset();
  transport.versions.mockReset(); transport.deleteVersions.mockReset();
  local.set('sessionExpiresAt', Date.now() + 60000); session.set('sessionKey', 'password');
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal('self', { addEventListener: vi.fn() });
  vi.stubGlobal('defineBackground', (callback: () => void) => callback);
  vi.stubGlobal('chrome', {
    runtime: { id: 'test-extension', getURL: (value: string) => `chrome-extension://test-extension/${value}`,
      getManifest: () => ({ version: '0.2.1' }), onInstalled: event(), onStartup: event(), onMessage: { addListener: (value: typeof listener) => { listener = value; } } },
    storage: { local: area(local), session: area(session), onChanged: event() },
    contextMenus: { onClicked: event() },
    tabs: { query: vi.fn().mockResolvedValue([]), onUpdated: event(), onActivated: event() },
    alarms: { clear: vi.fn().mockResolvedValue(true), create: vi.fn().mockResolvedValue(undefined), onAlarm: event() }
  });
  const background = await import('../entrypoints/background');
  (background.default as unknown as () => void)();
  await putSecrets([secret]);
});
describe('background authorization and writes', () => {
  it('uses the shared alarm for cloud-only work and preserves it when local scheduling is disabled', async () => {
    local.set('enableAutoBackup', false); local.set('cloudBackupSettings', { enabled: true });
    expect(await message({ action: 'updateBackupSchedule' })).toMatchObject({ success: true });
    expect(chrome.alarms.create).toHaveBeenLastCalledWith('openpass-auto-backup', { delayInMinutes: 1, periodInMinutes: 5 });
    expect(chrome.alarms.clear).toHaveBeenCalledWith('openpass-cloud-backup-pull');
    local.set('cloudBackupSettings', { enabled: false });
    const creations = vi.mocked(chrome.alarms.create).mock.calls.length;
    await message({ action: 'updateBackupSchedule' });
    expect(vi.mocked(chrome.alarms.create).mock.calls.length).toBe(creations);
  });
  it('clears only the local vault, disables sync and never downloads or deletes cloud backups', async () => {
    local.set('cloudBackupSettings', { enabled: true, bucket: 'fixture' });
    local.set('backupSnapshots', [{ data: backup([secret]) }]);
    const preview = await message({ action: 'prepareVaultClear', scope: 'local' });
    expect(await message({ action: 'clearVault', token: preview.token, confirmation: 'DELETE' })).toMatchObject({ success: true, scope: 'local' });
    expect(await readVault()).toEqual([]);
    expect(local.get('cloudBackupSettings')).toMatchObject({ enabled: false, bucket: 'fixture' });
    expect(local.has('backupSnapshots')).toBe(false);
    expect(local.get('secretTombstones')).toEqual([]);
    expect(transport.download).not.toHaveBeenCalled(); expect(transport.deleteVersions).not.toHaveBeenCalled(); expect(transport.upload).not.toHaveBeenCalled();
  });
  it('rejects missing confirmation, stale data and untrusted clear requests without modifying the vault', async () => {
    const preview = await message({ action: 'prepareVaultClear', scope: 'local' });
    expect((await message({ action: 'clearVault', token: preview.token, confirmation: '' })).error).toContain('确认');
    await putSecrets([{ ...secret, name: 'changed' }]);
    expect((await message({ action: 'clearVault', token: preview.token, confirmation: 'DELETE' })).error).toContain('已变更');
    expect((await message({ action: 'prepareVaultClear', scope: 'local' }, page)).error).toContain('扩展页面');
    expect((await readVault())[0].name).toBe('changed');
  });
  it('binds an individual history deletion to the reviewed configuration and refuses current versions', async () => {
    transport.versions.mockResolvedValue([{ key: 'history-old', current: false }, { key: 'history-current', current: true }]);
    expect((await message({ action: 'prepareCloudVersionDelete', key: 'history-current' })).error).toContain('受保护');
    const preview = await message({ action: 'prepareCloudVersionDelete', key: 'history-old' });
    local.set('cloudBackupSettings', { enabled: true, bucket: 'changed' });
    expect((await message({ action: 'deleteCloudBackupVersion', token: preview.token, confirmation: 'DELETE' })).error).toContain('配置已变更');
    expect(transport.deleteVersions).not.toHaveBeenCalled();
    session.clear();
    expect((await message({ action: 'prepareCloudVersionDelete', key: 'history-old' })).error).toContain('锁定');
  });
  it('does not report a manual synchronization as successful when locked or disabled', async () => {
    expect(await message({ action: 'syncLatestCloudBackup' })).toMatchObject({ error: '云端同步未启用' });
    local.set('cloudBackupSettings', { enabled: true });
    session.clear();
    expect(await message({ action: 'syncLatestCloudBackup' })).toMatchObject({ error: '请先解锁 OpenPass' });
    expect(transport.upload).not.toHaveBeenCalled();
    expect(transport.download).not.toHaveBeenCalled();
  });
  it('sends only matching metadata to content scripts and refuses another site', async () => {
    const result = await message({ action: 'getSecrets' }, page);
    expect(result.secrets![0].id).toBe('one'); expect(result.secrets![0].secret).toBeUndefined();
    expect((await message({ action: 'generateCode', id: 'one' }, { ...page, url: 'https://other.org/' })).error).toContain('不匹配');
    expect((await message({ action: 'saveVault', secrets: [] }, page)).error).toContain('扩展页面');
  });
  it('rejects locked preview and fill, including an expired session', async () => {
    local.set('deviceOtpEnabled', false);
    local.set('sessionExpiresAt', Date.now() - 1);
    expect(await message({ action: 'getSecrets' }, page)).toMatchObject({ secrets: [], locked: true, otpAvailable: false });
    expect((await message({ action: 'consumeCode', id: 'one' }, page)).error).toContain('请先解锁');
    expect(session.has('sessionKey')).toBe(false);
  });
  it('matches, previews and consumes after restart while management remains locked', async () => {
    await writeVault([secret], 'password');
    session.clear(); local.delete('sessionExpiresAt');
    const accounts = await message({ action: 'getSecrets' }, page);
    expect(accounts).toMatchObject({ locked: true, otpAvailable: true, secrets: [{ id: 'one', site: 'example.com' }] });
    expect(accounts.secrets![0].secret).toBeUndefined();
    expect(JSON.stringify(Object.fromEntries(local))).not.toContain('password');
    expect((await message({ action: 'getSecrets' })).secrets![0].secret).toBeUndefined();
    const preview = await message({ action: 'generateCode', id: 'one' }, page);
    expect(preview.code).toMatch(/^\d{6}$/);
    const [first, second] = await Promise.all([
      message({ action: 'consumeCode', id: 'one' }, page), message({ action: 'consumeCode', id: 'one' }, page)
    ]);
    expect(first.code).toBe(preview.code); expect(second.code).not.toBe(first.code);
    expect((await message({ action: 'saveVault', secrets: [] })).error).toContain('锁定');
    expect((await message({ action: 'restoreVault', backupData: backup([]), mode: 'replace' })).error).toContain('锁定');
    expect((await message({ action: 'setDeviceOtpEnabled', enabled: false })).error).toContain('锁定');
    expect((await message({ action: 'generateCode', secret: secret.secret })).error).toContain('解锁');
    expect((await message({ action: 'consumeCode', id: 'one' }, { ...page, url: 'https://other.org/' })).error).toContain('不匹配');
    session.set('sessionKey', 'password'); local.set('sessionExpiresAt', Date.now() + 60000);
    expect((await readVault())[0].counter).toBe(2);
    await writeVault([{ ...secret, counter: 0 }], 'password');
    session.clear();
    expect((await message({ action: 'generateCode', id: 'one' }, page)).code).not.toBe(preview.code);
  });
  it('disables device access immediately and rebuilds it only from an unlocked management session', async () => {
    await writeVault([secret], 'password');
    expect((await message({ action: 'setDeviceOtpEnabled', enabled: false })).success).toBe(true);
    expect(local.get('deviceOtpKey')).toBeNull(); expect(local.get('encryptedDeviceOtpSecrets')).toBeNull();
    session.clear();
    expect((await message({ action: 'consumeCode', id: 'one' }, page)).error).toContain('免密已关闭');
    session.set('sessionKey', 'password'); local.set('sessionExpiresAt', Date.now() + 60000);
    expect((await message({ action: 'setDeviceOtpEnabled', enabled: true })).success).toBe(true);
    session.clear();
    expect((await message({ action: 'generateCode', id: 'one' }, page)).code).toMatch(/^\d{6}$/);
  });
  it('refuses a stale device copy and explains the one-time initialization for old data', async () => {
    session.clear();
    expect((await message({ action: 'getSecrets' }, page)).message).toContain('初始化');
    session.set('sessionKey', 'password'); local.set('sessionExpiresAt', Date.now() + 60000);
    await writeVault([secret], 'password');
    await putSecrets([{ ...secret, site: 'other.org' }]);
    session.clear();
    expect((await message({ action: 'consumeCode', id: 'one' }, page)).error).toContain('初始化');
  });
  it('serializes management unlock migration with password-free HOTP consumption', async () => {
    const verifier = await CryptoUtils.createMasterPasswordHash('password');
    local.set('masterPasswordHash', verifier.hash); local.set('masterPasswordSalt', verifier.salt);
    await writeVault([secret], 'password');
    session.clear();
    expect((await message({ action: 'migrateVaultForUnlock', password: 'wrong' })).error).toContain('主密码错误');
    expect((await message({ action: 'migrateVaultForUnlock', password: 'password' }, page)).error).toContain('扩展页面');
    const [consumed, migrated] = await Promise.all([
      message({ action: 'consumeCode', id: 'one' }, page),
      message({ action: 'migrateVaultForUnlock', password: 'password' })
    ]);
    expect(consumed.code).toMatch(/^\d{6}$/); expect(migrated.success).toBe(true);
    session.set('sessionKey', 'password'); local.set('sessionExpiresAt', Date.now() + 60000);
    expect((await readVault())[0].counter).toBe(1);
  });
  it('serializes concurrent HOTP consumption while previews never advance counters', async () => {
    const preview = await message({ action: 'generateCode', id: 'one' }, page);
    expect((await readVault())[0].counter).toBe(0);
    const [first, second] = await Promise.all([message({ action: 'consumeCode', id: 'one' }, page), message({ action: 'consumeCode', id: 'one' }, page)]);
    expect(first.code).toBe(preview.code); expect(first.code).not.toBe(second.code);
    expect((await readVault())[0].counter).toBe(2);
  });
  it('rejects stale edits and atomically records deletion with the saved vault', async () => {
    expect((await message({ action: 'saveVault', secrets: [], expectedSecrets: '[]' })).error).toContain('更新');
    const result = await message({ action: 'saveVault', secrets: [], expectedSecrets: JSON.stringify(await readVault()) });
    expect(result.success).toBe(true); expect(await readVault()).toEqual([]);
    expect(local.get('secretTombstones')).toMatchObject([{ id: 'one' }]);
  });
  it('keeps edits and deletions newer than records received from a device with a fast clock', async () => {
    const future = { ...secret, updatedAt: '2030-01-01T00:00:00Z' };
    await putSecrets([future]);
    const current = await readVault();
    expect((await message({ action: 'saveVault', secrets: [{ ...current[0], name: 'edited' }], expectedSecrets: JSON.stringify(current) })).success).toBe(true);
    const edited = await readVault();
    expect(mergeSyncState(edited, [], [future], []).secrets[0].name).toBe('edited');
    await message({ action: 'saveVault', secrets: [], expectedSecrets: JSON.stringify(edited) });
    expect(mergeSyncState([], local.get('secretTombstones') as Parameters<typeof mergeSyncState>[1], [future], []).secrets).toEqual([]);
  });
  it('restores an empty version after preserving the previous encrypted snapshot', async () => {
    expect(await message({ action: 'restoreVault', backupData: backup([]), mode: 'replace' })).toMatchObject({ success: true, count: 0 });
    const snapshots = local.get('backupSnapshots') as Array<{ data: { encryptedData: string } }>;
    expect(JSON.parse(await CryptoUtils.decrypt(snapshots[1].data.encryptedData, 'password'))).toMatchObject([secret]);
  });
  it('changes password without losing the vault, credentials or master-encrypted snapshots', async () => {
    const verifier = await CryptoUtils.createMasterPasswordHash('password');
    local.set('masterPasswordHash', verifier.hash); local.set('masterPasswordSalt', verifier.salt);
    const cloudCredentials = { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret',
      cloudPassword: 'password', cloudPasswordMode: 'master' };
    local.set('encryptedCloudBackupSecrets', await CryptoUtils.encrypt(JSON.stringify(cloudCredentials), 'password'));
    local.set('backupSnapshots', [{ data: { ...backup([secret]), encrypted: true,
      secrets: undefined, encryptedData: await CryptoUtils.encrypt(JSON.stringify([secret]), 'password') } }]);
    expect((await message({ action: 'changeMasterPassword', currentPassword: 'wrong', password: 'new-password' })).error).toContain('密码');
    expect(session.get('sessionKey')).toBe('password');
    expect(await message({ action: 'changeMasterPassword', currentPassword: 'password', password: 'new-password' })).toMatchObject({ success: true });
    expect(await readVault()).toMatchObject([secret]);
    session.clear();
    expect((await message({ action: 'generateCode', id: 'one' }, page)).code).toMatch(/^\d{6}$/);
    expect(JSON.parse(await CryptoUtils.decrypt(String(local.get('encryptedCloudBackupSecrets')), 'new-password'))).toEqual(cloudCredentials);
    const snapshots = local.get('backupSnapshots') as Array<{ data: { encryptedData: string } }>;
    expect(JSON.parse(await CryptoUtils.decrypt(snapshots[0].data.encryptedData, 'new-password'))).toMatchObject([secret]);
  });
});
describe('conditional cloud synchronization', () => {
  beforeEach(() => { local.set('cloudBackupSettings', { enabled: true }); });
  it('preserves local data and history on a concurrent cloud clear, then reports partial deletion accurately', async () => {
    transport.download.mockResolvedValue({ etag: 'review-etag', backupData: backup([{ ...secret, id: 'remote' }]) });
    transport.versions.mockResolvedValue([{ key: 'history-one' }, { key: 'history-two' }]);
    let preview = await message({ action: 'prepareVaultClear', scope: 'cloud' });
    transport.upload.mockRejectedValue(Object.assign(new Error('concurrent update'), { name: 'CloudBackupConflict' }));
    expect((await message({ action: 'clearVault', token: preview.token, confirmation: 'DELETE CLOUD' })).error).toBe('concurrent update');
    expect((await readVault()).map(entry => entry.id)).toEqual(['one']);
    expect(transport.deleteVersions).not.toHaveBeenCalled();
    preview = await message({ action: 'prepareVaultClear', scope: 'cloud' });
    transport.upload.mockResolvedValue({ etag: 'empty-etag', snapshotKey: 'new-empty' });
    transport.deleteVersions.mockResolvedValue({ deleted: 1, failed: [{ key: 'history-two', error: 'access denied' }] });
    expect(await message({ action: 'clearVault', token: preview.token, confirmation: 'DELETE CLOUD' })).toMatchObject({ success: true, warning: expect.stringContaining('access denied') });
    expect(transport.upload.mock.calls.at(-1)![2]).toBe('review-etag');
    expect(transport.upload.mock.calls.at(-1)![0].sync.tombstones.map((entry: { id: string }) => entry.id).sort()).toEqual(['one', 'remote']);
    expect(await readVault()).toEqual([]);
    expect(transport.deleteVersions.mock.calls[0][0]).toEqual(['history-one', 'history-two']);
    expect(local.get('backupSnapshots')).toMatchObject([{ count: 0 }]);
    transport.download.mockResolvedValue({ etag: 'empty-etag', backupData: backup([]) });
    await message({ action: 'sessionChanged' });
    expect(await message({ action: 'syncLatestCloudBackup' })).toMatchObject({ success: true });
  });
  it('reports success when manual synchronization joins an automatic task that is already current', async () => {
    const timestamp = '2026-10-07T00:00:00Z';
    local.set('backupSnapshots', [{ timestamp, data: backup([secret]) }]);
    local.set('cloudBackupLastLocalTimestamp', timestamp);
    local.set('cloudBackupLastPulledETag', 'current-etag');
    let finishDownload!: (value: unknown) => void;
    transport.download.mockImplementation(() => new Promise((resolve) => { finishDownload = resolve; }));
    await message({ action: 'sessionChanged' });
    await vi.waitFor(() => expect(transport.download).toHaveBeenCalledOnce());
    const manual = message({ action: 'syncLatestCloudBackup' });
    finishDownload({ etag: 'current-etag', backupData: backup([secret]) });
    expect(await manual).toMatchObject({ success: true });
    expect(transport.download).toHaveBeenCalledOnce();
    expect(transport.upload).not.toHaveBeenCalled();
  });
  it('keeps the original local vault on 412 and pauses automatic retries', async () => {
    transport.download.mockResolvedValue({ etag: 'remote-etag', backupData: backup([{ ...secret, id: 'remote', site: 'other.com' }]) });
    transport.upload.mockImplementation(async () => {
      local.set('cloudBackupStatus', { state: 'conflict' });
      throw Object.assign(new Error('conflict'), { name: 'CloudBackupConflict' });
    });
    expect((await message({ action: 'syncLatestCloudBackup' })).error).toBe('conflict');
    expect((await readVault()).map((entry) => entry.id)).toEqual(['one']);
    await message({ action: 'syncLatestCloudBackup' });
    expect(transport.download).toHaveBeenCalledTimes(1);
  });
  it('rejects a comparison after local changes and resolves with its observed ETag', async () => {
    local.set('cloudBackupStatus', { state: 'conflict' });
    transport.download.mockResolvedValue({ etag: 'review-etag', backupData: backup([{ ...secret, id: 'remote', site: 'other.com' }]) });
    const stale = await message({ action: 'compareCloudConflict' });
    await putSecrets([{ ...secret, name: 'changed' }]);
    expect((await message({ action: 'resolveCloudConflict', token: stale.token, choice: 'remote' })).error).toContain('本地数据已变更');
    expect(transport.upload).not.toHaveBeenCalled();
    const fresh = await message({ action: 'compareCloudConflict' });
    expect(JSON.stringify(fresh)).not.toContain(secret.secret);
    transport.upload.mockResolvedValue({ etag: 'new-etag', snapshotKey: 'new-key' });
    expect(await message({ action: 'resolveCloudConflict', token: fresh.token, choice: 'remote' })).toMatchObject({ success: true });
    expect(transport.upload.mock.calls[0][2]).toBe('review-etag');
    expect((await readVault()).map((entry) => entry.id)).toEqual(['remote']);
  });
  it('rejects changed configuration and another 412 without changing local records', async () => {
    local.set('cloudBackupStatus', { state: 'conflict' });
    transport.download.mockResolvedValue({ etag: 'review-etag', backupData: backup([]) });
    const first = await message({ action: 'compareCloudConflict' });
    local.set('encryptedCloudBackupSecrets', 'changed-credentials');
    expect((await message({ action: 'resolveCloudConflict', token: first.token, choice: 'remote' })).error).toContain('配置已变更');
    expect(transport.upload).not.toHaveBeenCalled();
    const second = await message({ action: 'compareCloudConflict' });
    transport.upload.mockRejectedValue(Object.assign(new Error('another conflict'), { name: 'CloudBackupConflict' }));
    expect((await message({ action: 'resolveCloudConflict', token: second.token, choice: 'remote' })).error).toBe('another conflict');
    expect((await readVault()).map((entry) => entry.id)).toEqual(['one']);
  });
  it('keeps the vault and schedules retry after an upload network failure', async () => {
    transport.download.mockResolvedValue({ etag: 'etag', backupData: backup([]) });
    transport.upload.mockRejectedValue(new Error('network unavailable'));
    expect((await message({ action: 'syncLatestCloudBackup' })).error).toBe('network unavailable');
    expect((await readVault()).map((entry) => entry.id)).toEqual(['one']);
    expect(chrome.alarms.create).toHaveBeenCalledWith('openpass-cloud-backup-retry', { delayInMinutes: 5 });
  });
});
