interface BackupSecretLike {
  site?: string;
  secret?: string;
  digits?: number;
  createdAt?: string;
  importedAt?: string;
}

export interface SecretTombstone {
  id: string;
  deletedAt: string;
  deviceId: string;
}

export interface BackupSyncMetadata {
  version: 1;
  deviceId: string;
  tombstones: SecretTombstone[];
}

export interface SyncSecretLike extends BackupSecretLike {
  id: string;
  updatedAt?: string;
}

export interface SyncMergeResult<T extends SyncSecretLike> {
  secrets: T[];
  tombstones: SecretTombstone[];
  changed: boolean;
}

function buildSecretIdentity(secret: BackupSecretLike) {
  return `${String(secret.site || '').trim().toLowerCase()}::${String(secret.secret || '')
    .trim()
    .toUpperCase()}`;
}

function timestamp(value?: string) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getSecretTimestamp(secret: SyncSecretLike) {
  return Math.max(
    timestamp(secret.updatedAt),
    timestamp(secret.createdAt),
    timestamp(secret.importedAt)
  );
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableValue(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function chooseSecret<T extends SyncSecretLike>(left: T | undefined, right: T): T {
  if (!left) return right;
  const timeDiff = getSecretTimestamp(right) - getSecretTimestamp(left);
  if (timeDiff !== 0) return timeDiff > 0 ? right : left;
  return stableValue(right) > stableValue(left) ? right : left;
}

function chooseTombstone(
  left: SecretTombstone | undefined,
  right: SecretTombstone
): SecretTombstone {
  if (!left) return right;
  const timeDiff = timestamp(right.deletedAt) - timestamp(left.deletedAt);
  if (timeDiff !== 0) return timeDiff > 0 ? right : left;
  return right.deviceId > left.deviceId ? right : left;
}

function comparableState<T extends SyncSecretLike>(secrets: T[], tombstones: SecretTombstone[]) {
  return stableValue({
    secrets: [...secrets].sort((left, right) => left.id.localeCompare(right.id)),
    tombstones: [...tombstones].sort((left, right) => left.id.localeCompare(right.id))
  });
}

export function mergeSyncState<T extends SyncSecretLike>(
  localSecrets: T[],
  localTombstones: SecretTombstone[],
  remoteSecrets: T[],
  remoteTombstones: SecretTombstone[]
): SyncMergeResult<T> {
  const secretsById = new Map<string, T>();
  const tombstonesById = new Map<string, SecretTombstone>();

  for (const secret of [...localSecrets, ...remoteSecrets]) {
    if (!secret.id) continue;
    secretsById.set(secret.id, chooseSecret(secretsById.get(secret.id), secret));
  }
  for (const tombstone of [...localTombstones, ...remoteTombstones]) {
    if (!tombstone.id) continue;
    tombstonesById.set(
      tombstone.id,
      chooseTombstone(tombstonesById.get(tombstone.id), tombstone)
    );
  }

  const surviving = [...secretsById.values()].filter((secret) => {
    const tombstone = tombstonesById.get(secret.id);
    return !tombstone || timestamp(tombstone.deletedAt) < getSecretTimestamp(secret);
  });

  // Older imports may have generated different IDs for the same TOTP secret. Keep the newest
  // equivalent record so devices converge instead of displaying duplicates.
  const byIdentity = new Map<string, T>();
  for (const secret of surviving) {
    const identity = buildSecretIdentity(secret);
    byIdentity.set(identity, chooseSecret(byIdentity.get(identity), secret));
  }

  const secrets = [...byIdentity.values()].sort((left, right) => left.id.localeCompare(right.id));
  const tombstones = [...tombstonesById.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  return {
    secrets,
    tombstones,
    changed:
      comparableState(localSecrets, localTombstones) !== comparableState(secrets, tombstones)
  };
}

export async function getOrCreateSyncDeviceId() {
  const result = await chrome.storage.local.get<{ syncDeviceId?: string }>(['syncDeviceId']);
  if (result.syncDeviceId) return result.syncDeviceId;
  const syncDeviceId = crypto.randomUUID();
  await chrome.storage.local.set({ syncDeviceId });
  return syncDeviceId;
}

export async function loadSecretTombstones() {
  const result = await chrome.storage.local.get<{ secretTombstones?: SecretTombstone[] }>([
    'secretTombstones'
  ]);
  return Array.isArray(result.secretTombstones) ? result.secretTombstones : [];
}

export async function recordSecretDeletion(id: string) {
  return recordSecretDeletions([id]);
}

export async function recordSecretDeletions(ids: string[]) {
  const [deviceId, tombstones] = await Promise.all([
    getOrCreateSyncDeviceId(),
    loadSecretTombstones()
  ]);
  const deletedIds = new Set(ids.filter(Boolean));
  const next = tombstones.filter((entry) => !deletedIds.has(entry.id));
  const deletedAt = new Date().toISOString();
  for (const id of deletedIds) next.push({ id, deviceId, deletedAt });
  await chrome.storage.local.set({ secretTombstones: next });
  return next;
}

export async function getBackupSyncMetadata(): Promise<BackupSyncMetadata> {
  const [deviceId, tombstones] = await Promise.all([
    getOrCreateSyncDeviceId(),
    loadSecretTombstones()
  ]);
  return { version: 1, deviceId, tombstones };
}
