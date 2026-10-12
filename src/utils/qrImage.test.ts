// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readQrImageSource, readPageQrSources } from './qrImage';

const context = { fillStyle: '', imageSmoothingEnabled: true, fillRect: vi.fn(), drawImage: vi.fn() };
function image(src: string) {
  const image = document.createElement('img');
  image.src = src;
  Object.defineProperties(image, { naturalWidth: { value: 57 }, naturalHeight: { value: 57 }, complete: { value: true } });
  image.getBoundingClientRect = () => ({ left: 160, top: 278, right: 340, bottom: 458, width: 180, height: 180 } as DOMRect);
  document.body.append(image);
  return image;
}
beforeEach(() => {
  document.body.innerHTML = '';
  context.fillRect.mockReset(); context.drawImage.mockReset(); context.imageSmoothingEnabled = true;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,fixture');
});
afterEach(() => vi.restoreAllMocks());

describe('clicked QR image pixels', () => {
  it('reads the selected image at intrinsic resolution rather than its CSS size or an unrelated image', async () => {
    image('https://example.com/logo.png');
    const selected = image('data:image/svg+xml,<svg/>');
    selected.style.filter = 'contrast(0.2)';
    const result = await readQrImageSource(selected.src);
    expect(result?.dataUrl).toBe('data:image/png;base64,fixture');
    expect(context.drawImage).toHaveBeenCalledWith(selected, 0, 0, 228, 228);
    expect(result?.rect).toEqual({ x: 160 / innerWidth, y: 278 / innerHeight, width: 180 / innerWidth, height: 180 / innerHeight });
    expect(context.fillStyle).toBe('#fff');
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 228, 228);
    expect(context.imageSmoothingEnabled).toBe(false);
  });
  it('keeps a screenshot crop when a cross-origin image taints the canvas', async () => {
    const selected = image('https://images.example.com/qr.png');
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(() => { throw new DOMException('Tainted canvas', 'SecurityError'); });
    const result = await readQrImageSource(selected.src);
    expect(result?.dataUrl).toBeUndefined();
    expect(result?.rect.width).toBe(180 / innerWidth);
  });
  it('does not substitute another image when the clicked source is missing', async () => {
    image('https://example.com/logo.png');
    expect(await readQrImageSource('https://example.com/missing.png')).toBeNull();
    expect(context.drawImage).not.toHaveBeenCalled();
  });
  it('collects visible images and canvases, prioritizing QR hints without excluding ordinary images', async () => {
    const ordinary = image('https://example.com/plain.png');
    const qr = image('https://example.com/qr.png'); qr.className = 'qr-code-img';
    const hidden = image('https://example.com/hidden.png'); hidden.style.display = 'none';
    const canvas = document.createElement('canvas'); canvas.width = 147; canvas.height = 147;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 147, bottom: 147, width: 147, height: 147 } as DOMRect);
    document.body.append(canvas);
    const sources = await readPageQrSources();
    expect(sources).toHaveLength(3);
    expect(context.drawImage.mock.calls.map(call => call[0])).toEqual([qr, ordinary, canvas]);
  });
  it('skips loading and offscreen images instead of holding up the screenshot fallback', async () => {
    const loading = document.createElement('img'); loading.src = 'https://example.com/loading.png';
    loading.getBoundingClientRect = () => ({ left: 0, top: 0, right: 147, bottom: 147, width: 147, height: 147 } as DOMRect);
    Object.defineProperty(loading, 'complete', { value: false }); document.body.append(loading);
    const offscreen = image('https://example.com/offscreen.png');
    offscreen.getBoundingClientRect = () => ({ left: -180, top: 0, right: 0, bottom: 180, width: 180, height: 180 } as DOMRect);
    expect(await readPageQrSources()).toEqual([]);
    expect(context.drawImage).not.toHaveBeenCalled();
  });
});
