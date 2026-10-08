export interface OtpInputSignals {
  type: string;
  name?: string;
  id?: string;
  placeholder?: string;
  autocomplete?: string;
  ariaLabel?: string;
  inputMode?: string;
  maxLength?: number;
  contextText?: string;
}

const KEYWORDS = [
  'otp',
  'totp',
  '2fa',
  'mfa',
  'auth',
  'verification',
  'verify',
  'code',
  'pin',
  'token',
  'one-time',
  'onetime',
  '验证码',
  '动态码',
  '安全码',
  '一次性密码'
] as const;

const STRONG_KEYWORDS = [
  'otp',
  'totp',
  '2fa',
  'mfa',
  'one-time',
  'onetime',
  '验证码',
  '动态码',
  '一次性密码'
] as const;

const EXCLUDE_KEYWORDS = ['password', 'passwd', 'pwd', '密码'] as const;
const TARGET_LENGTHS = [6, 8] as const;
const SPLIT_MAX_LENGTH = 2;

function normalize(value?: string): string {
  return (value || '').toLowerCase();
}

/**
 * 根据输入框属性和周边文本判断其是否为 OTP/MFA 输入。
 * 这里不依赖 DOM，便于对第三方登录页的具体标记做回归测试。
 */
export function isOtpInput(signals: OtpInputSignals): boolean {
  const type = normalize(signals.type);
  if (!['text', 'tel', 'number', 'password'].includes(type)) {
    return false;
  }

  const autocomplete = normalize(signals.autocomplete);
  const inputMode = normalize(signals.inputMode);
  const directText = [
    signals.name,
    signals.id,
    signals.placeholder,
    autocomplete,
    signals.ariaLabel
  ]
    .map(normalize)
    .join(' ');
  const contextText = normalize(signals.contextText);
  const allText = `${directText} ${contextText}`;
  const lengthMatch = TARGET_LENGTHS.some((length) => length === signals.maxLength);
  const numericMode =
    inputMode === 'numeric' ||
    inputMode === 'tel' ||
    type === 'tel' ||
    type === 'number';

  // 标准 autocomplete 和输入框自身的明确 OTP/MFA 描述都是直接强信号。
  if (autocomplete.includes('one-time-code') || autocomplete.includes('otp')) {
    return true;
  }
  if (STRONG_KEYWORDS.some((keyword) => directText.includes(keyword))) {
    return true;
  }

  // 周边可能同时包含登录页的密码文案，不应覆盖上面的输入框直接强信号。
  if (EXCLUDE_KEYWORDS.some((keyword) => allText.includes(keyword))) {
    return false;
  }

  if (numericMode && lengthMatch) {
    return true;
  }

  const contextStrongMatch = STRONG_KEYWORDS.some((keyword) => contextText.includes(keyword));
  if (contextStrongMatch && (numericMode || lengthMatch)) {
    return true;
  }

  return KEYWORDS.some((keyword) => allText.includes(keyword)) && lengthMatch;
}

/**
 * 分位验证码经常只声明 maxlength=1，没有 inputmode 或 pattern。
 * 单个短输入框只作为分组候选，不会单独被认定为 OTP。
 */
export function isPotentialSplitOtpInput(signals: OtpInputSignals): boolean {
  const type = normalize(signals.type);
  const maxLength = signals.maxLength || 0;
  return (
    ['text', 'tel', 'number', 'password'].includes(type) &&
    maxLength >= 1 &&
    maxLength <= SPLIT_MAX_LENGTH
  );
}

/** 只有正好 6/8 个短输入框才能组成一组分位 OTP。 */
export function isOtpSplitGroup(inputs: OtpInputSignals[]): boolean {
  return (
    TARGET_LENGTHS.some((length) => length === inputs.length) &&
    inputs.every(isPotentialSplitOtpInput)
  );
}
