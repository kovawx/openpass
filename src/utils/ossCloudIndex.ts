import { parseXML } from '@aws-sdk/xml-builder';
import CryptoUtils from './crypto';
import { normalizeCloudEndpoint, type CloudBackupSettings, type CloudBackupSecrets } from './cloudBackupSettings';

const encoder = new TextEncoder();
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (value: string) => value.split('/').map(encode).join('/');

async function hmac(key: Uint8Array<ArrayBuffer>, value: string) {
  const imported = await globalThis.crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', imported, encoder.encode(value)));
}

export function getNativeOssOrigin(settings: CloudBackupSettings) {
  const url = new URL(normalizeCloudEndpoint(settings.endpoint));
  url.hostname = `${settings.bucket}.${url.hostname.replace(/^s3\./, '')}`;
  return url.origin;
}

export async function signOssRequest(
  settings: CloudBackupSettings, secrets: CloudBackupSecrets, method: string, key: string,
  query: Record<string, string> = {}, headers: Record<string, string> = {}, now = new Date()
) {
  const date = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const scope = `${date.slice(0, 8)}/${settings.region}/oss/aliyun_v4_request`;
  const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim()]));
  const signedHeaders: Record<string, string> = {
    ...normalizedHeaders, 'x-oss-date': date, 'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    ...(secrets.sessionToken ? { 'x-oss-security-token': secrets.sessionToken } : {})
  };
  const canonicalHeaders = Object.keys(signedHeaders).sort().map(name => `${name.toLowerCase()}:${signedHeaders[name].trim()}\n`).join('');
  const additional = Object.keys(normalizedHeaders).filter(name => !name.startsWith('x-oss-') && !['content-type', 'content-md5'].includes(name)).sort().join(';');
  const canonicalQuery = Object.entries(query).map(([name, value]) => [encode(name), encode(value)])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => value ? `${name}=${value}` : name).join('&');
  const canonical = [method, encodePath(`/${settings.bucket}/${key}`), canonicalQuery, canonicalHeaders, additional, 'UNSIGNED-PAYLOAD'].join('\n');
  const digest = hex(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(canonical)));
  let signingKey = encoder.encode(`aliyun_v4${secrets.secretAccessKey}`);
  for (const value of [date.slice(0, 8), settings.region, 'oss', 'aliyun_v4_request']) signingKey = await hmac(signingKey, value);
  const signature = hex((await hmac(signingKey, `OSS4-HMAC-SHA256\n${date}\n${scope}\n${digest}`)).buffer);
  return {
    url: `${getNativeOssOrigin(settings)}/${encodePath(key)}${canonicalQuery ? `?${canonicalQuery}` : ''}`,
    headers: { ...signedHeaders, authorization: `OSS4-HMAC-SHA256 Credential=${secrets.accessKeyId}/${scope},${additional ? `AdditionalHeaders=${additional},` : ''}Signature=${signature}` }
  };
}

export async function requestOss(
  settings: CloudBackupSettings, secrets: CloudBackupSecrets, method: string, key: string,
  options: { body?: string; query?: Record<string, string>; headers?: Record<string, string> } = {}
) {
  const signed = await signOssRequest(settings, secrets, method, key, options.query, options.headers);
  const response = await fetch(signed.url, { method, headers: signed.headers, body: options.body, cache: 'no-store', redirect: 'error' });
  if (!response.ok) {
    let errorBody: Record<string, unknown> = {};
    try { errorBody = (parseXML(await response.text()) as { Error?: Record<string, unknown> }).Error || {}; } catch { /* Preserve the HTTP status if an intermediary returned non-XML. */ }
    const code = typeof errorBody.Code === 'string' ? errorBody.Code : `OSSHttp${response.status}`;
    const error = new Error(`${code}: ${typeof errorBody.Message === 'string' ? errorBody.Message : 'OSS 请求失败'}`);
    error.name = code;
    Object.assign(error, { $metadata: { httpStatusCode: response.status } });
    throw error;
  }
  return response;
}

export function getOssIndexKey(settings: CloudBackupSettings) { return `${settings.prefix}/v1/latest.idx`; }
export function ossCursor(position: number) { return `oss-append:${position}`; }
export function parseOssCursor(cursor: string | null) {
  if (cursor === null) return 0;
  if (!/^oss-append:\d+$/.test(cursor)) throw new Error('OSS 同步版本已变更，请重新拉取云端备份');
  const value = Number(cursor.slice('oss-append:'.length));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('OSS 同步位置无效');
  return value;
}

export interface OssIndex { position: number; key: string | null; committedKeys: Set<string> }
function validateKey(settings: CloudBackupSettings, key: unknown): key is string {
  const prefix = `${settings.prefix}/v1/objects/`;
  return typeof key === 'string' && key.startsWith(prefix) && /^[a-zA-Z0-9-]+\.opb$/.test(key.slice(prefix.length));
}

export async function readOssIndex(settings: CloudBackupSettings, secrets: CloudBackupSecrets): Promise<OssIndex> {
  let response: Response;
  try { response = await requestOss(settings, secrets, 'GET', getOssIndexKey(settings)); }
  catch (error) {
    if (error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound')) return { position: 0, key: null, committedKeys: new Set() };
    throw error;
  }
  const text = await response.text();
  const position = encoder.encode(text).length;
  if (position > MAX_INDEX_BYTES) throw new Error('OSS 同步索引过大，请更换对象前缀建立新备份');
  if (!text) return { position: 0, key: null, committedKeys: new Set() };
  if (!text.endsWith('\n')) throw new Error('OSS 同步索引损坏，拒绝覆盖');
  const lines = text.slice(0, -1).split('\n');
  let records: { key: string; proof: string }[];
  try {
    records = lines.map(line => JSON.parse(line));
    if (records.some(record => !record || !validateKey(settings, record.key) || typeof record.proof !== 'string')) throw new Error();
  } catch { throw new Error('OSS 同步索引包含无效版本'); }
  const last = records[records.length - 1];
  const lastOffset = position - encoder.encode(lines[lines.length - 1] + '\n').length;
  let proof: { key: unknown; position: unknown };
  try { proof = JSON.parse(await CryptoUtils.decrypt(last.proof, secrets.cloudPassword)); }
  catch { throw new Error('云端备份密码错误或 OSS 同步索引损坏'); }
  if (!proof || proof.key !== last.key || proof.position !== lastOffset) throw new Error('OSS 同步索引校验失败');
  return { position, key: last.key as string, committedKeys: new Set(records.map(record => record.key as string)) };
}

export async function appendOssIndex(settings: CloudBackupSettings, secrets: CloudBackupSecrets, key: string, position: number) {
  if (!Number.isSafeInteger(position) || position < 0 || !validateKey(settings, key)) throw new Error('OSS 同步位置或版本无效');
  const proof = await CryptoUtils.encrypt(JSON.stringify({ key, position }), secrets.cloudPassword);
  const body = JSON.stringify({ key, proof }) + '\n';
  if (position + encoder.encode(body).length > MAX_INDEX_BYTES) throw new Error('OSS 同步索引过大，请更换对象前缀建立新备份');
  await requestOss(settings, secrets, 'POST', getOssIndexKey(settings), {
    query: { append: '', position: String(position) }, body,
    headers: { 'content-type': 'application/vnd.openpass.cloud-index+json' }
  });
  return ossCursor(position + encoder.encode(body).length);
}
