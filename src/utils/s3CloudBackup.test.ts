import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  send: vi.fn(),
  destroy: vi.fn()
}));

vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      send = sdk.send;
      destroy = sdk.destroy;
    },
    GetObjectCommand: Command,
    HeadObjectCommand: Command,
    PutObjectCommand: Command
  };
});

import type { BackupData } from './backup';
import { unwrapCloudBackup } from './cloudBackup';
import { saveCloudBackupConfiguration } from './cloudBackupSettings';
import CryptoUtils from './crypto';
import {
  getCloudBackupObjectKeys,
  isCloudBackupConflict,
  uploadBackupToS3
} from './s3CloudBackup';

const storage = new Map<string, unknown>();
const settings = {
  enabled: true,
  endpoint: 'https://s3.example.com',
  bucket: 'backups',
  region: 'us-east-1',
  prefix: 'team/openpass',
  forcePathStyle: true
};

beforeEach(async () => {
  storage.clear();
  sdk.send.mockReset();
  sdk.destroy.mockReset();
  vi.stubGlobal('chrome', {
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
  await saveCloudBackupConfiguration(
    settings,
    {
      accessKeyId: 'access',
      secretAccessKey: 'secret',
      cloudPassword: 'cloud-password'
    },
    'master-password'
  );
});

describe('S3 cloud backup transport', () => {
  it('uses immutable random objects and a stable latest object', () => {
    expect(getCloudBackupObjectKeys(settings, 'snapshot-id')).toEqual({
      snapshot: 'team/openpass/v1/objects/snapshot-id.opb',
      latest: 'team/openpass/v1/latest.opb'
    });
  });

  it('uploads history before conditionally updating latest', async () => {
    sdk.send
      .mockResolvedValueOnce({ ETag: 'history-etag' })
      .mockResolvedValueOnce({ ETag: 'remote-etag' })
      .mockResolvedValueOnce({ ETag: 'latest-etag' });
    const backup: BackupData<{ site: string; secret: string }> = {
      format: 'openpass-backup',
      formatVersion: 1,
      appVersion: '0.2.1',
      exportTime: '2026-07-21T00:00:00.000Z',
      count: 1,
      encrypted: false,
      secrets: [{ site: 'example.com', secret: 'TOPSECRET' }]
    };

    await uploadBackupToS3(backup, 'master-password');

    expect(sdk.send).toHaveBeenCalledTimes(3);
    const historyInput = sdk.send.mock.calls[0][0].input as Record<string, unknown>;
    const latestInput = sdk.send.mock.calls[2][0].input as Record<string, unknown>;
    expect(historyInput.IfNoneMatch).toBe('*');
    expect(String(historyInput.Body)).not.toContain('TOPSECRET');
    expect(latestInput.Key).toBe('team/openpass/v1/latest.opb');
    expect(latestInput.IfMatch).toBe('remote-etag');
    expect(storage.get('cloudBackupStatus')).toMatchObject({
      state: 'success',
      latestETag: 'latest-etag'
    });
  });

  it('conditions latest on the ETag observed during pull without a new HEAD', async () => {
    sdk.send
      .mockResolvedValueOnce({ ETag: 'history-etag' })
      .mockResolvedValueOnce({ ETag: 'latest-etag' });
    const backup: BackupData<{ site: string; secret: string }> = {
      format: 'openpass-backup',
      formatVersion: 1,
      appVersion: '0.2.1',
      exportTime: '2026-07-21T00:00:00.000Z',
      count: 1,
      encrypted: false,
      secrets: [{ site: 'example.com', secret: 'TOPSECRET' }]
    };

    await uploadBackupToS3(backup, 'master-password', 'observed-etag');

    expect(sdk.send).toHaveBeenCalledTimes(2);
    const latestInput = sdk.send.mock.calls[1][0].input as Record<string, unknown>;
    expect(latestInput.IfMatch).toBe('observed-etag');
  });

  it('recognizes S3 precondition failures as conflicts', () => {
    expect(isCloudBackupConflict({ $metadata: { httpStatusCode: 412 } })).toBe(true);
    const error = new Error('conflict');
    error.name = 'CloudBackupConflict';
    expect(isCloudBackupConflict(error)).toBe(true);
  });

  it('removes device-local backup encryption before applying the cloud envelope', async () => {
    storage.set('enableBackupEncryption', true);
    storage.set('useMasterPasswordForBackup', true);
    sdk.send
      .mockResolvedValueOnce({ ETag: 'history-etag' })
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 404 } })
      .mockResolvedValueOnce({ ETag: 'latest-etag' });
    const encryptedData = await CryptoUtils.encrypt(
      JSON.stringify([{ id: 'one', site: 'example.com', secret: 'TOPSECRET' }]),
      'master-password'
    );
    const backup: BackupData<{ id: string; site: string; secret: string }> = {
      format: 'openpass-backup',
      formatVersion: 1,
      appVersion: '0.2.1',
      exportTime: '2026-07-21T00:00:00.000Z',
      count: 1,
      encrypted: true,
      encryptedData
    };

    await uploadBackupToS3(backup, 'master-password');
    const historyInput = sdk.send.mock.calls[0][0].input as Record<string, unknown>;
    const cloudBackup = await unwrapCloudBackup(
      JSON.parse(String(historyInput.Body)),
      'cloud-password'
    );
    expect(cloudBackup.encrypted).toBe(false);
    expect(cloudBackup.secrets).toEqual([
      { id: 'one', site: 'example.com', secret: 'TOPSECRET' }
    ]);
  });

  it('keeps the immutable backup and exposes latest conflicts', async () => {
    sdk.send
      .mockResolvedValueOnce({ ETag: 'history-etag' })
      .mockResolvedValueOnce({ ETag: 'remote-etag' })
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } });
    const backup: BackupData<{ site: string; secret: string }> = {
      format: 'openpass-backup',
      formatVersion: 1,
      appVersion: '0.2.1',
      exportTime: '2026-07-21T00:00:00.000Z',
      count: 1,
      encrypted: false,
      secrets: [{ site: 'example.com', secret: 'TOPSECRET' }]
    };

    await expect(uploadBackupToS3(backup, 'master-password')).rejects.toMatchObject({
      name: 'CloudBackupConflict'
    });
    expect(storage.get('cloudBackupStatus')).toMatchObject({
      state: 'conflict',
      message: expect.stringContaining('未覆盖远端最新备份')
    });
  });
});
