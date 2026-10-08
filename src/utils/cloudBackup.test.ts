import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createBackupData, decryptBackupData } from './backup';
import { unwrapCloudBackup, wrapBackupForCloud } from './cloudBackup';

const secrets = [{ site: 'example.com', secret: 'TOPSECRET' }];

beforeAll(() => {
  const storage = new Map<string, unknown>();
  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: () => ({ version: '0.2.1' })
    },
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(
          keys.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)])
        ),
        set: async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        }
      }
    }
  });
});

describe('cloud backup envelope', () => {
  it('wraps the existing backup format without leaking its content or metadata', async () => {
    const backup = await createBackupData(secrets);
    const envelope = await wrapBackupForCloud(backup, 'cloud password');
    const serialized = JSON.stringify(envelope);

    expect(serialized).not.toContain('example.com');
    expect(serialized).not.toContain('TOPSECRET');
    expect(serialized).not.toContain('exportTime');
    expect(serialized).not.toContain('count');
    await expect(unwrapCloudBackup(envelope, 'cloud password')).resolves.toEqual(backup);
  });

  it('preserves the existing encrypted backup restore path', async () => {
    const backup = await createBackupData(secrets, 'backup password');
    const envelope = await wrapBackupForCloud(backup, 'cloud password');
    const restoredBackup = await unwrapCloudBackup(envelope, 'cloud password');

    await expect(decryptBackupData(restoredBackup, 'backup password')).resolves.toEqual(secrets);
  });

  it('rejects an incorrect cloud password without returning partial data', async () => {
    const envelope = await wrapBackupForCloud(
      await createBackupData(secrets),
      'correct password'
    );

    await expect(unwrapCloudBackup(envelope, 'wrong password')).rejects.toThrow(
      '云端备份密码错误或密文已损坏'
    );
  });
});
