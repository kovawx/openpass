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
  getCloudEndpointOriginPatterns,
  validateCloudBackupInput,
  isAliyunOssEndpoint,
  type CloudBackupSecrets,
  type CloudBackupSettings,
  type CloudBackupStatus
} from './cloudBackupSettings';

import { readOssIndex, requestOss, appendOssIndex, getOssIndexKey, ossCursor, parseOssCursor } from './ossCloudIndex';

const CONTENT_TYPE = 'application/vnd.openpass.cloud-backup+json';

export interface CloudBackupVersion {
  key: string;
  lastModified: string | null;
  size: number;
  etag: string | null;
  current?: boolean;
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
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
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
  if (error instanceof Error && error.name === 'NoSuchBucket') return false;
  return getHttpStatus(error) === 404 ||
    (error instanceof Error && (error.name === 'NotFound' || error.name === 'NoSuchKey'));
}

export function isCloudBackupConflict(error: unknown) {
  return getHttpStatus(error) === 412 ||
    (error instanceof Error &&
      (error.name === 'PreconditionFailed' || error.name === 'PositionNotEqualToLength' || error.name === 'CloudBackupConflict'));
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

async function resolveRuntime(masterPassword: string, allowDisabled = false) {
  const [settings, secrets] = await Promise.all([
    loadCloudBackupSettings(),
    loadCloudBackupSecrets(masterPassword)
  ]);
  if (!settings.enabled && !allowDisabled) throw new Error('云端备份未启用');
  const normalized = validateCloudBackupInput(settings);
  if (chrome.permissions?.contains && !await chrome.permissions.contains({
    origins: getCloudEndpointOriginPatterns(normalized)
  })) {
    throw new Error('云端地址尚未获得访问权限，请在设置页保存配置或重新测试连接以授权');
  }
  return { settings: normalized, secrets, client: createClient(normalized, secrets) };
}

async function prepareBackupForCloud<T extends BackupSecretLike>(
  backupData: BackupData<T>,
  masterPassword: string
): Promise<BackupData<T>> {
  if (!backupData.encrypted) return backupData;
  const encryptionSettings = await getBackupEncryptionSettings();
  const backupPassword = await resolveStoredBackupPassword(masterPassword, encryptionSettings);
  let secrets: T[];
  try { secrets = await decryptBackupData(backupData, backupPassword || masterPassword); }
  catch (error) {
    if (!backupPassword || backupPassword === masterPassword) throw error;
    secrets = await decryptBackupData(backupData, masterPassword);
  }
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
    // Listing distinguishes an empty bucket from a missing bucket or denied access.
    const result = await client.send(new ListObjectsV2Command({
      Bucket: settings.bucket, Prefix: isAliyunOssEndpoint(settings.endpoint) ? `${settings.prefix}/v1/latest.` : latestKey, MaxKeys: 2
    }));
    const latest = result.Contents?.find((object) => object.Key === getOssIndexKey(settings))
      || result.Contents?.find((object) => object.Key === latestKey);
    return { success: true, exists: Boolean(latest), etag: latest?.ETag ?? null };
  } finally {
    client.destroy();
  }
}

export async function uploadBackupToS3<T extends BackupSecretLike>(
  backupData: BackupData<T>,
  masterPassword: string,
  expectedLatestETag?: string | null,
  allowDisabled = false
) {
  const { settings, secrets, client } = await resolveRuntime(masterPassword, allowDisabled);
  const snapshotId = globalThis.crypto.randomUUID();
  const keys = getCloudBackupObjectKeys(settings, snapshotId);

  await updateStatus({ state: 'syncing', message: '正在上传云端备份' });
  try {
    const cloudBackupData = await prepareBackupForCloud(backupData, masterPassword);
    const envelope = await wrapBackupForCloud(cloudBackupData, secrets.cloudPassword);
    const body = JSON.stringify(envelope);
    const oss = isAliyunOssEndpoint(settings.endpoint);
    if (oss) {
      await requestOss(settings, secrets, 'PUT', keys.snapshot, {
        body, headers: { 'content-type': CONTENT_TYPE, 'x-oss-forbid-overwrite': 'true' }
      });
    } else {
      await client.send(new PutObjectCommand({
        Bucket: settings.bucket, Key: keys.snapshot, Body: body,
        ContentType: CONTENT_TYPE, IfNoneMatch: '*'
      }));
    }

    let currentETag = expectedLatestETag;
    if (oss && expectedLatestETag === undefined) {
      currentETag = ossCursor((await readOssIndex(settings, secrets)).position);
    } else if (!oss && expectedLatestETag === undefined) {
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
      latestResult = oss
        ? { ETag: await appendOssIndex(settings, secrets, keys.snapshot, parseOssCursor(currentETag ?? null)) }
        : await client.send(new PutObjectCommand({
          Bucket: settings.bucket, Key: keys.latest, Body: body, ContentType: CONTENT_TYPE,
          ...(currentETag ? { IfMatch: currentETag } : { IfNoneMatch: '*' })
        }));
    } catch (error) {
      if (isCloudBackupConflict(error)) {
        await updateStatus({
          state: 'conflict',
          message: '其他设备已更新云端版本；本次不可变备份已保留，未覆盖远端最新备份',
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
    return { snapshotKey: keys.snapshot, latestKey: oss ? getOssIndexKey(settings) : keys.latest, etag: latestResult.ETag ?? null };
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
  return (await downloadLatestBackupStateFromS3<T>(masterPassword, true)).backupData;
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
  masterPassword: string,
  allowDisabled = false
): Promise<{ backupData: BackupData<T>; etag: string | null }> {
  const { settings, secrets, client } = await resolveRuntime(masterPassword, allowDisabled);
  const latestKey = getCloudBackupObjectKeys(settings, 'restore').latest;
  try {
    if (isAliyunOssEndpoint(settings.endpoint)) {
      const index = await readOssIndex(settings, secrets);
      if (index.key) {
        try {
          const result = await client.send(new GetObjectCommand({ Bucket: settings.bucket, Key: index.key }));
          return { backupData: await unwrapCloudBackup<T>(JSON.parse(await readBodyAsText(result.Body)), secrets.cloudPassword), etag: ossCursor(index.position) };
        } catch (error) {
          if (isNotFound(error)) throw new Error('OSS 最新已提交备份缺失，已停止同步以保护本地数据', { cause: error });
          throw error;
        }
      }
      // Existing S3-format latest remains readable until the first index commit.
      const result = await client.send(new GetObjectCommand({ Bucket: settings.bucket, Key: latestKey }));
      return { backupData: await unwrapCloudBackup<T>(JSON.parse(await readBodyAsText(result.Body)), secrets.cloudPassword), etag: ossCursor(0) };
    }
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
  const { settings, secrets, client } = await resolveRuntime(masterPassword, true);
  try {
    const versions = await listVersionObjects(client, settings);
    const current = isAliyunOssEndpoint(settings.endpoint)
      ? (await readOssIndex(settings, secrets)).key : versions[0]?.key;
    return versions.map(version => ({ ...version, current: version.key === current }));
  } finally {
    client.destroy();
  }
}

/** Only explicit history keys may be deleted; never delete latest or the OSS index. */
export async function deleteCloudBackupVersions(keys: string[], masterPassword: string, beforeDelete?: () => Promise<void>) {
  const { settings, secrets, client } = await resolveRuntime(masterPassword, true);
  try {
    const uniqueKeys = [...new Set(keys)];
    uniqueKeys.forEach(key => assertHistoryKey(settings, key));
    const versions = await listVersionObjects(client, settings);
    const current = isAliyunOssEndpoint(settings.endpoint)
      ? (await readOssIndex(settings, secrets)).key : versions[0]?.key;
    if (uniqueKeys.includes(current || '')) throw new Error('当前同步版本不能删除，请先生成新的同步版本');
    const existing = new Set(versions.map(version => version.key));
    const failed: Array<{ key: string; error: string }> = [];
    let deleted = 0;
    for (const key of uniqueKeys) {
      if (!existing.has(key)) continue;
      try { await beforeDelete?.(); }
      catch (error) { failed.push({ key, error: error instanceof Error ? error.message : '清理权限已变更' }); break; }
      try {
        if (isAliyunOssEndpoint(settings.endpoint)) await requestOss(settings, secrets, 'DELETE', key);
        else {
          const result = await client.send(new DeleteObjectsCommand({ Bucket: settings.bucket,
            Delete: { Quiet: true, Objects: [{ Key: key }] } }));
          if (result.Errors?.length) throw new Error(result.Errors[0].Message || '删除云端历史失败');
        }
        deleted++;
      } catch (error) { failed.push({ key, error: error instanceof Error ? error.message : '删除失败' }); }
    }
    return { deleted, failed };
  } finally { client.destroy(); }
}

export async function downloadCloudBackupVersion<T extends BackupSecretLike>(
  key: string,
  masterPassword: string
): Promise<BackupData<T>> {
  const { settings, secrets, client } = await resolveRuntime(masterPassword, true);
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
    const { settings, secrets } = runtime;
    const ossIndex = isAliyunOssEndpoint(settings.endpoint) ? await readOssIndex(settings, secrets) : null;
    const versions = await listVersionObjects(client, settings);
    const protectedKeys = new Set([protectedKey, versions[0]?.key, ossIndex?.key].filter(Boolean));
    const cutoff = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000;
    const candidates = versions.filter((version, index) => {
      if (protectedKeys.has(version.key)) return false;
      // An uncommitted upload may still be waiting to append at the observed position.
      if (ossIndex && !ossIndex.committedKeys.has(version.key)) return false;
      const expired = version.lastModified
        ? Date.parse(version.lastModified) < cutoff
        : false;
      return index >= settings.retentionMaxVersions || expired;
    });

    for (let index = 0; index < candidates.length; index += 1000) {
      const chunk = candidates.slice(index, index + 1000);
      const result = ossIndex ? await (async () => {
        for (const version of chunk) await requestOss(settings, secrets, 'DELETE', version.key);
        return { Errors: [] };
      })() : await client.send(new DeleteObjectsCommand({
        Bucket: settings.bucket,
        Delete: { Quiet: true, Objects: chunk.map((version) => ({ Key: version.key })) }
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
