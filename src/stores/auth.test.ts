import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import CryptoUtils from '@/utils/crypto';
import { getValidSessionKey } from '@/utils/session';
import { useAuthStore } from './auth';

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
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
beforeEach(async () => {
  setActivePinia(createPinia()); local.clear(); session.clear(); observed.length = 0; observeSessionWrites = false;
  const verifier = await CryptoUtils.createMasterPasswordHash('correct-password');
  local.set('masterPasswordHash', verifier.hash); local.set('masterPasswordSalt', verifier.salt);
  vi.stubGlobal('chrome', { storage: { local: area(local), session: area(session) },
    runtime: { sendMessage: vi.fn().mockResolvedValue({ success: true }) } });
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
});
