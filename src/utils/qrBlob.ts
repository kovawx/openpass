const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

export async function decodeQrBlob<T>(blob: Blob, parse: (text: string) => T | null) {
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('二维码图片过大');
  const { decodeQrPixels } = await import('./qrDecode');
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('当前浏览器无法读取二维码图片');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return decodeQrPixels(pixels.data, pixels.width, pixels.height, parse)?.value ?? null;
  } finally { bitmap.close(); }
}

export function clipboardImages(clipboard: DataTransfer) {
  const files = Array.from(clipboard.files).filter(file => file.type.startsWith('image/'));
  return files.length ? files : Array.from(clipboard.items).flatMap(item => {
    const file = item.kind === 'file' && item.type.startsWith('image/') ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

export async function readQrImageUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) && !/^data:image\//i.test(value)) throw new Error('请输入二维码图片地址');
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(8000) })
    .catch(() => { throw new Error('无法读取图片地址，请复制图片本身后粘贴'); });
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !type.startsWith('image/') || !response.body) throw new Error('此地址未返回可读取的图片，请复制图片本身后粘贴');
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('二维码图片过大');
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) return new Blob(chunks, { type });
      size += chunk.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error('二维码图片过大');
      }
      chunks.push(Uint8Array.from(chunk));
    }
  } finally { reader.releaseLock(); }
}
