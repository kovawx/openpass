import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig
} from '@aws-sdk/client-s3';
import {
  decryptBackupData,
  getBackupEncryptionSettings,
  resolveStoredBackupPassword,
  type BackupData,
  type BackupSecretLike
} from './backup';
import { unwrapCloudBackup, wrapBackupForCloud } from './cloudBackup';
import {
  loadCloudBackupSecrets,
  loadCloudBackupSettings,
  type CloudBackupSecrets,
  type CloudBackupSettings,
  type CloudBackupStatus
} from './cloudBackupSettings';

const CONTENT_TYPE = 'application/vnd.openpass.cloud-backup+json';

export interface CloudBackupVersion {
  key: string;
  lastModified: string | null;
  size: number;
  etag: string | null;
}

function objectKey(settings: CloudBackupSettings, suffix: string) {
  return `${settings.prefix}/v1/${suffix}`;
}

function historyPrefix(settings: CloudBackupSettings) {
  return objectKey(settings, 'objects/');
}

function isHistoryKey(settings: CloudBackupSettings, key: string) {
  const prefix = historyPrefix(settings);
  const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : '';
  return /^[a-zA-Z0-9-]+\.opb$/.test(suffix);
}

export function getCloudBackupObjectKeys(settings: CloudBackupSettings, snapshotId: string) {
  return {
    snapshot: objectKey(settings, `objects/${snapshotId}.opb`),
    latest: objectKey(settings, 'latest.opb')
  };
}

function createClient(settings: CloudBackupSettings, secrets: CloudBackupSecrets) {
  const config: S3ClientConfig = {
    endpoint: settings.endpoint,
    region: settings.region,
    forcePathStyle: settings.forcePathStyle,
    credentials: {
      accessKeyId: secrets.accessKeyId,
      secretAccessKey: secrets.secretAccessKey,
      sessionToken: secrets.sessionToken
    }
  };
  return new S3Client(config);
}

function getHttpStatus(error: unknown) {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) return null;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode ?? null;
}

function isNotFound(error: unknown) {
  return getHttpStatus(error) === 404 ||
    (error instanceof Error && (error.name === 'NotFound' || error.name === 'NoSuchKey'));
}

export function isCloudBackupConflict(error: unknown) {
  return getHttpStatus(error) === 412 ||
    (error instanceof Error &&
      (error.name === 'PreconditionFailed' || error.name === 'CloudBackupConflict'));
}

async function updateStatus(status: Partial<CloudBackupStatus>) {
  const result = await chrome.storage.local.get<{ cloudBackupStatus?: CloudBackupStatus }>([
    'cloudBackupStatus'
  ]);
  await chrome.storage.local.set({
    cloudBackupStatus: {
      state: 'idle',
      message: null,
      lastSuccessAt: null,
      lastPullAt: null,
      latestETag: null,
      latestSnapshotKey: null,
      lastRetentionAt: null,
      lastRetentionError: null,
      ...result.cloudBackupStatus,
      ...status
    } satisfies CloudBackupStatus
  });
}

async function resolveRuntime(masterPassword: string) {
  const [settings, secrets] = await Promise.all([
    loadCloudBackupSettings(),
    loadCloudBackupSecrets(masterPassword)
  ]);
  if (!settings.enabled) throw new Error('云端备份未启用');
  return { settings, secrets, client: createClient(settings, secrets) };
}

async function prepareBackupForCloud<T extends BackupSecretLike>(
  backupData: BackupData<T>,
  masterPassword: string
): Promise<BackupData<T>> {
  if (!backupData.encrypted) return backupData;
  const encryptionSettings = await getBackupEncryptionSettings();
  const backupPassword = await resolveStoredBackupPassword(masterPassword, encryptionSettings);
  if (!backupPassword) throw new Error('无法解密本地备份，请检查备份密码');
  const secrets = await decryptBackupData(backupData, backupPassword);
  return {
    ...backupData,
    encrypted: false,
    encryptedData: undefined,
    encryptionVersion: undefined,
    kdf: undefined,
    kdfIterations: undefined,
    secrets,
    count: secrets.length
  };
}

async function readBodyAsText(body: unknown): Promise<string> {
  if (
    typeof body === 'object' &&
    body !== null &&
    'transformToString' in body &&
    typeof body.transformToString === 'function'
  ) {
    return body.transformToString();
  }
  if (body instanceof Blob) return body.text();
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  throw new Error('S3 返回了无法读取的对象内容');
}

export async function testS3CloudBackupConnection(masterPassword: string) {
  const { settings, client } = await resolveRuntime(masterPassword);
  const latestKey = getCloudBackupObjectKeys(settings, 'probe').latest;
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: settings.bucket, Key: latestKey }));
    return { success: true, exists: true, etag: result.ETag ?? null };
  } catch (error) {
    if (isNotFound(error)) return { success: true, exists: false, etag: null };
    throw error;
  } finally {
    client.destroy();
  }
}

export async function uploadBackupToS3<T extends BackupSecretLike>(
  backupData: BackupData<T>,
  masterPassword: string,
  expectedLatestETag?: string | null
) {
  const { settings, secrets, client } = await resolveRuntime(masterPassword);
  const snapshotId = crypto.randomUUID();
  const keys = getCloudBackupObjectKeys(settings, snapshotId);

  await updateStatus({ state: 'syncing', message: '正在上传云端备份' });
  try {
    const cloudBackupData = await prepareBackupForCloud(backupData, masterPassword);
    const envelope = await wrapBackupForCloud(cloudBackupData, secrets.cloudPassword);
    const body = JSON.stringify(envelope);
    await client.send(new PutObjectCommand({
      Bucket: settings.bucket,
      Key: keys.snapshot,
      Body: body,
      ContentType: CONTENT_TYPE,
      IfNoneMatch: '*'
    }));

    let currentETag = expectedLatestETag;
    if (expectedLatestETag === undefined) {
      try {
        const head = await client.send(new HeadObjectCommand({
          Bucket: settings.bucket,
          Key: keys.latest
        }));
        currentETag = head.ETag;
      } catch (error) {
        if (!isNotFound(error)) throw error;
        currentETag = null;
      }
    }

    let latestResult;
    try {
      latestResult = await client.send(new PutObjectCommand({
        Bucket: settings.bucket,
        Key: keys.latest,
        Body: body,
        ContentType: CONTENT_TYPE,
        ...(currentETag ? { IfMatch: currentETag } : { IfNoneMatch: '*' })
      }));
    } catch (error) {
      if (isCloudBackupConflict(error)) {
        await updateStatus({
          state: 'conflict',
          message: '其他设备已更新 latest；本次不可变备份已保留，未覆盖远端最新备份',
          latestSnapshotKey: keys.snapshot
        });
        const conflictError = new Error('云端最新备份发生并发冲突，本次历史备份已安全保留');
        conflictError.name = 'CloudBackupConflict';
        throw conflictError;
      }
      throw error;
    }

    const now = new Date().toISOString();
    await updateStatus({
      state: 'success',
      message: '云端备份已同步',
      lastSuccessAt: now,
      latestETag: latestResult.ETag ?? null,
      latestSnapshotKey: keys.snapshot
    });
    return { snapshotKey: keys.snapshot, latestKey: keys.latest, etag: latestResult.ETag ?? null };
  } catch (error) {
    if (!isCloudBackupConflict(error)) {
      await updateStatus({
        state: 'error',
        message: error instanceof Error ? error.message : '云端备份上传失败'
      });
    }
    throw error;
  } finally {
    client.destroy();
  }
}

export async function downloadLatestBackupFromS3<T extends BackupSecretLike>(
  masterPassword: string
): Promise<BackupData<T>> {
  return (await downloadLatestBackupStateFromS3<T>(masterPassword)).backupData;
}

async function listVersionObjects(
  client: S3Client,
  settings: CloudBackupSettings
): Promise<CloudBackupVersion[]> {
  const versions: CloudBackupVersion[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: settings.bucket,
      Prefix: historyPrefix(settings),
      ContinuationToken: continuationToken
    }));
    for (const object of result.Contents ?? []) {
      if (!object.Key || !isHistoryKey(settings, object.Key)) continue;
      versions.push({
        key: object.Key,
        lastModified: object.LastModified?.toISOString() ?? null,
        size: object.Size ?? 0,
        etag: object.ETag ?? null
      });
    }
    if (!result.IsTruncated) break;
    if (!result.NextContinuationToken || result.NextContinuationToken === continuationToken) {
      throw new Error('S3 历史版本分页响应无效');
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return versions.sort((left, right) => {
    const timeDiff = Date.parse(right.lastModified || '') - Date.parse(left.lastModified || '');
    if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff;
    return right.key.localeCompare(left.key);
  });
}

function assertHistoryKey(settings: CloudBackupSettings, key: string) {
  if (!isHistoryKey(settings, key)) {
    throw new Error('无效的云端历史版本标识');
  }
}

export async function downloadLatestBackupStateFromS3<T extends BackupSecretLike>(
  masterPassword: string
): Promise<{ backupData: BackupData<T>; etag: string | null }> {
  const { settings, secrets, client } = await resolveRuntime(masterPassword);
  const latestKey = getCloudBackupObjectKeys(settings, 'restore').latest;
  try {
    const result = await client.send(new GetObjectCommand({
      Bucket: settings.bucket,
      Key: latestKey
    }));
    const body = await readBodyAsText(result.Body);
    return {
      backupData: await unwrapCloudBackup<T>(JSON.parse(body), secrets.cloudPassword),
      etag: result.ETag ?? null
    };
  } catch (error) {
    if (isNotFound(error)) {
      const notFoundError = new Error('云端尚无可恢复的备份', { cause: error });
      notFoundError.name = 'CloudBackupNotFound';
      throw notFoundError;
    }
    throw error;
  } finally {
    client.destroy();
  }
}

export async function listCloudBackupVersions(
  masterPassword: string
): Promise<CloudBackupVersion[]> {
  const { settings, client } = await resolveRuntime(masterPassword);
  try {
    return await listVersionObjects(client, settings);
  } finally {
    client.destroy();
  }
}

export async function downloadCloudBackupVersion<T extends BackupSecretLike>(
  key: string,
  masterPassword: string
): Promise<BackupData<T>> {
  const { settings, secrets, client } = await resolveRuntime(masterPassword);
  try {
    assertHistoryKey(settings, key);
    const result = await client.send(new GetObjectCommand({
      Bucket: settings.bucket,
      Key: key
    }));
    const body = await readBodyAsText(result.Body);
    return unwrapCloudBackup<T>(JSON.parse(body), secrets.cloudPassword);
  } finally {
    client.destroy();
  }
}

export async function applyCloudBackupRetention(
  masterPassword: string,
  protectedKey?: string
): Promise<{ deleted: number; kept: number; error?: string }> {
  let client: S3Client | undefined;
  try {
    const runtime = await resolveRuntime(masterPassword);
    client = runtime.client;
    const { settings } = runtime;
    const versions = await listVersionObjects(client, settings);
    const protectedKeys = new Set([protectedKey, versions[0]?.key].filter(Boolean));
    const cutoff = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000;
    const candidates = versions.filter((version, index) => {
      if (protectedKeys.has(version.key)) return false;
      const expired = version.lastModified
        ? Date.parse(version.lastModified) < cutoff
        : false;
      return index >= settings.retentionMaxVersions || expired;
    });

    for (let index = 0; index < candidates.length; index += 1000) {
      const chunk = candidates.slice(index, index + 1000);
      const result = await client.send(new DeleteObjectsCommand({
        Bucket: settings.bucket,
        Delete: {
          Quiet: true,
          Objects: chunk.map((version) => ({ Key: version.key }))
        }
      }));
      if (result.Errors?.length) {
        throw new Error(`有 ${result.Errors.length} 个历史版本清理失败`);
      }
    }

    await updateStatus({
      message: candidates.length > 0
        ? `已清理 ${candidates.length} 个过期云端版本`
        : '云端历史版本在保留范围内',
      lastRetentionAt: new Date().toISOString(),
      lastRetentionError: null
    });
    return { deleted: candidates.length, kept: versions.length - candidates.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : '历史版本清理失败';
    await updateStatus({
      message: `同步成功，但历史版本清理失败：${message}`,
      lastRetentionError: message
    }).catch(() => undefined);
    return { deleted: 0, kept: 0, error: message };
  } finally {
    client?.destroy();
  }
}
