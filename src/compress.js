const HEIC_RE = /\.(heic|heif)$/i;

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Encoder returned no data')), type, quality);
  });
}

async function decodeWithImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // Kept alive until img.decode resolves. Drawing happens immediately after decode.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function decodeFile(file) {
  let source = file;
  const looksHeic = HEIC_RE.test(file.name) || /heic|heif/i.test(file.type);
  if (looksHeic) {
    const { default: heic2any } = await import('heic2any');
    const converted = await heic2any({ blob:file, toType:'image/jpeg', quality:0.98, multiple:false });
    source = Array.isArray(converted) ? converted[0] : converted;
  }
  try {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(source, { imageOrientation:'from-image' }); }
      catch { return await createImageBitmap(source); }
    }
    return await decodeWithImage(source);
  } catch (error) {
    throw new Error(`decode_failed:${error?.message || 'unknown'}`);
  }
}

function hasTransparency(image) {
  const c = document.createElement('canvas');
  const w = Math.min(64, image.width || image.naturalWidth || 64);
  const h = Math.min(64, image.height || image.naturalHeight || 64);
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently:true });
  x.clearRect(0,0,w,h);
  x.drawImage(image,0,0,w,h);
  const data = x.getImageData(0,0,w,h).data;
  for (let i=3;i<data.length;i+=16) if (data[i] < 250) return true;
  return false;
}

function sourceDimensions(image) {
  return { width:image.width || image.naturalWidth, height:image.height || image.naturalHeight };
}

function plannedDimensions(image, opts) {
  const src = sourceDimensions(image);
  const w = Number(opts.maxWidth) || 0;
  const h = Number(opts.maxHeight) || 0;
  if (opts.resizeMode === 'exact' && w && h) return { width:Math.round(w), height:Math.round(h), exact:true };
  if (!w && !h) return { ...src, exact:false };
  const scale = Math.min(w ? w/src.width : Infinity, h ? h/src.height : Infinity, 1);
  return { width:Math.max(1,Math.round(src.width*scale)), height:Math.max(1,Math.round(src.height*scale)), exact:false };
}

function draw(image, dims, exact) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(dims.width));
  canvas.height = Math.max(1, Math.round(dims.height));
  const ctx = canvas.getContext('2d', { alpha:true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (!exact) {
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
  const src = sourceDimensions(image);
  const scale = Math.max(canvas.width/src.width, canvas.height/src.height);
  const cropW = canvas.width/scale;
  const cropH = canvas.height/scale;
  const sx = (src.width-cropW)/2;
  const sy = (src.height-cropH)/2;
  ctx.drawImage(image, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function bestLossy(canvas, type, targetBytes) {
  let low = 0.28, high = 0.98, best = null, bestQ = low;
  const lowBlob = await toBlob(canvas, type, low);
  if (lowBlob.size > targetBytes) return { fits:false, blob:lowBlob, quality:low };
  const highBlob = await toBlob(canvas, type, high);
  if (highBlob.size <= targetBytes) return { fits:true, blob:highBlob, quality:high };
  best = lowBlob;
  for (let i=0;i<9;i++) {
    const q = (low+high)/2;
    const blob = await toBlob(canvas, type, q);
    if (blob.size <= targetBytes) { best = blob; bestQ = q; low = q; }
    else high = q;
  }
  return { fits:true, blob:best, quality:bestQ };
}

async function bestPng(canvas, targetBytes) {
  const blob = await toBlob(canvas, 'image/png');
  return { fits:blob.size <= targetBytes, blob, quality:1 };
}

export async function compressImage(file, opts, onProgress=()=>{}) {
  const image = await decodeFile(file);
  const src = sourceDimensions(image);
  const transparency = hasTransparency(image);
  const targetBytes = Math.max(3000, Math.floor(Number(opts.targetKb || 200) * 1000 * 0.98));
  const planned = plannedDimensions(image, opts);
  const sourceExt = (file.name.match(/\.([^.]+)$/)?.[1] || 'jpg').toLowerCase();
  const isHeic = HEIC_RE.test(file.name) || /heic|heif/i.test(file.type);
  if (opts.outputFormat === 'auto' && opts.stripMetadata === false && !isHeic && !planned.exact && planned.width === src.width && planned.height === src.height && file.size <= targetBytes) {
    onProgress(100);
    return {
      blob:file,
      outputName:file.name.replace(/\.[^.]+$/, '') + `_pixelquota.${sourceExt}`,
      outputType:file.type || 'application/octet-stream',
      quality:1,
      metTarget:true,
      targetBytes,
      originalSize:file.size,
      originalWidth:src.width,
      originalHeight:src.height,
      outputWidth:src.width,
      outputHeight:src.height,
      sourceName:file.name,
      unchanged:true
    };
  }
  let type = opts.outputFormat;
  if (type === 'auto') type = transparency ? 'image/webp' : 'image/jpeg';
  const extension = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  let dims = planned;
  let attempt = 0;
  let encoded = null;

  while (attempt < 14) {
    onProgress(Math.min(92, 10 + attempt*6));
    const canvas = draw(image, dims, dims.exact);
    encoded = type === 'image/png' ? await bestPng(canvas,targetBytes) : await bestLossy(canvas,type,targetBytes);
    if (encoded.fits) break;
    if (dims.exact) break;
    const ratio = Math.sqrt(targetBytes/Math.max(encoded.blob.size,1));
    const shrink = Math.max(0.58, Math.min(0.9, ratio*0.94));
    const nextW = Math.max(96, Math.floor(canvas.width*shrink));
    const nextH = Math.max(96, Math.floor(canvas.height*shrink));
    if (nextW === dims.width && nextH === dims.height) break;
    dims = { width:nextW, height:nextH, exact:false };
    attempt += 1;
  }
  onProgress(100);

  const outName = file.name.replace(/\.[^.]+$/, '') + `_pixelquota.${extension}`;
  return {
    blob:encoded.blob,
    outputName:outName,
    outputType:type,
    quality:encoded.quality,
    metTarget:encoded.blob.size <= targetBytes,
    targetBytes,
    originalSize:file.size,
    originalWidth:src.width,
    originalHeight:src.height,
    outputWidth:dims.width,
    outputHeight:dims.height,
    sourceName:file.name
  };
}
