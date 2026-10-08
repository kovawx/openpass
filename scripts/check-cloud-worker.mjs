// Runs the production background bundle in a real Chromium Worker with synthetic
// credentials and an in-memory HTTP fixture. No SDK mocks or real cloud requests.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { webcrypto } from 'node:crypto';
import puppeteer from 'puppeteer-core';

const password = 'fixture-master-password';
async function encrypt(value) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const data = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return Buffer.concat([salt, iv, Buffer.from(data)]).toString('base64');
}
const local = {
  deviceOtpEnabled: false,
  sessionExpiresAt: Date.now() + 900000,
  encryptedSecrets: await encrypt([{ id: 'one', site: 'fixture.example', secret: 'JBSWY3DPEHPK3PXP', type: 'totp' }]),
  encryptedCloudBackupSecrets: await encrypt({ accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret', cloudPassword: password, cloudPasswordMode: 'master' }),
  cloudBackupSettings: { enabled: true, endpoint: 'https://oss-cn-zhangjiakou.aliyuncs.com', bucket: 'fixture-backups',
    region: 'cn-zhangjiakou', prefix: 'openpass', forcePathStyle: true, retentionMaxVersions: 2, retentionDays: 90 }
};
const bootstrap = `
const values = ${JSON.stringify(local)};
const session = { sessionKey: ${JSON.stringify(password)} };
let runtimeListener;
const noop = () => {};
const event = { addListener: noop, removeListener: noop };
const area = (map) => ({
  get: async (keys) => Object.fromEntries(keys.map(key => [key, map[key]])),
  set: async (updates) => { Object.assign(map, updates); },
  remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach(key => delete map[key]); },
  setAccessLevel: async () => {}
});
self.chrome = {
  runtime: { id: 'fixture-extension', getURL: path => 'chrome-extension://fixture-extension/' + path,
    getManifest: () => ({ version: '0.2.1' }), onInstalled: event, onStartup: event,
    onMessage: { addListener: listener => { runtimeListener = listener; } } },
  storage: { local: area(values), session: area(session), onChanged: event },
  permissions: { contains: async ({origins}) => origins.includes('https://fixture-backups.s3.oss-cn-zhangjiakou.aliyuncs.com/*') },
  contextMenus: { onClicked: event }, tabs: { query: async () => [], onUpdated: event, onActivated: event },
  alarms: { clear: async () => true, create: async () => {}, onAlarm: event },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop }
};
const objects = new Map();
const requests = [];
let mode = 'normal';
let objectSerial = 0;
const xml = (code, status) => new Response('<Error><Code>' + code + '</Code><Message>' + code + '</Message><RequestId>fixture-request</RequestId></Error>',
  { status, headers: { 'content-type': 'application/xml', 'x-amz-request-id': 'fixture-request' } });
self.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const native = url.hostname === 'fixture-backups.oss-cn-zhangjiakou.aliyuncs.com';
  if (!native && url.hostname !== 'fixture-backups.s3.oss-cn-zhangjiakou.aliyuncs.com') throw new Error('Unexpected request host');
  if (native && !request.headers.get('authorization')?.startsWith('OSS4-HMAC-SHA256 ')) throw new Error('Missing native OSS signature');
  const key = decodeURIComponent(url.pathname.slice(1));
  requests.push({ method: request.method, key, ifMatch: request.headers.get('if-match'), ifNoneMatch: request.headers.get('if-none-match'), position: url.searchParams.get('position'), native });
  if (mode === 'denied') return xml('AccessDenied', 403);
  if (mode === 'missing-bucket') return xml('NoSuchBucket', 404);
  if (request.method === 'GET' && url.searchParams.has('list-type')) {
    const prefix = url.searchParams.get('prefix') || '';
    const contents = [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, item]) =>
      '<Contents><Key>' + key + '</Key><LastModified>' + item.modified + '</LastModified><Size>' + item.body.length + '</Size><ETag>&quot;' + item.etag + '&quot;</ETag></Contents>').join('');
    return new Response('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>' + contents + '</ListBucketResult>',
      { headers: { 'content-type': 'application/xml' } });
  }
  const current = objects.get(key);
  if (request.method === 'GET') {
    if (mode === 'missing-latest' && key.includes('/objects/')) return xml('NoSuchKey', 404);
    return current ? new Response(current.body, { headers: { etag: '"' + current.etag + '"' } }) : xml('NoSuchKey', 404);
  }
  if (request.method === 'PUT' || request.method === 'POST') {
    // Real OSS rejects S3 conditional upload headers, on both endpoint families.
    if (request.headers.has('if-match') || request.headers.has('if-none-match')) return xml('NotImplemented', 400);
    if (!native) throw new Error('OSS writes must use the native transport');
    let body = await request.text();
    if (body.includes('JBSWY3DPEHPK3PXP') || body.includes('fixture.example')) throw new Error('Cloud payload leaked plaintext');
    if (request.method === 'POST') {
      if (!url.searchParams.has('append')) throw new Error('Expected AppendObject');
      const position = Number(url.searchParams.get('position'));
      if (mode === 'conflict' || position !== new TextEncoder().encode(current?.body || '').length) return xml('PositionNotEqualToLength', 409);
      body = (current?.body || '') + body;
    } else if (current && request.headers.get('x-oss-forbid-overwrite') === 'true') return xml('FileAlreadyExists', 409);
    const etag = String(++objectSerial);
    objects.set(key, { body, etag, modified: new Date(Date.now() + objectSerial).toISOString() });
    return new Response(null, { status: 200, headers: { etag: '"' + etag + '"' } });
  }
  if (request.method === 'DELETE') {
    if (!native || !key.includes('/objects/')) throw new Error('Unsafe fixture delete');
    objects.delete(key);
    return new Response(null, { status: 204 });
  }
  throw new Error('Unexpected fixture operation ' + request.method);
};
self.addEventListener('message', async ({data}) => {
  if (data.mode) { mode = data.mode; self.postMessage({id: data.id, result: true}); return; }
  if (data.inspect) {
    self.postMessage({ id: data.id, result: { domParser: typeof DOMParser, requests, objectKeys: [...objects.keys()], status: values.cloudBackupStatus, vault: values.encryptedSecrets } }); return;
  }
  runtimeListener({...data}, {id: 'fixture-extension', url: 'chrome-extension://fixture-extension/options.html'},
    result => self.postMessage({id: data.id, result}));
});
`;
const bundle = await readFile(new URL('../.output/chrome-mv3/background.js', import.meta.url), 'utf8');
assert.ok(!bundle.includes('new DOMParser'), 'Production background still depends on DOMParser');
const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Cloud worker test</title>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({ headless: true,
  executablePath: process.env.OPENPASS_CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome') });
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.evaluate((source) => {
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    let serial = 0;
    const pending = new Map();
    worker.onmessage = ({data}) => { pending.get(data.id)?.resolve(data.result); pending.delete(data.id); };
    worker.onerror = event => { for (const item of pending.values()) item.reject(new Error(event.message)); pending.clear(); };
    window.callWorker = data => new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => reject(new Error('Cloud worker timed out')), 20000);
      pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject });
      worker.postMessage({...data, id});
    });
  }, bootstrap + '\n' + bundle);
  const call = data => page.evaluate(data => window.callWorker(data), data);
  assert.deepEqual(await call({action: 'testCloudBackupConnection'}), {success: true, exists: false, etag: null});
  const first = await call({action: 'syncLatestCloudBackup'});
  assert.equal(first.success, true, JSON.stringify(first));
  const details = await call({inspect: true});
  assert.equal(details.domParser, 'undefined');
  assert.equal(details.objectKeys.length, 2);
  assert.equal(details.requests.find(r => r.method === 'POST' && r.key.endsWith('/latest.idx')).position, '0');
  assert.ok(details.requests.every(r => !r.ifMatch && !r.ifNoneMatch));
  assert.ok(details.requests.every(r => r.method !== 'PUT' || r.key.includes('/objects/')));
  assert.equal((await call({action: 'restoreLatestCloudBackup'})).backupData.secrets[0].site, 'fixture.example');
  assert.equal((await call({action: 'listCloudBackupVersions'})).versions.length, 1);
  assert.equal((await call({action: 'testCloudBackupConnection'})).exists, true);
  for (let index = 0; index < 2; index++) {
    const synced = await call({action: 'syncLatestCloudBackup'});
    assert.equal(synced.success, true, JSON.stringify(synced));
  }
  assert.equal((await call({action: 'listCloudBackupVersions'})).versions.length, 2);
  assert.equal((await call({action: 'restoreLatestCloudBackup'})).backupData.secrets[0].site, 'fixture.example');
  const committed = await call({inspect: true});
  assert.ok(committed.requests.some(r => r.method === 'POST' && Number(r.position) > 0));
  assert.ok(committed.requests.some(r => r.method === 'DELETE'));
  const versions = (await call({ action: 'listCloudBackupVersions' })).versions;
  const current = versions.find(version => version.current);
  const historical = versions.find(version => !version.current);
  assert.match((await call({ action: 'prepareCloudVersionDelete', key: current.key })).error, /受保护/);
  const deletion = await call({ action: 'prepareCloudVersionDelete', key: historical.key });
  await call({ mode: 'denied' });
  assert.match((await call({ action: 'deleteCloudBackupVersion', token: deletion.token, confirmation: 'DELETE' })).error, /AccessDenied/);
  await call({ mode: 'normal' });
  assert.equal((await call({ action: 'deleteCloudBackupVersion', token: deletion.token, confirmation: 'DELETE' })).success, true);
  assert.equal((await call({ action: 'listCloudBackupVersions' })).versions.length, 1);
  assert.equal((await call({ action: 'restoreLatestCloudBackup' })).backupData.secrets.length, 1);
  // Continue existing safety checks from the new committed state.
  const afterDeletion = await call({ inspect: true });
  await call({mode: 'missing-latest'});
  assert.match((await call({action: 'syncLatestCloudBackup'})).error, /最新已提交备份缺失/);
  assert.equal((await call({inspect: true})).vault, committed.vault);
  assert.equal((await call({inspect: true})).objectKeys.length, afterDeletion.objectKeys.length);
  await call({mode: 'denied'});
  assert.match((await call({action: 'testCloudBackupConnection'})).error, /AccessDenied/);
  await call({mode: 'missing-bucket'});
  assert.match((await call({action: 'syncLatestCloudBackup'})).error, /NoSuchBucket/);
  await call({mode: 'conflict'});
  assert.match((await call({action: 'syncLatestCloudBackup'})).error, /并发冲突/);
  const conflicted = await call({inspect: true});
  assert.equal(conflicted.status.state, 'conflict');
  assert.equal(conflicted.vault, committed.vault);
  assert.equal(conflicted.objectKeys.length, afterDeletion.objectKeys.length + 1);
  await call({ mode: 'normal' });
  let clear = await call({ action: 'prepareVaultClear', scope: 'cloud' });
  assert.equal(clear.localCount, 1);
  await call({ mode: 'conflict' });
  assert.match((await call({ action: 'clearVault', token: clear.token, confirmation: 'DELETE CLOUD' })).error, /并发冲突/);
  assert.equal((await call({ inspect: true })).vault, committed.vault);
  await call({ mode: 'normal' });
  clear = await call({ action: 'prepareVaultClear', scope: 'cloud' });
  const cleared = await call({ action: 'clearVault', token: clear.token, confirmation: 'DELETE CLOUD' });
  assert.equal(cleared.success, true, JSON.stringify(cleared));
  assert.ok(!cleared.warning);
  assert.equal((await call({ action: 'listCloudBackupVersions' })).versions.length, 1);
  assert.equal((await call({ action: 'restoreLatestCloudBackup' })).backupData.secrets.length, 0);
  assert.ok((await call({ inspect: true })).objectKeys.includes('openpass/v1/latest.idx'));
  const beforeLocalClear = await call({ inspect: true });
  clear = await call({ action: 'prepareVaultClear', scope: 'local' });
  assert.equal((await call({ action: 'clearVault', token: clear.token, confirmation: 'DELETE' })).success, true);
  const afterLocalClear = await call({ inspect: true });
  assert.equal(afterLocalClear.requests.length, beforeLocalClear.requests.length);
  assert.deepEqual(afterLocalClear.objectKeys, beforeLocalClear.objectKeys);
  console.log('PASS: real OSS Worker upload, sync, restore, retention, protected-current deletion, AccessDenied, conflict-safe cloud clear, empty committed state and local-only clear without cloud requests.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
