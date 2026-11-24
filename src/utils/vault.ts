import CryptoUtils, { type VaultKey } from './crypto';
import { assertSessionKey, decryptSessionData, getSessionVaultKey, getValidSessionKey, requireSessionKey } from './session';
import { encryptDailyVault, hasDailyWriteKey, prepareDailyWriteKeys, retainDailyWriteKeys } from './deviceVaultWrite';
import { encryptedBackupFields, getBackupEncryptionSettings } from './backup';
import { normalizeOtpSettings, type OtpSettings } from './otp';
import { normalizeAccountOrganization, type AccountOrganization } from './accountOrganization';

export interface VaultSecret extends OtpSettings, AccountOrganization {
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
export type OtpAccount = Pick<VaultSecret, 'id' | 'site' | 'name' | 'type' | 'digits' | 'period' | 'algorithm' | 'counter' | 'group' | 'favorite'>;

export function toOtpAccount(account: OtpAccount): OtpAccount {
  const { id, site, name, type, digits, period, algorithm, counter } = account;
  return { id, site, name, type, digits, period, algorithm, counter, ...normalizeAccountOrganization(account) };
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
  // Daily append must preserve the complete existing records, including sync
  // timestamps. Only the background reads this copy; UI replies stay redacted.
  const records = secrets.map((entry) => ({ ...entry }));
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
    return { ...entry, ...normalizeOtpSettings(entry), ...normalizeAccountOrganization(entry), id, secret, site: entry.site.trim().toLowerCase() };
  });
}

export async function readVault(key = undefined as string | undefined) {
  const sessionKey = key ?? await requireSessionKey();
  await assertSessionKey(sessionKey);
  const data = await chrome.storage.local.get<{ encryptedSecrets?: string; hotpCounters?: Record<string, number> }>(['encryptedSecrets', 'hotpCounters']);
  const ciphertext = data.encryptedSecrets;
  let secrets: VaultSecret[] = [];
  if (ciphertext) {
    const plaintext = CryptoUtils.isVaultCiphertext(ciphertext)
      ? await CryptoUtils.decryptVault(ciphertext, await requireVaultKey(sessionKey))
      : await CryptoUtils.decrypt(ciphertext, sessionKey);
    secrets = normalizeVaultSecrets(JSON.parse(plaintext));
  }
  const adjusted = await applyHotpCounters(secrets, data.hotpCounters);
  await assertSessionKey(sessionKey);
  return adjusted.secrets;
}

async function requireVaultKey(password: string) {
  const key = await getSessionVaultKey(password);
  if (!key) throw new Error('请重新输入主密码解锁密钥库');
  return key;
}

export async function writeVault(value: unknown, key: string, extra: Record<string, unknown> = {}) {
  await assertSessionKey(key);
  const { encryptedSecrets: currentCiphertext, hotpCounters } = await chrome.storage.local.get<{
    encryptedSecrets?: string; hotpCounters?: Record<string, number>
  }>(['encryptedSecrets', 'hotpCounters']);
  const adjusted = await applyHotpCounters(normalizeVaultSecrets(value), mergeHotpCounters(hotpCounters, extra.hotpCounters as Record<string, number> | undefined));
  const secrets = adjusted.secrets;
  const vaultKey = currentCiphertext && CryptoUtils.isVaultCiphertext(currentCiphertext) ? await requireVaultKey(key) : undefined;
  if (vaultKey && currentCiphertext && !CryptoUtils.matchesVaultKey(currentCiphertext, vaultKey)) throw new Error('密钥库已变更，请重新解锁');
  const payload = JSON.stringify(secrets);
  const encryptedSecrets = vaultKey ? await CryptoUtils.encryptVault(payload, vaultKey) : await CryptoUtils.encrypt(payload, key);
  const settings = await getBackupEncryptionSettings();
  let encryptedSecretsForBackup: string | undefined;
  let backupPassword: string | undefined;
  if (settings.enableBackupEncryption && !settings.useMasterPasswordForBackup && settings.encryptedBackupPassword) {
    backupPassword = await decryptSessionData(settings.encryptedBackupPassword, key);
    encryptedSecretsForBackup = await CryptoUtils.encrypt(payload, backupPassword);
  }
  const deviceOtpState = await prepareDeviceOtpState(secrets, encryptedSecrets,
    typeof extra.deviceOtpEnabled === 'boolean' ? extra.deviceOtpEnabled : undefined);
  if (deviceOtpState.deviceOtpEnabled) {
    const entries = [];
    if (!vaultKey || !await hasDailyWriteKey(encryptedSecrets)) {
      entries.push({ ciphertext: encryptedSecrets, password: key, vaultKey });
    }
    if (encryptedSecretsForBackup && backupPassword !== undefined) {
      entries.push({ ciphertext: encryptedSecretsForBackup, password: backupPassword });
    }
    if (entries.length) await prepareDailyWriteKeys(entries);
  }
  await assertSessionKey(key);
  await chrome.storage.local.set({
    ...extra, ...deviceOtpState, encryptedSecrets, hotpCounters: adjusted.counters,
    sitesList: secrets.map(({ id, site }) => ({ id, site })),
    ...(encryptedSecretsForBackup ? { encryptedSecretsForBackup } : {})
  });
  await chrome.storage.local.remove(['secrets', ...(encryptedSecretsForBackup ? [] : ['encryptedSecretsForBackup'])]);
  await retainDailyWriteKeys(deviceOtpState.deviceOtpEnabled
    ? [encryptedSecrets, ...(encryptedSecretsForBackup ? [encryptedSecretsForBackup] : [])] : [])
    .catch(error => console.warn('OpenPass: 清理旧免密添加能力失败', error));
  return secrets;
}

/** Only append a server-assigned account; never accept replacement records or settings. */
export async function appendVaultAccount(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('新增账户格式无效');
  const input = value as Record<string, unknown>;
  if (typeof input.secret !== 'string' || typeof input.site !== 'string' || !input.site.trim()) {
    throw new Error('请输入有效密钥和目标站点');
  }
  const timestamp = new Date().toISOString();
  const [entry] = normalizeVaultSecrets([{
    id: globalThis.crypto.randomUUID(), secret: input.secret, site: input.site,
    name: typeof input.name === 'string' ? input.name : '',
    group: typeof input.group === 'string' ? input.group : '',
    ...normalizeOtpSettings(input), createdAt: timestamp, updatedAt: timestamp
  }]);
  const key = await getValidSessionKey();
  if (key) return writeVault([...(await readVault(key)), entry], key);

  const { secrets, context } = await readDeviceOtpVault();
  const previous = await chrome.storage.local.get<{
    encryptedSecretsForBackup?: string; hotpCounters?: Record<string, number>
  }>(['encryptedSecretsForBackup', 'hotpCounters']);
  const adjusted = await applyHotpCounters([...secrets, entry], previous.hotpCounters);
  const plaintext = JSON.stringify(adjusted.secrets);
  const encryptedSecrets = await encryptDailyVault(plaintext, context.revision);
  const settings = await getBackupEncryptionSettings();
  let encryptedSecretsForBackup: string | undefined;
  if (settings.enableBackupEncryption && !settings.useMasterPasswordForBackup && settings.encryptedBackupPassword) {
    if (!previous.encryptedSecretsForBackup) throw new Error('请先解锁一次以初始化独立密码备份');
    encryptedSecretsForBackup = await encryptDailyVault(plaintext, previous.encryptedSecretsForBackup);
  }
  const encryptedDeviceOtpSecrets = await CryptoUtils.encrypt(plaintext, context.key);
  await assertDeviceOtpAccess(context);
  if (JSON.stringify(await getBackupEncryptionSettings()) !== JSON.stringify(settings)) {
    throw new Error('备份设置已变更，请重新添加');
  }
  await chrome.storage.local.set({
    encryptedSecrets, deviceOtpRevision: encryptedSecrets, encryptedDeviceOtpSecrets,
    hotpCounters: adjusted.counters, sitesList: adjusted.secrets.map(({ id, site }) => ({ id, site })),
    ...(encryptedSecretsForBackup ? { encryptedSecretsForBackup } : {})
  });
  return adjusted.secrets;
}

export class VaultAuthenticationError extends Error {}

/** Rewrap the local fields protected by the master password, including recoverable snapshots. */
export async function rekeyMasterData(state: Record<string, unknown>, password: string, newKey: VaultKey, oldKey?: VaultKey) {
  const updates: Record<string, unknown> = {};
  const open = (ciphertext: string) => oldKey && CryptoUtils.matchesVaultKey(ciphertext, oldKey)
    ? CryptoUtils.decryptVault(ciphertext, oldKey) : CryptoUtils.decrypt(ciphertext, password);
  for (const field of ['encryptedBackupPassword', 'encryptedCloudBackupSecrets', 'encryptedPendingSecret']) {
    const ciphertext = state[field];
    if (typeof ciphertext === 'string') updates[field] = await CryptoUtils.encryptVault(await open(ciphertext), newKey);
  }
  if (Array.isArray(state.backupSnapshots)) {
    updates.backupSnapshots = await Promise.all(state.backupSnapshots.map(async snapshot => {
      if (!snapshot?.data) return snapshot;
      const { secrets, ...metadata } = snapshot.data;
      let plaintext: string;
      if (metadata.encrypted && typeof metadata.encryptedData === 'string') {
        try { plaintext = await open(metadata.encryptedData); }
        catch { return { ...snapshot, data: metadata }; } // Preserve independent-password and historical snapshots.
      } else if (Array.isArray(secrets)) {
        plaintext = JSON.stringify(secrets);
      } else return snapshot;
      return { ...snapshot, data: { ...metadata, ...encryptedBackupFields(await CryptoUtils.encryptVault(plaintext, newKey)) } };
    }));
  }
  return updates;
}

/** Authenticate before publishing any session. Replace legacy state in one storage commit. */
export async function migrateLegacyVault(password: string, initialize = false) {
  const [data, settings] = await Promise.all([
    chrome.storage.local.get(['secrets', 'encryptedSecrets', 'pendingSecret', 'backupSnapshots', 'hotpCounters', 'sitesList',
      'deviceOtpEnabled', 'deviceOtpRevision', 'deviceOtpKey', 'encryptedDeviceOtpSecrets', 'encryptedSecretsForBackup',
      'masterPasswordHash', 'masterPasswordSalt', 'isSetupComplete',
      'encryptedBackupPassword', 'encryptedCloudBackupSecrets', 'encryptedPendingSecret']),
    getBackupEncryptionSettings()
  ]);
  const ciphertext = data.encryptedSecrets;
  const hasLegacyRecords = Array.isArray(data.secrets) && data.secrets.length > 0;
  if (initialize && (ciphertext != null || data.masterPasswordHash || data.isSetupComplete || hasLegacyRecords)) {
    throw new Error('主密码已设置，请解锁现有密钥库');
  }
  let records: unknown = data.secrets ?? [];
  let vaultKey: VaultKey | undefined;
  if (typeof ciphertext === 'string') {
    let plaintext: string;
    try {
      if (CryptoUtils.isVaultCiphertext(ciphertext)) {
        ({ key: vaultKey, plaintext } = await CryptoUtils.openVault(ciphertext, password));
      } else {
        plaintext = await CryptoUtils.decrypt(ciphertext, password);
      }
    } catch (error) {
      if ((error as Error).name === 'OperationError') throw new VaultAuthenticationError('主密码错误或密钥库校验失败');
      throw error;
    }
    records = JSON.parse(plaintext);
  } else if (ciphertext != null) {
    throw new Error('密钥库密文格式无效');
  } else if (!initialize) {
    // Profiles from before encrypted vaults have only a standalone verifier.
    if (typeof data.masterPasswordHash !== 'string' || typeof data.masterPasswordSalt !== 'string') {
      throw new Error('缺少可验证的密钥库，请检查备份');
    }
    if (!await CryptoUtils.verifyMasterPassword(password, data.masterPasswordHash, data.masterPasswordSalt)) {
      throw new VaultAuthenticationError('主密码错误');
    }
  }

  const secrets = normalizeVaultSecrets(records);
  const migrating = !vaultKey;
  vaultKey ??= await CryptoUtils.deriveVaultKey(password);
  const independentBackup = settings.enableBackupEncryption && !settings.useMasterPasswordForBackup && settings.encryptedBackupPassword;
  const enabled = data.deviceOtpEnabled !== false;
  const [deviceReady, backupReady] = await Promise.all([
    !enabled || (!migrating && data.deviceOtpRevision === ciphertext && typeof data.deviceOtpKey === 'string' &&
      typeof data.encryptedDeviceOtpSecrets === 'string' && hasDailyWriteKey(ciphertext as string)),
    !independentBackup || (typeof data.encryptedSecretsForBackup === 'string' &&
      (!enabled || hasDailyWriteKey(data.encryptedSecretsForBackup).catch(() => false)))
  ]);
  const sites = data.sitesList;
  const indexReady = Array.isArray(sites) && sites.length === secrets.length &&
    secrets.every((entry, index) => sites[index]?.id === entry.id && sites[index]?.site === entry.site);
  const ledger = data.hotpCounters as Record<string, number> | undefined;
  const adjusted = secrets.some(entry => entry.type === 'hotp') ? await applyHotpCounters(secrets, ledger) : null;
  const countersChanged = adjusted?.secrets.some((entry, index) => entry.counter !== secrets[index].counter);
  const updates = migrating ? await rekeyMasterData(data, password, vaultKey) : {};
  if (migrating || !deviceReady || !backupReady || !indexReady || countersChanged || data.pendingSecret) {
    const current = adjusted ?? { secrets, counters: mergeHotpCounters(ledger) };
    const payload = JSON.stringify(current.secrets);
    const sealed = await CryptoUtils.encryptVault(payload, vaultKey);
    Object.assign(updates, await prepareDeviceOtpState(current.secrets, sealed), {
      encryptedSecrets: sealed, hotpCounters: current.counters,
      sitesList: current.secrets.map(({ id, site }) => ({ id, site }))
    });
    let backupCiphertext = typeof data.encryptedSecretsForBackup === 'string' ? data.encryptedSecretsForBackup : undefined;
    if (independentBackup && (migrating || !backupReady || countersChanged)) {
      const wrapped = typeof updates.encryptedBackupPassword === 'string' ? updates.encryptedBackupPassword : independentBackup;
      const backupPassword = CryptoUtils.matchesVaultKey(wrapped, vaultKey)
        ? await CryptoUtils.decryptVault(wrapped, vaultKey) : await CryptoUtils.decrypt(wrapped, password);
      backupCiphertext = await CryptoUtils.encrypt(payload, backupPassword);
      updates.encryptedSecretsForBackup = backupCiphertext;
      if (enabled) await prepareDailyWriteKeys([{ ciphertext: backupCiphertext, password: backupPassword }]);
    }
    if (enabled && !deviceReady) await prepareDailyWriteKeys([{ ciphertext: sealed, password, vaultKey }]);
    if (migrating) Object.assign(updates, { masterPasswordHash: null, masterPasswordSalt: null, isSetupComplete: true });
    if (data.pendingSecret) updates.encryptedPendingSecret = await CryptoUtils.encryptVault(JSON.stringify(data.pendingSecret), vaultKey);
    if (data.secrets !== undefined) updates.secrets = null;
    if (data.pendingSecret !== undefined) updates.pendingSecret = null;
    await chrome.storage.local.set(updates);
    if (data.secrets !== undefined || data.pendingSecret !== undefined) await chrome.storage.local.remove(['secrets', 'pendingSecret']);
    await retainDailyWriteKeys(enabled ? [sealed, ...(backupCiphertext ? [backupCiphertext] : [])] : [])
      .catch(error => console.warn('OpenPass: 清理旧免密添加能力失败', error));
  }
  return vaultKey;
}
