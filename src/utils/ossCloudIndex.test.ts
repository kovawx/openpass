import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendOssIndex, getNativeOssOrigin, parseOssCursor, readOssIndex, signOssRequest } from './ossCloudIndex';
import type { CloudBackupSettings, CloudBackupSecrets } from './cloudBackupSettings';
import { isCloudBackupConflict } from './s3CloudBackup';

const settings: CloudBackupSettings = {
  enabled: true, endpoint: 'https://s3.oss-cn-hangzhou.aliyuncs.com', bucket: 'examplebucket',
  region: 'cn-hangzhou', prefix: 'openpass', forcePathStyle: false, retentionMaxVersions: 2, retentionDays: 90
};
const secrets: CloudBackupSecrets = { accessKeyId: 'fixture-access', secretAccessKey: 'yourAccessKeySecret', cloudPassword: 'fixture-password' };
const history = (id: string) => `openpass/v1/objects/${id}.opb`;
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  let body: string | null = null;
  const requests: Request[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const request = new Request(url, init);
    requests.push(request);
    if (request.method === 'GET') return body === null
      ? new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }) : new Response(body);
    const position = Number(new URL(request.url).searchParams.get('position'));
    const chunk = await request.text();
    if (position !== new TextEncoder().encode(body || '').length) {
      return new Response('<Error><Code>PositionNotEqualToLength</Code><Message>Stale position</Message></Error>', { status: 409 });
    }
    body = (body || '') + chunk;
    return new Response(null);
  });
  return { requests, get: () => body, set: (value: string) => { body = value; } };
}

describe('OSS native signed append index', () => {
  it('signs the published OSS V4 request using its stated example secret', async () => {
    // Official request/secret: https://help.aliyun.com/zh/oss/developer-reference/recommend-to-use-signature-version-4/
    // Canonical SHA256 c46d9639... matches the document. Expected signature independently
    // computed with Python hashlib/hmac; the document notes its masked signing key is illustrative.
    const signed = await signOssRequest(settings, secrets, 'PUT', 'exampleobject', {}, {
      'content-disposition': 'attachment', 'content-length': '3',
      'content-md5': 'ICy5YqxZB1uWSwcVLSNLcA==', 'content-type': 'text/plain'
    }, new Date('2025-04-11T06:41:24Z'));
    expect(signed.headers.authorization).toBe('OSS4-HMAC-SHA256 Credential=fixture-access/20250411/cn-hangzhou/oss/aliyun_v4_request,AdditionalHeaders=content-disposition;content-length,Signature=d3694c2dfc5371ee6acd35e88c4871ac95a7ba01d3a2f476768fe61218590097');
    expect(signed.url).toBe('https://examplebucket.oss-cn-hangzhou.aliyuncs.com/exampleobject');
  });

  it('encodes paths and append parameters and signs STS credentials', async () => {
    const signed = await signOssRequest(settings, { ...secrets, sessionToken: 'fixture-token' }, 'POST', '中文/a b.idx',
      { position: '0', append: '' }, { 'Content-Type': 'application/json' });
    expect(signed.url).toBe('https://examplebucket.oss-cn-hangzhou.aliyuncs.com/%E4%B8%AD%E6%96%87/a%20b.idx?append&position=0');
    expect(signed.headers).toMatchObject({ 'x-oss-security-token': 'fixture-token', 'content-type': 'application/json' });
    expect(signed.headers.authorization).not.toContain('AdditionalHeaders');
    expect(getNativeOssOrigin({ ...settings, endpoint: 'https://oss-cn-hangzhou.aliyuncs.com' })).toBe('https://examplebucket.oss-cn-hangzhou.aliyuncs.com');
  });

  it('allows exactly one of two writers using the same position and reads the committed version', async () => {
    const remote = fixture();
    expect(await readOssIndex(settings, secrets)).toMatchObject({ position: 0, key: null });
    const results = await Promise.allSettled([
      appendOssIndex(settings, secrets, history('one'), 0), appendOssIndex(settings, secrets, history('two'), 0)
    ]);
    const success = results.filter(result => result.status === 'fulfilled');
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(success).toHaveLength(1);
    expect(isCloudBackupConflict(rejected.reason)).toBe(true);
    const index = await readOssIndex(settings, secrets);
    expect([history('one'), history('two')]).toContain(index.key);
    expect(index.committedKeys.size).toBe(1);
    expect(index.position).toBe(new TextEncoder().encode(remote.get()!).length);
    const cursor = await appendOssIndex(settings, secrets, history('three'), index.position);
    expect((await readOssIndex(settings, secrets)).key).toBe(history('three'));
    expect(parseOssCursor(cursor)).toBe(new TextEncoder().encode(remote.get()!).length);
    expect(remote.requests.every(request => !request.headers.has('if-match') && !request.headers.has('if-none-match'))).toBe(true);
  });

  it('rejects wrong passwords and altered latest pointers or positions', async () => {
    const remote = fixture();
    await appendOssIndex(settings, secrets, history('one'), 0);
    const original = remote.get()!;
    await expect(readOssIndex(settings, { ...secrets, cloudPassword: 'wrong-password' })).rejects.toThrow('密码错误');
    remote.set(original.replace(history('one'), history('two')));
    await expect(readOssIndex(settings, secrets)).rejects.toThrow('校验失败');
    remote.set(original + original);
    await expect(readOssIndex(settings, secrets)).rejects.toThrow('校验失败');
    remote.set('null\n');
    await expect(readOssIndex(settings, secrets)).rejects.toThrow('无效版本');
    remote.set(original.trim());
    await expect(readOssIndex(settings, secrets)).rejects.toThrow('索引损坏');
  });

  it('does not confuse a missing bucket or denied access with an empty index', async () => {
    for (const [code, status] of [['NoSuchBucket', 404], ['AccessDenied', 403]] as const) {
      vi.stubGlobal('fetch', async () => new Response(`<Error><Code>${code}</Code></Error>`, { status }));
      await expect(readOssIndex(settings, secrets)).rejects.toMatchObject({ name: code });
    }
  });

  it('rejects invalid cursors and refuses to exceed the readable index size', async () => {
    expect(() => parseOssCursor('old-s3-etag')).toThrow('重新拉取');
    expect(() => parseOssCursor('oss-append:99999999999999999')).toThrow('位置无效');
    const remote = fixture();
    await expect(appendOssIndex(settings, secrets, history('one'), 8 * 1024 * 1024)).rejects.toThrow('索引过大');
    expect(remote.requests).toHaveLength(0);
  });
});
