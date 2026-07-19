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
      digits: 8
    });
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
