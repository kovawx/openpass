import { parseOtpAuth, type ParsedOtpAuth } from './otpAuth';
import { isMigrationLink } from './otpMigration';

export const DEVICE_REGISTRATION_MESSAGE = '这是 Microsoft Authenticator 设备注册二维码，请在微软应用中完成绑定。若网站提供验证码方式，请使用该方式的绑定二维码。';

export function isDeviceRegistration(value: string) {
  if (/^phonefactor:\/\//i.test(value.trim())) return true;
  if (!/^https:\/\//i.test(value.trim())) return false;
  try {
    const url = new URL(value);
    return url.hostname === 'mobileappcommunicator.auth.microsoft.com' && /^\/activate(?:v2)?\//i.test(url.pathname);
  } catch { return false; }
}

export type OtpQrInput =
  | { kind: 'account'; account: ParsedOtpAuth }
  | { kind: 'migration'; link: string }
  | { kind: 'device-registration' };

export function classifyOtpQrInput(text: string): OtpQrInput | null {
  if (isMigrationLink(text)) return { kind: 'migration', link: text.trim() };
  if (isDeviceRegistration(text)) return { kind: 'device-registration' };
  const account = parseOtpAuth(text);
  return account ? { kind: 'account', account } : null;
}
