import { describe, expect, it } from 'vitest';
import { createScanRegions, normalizeQrBounds } from './qrScan';

describe('QR scan geometry', () => {
  it('scans the full screenshot plus overlapping tiles', () => {
    const regions = createScanRegions(1000, 800);
    expect(regions).toHaveLength(10);
    expect(regions[0]).toEqual([0, 0, 1000, 800]);
    expect(regions).toContainEqual([450, 360, 550, 440]);
  });

  it('converts and clamps a normalized user selection', () => {
    expect(createScanRegions(1000, 500, { x: 0.2, y: 0.1, width: 0.4, height: 0.5 })).toEqual([
      [200, 50, 400, 250]
    ]);
    expect(createScanRegions(100, 100, { x: -0.2, y: 0.9, width: 2, height: 0.5 })).toEqual([
      [0, 90, 100, 10]
    ]);
  });

  it('normalizes decoder coordinates from a cropped region', () => {
    expect(
      normalizeQrBounds(
        [{ x: 10, y: 20 }, { x: 110, y: 120 }],
        200,
        100,
        1000,
        500
      )
    ).toEqual({ x: 0.21, y: 0.24, width: 0.1, height: 0.2 });
  });
});
