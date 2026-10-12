// Exercise the production popup and manager with synthetic accounts in an isolated headless browser.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { webcrypto, createHash } from 'node:crypto';
import puppeteer from 'puppeteer-core';

const password = 'fixture-master';
const defaults = { type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, counter: 0 };
const accounts = [
  { id: 'legacy', site: 'example.com', name: '旧账户', secret: 'JBSWY3DPEHPK3PXP', ...defaults },
  { id: 'work', site: 'github.com', name: '工作账户', secret: 'GEZDGNBVGY3TQOJQ', ...defaults, group: '工作', favorite: true },
  { id: 'personal', site: 'mail.example.org', name: '个人账户', secret: 'MFRGGZDFMZTWQ2LK', ...defaults, group: '个人', favorite: false }
];
const salt = webcrypto.getRandomValues(new Uint8Array(16));
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, base,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(accounts)));
const verifierSalt = Buffer.from(salt).toString('base64');
const fixture = { isSetupComplete: true, welcomeCompleted: true,
  masterPasswordHash: createHash('sha256').update(password + verifierSalt).digest('base64'), masterPasswordSalt: verifierSalt,
  sessionExpiresAt: Date.now() + 900000, encryptedSecrets: Buffer.concat([salt, iv, Buffer.from(encrypted)]).toString('base64') };
const root = resolve('.output/chrome-mv3');
const screenshots = join(tmpdir(), 'openpass-account-organization');
await mkdir(screenshots, { recursive: true });
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
let browser, page;
try {
  browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.OPENPASS_CHROME_PATH || (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome') });
  page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.evaluateOnNewDocument((initial, original, password, defaults) => {
    const normalized = entry => ({ ...entry, ...defaults, ...entry, group: typeof entry.group === 'string' ? entry.group.trim() : '', favorite: entry.favorite === true });
    const persisted = localStorage.getItem('organization-fixture');
    const values = persisted ? JSON.parse(persisted) : initial;
    const saved = localStorage.getItem('organization-accounts');
    const control = { accounts: (saved ? JSON.parse(saved) : original).map(normalized), saves: [], copies: 0, failSave: false, migrationError: '', opened: [] };
    window.openpassFixture = control;
    const previousSession = sessionStorage.getItem('organization-session');
    const session = location.search.includes('locked') ? {} : previousSession ? JSON.parse(previousSession) : { sessionKey: password };
    sessionStorage.setItem('organization-session', JSON.stringify(session));
    window.close = () => {};
    const listeners = new Set();
    const area = (map, name) => ({
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, map[key]])),
      set: async updates => {
        const changes = Object.fromEntries(Object.entries(updates).map(([key, value]) => [key, { oldValue: map[key], newValue: value }]));
        Object.assign(map, updates);
        if (name === 'local') localStorage.setItem('organization-fixture', JSON.stringify(map));
        else sessionStorage.setItem('organization-session', JSON.stringify(map));
        queueMicrotask(() => listeners.forEach(listener => listener(changes, name)));
      },
      remove: async keys => {
        for (const key of keys) delete map[key];
        if (name === 'local') localStorage.setItem('organization-fixture', JSON.stringify(map));
        else sessionStorage.setItem('organization-session', JSON.stringify(map));
      }, setAccessLevel: async () => {}
    });
    const local = area(values, 'local');
    const encrypt = async records => {
      const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, base,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(records)));
      const bytes = new Uint8Array(28 + ciphertext.byteLength);
      bytes.set(salt); bytes.set(iv, 16); bytes.set(new Uint8Array(ciphertext), 28);
      return btoa(String.fromCharCode(...bytes));
    };
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { control.copies++; } } });
    Object.defineProperty(window, 'chrome', { configurable: true, value: {
      runtime: { id: 'fixture-extension', getURL: path => location.origin + '/' + path,
        getManifest: () => ({ version: '0.3.0' }), onMessage: { addListener() {}, removeListener() {} },
        sendMessage: async request => {
          if (request.action === 'migrateVaultForUnlock') return control.migrationError
            ? { error: control.migrationError } : { success: true };
          if (request.action === 'saveVault') {
            if (control.failSave) return { error: 'fixture concurrent update' };
            if (request.expectedSecrets !== JSON.stringify(control.accounts)) return { error: 'fixture stale write' };
            control.accounts = request.secrets.map(normalized);
            control.saves.push(request);
            localStorage.setItem('organization-accounts', JSON.stringify(control.accounts));
            await local.set({ encryptedSecrets: await encrypt(control.accounts) });
            return { success: true, secrets: control.accounts };
          }
          if (request.action === 'getSecrets') return { locked: !session.sessionKey, otpAvailable: true,
            secrets: control.accounts.map(account => { const metadata = { ...account }; delete metadata.secret; return metadata; }) };
          if (request.action === 'generateCode' || request.action === 'consumeCode') return { code: '123456', remainingSeconds: 25 };
          return { success: true };
        } },
      storage: { local, session: area(session, 'session'), onChanged: {
        addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener)
      } },
      tabs: { query: async () => [{ url: 'https://github.com/login' }], create: async options => { control.opened.push(options.url); } },
      permissions: { request: async () => true, contains: async () => true }
    } });
  }, fixture, accounts, password, defaults);
  const origin = 'http://127.0.0.1:' + server.address().port;
  const clickText = async text => page.evaluate(text => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text);
    if (!button) throw Error('Missing button: ' + text);
    button.click();
  }, text);
  const assertRows = async names => assert.deepEqual(await page.$$eval('tbody tr', rows => rows
    .filter(row => row.querySelector('button[aria-pressed]'))
    .map(row => row.querySelector('td .font-medium')?.textContent)), names);
  const typeGroup = async group => page.$eval('input[list]', (input, group) => {
    input.value = group; input.dispatchEvent(new Event('input', { bubbles: true }));
  }, group);
  const waitIdle = () => page.waitForFunction(() => !document.querySelector('select[aria-label="分组筛选"]')?.disabled);
  await page.setViewport({ width: 1280, height: 850 });
  await page.goto(origin + '/options.html');
  await page.waitForSelector('tbody button[aria-pressed]');
  await assertRows(['旧账户', '工作账户', '个人账户']);
  await page.select('select[aria-label="分组筛选"]', '工作');
  await assertRows(['工作账户']);
  // Native keyboard activation of the shared star must not trigger the global copy shortcut.
  await page.focus('tbody button[aria-label="取消收藏"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('tbody button[aria-label="收藏"]');
  await waitIdle();
  assert.equal(await page.evaluate(() => window.openpassFixture.copies), 0);
  await page.click('input[type="checkbox"]');
  await assertRows([]);
  assert.match(await page.$eval('tbody', el => el.textContent), /未找到匹配结果/);
  await page.click('input[type="checkbox"]');
  await page.click('tbody button[title="编辑"]');
  await page.waitForSelector('input[list]');
  assert.equal(await page.$eval('input[list]', input => input.value), '工作');
  await typeGroup('项目');
  await clickText('保存');
  await page.waitForFunction(() => !document.querySelector('.modal-overlay'));
  await waitIdle();
  await page.select('select[aria-label="分组筛选"]', '项目');
  await assertRows(['工作账户']);
  await page.screenshot({ path: join(screenshots, 'manager.png') });
  await clickText('删除分组');
  await page.waitForFunction(() => ![...document.querySelectorAll('option')].some(option => option.value === '项目'));
  await waitIdle();
  await assertRows(['旧账户', '工作账户', '个人账户']);
  await page.select('select[aria-label="分组筛选"]', '');
  await assertRows(['旧账户', '工作账户']);
  await page.reload();
  await page.waitForSelector('tbody button[aria-pressed]');
  await assertRows(['旧账户', '工作账户', '个人账户']);
  // Popup sees the same persisted organization and can edit it in place.
  await page.setViewport({ width: 420, height: 760 });
  await page.goto(origin + '/popup.html');
  await page.waitForSelector('button[aria-label="收藏"]');
  await page.click('button[aria-label="收藏"]');
  await page.waitForSelector('button[aria-label="取消收藏"]');
  await waitIdle();
  await page.click('input[type="checkbox"]');
  await page.waitForFunction(() => document.querySelectorAll('button[aria-pressed]').length === 1);
  await page.screenshot({ path: join(screenshots, 'popup.png') });
  assert.match(await page.$eval('main', el => el.textContent), /工作账户/);
  await page.select('select[aria-label="分组筛选"]', '个人');
  await page.waitForFunction(() => document.querySelectorAll('button[aria-pressed]').length === 0);
  await page.click('input[type="checkbox"]');
  await page.waitForFunction(() => document.querySelectorAll('button[aria-pressed]').length === 1);
  await page.click('button[title="编辑"]');
  await page.waitForSelector('input[list]');
  await typeGroup('家庭');
  await clickText('保存修改');
  await page.waitForSelector('select[aria-label="分组筛选"]');
  await waitIdle();
  await page.select('select[aria-label="分组筛选"]', '家庭');
  await page.waitForSelector('button[aria-label="收藏"]');
  // A failed save must restore the previous star and keep the page usable.
  await page.evaluate(() => { window.openpassFixture.failSave = true; });
  await page.click('button[aria-label="收藏"]');
  await page.waitForFunction(() => document.querySelector('.openpass-toast')?.textContent.includes('fixture concurrent update'));
  await waitIdle();
  assert.equal(await page.$eval('button[aria-pressed]', el => el.getAttribute('aria-pressed')), 'false');
  await page.evaluate(() => { window.openpassFixture.failSave = false; });
  await clickText('删除分组');
  await page.waitForFunction(() => ![...document.querySelectorAll('option')].some(option => option.value === '家庭'));
  await waitIdle();
  assert.equal(await page.evaluate(() => window.openpassFixture.accounts.length), 3);
  await page.setViewport({ width: 1280, height: 850 });
  await page.goto(origin + '/options.html');
  await page.waitForSelector('tbody button[aria-pressed]');
  await page.click('input[type="checkbox"]');
  await assertRows(['工作账户']);
  await page.setViewport({ width: 420, height: 760 });
  await page.goto(origin + '/popup.html?locked');
  await page.waitForSelector('select[aria-label="分组筛选"]');
  await page.click('input[type="checkbox"]');
  await page.waitForSelector('button[aria-label="取消收藏"]');
  assert.match(await page.$eval('main', el => el.textContent), /工作账户/);
  // Follow the popup manager entry, then submit the real password form with native Enter.
  await page.click('button[title="更多操作"]');
  await clickText('打开管理页面');
  const managerUrl = await page.evaluate(() => window.openpassFixture.opened.at(-1));
  assert.equal(managerUrl, origin + '/options.html');
  await page.goto(managerUrl);
  await page.waitForSelector('#password');
  assert.match(page.url(), /auth\.html\?redirect=options\.html/);
  await page.type('#password', 'wrong-password');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role="alert"]');
  assert.match(await page.$eval('[role="alert"]', el => el.textContent), /主密码错误/);
  await page.waitForFunction(() => !document.querySelector('#password').disabled);
  await page.type('#password', password);
  await page.keyboard.press('Enter');
  await page.waitForSelector('tbody button[aria-pressed]');
  assert.equal(new URL(page.url()).pathname, '/options.html');
  await assertRows(['旧账户', '工作账户', '个人账户']);
  // Extension-details/direct entry with an existing session must work as well.
  await page.goto(origin + '/options.html');
  await page.waitForSelector('tbody button[aria-pressed]');
  // Migration/session failures stay visible rather than silently returning to the password page.
  await page.goto(origin + '/popup.html?locked');
  await page.waitForSelector('select[aria-label="分组筛选"]');
  await page.goto(origin + '/options.html');
  await page.waitForSelector('#password');
  await page.evaluate(() => { window.openpassFixture.migrationError = 'fixture unlock migration failed'; });
  await page.type('#password', password);
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role="alert"]');
  assert.match(await page.$eval('[role="alert"]', el => el.textContent), /fixture unlock migration failed/);
  await page.waitForFunction(() => !document.querySelector('#password').disabled);
  await page.evaluate(() => { window.openpassFixture.migrationError = ''; });
  await page.click('#password', { clickCount: 3 });
  await page.type('#password', password);
  await clickText('解锁');
  await page.waitForSelector('tbody button[aria-pressed]');
  assert.deepEqual(errors, []);
  console.log('Account organization UI passed: manager/popup filters, keyboard favorites, edits, group deletion, persistence, rollback and locked viewing.');
  console.log('Authentication UI passed: popup manager entry + Enter, direct manager entry, wrong password, visible migration errors and button unlock.');
  console.log('Screenshots: ' + screenshots);
} catch (error) {
  if (page && !page.isClosed()) {
    console.error('Synthetic UI fixture failed at:', page.url());
    console.error(await page.$eval('body', body => body.innerText));
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
