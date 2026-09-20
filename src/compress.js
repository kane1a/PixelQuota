import { encodeAvif, detectAvifEncoderSupport } from './avif.js';

const HEIC_RE = /\.(heic|heif)$/i;

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if(!blob)return reject(new Error('encode_failed:no_data'));
      if(type!=='image/png'&&blob.type!==type)return reject(new Error(`encode_unsupported:${type}`));
      resolve(blob);
    }, type, quality);
  });
}

function writeAscii(view,offset,text){for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));}
function encodeBmp(canvas){
  const width=canvas.width,height=canvas.height,rowBytes=width*4,pixelBytes=rowBytes*height,header=54;
  const buffer=new ArrayBuffer(header+pixelBytes),view=new DataView(buffer);
  writeAscii(view,0,'BM');view.setUint32(2,header+pixelBytes,true);view.setUint32(10,header,true);
  view.setUint32(14,40,true);view.setInt32(18,width,true);view.setInt32(22,height,true);view.setUint16(26,1,true);view.setUint16(28,32,true);view.setUint32(30,0,true);view.setUint32(34,pixelBytes,true);view.setInt32(38,2835,true);view.setInt32(42,2835,true);
  const src=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,width,height).data;
  let out=header;
  for(let y=height-1;y>=0;y--){
    const row=y*width*4;
    for(let x=0;x<width;x++){
      const i=row+x*4;
      view.setUint8(out++,src[i+2]);view.setUint8(out++,src[i+1]);view.setUint8(out++,src[i]);view.setUint8(out++,255);
    }
  }
  return new Blob([buffer],{type:'image/bmp'});
}

export async function detectEncoderSupport(type){
  if(type==='image/bmp')return true;
  if(type==='image/avif')return detectAvifEncoderSupport();
  if(!['image/jpeg','image/png','image/webp'].includes(type))return false;
  const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;
  try{const blob=await toBlob(canvas,type,.9);return blob.type===type;}catch{return false;}
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

async function encodeLossy(canvas,type,quality){
  if(type==='image/avif')return encodeAvif(canvas,quality);
  return toBlob(canvas,type,quality);
}

async function bestLossy(canvas, type, targetBytes) {
  let low = 0.28, high = 0.98, best = null, bestQ = low;
  const lowBlob = await encodeLossy(canvas, type, low);
  if (lowBlob.size > targetBytes) return { fits:false, blob:lowBlob, quality:low };
  const highBlob = await encodeLossy(canvas, type, high);
  if (highBlob.size <= targetBytes) return { fits:true, blob:highBlob, quality:high };
  best = lowBlob;
  for (let i=0;i<9;i++) {
    const q = (low+high)/2;
    const blob = await encodeLossy(canvas, type, q);
    if (blob.size <= targetBytes) { best = blob; bestQ = q; low = q; }
    else high = q;
  }
  return { fits:true, blob:best, quality:bestQ };
}

async function bestPng(canvas, targetBytes) {
  const blob = await toBlob(canvas, 'image/png');
  return { fits:blob.size <= targetBytes, blob, quality:1 };
}

async function bestBmp(canvas,targetBytes){
  const blob=encodeBmp(canvas);
  return{fits:blob.size<=targetBytes,blob,quality:1};
}

function sourceType(file,sourceExt){
  if(file.type&&/^image\/(jpeg|png|webp|avif|bmp)$/.test(file.type))return file.type;
  return sourceExt==='png'?'image/png':sourceExt==='webp'?'image/webp':sourceExt==='avif'?'image/avif':sourceExt==='bmp'?'image/bmp':/^jpe?g$/.test(sourceExt)?'image/jpeg':'';
}
function extensionForType(type){return type==='image/png'?'png':type==='image/webp'?'webp':type==='image/avif'?'avif':type==='image/bmp'?'bmp':'jpg';}
async function encodeAtQuality(canvas,type,quality=.98){
  if(type==='image/bmp')return encodeBmp(canvas);
  if(type==='image/avif')return encodeAvif(canvas,quality);
  return toBlob(canvas,type,type==='image/png'?undefined:quality);
}

export async function compressImage(file, opts, onProgress=()=>{}) {
  const image = await decodeFile(file);
  const src = sourceDimensions(image);
  const transparency = hasTransparency(image);
  const compressionMode=opts.compressionMode==='convert'?'convert':'limit';
  const targetBytes = compressionMode==='convert'?Number.POSITIVE_INFINITY:Math.max(3000, Math.floor(Number(opts.targetKb || 200) * 1000 * 0.98));
  const planned = plannedDimensions(image, opts);
  const sourceExt = (file.name.match(/\.([^.]+)$/)?.[1] || 'jpg').toLowerCase();
  const isHeic = HEIC_RE.test(file.name) || /heic|heif/i.test(file.type);
  if (compressionMode==='limit'&&opts.outputFormat === 'auto' && opts.stripMetadata === false && !isHeic && !planned.exact && planned.width === src.width && planned.height === src.height && file.size <= targetBytes) {
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
  if (type === 'auto'){
    const originalType=sourceType(file,sourceExt);
    type=compressionMode==='convert'&&originalType&&!isHeic?originalType:(transparency ? 'image/webp' : 'image/jpeg');
  }
  if(!['image/jpeg','image/png','image/webp','image/avif','image/bmp'].includes(type))throw new Error(`encode_unsupported:${type}`);
  if(type==='image/avif'&&!(await detectEncoderSupport(type)))throw new Error('encode_unsupported:image/avif');
  const extension = extensionForType(type);
  let dims = planned;
  let attempt = 0;
  let encoded = null;

  if(compressionMode==='convert'){
    onProgress(20);
    const canvas=draw(image,dims,dims.exact);
    const blob=await encodeAtQuality(canvas,type,.98);
    onProgress(100);
    return{
      blob,
      outputName:file.name.replace(/\.[^.]+$/, '') + `_converted.${extension}`,
      outputType:type,
      quality:type==='image/png'||type==='image/bmp'?1:.98,
      metTarget:true,
      targetBytes,
      originalSize:file.size,
      originalWidth:src.width,
      originalHeight:src.height,
      outputWidth:dims.width,
      outputHeight:dims.height,
      sourceName:file.name,
      operation:'convert',
      conversionOnly:true
    };
  }

  while (attempt < 14) {
    onProgress(Math.min(92, 10 + attempt*6));
    const canvas = draw(image, dims, dims.exact);
    encoded = type === 'image/png' ? await bestPng(canvas,targetBytes) : type==='image/bmp'?await bestBmp(canvas,targetBytes):await bestLossy(canvas,type,targetBytes);
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
