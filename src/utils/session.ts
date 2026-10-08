export const SESSION_TIMEOUT = 15 * 60 * 1000;
export const SESSION_ALARM = 'openpass-session-expiry';

export async function clearSessionStorage() {
  await chrome.storage.session.remove(['sessionKey', 'pendingSecret']);
  await chrome.storage.local.remove(['sessionExpiresAt']);
}

export async function getValidSessionKey(): Promise<string | null> {
  const [local, session] = await Promise.all([
    chrome.storage.local.get<{ sessionExpiresAt?: number }>(['sessionExpiresAt']),
    chrome.storage.session.get<{ sessionKey?: string }>(['sessionKey'])
  ]);
  if (
    typeof session.sessionKey !== 'string' || !session.sessionKey ||
    typeof local.sessionExpiresAt !== 'number' || !Number.isFinite(local.sessionExpiresAt) ||
    local.sessionExpiresAt <= Date.now()
  ) {
    if (session.sessionKey || local.sessionExpiresAt) await clearSessionStorage();
    return null;
  }
  return session.sessionKey;
}

export async function requireSessionKey() {
  const key = await getValidSessionKey();
  if (!key) throw new Error('会话已锁定，请先解锁 OpenPass');
  return key;
}

export async function assertSessionKey(key: string) {
  if (await requireSessionKey() !== key) throw new Error('会话已变更，请重新操作');
}
