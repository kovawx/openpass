import { parseOtpAuth } from './otpAuth';
import type { OtpAccount } from './vault';
import type { OtpSettings } from './otp';

/**
 * TOTP (Time-based One-Time Password) 生成工具
 * 基于 RFC 6238 实现
 */

class TOTPUtils {
  /**
   * 验证密钥格式是否有效
   * Base32 编码，至少 16 个字符
   */
  isValidSecret(secret: string): boolean {
    const cleaned = secret.toUpperCase().replace(/\s/g, '');
    return /^[A-Z2-7]+=*$/.test(cleaned) && cleaned.length >= 16;
  }

  /**
   * 生成 TOTP 验证码
   * 调用 background service worker 生成（需要访问 totp.js 库）
   */
  async generateCode(secret: string | OtpAccount, digits = 6, options: OtpSettings = {}, consume = false): Promise<{
    code: string; remainingSeconds: number; period: number; type: 'totp' | 'hotp'; counter: number;
  }> {
    const request = typeof secret === 'string'
      ? { action: 'generateCode', secret, digits, ...options }
      : { action: consume ? 'consumeCode' : 'generateCode', id: secret.id };
    const response = await chrome.runtime.sendMessage(request);
    if (response?.error) throw new Error(response.error);
    if (!response?.code) throw new Error('无法生成验证码');
    return response;
  }

  /**
   * 格式化验证码（每 3 位加空格）
   */
  formatCode(code: string): string {
    if (code?.length === 8) return code.slice(0, 4) + ' ' + code.slice(4);
    if (!code || code.length !== 6) return code;
    return code.slice(0, 3) + ' ' + code.slice(3);
  }

  /**
   * 复制文本到剪贴板
   */
  async copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
  }

  /**
   * 解析 otpauth:// URL
   */
  parseOTPAuthUrl(data: string) {
    return parseOtpAuth(data);
  }
}

export const TOTP = new TOTPUtils();
export default TOTP;
