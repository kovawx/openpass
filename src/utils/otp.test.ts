import { describe, expect, it } from 'vitest';
import { Secret } from 'otpauth';
import { generateOtp, normalizeOtpSettings } from './otp';

describe('OTP reference vectors', () => {
  const key = Secret.fromUTF8('12345678901234567890').base32;
  it('matches all ten RFC 4226 HOTP vectors without mutating preview settings', () => {
    const codes = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    codes.forEach((code, counter) => {
      const settings = { type: 'hotp' as const, counter };
      expect(generateOtp(key, settings).code).toBe(code);
      expect(settings.counter).toBe(counter);
    });
  });
  it.each([
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826']
  ])('matches RFC 6238 SHA1/SHA256/SHA512 at %s', (time, ...codes) => {
    const seeds = ['12345678901234567890', '12345678901234567890123456789012',
      '1234567890123456789012345678901234567890123456789012345678901234'];
    ['SHA1', 'SHA256', 'SHA512'].forEach((algorithm, index) => {
      expect(generateOtp(Secret.fromUTF8(seeds[index]).base32, { algorithm, digits: 8 }, Number(time) * 1000).code).toBe(codes[index]);
    });
  });
  it('uses a custom period and rejects unsupported parameters', () => {
    expect(generateOtp(key, { period: 60, digits: 8 }, 59000)).toMatchObject({ code: '84755224', remainingSeconds: 1 });
    for (const value of [{ period: 0 }, { counter: -1 }, { counter: 1.5 }, { digits: 7 }, { algorithm: 'MD5' }]) {
      expect(() => normalizeOtpSettings(value)).toThrow();
    }
  });
});
