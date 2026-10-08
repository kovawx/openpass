import { HOTP, TOTP } from 'otpauth';

export interface OtpSettings {
  type?: 'totp' | 'hotp';
  digits?: number;
  algorithm?: string;
  period?: number;
  counter?: number;
}

export function normalizeOtpSettings(value: OtpSettings) {
  const type = value.type ?? 'totp';
  const algorithm = (value.algorithm ?? 'SHA1').toUpperCase().replace(/-/g, '');
  const digits = value.digits ?? 6;
  const period = value.period ?? 30;
  const counter = value.counter ?? 0;
  if (type !== 'totp' && type !== 'hotp') throw new Error('不支持的 OTP 类型');
  if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm)) throw new Error('不支持的 OTP 算法');
  if (digits !== 6 && digits !== 8) throw new Error('验证码仅支持 6 位或 8 位');
  if (!Number.isSafeInteger(period) || period < 1 || period > 3600) throw new Error('周期须为 1～3600 秒');
  if (!Number.isSafeInteger(counter) || counter < 0 || counter >= Number.MAX_SAFE_INTEGER) {
    throw new Error('HOTP 计数器无效');
  }
  return { type, algorithm, digits, period, counter };
}

export function generateOtp(secret: string, settings: OtpSettings, timestamp = Date.now()) {
  const options = normalizeOtpSettings(settings);
  const code = options.type === 'hotp'
    ? new HOTP({ secret, ...options }).generate({ counter: options.counter })
    : new TOTP({ secret, ...options }).generate({ timestamp });
  return {
    code,
    type: options.type,
    period: options.period,
    counter: options.counter,
    remainingSeconds: options.type === 'hotp' ? 0 : options.period - Math.floor(timestamp / 1000) % options.period
  };
}
