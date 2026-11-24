import { beforeEach, describe, expect, it, vi } from 'vitest';
import CryptoUtils from './crypto';
import { getValidSessionKey, publishVaultSession } from './session';
import { appendVaultAccount, migrateLegacyVault, readVault, readDeviceOtpVault, writeVault } from './vault';
import { encryptDailyVault, hasDailyWriteKey, retainDailyWriteKeys } from './deviceVaultWrite';
import { saveBackupSnapshot, createBackupData } from './backup';
import { decodeRestoreBackup } from './restore';

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
function area(values: Map<string, unknown>) {
  return {
    get: async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, values.get(key)])),
    set: async (updates: Record<string, unknown>) => { Object.entries(updates).forEach(([key, value]) => values.set(key, value)); },
    remove: async (keys: string[]) => { keys.forEach((key) => values.delete(key)); }
  };
}
const secret = { id: 'one', site: 'example.com', secret: 'JBSWY3DPEHPK3PXP' };
beforeEach(() => {
  local.clear(); session.clear();
  local.set('sessionExpiresAt', Date.now() + 60000); session.set('sessionKey', 'password');
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '0.2.1' }) }, storage: { local: area(local), session: area(session) } });
});
describe('vault and session boundaries', () => {
  it('initializes daily additions during setup even when no account has been created yet', async () => {
    await migrateLegacyVault('password', true); session.clear();
    expect((await readDeviceOtpVault()).secrets).toEqual([]);
    await appendVaultAccount({ ...secret, site: 'github.com' });
    expect(JSON.parse(await CryptoUtils.decrypt(String(local.get('encryptedSecrets')), 'password'))).toHaveLength(1);
  });
  it('appends while management is locked, preserves every existing record and keeps master-password backups portable', async () => {
    const existing = { ...secret, group: '工作', favorite: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' };
    await writeVault([existing], 'password');
    const before = (await readVault())[0];
    session.clear(); local.delete('sessionExpiresAt');
    const added = await appendVaultAccount({ ...secret, id: 'one', site: 'github.com', name: 'GitHub', group: '个人', favorite: true });
    expect(added[0]).toEqual(before);
    expect(added[1]).toMatchObject({ site: 'github.com', name: 'GitHub', group: '个人', favorite: false });
    expect(added[1].id).not.toBe('one');
    await expect(readVault()).rejects.toThrow('锁定');
    const ciphertext = String(local.get('encryptedSecrets'));
    expect(JSON.parse(await CryptoUtils.decrypt(ciphertext, 'password'))).toEqual(added);
    await expect(CryptoUtils.decrypt(ciphertext, 'wrong-password')).rejects.toThrow();
    expect((await readDeviceOtpVault()).secrets).toEqual(added);
    expect(JSON.stringify(Object.fromEntries(local))).not.toContain(secret.secret);
    expect(session.has('sessionKey')).toBe(false);
  });
  it('updates an independent-password encrypted backup together with a locked append', async () => {
    local.set('enableBackupEncryption', true); local.set('useMasterPasswordForBackup', false);
    local.set('encryptedBackupPassword', await CryptoUtils.encrypt('backup-password', 'password'));
    await writeVault([secret], 'password'); session.clear();
    await appendVaultAccount({ ...secret, site: 'github.com' });
    const primary = JSON.parse(await CryptoUtils.decrypt(String(local.get('encryptedSecrets')), 'password'));
    const portable = JSON.parse(await CryptoUtils.decrypt(String(local.get('encryptedSecretsForBackup')), 'backup-password'));
    expect(primary).toEqual(portable); expect(primary).toHaveLength(2);
    await expect(CryptoUtils.decrypt(String(local.get('encryptedSecretsForBackup')), 'password')).rejects.toThrow();
  });
  it('requires one initialization for old data, then preserves daily append across management expiry', async () => {
    local.set('encryptedSecrets', await CryptoUtils.encrypt(JSON.stringify([secret]), 'password'));
    await migrateLegacyVault('password'); session.clear();
    expect(await hasDailyWriteKey(String(local.get('encryptedSecrets')))).toBe(true);
    await appendVaultAccount({ ...secret, site: 'github.com' });
    await retainDailyWriteKeys([]);
    const before = new Map(local);
    await expect(appendVaultAccount({ ...secret, site: 'another.example' })).rejects.toThrow('初始化免密添加');
    expect(local).toEqual(before);
  });
  it('keeps the current ciphertext on repeated unlock and repairs a missing daily write key', async () => {
    local.set('enableBackupEncryption', true); local.set('useMasterPasswordForBackup', false);
    local.set('encryptedBackupPassword', await CryptoUtils.encrypt('backup-password', 'password'));
    await writeVault([secret], 'password');
    session.clear();
    await migrateLegacyVault('password');
    const before = new Map(local);
    await migrateLegacyVault('password');
    expect(local).toEqual(before);
    await retainDailyWriteKeys([String(local.get('encryptedSecrets'))]);
    await migrateLegacyVault('password');
    expect(await hasDailyWriteKey(String(local.get('encryptedSecretsForBackup')))).toBe(true);
    expect((await readDeviceOtpVault()).secrets).toMatchObject([secret]);
  });
  it('fails closed when daily access is disabled or its primary revision changes', async () => {
    await writeVault([secret], 'password', { deviceOtpEnabled: false }); session.clear();
    await expect(appendVaultAccount({ ...secret, site: 'github.com' })).rejects.toThrow('免密已关闭');
    session.set('sessionKey', 'password'); local.set('sessionExpiresAt', Date.now() + 60000);
    await writeVault([secret], 'password', { deviceOtpEnabled: true }); session.clear();
    local.delete('sessionExpiresAt');
    local.set('encryptedSecrets', await CryptoUtils.encrypt(JSON.stringify([]), 'password'));
    const before = new Map(local);
    await expect(appendVaultAccount({ ...secret, site: 'github.com' })).rejects.toThrow('初始化');
    expect(local).toEqual(before);
  });
  it('retains HOTP high-water marks when adding an unrelated account without management access', async () => {
    await writeVault([{ ...secret, type: 'hotp', counter: 50 }], 'password');
    const expected = (await readDeviceOtpVault()).secrets[0]; session.clear();
    await appendVaultAccount({ secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', site: 'github.com' });
    const records = JSON.parse(await CryptoUtils.decrypt(String(local.get('encryptedSecrets')), 'password'));
    expect(records[0]).toEqual(expected);
    expect(records[0].counter).toBe(50);
  });
  it('does not reset a deleted HOTP account counter when it is added again through daily access', async () => {
    await writeVault([{ ...secret, type: 'hotp', counter: 50 }], 'password');
    await writeVault([], 'password'); session.clear();
    await appendVaultAccount({ ...secret, type: 'hotp', counter: 1 });
    const records = JSON.parse(await CryptoUtils.decrypt(String(local.get('encryptedSecrets')), 'password'));
    expect(records[0].counter).toBe(50);
    expect(Object.values(local.get('hotpCounters') as Record<string, number>)).toEqual([50]);
  });
  it('uses persisted encryption-only keys with fresh IVs and never retains decrypt/export capability', async () => {
    await writeVault([secret], 'password');
    const ciphertext = String(local.get('encryptedSecrets'));
    const first = await encryptDailyVault('first', ciphertext);
    const second = await encryptDailyVault('second', ciphertext);
    expect(first).not.toBe(second);
    expect(await CryptoUtils.decrypt(first, 'password')).toBe('first');
    expect(await CryptoUtils.decrypt(second, 'password')).toBe('second');
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('OpenPassDailyWriteDB', 1); request.onsuccess = () => resolve(request.result); });
    const keys = await new Promise<CryptoKey[]>(resolve => { const request = db.transaction('keys').objectStore('keys').getAll(); request.onsuccess = () => resolve(request.result); });
    db.close();
    for (const key of keys) {
      expect(key.extractable).toBe(false); expect(key.usages).toEqual(['encrypt']);
      await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
      await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, new Uint8Array(16))).rejects.toThrow();
    }
  });
  it('preserves the committed vault when persisting a new daily capability fails', async () => {
    await writeVault([secret], 'password');
    const before = new Map(local);
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('fixture quota', 'QuotaExceededError'); });
    try {
      await expect(writeVault([], 'password')).rejects.toThrow('fixture quota');
      expect(local).toEqual(before);
    } finally { put.mockRestore(); }
  });
  it('preserves organization through encryption, everyday access and plain/encrypted backups', async () => {
    const organized = { ...secret, group: '工作', favorite: true };
    await writeVault([organized], 'password');
    expect(await readVault()).toMatchObject([organized]);
    expect((await readDeviceOtpVault()).secrets).toMatchObject([organized]);
    expect(JSON.stringify(Object.fromEntries(local))).not.toContain('工作');
    for (const password of [undefined, 'backup-password']) {
      const backup = await createBackupData(await readVault(), password);
      expect(backup.formatVersion).toBe(1);
      expect(await decodeRestoreBackup(backup, password ? [password] : [])).toMatchObject([organized]);
    }
    expect(await decodeRestoreBackup([secret], [])).toMatchObject([{ ...secret, group: '', favorite: false }]);
  });
  it('rejects expired and orphan sessions and removes pending plaintext', async () => {
    local.set('sessionExpiresAt', Date.now() - 1); session.set('pendingSecret', secret);
    expect(await getValidSessionKey()).toBeNull();
    expect(session.has('sessionKey')).toBe(false); expect(session.has('pendingSecret')).toBe(false);
    await expect(readVault()).rejects.toThrow('锁定');
    session.set('sessionKey', 'password');
    expect(await getValidSessionKey()).toBeNull();
  });
  it('writes ciphertext only and refuses a changed session key', async () => {
    local.set('secrets', [secret]);
    await writeVault([secret], 'password');
    expect(local.has('secrets')).toBe(false);
    expect(String(local.get('encryptedSecrets'))).not.toContain(secret.secret);
    expect(await readVault()).toMatchObject([secret]);
    session.set('sessionKey', 'changed');
    await expect(writeVault([], 'password')).rejects.toThrow('变更');
  });
  it('migrates legacy vault, pending import and snapshots without plaintext copies', async () => {
    const salt = new Uint8Array(16);
    local.set('masterPasswordSalt', CryptoUtils.arrayBufferToBase64(salt.buffer));
    local.set('masterPasswordHash', await CryptoUtils.hashPassword('password', salt));
    local.set('secrets', [secret]); local.set('pendingSecret', secret);
    local.set('backupSnapshots', [
      { data: { secrets: [secret], encrypted: false, count: 1 } },
      { data: { secrets: [secret], encrypted: true, count: 1,
        encryptedData: await CryptoUtils.encrypt(JSON.stringify([secret]), 'backup-password') } }
    ]);
    await publishVaultSession('password', await migrateLegacyVault('password'));
    expect(local.has('secrets')).toBe(false); expect(local.has('pendingSecret')).toBe(false);
    expect(await readVault()).toMatchObject([secret]);
    expect(JSON.stringify(local.get('backupSnapshots'))).not.toContain(secret.secret);
    expect(await CryptoUtils.decrypt(String(local.get('encryptedPendingSecret')), 'password')).toContain(secret.secret);
    const snapshots = local.get('backupSnapshots') as Array<{ data: { encryptedData: string; encryptionVersion?: number } }>;
    expect(snapshots[0].data.encryptionVersion).toBe(2);
    session.clear();
    expect(await decodeRestoreBackup({ ...snapshots[0].data, format: 'openpass-backup', formatVersion: 1, appVersion: '0.2.1' }, ['password'])).toMatchObject([secret]);
    expect(await decodeRestoreBackup({ ...snapshots[1].data, format: 'openpass-backup', formatVersion: 1, appVersion: '0.2.1' }, ['backup-password'])).toMatchObject([secret]);
  });
  it('preserves all old data when migration cannot decrypt existing ciphertext', async () => {
    local.set('encryptedSecrets', await CryptoUtils.encrypt(JSON.stringify([secret]), 'another-password'));
    local.set('pendingSecret', secret);
    const before = new Map(local);
    await expect(migrateLegacyVault('password')).rejects.toThrow();
    expect(local).toEqual(before);
  });
  it('encrypts snapshots even when exported files are configured plaintext', async () => {
    const backup = await createBackupData([secret]);
    expect(backup.encrypted).toBe(false);
    const snapshots = await saveBackupSnapshot(backup);
    expect(snapshots[0].data.encrypted).toBe(true);
    expect(snapshots[0].data.secrets).toBeUndefined();
    expect(JSON.parse(await CryptoUtils.decrypt(snapshots[0].data.encryptedData!, 'password'))).toEqual([secret]);
  });
  it('retains HOTP high water marks after deletion and restoration', async () => {
    await writeVault([{ ...secret, type: 'hotp', counter: 50 }], 'password');
    await writeVault([], 'password');
    await writeVault([{ ...secret, type: 'hotp', counter: 1 }], 'password');
    expect((await readVault())[0].counter).toBe(50);
    expect(JSON.stringify(local.get('hotpCounters'))).not.toContain(secret.secret);
  });
  it('uses PBKDF2 verification while accepting an existing SHA256 verifier', async () => {
    const verifier = await CryptoUtils.createMasterPasswordHash('password');
    expect(verifier.hash).toMatch(/^pbkdf2-sha256\$600000\$/);
    expect(await CryptoUtils.verifyMasterPassword('password', verifier.hash, verifier.salt)).toBe(true);
    expect(await CryptoUtils.verifyMasterPassword('wrong', verifier.hash, verifier.salt)).toBe(false);
    const legacy = await CryptoUtils.hashPassword('password', new Uint8Array(CryptoUtils.base64ToArrayBuffer(verifier.salt)));
    expect(await CryptoUtils.verifyMasterPassword('password', legacy, verifier.salt)).toBe(true);
  });
});
