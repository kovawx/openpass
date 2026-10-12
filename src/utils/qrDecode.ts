import jsQR, { type QRCode } from 'jsqr';
import { parseOtpAuth } from './otpAuth';

function decodedResult(code: QRCode | null, mapPoint: (point: { x: number; y: number }) => { x: number; y: number }) {
  const secret = code?.data ? parseOtpAuth(code.data) : null;
  if (!code || !secret) return null;
  return { secret, code: { ...code, location: Object.fromEntries(Object.entries(code.location)
    .map(([name, point]) => [name, mapPoint(point)])) as QRCode['location'] } };
}

/** 对缩放后每个模块只有 2～3 像素的平面二维码，按定位框和标准模块数重建均匀网格。 */
function decodeSquareGrid(data: Uint8ClampedArray, width: number, height: number) {
  const luminance = new Float32Array(width * height);
  let min = 255, max = 0;
  for (let i = 0; i < luminance.length; i++) {
    const value = .2126 * data[i * 4] + .7152 * data[i * 4 + 1] + .0722 * data[i * 4 + 2];
    luminance[i] = value; min = Math.min(min, value); max = Math.max(max, value);
  }
  if (max - min < 32) return null;
  for (const invert of [false, true]) {
    const dark = (x: number, y: number) => (luminance[y * width + x] < (min + max) / 2) !== invert;
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (dark(x, y)) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    const gridWidth = right - left + 1, gridHeight = bottom - top + 1;
    if (gridWidth < 21 || gridHeight < 21 || Math.abs(gridWidth / gridHeight - 1) > .1) continue;
    let finderWidth = 0;
    while (left + finderWidth <= right && dark(left + finderWidth, top)) finderWidth++;
    if (!finderWidth) continue;
    // 定位框宽度为 7 个模块；QR 版本的边长为 21 + 4 * (version - 1)。
    const estimate = 21 + 4 * Math.round((gridWidth * 7 / finderWidth - 21) / 4);
    for (const modules of [estimate, estimate - 4, estimate + 4]) {
      if (modules < 21 || modules > 177 || modules > Math.min(gridWidth, gridHeight)) continue;
      const size = (modules + 8) * 4;
      const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
      for (let y = 0; y < modules; y++) for (let x = 0; x < modules; x++) {
        const sampleX = left + Math.floor((x + .5) * gridWidth / modules);
        const sampleY = top + Math.floor((y + .5) * gridHeight / modules);
        if (!dark(sampleX, sampleY)) continue;
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
          pixels.set([0, 0, 0, 255], (((y + 4) * 4 + dy) * size + (x + 4) * 4 + dx) * 4);
        }
      }
      const result = decodedResult(jsQR(pixels, size, size, { inversionAttempts: 'attemptBoth' }), point => ({
        x: left + (point.x / 4 - 4) * gridWidth / modules,
        y: top + (point.y / 4 - 4) * gridHeight / modules
      }));
      if (result) return result;
    }
  }
  return null;
}

/** 小图按整数倍复制像素重试，避免插值把密集二维码的黑白模块混在一起。 */
export function decodeOtpQrPixels(data: Uint8ClampedArray, width: number, height: number) {
  const scales = Math.max(width, height) <= 512 ? [1, 2, 3] : [1];
  for (const scale of scales) {
    const pixels = scale === 1 ? data : new Uint8ClampedArray(width * height * scale * scale * 4);
    if (scale !== 1) {
      for (let y = 0; y < height * scale; y++) for (let x = 0; x < width * scale; x++) {
        const from = (Math.floor(y / scale) * width + Math.floor(x / scale)) * 4;
        const to = (y * width * scale + x) * 4;
        for (let channel = 0; channel < 4; channel++) pixels[to + channel] = data[from + channel];
      }
    }
    const result = decodedResult(jsQR(pixels, width * scale, height * scale, { inversionAttempts: 'attemptBoth' }),
      point => ({ x: point.x / scale, y: point.y / scale }));
    if (result) return result;
  }
  return Math.max(width, height) <= 512 ? decodeSquareGrid(data, width, height) : null;
}
