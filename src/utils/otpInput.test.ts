import { describe, expect, it } from 'vitest';
import { classifyOtpInput, isOtpInput, isOtpSplitGroup, type OtpInputSignals } from './otpInput';

const classify = (signals: Partial<OtpInputSignals>) =>
  classifyOtpInput({ type: 'text', ...signals });
const matches = (signals: Partial<OtpInputSignals>) => isOtpInput({ type: 'text', ...signals });

describe('字段用途与代码来源', () => {
  it('泛验证码有代码用途，但不能说明来源', () => {
    expect(classify({ placeholder: '验证码' })).toMatchObject({ role: 'code', source: 'unknown' });
    expect(matches({ placeholder: '验证码' })).toBe(false);
    expect(classify({ autocomplete: 'one-time-code' })).toMatchObject({
      role: 'code',
      source: 'unknown'
    });
    expect(matches({ autocomplete: 'one-time-code' })).toBe(true);
    expect(matches({ name: 'otpCode', maxLength: 6 })).toBe(true);
  });

  it('MFA/2FA 表示认证流程，不证明使用 TOTP/HOTP', () => {
    expect(classify({ placeholder: '输入动态MFA码' }).source).toBe('unknown');
    expect(matches({ placeholder: 'MFA code' })).toBe(true);
    expect(matches({ placeholder: '输入动态MFA码', autocomplete: 'off' })).toBe(true);
    expect(matches({ placeholder: '2FA code', contextText: '短信验证码' })).toBe(false);
    expect(matches({ placeholder: 'MFA code', contextText: '从身份验证器获取验证码' })).toBe(true);
  });

  it.each<Partial<OtpInputSignals>>([
    { autocomplete: 'one-time-code' },
    { autocomplete: 'section-login ONE-TIME-CODE' },
    { type: 'password', autocomplete: 'one-time-code' },
    { name: 'otp', autocomplete: 'off' },
    { name: 'otp_attempt', autocomplete: 'off' },
    { name: 'passcode', maxLength: 6 },
    { placeholder: '验证码', maxLength: 6 },
    { labelText: '验证码', maxLength: 8 },
    { placeholder: 'Enter code', inputMode: 'numeric' },
    { placeholder: '验证码', pattern: '[0-9]{6}' },
    { placeholder: 'Verification code', pattern: '\\d{8}' },
    { placeholder: '验证码', pattern: '[0-9]*' },
    { placeholder: '验证码', isCodeStep: true },
    { placeholder: 'Enter code', contextText: 'Two-factor authentication' },
    { inputMode: 'numeric', maxLength: 6, contextText: 'MFA码' }
  ])('来源未知时保留有正向 OTP 证据的兼容路径：%j', (signals) => {
    expect(classify(signals).source).toBe('unknown');
    expect(matches(signals)).toBe(true);
  });

  it.each<Partial<OtpInputSignals>>([
    { placeholder: '验证码' },
    { placeholder: 'Enter code' },
    { placeholder: '验证码', maxLength: 4 },
    { placeholder: 'code', pattern: '[a-z]{6}' },
    { autocomplete: 'one-time-code', maxLength: 4 },
    { placeholder: 'MFA code', maxLength: 1 }
  ])('缺少兼容证据或无法容纳完整 OTP 的输入框保持不匹配：%j', (signals) => {
    expect(matches(signals)).toBe(false);
  });

  it.each<Partial<OtpInputSignals>>([
    { autocomplete: 'one-time-code', hasAdjacentImage: true },
    { placeholder: '验证码', maxLength: 6, hasAdjacentImage: true },
    { placeholder: 'MFA code', inputMode: 'numeric', hasAdjacentImage: true },
    { autocomplete: 'one-time-code', descriptionText: '短信验证码' },
    { name: 'otp', labelText: '邮箱验证码' },
    { placeholder: '验证码', isCodeStep: true, hasAdjacentImage: true }
  ])('兼容证据不能覆盖已知的其他来源：%j', (signals) => {
    expect(matches(signals)).toBe(false);
  });

  it.each<Partial<OtpInputSignals>>([
    { name: 'totpCode' },
    { id: 'TOTPInput' },
    { type: 'password', id: 'hotp_code' },
    { placeholder: 'Authenticator code' },
    { placeholder: '输入TOTP码' },
    { labelText: '身份验证器验证码' },
    { descriptionText: 'Enter the code from your authentication app', placeholder: 'Enter code' },
    { autocomplete: 'section-login one-time-code', contextText: 'Authenticator app' },
    { inputMode: 'numeric', maxLength: 6, contextText: '身份验证器' }
  ])('明确来源和代码用途共同支持识别：%j', (signals) => {
    expect(matches(signals)).toBe(true);
    expect(classify(signals)).toMatchObject({ role: 'code', source: 'authenticator' });
  });

  it.each<Partial<OtpInputSignals>>([
    { inputMode: 'numeric', maxLength: 6 },
    { type: 'tel', maxLength: 6 },
    { type: 'number', maxLength: 8 },
    { id: 'photopin', maxLength: 6 },
    { type: 'password', placeholder: '密码' },
    { autocomplete: 'username', contextText: 'Authenticator' },
    { autocomplete: 'current-password', placeholder: 'TOTP password' },
    { name: 'username', contextText: '身份验证器' },
    { labelText: 'Authenticator username' },
    { contextText: '身份验证器' },
    { type: 'email', placeholder: 'TOTP code' },
    { name: 'totp_secret', placeholder: 'TOTP Secret' },
    { placeholder: 'Authenticator', labelText: '身份验证器' },
    { placeholder: 'TOTP code', maxLength: 1 }
  ])('来源、形状或位数单独成立不能支持整码填充：%j', (signals) => {
    expect(matches(signals)).toBe(false);
  });

  it('标准普通字段属性不会因 code 文案和数字长度误匹配', () => {
    expect(
      classify({
        autocomplete: 'section-checkout shipping postal-code',
        placeholder: 'Postal code',
        inputMode: 'numeric',
        maxLength: 6
      }).role
    ).toBe('other');
    expect(
      matches({
        autocomplete: 'postal-code',
        placeholder: 'Postal code',
        inputMode: 'numeric',
        maxLength: 6
      })
    ).toBe(false);
    expect(matches({ autocomplete: 'cc-csc', placeholder: 'Security code', maxLength: 6 })).toBe(
      false
    );
    expect(
      isOtpSplitGroup(
        Array.from({ length: 6 }, () => ({
          type: 'text',
          maxLength: 1,
          autocomplete: 'postal-code',
          contextText: 'MFA code'
        }))
      )
    ).toBe(false);
  });

  it.each([
    ['image', { placeholder: '验证码', hasAdjacentImage: true }],
    ['image', { name: 'captcha', placeholder: '验证码' }],
    ['image', { labelText: '图片验证码' }],
    ['sms', { name: 'sms_code' }],
    ['email', { name: 'email_otp_code' }]
  ] as const)('识别其他代码来源：%s', (source, signals) => {
    expect(classify(signals)).toMatchObject({ role: 'code', source });
    expect(matches(signals)).toBe(false);
  });
});

describe('证据范围与冲突', () => {
  it('明确关联的说明可判断仅标注 OTP 的输入框', () => {
    expect(matches({ name: 'otp', descriptionText: 'Use your authenticator app' })).toBe(true);
    expect(matches({ name: 'otp', descriptionText: 'SMS verification code' })).toBe(false);
  });

  it('当前字段说明比附近的备用认证方式更具体', () => {
    expect(classify({ placeholder: 'TOTP code', contextText: 'Password or SMS code' }).source).toBe(
      'authenticator'
    );
    expect(matches({ placeholder: 'TOTP code', contextText: 'Password or SMS code' })).toBe(true);
    expect(
      classify({ placeholder: '验证码', labelText: '图片验证码', contextText: 'Authenticator' })
        .source
    ).toBe('image');
  });

  it('当前字段自身存在来源冲突时保持冲突，不用词语优先级强行选择', () => {
    expect(classify({ name: 'totp', labelText: '短信验证码' })).toMatchObject({
      source: 'conflict'
    });
    expect(matches({ name: 'totp', labelText: '短信验证码' })).toBe(false);
    expect(matches({ name: 'totp', descriptionText: '请输入图片验证码' })).toBe(false);
    expect(matches({ placeholder: '验证码', contextText: 'Authenticator or SMS code' })).toBe(
      false
    );
  });

  it('代码框内的图片与附近验证器文案冲突，不继承附近来源', () => {
    expect(
      classify({ placeholder: '验证码', hasAdjacentImage: true, contextText: 'Authenticator' })
        .source
    ).toBe('conflict');
    expect(
      matches({ placeholder: '验证码', hasAdjacentImage: true, contextText: 'Authenticator' })
    ).toBe(false);
  });
});

describe('分位验证码', () => {
  const inputs = (length: number, signals: Partial<OtpInputSignals> = {}): OtpInputSignals[] =>
    Array.from({ length }, () => ({ type: 'text', maxLength: 1, ...signals }));

  it('数量与形状不能证明代码来源', () => {
    expect(isOtpSplitGroup(inputs(6))).toBe(false);
    expect(isOtpSplitGroup(inputs(8, { placeholder: '验证码' }))).toBe(false);
    expect(isOtpSplitGroup(inputs(6, { contextText: 'MFA码' }))).toBe(true);
  });

  it('完整分位组结合标准 OTP、共享代码语义或数字模式可兼容识别', () => {
    expect(isOtpSplitGroup(inputs(6, { autocomplete: 'one-time-code' }))).toBe(true);
    expect(isOtpSplitGroup(inputs(8, { contextText: '验证码' }))).toBe(true);
    expect(isOtpSplitGroup(inputs(6, { inputMode: 'numeric' }))).toBe(true);
    expect(isOtpSplitGroup(inputs(6, { inputMode: 'numeric', hasAdjacentImage: true }))).toBe(
      false
    );
  });

  it('完整 6/8 位组可从共享说明获得验证器来源', () => {
    expect(isOtpSplitGroup(inputs(6, { contextText: '身份验证器' }))).toBe(true);
    expect(isOtpSplitGroup(inputs(8, { descriptionText: 'Authenticator app' }))).toBe(true);
  });

  it('一组内不能混入其他来源或密码框', () => {
    const group = inputs(6, { contextText: '身份验证器' });
    group[3].labelText = '图片验证码';
    expect(isOtpSplitGroup(group)).toBe(false);
    group[3] = { type: 'password', maxLength: 1, autocomplete: 'current-password' };
    expect(isOtpSplitGroup(group)).toBe(false);
  });

  it('不完整或混入整码框的分组不成立', () => {
    const group = inputs(6, { contextText: '身份验证器' });
    expect(isOtpSplitGroup(group.slice(0, 5))).toBe(false);
    group[5].maxLength = 6;
    expect(isOtpSplitGroup(group)).toBe(false);
  });
});
