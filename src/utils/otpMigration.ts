import { Secret } from 'otpauth';
import { normalizeOtpSettings } from './otp';
import type { ParsedOtpAuth } from './otpAuth';

const MIGRATION_SCHEME = /^otpauth-migration:\/\//i;
const MAX_LINK_LENGTH = 65536;
const MAX_LINKS = 100;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function readInteger(fields: Map<number, bigint | Uint8Array>, field: number, fallback = 0) {
  const value = fields.get(field);
  if (value === undefined) return fallback;
  if (typeof value !== 'bigint') throw new Error('迁移数据字段无效');
  return Number(value);
}

export function isMigrationLink(value: string) {
  return MIGRATION_SCHEME.test(value.trim());
}

// Google Authenticator's MigrationPayload uses protobuf varints and byte fields.
// https://github.com/qistoph/otp_export/blob/master/OtpMigration.proto
function* readFields(data: Uint8Array) {
  let offset = 0;
  function readVarint() {
    let value = 0n;
    for (let shift = 0n; shift <= 63n && offset < data.length; shift += 7n) {
      const byte = data[offset++];
      if (shift === 63n && byte > 1) break;
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value;
    }
    throw new Error('迁移数据不完整或已损坏');
  }

  while (offset < data.length) {
    const tag = readVarint();
    const field = Number(tag >> 3n);
    if (field < 1 || field > 0x1fffffff) throw new Error('迁移数据字段无效');
    const wire = Number(tag & 7n);
    if (wire === 0) {
      yield [field, readVarint()] as const;
      continue;
    }
    const length = wire === 2 ? Number(readVarint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (length < 0 || length > data.length - offset) throw new Error('迁移数据不完整或已损坏');
    if (wire === 2) yield [field, data.subarray(offset, offset + length)] as const;
    offset += length;
  }
}

function parseMigrationAccount(bytes: Uint8Array): ParsedOtpAuth {
  const fields = new Map<number, bigint | Uint8Array>(readFields(bytes));
  const secret = fields.get(1);
  if (!(secret instanceof Uint8Array) || !secret.length) throw new Error('迁移账户缺少密钥');

  function readText(field: number) {
    const value = fields.get(field);
    if (value === undefined) return '';
    if (!(value instanceof Uint8Array)) throw new Error('迁移数据字段无效');
    try { return textDecoder.decode(value).trim(); }
    catch { throw new Error('迁移账户名称编码无效'); }
  }

  const account = readText(2);
  const issuer = readText(3);
  const algorithm = ['SHA1', 'SHA1', 'SHA256', 'SHA512'][readInteger(fields, 4)];
  const digits = [6, 6, 8][readInteger(fields, 5)];
  const otpType = ([undefined, 'hotp', 'totp'] as const)[readInteger(fields, 6)];
  if (!algorithm || !digits || !otpType) throw new Error('迁移账户包含不支持的 OTP 类型、算法或位数');

  const issuerInName = account.toLowerCase().startsWith(`${issuer.toLowerCase()}:`);
  return {
    secret: new Secret({ buffer: Uint8Array.from(secret).buffer }).base32,
    site: /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z][a-z\d-]*$/i.test(issuer) ? issuer.toLowerCase() : '',
    name: issuer && account && !issuerInName ? `${issuer} · ${account}` : account || issuer || '未命名账户',
    ...normalizeOtpSettings({ type: otpType, digits, algorithm, counter: otpType === 'hotp' ? readInteger(fields, 7) : 0 })
  };
}

function parseMigrationLink(link: string) {
  if (link.length > MAX_LINK_LENGTH || !isMigrationLink(link)) throw new Error('请输入 Google Authenticator 迁移链接');
  const url = new URL(link);
  const encoded = url.searchParams.get('data');
  if (url.hostname.toLowerCase() !== 'offline' || !encoded) throw new Error('迁移链接缺少账户数据');
  const base64 = encoded.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try { binary = atob(base64); }
  catch { throw new Error('迁移链接编码无效'); }

  const accounts: ParsedOtpAuth[] = [];
  const metadata = new Map<number, bigint | Uint8Array>();
  for (const [field, value] of readFields(Uint8Array.from(binary, char => char.charCodeAt(0)))) {
    if (field === 1) {
      if (!(value instanceof Uint8Array)) throw new Error('迁移数据字段无效');
      accounts.push(parseMigrationAccount(value));
    } else metadata.set(field, value);
  }
  const version = readInteger(metadata, 2, 1);
  const size = readInteger(metadata, 3, 1);
  const index = readInteger(metadata, 4);
  const id = metadata.get(5) ?? 0n;
  if (!accounts.length) throw new Error('迁移链接中没有账户');
  if (version !== 1 && version !== 2) throw new Error('不支持此 Google Authenticator 迁移版本');
  if (size < 1 || size > MAX_LINKS || index >= size || typeof id !== 'bigint') throw new Error('迁移批次信息无效');
  return { accounts, version, size, index, id, binary };
}

export function parseOtpMigration(input: string) {
  if (input.length > 524288) throw new Error('迁移数据太大，请分次导入');
  const links = [...new Set(input.trim().split(/\s+/))];
  if (links.length > MAX_LINKS) throw new Error('迁移链接太多，请分次导入');
  const accounts: ParsedOtpAuth[] = [];
  const batches = new Map<string, { size: number; parts: Map<number, string> }>();
  for (const link of links) {
    const part = parseMigrationLink(link);
    if (part.size > 1) {
      const key = `${part.version}:${part.id}`;
      const batch = batches.get(key) ?? { size: part.size, parts: new Map<number, string>() };
      const previous = batch.parts.get(part.index);
      if (batch.size !== part.size || (previous && previous !== part.binary)) throw new Error('检测到冲突的迁移批次，请重新选择同一次导出的二维码');
      if (previous) continue;
      batch.parts.set(part.index, part.binary);
      batches.set(key, batch);
    }
    accounts.push(...part.accounts);
  }
  const missingImages = [...batches.values()].reduce((total, batch) => total + batch.size - batch.parts.size, 0);
  return { accounts, missingImages };
}
