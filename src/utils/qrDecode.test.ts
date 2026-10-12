import { describe, expect, it } from 'vitest';
import { decodeOtpQrPixels } from './qrDecode';
import { normalizeQrBounds } from './qrScan';
import fixture from './fixtures/github-otp-qr.json';

function pixels(width: number, invert = false) {
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const black = fixture.rows[Math.min(fixture.rows.length - 1, Math.floor((y + .5) * fixture.rows.length / width))]
      [Math.min(fixture.rows.length - 1, Math.floor((x + .5) * fixture.rows.length / width))] === '1';
    const value = black !== invert ? 0 : 255;
    data.set([value, value, value, 255], (y * width + x) * 4);
  }
  return data;
}

describe('dense OTP QR pixel decoding', () => {
  it.each([57, 148, 228])('reads a synthetic GitHub QR at %i pixels and maps its location back to the source', width => {
    const decoded = decodeOtpQrPixels(pixels(width), width, width);
    expect(decoded?.code.data).toBe(fixture.uri);
    expect(decoded?.secret).toMatchObject({ type: 'totp', name: 'GitHub', digits: 6 });
    const rect = normalizeQrBounds(Object.values(decoded!.code.location), 0, 0, width, width);
    expect(rect.x).toBeGreaterThan(0); expect(rect.x).toBeLessThan(.15);
    expect(rect.width).toBeGreaterThan(.75); expect(rect.width).toBeLessThan(1);
  });
  it('continues to recognize inverted QR images', () => {
    expect(decodeOtpQrPixels(pixels(228, true), 228, 228)?.code.data).toBe(fixture.uri);
  });
  it('does not turn a blank image into an OTP import', () => {
    expect(decodeOtpQrPixels(new Uint8ClampedArray(148 * 148 * 4).fill(255), 148, 148)).toBeNull();
  });
});
