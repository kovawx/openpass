// Exercise the built management UI using synthetic storage and cloud responses.
// This does not use the user's profile, credentials, or an actual bucket.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
import { webcrypto } from 'node:crypto';
import puppeteer from 'puppeteer-core';

const password = 'fixture-master';
const salt = webcrypto.getRandomValues(new Uint8Array(16));
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, base,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify({
  accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret', cloudPassword: password, cloudPasswordMode: 'custom'
})));
const fixture = {
  masterPasswordHash: 'fixture-hash', masterPasswordSalt: 'fixture-salt', isSetupComplete: true, welcomeCompleted: true,
  sessionExpiresAt: Date.now() + 900000,
  encryptedCloudBackupSecrets: Buffer.concat([salt, iv, Buffer.from(encrypted)]).toString('base64'),
  cloudBackupSettings: { enabled: true, endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'fixture-bucket',
    prefix: 'openpass', forcePathStyle: true, retentionMaxVersions: 30, retentionDays: 90 },
  cloudBackupStatus: { state: 'success', message: 'Fixture synchronized', lastSuccessAt: '2026-10-07T10:06:01Z' }
};
fixture.backupSnapshots = Array.from({ length: 3 }, (_, index) => ({
  timestamp: new Date(Date.UTC(2026, 9, 7, 10, 6 - index)).toISOString(), count: 9 - index,
  data: { format: 'openpass-backup', formatVersion: 1, encrypted: true, encryptedData: 'fixture', count: 9 - index }
}));
const root = resolve('.output/chrome-mv3');
const server = createServer(async (req, res) => {
  try {
    const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
    const content = await readFile(file);
    res.setHeader('content-type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' }[extname(file)] || 'application/octet-stream');
    res.end(content);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({ headless: true,
  executablePath: process.env.OPENPASS_CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome') });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluateOnNewDocument((initial, password) => {
    const persisted = sessionStorage.getItem('openpass-ui-fixture');
    const values = persisted ? JSON.parse(persisted) : initial;
    const session = { sessionKey: password };
    const listeners = new Set();
    const actions = [];
    const control = { values, actions, restores: [], historyFailure: false, syncLocked: false,
      restoreFailure: false, holdRestore: false, finishRestore: null, deleted: [], deleteFailure: false,
      clears: [], clearScope: null, clearFailure: false };
    window.openpassFixture = control;
    const area = (map, name) => ({
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, map[key]])),
      set: async updates => {
        const changes = Object.fromEntries(Object.entries(updates).map(([key, value]) => [key, { oldValue: map[key], newValue: value }]));
        Object.assign(map, updates);
        if (name === 'local') sessionStorage.setItem('openpass-ui-fixture', JSON.stringify(map));
        queueMicrotask(() => listeners.forEach(listener => listener(changes, name)));
      },
      remove: async keys => { for (const key of keys) delete map[key]; },
      setAccessLevel: async () => {}
    });
    const local = area(values, 'local');
    Object.defineProperty(window, 'chrome', { configurable: true, value: {
      runtime: { id: 'fixture-extension', getURL: path => location.origin + '/' + path,
        getManifest: () => ({ version: '0.2.1' }), onMessage: { addListener() {}, removeListener() {} },
        sendMessage: async request => {
          actions.push(request.action);
          if (request.action === 'prepareCloudVersionDelete') { control.deleteKey = request.key; return { success: true, token: 'fixture-delete' }; }
          if (request.action === 'deleteCloudBackupVersion') {
            if (control.deleteFailure) return { error: 'fixture deletion denied' };
            control.deleted.push(control.deleteKey); return { success: true, deleted: 1 };
          }
          if (request.action === 'prepareVaultClear') { control.clearScope = request.scope; return {
            success: true, token: 'fixture-clear', localCount: 9, remoteCount: 9, historyCount: 29,
            bucket: 'fixture-bucket', prefix: 'openpass' }; }
          if (request.action === 'clearVault') {
            if (control.clearFailure) return { error: 'fixture concurrent update' };
            control.clears.push({ ...request, scope: control.clearScope });
            if (control.clearScope === 'local') await local.set({ cloudBackupSettings: { ...values.cloudBackupSettings, enabled: false }, cloudBackupStatus: { state: 'disabled' } });
            return { success: true, scope: control.clearScope };
          }
          if (request.action === 'restoreVault') {
            control.restores.push(request);
            if (control.restoreFailure) return { error: 'fixture restore denied' };
            if (control.holdRestore) await new Promise(resolve => { control.finishRestore = resolve; });
            return { success: true, count: request.backupData.count };
          }
          if (request.action === 'listCloudBackupVersions') return control.historyFailure
            ? { error: 'fixture history denied' } : { success: true, versions: Array.from({ length: 30 }, (_, index) => ({
              key: 'openpass/v1/objects/fixture-' + (30 - index) + '.opb', size: 1024,
              lastModified: new Date(Date.UTC(2026, 9, 7, 10, 30 - index)).toISOString(), current: index === 0
            })).filter(version => !control.deleted.includes(version.key)) };
          if (request.action === 'syncLatestCloudBackup') {
            if (control.syncLocked) return { error: '请先解锁 OpenPass' };
            await local.set({ cloudBackupStatus: { ...values.cloudBackupStatus, state: 'success', message: 'Fixture synchronized' } });
            return { success: true, result: { count: 0 } };
          }
          if (request.action === 'testCloudBackupConnection') return { success: true, exists: true };
          return { success: true };
        } },
      storage: { local, session: area(session, 'session'), onChanged: {
        addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener)
      } },
      permissions: { request: async () => true, contains: async () => true },
      alarms: { clear: async () => true, create: async () => {} }
    } });
  }, fixture, password);
  const clickText = text => page.evaluate(text => {
    const element = [...document.querySelectorAll('button, nav a')].find(element => element.textContent.trim() === text);
    if (!element) throw Error('Missing control: ' + text);
    element.click();
  }, text);
  const openSettings = async () => {
    await page.goto('http://127.0.0.1:' + server.address().port + '/options.html');
    await page.waitForSelector('aside nav a');
    await clickText('设置');
    await page.waitForFunction(() => document.querySelectorAll('.cloud-history-item').length === 5);
  };
  await openSettings();
  assert.equal(await page.$eval('.cloud-config-toggle', el => el.getAttribute('aria-expanded')), 'false');
  assert.ok((await page.evaluate(() => window.openpassFixture.actions)).includes('listCloudBackupVersions'));
  assert.match(await page.$eval('.cloud-pagination', el => el.textContent), /1 \/ 6/);
  await clickText('下一页');
  assert.match(await page.$eval('.cloud-pagination', el => el.textContent), /2 \/ 6/);
  assert.match(await page.$eval('.cloud-history-item', el => el.textContent), /fixture-25.opb/);
  await page.click('.cloud-config-toggle');
  await page.select('#cloud-password-choice', 'master');
  await clickText('保存并同步');
  await page.waitForFunction(() => document.querySelector('.cloud-actions button')?.textContent.trim() === '保存并同步');
  assert.equal(await page.$eval('#cloud-password-choice', el => el.value), 'master');
  assert.ok((await page.evaluate(() => window.openpassFixture.actions)).includes('syncLatestCloudBackup'));
  await openSettings();
  await page.click('.cloud-config-toggle');
  assert.equal(await page.$eval('#cloud-password-choice', el => el.value), 'master');
  assert.equal(await page.$eval('#cloud-password-choice', el => getComputedStyle(el).appearance), 'none');
  await page.screenshot({ path: '/tmp/openpass-cloud-settings-expanded.png', fullPage: true });
  await page.click('.cloud-config-toggle');
  await page.$eval('.cloud-config-toggle', el => el.scrollIntoView());
  await page.screenshot({ path: '/tmp/openpass-cloud-settings-collapsed.png' });
  await page.evaluate(() => { window.openpassFixture.historyFailure = true; });
  await clickText('刷新版本');
  await page.waitForSelector('.cloud-history-error');
  assert.match(await page.$eval('.cloud-history-error', el => el.textContent), /fixture history denied/);
  await page.evaluate(() => { window.openpassFixture.historyFailure = false; });
  await clickText('重新读取');
  await page.waitForFunction(() => document.querySelectorAll('.cloud-history-item').length === 5);
  await page.evaluate(() => { window.openpassFixture.syncLocked = true; });
  await clickText('立即双向同步');
  await page.waitForSelector('.cloud-action-error');
  assert.match(await page.$eval('.cloud-action-error', el => el.textContent), /请先解锁/);
  assert.ok(!await page.$('.openpass-toast-success'));
  await page.setViewport({ width: 800, height: 1000 });
  await page.click('.cloud-config-toggle');
  assert.ok(await page.$eval('#cloud-password-choice', el => el.getBoundingClientRect().right <= innerWidth));
  await page.setViewport({ width: 1440, height: 1000 });
  await clickText('备份恢复');
  await page.waitForFunction(() => document.querySelectorAll('.snapshot-item').length === 3);
  assert.equal(await page.$eval('#snapshot-mode', el => getComputedStyle(el).appearance), 'none');
  await page.screenshot({ path: '/tmp/openpass-backup-list.png' });
  await page.select('#snapshot-mode', 'replace');
  assert.ok(await page.$('.snapshot-toolbar-replace'));
  await page.click('.snapshot-item .btn-secondary');
  await page.waitForSelector('.snapshot-dialog[open]');
  assert.match(await page.$eval('.snapshot-dialog', el => el.textContent), /9 个密钥/);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '取消');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.snapshot-dialog').open);
  assert.equal(await page.evaluate(() => window.openpassFixture.restores.length), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.snapshot-item') !== null), true);
  await page.click('.snapshot-item .btn-secondary');
  await page.evaluate(() => { window.openpassFixture.restoreFailure = true; });
  await clickText('确认替换');
  await page.waitForSelector('.snapshot-dialog .form-error');
  assert.match(await page.$eval('.snapshot-dialog .form-error', el => el.textContent), /fixture restore denied/);
  await page.evaluate(() => { window.openpassFixture.restoreFailure = false; window.openpassFixture.holdRestore = true; });
  await clickText('确认替换');
  await page.waitForSelector('.snapshot-spinner');
  assert.ok(await page.$$eval('.snapshot-dialog button', buttons => buttons.every(button => button.disabled)));
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.snapshot-dialog', el => el.open), true);
  await page.evaluate(() => window.openpassFixture.finishRestore());
  await page.waitForFunction(() => !document.querySelector('.snapshot-dialog').open);
  assert.equal(await page.evaluate(() => window.openpassFixture.restores.at(-1).mode), 'replace');
  await page.select('#snapshot-mode', 'merge');
  await page.click('.snapshot-item:nth-child(2) .btn-secondary');
  await page.waitForSelector('.snapshot-dialog[open]');
  assert.match(await page.$eval('.snapshot-dialog', el => el.textContent), /8 个密钥/);
  await page.screenshot({ path: '/tmp/openpass-backup-confirm.png' });
  await clickText('取消');
  await page.evaluate(() => chrome.storage.local.set({ backupSnapshots: [...window.openpassFixture.values.backupSnapshots,
    { ...window.openpassFixture.values.backupSnapshots[2], timestamp: '2026-10-07T09:00:00Z' }] }));
  await page.waitForFunction(() => document.querySelectorAll('.snapshot-item').length === 4);
  await page.setViewport({ width: 800, height: 1000 });
  assert.ok(await page.$eval('.snapshot-item', el => el.getBoundingClientRect().right <= innerWidth));
  await page.screenshot({ path: '/tmp/openpass-backup-narrow.png' });
  await page.setViewport({ width: 1440, height: 1000 });
  await clickText('设置');
  await page.waitForFunction(() => document.querySelectorAll('.cloud-history-item').length === 5);
  assert.equal(await page.$eval('.cloud-history-item .cloud-delete-button', el => el.disabled), true);
  assert.equal(await page.$eval('.cloud-version-actions', el => getComputedStyle(el).flexDirection), 'row');
  await (await page.$$('.cloud-history-item .cloud-delete-button'))[1].click();
  await page.waitForSelector('[aria-labelledby="cloud-delete-title"][open]');
  await page.waitForFunction(() => document.querySelector('[aria-labelledby="cloud-delete-title"] .btn-danger')?.textContent === '确认删除');
  assert.equal(await page.$eval('[aria-labelledby="cloud-delete-title"] .btn-danger', el => el.disabled), true);
  await page.type('#cloud-delete-confirmation', 'DELETE');
  await page.evaluate(() => { window.openpassFixture.deleteFailure = true; });
  await clickText('确认删除');
  await page.waitForSelector('[aria-labelledby="cloud-delete-title"] .form-error');
  assert.match(await page.$eval('[aria-labelledby="cloud-delete-title"] .form-error', el => el.textContent), /fixture deletion denied/);
  await page.evaluate(() => { window.openpassFixture.deleteFailure = false; });
  await clickText('确认删除');
  await page.waitForFunction(() => !document.querySelector('[aria-labelledby="cloud-delete-title"]').open);
  assert.equal(await page.evaluate(() => window.openpassFixture.deleted.length), 1);
  await clickText('清空密钥');
  await page.waitForSelector('[aria-labelledby="clear-dialog-title"][open]');
  assert.equal(await page.$eval('input[type=radio][value=local]', el => el.checked), true);
  assert.equal(await page.$eval('[aria-labelledby="clear-dialog-title"] .btn-danger', el => el.disabled), true);
  await page.click('input[type=radio][value=cloud]');
  await clickText('检查清理范围');
  await page.waitForSelector('#clear-confirmation');
  assert.match(await page.$eval('.clear-review', el => el.textContent), /29 份历史备份/);
  await page.type('#clear-confirmation', 'DELETE');
  assert.equal(await page.$eval('[aria-labelledby="clear-dialog-title"] .btn-danger', el => el.disabled), true);
  await page.type('#clear-confirmation', ' CLOUD');
  await page.evaluate(() => { window.openpassFixture.clearFailure = true; });
  await clickText('确认清理');
  await page.waitForSelector('[aria-labelledby="clear-dialog-title"] .form-error');
  assert.match(await page.$eval('[aria-labelledby="clear-dialog-title"] .form-error', el => el.textContent), /fixture concurrent update/);
  await page.screenshot({ path: '/tmp/openpass-clear-cloud-confirm.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.openpassFixture.clears.length), 0);
  await clickText('清空密钥');
  await page.waitForSelector('[aria-labelledby="clear-dialog-title"][open]');
  await page.evaluate(() => { window.openpassFixture.clearFailure = false; });
  await clickText('检查清理范围');
  await page.waitForSelector('#clear-confirmation');
  await page.type('#clear-confirmation', 'DELETE');
  await clickText('确认清理');
  await page.waitForFunction(() => !document.querySelector('[aria-labelledby="clear-dialog-title"]').open);
  assert.equal(await page.evaluate(() => window.openpassFixture.clears.at(-1).scope), 'local');
  assert.equal(await page.evaluate(() => window.openpassFixture.values.cloudBackupSettings.enabled), false);
  assert.equal(await page.evaluate(() => window.openpassFixture.deleted.length), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: management UI history/paging, password persistence, restore confirmation, explicit clear scope and typed consent, cloud deletion retry, protected current version, local-only cleanup and narrow layouts.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
