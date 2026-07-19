import { parseOtpAuth } from './otpAuth';

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
  async generateCode(secret: string, digits: number = 6): Promise<{
    code: string;
    remainingSeconds: number;
  }> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'generateCode', secret, digits },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response?.error) {
            reject(new Error(response.error));
            return;
          }
          resolve({
            code: response.code,
            remainingSeconds: response.remainingSeconds
          });
        }
      );
    });
  }

  /**
   * 格式化验证码（每 3 位加空格）
   */
  formatCode(code: string): string {
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
  parseOTPAuthUrl(data: string): {
    secret: string;
    site: string;
    name: string;
  } | null {
    return parseOtpAuth(data);
  }
}

export const TOTP = new TOTPUtils();
export default TOTP;
