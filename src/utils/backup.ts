import CryptoUtils from './crypto';
import { getBackupSyncMetadata, type BackupSyncMetadata } from './syncMerge';

export interface BackupSecretLike {
  site?: string;
  secret?: string;
  digits?: number;
  createdAt?: string;
  importedAt?: string;
}

export interface BackupData<T = BackupSecretLike> {
  format: 'openpass-backup';
  formatVersion: number;
  appVersion: string;
  exportTime: string;
  count: number;
  encrypted: boolean;
  secrets?: T[];
  encryptedData?: string;
  exportPlatform?: string;
  encryptionVersion?: number;
  kdf?: string;
  kdfIterations?: number;
  migratedFrom?: string;
  migratedAt?: string;
  sync?: BackupSyncMetadata;
}

export interface BackupEncryptionSettings {
  enableBackupEncryption: boolean;
  useMasterPasswordForBackup: boolean;
  encryptedBackupPassword: string | null;
}

export interface BackupValidationResult<T = BackupSecretLike> {
  valid: boolean;
  error?: string;
  data?: BackupData<T>;
  encrypted?: boolean;
}

export interface BackupCompatibilityResult {
  compatible: boolean;
  message: string;
  level: 'ok' | 'warning' | 'error';
}

export interface BackupSummary {
  format: string;
  formatVersion: number;
  appVersion: string;
  exportTime: string;
  count: number;
  encrypted: boolean;
  compatibility: BackupCompatibilityResult;
}

interface LegacyBackupData<T> {
  version?: string;
  exportTime?: string;
  count?: number;
  encrypted?: boolean;
  secrets: T[];
}

const MAX_BACKUP_SNAPSHOTS = 5;
const SNAPSHOT_DEBOUNCE_MS = 3000;

let pendingSnapshotSecrets: BackupSecretLike[] | null = null;
let pendingSnapshotPassword: string | undefined;
let snapshotDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function buildSecretIdentity<T extends BackupSecretLike>(secret: T): string {
  const site = String(secret.site || '').trim().toLowerCase();
  const value = String(secret.secret || '').trim().toUpperCase();
  return `${site}::${value}`;
}

function getCurrentAppVersion() {
  return chrome.runtime.getManifest().version || '0.0.0';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneSecrets<T>(secrets: T[]): T[] {
  return secrets.map((secret) => ({ ...secret }));
}

function parseVersion(version: string) {
  const parts = (version || '0.0.0').split('.').map((part) => Number.parseInt(part, 10));
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0
  };
}

function normalizeBackupSyncMetadata(value: unknown): BackupSyncMetadata | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.deviceId !== 'string') {
    return undefined;
  }
  const tombstones = Array.isArray(value.tombstones)
    ? value.tombstones.filter((entry): entry is BackupSyncMetadata['tombstones'][number] =>
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        typeof entry.deletedAt === 'string' &&
        typeof entry.deviceId === 'string'
      )
    : [];
  return { version: 1, deviceId: value.deviceId, tombstones };
}

function normalizeBackupData<T extends BackupSecretLike>(data: unknown): BackupData<T> | null {
  if (Array.isArray(data)) {
    return {
      format: 'openpass-backup',
      formatVersion: 0,
      appVersion: '0.0.0',
      exportTime: new Date().toISOString(),
      count: data.length,
      encrypted: false,
      secrets: data as T[]
    };
  }

  if (!isRecord(data)) {
    return null;
  }

  if (data.format === 'openpass-backup') {
    return {
      format: 'openpass-backup',
      formatVersion:
        typeof data.formatVersion === 'number' ? data.formatVersion : Number.NaN,
      appVersion: typeof data.appVersion === 'string' ? data.appVersion : '0.0.0',
      exportTime:
        typeof data.exportTime === 'string' ? data.exportTime : new Date().toISOString(),
      count:
        typeof data.count === 'number'
          ? data.count
          : Array.isArray(data.secrets)
            ? data.secrets.length
            : 0,
      encrypted: data.encrypted === true,
      encryptedData: typeof data.encryptedData === 'string' ? data.encryptedData : undefined,
      secrets: Array.isArray(data.secrets) ? (data.secrets as T[]) : undefined,
      exportPlatform: typeof data.exportPlatform === 'string' ? data.exportPlatform : undefined,
      encryptionVersion:
        typeof data.encryptionVersion === 'number' ? data.encryptionVersion : undefined,
      kdf: typeof data.kdf === 'string' ? data.kdf : undefined,
      kdfIterations: typeof data.kdfIterations === 'number' ? data.kdfIterations : undefined,
      migratedFrom: typeof data.migratedFrom === 'string' ? data.migratedFrom : undefined,
      migratedAt: typeof data.migratedAt === 'string' ? data.migratedAt : undefined,
      sync: normalizeBackupSyncMetadata(data.sync)
    };
  }

  if ((data.version === '1.0' || data.version === '2.0') && Array.isArray(data.secrets)) {
    return migrateLegacyBackupData(data as unknown as LegacyBackupData<T>);
  }

  if (Array.isArray(data.secrets)) {
    return {
      format: 'openpass-backup',
      formatVersion: 0,
      appVersion: typeof data.appVersion === 'string' ? data.appVersion : '0.0.0',
      exportTime:
        typeof data.exportTime === 'string' ? data.exportTime : new Date().toISOString(),
      count:
        typeof data.count === 'number'
          ? data.count
          : Array.isArray(data.secrets)
            ? data.secrets.length
            : 0,
      encrypted: data.encrypted === true && typeof data.encryptedData === 'string',
      encryptedData: typeof data.encryptedData === 'string' ? data.encryptedData : undefined,
      secrets: data.secrets as T[]
    };
  }

  return null;
}

function validateSecrets<T extends BackupSecretLike>(secrets: T[]) {
  for (let index = 0; index < secrets.length; index += 1) {
    const secret = secrets[index];
    if (!isRecord(secret)) {
      return `第 ${index + 1} 个密钥数据格式错误`;
    }

    if (typeof secret.secret !== 'string' || !secret.secret.trim()) {
      return `第 ${index + 1} 个密钥缺少有效的密钥内容`;
    }

    if (typeof secret.site !== 'string' || !secret.site.trim()) {
      return `第 ${index + 1} 个密钥缺少有效的站点信息`;
    }
  }

  return null;
}

export function checkBackupCompatibility(
  backupVersion: string,
  currentVersion = getCurrentAppVersion()
): BackupCompatibilityResult {
  const current = parseVersion(currentVersion);
  const backup = parseVersion(backupVersion || '0.0.0');

  if (current.major !== backup.major) {
    return {
      compatible: false,
      message: `备份版本 ${backupVersion} 与当前版本 ${currentVersion} 主版本不兼容`,
      level: 'error'
    };
  }

  const minorDiff = current.minor - backup.minor;

  if (minorDiff < 0) {
    return {
      compatible: false,
      message: `备份版本 ${backupVersion} 高于当前版本 ${currentVersion}，请先升级应用`,
      level: 'error'
    };
  }

  if (minorDiff === 0) {
    return {
      compatible: true,
      message: `备份版本 ${backupVersion} 与当前版本完全兼容`,
      level: 'ok'
    };
  }

  if (minorDiff === 1) {
    return {
      compatible: true,
      message: `备份版本 ${backupVersion} 可导入，数据将自动迁移到 ${currentVersion}`,
      level: 'warning'
    };
  }

  return {
    compatible: false,
    message: `备份版本 ${backupVersion} 过旧，不支持跨多个次版本导入（当前 ${currentVersion}）`,
    level: 'error'
  };
}

export function migrateLegacyBackupData<T extends BackupSecretLike>(
  data: LegacyBackupData<T>
): BackupData<T> {
  return {
    format: 'openpass-backup',
    formatVersion: 1,
    appVersion: data.version === '2.0' ? '0.1.0' : '0.0.0',
    exportTime: data.exportTime || new Date().toISOString(),
    count: typeof data.count === 'number' ? data.count : data.secrets.length,
    encrypted: data.encrypted === true,
    secrets: data.secrets
  };
}

export function migrateBackupData<T extends BackupSecretLike>(
  data: BackupData<T>,
  currentVersion = getCurrentAppVersion()
): BackupData<T> {
  if (data.appVersion === currentVersion) {
    return data;
  }

  const from = parseVersion(data.appVersion);
  const to = parseVersion(currentVersion);
  const migrated: BackupData<T> = {
    ...data,
    formatVersion: 1,
    appVersion: currentVersion,
    migratedFrom: data.appVersion,
    migratedAt: new Date().toISOString(),
    secrets: Array.isArray(data.secrets) ? cloneSecrets(data.secrets) : data.secrets
  };

  if (Array.isArray(migrated.secrets)) {
    if (from.major === 0 && from.minor === 0 && to.minor >= 1) {
      migrated.secrets = migrated.secrets.map((secret) => {
        const nextSecret = {
          ...secret
        } as T & { digits?: number; createdAt?: string; importedAt?: string };

        nextSecret.digits = typeof nextSecret.digits === 'number' ? nextSecret.digits : 6;
        nextSecret.createdAt =
          typeof nextSecret.createdAt === 'string'
            ? nextSecret.createdAt
            : typeof nextSecret.importedAt === 'string'
              ? nextSecret.importedAt
              : new Date().toISOString();

        return nextSecret;
      });
    }
  }

  return migrated;
}

export function validateBackupData<T extends BackupSecretLike>(
  data: unknown
): BackupValidationResult<T> {
  const normalizedData = normalizeBackupData<T>(data);
  if (!normalizedData) {
    return { valid: false, error: '无法识别的备份格式' };
  }

  if (!Number.isFinite(normalizedData.formatVersion)) {
    return { valid: false, error: '缺少格式版本号' };
  }

  if (normalizedData.encrypted) {
    if (!normalizedData.encryptedData) {
      return { valid: false, error: '缺少加密数据' };
    }

    return {
      valid: true,
      data: normalizedData,
      encrypted: true
    };
  }

  if (!Array.isArray(normalizedData.secrets)) {
    return { valid: false, error: '缺少密钥数据' };
  }

  const validationError = validateSecrets(normalizedData.secrets);
  if (validationError) {
    return { valid: false, error: validationError };
  }

  return {
    valid: true,
    data: {
      ...normalizedData,
      count: normalizedData.secrets.length
    },
    encrypted: false
  };
}

export function getBackupSummary<T extends BackupSecretLike>(
  data: BackupData<T>
): BackupSummary {
  return {
    format: data.format,
    formatVersion: data.formatVersion,
    appVersion: data.appVersion,
    exportTime: data.exportTime,
    count: data.count || data.secrets?.length || 0,
    encrypted: data.encrypted,
    compatibility: checkBackupCompatibility(data.appVersion || '0.0.0')
  };
}

export async function createBackupData<T>(
  secrets: T[],
  password?: string
): Promise<BackupData<T>> {
  const backupData: BackupData<T> = {
    format: 'openpass-backup',
    formatVersion: 1,
    appVersion: getCurrentAppVersion(),
    exportTime: new Date().toISOString(),
    exportPlatform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
    count: secrets.length,
    encrypted: !!password,
    secrets: password ? undefined : secrets,
    sync: await getBackupSyncMetadata()
  };

  if (password) {
    backupData.encryptionVersion = 1;
    backupData.kdf = 'PBKDF2';
    backupData.kdfIterations = 100000;
    backupData.encryptedData = await CryptoUtils.encrypt(JSON.stringify(secrets), password);
  }

  return backupData;
}

export async function saveBackupSnapshot<T>(backupData: BackupData<T>) {
  const result = await chrome.storage.local.get<{
    backupSnapshots?: Array<{ data: BackupData<T>; timestamp: string; count: number }>;
  }>(['backupSnapshots']);
  let snapshots = Array.isArray(result.backupSnapshots) ? result.backupSnapshots : [];

  snapshots.unshift({
    data: backupData,
    timestamp: new Date().toISOString(),
    count: backupData.count
  });

  if (snapshots.length > MAX_BACKUP_SNAPSHOTS) {
    snapshots = snapshots.slice(0, MAX_BACKUP_SNAPSHOTS);
  }

  await chrome.storage.local.set({ backupSnapshots: snapshots });
  return snapshots;
}

async function flushPendingSnapshotBackup() {
  snapshotDebounceTimer = null;

  if (!pendingSnapshotSecrets) {
    return false;
  }

  const result = await chrome.storage.local.get<{ enableLocalSnapshot?: boolean }>([
    'enableLocalSnapshot'
  ]);
  if (result.enableLocalSnapshot === false) {
    pendingSnapshotSecrets = null;
    pendingSnapshotPassword = undefined;
    return false;
  }

  const secrets = pendingSnapshotSecrets;
  const password = pendingSnapshotPassword;
  pendingSnapshotSecrets = null;
  pendingSnapshotPassword = undefined;

  const backupData = await createBackupData(secrets, password);
  await saveBackupSnapshot(backupData);
  return true;
}

export async function triggerChangeBackup<T extends BackupSecretLike>(
  secrets: T[],
  password?: string
) {
  pendingSnapshotSecrets = cloneSecrets(secrets);
  pendingSnapshotPassword = password;

  if (snapshotDebounceTimer) {
    clearTimeout(snapshotDebounceTimer);
  }

  snapshotDebounceTimer = setTimeout(() => {
    void flushPendingSnapshotBackup().catch((error) => {
      console.error('OpenPass: 自动快照备份失败', error);
    });
  }, SNAPSHOT_DEBOUNCE_MS);

  return Promise.resolve();
}

export async function triggerLocalSnapshotBackup<T>(secrets: T[], password?: string) {
  const result = await chrome.storage.local.get<{ enableLocalSnapshot?: boolean }>([
    'enableLocalSnapshot'
  ]);
  if (result.enableLocalSnapshot === false) {
    return false;
  }

  const backupData = await createBackupData(secrets, password);
  await saveBackupSnapshot(backupData);
  return true;
}

export async function decryptBackupData<T extends BackupSecretLike>(
  backupData: BackupData<T>,
  password: string
): Promise<T[]> {
  if (!backupData.encrypted || !backupData.encryptedData) {
    return Array.isArray(backupData.secrets) ? backupData.secrets : [];
  }

  let decrypted: string;
  try {
    decrypted = await CryptoUtils.decrypt(backupData.encryptedData, password);
  } catch {
    throw new Error('备份密码不正确，请重新输入');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypted);
  } catch {
    throw new Error('备份文件已损坏，解密后的内容无效');
  }

  const validation = validateBackupData<T>(parsed);

  if (!validation.valid || !validation.data?.secrets) {
    throw new Error(validation.error || '备份文件已损坏，解密后的内容无效');
  }

  return validation.data.secrets;
}

export async function getBackupEncryptionSettings(): Promise<BackupEncryptionSettings> {
  const result = await chrome.storage.local.get<{
    enableBackupEncryption?: boolean;
    useMasterPasswordForBackup?: boolean;
    encryptedBackupPassword?: string;
  }>([
    'enableBackupEncryption',
    'useMasterPasswordForBackup',
    'encryptedBackupPassword'
  ]);

  return {
    enableBackupEncryption: result.enableBackupEncryption === true,
    useMasterPasswordForBackup: result.useMasterPasswordForBackup !== false,
    encryptedBackupPassword:
      typeof result.encryptedBackupPassword === 'string' ? result.encryptedBackupPassword : null
  };
}

export async function resolveStoredBackupPassword(
  sessionKey: string | null,
  settings: BackupEncryptionSettings
): Promise<string | undefined> {
  if (!settings.enableBackupEncryption) {
    return undefined;
  }

  if (settings.useMasterPasswordForBackup) {
    return sessionKey || undefined;
  }

  if (!sessionKey || !settings.encryptedBackupPassword) {
    return undefined;
  }

  return CryptoUtils.decrypt(settings.encryptedBackupPassword, sessionKey);
}
