import CryptoUtils from './crypto';

export interface CloudBackupSettings {
  enabled: boolean;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  forcePathStyle: boolean;
  retentionMaxVersions: number;
  retentionDays: number;
}

export interface CloudBackupSecrets {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  cloudPassword: string;
  cloudPasswordMode?: 'master' | 'custom';
}

export function getCloudPasswordChoice(secrets: CloudBackupSecrets | null, masterPassword: string | null): 'master' | 'saved' {
  if (!secrets) return 'master';
  return secrets.cloudPasswordMode === 'master' && secrets.cloudPassword === masterPassword ? 'master' : 'saved';
}

export interface CloudBackupStatus {
  state: 'disabled' | 'idle' | 'pending' | 'syncing' | 'success' | 'conflict' | 'error';
  message: string | null;
  lastSuccessAt: string | null;
  lastPullAt: string | null;
  latestETag: string | null;
  latestSnapshotKey: string | null;
  lastRetentionAt: string | null;
  lastRetentionError: string | null;
}

export const DEFAULT_CLOUD_BACKUP_SETTINGS: CloudBackupSettings = {
  enabled: false,
  endpoint: '',
  bucket: '',
  region: 'us-east-1',
  prefix: 'openpass',
  forcePathStyle: true,
  retentionMaxVersions: 30,
  retentionDays: 90
};

export const DEFAULT_CLOUD_BACKUP_STATUS: CloudBackupStatus = {
  state: 'disabled',
  message: null,
  lastSuccessAt: null,
  lastPullAt: null,
  latestETag: null,
  latestSnapshotKey: null,
  lastRetentionAt: null,
  lastRetentionError: null
};

function normalizeRetention(value: number, fallback: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

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
  // AWS signing must target OSS's S3-compatible endpoint, not its native API.
  if (/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname)) {
    url.hostname = `s3.${url.hostname}`;
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function normalizeCloudPrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+|\/+$/g, '') || 'openpass';
}

export function isAliyunOssEndpoint(endpoint: string): boolean {
  return /^s3\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(new URL(normalizeCloudEndpoint(endpoint)).hostname);
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
    prefix: normalizeCloudPrefix(settings.prefix),
    forcePathStyle: isAliyunOssEndpoint(settings.endpoint) ? false : settings.forcePathStyle,
    retentionMaxVersions: normalizeRetention(settings.retentionMaxVersions, 30, 200),
    retentionDays: normalizeRetention(settings.retentionDays, 90, 3650)
  };

  if (!normalized.bucket) throw new Error('Bucket 不能为空');
  if (secrets) {
    if (!secrets.accessKeyId?.trim()) throw new Error('Access Key ID 不能为空');
    if (!secrets.secretAccessKey?.trim()) throw new Error('Secret Access Key 不能为空');
    if (secrets.cloudPasswordMode && !['master', 'custom'].includes(secrets.cloudPasswordMode)) {
      throw new Error('无效的云端密码方式');
    }
    if (!secrets.cloudPassword || secrets.cloudPassword.length < (secrets.cloudPasswordMode === 'master' ? 6 : 8)) {
      throw new Error(secrets.cloudPasswordMode === 'master'
        ? '主密码至少需要 6 个字符' : '云端加密密码至少需要 8 个字符');
    }
  }
  return normalized;
}

export async function saveCloudBackupConfiguration(
  settings: CloudBackupSettings,
  secrets: CloudBackupSecrets,
  masterPassword: string,
  passwordChoice: 'master' | 'custom' | 'saved' = secrets.cloudPasswordMode || 'custom'
) {
  if (!masterPassword) throw new Error('请先解锁 OpenPass');
  const resolvedSecrets: CloudBackupSecrets = {
    ...secrets,
    cloudPasswordMode: passwordChoice === 'saved' ? secrets.cloudPasswordMode || 'custom' : passwordChoice,
    // Capture once: rotating the local master password must not strand remote history.
    cloudPassword: passwordChoice === 'master' ? masterPassword : secrets.cloudPassword
  };
  const normalized = validateCloudBackupInput(settings, resolvedSecrets);
  const stored = await chrome.storage.local.get(['encryptedCloudBackupSecrets']);
  const previousSettings = await loadCloudBackupSettings();
  const sameLocation = Boolean(stored.encryptedCloudBackupSecrets) &&
    normalizeCloudEndpoint(previousSettings.endpoint) === normalized.endpoint &&
    previousSettings.bucket === normalized.bucket && previousSettings.prefix === normalized.prefix;
  if (stored.encryptedCloudBackupSecrets) {
    const previousSecrets = await loadCloudBackupSecrets(masterPassword);
    if (
      previousSecrets.cloudPassword !== resolvedSecrets.cloudPassword &&
      sameLocation
    ) {
      throw new Error('此云端位置已保存另一加密密码。请沿用已保存密码，或更换对象前缀建立新备份。');
    }
  }
  const encryptedSecrets = await CryptoUtils.encrypt(JSON.stringify(resolvedSecrets), masterPassword);
  const previousStatus = sameLocation ? await loadCloudBackupStatus() : DEFAULT_CLOUD_BACKUP_STATUS;
  await chrome.storage.local.set({
    cloudBackupSettings: normalized,
    encryptedCloudBackupSecrets: encryptedSecrets,
    cloudBackupStatus: {
      ...previousStatus,
      state: !normalized.enabled ? 'disabled' : previousStatus.state === 'disabled' ? 'idle' : previousStatus.state
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
      cloudPassword: parsed.cloudPassword,
      cloudPasswordMode: parsed.cloudPasswordMode === 'master' ? 'master' : 'custom'
    };
  } catch {
    throw new Error('无法解密云端凭据，请重新保存配置');
  }
}

export function getCloudEndpointOriginPattern(endpoint: string): string {
  return `${new URL(normalizeCloudEndpoint(endpoint)).origin}/*`;
}

export function getCloudEndpointOriginPatterns(settings: CloudBackupSettings): string[] {
  const normalized = validateCloudBackupInput(settings);
  const url = new URL(normalized.endpoint);
  const origins = [getCloudEndpointOriginPattern(normalized.endpoint)];
  if (!normalized.forcePathStyle) {
    url.hostname = `${normalized.bucket}.${url.hostname}`;
    origins.push(`${url.origin}/*`);
    if (isAliyunOssEndpoint(normalized.endpoint)) {
      url.hostname = url.hostname.replace(`${normalized.bucket}.s3.`, `${normalized.bucket}.`);
      origins.push(`${url.origin}/*`);
    }
  }
  return [...new Set(origins)];
}
