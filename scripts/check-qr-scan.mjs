// Use production background/content bundles and the real jsQR decoder with public synthetic OTP data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
import puppeteer from 'puppeteer-core';

const fixture = JSON.parse(await readFile('src/utils/fixtures/github-otp-qr.json', 'utf8'));
const [migrationPartOne, migrationPartTwo, deviceRegistration] = JSON.parse(await readFile('src/utils/fixtures/authenticator-import-qr.json', 'utf8'));
function qrSource(rows) {
  const size = rows.length;
  const cells = rows.flatMap((row, y) => [...row].flatMap((cell, x) => cell === '1'
    ? [`<rect x="${x}" y="${y}" width="1" height="1"/>`] : [])).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><g fill="black">${cells}</g></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
const source = qrSource(fixture.rows);
// Optional local regression input; its image data and decoded OTP payload are never printed or saved.
const suppliedHtml = process.env.OPENPASS_QR_HTML_FIXTURE
  ? await readFile(process.env.OPENPASS_QR_HTML_FIXTURE, 'utf8') : null;
const suppliedSource = suppliedHtml?.match(/<img\b[^>]*\bsrc=["'](data:image\/[^"']+)["']/i)?.[1];
if (suppliedHtml !== null) assert.ok(suppliedSource, 'Local HTML fixture must include a data image');
const root = resolve('.output/chrome-mv3');
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/fixture.html') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<html><body></body></html>'); return; }
    const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
    res.setHeader('content-type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await puppeteer.launch({ headless: true, pipe: true,
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
    const control = { menuClick: null, installListeners: [], popups: 0, captures: 0, notifications: [], requests: [], local, session, runtimeListeners,
      screenshot: null, failPageReply: false, pickerFrameId: 0 };
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
        getManifest: () => ({ version: '0.3.0' }), onInstalled: { addListener: listener => control.installListeners.push(listener) }, onStartup: event(),
        onMessage: { addListener: listener => runtimeListeners.push(listener) },
        sendMessage: async request => {
          const result = await sendToListener(runtimeListeners[0], request, ['startQrScan', 'startQrElementPicker'].includes(request.action)
            ? { id: 'fixture-extension', url: location.origin + '/popup.html' }
            : { id: 'fixture-extension', url: tab.url, tab,
              frameId: request.action === 'scanQrSelection' ? control.pickerFrameId : 0 });
          // A scan initiated in the popup updates that same popup rather than
          // closing it and trying to reopen it. Count displayed results here.
          if (request.action === 'startQrScan' && result?.pendingDraft) control.popups++;
          return result;
        } },
      storage: { local: area(local, 'local'), session: area(session, 'session'),
        onChanged: { addListener: listener => changedListeners.push(listener) } },
      contextMenus: { onClicked: { addListener: listener => { control.menuClick = listener; } },
        update: (id, properties, done) => {
          if (id !== 'parseQRCode') throw Error('Unexpected QR menu ID');
          control.menuTitle = properties.title;
          done();
        } },
      tabs: { query: async () => [tab], onUpdated: event(), onActivated: event(),
        sendMessage: async (id, request, options) => {
          control.requests.push({ action: request.action, frameId: options?.frameId });
          if (request.action === 'startQrSelection') control.pickerFrameId = options?.frameId ?? 0;
          if (request.action === 'getPageQrSources' && control.failPageReply) return [];
          if (request.action === 'showQrCandidates') control.visibleCandidates = request.candidates;
          return sendToListener(runtimeListeners.at(-1), request, { id: 'fixture-extension' });
        },
        captureVisibleTab: async () => {
          control.captures++;
          if (control.hangCapture) return new Promise(() => {});
          if (!control.screenshot) throw Error('QR image scanning must not depend on a covered screenshot');
          return control.screenshot;
        } },
      notifications: { create: async value => { control.notifications.push(value); return 'fixture'; } },
      alarms: { clear: async () => true, create: async () => {}, onAlarm: event() },
      action: { openPopup: async options => {
        control.popupWindowId = options?.windowId;
        if (control.hangPopup) return new Promise(() => {});
        if (control.failPopup) throw Error('Could not find an active browser window.');
        control.popups++;
      } }
    } });
  }, source);
  await page.addScriptTag({ url: origin + '/background.js' });
  await page.addScriptTag({ url: origin + '/content-scripts/content.js' });
  await page.waitForFunction(() => window.qrFixture.runtimeListeners.length === 2 && typeof window.qrFixture.menuClick === 'function');
  assert.equal(await page.evaluate(async () => {
    const fixture = window.qrFixture;
    fixture.menuTitle = '自动识别网页二维码';
    await Promise.all(fixture.installListeners.map(listener => listener({ reason: 'update' })));
    return fixture.menuTitle;
  }), '点选网页二维码');
  const selectImageFromMenu = async (frameId = 0) => {
    const scanCount = await page.evaluate(frameId => {
      const fixture = window.qrFixture;
      const image = document.querySelector('#qr');
      fixture.menuClick({ menuItemId: 'parseQRCode', frameId, mediaType: 'image', srcUrl: image.src },
        { id: 7, windowId: 1, url: 'https://github.com/settings/security', active: true });
      return { popups: fixture.popups, captures: fixture.captures };
    }, frameId);
    await page.waitForSelector('.openpass-qr-selecting');
    assert.deepEqual(await page.evaluate(() => ({ popups: window.qrFixture.popups, captures: window.qrFixture.captures })), scanCount);
    await page.mouse.click(165, 110);
  };
  const scan = async (expectedPopups, frameId = 0, mode = 'image') => {
    if (mode === 'image') await selectImageFromMenu(frameId);
    else await page.evaluate(() => { void chrome.runtime.sendMessage({ action: 'startQrScan' }); });
    await page.waitForFunction(count => window.qrFixture.popups === count, {}, expectedPopups);
    const result = await page.evaluate(() => ({
      site: window.qrFixture.session.pendingQrDraft?.secret.site, name: window.qrFixture.session.pendingQrDraft?.secret.name,
      type: window.qrFixture.session.pendingQrDraft?.secret.type, captures: window.qrFixture.captures,
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
  assert.ok(await page.evaluate(() => window.qrFixture.requests.some(request => request.action === 'startQrSelection' && request.frameId === 4)));
  // A tainted/unreadable image can fall back to its precise screenshot crop, rather than another QR on the page.
  await page.evaluate(() => {
    const image = document.querySelector('#qr');
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 800, 600);
    context.imageSmoothingEnabled = false; context.drawImage(image, 160, 100, 148, 148);
    window.qrFixture.screenshot = canvas.toDataURL('image/png');
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
      window.qrFixture.failPageReply = false;
      const image = document.querySelector('#qr'); image.src = src; await image.decode();
    }, suppliedSource);
    await scan(10);
    assert.equal(await page.evaluate(() => window.qrFixture.captures), 4);
    console.log('Supplied local SVG passed without screenshot fallback; decoded OTP data stayed in the isolated browser.');
  }
  const setQrImages = async (first, second) => page.evaluate(async (first, second) => {
    const control = window.qrFixture;
    control.failPageReply = false;
    const image = document.querySelector('#qr');
    image.src = first;
    await image.decode();
    document.querySelector('#second-qr')?.remove();
    if (second) {
      const other = document.createElement('img');
      other.id = 'second-qr';
      other.style.cssText = 'position:absolute;left:460px;top:100px;width:148px;height:148px';
      other.src = second;
      document.body.append(other);
      await other.decode();
    }
  }, qrSource(first.rows), second ? qrSource(second.rows) : null);
  await setQrImages(migrationPartOne, migrationPartTwo);
  assert.equal((await page.evaluate(() => chrome.runtime.sendMessage({ action: 'startQrScan' }))).pendingDraft, true);
  const drafted = await page.evaluate(() => window.qrFixture.session.pendingOtpImport.links);
  assert.deepEqual(new Set(drafted.split('\n')), new Set([migrationPartOne.uri, migrationPartTwo.uri]));
  assert.equal(await page.evaluate(() => window.qrFixture.captures), 4);

  await setQrImages(migrationPartOne, fixture);
  const mixed = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'startQrScan' }));
  assert.deepEqual(mixed, { success: true });
  const visible = await page.evaluate(() => window.qrFixture.visibleCandidates ?? []);
  assert.deepEqual(visible.map(candidate => candidate.label).sort(), ['GitHub', 'Google Authenticator 迁移']);
  assert.ok(visible.every(candidate => Object.keys(candidate).sort().join(',') === 'id,label,rect'));
  await page.click('.openpass-qr-candidate[title="Google Authenticator 迁移"]');
  await page.waitForFunction(link => window.qrFixture.session.pendingOtpImport?.links === link, {}, migrationPartOne.uri);

  await setQrImages(deviceRegistration);
  const device = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'startQrScan' }));
  assert.match(device.error, /Microsoft Authenticator 设备注册/);

  const openPicker = async () => {
    assert.deepEqual(await page.evaluate(() => chrome.runtime.sendMessage({ action: 'startQrElementPicker' })), { success: true });
    await page.waitForSelector('.openpass-qr-selecting');
    assert.match(await page.$eval('.openpass-qr-hint', hint => hint.textContent), /将鼠标移到二维码上并点击/);
  };
  const pick = async (x, y, size) => {
    await page.mouse.move(x, y);
    await page.waitForFunction(width => document.querySelector('.openpass-qr-selection')?.getBoundingClientRect().width === width, {}, size);
    const popups = await page.evaluate(() => window.qrFixture.popups);
    await page.mouse.click(x, y);
    await page.waitForFunction(count => window.qrFixture.popups === count + 1, {}, popups);
  };
  await setQrImages(fixture);
  await page.evaluate(() => {
    window.qrFixture.requests.length = 0;
    document.querySelector('#qr').addEventListener('click', () => { window.qrFixture.imageClicked = true; });
  });
  await openPicker();
  await pick(165, 110, 148);
  assert.deepEqual(await page.evaluate(() => ({ captures: window.qrFixture.captures, clicked: !!window.qrFixture.imageClicked,
    wholePage: window.qrFixture.requests.some(request => request.action === 'getPageQrSources') })),
  { captures: 4, clicked: false, wholePage: false });

  await page.evaluate(svg => {
    document.body.insertAdjacentHTML('beforeend', svg);
    const svgElement = document.body.lastElementChild;
    svgElement.style.cssText = 'position:absolute;left:460px;top:100px;width:148px;height:148px';
    const image = document.querySelector('#qr');
    const canvas = document.createElement('canvas');
    canvas.width = 800; canvas.height = 600;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, 800, 600);
    context.imageSmoothingEnabled = false; context.drawImage(image, 460, 280, 148, 148);
    window.qrFixture.screenshot = canvas.toDataURL('image/png');
    const background = document.createElement('div');
    background.style.cssText = 'position:absolute;left:460px;top:280px;width:148px;height:148px';
    document.body.append(background);
  }, Buffer.from(source.split(',')[1], 'base64').toString('utf8'));
  await openPicker();
  await pick(520, 160, 148);
  assert.equal(await page.evaluate(() => window.qrFixture.captures), 4);
  await openPicker();
  await pick(520, 340, 148);
  assert.equal(await page.evaluate(() => window.qrFixture.captures), 5);
  await openPicker();
  const popupsBeforeDrag = await page.evaluate(() => window.qrFixture.popups);
  await page.mouse.move(446, 266);
  await page.mouse.down();
  await page.mouse.move(622, 443, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(count => window.qrFixture.popups === count + 1, {}, popupsBeforeDrag);
  assert.equal(await page.evaluate(() => window.qrFixture.captures), 6);
  await openPicker();
  await page.keyboard.press('Escape');
  await page.waitForSelector('.openpass-qr-selecting', { hidden: true });
  assert.equal(await page.evaluate(() => window.qrFixture.captures), 6);

  const beforeBlockedPopup = await page.evaluate(() => {
    const fixture = window.qrFixture;
    fixture.session.pendingQrDraft = null;
    fixture.popupWindowId = null;
    fixture.failPopup = true;
    return { popups: fixture.popups, notifications: fixture.notifications.length };
  });
  await openPicker();
  await page.mouse.click(165, 110);
  await page.waitForFunction(() => document.querySelector('.openpass-toast-success')?.textContent.includes('点击浏览器工具栏上的 OpenPass 图标'));
  assert.deepEqual(await page.evaluate(() => ({
    popups: window.qrFixture.popups, notifications: window.qrFixture.notifications.length,
    windowId: window.qrFixture.popupWindowId, site: window.qrFixture.session.pendingQrDraft?.secret.site
  })), { ...beforeBlockedPopup, windowId: 1, site: 'github.com' });

  await page.evaluate(() => {
    window.qrFixture.failPopup = false;
    window.qrFixture.hangPopup = true;
    window.qrFixture.session.pendingQrDraft = null;
    document.querySelector('.openpass-toast')?.remove();
  });
  await openPicker();
  await page.mouse.click(165, 110);
  await page.waitForSelector('.openpass-toast-success', { timeout: 6000 });
  assert.equal(await page.evaluate(() => window.qrFixture.session.pendingQrDraft?.secret.site), 'github.com');

  await page.evaluate(() => {
    window.qrFixture.hangPopup = false;
    const stalledImage = document.createElement('img');
    stalledImage.style.cssText = 'position:absolute;left:460px;top:280px;width:148px;height:148px';
    Object.defineProperty(stalledImage, 'complete', { value: false });
    stalledImage.decode = () => new Promise(() => {});
    document.body.append(stalledImage);
  });
  await openPicker();
  await pick(520, 340, 148);
  assert.equal(await page.evaluate(() => window.qrFixture.captures), 7);
  await page.evaluate(() => { window.qrFixture.hangCapture = true; });
  await openPicker();
  await page.mouse.click(520, 340);
  await page.waitForFunction(() => document.querySelector('.openpass-toast-error')?.textContent.includes('获取网页选区超时'), { timeout: 5000 });

  await page.evaluate(() => {
    const large = document.createElement('canvas');
    large.width = 2048;
    large.height = 1800;
    large.style.cssText = 'position:absolute;left:455px;top:430px;width:250px;height:160px';
    const context = large.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, large.width, large.height);
    context.drawImage(document.querySelector('#qr'), 1350, 1060, 228, 228);
    document.body.append(large);
  });
  await openPicker();
  const largeStarted = Date.now();
  const beforeLarge = await page.evaluate(() => window.qrFixture.popups);
  await page.mouse.click(634, 534);
  await page.waitForFunction(count => window.qrFixture.popups === count + 1, { timeout: 6500 }, beforeLarge);
  assert.equal(await page.evaluate(() => window.qrFixture.captures), 8, 'Large canvas was recognized from the selected image');

  assert.deepEqual(errors, []);
  console.log(`QR scan passed: large canvas selection in ${Date.now() - largeStarted}ms, screenshot fallback, and limits for stalled image, capture, and popup.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
