import { createCipheriv, pbkdf2Sync, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthenticatorPasswordError, parseAuthenticatorImport } from './authenticatorImport';
import { classifyOtpQrInput, DEVICE_REGISTRATION_MESSAGE } from './otpQrInput';
import { migrationParts } from './fixtures/otpMigration';

const password = 'synthetic backup password';
const secret = 'JBSWY3DPEHPK3PXP';

function encrypt(plaintext: string | Buffer, key: Buffer, iv: Buffer) {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext) : plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

const aegisContent = { version: 3, groups: [{ uuid: 'work', name: 'Work' }], entries: [
  { type: 'hotp', name: 'alice', issuer: 'aegis.example', groups: ['work'], favorite: true,
    info: { secret, algo: 'SHA256', digits: 8, counter: 37 } },
  { type: 'steam', name: 'Steam demo', info: { secret } }
] };

const twoFasServices = [
  { name: 'Example', groupId: 'work', secret, otp: { issuer: '2fas.example', account: 'alice', tokenType: 'TOTP', algorithm: 'SHA512', period: 45 } },
  { name: 'Malformed without a secret', otp: {} }
];

describe('authenticator imports', () => {
  it('reads both plaintext and scrypt/AES-GCM Aegis exports with organization and skipped entries', async () => {
    const salt = Buffer.alloc(32, 1);
    const key = Buffer.alloc(32, 2);
    const n = 32768, r = 8, p = 1;
    const slotNonce = Buffer.alloc(12, 3), vaultNonce = Buffer.alloc(12, 4);
    const slot = encrypt(key, scryptSync(password, salt, 32, { N: n, r, p, maxmem: 64 * 1024 * 1024 }), slotNonce);
    const db = encrypt(JSON.stringify(aegisContent), key, vaultNonce);
    const encrypted = JSON.stringify({ version: 1, header: {
      slots: [{ type: 1, n, r, p, salt: salt.toString('hex'), key: slot.ciphertext.toString('hex'),
        key_params: { nonce: slotNonce.toString('hex'), tag: slot.tag.toString('hex') } }],
      params: { nonce: vaultNonce.toString('hex'), tag: db.tag.toString('hex') }
    }, db: db.ciphertext.toString('base64') });
    const expected = await parseAuthenticatorImport(JSON.stringify({ version: 1, header: {}, db: aegisContent }));
    await expect(parseAuthenticatorImport(encrypted)).rejects.toBeInstanceOf(AuthenticatorPasswordError);
    await expect(parseAuthenticatorImport(encrypted, 'wrong')).rejects.toBeInstanceOf(AuthenticatorPasswordError);
    expect(await parseAuthenticatorImport(encrypted, password)).toEqual(expected);
    expect(expected).toMatchObject({ source: 'Aegis', accounts: [
      { name: 'aegis.example · alice', site: 'aegis.example', type: 'hotp', algorithm: 'SHA256', digits: 8, counter: 37,
        group: 'Work', favorite: true }
    ], omitted: [{ name: 'Steam demo' }] });
  });

  it('reads 2FAS v4 files with and without PBKDF2/AES-GCM protection', async () => {
    const salt = Buffer.alloc(256, 17), iv = Buffer.alloc(12, 19);
    const key = pbkdf2Sync(password, salt, 10000, 32, 'sha256');
    const data = encrypt(JSON.stringify(twoFasServices), key, iv);
    const header = { schemaVersion: 4, groups: [{ id: 'work', name: 'Work' }] };
    const encrypted = JSON.stringify({ ...header, services: [],
      servicesEncrypted: [Buffer.concat([data.ciphertext, data.tag]), salt, iv].map(part => part.toString('base64')).join(':') });
    const expected = await parseAuthenticatorImport(JSON.stringify({ ...header, services: twoFasServices }));
    await expect(parseAuthenticatorImport(encrypted, 'wrong')).rejects.toBeInstanceOf(AuthenticatorPasswordError);
    expect(await parseAuthenticatorImport(encrypted, password)).toEqual(expected);
    expect(expected).toMatchObject({ source: '2FAS', accounts: [
      { name: 'Example · alice', site: '2fas.example', type: 'totp', algorithm: 'SHA512', digits: 6, period: 45, group: 'Work' }
    ], omitted: [{ name: 'Malformed without a secret' }] });
  });

  it('accepts mixed OTPAuth and migration codes while keeping incomplete Google batches pending', async () => {
    const uri = 'otpauth://totp/demo?issuer=demo.example&secret=JBSWY3DPEHPK3PXP';
    expect(await parseAuthenticatorImport(uri + '\n' + migrationParts[0])).toMatchObject({ missingImages: 1, accounts: [
      { type: 'totp' }, { site: 'demo.example', type: 'totp' }
    ] });
    expect((await parseAuthenticatorImport(uri + '\n' + migrationParts.join('\n'))).accounts).toHaveLength(3);
  });

  it('recognizes device registration without exposing its data or treating a Microsoft OTP as a device code', async () => {
    const registration = 'phonefactor://activate_account?code=fixture-only';
    expect(classifyOtpQrInput(registration)).toEqual({ kind: 'device-registration' });
    await expect(parseAuthenticatorImport(registration)).rejects.toThrow(DEVICE_REGISTRATION_MESSAGE);
    expect(classifyOtpQrInput('otpauth://totp/demo?issuer=Microsoft&secret=JBSWY3DPEHPK3PXP')?.kind).toBe('account');
  });
});
