import type { NormalizedRect } from './qrScan';

export interface QrImageSource {
  dataUrl?: string;
  rect: NormalizedRect;
}

/** 从已加载的图片读取固有像素，不包含 CSS 缩放、选中高亮和页面覆盖层。 */
export async function readQrImageSource(srcUrl: string, root = document): Promise<QrImageSource | null> {
  const image = Array.from(root.querySelectorAll('img')).find(image => image.currentSrc === srcUrl || image.src === srcUrl);
  if (!image) return null;
  return readQrElementSource(image, root);
}

async function readQrElementSource(image: HTMLImageElement | HTMLCanvasElement, root: Document): Promise<QrImageSource | null> {
  const bounds = image.getBoundingClientRect();
  const view = root.defaultView;
  if (!view || bounds.width <= 0 || bounds.height <= 0) return null;
  const result: QrImageSource = { rect: {
    x: bounds.left / view.innerWidth, y: bounds.top / view.innerHeight,
    width: bounds.width / view.innerWidth, height: bounds.height / view.innerHeight
  } };
  try {
    const isImage = image.tagName === 'IMG';
    if (isImage && !(image as HTMLImageElement).complete) await (image as HTMLImageElement).decode();
    const width = isImage ? (image as HTMLImageElement).naturalWidth : image.width;
    const height = isImage ? (image as HTMLImageElement).naturalHeight : image.height;
    if (!width || !height || width * height > 16000000) return result;
    const scale = Math.min(4, Math.max(1, 512 / Math.min(width, height)), 2048 / Math.max(width, height));
    const canvas = root.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return result;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    result.dataUrl = canvas.toDataURL('image/png');
  } catch { /* 跨域污染或图片失效时保留位置，让后台回退到该图片的截图区域。 */ }
  return result;
}

/** 普通扫描先读取当前可见的图片和 canvas，二维码提示只影响顺序，不排除其他图像。 */
export async function readPageQrSources(root = document): Promise<QrImageSource[]> {
  const view = root.defaultView;
  if (!view) return [];
  const elements = Array.from(root.querySelectorAll<HTMLImageElement | HTMLCanvasElement>('img, canvas')).filter(element => {
    const bounds = element.getBoundingClientRect();
    const style = view.getComputedStyle(element);
    if (bounds.width <= 0 || bounds.height <= 0 || bounds.right <= 0 || bounds.bottom <= 0 ||
        bounds.left >= view.innerWidth || bounds.top >= view.innerHeight || style.display === 'none' ||
        style.visibility === 'hidden' || style.opacity === '0') return false;
    if (element.tagName === 'IMG') {
      const image = element as HTMLImageElement;
      return image.complete && image.naturalWidth >= 21 && image.naturalHeight >= 21;
    }
    return element.width >= 21 && element.height >= 21;
  });
  const priority = (element: Element) => /qr|二维码/i.test([
    element.id, element.className, element.getAttribute('alt')
  ].join(' ')) ? 1 : 0;
  elements.sort((left, right) => priority(right) - priority(left));
  const sources: QrImageSource[] = [];
  let bytes = 0;
  for (const element of elements.slice(0, 32)) {
    const source = await readQrElementSource(element, root);
    if (!source) continue;
    const length = source.dataUrl?.length || 0;
    // 限定单次消息体，无法读取或超出预算的图像仍可由网页截图覆盖。
    if (bytes + length <= 8 * 1024 * 1024) { sources.push(source); bytes += length; }
  }
  return sources;
}
