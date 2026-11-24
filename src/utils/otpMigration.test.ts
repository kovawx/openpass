import { describe, expect, it } from 'vitest';
import { migrationLink, migrationParts } from './fixtures/otpMigration';
import { parseOtpMigration } from './otpMigration';

describe('Google Authenticator migration', () => {
  it('decodes all accounts, preserving Unicode names and OTP settings', () => {
    const result = parseOtpMigration(decodeURIComponent(migrationLink));
    expect(result.missingImages).toBe(0);
    expect(result.accounts).toEqual([
      { name: 'Google · Alice', site: '', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', type: 'totp',
        algorithm: 'SHA1', digits: 6, period: 30, counter: 0 },
      { name: 'example.test · 示例:alice@example.test', site: 'example.test', secret: '7PX76YLCMNSDCMRTGQ2TMNY', type: 'hotp',
        algorithm: 'SHA512', digits: 8, period: 30, counter: 42 }
    ]);
  });

  it('waits for missing batch parts and accepts all distinct parts in any order', () => {
    const [first, second] = migrationParts;
    expect(parseOtpMigration(second)).toMatchObject({ missingImages: 1, accounts: [{ counter: 42 }] });
    expect(parseOtpMigration(`${second}\n${first}\n${decodeURIComponent(first)}`)).toMatchObject({
      missingImages: 0, accounts: [{ type: 'hotp' }, { type: 'totp' }]
    });
  });

  it('rejects invalid data and unsupported algorithms without exposing any keys', () => {
    expect(() => parseOtpMigration('otpauth-migration://offline?data=INVALID%21')).toThrow('编码无效');
    expect(() => parseOtpMigration('otpauth-migration://offline?data=Cjw%3D')).toThrow('数据不完整');
    const md5 = 'otpauth-migration://offline?data=Ci0KFDEyMzQ1Njc4OTAxMjM0NTY3ODkwEgVBbGljZRoGR29vZ2xlIAQoATACOAAQAhgB';
    expect(() => parseOtpMigration(md5)).toThrow('不支持的 OTP');
  });
});
