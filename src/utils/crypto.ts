/**
 * OpenPass - 加密工具模块
 * 使用 Web Crypto API 实现 AES-GCM 加密
 */

const VAULT_PREFIX = 'openpass-v2:';
// Keep KDF parameters fixed per envelope version so old backups remain readable.
export const VAULT_KDF_ITERATIONS = 300000;
export const LEGACY_KDF_ITERATIONS = 100000;
const vaultHeader = new TextEncoder().encode(VAULT_PREFIX);

export interface VaultKey {
  salt: string;
  value: string;
}

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
  static async deriveKey(password: string, salt: Uint8Array, usages: KeyUsage[] = ['encrypt', 'decrypt']) {
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
        iterations: LEGACY_KDF_ITERATIONS,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      usages
    );
  }

  /**
   * 加密数据
   */
  static async encrypt(plaintext: string, password: string): Promise<string> {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const key = await this.deriveKey(password, salt);
    return this.seal(plaintext, key, salt, false);
  }

  static async seal(plaintext: string, key: CryptoKey, salt: Uint8Array<ArrayBuffer>, vaultFormat: boolean) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, ...(vaultFormat ? { additionalData: vaultHeader } : {}) },
      key,
      new TextEncoder().encode(plaintext)
    );

    const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(encrypted), salt.length + iv.length);

    return (vaultFormat ? VAULT_PREFIX : '') + this.arrayBufferToBase64(combined.buffer);
  }

  /**
   * 解密数据
   */
  static async decrypt(ciphertext: string, password: string): Promise<string> {
    if (this.isVaultCiphertext(ciphertext)) return (await this.openVault(ciphertext, password)).plaintext;
    const envelope = this.readCiphertext(ciphertext);
    return this.open(envelope, await this.deriveKey(password, envelope.salt));
  }

  static isVaultCiphertext(ciphertext: string) {
    return ciphertext.startsWith(VAULT_PREFIX);
  }

  static readCiphertext(ciphertext: string) {
    const vaultFormat = this.isVaultCiphertext(ciphertext);
    const combined = new Uint8Array(this.base64ToArrayBuffer(vaultFormat ? ciphertext.slice(VAULT_PREFIX.length) : ciphertext));
    if (combined.length < 44) throw new Error('密文格式无效');
    return { salt: combined.slice(0, 16), iv: combined.slice(16, 28), encrypted: combined.slice(28), vaultFormat };
  }

  static async deriveVaultKey(password: string, salt = this.generateSalt()): Promise<VaultKey> {
    const key = await globalThis.crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await globalThis.crypto.subtle.deriveBits({
      name: 'PBKDF2', hash: 'SHA-256', iterations: VAULT_KDF_ITERATIONS, salt: this.base64ToArrayBuffer(salt)
    }, key, 256);
    return { salt, value: this.arrayBufferToBase64(bits) };
  }

  static importVaultKey(key: VaultKey, usages: KeyUsage[]) {
    return globalThis.crypto.subtle.importKey('raw', this.base64ToArrayBuffer(key.value), 'AES-GCM', false, usages);
  }

  static async openVault(ciphertext: string, password: string) {
    const envelope = this.readCiphertext(ciphertext);
    if (!envelope.vaultFormat) throw new Error('密钥库密文格式无效');
    const key = await this.deriveVaultKey(password, this.arrayBufferToBase64(envelope.salt.buffer));
    return { key, plaintext: await this.open(envelope, await this.importVaultKey(key, ['decrypt'])) };
  }

  static async encryptVault(plaintext: string, key: VaultKey) {
    return this.seal(plaintext, await this.importVaultKey(key, ['encrypt']), new Uint8Array(this.base64ToArrayBuffer(key.salt)), true);
  }

  static matchesVaultKey(ciphertext: string, key: VaultKey) {
    return this.isVaultCiphertext(ciphertext) && this.arrayBufferToBase64(this.readCiphertext(ciphertext).salt.buffer) === key.salt;
  }

  static async decryptVault(ciphertext: string, key: VaultKey) {
    const envelope = this.readCiphertext(ciphertext);
    if (!envelope.vaultFormat || this.arrayBufferToBase64(envelope.salt.buffer) !== key.salt) throw new Error('密钥库已变更，请重新解锁');
    return this.open(envelope, await this.importVaultKey(key, ['decrypt']));
  }

  private static async open({ iv, encrypted, vaultFormat }: ReturnType<typeof CryptoUtils.readCiphertext>, key: CryptoKey) {
    const decrypted = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, ...(vaultFormat ? { additionalData: vaultHeader } : {}) },
      key,
      encrypted
    );

    return new TextDecoder().decode(decrypted);
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
