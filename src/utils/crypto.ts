/**
 * OpenPass - 加密工具模块
 * 使用 Web Crypto API 实现 AES-GCM 加密
 */

class CryptoUtils {
  static toArrayBuffer(buffer: ArrayBufferLike): ArrayBuffer {
    if (buffer instanceof ArrayBuffer) {
      return buffer;
    }

    return Uint8Array.from(new Uint8Array(buffer)).buffer;
  }

  static normalizeBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const normalizedBuffer = this
      .toArrayBuffer(bytes.buffer)
      .slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    return new Uint8Array(normalizedBuffer);
  }

  /**
   * 从密码派生密钥
   * 使用 PBKDF2 算法
   */
  static async deriveKey(password: string, salt: Uint8Array) {
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);
    const normalizedSalt = this.normalizeBytes(salt);

    const baseKey = await globalThis.crypto.subtle.importKey(
      'raw',
      passwordBuffer,
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return globalThis.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: normalizedSalt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * 加密数据
   */
  static async encrypt(plaintext: string, password: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);

    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));

    const key = await this.deriveKey(password, salt);

    const encrypted = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      data
    );

    const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(encrypted), salt.length + iv.length);

    return this.arrayBufferToBase64(combined.buffer);
  }

  /**
   * 解密数据
   */
  static async decrypt(ciphertext: string, password: string): Promise<string> {
    const decoder = new TextDecoder();
    const combined = new Uint8Array(this.base64ToArrayBuffer(ciphertext));

    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const encrypted = combined.slice(28);

    const key = await this.deriveKey(password, salt);

    const decrypted = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      encrypted
    );

    return decoder.decode(decrypted);
  }

  /**
   * 计算密码哈希（用于验证）
   */
  static async hashPassword(password: string, salt: Uint8Array) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + this.arrayBufferToBase64(this.toArrayBuffer(salt.buffer)));

    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
    return this.arrayBufferToBase64(hashBuffer);
  }

  /**
   * 生成随机 salt
   */
  static generateSalt(): string {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return this.arrayBufferToBase64(salt.buffer);
  }

  /**
   * 验证主密码
   */
  static async verifyMasterPassword(
    password: string,
    storedHash: string,
    salt: string
  ): Promise<boolean> {
    const saltBuffer = this.base64ToArrayBuffer(salt);
    const hash = storedHash.startsWith('pbkdf2-sha256$')
      ? await this.derivePasswordVerifier(password, new Uint8Array(saltBuffer))
      : await this.hashPassword(password, new Uint8Array(saltBuffer));
    return hash === storedHash;
  }

  static async derivePasswordVerifier(password: string, salt: Uint8Array) {
    const key = await globalThis.crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const hash = await globalThis.crypto.subtle.deriveBits({
      name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: this.normalizeBytes(salt)
    }, key, 256);
    return `pbkdf2-sha256$600000$${this.arrayBufferToBase64(hash)}`;
  }

  /**
   * 创建主密码哈希
   */
  static async createMasterPasswordHash(password: string) {
    const salt = this.generateSalt();
    const saltBuffer = this.base64ToArrayBuffer(salt);
    const hash = await this.derivePasswordVerifier(password, new Uint8Array(saltBuffer));
    return { hash, salt };
  }

  /**
   * ArrayBuffer 转 Base64
   */
  static arrayBufferToBase64(buffer: ArrayBufferLike): string {
    const bytes = new Uint8Array(this.toArrayBuffer(buffer));
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Base64 转 ArrayBuffer
   */
  static base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return this.toArrayBuffer(bytes.buffer);
  }
}

export default CryptoUtils;
