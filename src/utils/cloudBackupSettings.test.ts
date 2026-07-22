import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CLOUD_BACKUP_SETTINGS,
  getCloudEndpointOriginPattern,
  loadCloudBackupSecrets,
  normalizeCloudPrefix,
  saveCloudBackupConfiguration
} from './cloudBackupSettings';

const storage = new Map<string, unknown>();

beforeEach(() => {
  storage.clear();
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
});

describe('cloud backup settings', () => {
  it('keeps cloud synchronization opt-in by default', () => {
    expect(DEFAULT_CLOUD_BACKUP_SETTINGS.enabled).toBe(false);
  });

  it('encrypts credentials before persisting them', async () => {
    await saveCloudBackupConfiguration(
      {
        enabled: true,
        endpoint: 'https://s3.example.com/',
        bucket: 'backups',
        region: 'us-east-1',
        prefix: '/team/openpass/',
        forcePathStyle: true,
        retentionMaxVersions: 30,
        retentionDays: 90
      },
      {
        accessKeyId: 'ACCESS_KEY',
        secretAccessKey: 'SECRET_KEY',
        cloudPassword: 'cloud-password'
      },
      'master-password'
    );

    const serialized = JSON.stringify(Object.fromEntries(storage));
    expect(serialized).not.toContain('SECRET_KEY');
    expect(serialized).not.toContain('cloud-password');
    await expect(loadCloudBackupSecrets('master-password')).resolves.toMatchObject({
      accessKeyId: 'ACCESS_KEY',
      secretAccessKey: 'SECRET_KEY',
      cloudPassword: 'cloud-password'
    });
  });

  it('rejects insecure remote endpoints but allows local MinIO', () => {
    expect(() => getCloudEndpointOriginPattern('http://storage.example.com')).toThrow(
      '必须使用 HTTPS'
    );
    expect(getCloudEndpointOriginPattern('http://127.0.0.1:9000')).toBe(
      'http://127.0.0.1:9000/*'
    );
  });

  it('normalizes object prefixes', () => {
    expect(normalizeCloudPrefix('/team/openpass/')).toBe('team/openpass');
    expect(normalizeCloudPrefix('')).toBe('openpass');
  });
});
