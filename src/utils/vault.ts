import CryptoUtils from './crypto';
import { assertSessionKey, requireSessionKey } from './session';
import { getBackupEncryptionSettings } from './backup';
import { normalizeOtpSettings, type OtpSettings } from './otp';

export interface VaultSecret extends OtpSettings {
  id: string;
  duplicateOf?: string;
  secret: string;
  site: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  importedAt?: string;
}

/** 日常验证码界面只接收账户信息，不接收 OTP 原始密钥。 */
export type OtpAccount = Pick<VaultSecret, 'id' | 'site' | 'name' | 'type' | 'digits' | 'period' | 'algorithm' | 'counter'>;

export function toOtpAccount({ id, site, name, type, digits, period, algorithm, counter }: OtpAccount): OtpAccount {
  return { id, site, name, type, digits, period, algorithm, counter };
}

interface DeviceOtpContext {
  key: string;
  revision: string;
  ciphertext: string;
}

interface DeviceOtpState {
  deviceOtpEnabled: boolean;
  deviceOtpKey: string | null;
  encryptedDeviceOtpSecrets: string | null;
  deviceOtpRevision: string | null;
}

/** 设备能力与主密码独立；主密码仍保护管理会话和可移植备份。 */
export async function prepareDeviceOtpState(secrets: VaultSecret[], revision: string, enabled?: boolean): Promise<DeviceOtpState> {
  const state = await chrome.storage.local.get<{ deviceOtpEnabled?: boolean; deviceOtpKey?: string }>(['deviceOtpEnabled', 'deviceOtpKey']);
  const deviceOtpEnabled = enabled ?? state.deviceOtpEnabled !== false;
  if (!deviceOtpEnabled) return { deviceOtpEnabled, deviceOtpKey: null, encryptedDeviceOtpSecrets: null, deviceOtpRevision: null };
  const deviceOtpKey = state.deviceOtpKey || CryptoUtils.arrayBufferToBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)).buffer);
  const records = secrets.map((entry) => ({ ...toOtpAccount(entry), secret: entry.secret }));
  return { deviceOtpEnabled, deviceOtpKey, deviceOtpRevision: revision,
    encryptedDeviceOtpSecrets: await CryptoUtils.encrypt(JSON.stringify(records), deviceOtpKey) };
}

export async function assertDeviceOtpAccess(context: DeviceOtpContext) {
  const state = await chrome.storage.local.get(['deviceOtpEnabled', 'deviceOtpKey', 'deviceOtpRevision', 'encryptedDeviceOtpSecrets', 'encryptedSecrets']);
  if (state.deviceOtpEnabled === false || state.deviceOtpKey !== context.key || state.deviceOtpRevision !== context.revision ||
      state.encryptedSecrets !== context.revision || state.encryptedDeviceOtpSecrets !== context.ciphertext) {
    throw new Error('验证码数据已变更，请重新操作');
  }
}

export async function readDeviceOtpVault() {
  const state = await chrome.storage.local.get(['deviceOtpEnabled', 'deviceOtpKey', 'deviceOtpRevision', 'encryptedDeviceOtpSecrets', 'encryptedSecrets', 'hotpCounters']);
  if (state.deviceOtpEnabled === false) throw new Error('验证码免密已关闭，请先解锁 OpenPass');
  if (typeof state.deviceOtpKey !== 'string' || typeof state.encryptedDeviceOtpSecrets !== 'string' ||
      typeof state.deviceOtpRevision !== 'string' || state.deviceOtpRevision !== state.encryptedSecrets) {
    throw new Error('请先用主密码解锁一次，完成验证码免密初始化');
  }
  const context = { key: state.deviceOtpKey, revision: state.deviceOtpRevision, ciphertext: state.encryptedDeviceOtpSecrets };
  const secrets = normalizeVaultSecrets(JSON.parse(await CryptoUtils.decrypt(context.ciphertext, context.key)));
  const adjusted = await applyHotpCounters(secrets, state.hotpCounters as Record<string, number> | undefined);
  await assertDeviceOtpAccess(context);
  return { secrets: adjusted.secrets, context };
}

/** 免密消费仅更新 OTP 副本和计数器账本，不取得主密码管理能力。 */
export async function writeDeviceOtpCounters(secrets: VaultSecret[], context: DeviceOtpContext) {
  await assertDeviceOtpAccess(context);
  const { hotpCounters } = await chrome.storage.local.get<{ hotpCounters?: Record<string, number> }>(['hotpCounters']);
  const adjusted = await applyHotpCounters(secrets, hotpCounters);
  const ciphertext = await CryptoUtils.encrypt(JSON.stringify(adjusted.secrets), context.key);
  await assertDeviceOtpAccess(context);
  await chrome.storage.local.set({ encryptedDeviceOtpSecrets: ciphertext, hotpCounters: adjusted.counters });
  return { ...context, ciphertext };
}

export function mergeHotpCounters(...ledgers: Array<Record<string, number> | undefined>) {
  const counters: Record<string, number> = {};
  for (const ledger of ledgers) for (const [id, value] of Object.entries(ledger ?? {})) {
    if (/^[a-f0-9]{64}$/.test(id) && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER) {
      counters[id] = Math.max(counters[id] ?? 0, value);
    }
  }
  return counters;
}

export async function applyHotpCounters(secrets: VaultSecret[], ledger?: Record<string, number>) {
  const counters = mergeHotpCounters(ledger);
  const ids = await Promise.all(secrets.map(async (entry) => entry.type !== 'hotp' ? null
    : Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(entry.secret))))
      .map((byte) => byte.toString(16).padStart(2, '0')).join('')));
  secrets.forEach((entry, index) => {
    const id = ids[index];
    if (id) counters[id] = Math.max(counters[id] ?? 0, entry.counter ?? 0);
  });
  return { secrets: secrets.map((entry, index) => ids[index] ? { ...entry, counter: counters[ids[index]!] } : entry), counters };
}

export function normalizeVaultSecrets(value: unknown): VaultSecret[] {
  if (!Array.isArray(value)) throw new Error('密钥数据格式无效');
  const ids = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.secret !== 'string' || typeof entry.site !== 'string') {
      throw new Error('密钥记录格式无效');
    }
    const secret = entry.secret.trim().toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z2-7]+=*$/.test(secret)) throw new Error('密钥不是有效的 Base32');
    const id = typeof entry.id === 'string' && entry.id ? entry.id : globalThis.crypto.randomUUID();
    if (ids.has(id)) throw new Error('密钥记录 ID 重复');
    ids.add(id);
    return { ...entry, ...normalizeOtpSettings(entry), id, secret, site: entry.site.trim().toLowerCase() };
  });
}

export async function readVault(key = undefined as string | undefined) {
  const sessionKey = key ?? await requireSessionKey();
  await assertSessionKey(sessionKey);
  const data = await chrome.storage.local.get<{ encryptedSecrets?: string; hotpCounters?: Record<string, number> }>(['encryptedSecrets', 'hotpCounters']);
  const secrets = data.encryptedSecrets
    ? normalizeVaultSecrets(JSON.parse(await CryptoUtils.decrypt(data.encryptedSecrets, sessionKey)))
    : [];
  const adjusted = await applyHotpCounters(secrets, data.hotpCounters);
  await assertSessionKey(sessionKey);
  return adjusted.secrets;
}

export async function writeVault(value: unknown, key: string, extra: Record<string, unknown> = {}) {
  await assertSessionKey(key);
  const { hotpCounters } = await chrome.storage.local.get<{ hotpCounters?: Record<string, number> }>(['hotpCounters']);
  const adjusted = await applyHotpCounters(normalizeVaultSecrets(value), mergeHotpCounters(hotpCounters, extra.hotpCounters as Record<string, number> | undefined));
  const secrets = adjusted.secrets;
  const encryptedSecrets = await CryptoUtils.encrypt(JSON.stringify(secrets), key);
  const settings = await getBackupEncryptionSettings();
  let encryptedSecretsForBackup: string | undefined;
  if (settings.enableBackupEncryption && !settings.useMasterPasswordForBackup && settings.encryptedBackupPassword) {
    const password = await CryptoUtils.decrypt(settings.encryptedBackupPassword, key);
    encryptedSecretsForBackup = await CryptoUtils.encrypt(JSON.stringify(secrets), password);
  }
  const deviceOtpState = await prepareDeviceOtpState(secrets, encryptedSecrets,
    typeof extra.deviceOtpEnabled === 'boolean' ? extra.deviceOtpEnabled : undefined);
  await assertSessionKey(key);
  await chrome.storage.local.set({
    ...extra, ...deviceOtpState, encryptedSecrets, hotpCounters: adjusted.counters,
    sitesList: secrets.map(({ id, site }) => ({ id, site })),
    ...(encryptedSecretsForBackup ? { encryptedSecretsForBackup } : {})
  });
  await chrome.storage.local.remove(['secrets', ...(encryptedSecretsForBackup ? [] : ['encryptedSecretsForBackup'])]);
  return secrets;
}

/** 仅在主密码验证成功后迁移；全部加密成功前不删除任何旧数据。 */
export async function migrateLegacyVault(password: string) {
  const data = await chrome.storage.local.get(['secrets', 'encryptedSecrets', 'pendingSecret', 'backupSnapshots', 'hotpCounters']);
  const updates: Record<string, unknown> = {};
  let migratedSecrets: VaultSecret[] | undefined;
  if (Array.isArray(data.secrets)) {
    const secrets = normalizeVaultSecrets(data.secrets);
    migratedSecrets = secrets;
  } else if (typeof data.encryptedSecrets === 'string') {
    // 确认密码能解密现有数据，避免迁移时把损坏的数据当作空数据覆盖。
    const secrets = normalizeVaultSecrets(JSON.parse(await CryptoUtils.decrypt(data.encryptedSecrets, password)));
    migratedSecrets = secrets;
  }
  if (migratedSecrets) {
    const adjusted = await applyHotpCounters(migratedSecrets, data.hotpCounters as Record<string, number> | undefined);
    updates.hotpCounters = adjusted.counters;
    updates.encryptedSecrets = await CryptoUtils.encrypt(JSON.stringify(adjusted.secrets), password);
    Object.assign(updates, await prepareDeviceOtpState(adjusted.secrets, updates.encryptedSecrets as string));
    updates.sitesList = adjusted.secrets.map(({ id, site }) => ({ id, site }));
    const settings = await getBackupEncryptionSettings();
    if (settings.enableBackupEncryption && !settings.useMasterPasswordForBackup && settings.encryptedBackupPassword) {
      const backupPassword = await CryptoUtils.decrypt(settings.encryptedBackupPassword, password);
      updates.encryptedSecretsForBackup = await CryptoUtils.encrypt(JSON.stringify(adjusted.secrets), backupPassword);
    }
  }
  if (data.pendingSecret) {
    updates.encryptedPendingSecret = await CryptoUtils.encrypt(JSON.stringify(data.pendingSecret), password);
  }
  if (Array.isArray(data.backupSnapshots)) {
    updates.backupSnapshots = await Promise.all(data.backupSnapshots.map(async (snapshot) => {
      if (!Array.isArray(snapshot.data?.secrets)) return snapshot;
      const { secrets, ...metadata } = snapshot.data;
      if (metadata.encrypted && typeof metadata.encryptedData === 'string') {
        return { ...snapshot, data: metadata };
      }
      return { ...snapshot, data: {
        ...metadata, encrypted: true, encryptionVersion: 1, kdf: 'PBKDF2', kdfIterations: 100000,
        encryptedData: await CryptoUtils.encrypt(JSON.stringify(secrets), password)
      } };
    }));
  }
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  await chrome.storage.local.remove(['secrets', 'pendingSecret']);
}
