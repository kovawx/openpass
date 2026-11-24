import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { getValidSessionKey, publishVaultSession } from '@/utils/session';
import { useAuthStore } from './auth';

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
const sendMessage = vi.fn<(request: { action: string; password?: string }) => Promise<Record<string, unknown>>>();
let observeSessionWrites = false;
const observed: Array<string | null> = [];
function area(values: Map<string, unknown>) {
  return {
    get: async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, values.get(key)])),
    set: async (updates: Record<string, unknown>) => {
      Object.entries(updates).forEach(([key, value]) => values.set(key, value));
      // Model a content script reacting to storage.onChanged before the login page continues.
      if (values === session && observeSessionWrites && updates.sessionKey) observed.push(await getValidSessionKey());
    },
    remove: async (keys: string[]) => { keys.forEach((key) => values.delete(key)); }
  };
}
beforeEach(() => {
  setActivePinia(createPinia()); local.clear(); session.clear(); observed.length = 0; observeSessionWrites = false;
  sendMessage.mockReset().mockImplementation(async request => {
    if (request.password) await publishVaultSession(request.password, { salt: 'fixture', value: 'fixture' });
    return { success: true };
  });
  vi.stubGlobal('chrome', { storage: { local: area(local), session: area(session) },
    runtime: { sendMessage } });
});
afterEach(async () => { await useAuthStore().clearSession(); vi.unstubAllGlobals(); });

describe('management unlock publication', () => {
  it('publishes a complete valid session before other extension pages can observe it', async () => {
    observeSessionWrites = true;
    expect(await useAuthStore().login('correct-password')).toBe(true);
    expect(observed).toEqual(['correct-password']);
    expect(await getValidSessionKey()).toBe('correct-password');
    expect(await useAuthStore().checkSession()).toBe(true);
  });

  it('counts only rejected passwords and never opens a session on a migration failure', async () => {
    sendMessage.mockResolvedValueOnce({ error: '主密码错误', incorrectPassword: true })
      .mockResolvedValueOnce({ error: '密钥库无法解密' });
    expect(await useAuthStore().login('wrong-password')).toBe(false);
    expect(useAuthStore().getRemainingAttempts()).toBe(4);
    await expect(useAuthStore().login('correct-password')).rejects.toThrow('密钥库无法解密');
    expect(useAuthStore().getRemainingAttempts()).toBe(4);
    expect(session.has('sessionKey')).toBe(false);
  });
});
