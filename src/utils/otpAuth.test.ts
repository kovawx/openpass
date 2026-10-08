import { describe, expect, it } from 'vitest';
import { parseOtpAuth } from './otpAuth';

describe('parseOtpAuth', () => {
  it('parses a TOTP URI and preserves supported digit count', () => {
    expect(
      parseOtpAuth(
        'otpauth://totp/GitHub:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8'
      )
    ).toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      site: 'github',
      name: 'GitHub',
      digits: 8, type: 'totp', algorithm: 'SHA1', period: 30, counter: 0
    });
  });

  it('preserves HOTP counters and TOTP algorithms and periods', () => {
    expect(parseOtpAuth('otpauth://hotp/Test?secret=JBSWY3DPEHPK3PXP&counter=42&algorithm=SHA256&digits=8'))
      .toMatchObject({ type: 'hotp', counter: 42, algorithm: 'SHA256', digits: 8 });
    expect(parseOtpAuth('otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&algorithm=SHA512&period=60'))
      .toMatchObject({ type: 'totp', algorithm: 'SHA512', period: 60 });
    expect(parseOtpAuth('otpauth://hotp/Test?secret=JBSWY3DPEHPK3PXP&counter=-1')).toBeNull();
    expect(parseOtpAuth('otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&period=0')).toBeNull();
  });

  it('uses the label issuer when the issuer parameter is absent', () => {
    expect(parseOtpAuth('otpauth://totp/Example:alice?secret=JBSW-Y3DP-EHPK-3PXP')).toMatchObject({
      site: 'example',
      name: 'Example'
    });
  });

  it('accepts normalized Base32 and rejects HOTP or invalid secrets', () => {
    expect(parseOtpAuth('jbsw y3dp ehpk 3pxp')?.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(parseOtpAuth('otpauth://hotp/test?secret=JBSWY3DPEHPK3PXP')).toBeNull();
    expect(parseOtpAuth('otpauth://totp/test?secret=INVALID018')).toBeNull();
  });
});
