import { decodeFile } from './compress.js';

const decodeCache=new Map();

function dimensions(image){
  return {width:image.width||image.naturalWidth,height:image.height||image.naturalHeight};
}

async function cachedDecode(file){
  let pending=decodeCache.get(file);
  if(!pending){
    pending=decodeFile(file);
    decodeCache.set(file,pending);
  }
  return pending;
}

export function clearRedactCache(file=null){
  const release=key=>{
    const pending=decodeCache.get(key);
    if(!pending)return;
    decodeCache.delete(key);
    pending.then(image=>setTimeout(()=>image?.close?.(),750)).catch(()=>{});
  };
  if(file)return release(file);
  for(const key of [...decodeCache.keys()])release(key);
}

function canvasBlob(canvas,type,quality){
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('redact_encode_failed')),type,quality));
}

function outputTypeFor(file){
  if(file.type==='image/png')return'image/png';
  if(file.type==='image/webp')return'image/webp';
  return'image/jpeg';
}

function extensionFor(type){
  return type==='image/png'?'png':type==='image/webp'?'webp':'jpg';
}

function normalizedRect(region,width,height){
  const x=Math.round(Math.max(0,Math.min(1,region.x))*width);
  const y=Math.round(Math.max(0,Math.min(1,region.y))*height);
  const w=Math.max(1,Math.round(Math.max(0,Math.min(1-region.x,region.w))*width));
  const h=Math.max(1,Math.round(Math.max(0,Math.min(1-region.y,region.h))*height));
  return{x,y,w,h};
}

function strengthRatio(strength){
  return Math.max(0,Math.min(1,(Number(strength||45)-1)/99));
}

function drawPixelate(ctx,canvas,rect,strength){
  const amount=strengthRatio(strength);
  const minSide=Math.max(1,Math.min(rect.w,rect.h));
  const block=Math.max(2,Math.round(minSide*(.025+amount*.24)));
  const smallW=Math.max(1,Math.ceil(rect.w/block));
  const smallH=Math.max(1,Math.ceil(rect.h/block));
  const temp=document.createElement('canvas');temp.width=smallW;temp.height=smallH;
  const t=temp.getContext('2d',{alpha:false});
  t.imageSmoothingEnabled=false;
  t.drawImage(canvas,rect.x,rect.y,rect.w,rect.h,0,0,smallW,smallH);
  ctx.save();ctx.imageSmoothingEnabled=false;
  ctx.drawImage(temp,0,0,smallW,smallH,rect.x,rect.y,rect.w,rect.h);
  ctx.restore();
}

function drawBlur(ctx,canvas,rect,strength){
  const temp=document.createElement('canvas');temp.width=rect.w;temp.height=rect.h;
  const t=temp.getContext('2d',{alpha:true});
  t.drawImage(canvas,rect.x,rect.y,rect.w,rect.h,0,0,rect.w,rect.h);
  const amount=strengthRatio(strength);
  const minSide=Math.max(1,Math.min(rect.w,rect.h));
  const radius=Math.max(2,Math.round(minSide*(.018+amount*.15)));
  ctx.save();
  ctx.beginPath();ctx.rect(rect.x,rect.y,rect.w,rect.h);ctx.clip();
  ctx.filter=`blur(${radius}px)`;
  ctx.drawImage(temp,rect.x,rect.y,rect.w,rect.h);
  ctx.filter='none';ctx.restore();
}

function drawRegion(ctx,canvas,region){
  const rect=normalizedRect(region,canvas.width,canvas.height);
  if(region.mode==='block'){
    ctx.save();ctx.fillStyle=region.color||'#111827';ctx.fillRect(rect.x,rect.y,rect.w,rect.h);ctx.restore();
  }else if(region.mode==='blur'){
    drawBlur(ctx,canvas,rect,region.strength||45);
  }else{
    drawPixelate(ctx,canvas,rect,region.strength||45);
  }
}

async function renderCanvas(file,regions=[],maxDimension=0,onProgress=()=>{}){
  onProgress(5);
  const image=await cachedDecode(file);
  const source=dimensions(image);
  if(!source.width||!source.height)throw new Error('decode_failed:dimensions');
  const scale=maxDimension>0?Math.min(1,maxDimension/Math.max(source.width,source.height)):1;
  const width=Math.max(1,Math.round(source.width*scale));
  const height=Math.max(1,Math.round(source.height*scale));
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:true});
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.drawImage(image,0,0,width,height);
  onProgress(30);
  regions.forEach((region,index)=>{
    drawRegion(ctx,canvas,region);
    onProgress(30+Math.round(((index+1)/Math.max(1,regions.length))*52));
  });
  return{canvas,width,height,sourceWidth:source.width,sourceHeight:source.height};
}

export async function renderRedactPreview(file,regions=[],maxDimension=1200){
  return renderCanvas(file,regions,Math.max(480,Math.min(1400,Number(maxDimension)||1200)));
}

export async function applyRedactions(file,regions=[],onProgress=()=>{}){
  if(!regions.length)throw new Error('redact_regions_required');
  const rendered=await renderCanvas(file,regions,0,p=>onProgress(Math.round(p*.88)));
  const outputType=outputTypeFor(file);
  const blob=await canvasBlob(rendered.canvas,outputType,outputType==='image/png'?undefined:.94);
  onProgress(100);
  const base=file.name.replace(/\.[^.]+$/,'');
  return{
    blob,
    outputName:`${base}_redacted.${extensionFor(outputType)}`,
    outputType,
    quality:outputType==='image/png'?1:.94,
    metTarget:true,
    targetBytes:Number.POSITIVE_INFINITY,
    originalSize:file.size,
    originalWidth:rendered.sourceWidth,
    originalHeight:rendered.sourceHeight,
    outputWidth:rendered.sourceWidth,
    outputHeight:rendered.sourceHeight,
    sourceName:file.name,
    operation:'redact',
    regionCount:regions.length
  };
}
