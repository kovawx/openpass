import CryptoUtils from './crypto';

export interface CloudBackupSettings {
  enabled: boolean;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  forcePathStyle: boolean;
}

export interface CloudBackupSecrets {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  cloudPassword: string;
}

export interface CloudBackupStatus {
  state: 'disabled' | 'idle' | 'pending' | 'syncing' | 'success' | 'conflict' | 'error';
  message: string | null;
  lastSuccessAt: string | null;
  latestETag: string | null;
  latestSnapshotKey: string | null;
}

export const DEFAULT_CLOUD_BACKUP_SETTINGS: CloudBackupSettings = {
  enabled: false,
  endpoint: '',
  bucket: '',
  region: 'us-east-1',
  prefix: 'openpass',
  forcePathStyle: true
};

export const DEFAULT_CLOUD_BACKUP_STATUS: CloudBackupStatus = {
  state: 'disabled',
  message: null,
  lastSuccessAt: null,
  latestETag: null,
  latestSnapshotKey: null
};

export function normalizeCloudEndpoint(endpoint: string): string {
  const url = new URL(endpoint.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('S3 Endpoint 仅支持 HTTP 或 HTTPS');
  }

  const localHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('非本机 S3 Endpoint 必须使用 HTTPS');
  }

  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function normalizeCloudPrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+|\/+$/g, '') || 'openpass';
}

export function validateCloudBackupInput(
  settings: CloudBackupSettings,
  secrets?: Partial<CloudBackupSecrets>
): CloudBackupSettings {
  const normalized = {
    ...settings,
    endpoint: normalizeCloudEndpoint(settings.endpoint),
    bucket: settings.bucket.trim(),
    region: settings.region.trim() || 'us-east-1',
    prefix: normalizeCloudPrefix(settings.prefix)
  };

  if (!normalized.bucket) throw new Error('Bucket 不能为空');
  if (secrets) {
    if (!secrets.accessKeyId?.trim()) throw new Error('Access Key ID 不能为空');
    if (!secrets.secretAccessKey?.trim()) throw new Error('Secret Access Key 不能为空');
    if (!secrets.cloudPassword || secrets.cloudPassword.length < 8) {
      throw new Error('云端加密密码至少需要 8 个字符');
    }
  }
  return normalized;
}

export async function saveCloudBackupConfiguration(
  settings: CloudBackupSettings,
  secrets: CloudBackupSecrets,
  masterPassword: string
) {
  if (!masterPassword) throw new Error('请先解锁 OpenPass');
  const normalized = validateCloudBackupInput(settings, secrets);
  const encryptedSecrets = await CryptoUtils.encrypt(JSON.stringify(secrets), masterPassword);
  await chrome.storage.local.set({
    cloudBackupSettings: normalized,
    encryptedCloudBackupSecrets: encryptedSecrets,
    cloudBackupStatus: {
      ...DEFAULT_CLOUD_BACKUP_STATUS,
      state: normalized.enabled ? 'idle' : 'disabled'
    } satisfies CloudBackupStatus
  });
  return normalized;
}

export async function loadCloudBackupSettings(): Promise<CloudBackupSettings> {
  const result = await chrome.storage.local.get<{ cloudBackupSettings?: Partial<CloudBackupSettings> }>([
    'cloudBackupSettings'
  ]);
  return { ...DEFAULT_CLOUD_BACKUP_SETTINGS, ...result.cloudBackupSettings };
}

export async function loadCloudBackupStatus(): Promise<CloudBackupStatus> {
  const result = await chrome.storage.local.get<{ cloudBackupStatus?: Partial<CloudBackupStatus> }>([
    'cloudBackupStatus'
  ]);
  return { ...DEFAULT_CLOUD_BACKUP_STATUS, ...result.cloudBackupStatus };
}

export async function loadCloudBackupSecrets(masterPassword: string): Promise<CloudBackupSecrets> {
  const result = await chrome.storage.local.get<{ encryptedCloudBackupSecrets?: string }>([
    'encryptedCloudBackupSecrets'
  ]);
  if (!result.encryptedCloudBackupSecrets) throw new Error('尚未保存云端备份凭据');

  try {
    const parsed = JSON.parse(
      await CryptoUtils.decrypt(result.encryptedCloudBackupSecrets, masterPassword)
    ) as Partial<CloudBackupSecrets>;
    if (!parsed.accessKeyId || !parsed.secretAccessKey || !parsed.cloudPassword) {
      throw new Error('missing fields');
    }
    return {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      sessionToken: parsed.sessionToken || undefined,
      cloudPassword: parsed.cloudPassword
    };
  } catch {
    throw new Error('无法解密云端凭据，请重新保存配置');
  }
}

export function getCloudEndpointOriginPattern(endpoint: string): string {
  return `${new URL(normalizeCloudEndpoint(endpoint)).origin}/*`;
}
