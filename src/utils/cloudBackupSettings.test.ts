import { beforeEach, describe, expect, it, vi } from 'vitest';
import CryptoUtils from './crypto';
import {
  DEFAULT_CLOUD_BACKUP_SETTINGS,
  getCloudEndpointOriginPattern,
  getCloudEndpointOriginPatterns,
  getCloudPasswordChoice,
  validateCloudBackupInput,
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
  const settings = {
    ...DEFAULT_CLOUD_BACKUP_SETTINGS,
    enabled: true,
    endpoint: 'https://s3.example.com',
    bucket: 'backups'
  };
  const credentials = {
    accessKeyId: 'ACCESS_KEY',
    secretAccessKey: 'SECRET_KEY',
    cloudPassword: 'cloud-password'
  };

  it('uses the unlocked master password without requiring another password', async () => {
    await saveCloudBackupConfiguration(settings, { ...credentials, cloudPassword: '' }, 'master', 'master');
    await expect(loadCloudBackupSecrets('master')).resolves.toMatchObject({
      cloudPassword: 'master', cloudPasswordMode: 'master'
    });
    expect(getCloudPasswordChoice(await loadCloudBackupSecrets('master'), 'master')).toBe('master');
    expect(JSON.stringify(Object.fromEntries(storage))).not.toContain('"cloudPassword":"master"');
  });

  it('preserves the captured cloud password after rotating the master password and saving settings', async () => {
    await saveCloudBackupConfiguration(settings, credentials, 'old-master', 'master');
    const contents = await CryptoUtils.decrypt(storage.get('encryptedCloudBackupSecrets') as string, 'old-master');
    storage.set('encryptedCloudBackupSecrets', await CryptoUtils.encrypt(contents, 'new-master'));
    const saved = await loadCloudBackupSecrets('new-master');
    expect(getCloudPasswordChoice(saved, 'new-master')).toBe('saved');
    await saveCloudBackupConfiguration({ ...settings, retentionDays: 60 }, saved, 'new-master', 'saved');
    await expect(loadCloudBackupSecrets('new-master')).resolves.toMatchObject({ cloudPassword: 'old-master' });
  });

  it('keeps synchronization history and unresolved conflicts when saving the same location', async () => {
    await saveCloudBackupConfiguration(settings, credentials, 'master-password');
    storage.set('cloudBackupStatus', { state: 'conflict', lastSuccessAt: '2026-10-07T10:06:01Z', latestETag: 'oss-append:500' });
    const saved = await loadCloudBackupSecrets('master-password');
    await saveCloudBackupConfiguration({ ...settings, retentionDays: 60 }, saved, 'master-password', 'saved');
    expect(storage.get('cloudBackupStatus')).toMatchObject({ state: 'conflict', lastSuccessAt: '2026-10-07T10:06:01Z', latestETag: 'oss-append:500' });
    await saveCloudBackupConfiguration({ ...settings, prefix: 'new-backups' }, saved, 'master-password', 'saved');
    expect(storage.get('cloudBackupStatus')).toMatchObject({ state: 'idle', lastSuccessAt: null, latestETag: null });
  });

  it('keeps legacy custom passwords and rejects changing the password in the same namespace', async () => {
    storage.set('cloudBackupSettings', settings);
    storage.set('encryptedCloudBackupSecrets', await CryptoUtils.encrypt(JSON.stringify(credentials), 'master-password'));
    await expect(loadCloudBackupSecrets('master-password')).resolves.toMatchObject({ cloudPasswordMode: 'custom' });
    const before = storage.get('encryptedCloudBackupSecrets');
    await expect(saveCloudBackupConfiguration(settings, credentials, 'master-password', 'master')).rejects.toThrow('更换对象前缀');
    expect(storage.get('encryptedCloudBackupSecrets')).toBe(before);
  });

  it('allows a different password for a new namespace', async () => {
    await saveCloudBackupConfiguration(settings, credentials, 'master-password');
    await saveCloudBackupConfiguration({ ...settings, prefix: 'new-backups' }, credentials, 'master-password', 'master');
    await expect(loadCloudBackupSecrets('master-password')).resolves.toMatchObject({ cloudPassword: 'master-password' });
  });

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

  it('converts native OSS endpoints and grants the actual bucket host', () => {
    const oss = { ...settings, endpoint: 'https://oss-cn-zhangjiakou.aliyuncs.com',
      bucket: 'fixture-backups', region: 'cn-zhangjiakou', forcePathStyle: true };
    expect(validateCloudBackupInput(oss)).toMatchObject({
      endpoint: 'https://s3.oss-cn-zhangjiakou.aliyuncs.com', forcePathStyle: false
    });
    expect(getCloudEndpointOriginPatterns(oss)).toEqual([
      'https://s3.oss-cn-zhangjiakou.aliyuncs.com/*',
      'https://fixture-backups.s3.oss-cn-zhangjiakou.aliyuncs.com/*',
      'https://fixture-backups.oss-cn-zhangjiakou.aliyuncs.com/*'
    ]);
    expect(getCloudEndpointOriginPatterns(settings)).toEqual(['https://s3.example.com/*']);
  });
});
