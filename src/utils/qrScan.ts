export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PixelRegion = [x: number, y: number, width: number, height: number];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function getQrScanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/Could not find an active browser window|No current window/i.test(message)) {
    return '未找到可扫描的浏览器窗口，请先切换到要扫描的普通网页后重试';
  }
  if (/Cannot access contents of url|Cannot access a chrome:\/\//i.test(message)) {
    return '当前页面受浏览器保护，无法扫描；请在普通网页中重试';
  }
  return message || '无法扫描当前页面';
}

export function createScanRegions(
  imageWidth: number,
  imageHeight: number,
  crop?: NormalizedRect
): PixelRegion[] {
  if (crop) {
    const x = Math.round(clamp(crop.x, 0, 1) * imageWidth);
    const y = Math.round(clamp(crop.y, 0, 1) * imageHeight);
    const right = Math.round(clamp(crop.x + crop.width, 0, 1) * imageWidth);
    const bottom = Math.round(clamp(crop.y + crop.height, 0, 1) * imageHeight);
    return [[x, y, Math.max(1, right - x), Math.max(1, bottom - y)]];
  }

  const regions: PixelRegion[] = [[0, 0, imageWidth, imageHeight]];
  const tileWidth = Math.round(imageWidth * 0.55);
  const tileHeight = Math.round(imageHeight * 0.55);
  const xPositions = [0, Math.floor((imageWidth - tileWidth) / 2), imageWidth - tileWidth];
  const yPositions = [0, Math.floor((imageHeight - tileHeight) / 2), imageHeight - tileHeight];
  for (const x of xPositions) {
    for (const y of yPositions) {
      regions.push([Math.max(0, x), Math.max(0, y), tileWidth, tileHeight]);
    }
  }
  return regions;
}

export function normalizeQrBounds(
  points: Array<{ x: number; y: number }>,
  regionX: number,
  regionY: number,
  imageWidth: number,
  imageHeight: number
): NormalizedRect {
  const minX = Math.min(...points.map((point) => point.x)) + regionX;
  const minY = Math.min(...points.map((point) => point.y)) + regionY;
  const maxX = Math.max(...points.map((point) => point.x)) + regionX;
  const maxY = Math.max(...points.map((point) => point.y)) + regionY;
  return {
    x: minX / imageWidth,
    y: minY / imageHeight,
    width: (maxX - minX) / imageWidth,
    height: (maxY - minY) / imageHeight
  };
}
