import { beforeEach, describe, expect, it, vi } from 'vitest';
import CryptoUtils from './crypto';
import { getValidSessionKey } from './session';
import { migrateLegacyVault, readVault, writeVault } from './vault';
import { saveBackupSnapshot, createBackupData } from './backup';

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
    local.set('secrets', [secret]); local.set('pendingSecret', secret);
    local.set('backupSnapshots', [
      { data: { secrets: [secret], encrypted: false, count: 1 } },
      { data: { secrets: [secret], encrypted: true, count: 1,
        encryptedData: await CryptoUtils.encrypt(JSON.stringify([secret]), 'backup-password') } }
    ]);
    await migrateLegacyVault('password');
    expect(local.has('secrets')).toBe(false); expect(local.has('pendingSecret')).toBe(false);
    expect(await readVault()).toMatchObject([secret]);
    expect(JSON.stringify(local.get('backupSnapshots'))).not.toContain(secret.secret);
    expect(await CryptoUtils.decrypt(String(local.get('encryptedPendingSecret')), 'password')).toContain(secret.secret);
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
