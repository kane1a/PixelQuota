import UTIF from 'utif2';

// UTIF's CMYK converter checks window. Keep the compatibility alias inside this worker.
self.window = self;
const MAX_SIDE = 32767;
const MAX_PIXELS = 268435456;

function checkSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
      width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error(`too_large:${width}x${height}`);
  }
}

const MAX_IFD_ENTRIES = 4096;
const MAX_TOTAL_IFD_ENTRIES = 16384;
const MAX_IFDS = 128;
const MAX_IFD_DEPTH = 16;
const MAX_TAG_VALUES = 65536;
const TIFF_TYPE_BYTES = [0,1,1,2,4,8,1,1,2,4,8,4,8,4];

function preflightIFDs(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer), little = bytes[0] === 73;
  const fail = reason => { throw new Error(`decode_failed:tiff_ifd_${reason}`); };
  const inBounds = (offset, length) => Number.isSafeInteger(offset) && Number.isSafeInteger(length) &&
    offset >= 0 && length >= 0 && offset <= bytes.length && length <= bytes.length - offset;
  const read16 = offset => {
    if (!inBounds(offset, 2)) fail('bounds');
    return view.getUint16(offset, little);
  };
  const read32 = offset => {
    if (!inBounds(offset, 4)) fail('bounds');
    return view.getUint32(offset, little);
  };
  const visited = new Set();
  let directoryCount = 0, totalEntries = 0;

  function visit(offset, depth, mainDirectory) {
    if (!Number.isSafeInteger(offset) || offset < 8) fail('bounds');
    if (depth > MAX_IFD_DEPTH) fail('depth_limit');
    if (visited.has(offset)) fail('cycle');
    if (directoryCount >= MAX_IFDS) fail('directory_limit');
    visited.add(offset);
    directoryCount++;

    const count = read16(offset);
    if (count > MAX_IFD_ENTRIES) fail('entry_limit');
    totalEntries += count;
    if (!Number.isSafeInteger(totalEntries) || totalEntries > MAX_TOTAL_IFD_ENTRIES) fail('total_entry_limit');
    const tableBytes = count * 12;
    if (!Number.isSafeInteger(tableBytes) || !inBounds(offset + 2, tableBytes + 4)) fail('bounds');
    const nextOffset = read32(offset + 2 + tableBytes);
    let model = '';

    for (let index = 0; index < count; index++) {
      const entry = offset + 2 + index * 12;
      const tag = read16(entry), type = read16(entry + 2), valueCount = read32(entry + 4);
      const unitBytes = TIFF_TYPE_BYTES[type];
      if (!unitBytes) fail('type');
      if (valueCount > MAX_TAG_VALUES) fail('value_limit');
      const valueBytes = valueCount * unitBytes;
      if (!Number.isSafeInteger(valueBytes)) fail('value_limit');
      const valueField = entry + 8;
      const valueOffset = valueBytes > 4 ? read32(valueField) : valueField;
      if (valueBytes > 4 && !inBounds(valueOffset, valueBytes)) fail('value_bounds');

      if (tag === 272 && type === 2 && valueCount > 0) {
        const textLength = Math.min(valueCount - 1, bytes.length - valueOffset);
        model = '';
        for (let i = 0; i < textLength; i++) model += String.fromCharCode(bytes[valueOffset + i]);
      }

      if ((tag === 330 || tag === 34665 || tag === 34853 || tag === 61440) && valueCount > 0) {
        if (tag === 330 && model === 'DSLR-A100') continue;
        if (type !== 4 && type !== 13) fail('link_type');
        for (let i = 0; i < valueCount; i++) visit(read32(valueOffset + i * 4), depth + 1, false);
      } else if (tag === 50740 && valueCount > 0 && (type === 1 || type === 7 || type === 2)) {
        const byteArray = type !== 2 || bytes[valueOffset] >= 128;
        if (byteArray && valueCount >= 4) {
          const privateOffset = read32(valueOffset);
          if (read16(privateOffset) < 300) visit(privateOffset, depth + 1, false);
        }
      }
    }
    return mainDirectory ? nextOffset : 0;
  }

  let offset = read32(4);
  while (offset !== 0) offset = visit(offset, 0, true);
}

function validatePixelRanges(buffer, page, compression) {
  const fail = reason => { throw new Error(`decode_failed:${reason}`); };
  const width = page.t256?.[0], height = page.t257?.[0];
  const channels = page.t277?.[0] ?? 1, planar = page.t284?.[0] ?? 1;
  const bits = page.t258?.[0] ?? 1;
  if (!Number.isSafeInteger(channels) || channels < 1 || channels > 16 || ![1,2].includes(planar) ||
      !Number.isSafeInteger(bits) || bits < 1 || bits > 32) fail('tiff_pixel_layout');

  const tiled = page.t322 !== undefined && page.t322 !== null;
  let segmentsPerPlane, tileWidth, tileHeight, rowsPerStrip = height;
  if (tiled) {
    tileWidth = page.t322?.[0]; tileHeight = page.t323?.[0];
    if (!Number.isSafeInteger(tileWidth) || tileWidth <= 0 || !Number.isSafeInteger(tileHeight) || tileHeight <= 0) {
      fail('tiff_pixel_layout');
    }
    segmentsPerPlane = Math.ceil(width / tileWidth) * Math.ceil(height / tileHeight);
  } else {
    rowsPerStrip = page.t278?.[0] ?? height;
    if (!Number.isSafeInteger(rowsPerStrip) || rowsPerStrip <= 0) fail('tiff_pixel_layout');
    rowsPerStrip = Math.min(rowsPerStrip, height);
    segmentsPerPlane = Math.ceil(height / rowsPerStrip);
  }
  const planes = planar === 2 ? channels : 1;
  const expectedSegments = segmentsPerPlane * planes;
  if (!Number.isSafeInteger(expectedSegments) || expectedSegments < 1 || expectedSegments > MAX_TAG_VALUES) fail('tiff_pixel_layout');
  const offsetTag = tiled ? 't324' : 't273', lengthTag = tiled ? 't325' : 't279';
  const offsets = page[offsetTag], lengths = page[lengthTag];
  if (!offsets?.length || !lengths?.length || offsets.length !== expectedSegments || lengths.length !== expectedSegments) {
    fail('tiff_pixel_layout');
  }
  const validRange = (offset, length) => Number.isSafeInteger(offset) && offset >= 8 &&
    Number.isSafeInteger(length) && length > 0 && offset <= buffer.byteLength && length <= buffer.byteLength - offset;
  if (offsets.some((offset, index) => !validRange(offset, lengths[index]))) fail('tiff_pixel_range');

  if (compression === 1) {
    // UTIF uses the first BitsPerSample value and pads each strip row to a byte.
    const samplesPerSegment = planar === 2 ? 1 : channels;
    const bitsPerPixel = bits * samplesPerSegment;
    if (!Number.isSafeInteger(bitsPerPixel) || bitsPerPixel <= 0) fail('tiff_pixel_layout');

    // UTIF replaces a single uncompressed strip's declared byte count with its computed size.
    if (!tiled && segmentsPerPlane === 1) {
      const requiredBytes = height * Math.ceil(width * bitsPerPixel / 8);
      if (!Number.isSafeInteger(requiredBytes) || requiredBytes <= 0) fail('tiff_pixel_layout');
      for (const offset of offsets) {
        if (!Number.isSafeInteger(offset) || offset < 8 || offset > buffer.byteLength ||
            requiredBytes > buffer.byteLength - offset) fail('tiff_pixel_range');
      }
    } else {
      for (let segment = 0; segment < expectedSegments; segment++) {
        let requiredBytes;
        if (tiled) {
          // UTIF's tile buffer is ceil(tileWidth * tileHeight * bitsPerPixel / 8).
          const tileBits = tileWidth * tileHeight * bitsPerPixel;
          if (!Number.isSafeInteger(tileBits) || tileBits <= 0) fail('tiff_pixel_layout');
          requiredBytes = Math.ceil(tileBits / 8);
        } else {
          const segmentInPlane = segment % segmentsPerPlane;
          const firstRow = segmentInPlane * rowsPerStrip;
          const rows = Math.min(rowsPerStrip, height - firstRow);
          const bytesPerRow = Math.ceil(width * bitsPerPixel / 8);
          requiredBytes = rows * bytesPerRow;
        }
        if (!Number.isSafeInteger(requiredBytes) || requiredBytes <= 0) fail('tiff_pixel_layout');
        if (lengths[segment] < requiredBytes) fail('tiff_pixel_bytes');
      }
    }
  }
}

function decodePixels(buffer, page, pages) {
  if (page.t284?.[0] !== 2) return UTIF.decodeImage(buffer, page, pages);
  const channels = page.t277?.[0] || 1, bits = page.t258?.[0] || 8;
  if (![8,16].includes(bits) || page.t258?.some(value => value !== bits)) throw new Error('decode_failed:tiff_planar_samples');
  const offsetTag = page.t322 ? 't324' : 't273', lengthTag = page.t322 ? 't325' : 't279';
  const offsets = page[offsetTag], lengths = page[lengthTag], perPlane = offsets.length / channels;
  if (!Number.isInteger(perPlane)) throw new Error('decode_failed:tiff_planar_strips');
  const width = page.t256[0], height = page.t257[0], sampleBytes = bits / 8;
  const pixels = new Uint8Array(width * height * channels * sampleBytes);
  for (let channel = 0; channel < channels; channel++) {
    const plane = { ...page, t277:[1], t258:[bits], t262:[1], t284:[1],
      [offsetTag]:offsets.slice(channel * perPlane, (channel + 1) * perPlane),
      [lengthTag]:lengths.slice(channel * perPlane, (channel + 1) * perPlane) };
    delete plane.data;
    UTIF.decodeImage(buffer, plane, pages);
    if (!plane.data || plane.data.length < width * height * sampleBytes) throw new Error('decode_failed:tiff_planar_pixels');
    for (let i = 0; i < width * height; i++) for (let byte = 0; byte < sampleBytes; byte++) {
      pixels[(i * channels + channel) * sampleBytes + byte] = plane.data[i * sampleBytes + byte];
    }
  }
  page.width = width; page.height = height; page.data = pixels;
}

function rgbaPixels(page) {
  const interpretation = page.t262?.[0], channels = page.t277?.[0] || 1, bits = page.t258?.[0] || 8;
  if (![0,1].includes(interpretation) || channels !== 2 || ![8,16].includes(bits) || !page.t338?.[0]) return UTIF.toRGBA8(page);
  const rgba = new Uint8Array(page.width * page.height * 4), stride = bits / 8;
  for (let i = 0; i < page.width * page.height; i++) {
    const source = i * 2 * stride, gray = page.data[source + stride - 1];
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = interpretation === 0 ? 255 - gray : gray;
    rgba[i * 4 + 3] = page.data[source + 2 * stride - 1];
  }
  return rgba;
}

function orientRgba(rgba, width, height, orientation) {
  if (!Number.isInteger(orientation) || orientation < 2 || orientation > 8) return { rgba, width, height };
  const swaps = orientation >= 5;
  const orientedWidth = swaps ? height : width, orientedHeight = swaps ? width : height;
  const oriented = new Uint8Array(rgba.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let targetX, targetY;
    switch (orientation) {
      case 2: targetX = width - 1 - x; targetY = y; break;
      case 3: targetX = width - 1 - x; targetY = height - 1 - y; break;
      case 4: targetX = x; targetY = height - 1 - y; break;
      case 5: targetX = y; targetY = x; break;
      case 6: targetX = height - 1 - y; targetY = x; break;
      case 7: targetX = height - 1 - y; targetY = width - 1 - x; break;
      case 8: targetX = y; targetY = width - 1 - x; break;
    }
    const source = (y * width + x) * 4, target = (targetY * orientedWidth + targetX) * 4;
    oriented.set(rgba.subarray(source, source + 4), target);
  }
  return { rgba:oriented, width:orientedWidth, height:orientedHeight };
}

self.onmessage = async ({ data: buffer }) => {
  let bitmap;
  try {
    const bytes = new Uint8Array(buffer);
    const little = bytes[0] === 73 && bytes[1] === 73;
    const big = bytes[0] === 77 && bytes[1] === 77;
    if (bytes.length < 8 || (!little && !big) || new DataView(buffer).getUint16(2, little) !== 42) {
      throw new Error('decode_failed:invalid_tiff');
    }
    preflightIFDs(buffer);
    const pages = UTIF.decode(buffer, { parseMN:false, debug:false });
    const page = pages.find(item => item.t256?.[0] > 0 && item.t257?.[0] > 0);
    if (!page) throw new Error('decode_failed:tiff_no_image');
    const width = page.t256[0], height = page.t257[0];
    checkSize(width, height);
    const compression = page.t259?.[0] || 1;
    if (![1,2,3,4,5,6,7,8,32773,32946,32809,34892].includes(compression)) {
      throw new Error('decode_failed:tiff_compression');
    }
    validatePixelRanges(buffer, page, compression);
    decodePixels(buffer, page, pages);
    if (!page.data?.length) throw new Error('decode_failed:tiff_no_pixels');
    const rgba = rgbaPixels(page);
    if (rgba.length !== width * height * 4) throw new Error('decode_failed:tiff_pixel_count');
    // An unspecified extra channel is not alpha. Also repair UTIF's opaque-CMYK
    // last pixel, whose missing next sample otherwise becomes NaN and alpha zero.
    if (!page.t338?.some(value => value === 1 || value === 2)) {
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    }
    // TIFF associated alpha is premultiplied; ImageData requires straight alpha.
    if (page.t338?.[0] === 1) {
      for (let i = 0; i < rgba.length; i += 4) {
        const alpha = rgba[i + 3];
        if (alpha > 0 && alpha < 255) {
          rgba[i] = Math.min(255, Math.round(rgba[i] * 255 / alpha));
          rgba[i + 1] = Math.min(255, Math.round(rgba[i + 1] * 255 / alpha));
          rgba[i + 2] = Math.min(255, Math.round(rgba[i + 2] * 255 / alpha));
        }
      }
    }
    const orientation = page.t274?.[0] || 1;
    if (typeof OffscreenCanvas !== 'function' || typeof ImageData !== 'function' ||
        typeof OffscreenCanvas.prototype?.convertToBlob !== 'function') {
      const oriented = orientRgba(rgba, width, height, orientation), pixels = oriented.rgba.buffer;
      self.postMessage({ rgba:pixels, width:oriented.width, height:oriented.height, pages:pages.length }, [pixels]);
      return;
    }
    const swap = orientation >= 5 && orientation <= 8;
    const canvas = new OffscreenCanvas(swap ? height : width, swap ? width : height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('decode_failed:no_canvas');
    const image = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height);
    if (orientation === 1) context.putImageData(image, 0, 0);
    else {
      bitmap = await createImageBitmap(image);
      const transforms = {
        2:[-1,0,0,1,width,0], 3:[-1,0,0,-1,width,height], 4:[1,0,0,-1,0,height],
        5:[0,1,1,0,0,0], 6:[0,1,-1,0,height,0], 7:[0,-1,-1,0,height,width], 8:[0,-1,1,0,0,width]
      };
      context.setTransform(...(transforms[orientation] || [1,0,0,1,0,0]));
      context.drawImage(bitmap, 0, 0);
    }
    self.postMessage({ blob:await canvas.convertToBlob({ type:'image/png' }), pages:pages.length });
  } catch (error) {
    const message = error?.message || String(error);
    self.postMessage({ error:/^(too_large:|decode_failed:)/.test(message) ? message : `decode_failed:${message}` });
  } finally {
    bitmap?.close?.();
  }
};
