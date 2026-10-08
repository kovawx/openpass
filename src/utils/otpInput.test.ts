import { describe, expect, it } from 'vitest';
import { isOtpInput, isOtpSplitGroup, isPotentialSplitOtpInput } from './otpInput';

describe('isOtpInput', () => {
  it('识别 autocomplete=off 且没有 maxlength 的动态 MFA 输入框', () => {
    expect(
      isOtpInput({
        type: 'text',
        placeholder: '输入动态MFA码',
        autocomplete: 'off',
        ariaLabel: 'Large',
        maxLength: 0,
        contextText: 'MFA码'
      })
    ).toBe(true);
  });

  it('输入框自身的 MFA 强信号不会被周边密码文案覆盖', () => {
    expect(
      isOtpInput({
        type: 'text',
        placeholder: 'MFA code',
        contextText: 'Password MFA code'
      })
    ).toBe(true);
  });

  it('周边的 MFA 语义需要数字模式或长度约束', () => {
    expect(isOtpInput({ type: 'text', contextText: 'MFA码' })).toBe(false);
    expect(isOtpInput({ type: 'text', inputMode: 'numeric', contextText: 'MFA码' })).toBe(true);
  });

  it('不会把普通密码或无长度约束的泛 code 输入当作 OTP', () => {
    expect(isOtpInput({ type: 'password', placeholder: '输入密码' })).toBe(false);
    expect(isOtpInput({ type: 'text', placeholder: 'Enter code' })).toBe(false);
  });

  it('允许无数字属性的单字符输入参与分位 OTP 分组', () => {
    const input = { type: 'text', autocomplete: 'off', maxLength: 1 };

    expect(isPotentialSplitOtpInput(input)).toBe(true);
    expect(isOtpSplitGroup(Array.from({ length: 6 }, () => ({ ...input })))).toBe(true);
    expect(isOtpSplitGroup(Array.from({ length: 8 }, () => ({ ...input })))).toBe(true);
  });

  it('不会把数量不对或包含长输入框的组当作分位 OTP', () => {
    const inputs = Array.from({ length: 6 }, () => ({ type: 'text', maxLength: 1 }));

    expect(isOtpSplitGroup(inputs.slice(0, 5))).toBe(false);
    expect(isOtpSplitGroup([...inputs.slice(0, 5), { type: 'text', maxLength: 4 }])).toBe(false);
  });
});
