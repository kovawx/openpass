export const SESSION_TIMEOUT = 15 * 60 * 1000;
export const SESSION_ALARM = 'openpass-session-expiry';

export interface ActiveSession {
  key: string;
  expiresAt: number;
  vaultKey?: VaultKey;
}

export async function clearSessionStorage(clearDailyDraft = true) {
  await chrome.storage.session.remove(['sessionKey', 'sessionExpiresAt', 'vaultSessionKey', 'pendingSecret', ...(clearDailyDraft ? ['pendingQrDraft', 'pendingOtpImport'] : [])]);
  await chrome.storage.local.remove(['sessionExpiresAt']);
}

export async function getValidSession(): Promise<ActiveSession | null> {
  const [local, session] = await Promise.all([
    chrome.storage.local.get<{ sessionExpiresAt?: number }>(['sessionExpiresAt']),
    chrome.storage.session.get<{ sessionKey?: string; sessionExpiresAt?: number; vaultSessionKey?: VaultKey }>(['sessionKey', 'sessionExpiresAt', 'vaultSessionKey'])
  ]);
  // 新会话在 session 中一次发布密钥和到期时间；local 字段仅兼容旧会话及界面通知。
  const expiresAt = session.sessionExpiresAt === undefined ? local.sessionExpiresAt : session.sessionExpiresAt;
  if (
    typeof session.sessionKey !== 'string' || !session.sessionKey ||
    typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()
  ) {
    if (session.sessionKey || expiresAt || session.vaultSessionKey) {
      // 读取过程中可能已有页面完成解锁，不清除这次读取之后发布的新会话。
      const latest = await chrome.storage.session.get(['sessionKey', 'sessionExpiresAt']);
      if (latest.sessionKey !== session.sessionKey || latest.sessionExpiresAt !== session.sessionExpiresAt) return getValidSession();
      await clearSessionStorage(false);
    }
    return null;
  }
  return { key: session.sessionKey, expiresAt, ...(session.vaultSessionKey ? { vaultKey: session.vaultSessionKey } : {}) };
}

export async function publishVaultSession(password: string, key: VaultKey) {
  const expiresAt = Date.now() + SESSION_TIMEOUT;
  await chrome.storage.session.set({ sessionKey: password, sessionExpiresAt: expiresAt, vaultSessionKey: key });
  await chrome.storage.local.set({ sessionExpiresAt: expiresAt });
}

export async function getSessionVaultKey(password: string) {
  if (!chrome.storage.session) return undefined;
  const session = await getValidSession();
  return session?.key === password ? session.vaultKey : undefined;
}

export async function encryptSessionData(plaintext: string, password: string) {
  const key = await getSessionVaultKey(password);
  return key ? CryptoUtils.encryptVault(plaintext, key) : CryptoUtils.encrypt(plaintext, password);
}

export async function decryptSessionData(ciphertext: string, password: string) {
  const key = CryptoUtils.isVaultCiphertext(ciphertext) ? await getSessionVaultKey(password) : undefined;
  return key && CryptoUtils.matchesVaultKey(ciphertext, key)
    ? CryptoUtils.decryptVault(ciphertext, key) : CryptoUtils.decrypt(ciphertext, password);
}

export async function getValidSessionKey(): Promise<string | null> {
  return (await getValidSession())?.key ?? null;
}

export async function requireSessionKey() {
  const key = await getValidSessionKey();
  if (!key) throw new Error('会话已锁定，请先解锁 OpenPass');
  return key;
}

export async function assertSessionKey(key: string) {
  if (await requireSessionKey() !== key) throw new Error('会话已变更，请重新操作');
}
import CryptoUtils, { type VaultKey } from './crypto';
