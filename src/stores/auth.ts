import { defineStore } from 'pinia';
import { ref } from 'vue';
import CryptoUtils from '@/utils/crypto';
import { getValidSessionKey, clearSessionStorage, SESSION_TIMEOUT } from '@/utils/session';

export interface SessionData {
  sessionKey: string | null;
  expiresAt: number | null;
}

export const useAuthStore = defineStore('auth', () => {
  const sessionKey = ref<string | null>(null);
  const expiresAt = ref<number | null>(null);
  const isAuthenticated = ref(false);
  const authAttempts = ref(0);
  const authLockedUntil = ref<number | null>(null);

  const MAX_ATTEMPTS = 5;
  const LOCK_DURATION = 5 * 60 * 1000; // 5 minutes
  let unlockTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;

  function clearUnlockTimer() {
    if (unlockTimer) {
      clearTimeout(unlockTimer);
      unlockTimer = null;
    }
  }

  async function clearAuthLock() {
    clearUnlockTimer();
    authAttempts.value = 0;
    authLockedUntil.value = null;
    await chrome.storage.local.remove(['authAttempts', 'authLockedUntil']);
  }

  function scheduleUnlock() {
    clearUnlockTimer();
    if (!authLockedUntil.value) {
      return;
    }

    const delay = authLockedUntil.value - Date.now();
    if (delay <= 0) {
      void clearAuthLock();
      return;
    }

    unlockTimer = setTimeout(() => {
      void clearAuthLock();
    }, delay);
  }

  function hasActiveLock() {
    return typeof authLockedUntil.value === 'number' && authLockedUntil.value > Date.now();
  }

  function applySession(nextSessionKey: string | null, nextExpiresAt: number | null) {
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = nextSessionKey && nextExpiresAt
      ? setTimeout(() => { void checkSession(); }, Math.max(0, nextExpiresAt - Date.now()))
      : null;
    sessionKey.value = nextSessionKey;
    expiresAt.value = nextExpiresAt;
    isAuthenticated.value = !!nextSessionKey && !!nextExpiresAt;
  }

  async function checkSession(): Promise<boolean> {
    const key = await getValidSessionKey();
    const result = await chrome.storage.local.get<{ sessionExpiresAt?: number }>(['sessionExpiresAt']);
    applySession(key, key ? result.sessionExpiresAt ?? null : null);
    return !!key;
  }

  async function init() {
    try {
      const result = await chrome.storage.local.get<{
        authAttempts?: number;
        authLockedUntil?: number;
      }>(['authAttempts', 'authLockedUntil']);
      authAttempts.value = typeof result.authAttempts === 'number' ? result.authAttempts : 0;
      authLockedUntil.value =
        typeof result.authLockedUntil === 'number' ? result.authLockedUntil : null;

      if (hasActiveLock()) {
        scheduleUnlock();
      } else if (authAttempts.value >= MAX_ATTEMPTS || authLockedUntil.value !== null) {
        await clearAuthLock();
      }

      await checkSession();
    } catch (error) {
      console.error('Failed to initialize auth:', error);
      applySession(null, null);
      authAttempts.value = 0;
      authLockedUntil.value = null;
      clearUnlockTimer();
    }
  }

  async function login(password: string): Promise<boolean> {
    if (hasActiveLock()) {
      return false;
    }

    const result = await chrome.storage.local.get<{
      masterPasswordHash?: string;
      masterPasswordSalt?: string;
    }>(['masterPasswordHash', 'masterPasswordSalt']);
    if (!result.masterPasswordHash || !result.masterPasswordSalt) {
      throw new Error('系统错误，请重新设置');
    }

    const isValid = await CryptoUtils.verifyMasterPassword(
      password,
      result.masterPasswordHash,
      result.masterPasswordSalt
    );

    if (isValid) {
      if (!result.masterPasswordHash.startsWith('pbkdf2-sha256$')) {
        const upgraded = await CryptoUtils.createMasterPasswordHash(password);
        await chrome.storage.local.set({ masterPasswordHash: upgraded.hash, masterPasswordSalt: upgraded.salt });
      }
      await createSession(password);
      await clearAuthLock();
      return true;
    }

    authAttempts.value++;

    if (authAttempts.value >= MAX_ATTEMPTS) {
      authLockedUntil.value = Date.now() + LOCK_DURATION;
      scheduleUnlock();
    }

    await chrome.storage.local.set({
      authAttempts: authAttempts.value,
      authLockedUntil: authLockedUntil.value
    });
    return false;
  }

  async function createSession(password: string) {
    const migration = await chrome.runtime.sendMessage({ action: 'migrateVaultForUnlock', password });
    if (migration?.error || !migration?.success) throw new Error(migration?.error || '解锁迁移失败');
    const nextExpiresAt = Date.now() + SESSION_TIMEOUT;

    await chrome.storage.session.set({ sessionKey: password });
    await chrome.storage.local.set({ sessionExpiresAt: nextExpiresAt });
    applySession(password, nextExpiresAt);

    // 通知 background 缓存 sessionKey（用于自动备份）
    try {
      await chrome.runtime.sendMessage({ action: 'sessionChanged' });
    } catch (error) {
      console.warn('Failed to cache session key in background:', error);
    }
  }

  async function clearSession() {
    applySession(null, null);

    await clearSessionStorage();

    // 通知 background 清除缓存的 sessionKey
    try {
      await chrome.runtime.sendMessage({ action: 'sessionChanged' });
    } catch {
      // Ignore errors
    }
  }

  async function updateActivity() {
    if (await checkSession()) {
      const nextExpiresAt = Date.now() + SESSION_TIMEOUT;
      applySession(sessionKey.value, nextExpiresAt);
      await chrome.storage.local.set({ sessionExpiresAt: nextExpiresAt });
    }
  }

  function getRemainingAttempts() {
    if (hasActiveLock()) {
      return 0;
    }
    return Math.max(0, MAX_ATTEMPTS - authAttempts.value);
  }

  function isLocked() {
    return hasActiveLock();
  }

  return {
    sessionKey,
    expiresAt,
    isAuthenticated,
    authAttempts,
    authLockedUntil,
    init,
    checkSession,
    login,
    createSession,
    clearSession,
    updateActivity,
    getRemainingAttempts,
    isLocked
  };
});
