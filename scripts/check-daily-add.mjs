// Real production extension, isolated Chrome profile, synthetic GitHub QR/page.
// No real site/account, user profile, clipboard or provider is accessed.
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { webcrypto, createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const fixture = await mkdtemp(join(tmpdir(), 'openpass-daily-add-'));
const profile = join(fixture, 'profile');
const downloads = join(fixture, 'downloads');
const extension = join(fixture, 'extension');
await mkdir(join(profile, 'Default'), { recursive: true }); await mkdir(downloads);
await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
await writeFile(join(extension, 'fixture.html'), '<!doctype html><title>Isolated setup fixture</title>');
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.permissions.push('downloads'); // fixture-only pregrant for backup completion
manifest.optional_permissions = manifest.optional_permissions.filter(value => value !== 'downloads');
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
const password = 'fixture-master-password';
const salt = webcrypto.getRandomValues(new Uint8Array(16));
const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
const verifier = Buffer.from(await webcrypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, base, 256)).toString('base64');
const old = { id: 'original', site: 'original.example', secret: 'JBSWY3DPEHPK3PXP', name: 'Original',
  type: 'totp', digits: 6, algorithm: 'SHA1', period: 30, counter: 0,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z', group: '工作', favorite: true };
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, base,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify([old])));
const encryptedSecrets = Buffer.concat([salt, iv, Buffer.from(ciphertext)]).toString('base64');
const decode = async ciphertext => {
  const versionPrefix = 'openpass-v2:';
  const v2 = ciphertext.startsWith(versionPrefix);
  const bytes = Buffer.from(v2 ? ciphertext.slice(versionPrefix.length) : ciphertext, 'base64');
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: bytes.subarray(0, 16), iterations: v2 ? 300000 : 100000, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const params = { name: 'AES-GCM', iv: bytes.subarray(16, 28), ...(v2 ? { additionalData: Buffer.from(versionPrefix) } : {}) };
  return JSON.parse(new TextDecoder().decode(await webcrypto.subtle.decrypt(params, key, bytes.subarray(28))));
};
const qr = JSON.parse(await readFile('src/utils/fixtures/github-otp-qr.json', 'utf8'));
const cells = qr.rows.flatMap((row, y) => [...row].flatMap((cell, x) => cell === '1' ? [`<rect x="${x}" y="${y}" width="1" height="1"/>`] : [])).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${qr.rows.length}" height="${qr.rows.length}" viewBox="0 0 ${qr.rows.length} ${qr.rows.length}"><g fill="black">${cells}</g></svg>`;
const url = 'https://github.com/settings/two_factor_authentication/setup/intro';
const expectedFixtureCodes = () => {
  const timeStep = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].map(offset => {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(timeStep + offset));
    const hash = createHmac('sha1', Buffer.from('12345678901234567890')).update(counter).digest();
    const index = hash[19] & 15;
    return String((hash.readUInt32BE(index) & 0x7fffffff) % 1000000).padStart(6, '0');
  });
};
const launch = () => puppeteer.launch({
  executablePath: process.env.OPENPASS_CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
  headless: true, pipe: true, userDataDir: profile, enableExtensions: [extension], args: ['--no-first-run']
});
const getWorker = async browser => {
  const target = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url().includes('background.js'));
  const url = new URL(target.url());
  return { worker: await target.worker(), origin: `${url.protocol}//${url.host}` };
};
const openPopup = async (browser, worker) => {
  await worker.evaluate(() => chrome.action.openPopup());
  const target = await browser.waitForTarget(target => target.url().endsWith('/popup.html'));
  // Chrome exposes its native extension popup as an "other" target.
  const page = await target.asPage(); await page.waitForSelector('button[aria-label="点选二维码"]');
  return page;
};
const fixturePage = async (browser, origin) => { const page = await browser.newPage(); await page.goto(origin + '/fixture.html'); return page; };
const ensureNoNavigation = async browser => {
  assert.equal((await browser.pages()).filter(page => /\/(?:auth|options)\.html/.test(page.url())).length, 0);
};
let browser;
try {
  browser = await launch();
  let { worker, origin } = await getWorker(browser);
  const setup = await fixturePage(browser, origin);
  console.log('TEST_CONTEXT', fixture, await browser.version());
  await setup.evaluate(async state => {
    await chrome.storage.local.set(state);
    const result = await chrome.runtime.sendMessage({ action: 'migrateVaultForUnlock', password: 'fixture-master-password' });
    if (!result.success) throw Error(result.error);
    await chrome.storage.session.clear(); await chrome.storage.local.remove(['sessionExpiresAt']);
  }, { masterPasswordHash: 'pbkdf2-sha256$600000$' + verifier, masterPasswordSalt: Buffer.from(salt).toString('base64'), encryptedSecrets,
    isSetupComplete: true, welcomeCompleted: true, deviceOtpEnabled: true,
    enableAutoBackup: false, enableLocalSnapshot: true, enableDirectoryBackup: true,
    backupFileDestination: 'downloads', backupDownloadDirectory: 'OpenPass-Fixture', enableBackupEncryption: true, useMasterPasswordForBackup: true });
  await setup.close();
  for (const page of await browser.pages()) if (page.url().startsWith(origin)) await page.close();
  // Restart before scanning: both service-worker globals and the management
  // session are absent; the IndexedDB CryptoKeys must survive the restart.
  await browser.close(); browser = await launch(); ({ worker, origin } = await getWorker(browser));
  for (const page of await browser.pages()) if (page.url().startsWith(origin)) await page.close();
  const github = await browser.newPage(); await github.setRequestInterception(true);
  github.on('request', request => request.url() === url
    ? request.respond({ status: 200, contentType: 'text/html', body: `<!doctype html><title>Synthetic GitHub 2FA setup</title><img style="width:228px;height:228px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"><input id="otp"><button id="verify" onclick="document.body.dataset.confirmed=document.querySelector('#otp').value">Verify</button>` })
    : request.abort());
  await github.goto(url); await github.waitForSelector('img');
  // Unpacked-extension installation may finish opening its onboarding tab
  // after worker startup. Exclude that setup side effect before the scan.
  for (const page of await browser.pages()) if (page.url().startsWith(origin)) await page.close();
  await github.bringToFront();
  // Target the fixture explicitly while waiting for document_idle injection;
  // installation can briefly activate an onboarding tab in the meantime.
  await worker.evaluate(async expectedUrl => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === expectedUrl);
      try { await chrome.tabs.sendMessage(tab.id, { action: 'getPageQrSources' }); return; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    throw Error('The production content script did not initialize in the synthetic page');
  }, url);
  for (const page of await browser.pages()) if (page.url().startsWith(origin)) await page.close();
  await github.bringToFront();
  // A new scan must replace an older displayed draft, not merely update the
  // parent's props while leaving the form's old local fields on screen.
  await worker.evaluate(() => chrome.storage.session.set({ pendingQrDraft: {
    secret: { secret: 'JBSWY3DPEHPK3PXP', site: 'old-draft.example', name: 'Old draft' }, createdAt: Date.now() - 1000
  } }));
  const initialOpenStarted = Date.now();
  let popup = await openPopup(browser, worker);
  const initialPopupMs = Date.now() - initialOpenStarted;
  console.log('Native popup opened after browser restart with management locked.');
  const originalPopup = popup.target();
  const pickerButton = 'button[aria-label="点选二维码"]';
  assert.equal(await popup.$eval(pickerButton, button => button.textContent.trim()), '点选二维码');
  const pickerStarted = Date.now();
  await popup.click(pickerButton);
  await github.waitForSelector('.openpass-qr-selecting');
  const pickerMs = Date.now() - pickerStarted;
  const imageBounds = await github.$eval('img', img => img.getBoundingClientRect().toJSON());
  await github.mouse.move(imageBounds.x + 20, imageBounds.y + 20);
  await github.waitForFunction(width => document.querySelector('.openpass-qr-selection')?.getBoundingClientRect().width === width,
    {}, imageBounds.width);
  const clickStarted = Date.now();
  await github.mouse.click(imageBounds.x + 20, imageBounds.y + 20);
  const scannedPopup = await browser.waitForTarget(target => target !== originalPopup && target.url().endsWith('/popup.html'));
  const popupTargetMs = Date.now() - clickStarted;
  popup = await scannedPopup.asPage();
  await popup.waitForFunction(() => document.querySelector('h2')?.textContent.trim() === '添加密钥');
  await popup.waitForFunction(() => document.querySelector('input[placeholder="例如: github.com"]')?.value === 'github.com');
  await popup.waitForFunction(() => /\d{3} \d{3}/.test(document.body.innerText));
  const previewMs = Date.now() - clickStarted;
  const draftReadyAt = await worker.evaluate(async () => (await chrome.storage.session.get(['pendingQrDraft'])).pendingQrDraft.createdAt);
  const scanTiming = { initialPopupMs, pickerMs, recognitionMs: draftReadyAt - clickStarted, popupTargetMs, previewMs };
  console.log('QR_TIMING', JSON.stringify(scanTiming));
  assert.equal(github.url(), url); await ensureNoNavigation(browser);
  assert.equal(await worker.evaluate(async () => !!(await chrome.storage.session.get(['sessionKey'])).sessionKey), false);
  await popup.close();
  popup = await openPopup(browser, worker);
  await popup.waitForFunction(() => document.querySelector('h2')?.textContent.trim() === '添加密钥');
  await popup.screenshot({ path: join(fixture, 'qr-confirmation.png') });
  const saveBounds = await popup.$eval('button[type="submit"]', button => {
    const rect = button.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, width: rect.width, height: innerHeight,
      layout: ['html', 'body', '#app', '#app > div', 'main', 'form'].map(selector => {
        const element = document.querySelector(selector);
        return [selector, element?.getBoundingClientRect().height, element && getComputedStyle(element).height];
      }) };
  });
  assert.ok(saveBounds.top >= 0 && saveBounds.bottom <= saveBounds.height && saveBounds.width > 0,
    'Save stays visible in the native popup without scrolling: ' + JSON.stringify(saveBounds));
  await popup.click('.otp-advanced > summary');
  await popup.waitForSelector('.otp-advanced[open] select');
  const advancedLayout = await popup.$eval('.popup-form-scroll', scroller => {
    scroller.scrollTop = scroller.scrollHeight;
    const advanced = scroller.querySelector('.otp-advanced');
    return { scrollOffset: scroller.scrollTop, scrollbarWidth: getComputedStyle(scroller).scrollbarWidth,
      gutter: scroller.getBoundingClientRect().right - advanced.getBoundingClientRect().right,
      digitsControls: [...advanced.querySelectorAll('select')].filter(select => [...select.options].some(option => option.textContent === '8 位')).length };
  });
  assert.ok(advancedLayout.scrollOffset > 0 && advancedLayout.gutter >= 8);
  assert.equal(advancedLayout.scrollbarWidth, 'thin');
  assert.equal(advancedLayout.digitsControls, 1);
  await popup.screenshot({ path: join(fixture, 'qr-advanced.png') });
  await popup.click('button[type="submit"]');
  await popup.waitForFunction(() => !!document.querySelector('button[title="添加密钥"]') && !document.querySelector('form'));
  await popup.screenshot({ path: join(fixture, 'account-list.png') });
  const stored = await worker.evaluate(() => chrome.storage.local.get(['encryptedSecrets', 'backupSnapshots']));
  assert.ok(stored.encryptedSecrets.startsWith('openpass-v2:'));
  assert.equal(stored.backupSnapshots[0].data.encryptionVersion, 2);
  const records = await decode(stored.encryptedSecrets);
  assert.equal(records.length, 2); assert.deepEqual(records[0], old);
  assert.equal(records[1].site, 'github.com');
  assert.equal((await decode(stored.backupSnapshots[0].data.encryptedData)).length, 2);
  // Confirm the website using the newly stored account's real generated TOTP.
  await popup.waitForFunction(() => /\d{3} \d{3}/.test(document.querySelector('[title="GitHub"]')?.closest('.group')?.textContent || ''));
  const account = await popup.$eval('[title="GitHub"]', el => el.closest('.group').textContent);
  const displayedCodes = account.match(/\d{3} \d{3}/g) || [];
  const expectedCodes = expectedFixtureCodes();
  const code = displayedCodes.map(value => value.replace(' ', '')).find(value => expectedCodes.includes(value));
  assert.ok(code, 'The stored GitHub account must generate the expected TOTP');
  await popup.close();
  const normalOpenStarted = Date.now();
  popup = await openPopup(browser, worker);
  scanTiming.toolbarShellMs = Date.now() - normalOpenStarted;
  await popup.waitForFunction(() => /\d{3} \d{3}/.test(document.querySelector('[title="GitHub"]')?.closest('.group')?.textContent || ''));
  scanTiming.toolbarMatchedCodeMs = Date.now() - normalOpenStarted;
  assert.equal(await popup.$$eval('main [title="复制验证码"]', buttons => buttons.length), 1);
  console.log('TOOLBAR_TIMING', JSON.stringify({ shellMs: scanTiming.toolbarShellMs, matchedCodeMs: scanTiming.toolbarMatchedCodeMs }));
  await popup.close(); await github.type('#otp', code); await github.click('#verify');
  assert.equal(await github.$eval('body', el => el.dataset.confirmed), code);
  await ensureNoNavigation(browser);
  const controller = await fixturePage(browser, origin);
  const protectedResult = await controller.evaluate(() => chrome.runtime.sendMessage({ action: 'setDeviceOtpEnabled', enabled: false }));
  assert.ok(protectedResult.error.includes('锁定'));
  const extra = await controller.evaluate(() => chrome.runtime.sendMessage({ action: 'appendAccount', account: { site: 'extra.example', secret: 'JBSWY3DPEHPK3PXP' } }));
  assert.equal(extra.success, true);
  assert.ok(extra.secrets.every(entry => entry.secret === undefined));
  // An older installation has the OTP copy but no daily write key. Its one-time
  // initialization stays inside the popup and resumes the already filled form.
  await controller.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('OpenPassDailyWriteDB');
    request.onsuccess = resolve; request.onerror = () => reject(request.error);
  }));
  popup = await openPopup(browser, worker);
  await popup.click('button[title="添加密钥"]');
  await popup.type('input[placeholder="输入密钥"]', 'JBSWY3DPEHPK3PXP');
  await popup.$eval('input[placeholder="例如: github.com"]', el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await popup.type('input[placeholder="例如: github.com"]', 'initialized.example');
  await popup.click('button[type="submit"]');
  await popup.waitForSelector('input[type="password"]');
  await ensureNoNavigation(browser); assert.equal(github.url(), url);
  await popup.type('input[type="password"]', password);
  await popup.click('form .btn-primary');
  await popup.waitForFunction(() => !document.querySelector('form'));
  const initialized = await worker.evaluate(() => chrome.storage.local.get(['encryptedSecrets']));
  assert.equal((await decode(initialized.encryptedSecrets)).length, 4);
  await popup.close();
  await controller.evaluate(async () => {
    await chrome.storage.session.clear(); await chrome.storage.local.remove(['sessionExpiresAt']);
    await chrome.storage.local.set({ enableAutoBackup: true });
  });
  const backup = await controller.evaluate(() => chrome.runtime.sendMessage({ action: 'testAutoBackup' }));
  assert.equal(backup.success, true);
  const files = await readdir(join(downloads, 'OpenPass-Fixture'));
  assert.equal(files.length, 1);
  const exported = JSON.parse(await readFile(join(downloads, 'OpenPass-Fixture', files[0]), 'utf8'));
  assert.equal(exported.encrypted, true); assert.equal(exported.secrets, undefined);
  assert.equal((await decode(exported.encryptedData)).length, 4);

  await controller.bringToFront();
  popup = await openPopup(browser, worker);
  const pasteText = text => popup.evaluate(text => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    (document.querySelector('#popup-quick-add') || document.body).dispatchEvent(new ClipboardEvent('paste', {
      clipboardData, bubbles: true, cancelable: true
    }));
  }, text);
  const saveDraft = async () => {
    await popup.waitForSelector('button[type="submit"]:not([disabled])');
    await popup.click('button[type="submit"]');
    try { await popup.waitForFunction(() => !document.querySelector('form'), { timeout: 10000 }); }
    catch (error) { console.error(await popup.$eval('body', el => el.innerText)); throw error; }
    await ensureNoNavigation(browser);
  };
  await popup.click('button[title="添加密钥"]');
  await pasteText('otpauth://hotp/Fixture?secret=JBSWY3DPEHPK3PXP&issuer=clipboard.example&counter=42&digits=8');
  await popup.waitForFunction(() => document.body.innerText.includes('计数器 42'));
  assert.equal(await popup.$eval('input[placeholder="例如: github.com"]', el => el.value), 'clipboard.example');
  await saveDraft();

  const readPreviewStorage = () => worker.evaluate(async () => ({
    ...(await chrome.storage.local.get(['encryptedSecrets', 'backupSnapshots'])),
    ...(await chrome.storage.session.get(['pendingQrDraft', 'sessionKey']))
  }));
  const beforePreview = await readPreviewStorage();
  const pngUrl = await popup.evaluate(async rows => {
    const canvas = document.createElement('canvas');
    const scale = 4;
    canvas.width = canvas.height = rows.length * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[y].length; x++) {
      if (rows[y][x] === '1') ctx.fillRect(x * scale, y * scale, scale, scale);
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([blob], 'fixture.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    return canvas.toDataURL('image/png');
  }, qr.rows);
  await popup.waitForFunction(() => document.body.innerText.includes('验证码预览'));
  const unrelatedSite = await popup.$eval('input[placeholder="例如: github.com"]', el => el.value);
  assert.equal(unrelatedSite, '');

  assert.equal(beforePreview.pendingQrDraft, undefined);
  assert.equal(beforePreview.sessionKey, undefined);
  assert.deepEqual(await readPreviewStorage(), beforePreview);
  await popup.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async code => {
      window.copiedPreviewCode = code;
    } });
  });
  await popup.click('button[title="复制预览验证码"]');
  await popup.waitForFunction(() => /^\d{6}$/.test(window.copiedPreviewCode));
  const copiedCode = await popup.evaluate(() => window.copiedPreviewCode);
  assert.ok(expectedFixtureCodes().includes(copiedCode));
  await popup.close();
  await controller.bringToFront();
  popup = await openPopup(browser, worker);
  await popup.waitForFunction(() => document.body.innerText.includes('当前站点没有匹配的账户') && !document.querySelector('form'));
  assert.deepEqual(await readPreviewStorage(), beforePreview);
  await ensureNoNavigation(browser);

  const sharedImagePath = join(fixture, 'shared-qr.png');
  await writeFile(sharedImagePath, Buffer.from(pngUrl.split(',')[1], 'base64'));
  await popup.click('button[title="添加密钥"]');
  const selectedImage = await popup.waitForSelector('input[aria-label="选择验证码二维码图片"]');
  await selectedImage.uploadFile(sharedImagePath);
  await popup.waitForSelector('button[title="复制预览验证码"]');
  await popup.type('input[placeholder="例如: github.com"]', 'copied-image.example');
  await saveDraft();

  const imageUrl = 'https://clipboard-image.example/otp.png';
  await popup.setRequestInterception(true);
  const serveImage = request => request.url() === imageUrl
    ? request.respond({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' },
      body: Buffer.from(pngUrl.split(',')[1], 'base64') })
    : request.continue();
  popup.on('request', serveImage);
  await popup.click('button[title="添加密钥"]');
  await pasteText(imageUrl);
  await popup.waitForFunction(() => document.body.innerText.includes('验证码预览'));
  await popup.type('input[placeholder="例如: github.com"]', 'copied-address.example');
  await saveDraft();
  popup.off('request', serveImage);
  await popup.setRequestInterception(false);
  assert.equal(await worker.evaluate(async () => !!(await chrome.storage.session.get(['sessionKey'])).sessionKey), false);

  const batch = 'otpauth-migration://offline?data=Ci0KFDEyMzQ1Njc4OTAxMjM0NTY3ODkwEgVBbGljZRoGR29vZ2xlIAEoATACOAAKQQoO%2B%2B%2F%2FYWJjZDEyMzQ1NjcSGeekuuS%2BizphbGljZUBleGFtcGxlLnRlc3QaDGV4YW1wbGUudGVzdCADKAIwATgqEAIYASAA';
  await pasteText(batch);
  await popup.waitForSelector('[role="dialog"] button[type="submit"]');
  assert.equal(await popup.$eval('[role="dialog"] button[type="submit"]', el => el.textContent.trim()), '解锁并导入');
  await popup.click('[role="dialog"] button[type="submit"]');
  await popup.waitForSelector('input[type="password"]');
  await popup.type('input[type="password"]', password);
  await popup.click('form .btn-primary');
  await popup.waitForFunction(() => document.body.innerText.includes('跳过 1 个重复账户'));
  await ensureNoNavigation(browser);
  assert.equal(github.url(), url);
  const pasted = await worker.evaluate(() => chrome.storage.local.get(['encryptedSecrets']));
  const imported = await decode(pasted.encryptedSecrets);
  assert.equal(imported.length, 8);
  assert.ok(imported.some(entry => entry.site === 'clipboard.example' && entry.counter === 42 && entry.digits === 8));
  assert.ok(imported.some(entry => entry.site === 'copied-image.example'));
  assert.ok(imported.some(entry => entry.site === 'copied-address.example'));
  assert.ok(imported.some(entry => entry.site === 'example.test' && entry.type === 'hotp'));

  const uploadAuthenticatorBackup = async path => {
    await popup.click('button[title="添加密钥"]');
    await popup.waitForSelector('::-p-text(导入备份)');
    await popup.click('::-p-text(导入备份)');
    const fileInput = await popup.waitForSelector('#authenticator-import-file');
    await fileInput.uploadFile(path);
  };
  const confirmAuthenticatorBackup = async source => {
    const submit = '[role="dialog"] button[type="submit"]';
    await popup.waitForFunction(name => document.querySelector('[role="dialog"]')?.innerText.includes(`${name} · 1 个可导入账户`), {}, source);
    await popup.click(submit);
    await popup.waitForSelector('[role="dialog"]', { hidden: true });
  };

  const aegisPath = join(fixture, 'aegis.json');
  await writeFile(aegisPath, JSON.stringify({ version: 1, header: {}, db: {
    version: 3, entries: [{ type: 'totp', name: 'File fixture', issuer: 'aegis.example', info: {
      secret: 'MFRGGZDFMZTWQ2LK', algo: 'SHA1', digits: 6, period: 30
    } }]
  } }));
  await uploadAuthenticatorBackup(aegisPath);
  await confirmAuthenticatorBackup('Aegis');

  const backupPassword = 'fixture-backup-password';
  const backupSalt = webcrypto.getRandomValues(new Uint8Array(16));
  const backupIv = webcrypto.getRandomValues(new Uint8Array(12));
  const backupBase = await webcrypto.subtle.importKey('raw', Buffer.from(backupPassword), 'PBKDF2', false, ['deriveKey']);
  const backupKey = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: backupSalt, iterations: 10000, hash: 'SHA-256' },
    backupBase, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const protectedServices = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: backupIv }, backupKey, Buffer.from(JSON.stringify([
    { name: 'Encrypted file fixture', secret: 'GEZDGNBVGY3TQOJQ', otp: { issuer: 'twofas.example', tokenType: 'TOTP' } }
  ])));
  const twoFasPath = join(fixture, 'protected.2fas');
  const servicesEncrypted = [protectedServices, backupSalt, backupIv].map(bytes => Buffer.from(bytes).toString('base64')).join(':');
  await writeFile(twoFasPath, JSON.stringify({ schemaVersion: 4, servicesEncrypted }));
  await uploadAuthenticatorBackup(twoFasPath);
  await popup.waitForSelector('#authenticator-backup-password');
  await popup.type('#authenticator-backup-password', backupPassword);
  await popup.click('[role="dialog"] button[type="submit"]');
  await confirmAuthenticatorBackup('2FAS');
  await ensureNoNavigation(browser);
  const withBackups = await decode((await worker.evaluate(() => chrome.storage.local.get(['encryptedSecrets']))).encryptedSecrets);
  assert.equal(withBackups.length, 10);
  assert.ok(withBackups.some(entry => entry.site === 'aegis.example'));
  assert.ok(withBackups.some(entry => entry.site === 'twofas.example'));

  const report = { browser: await browser.version(), fixture, scanTiming, qrSourceRetained: true, popupDraftRetained: true, qrElementPicker: true,
    appendedWithoutManagementSession: true, originalMetadataPreserved: true, syntheticWebsiteConfirmed: true,
    managementStillProtected: true, inlineInitializationResumed: true, backupIncludesAllAccounts: true,
    clipboardUrl: true, clipboardImage: true, imageAddress: true, batchImportedInPopup: true,
    aegisImportedInPopup: true, encrypted2FasImportedInPopup: true, sharedImagePreviewLeftVaultUntouched: true };
  await writeFile(join(fixture, 'report.json'), JSON.stringify(report, null, 2));
  console.log('PASS: isolated real extension restart, password-free scan/preview/add, original page and popup draft retained, synthetic website confirmation, management denial and complete encrypted backup.');
  console.log('PASS: pasted OTP URL, clipboard image, image address and Google Authenticator batch stay in the popup.');
  console.log('PASS: a shared image can be previewed and copied without permission to manage the vault or retention after popup closure.');
  console.log('PASS: Aegis and password-protected 2FAS file imports stay in the popup.');
  console.log(JSON.stringify(report));
} finally { await browser?.close(); }
