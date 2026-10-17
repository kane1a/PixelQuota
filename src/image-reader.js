const HEIF_EXTENSION = /\.(heic|heif|hif)$/i;
const IMAGE_EXTENSION = /\.(jpe?g|jpe|jfif|png|apng|webp|avif|heic|heif|hif|bmp|gif|svg|ico|tiff?)$/i;
const HEIF_BRANDS = new Set(['heic','heix','hevc','hevx','heim','heis','hevm','hevs','mif1','msf1']);
const sources = new WeakMap();

export const MAX_CANVAS_SIDE = 32767;
export const MAX_CANVAS_PIXELS = 268435456;
export function assertCanvasSize(width, height) {
  if (!(width > 0 && height > 0) || width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE || width * height > MAX_CANVAS_PIXELS) {
    throw new Error(`too_large:${Math.round(width)}x${Math.round(height)}`);
  }
}

export function isImageFile(file) {
  return !!file && (/^image\//i.test(file.type || '') || IMAGE_EXTENSION.test(file.name || ''));
}
export function isHeifFile(file) {
  return !!file && (HEIF_EXTENSION.test(file.name || '') || /^image\/(heic|heif)(?:-sequence)?$/i.test(file.type || ''));
}
export function requiresImagePreparation(file) {
  return isHeifFile(file) || /\.(tiff?|svg)$/i.test(file?.name || '') || /^image\/(tiff?|svg\+xml)$/i.test(file?.type || '');
}
async function svgSource(file) {
  const doc = new DOMParser().parseFromString(await file.text(), 'image/svg+xml');
  const svg = doc.documentElement;
  if (doc.querySelector('parsererror') || svg.localName !== 'svg') throw new Error('decode_failed:invalid_svg');
  const viewBox = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const absolute = value => value && !/%$/.test(value) && Number.isFinite(parseFloat(value)) && parseFloat(value) > 0;
  if (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0 ||
      (absolute(svg.getAttribute('width')) && absolute(svg.getAttribute('height')))) {
    return file.type === 'image/svg+xml' ? file : file.slice(0, file.size, 'image/svg+xml');
  }
  const pixels = value => /^\d+(?:\.\d+)?(?:px)?$/.test(value || '') ? parseFloat(value) : 0;
  const width = pixels(svg.getAttribute('width')), height = pixels(svg.getAttribute('height'));
  const targetWidth = width || (height ? height * viewBox[2] / viewBox[3] : viewBox[2]);
  const targetHeight = height || (width ? width * viewBox[3] / viewBox[2] : viewBox[3]);
  assertCanvasSize(targetWidth, targetHeight);
  svg.setAttribute('width', String(targetWidth));
  svg.setAttribute('height', String(targetHeight));
  return new Blob([new XMLSerializer().serializeToString(svg)], { type:'image/svg+xml' });
}
async function hasHeifContent(file) {
  const bytes = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const ascii = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length >= 16 && ascii(4) === 'ftyp') {
    const end = Math.min(bytes.length, new DataView(bytes.buffer).getUint32(0));
    const brands = [ascii(8)];
    for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(ascii(offset));
    // AVIF is also an ISO-BMFF image; do not send it through an HEVC-only decoder.
    if (brands.some(brand => brand === 'avif' || brand === 'avis')) return false;
    if (brands.some(brand => HEIF_BRANDS.has(brand))) return true;
  }
  return isHeifFile(file);
}

async function nativeDecode(blob) {
  // HTMLImageElement preserves the browser's HDR-to-SDR mapping for AVIF.
  // ImageBitmap can discard the HDR headroom metadata and shift rendered colors.
  if (typeof createImageBitmap === 'function' && blob.type !== 'image/avif') {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch {
      try { return await createImageBitmap(blob); }
      catch { /* Some browser-supported formats only work through HTMLImageElement. */ }
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function prepareSource(file) {
  const header = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const tiff = header.length >= 4 && ((header[0] === 73 && header[1] === 73 && header[2] === 42 && header[3] === 0) ||
    (header[0] === 77 && header[1] === 77 && header[2] === 0 && header[3] === 42));
  if (tiff) return (await import('./tiff.js')).decodeTiffSource(file);
  const ascii = (start, end) => String.fromCharCode(...header.subarray(start, end));
  const nativeType = header[0] === 255 && header[1] === 216 && header[2] === 255 ? 'image/jpeg'
    : ascii(0,8) === '\x89PNG\r\n\x1a\n' ? 'image/png'
    : /^(GIF87a|GIF89a)$/.test(ascii(0,6)) ? 'image/gif'
    : ascii(0,2) === 'BM' ? 'image/bmp'
    : ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP' ? 'image/webp'
    : header.length >= 6 && header[0] === 0 && header[1] === 0 && header[2] === 1 && header[3] === 0 ? 'image/x-icon'
    : ascii(4,8) === 'ftyp' && /avif|avis/.test(ascii(8,header.length)) ? 'image/avif' : '';
  if (nativeType) return file.type === nativeType ? file : file.slice(0, file.size, nativeType);
  const text = new TextDecoder().decode(header).trimStart();
  if (/<svg(?:\s|>)/i.test(text) || /^image\/svg\+xml$/i.test(file.type || '') || /\.svg$/i.test(file.name || '')) return svgSource(file);
  if (!(await hasHeifContent(file))) return file;
  let image;
  try {
    // Native decoding is preferable where available; the fallback runs in a Web Worker.
    try { image = await nativeDecode(file); }
    catch { image = await (await import('heic-to/csp')).heicTo({ blob: file, type: 'bitmap' }); }
    const width = image.width || image.naturalWidth;
    const height = image.height || image.naturalHeight;
    assertCanvasSize(width, height);
    const canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('decode_failed:no_canvas');
    context.drawImage(image, 0, 0);
    // A lossless, alpha-preserving source works both for <img> previews and every tool.
    if (canvas.convertToBlob) return await canvas.convertToBlob({ type: 'image/png' });
    return await new Promise((resolve, reject) => canvas.toBlob(blob => blob
      ? resolve(blob) : reject(new Error('decode_failed:no_pixels')), 'image/png'));
  } finally {
    image?.close?.();
  }
}

export function browserImageSource(file) {
  let pending = sources.get(file);
  if (!pending) {
    pending = prepareSource(file).catch(error => {
      sources.delete(file);
      if (/^(too_large:|decode_failed:)/.test(error?.message || '')) throw error;
      throw new Error(`decode_failed:${error?.message || String(error)}`);
    });
    sources.set(file, pending);
  }
  return pending;
}

export async function preferredOutputType(file) {
  const source = await browserImageSource(file);
  if (source.type === 'image/webp' || (source === file && /\.webp$/i.test(file.name || ''))) return 'image/webp';
  if (source.type === 'image/png') return 'image/png';
  if (source.type === 'image/jpeg' || source.type === 'image/bmp' ||
      (source === file && /\.(jpe?g|jpe|jfif|bmp)$/i.test(file.name || ''))) return 'image/jpeg';
  // Other editable inputs may contain alpha, including AVIF, GIF, ICO, SVG and normalized HEIF/TIFF.
  return 'image/png';
}

export async function decodeFile(file) {
  let image;
  try {
    image = await nativeDecode(await browserImageSource(file));
    assertCanvasSize(image.width || image.naturalWidth, image.height || image.naturalHeight);
    return image;
  } catch (error) {
    image?.close?.();
    if (/^(too_large:|decode_failed:)/.test(error?.message || '')) throw error;
    throw new Error(`decode_failed:${error?.message || String(error)}`);
  }
}
