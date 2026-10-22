// Real extension/Service Worker regression, using an isolated Chrome profile,
// synthetic encrypted records and temporary directories. Never opens the user's profile.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { cp, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixture = await mkdtemp(join(tmpdir(), 'openpass-directory-regression-'));
const profile = join(fixture, 'profile');
const directory = join(fixture, 'external-backup');
const downloads = join(fixture, 'downloads');
const extension = join(fixture, 'extension');
await mkdir(join(profile, 'Default'), { recursive: true });
await mkdir(directory); await mkdir(downloads);
await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
await writeFile(join(extension, 'fixture.html'), '<!doctype html><html><body>Backup test fixture</body></html>');
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
// Only the fixture pre-grants the optional permission. Production requests it
// in response to the user's settings action, tested by check-cloud-settings.
manifest.permissions = [...manifest.permissions, 'downloads'];
manifest.optional_permissions = (manifest.optional_permissions || []).filter(value => value !== 'downloads');
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
  profile: { default_content_setting_values: { file_system_read_guard: 1, file_system_write_guard: 1 } },
  download: { default_directory: downloads, prompt_for_download: false }
}));
const salt = webcrypto.getRandomValues(new Uint8Array(16));
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('fixture-password'), 'PBKDF2', false, ['deriveKey']);
const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, base,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify([
  { id: 'fixture', site: 'fixture.example', secret: 'JBSWY3DPEHPK3PXP', type: 'totp' }
])));
const encryptedSecrets = Buffer.concat([salt, iv, Buffer.from(ciphertext)]).toString('base64');
const launch = () => puppeteer.launch({
  executablePath: process.env.OPENPASS_CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
  headless: true, pipe: true, userDataDir: profile,
  enableExtensions: [extension], args: ['--no-first-run']
});
const getWorker = async browser => {
  const target = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url().includes('background.js'));
  const url = new URL(target.url());
  return { worker: await target.worker(), origin: `${url.protocol}//${url.host}` };
};
const waitUntil = async (check, label) => {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const result = await check(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
};
const readState = worker => worker.evaluate(async () => chrome.storage.local.get([
  'localBackupStatus', 'lastBackupTime', 'backupSnapshots', 'backupFileDestination', 'enableDirectoryBackup'
]));
const schedule = worker => worker.evaluate(async () => {
  const { localBackupStatus } = await chrome.storage.local.get(['localBackupStatus']);
  await chrome.storage.local.set({ nextBackupTime: new Date(Date.now() - 1000).toISOString(),
    localBackupStatus: { ...localBackupStatus, nextRetryAt: null } });
  // Let the production storage-change listener finish rebuilding the periodic
  // alarm before replacing it with a near-term one-shot alarm for this test.
  await new Promise(resolve => setTimeout(resolve, 600));
  await chrome.alarms.create('openpass-auto-backup', { when: Date.now() + 300 });
});
let browser;
try {
  browser = await launch();
  let { worker, origin } = await getWorker(browser);
  console.log('TEST_CONTEXT', fixture, await browser.version());
  const page = await browser.newPage(); await page.goto(origin + '/fixture.html');
  await page.evaluate(() => {
    document.body.innerHTML = '<div style="position:fixed;inset:0">Drop synthetic backup directory</div>';
    document.addEventListener('dragover', event => event.preventDefault());
    document.addEventListener('drop', async event => {
      event.preventDefault();
      try { window.fixtureHandle = await event.dataTransfer.items[0].getAsFileSystemHandle(); }
      catch (error) { window.fixtureError = error.message; }
    });
  });
  const cdp = await page.createCDPSession();
  const data = { items: [], files: [directory], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: 100, y: 100, data });
  await page.waitForFunction(() => window.fixtureHandle || window.fixtureError);
  assert.equal(await page.evaluate(() => window.fixtureError), undefined);
  const manualPermission = await page.evaluate(async () => {
    const handle = window.fixtureHandle;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('OpenPassBackupDB', 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('handles')) request.result.createObjectStore('handles'); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('handles', 'readwrite'); transaction.objectStore('handles').put(handle, 'backupDirectory');
      transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
    }); db.close();
    const file = await handle.getFileHandle('manual-fixture.txt', { create: true });
    const writable = await file.createWritable(); await writable.write('fixture'); await writable.close();
    return handle.queryPermission({ mode: 'readwrite' });
  });
  assert.equal(manualPermission, 'granted');
  await page.evaluate(async encryptedSecrets => {
    await chrome.storage.session.clear();
    await chrome.storage.local.set({
      deviceOtpEnabled: false, enableAutoBackup: true, enableLocalSnapshot: true, enableDirectoryBackup: true,
      backupFileDestination: 'directory', backupDirectory: 'external-backup', backupFrequency: 'daily',
      enableBackupEncryption: true, useMasterPasswordForBackup: true,
      encryptedSecrets, sitesList: [{ site: 'fixture.example' }]
    });
  }, encryptedSecrets);
  assert.equal((await page.evaluate(() => chrome.runtime.sendMessage({ action: 'testAutoBackup' }))).success, true);
  const beforeClose = await readState(worker);
  assert.equal(beforeClose.localBackupStatus.state, 'success');
  assert.ok((await readdir(directory)).some(name => name.endsWith('-encrypted.json')));
  // Match the user's temporary directory authorization: the active page still
  // has a grant, but there is no "allow on every visit" grant for future sessions.
  const settings = await browser.newPage(); await settings.goto('chrome://settings/content');
  await settings.evaluate(() => chrome.send('setDefaultValueForContentType', ['file-system-write', 'ask']));
  assert.equal(await page.evaluate(() => window.fixtureHandle.queryPermission({ mode: 'readwrite' })), 'granted');
  for (const tab of await browser.pages()) if (tab.url().startsWith(origin)) await tab.close();
  await new Promise(resolve => setTimeout(resolve, 7000));
  const afterClose = await worker.evaluate(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open('OpenPassBackupDB', 1); request.onsuccess = () => resolve(request.result); });
    const handle = await new Promise(resolve => { const request = db.transaction('handles').objectStore('handles').get('backupDirectory'); request.onsuccess = () => resolve(request.result); });
    db.close();
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    try { await handle.getFileHandle('should-not-be-created.txt', { create: true }); return { permission, error: null }; }
    catch (error) { return { permission, error: error.name }; }
  });
  assert.deepEqual(afterClose, { permission: 'prompt', error: 'NotAllowedError' });
  console.log('REPRODUCED: manual and background writes succeeded while granted; closed pages revoked the temporary grant.');
  await schedule(worker);
  const failed = await waitUntil(async () => { const state = await readState(worker); return state.localBackupStatus?.state === 'partial' && state; }, 'scheduled custom-directory failure');
  assert.equal(failed.lastBackupTime, beforeClose.lastBackupTime);
  assert.equal(failed.enableDirectoryBackup, true);
  assert.equal(failed.backupFileDestination, 'directory');
  assert.equal(failed.localBackupStatus.needAuth, true);
  assert.ok(failed.localBackupStatus.nextRetryAt);
  // Explicitly choose the reliable destination in the fixture; a failure never
  // makes this change automatically in the application.
  await worker.evaluate(() => chrome.storage.local.set({ backupFileDestination: 'downloads', backupDownloadDirectory: 'OpenPass-Fixture' }));
  await schedule(worker);
  await waitUntil(async () => (await readState(worker)).localBackupStatus?.state === 'success', 'scheduled download with all management pages closed');
  const files = await readdir(join(downloads, 'OpenPass-Fixture'));
  assert.equal(files.length, 1);
  const first = JSON.parse(await readFile(join(downloads, 'OpenPass-Fixture', files[0]), 'utf8'));
  assert.equal(first.encrypted, true); assert.equal(first.encryptedData, encryptedSecrets); assert.equal(first.count, 1);
  assert.equal(first.secrets, undefined);
  const downloadedState = await readState(worker);
  // Full browser restart also recreates the Service Worker; no management page
  // or unlocked session is involved in the next actual alarm.
  await browser.close(); browser = await launch();
  ({ worker, origin } = await getWorker(browser));
  for (const tab of await browser.pages()) if (tab.url().startsWith(origin)) await tab.close();
  await schedule(worker);
  await waitUntil(async () => (await readdir(join(downloads, 'OpenPass-Fixture'))).filter(name => name.endsWith('.json')).length >= 2,
    'scheduled encrypted backup after browser and worker restart');
  const restarted = await waitUntil(async () => { const state = await readState(worker); return state.localBackupStatus?.state === 'success' && !state.localBackupStatus.nextRetryAt &&
    state.localBackupStatus.lastAttemptAt !== downloadedState.localBackupStatus.lastAttemptAt && state; }, 'completed restart backup');
  assert.equal(restarted.localBackupStatus.needAuth, false);
  for (const filename of await readdir(join(downloads, 'OpenPass-Fixture'))) {
    const data = JSON.parse(await readFile(join(downloads, 'OpenPass-Fixture', filename), 'utf8'));
    assert.equal(data.encryptedData, encryptedSecrets); assert.equal(data.secrets, undefined);
  }
  const report = { browser: await browser.version(), fixture, manualPermission, afterClose,
    customFailure: failed.localBackupStatus.state, closedPageDownloads: files.length,
    downloadsAfterRestart: (await readdir(join(downloads, 'OpenPass-Fixture'))).length, encrypted: true };
  await writeFile(join(fixture, 'report.json'), JSON.stringify(report, null, 2));
  console.log('PASS: real manual write, directory grant expiration, actual alarm failure, preserved settings and success time, encrypted scheduled downloads with closed pages, browser/worker restart.');
  console.log(JSON.stringify(report));
} finally { await browser?.close(); }
