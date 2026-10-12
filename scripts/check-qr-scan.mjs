// Use production background/content bundles and the real jsQR decoder with public synthetic OTP data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
import puppeteer from 'puppeteer-core';

const fixture = JSON.parse(await readFile('src/utils/fixtures/github-otp-qr.json', 'utf8'));
const size = fixture.rows.length;
const cells = fixture.rows.flatMap((row, y) => [...row].flatMap((cell, x) => cell === '1'
  ? [`<rect x="${x}" y="${y}" width="1" height="1"/>`] : [])).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><g fill="black">${cells}</g></svg>`;
const source = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
// Optional local regression input; its image data and decoded OTP payload are never printed or saved.
const suppliedHtml = process.env.OPENPASS_QR_HTML_FIXTURE
  ? await readFile(process.env.OPENPASS_QR_HTML_FIXTURE, 'utf8') : null;
const suppliedSource = suppliedHtml?.match(/<img\b[^>]*\bsrc=["'](data:image\/[^"']+)["']/i)?.[1];
if (suppliedHtml !== null) assert.ok(suppliedSource, 'Local HTML fixture must include a data image');
const root = resolve('.output/chrome-mv3');
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/fixture.html') { res.setHeader('content-type', 'text/html'); res.end('<html><body></body></html>'); return; }
    const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
    res.setHeader('content-type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.OPENPASS_CHROME_PATH || (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome') });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = 'http://127.0.0.1:' + server.address().port;
  await page.goto(origin + '/fixture.html');
  // The test supplies its own document and API surface before loading either production bundle.
  await page.setContent('<html><body><img id="qr" style="position:absolute;left:160px;top:100px;width:148px;height:148px;filter:contrast(.5)"><div style="position:absolute;left:170px;top:120px;width:250px;height:200px;background:#ddd;z-index:100">Context menu covering the QR</div></body></html>');
  await page.evaluate(async source => {
    const image = document.querySelector('#qr');
    image.src = source; await image.decode();
    const local = { isSetupComplete: true, deviceOtpEnabled: false, sessionExpiresAt: Date.now() + 600000 };
    const session = { sessionKey: 'fixture-master', sessionExpiresAt: local.sessionExpiresAt };
    const runtimeListeners = [];
    const changedListeners = [];
    const control = { menuClick: null, popups: 0, captures: 0, notifications: [], requests: [], local, session, runtimeListeners,
      screenshot: null, imageReply: null, failImageReply: false, failPageReply: false };
    window.qrFixture = control;
    const event = () => ({ addListener() {}, removeListener() {} });
    const area = (values, name) => ({
      get: async keys => Object.fromEntries(keys.map(key => [key, values[key]])),
      set: async updates => {
        Object.assign(values, updates);
        const changes = Object.fromEntries(Object.entries(updates).map(([key, value]) => [key, { newValue: value }]));
        queueMicrotask(() => changedListeners.forEach(listener => listener(changes, name)));
      },
      remove: async keys => { keys.forEach(key => delete values[key]); }, setAccessLevel: async () => {}
    });
    const tab = { id: 7, windowId: 1, url: 'https://github.com/settings/security', active: true };
    const sendToListener = (listener, request, sender) => new Promise((resolve, reject) => {
      try { if (listener(request, sender, resolve) !== true) resolve(undefined); } catch (error) { reject(error); }
    });
    Object.defineProperty(window, 'chrome', { configurable: true, value: {
      runtime: { id: 'fixture-extension', getURL: path => location.origin + '/' + path,
        getManifest: () => ({ version: '0.3.0' }), onInstalled: event(), onStartup: event(),
        onMessage: { addListener: listener => runtimeListeners.push(listener) },
        sendMessage: request => sendToListener(runtimeListeners[0], request, request.action === 'startQrScan'
          ? { id: 'fixture-extension', url: location.origin + '/popup.html' }
          : { id: 'fixture-extension', url: tab.url, tab }) },
      storage: { local: area(local, 'local'), session: area(session, 'session'),
        onChanged: { addListener: listener => changedListeners.push(listener) } },
      contextMenus: { onClicked: { addListener: listener => { control.menuClick = listener; } } },
      tabs: { query: async () => [tab], onUpdated: event(), onActivated: event(),
        sendMessage: async (id, request, options) => {
          control.requests.push({ action: request.action, frameId: options?.frameId });
          if (request.action === 'getQrImage' && control.failImageReply) return control.imageReply;
          if (request.action === 'getPageQrSources' && control.failPageReply) return [];
          return sendToListener(runtimeListeners.at(-1), request, { id: 'fixture-extension' });
        },
        captureVisibleTab: async () => {
          control.captures++;
          if (!control.screenshot) throw Error('QR image scanning must not depend on a covered screenshot');
          return control.screenshot;
        } },
      notifications: { create: async value => { control.notifications.push(value); return 'fixture'; } },
      alarms: { clear: async () => true, create: async () => {}, onAlarm: event() },
      action: { openPopup: async () => { control.popups++; } }
    } });
  }, source);
  await page.addScriptTag({ url: origin + '/background.js' });
  await page.addScriptTag({ url: origin + '/content-scripts/content.js' });
  await page.waitForFunction(() => window.qrFixture.runtimeListeners.length === 2 && typeof window.qrFixture.menuClick === 'function');
  const scan = async (expectedPopups, frameId = 0, mode = 'image') => {
    await page.evaluate(({ frameId, mode }) => {
      if (mode === 'popup') { void chrome.runtime.sendMessage({ action: 'startQrScan' }); return; }
      const image = document.querySelector('#qr');
      window.qrFixture.menuClick({ menuItemId: 'parseQRCode', frameId,
        ...(mode === 'image' ? { mediaType: 'image', srcUrl: image.src } : {}) },
        { id: 7, windowId: 1, url: 'https://github.com/settings/security', active: true });
    }, { frameId, mode });
    await page.waitForFunction(count => window.qrFixture.popups === count, {}, expectedPopups);
    const result = await page.evaluate(() => ({
      site: window.qrFixture.session.pendingSecret?.site, name: window.qrFixture.session.pendingSecret?.name,
      type: window.qrFixture.session.pendingSecret?.type, captures: window.qrFixture.captures,
      notifications: window.qrFixture.notifications.length
    }));
    assert.equal(result.site, 'github.com'); assert.equal(result.name, 'GitHub'); assert.equal(result.type, 'totp');
    assert.equal(result.notifications, 0);
    return result;
  };
  // SVG with transparent whitespace, dense modules, CSS scaling/highlight and a covering menu.
  assert.equal((await scan(1)).captures, 0);
  assert.equal((await scan(2, 0, 'page')).captures, 0);
  assert.equal((await scan(3, 0, 'popup')).captures, 0);
  await page.evaluate(() => {
    const image = document.querySelector('#qr');
    const canvas = document.createElement('canvas'); canvas.id = 'qr-canvas';
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.style.cssText = image.style.cssText;
    canvas.getContext('2d').drawImage(image, 0, 0);
    document.body.append(canvas); image.style.display = 'none';
  });
  assert.equal((await scan(4, 0, 'page')).captures, 0);
  await page.evaluate(() => { document.querySelector('#qr').style.display = ''; });
  // The same account rendered as an image and canvas is imported only once.
  assert.equal((await scan(5, 0, 'popup')).captures, 0);
  await page.evaluate(() => { document.querySelector('#qr-canvas').remove(); });
  await page.evaluate(async () => {
    const image = document.querySelector('#qr');
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    image.src = canvas.toDataURL('image/png'); await image.decode();
  });
  assert.equal((await scan(6)).captures, 0);
  // blob URLs must be read by the image's frame, without refetching from the service worker.
  await page.evaluate(async () => {
    const image = document.querySelector('#qr');
    image.src = URL.createObjectURL(await (await fetch(image.src)).blob()); await image.decode();
  });
  assert.equal((await scan(7, 4)).captures, 0);
  assert.ok(await page.evaluate(() => window.qrFixture.requests.some(request => request.action === 'getQrImage' && request.frameId === 4)));
  // A tainted/unreadable image can fall back to its precise screenshot crop, rather than another QR on the page.
  await page.evaluate(() => {
    const image = document.querySelector('#qr');
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 800, 600);
    context.imageSmoothingEnabled = false; context.drawImage(image, 160, 100, 148, 148);
    window.qrFixture.screenshot = canvas.toDataURL('image/png');
    window.qrFixture.failImageReply = true;
    window.qrFixture.imageReply = { rect: { x: 160 / 800, y: 100 / 600, width: 148 / 800, height: 148 / 600 } };
    image.src = 'data:image/png;base64,invalid';
  });
  assert.equal((await scan(8)).captures, 1);
  await page.evaluate(() => { window.qrFixture.failPageReply = true; });
  assert.equal((await scan(9, 0, 'popup')).captures, 2);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 800, 600);
    window.qrFixture.screenshot = canvas.toDataURL('image/png');
    void chrome.runtime.sendMessage({ action: 'startQrScan' });
  });
  await page.waitForSelector('.openpass-qr-overlay');
  assert.equal(await page.evaluate(() => window.qrFixture.popups), 9);
  assert.equal(await page.evaluate(() => window.qrFixture.captures), 3);
  // Once a user selects an area, skip image collection and scan just the supplied crop.
  await page.evaluate(async () => {
    window.qrFixture.requests.length = 0;
    await chrome.runtime.sendMessage({ action: 'scanQrSelection', rect: { x: 0, y: 0, width: .2, height: .2 } });
  });
  await page.waitForFunction(() => window.qrFixture.captures === 4);
  assert.equal(await page.evaluate(() => window.qrFixture.requests.some(request => request.action === 'getPageQrSources')), false);
  await page.keyboard.press('Escape');
  if (suppliedSource) {
    await page.evaluate(async src => {
      window.qrFixture.failPageReply = false; window.qrFixture.failImageReply = false;
      const image = document.querySelector('#qr'); image.src = src; await image.decode();
      window.qrFixture.menuClick({ menuItemId: 'parseQRCode' },
        { id: 7, windowId: 1, url: 'https://github.com/settings/security', active: true });
    }, suppliedSource);
    await page.waitForFunction(() => window.qrFixture.popups === 10);
    assert.equal(await page.evaluate(() => window.qrFixture.captures), 4);
    console.log('Supplied local SVG passed without screenshot fallback; decoded OTP data stayed in the isolated browser.');
  }
  assert.deepEqual(errors, []);
  console.log('QR scan passed: popup/page/image entries, image/canvas priority, duplicate accounts, PNG/SVG/blob, screenshot fallback, manual selection and crop-only retries.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
