import {
  validateBackupData,
  type BackupData,
  type BackupSecretLike
} from './backup';
import CryptoUtils from './crypto';

export const CLOUD_BACKUP_FORMAT = 'openpass-cloud-backup';
export const CLOUD_BACKUP_FORMAT_VERSION = 1;

export interface CloudBackupEnvelope {
  format: typeof CLOUD_BACKUP_FORMAT;
  version: typeof CLOUD_BACKUP_FORMAT_VERSION;
  cipher: 'AES-256-GCM';
  encryptedBackup: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Cloud storage must never receive BackupData directly because an unencrypted backup contains
 * secrets and an encrypted backup still exposes metadata. The entire existing backup format is
 * therefore wrapped in an authenticated cloud envelope.
 */
export async function wrapBackupForCloud<T>(
  backupData: BackupData<T>,
  cloudPassword: string
): Promise<CloudBackupEnvelope> {
  if (!cloudPassword) {
    throw new Error('云端备份密码不能为空');
  }

  return {
    format: CLOUD_BACKUP_FORMAT,
    version: CLOUD_BACKUP_FORMAT_VERSION,
    cipher: 'AES-256-GCM',
    encryptedBackup: await CryptoUtils.encrypt(JSON.stringify(backupData), cloudPassword)
  };
}

export async function unwrapCloudBackup<T extends BackupSecretLike>(
  envelope: unknown,
  cloudPassword: string
): Promise<BackupData<T>> {
  if (
    !isRecord(envelope) ||
    envelope.format !== CLOUD_BACKUP_FORMAT ||
    envelope.version !== CLOUD_BACKUP_FORMAT_VERSION ||
    envelope.cipher !== 'AES-256-GCM' ||
    typeof envelope.encryptedBackup !== 'string'
  ) {
    throw new Error('不支持或已损坏的 OpenPass 云端备份格式');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await CryptoUtils.decrypt(envelope.encryptedBackup, cloudPassword));
  } catch {
    throw new Error('云端备份密码错误或密文已损坏');
  }

  const validation = validateBackupData<T>(parsed);
  if (!validation.valid || !validation.data) {
    throw new Error(validation.error || '云端备份中的 OpenPass 备份格式无效');
  }

  return validation.data;
}
