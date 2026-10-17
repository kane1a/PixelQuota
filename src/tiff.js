import TiffWorker from './tiff-worker.js?worker&inline';

let pendingDecode = Promise.resolve();

const MAX_SIDE = 32767;
const MAX_PIXELS = 268435456;

async function encodeWorkerPixels(data) {
  const { width, height, rgba } = data;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error('decode_failed:tiff_pixel_size');
  }
  const byteLength = width * height * 4;
  if (!(rgba instanceof ArrayBuffer) || rgba.byteLength !== byteLength) {
    throw new Error('decode_failed:tiff_pixel_count');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('decode_failed:no_canvas');
  const image = context.createImageData(width, height);
  image.data.set(new Uint8ClampedArray(rgba));
  context.putImageData(image, 0, 0);
  return await new Promise((resolve, reject) => canvas.toBlob(blob => blob?.type === 'image/png' && blob.size
    ? resolve(blob) : reject(new Error('decode_failed:tiff_no_pixels')), 'image/png'));
}

async function runDecoder(file) {
  const buffer = await file.arrayBuffer();
  const worker = new TiffWorker();
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('decode_failed:tiff_timeout')), 30000);
      worker.onmessage = ({ data }) => {
        if (data?.error) reject(new Error(data.error));
        else if (!Number.isSafeInteger(data?.pages) || data.pages < 1) reject(new Error('decode_failed:tiff_no_pixels'));
        else if (data.blob instanceof Blob) data.blob.type === 'image/png' && data.blob.size
          ? resolve(data.blob) : reject(new Error('decode_failed:tiff_no_pixels'));
        else encodeWorkerPixels(data).then(resolve, reject);
      };
      worker.onerror = () => reject(new Error('decode_failed:tiff_worker'));
      worker.onmessageerror = () => reject(new Error('decode_failed:tiff_worker_message'));
      worker.postMessage(buffer, [buffer]);
    });
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
}

export function decodeTiffSource(file) {
  // One full-size TIFF at a time, even when a batch starts all previews together.
  const result = pendingDecode.then(() => runDecoder(file));
  pendingDecode = result.catch(() => {});
  return result;
}
