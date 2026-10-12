import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSessionStorage, getValidSession, getValidSessionKey } from './session';

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
const snapshot = (values: Map<string, unknown>, keys: string[]) => Object.fromEntries(keys.map(key => [key, values.get(key)]));
const sessionGet = vi.fn(async (keys: string[]) => snapshot(session, keys));
beforeEach(() => {
  local.clear(); session.clear(); sessionGet.mockReset();
  sessionGet.mockImplementation(async keys => snapshot(session, keys));
  vi.stubGlobal('chrome', { storage: {
    local: { get: async (keys: string[]) => snapshot(local, keys), remove: async (keys: string[]) => keys.forEach(key => local.delete(key)) },
    session: { get: sessionGet, remove: async (keys: string[]) => keys.forEach(key => session.delete(key)) }
  } });
});
afterEach(() => vi.unstubAllGlobals());

describe('session expiry authority', () => {
  it('reads an atomically published session even before the local expiry mirror exists', async () => {
    const expiresAt = Date.now() + 60000;
    session.set('sessionKey', 'password'); session.set('sessionExpiresAt', expiresAt);
    expect(await getValidSession()).toEqual({ key: 'password', expiresAt });
    local.set('sessionExpiresAt', Date.now() - 1);
    expect(await getValidSessionKey()).toBe('password');
  });
  it('continues to accept an existing legacy session', async () => {
    session.set('sessionKey', 'legacy'); local.set('sessionExpiresAt', Date.now() + 60000);
    expect(await getValidSessionKey()).toBe('legacy');
  });
  it('rejects expired canonical sessions even when the local mirror has a later time', async () => {
    session.set('sessionKey', 'expired'); session.set('sessionExpiresAt', Date.now() - 1);
    local.set('sessionExpiresAt', Date.now() + 60000);
    session.set('pendingSecret', { secret: 'fixture' });
    expect(await getValidSessionKey()).toBeNull();
    expect(session.size).toBe(0); expect(local.has('sessionExpiresAt')).toBe(false);
  });
  it('does not clear a newly published session when an old expired read completes late', async () => {
    session.set('sessionKey', 'old'); local.set('sessionExpiresAt', Date.now() - 1);
    sessionGet.mockImplementationOnce(async keys => {
      const old = snapshot(session, keys);
      session.set('sessionKey', 'new'); session.set('sessionExpiresAt', Date.now() + 60000);
      return old;
    });
    expect(await getValidSessionKey()).toBe('new');
    expect(session.get('sessionKey')).toBe('new');
  });
  it('explicit logout removes the canonical session and pending imports', async () => {
    session.set('sessionKey', 'password'); session.set('sessionExpiresAt', Date.now() + 60000);
    session.set('pendingSecret', { secret: 'fixture' }); local.set('sessionExpiresAt', Date.now() + 60000);
    await clearSessionStorage();
    expect(session.size).toBe(0); expect(local.size).toBe(0);
  });
});
