import { hexToBytes } from '@noble/hashes/utils.js';
import CryptoUtils from './crypto';
import { normalizeOtpSettings, type OtpSettings } from './otp';
import { parseOtpAuth, type ParsedOtpAuth } from './otpAuth';
import { isMigrationLink, parseOtpMigration } from './otpMigration';
import { DEVICE_REGISTRATION_MESSAGE, isDeviceRegistration } from './otpQrInput';

export const MAX_AUTHENTICATOR_BACKUP_SIZE = 16 * 1024 * 1024;

type JsonObject = Record<string, unknown>;
export type ImportedAccount = ParsedOtpAuth & { group?: string; favorite?: boolean };
export interface AuthenticatorImport {
  source: string;
  accounts: ImportedAccount[];
  omitted: Array<{ name: string; reason: string }>;
  missingImages: number;
}

export class AuthenticatorPasswordError extends Error {}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

const asText = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const domain = (value: string) => /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z][a-z\d-]*$/i.test(value) ? value.toLowerCase() : '';

function readJson(value: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new Error('备份文件中的 JSON 无效'); }
}

function base64(value: unknown): Uint8Array<ArrayBuffer> {
  return new Uint8Array(CryptoUtils.base64ToArrayBuffer(asText(value).replace(/-/g, '+').replace(/_/g, '/')));
}

const subtle = () => globalThis.crypto.subtle;

async function decryptAes(key: CryptoKey, iv: Uint8Array<ArrayBuffer>, ciphertext: Uint8Array<ArrayBuffer>) {
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error('备份文件的加密数据格式无效');
  try { return await subtle().decrypt({ name: 'AES-GCM', iv }, key, ciphertext); }
  catch { throw new AuthenticatorPasswordError('备份密码错误，或备份文件已损坏'); }
}

async function decryptAegisBlock(key: Uint8Array<ArrayBuffer>, params: unknown, ciphertext: Uint8Array) {
  const { nonce, tag } = asObject(params);
  const authTag = hexToBytes(asText(tag));
  if (key.length !== 32 || authTag.length !== 16) throw new Error('Aegis 备份的加密数据格式无效');
  const sealed = new Uint8Array(ciphertext.length + authTag.length);
  sealed.set(ciphertext);
  sealed.set(authTag, ciphertext.length);
  const cryptoKey = await subtle().importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  return decryptAes(cryptoKey, hexToBytes(asText(nonce)), sealed);
}

// Aegis vault format v1 uses an scrypt password slot to wrap its AES vault key.
// https://github.com/beemdevelopment/Aegis/blob/master/docs/vault.md
async function openAegis(root: JsonObject, password?: string) {
  if (root.version !== 1) throw new Error('此 Aegis 备份版本暂未支持');
  if (typeof root.db !== 'string') return asObject(root.db);
  const header = asObject(root.header);
  const slots = (Array.isArray(header.slots) ? header.slots : []).map(asObject).filter(slot => slot.type === 1);
  if (!slots.length) throw new Error('此 Aegis 文件缺少密码密钥槽，请从 Aegis 导出密码保护的备份');
  if (!password) throw new AuthenticatorPasswordError('请输入 Aegis 备份密码');
  const { scryptAsync } = await import('@noble/hashes/scrypt.js');
  let supportedSlot = false;
  for (const slot of slots.slice(0, 8)) {
    const { n: N, r, p } = slot;
    if (typeof N !== 'number' || typeof r !== 'number' || typeof p !== 'number' ||
        ![N, r, p].every(Number.isSafeInteger) || N < 2 || r < 1 || p < 1 || (N & (N - 1)) !== 0 ||
        N * r * p > 1048576) continue;
    supportedSlot = true;
    const derived = await scryptAsync(new TextEncoder().encode(password), hexToBytes(asText(slot.salt)), {
      N, r, p, dkLen: 32, maxmem: 160 * 1024 * 1024
    });
    let key: ArrayBuffer;
    try { key = await decryptAegisBlock(derived, slot.key_params, hexToBytes(asText(slot.key))); }
    catch (error) {
      if (!(error instanceof AuthenticatorPasswordError)) throw error;
      continue;
    } finally { derived.fill(0); }
    try {
      const plaintext = await decryptAegisBlock(new Uint8Array(key), header.params, base64(root.db));
      return asObject(readJson(new TextDecoder().decode(plaintext)));
    } finally { new Uint8Array(key).fill(0); }
  }
  if (!supportedSlot) throw new Error('此 Aegis 文件的密钥派生参数超出浏览器导入范围');
  throw new AuthenticatorPasswordError('Aegis 备份密码错误，或备份文件已损坏');
}

// 2FAS serializes ciphertext+tag, salt and IV as three Base64 fields.
// https://github.com/twofas/2fas-android/blob/main/core/cipher/src/main/java/com/twofasapp/cipher/backup/DataEncrypted.kt
async function openTwoFas(root: JsonObject, password?: string) {
  if (typeof root.schemaVersion !== 'number' || !Number.isInteger(root.schemaVersion) || root.schemaVersion < 1 || root.schemaVersion > 4) {
    throw new Error('此 2FAS 备份版本暂未支持');
  }
  const payload = asText(root.servicesEncrypted);
  if (!payload) {
    if (root.reference) throw new Error('2FAS 加密备份缺少账户数据');
    return root.services;
  }
  if (!password) throw new AuthenticatorPasswordError('请输入 2FAS 备份密码');
  const parts = payload.split(':');
  if (parts.length !== 3 || parts.some(part => !part)) throw new Error('2FAS 备份的加密数据格式无效');
  const [ciphertext, salt, iv] = parts.map(base64);
  const base = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 10000 }, base,
    { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return readJson(new TextDecoder().decode(await decryptAes(key, iv, ciphertext)));
}

function finishAccount(secret: string, name: string, issuer: string, settings: OtpSettings): ImportedAccount {
  const normalized = secret.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!/^[A-Z2-7]+$/.test(normalized)) throw new Error('缺少有效的 Base32 密钥');
  return { secret: normalized, name: name || issuer || '未命名账户', site: domain(issuer), ...normalizeOtpSettings(settings) };
}

function convertEntries(source: string, entries: unknown, convert: (entry: JsonObject) => ImportedAccount): AuthenticatorImport {
  if (!Array.isArray(entries)) throw new Error(`${source} 备份缺少账户列表`);
  const accounts: ImportedAccount[] = [];
  const omitted: AuthenticatorImport['omitted'] = [];
  for (const value of entries) {
    const entry = asObject(value);
    try { accounts.push(convert(entry)); }
    catch (error) { omitted.push({ name: asText(entry.name) || asText(entry.issuer) || '未命名账户', reason: (error as Error).message }); }
  }
  return { source, accounts, omitted, missingImages: 0 };
}

function groupNames(groups: unknown, idField: 'id' | 'uuid') {
  return new Map((Array.isArray(groups) ? groups : []).map(asObject)
    .map(group => [asText(group[idField]), asText(group.name)]));
}

function codeType(type: unknown, fallback?: 'totp' | 'hotp') {
  const normalized = asText(type).toLowerCase() || fallback;
  if (normalized === 'hotp' || normalized === 'totp') return normalized;
  throw new Error(`此账户使用 ${normalized || '未知类型'}，需要原验证器`);
}

const numberOr = (value: unknown, fallback?: number) => value == null ? fallback : typeof value === 'number' ? value : NaN;

async function parseBackup(input: string, password?: string) {
  const root = asObject(readJson(input));
  if ('db' in root && 'header' in root) {
    const vault = await openAegis(root, password);
    if (typeof vault.version === 'number' && vault.version > 3) throw new Error('此 Aegis 账户数据版本暂未支持');
    const groups = groupNames(vault.groups, 'uuid');
    return convertEntries('Aegis', vault.entries, entry => {
      const info = asObject(entry.info);
      const issuer = asText(entry.issuer);
      const name = [issuer, asText(entry.name)].filter(Boolean).join(' · ');
      const group = (Array.isArray(entry.groups) ? entry.groups : []).map(id => groups.get(asText(id))).find(Boolean) || asText(entry.group);
      return { ...finishAccount(asText(info.secret), name, issuer, {
        type: codeType(entry.type), digits: numberOr(info.digits), algorithm: asText(info.algo) || undefined,
        period: numberOr(info.period), counter: numberOr(info.counter)
      }), group, favorite: entry.favorite === true };
    });
  }
  if ('schemaVersion' in root && ('services' in root || 'servicesEncrypted' in root)) {
    const groups = groupNames(root.groups, 'id');
    return convertEntries('2FAS', await openTwoFas(root, password), entry => {
      const otp = asObject(entry.otp);
      const link = asText(otp.link);
      const parsed = /^otpauth:\/\//i.test(link) ? parseOtpAuth(link) : null;
      const issuer = asText(otp.issuer) || parsed?.site || asText(entry.name);
      const label = asText(entry.name) || issuer;
      const account = asText(otp.account);
      const name = account && label !== account ? [label, account].filter(Boolean).join(' · ') : label;
      return { ...finishAccount(asText(entry.secret) || parsed?.secret || '', name, issuer, {
        type: codeType(otp.tokenType, parsed?.type || 'totp'), digits: numberOr(otp.digits, parsed?.digits),
        algorithm: asText(otp.algorithm) || parsed?.algorithm, period: numberOr(otp.period, parsed?.period),
        counter: numberOr(otp.counter, parsed?.counter)
      }), group: groups.get(asText(entry.groupId)) || '' };
    });
  }
  if (root.format === 'openpass-backup') throw new Error('请从「备份恢复」导入 OpenPass 备份');
  throw new Error('无法识别备份文件，请选择 Aegis 或 2FAS 导出文件');
}

export async function parseAuthenticatorImport(input: string, password?: string): Promise<AuthenticatorImport> {
  if (input.length > MAX_AUTHENTICATOR_BACKUP_SIZE) throw new Error('导入数据过大，请分批导入');
  const text = input.trim();
  if (text.startsWith('{')) return parseBackup(text, password);
  if (isDeviceRegistration(text)) throw new Error(DEVICE_REGISTRATION_MESSAGE);

  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).flatMap(line => line.split(/\s+(?=otpauth(?:-migration)?:\/\/)/i));
  const migrationLinks = lines.filter(isMigrationLink);
  const result: AuthenticatorImport = { source: migrationLinks.length ? 'Google Authenticator' : 'OTPAuth', accounts: [], omitted: [], missingImages: 0 };
  if (migrationLinks.length) Object.assign(result, parseOtpMigration(migrationLinks.join('\n')));
  for (const line of lines.filter(line => !isMigrationLink(line))) {
    const account = parseOtpAuth(line);
    if (!account) throw new Error(isDeviceRegistration(line) ? DEVICE_REGISTRATION_MESSAGE : '无法识别验证码链接或备份格式');
    result.accounts.push({ ...account, ...normalizeOtpSettings(account), site: domain(account.site), name: account.name || '未命名账户' });
  }
  return result;
}
