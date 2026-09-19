import { decodeFile } from './compress.js';

export const CROP_PRESETS={
  'ig-tall':{width:1080,height:1440,label:'Instagram Feed 3:4'},
  'ig-portrait':{width:1080,height:1350,label:'Instagram Feed 4:5'},
  'ig-story':{width:1080,height:1920,label:'Instagram Story / Reel 9:16'},
  'x-header':{width:1500,height:500,label:'X Header'},
  'youtube-thumb':{width:1280,height:720,label:'YouTube Thumbnail 16:9'},
  'facebook-cover':{width:851,height:315,label:'Facebook Page Cover'},
  'linkedin-cover':{width:1512,height:256,label:'LinkedIn Page Cover'},
  'linkedin-link':{width:1200,height:627,label:'LinkedIn Link Preview'}
};

const decodeCache=new Map();

function dimensions(image){return{width:image.width||image.naturalWidth,height:image.height||image.naturalHeight};}
function canvasBlob(canvas,type,quality){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('crop_encode_failed')),type,quality));}
async function cachedDecode(file){let pending=decodeCache.get(file);if(!pending){pending=decodeFile(file);decodeCache.set(file,pending);}return pending;}
export function clearCropCache(file=null){const release=key=>{const pending=decodeCache.get(key);if(!pending)return;decodeCache.delete(key);pending.then(image=>setTimeout(()=>image?.close?.(),750)).catch(()=>{});};if(file)return release(file);for(const key of [...decodeCache.keys()])release(key);}
function outputTypeFor(file){if(file.type==='image/png')return'image/png';if(file.type==='image/webp')return'image/webp';return'image/jpeg';}
function extensionFor(type){return type==='image/png'?'png':type==='image/webp'?'webp':'jpg';}

export function defaultCropRect(sourceWidth,sourceHeight,targetWidth,targetHeight){
  const sourceRatio=sourceWidth/sourceHeight,targetRatio=targetWidth/targetHeight;
  let w=1,h=1;
  if(sourceRatio>targetRatio)w=targetRatio/sourceRatio;
  else h=sourceRatio/targetRatio;
  return{x:(1-w)/2,y:(1-h)/2,w,h};
}

function sanitizeRect(rect,sourceWidth,sourceHeight,targetWidth,targetHeight){
  const fallback=defaultCropRect(sourceWidth,sourceHeight,targetWidth,targetHeight);
  if(!rect||![rect.x,rect.y,rect.w,rect.h].every(Number.isFinite))return fallback;
  const normalizedRatio=(targetWidth/targetHeight)*(sourceHeight/sourceWidth);
  let w=Math.max(.01,Math.min(1,Number(rect.w))),h=w/normalizedRatio;
  if(h>1){h=1;w=h*normalizedRatio;}
  const x=Math.max(0,Math.min(1-w,Number(rect.x)||0));
  const y=Math.max(0,Math.min(1-h,Number(rect.y)||0));
  return{x,y,w,h};
}

async function renderCropCanvas(file,opts={},renderOpts={}){
  const {maxDimension=0,onProgress=()=>{}}=renderOpts;onProgress(5);
  const preset=CROP_PRESETS[opts.preset]||CROP_PRESETS['ig-tall'];
  const image=await cachedDecode(file),source=dimensions(image);
  if(!source.width||!source.height)throw new Error('decode_failed:dimensions');
  const crop=sanitizeRect(opts.rect,source.width,source.height,preset.width,preset.height);
  const targetScale=maxDimension>0?Math.min(1,maxDimension/Math.max(preset.width,preset.height)):1;
  const width=Math.max(1,Math.round(preset.width*targetScale)),height=Math.max(1,Math.round(preset.height*targetScale));
  const sx=Math.round(crop.x*source.width),sy=Math.round(crop.y*source.height);
  const sw=Math.max(1,Math.round(crop.w*source.width)),sh=Math.max(1,Math.round(crop.h*source.height));
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:true});ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.drawImage(image,sx,sy,sw,sh,0,0,width,height);onProgress(82);
  return{canvas,width,height,sourceWidth:source.width,sourceHeight:source.height,targetWidth:preset.width,targetHeight:preset.height,crop,preset};
}

export async function renderCropPreview(file,opts={}){return renderCropCanvas(file,opts,{maxDimension:900});}

export async function applyCrop(file,opts={},onProgress=()=>{}){
  const rendered=await renderCropCanvas(file,opts,{onProgress:p=>onProgress(Math.round(p*.9))});
  const outputType=outputTypeFor(file),blob=await canvasBlob(rendered.canvas,outputType,outputType==='image/png'?undefined:.94);onProgress(100);
  const base=file.name.replace(/\.[^.]+$/,'');
  return{blob,outputName:`${base}_social_${rendered.targetWidth}x${rendered.targetHeight}.${extensionFor(outputType)}`,outputType,quality:outputType==='image/png'?1:.94,metTarget:true,targetBytes:Number.POSITIVE_INFINITY,originalSize:file.size,originalWidth:rendered.sourceWidth,originalHeight:rendered.sourceHeight,outputWidth:rendered.targetWidth,outputHeight:rendered.targetHeight,sourceName:file.name,operation:'crop',cropPreset:opts.preset||'ig-tall',cropRect:rendered.crop};
}
