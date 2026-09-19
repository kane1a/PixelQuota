import { decodeFile } from './compress.js';

const decodeCache=new Map();

function dimensions(image) {
  return { width:image.width || image.naturalWidth, height:image.height || image.naturalHeight };
}

function canvasBlob(canvas,type,quality) {
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('watermark_encode_failed')),type,quality));
}

async function cachedDecode(blob) {
  let pending=decodeCache.get(blob);
  if(!pending){
    pending=decodeFile(blob);
    decodeCache.set(blob,pending);
  }
  return pending;
}

function releaseDecoded(blob) {
  const pending=decodeCache.get(blob);
  if(!pending)return;
  decodeCache.delete(blob);
  pending.then(image=>setTimeout(()=>image?.close?.(),750)).catch(()=>{});
}

export function clearWatermarkCache(blob=null) {
  if(blob)return releaseDecoded(blob);
  for(const key of [...decodeCache.keys()])releaseDecoded(key);
}

function outputTypeFor(file) {
  if (file.type==='image/png') return 'image/png';
  if (file.type==='image/webp') return 'image/webp';
  return 'image/jpeg';
}

function extensionFor(type) {
  return type==='image/png'?'png':type==='image/webp'?'webp':'jpg';
}

function positionPoint(position,width,height,margin,boxWidth=0,boxHeight=0) {
  const pos=String(position||'br');
  const vertical=pos[0]||'b';
  const horizontal=pos[1]||'r';
  const x=horizontal==='l'?margin:horizontal==='c'?(width-boxWidth)/2:width-margin-boxWidth;
  const y=vertical==='t'?margin:vertical==='m'?(height-boxHeight)/2:height-margin-boxHeight;
  return {x:Math.max(0,x),y:Math.max(0,y)};
}

function wrapText(ctx,text,maxWidth) {
  const lines=[];
  for(const paragraph of String(text).split(/\r?\n/)){
    if(!paragraph){lines.push('');continue;}
    let line='';
    for(const character of Array.from(paragraph)){
      const candidate=line+character;
      if(line&&ctx.measureText(candidate).width>maxWidth){
        lines.push(line.trimEnd());
        line=character===' '?'':character;
      }else line=candidate;
    }
    lines.push(line.trimEnd());
  }
  return lines.length?lines:[''];
}

function drawTextWatermark(ctx,text,opts,width,height) {
  if(!text)return null;
  const opacity=Math.max(.1,Math.min(1,Number(opts.opacity)||.55));
  const requested=Math.max(.02,Math.min(.30,Number(opts.size)||.06));
  const fontSize=Math.max(12,Math.round(Math.min(width,height)*requested));
  ctx.font=`700 ${fontSize}px "Segoe UI", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", "Noto Sans JP", "Noto Sans KR", Arial, sans-serif`;
  if('letterSpacing' in ctx)ctx.letterSpacing=`${Math.max(.2,fontSize*.018)}px`;

  const maxTextWidth=Math.max(40,width*.86);
  const lines=wrapText(ctx,text,maxTextWidth);
  const lineHeight=Math.round(fontSize*1.22);
  const textWidth=Math.max(...lines.map(line=>ctx.measureText(line||' ').width),1);
  const textHeight=Math.max(lineHeight,lines.length*lineHeight);
  const blockWidth=Math.min(width,textWidth),blockHeight=Math.min(height,textHeight);
  const margin=Math.max(12,Math.round(fontSize*.38));
  const point=positionPoint(opts.position||'br',width,height,margin,blockWidth,blockHeight);

  ctx.save();
  ctx.globalAlpha=opacity;
  ctx.textAlign='left';
  ctx.textBaseline='top';
  ctx.fillStyle=opts.color||'#ffffff';
  ctx.shadowColor='rgba(0,0,0,.24)';
  ctx.shadowBlur=Math.max(1,fontSize*.045);
  ctx.shadowOffsetY=Math.max(1,fontSize*.022);
  const textAlign=['left','center','right'].includes(opts.textAlign)?opts.textAlign:'left';
  lines.forEach((line,index)=>{
    const y=point.y+index*lineHeight;
    const lineWidth=ctx.measureText(line||' ').width;
    const x=point.x+(textAlign==='center'?(blockWidth-lineWidth)/2:textAlign==='right'?blockWidth-lineWidth:0);
    ctx.fillText(line,x,y);
  });
  ctx.restore();
  return {fontSize,lineCount:lines.length,blockWidth,blockHeight,textAlign,background:false};
}

async function renderWatermarkOverlayCanvas(file,opts={},maxDimension=640) {
  const image=await cachedDecode(file),source=dimensions(image);
  if(!source.width||!source.height)throw new Error('decode_failed:dimensions');
  const scale=Math.min(1,maxDimension/Math.max(source.width,source.height));
  const width=Math.max(1,Math.round(source.width*scale)),height=Math.max(1,Math.round(source.height*scale));
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:true});ctx.clearRect(0,0,width,height);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  const imageFile=opts.imageFile instanceof Blob?opts.imageFile:null;
  if(imageFile){
    const logo=await cachedDecode(imageFile),logoSize=dimensions(logo);
    if(logoSize.width&&logoSize.height){
      const ratio=Math.max(.05,Math.min(.5,Number(opts.imageSize)||.2));
      const fit=Math.min((width*ratio)/logoSize.width,(height*ratio)/logoSize.height);
      const drawW=Math.max(1,Math.round(logoSize.width*fit)),drawH=Math.max(1,Math.round(logoSize.height*fit));
      const margin=Math.max(10,Math.round(Math.min(width,height)*.025));
      const point=positionPoint(opts.imagePosition||'tl',width,height,margin,drawW,drawH);
      ctx.save();ctx.globalAlpha=Math.max(.1,Math.min(1,Number(opts.imageOpacity)||.8));ctx.drawImage(logo,point.x,point.y,drawW,drawH);ctx.restore();
    }
  }
  const textMetrics=drawTextWatermark(ctx,String(opts.text||'').trim(),opts,width,height);
  return{canvas,sourceWidth:source.width,sourceHeight:source.height,width,height,textMetrics};
}

async function renderWatermarkCanvas(file,opts={},renderOpts={}) {
  const {maxDimension=0,onProgress=()=>{}}=renderOpts;
  onProgress(5);
  const image=await cachedDecode(file);
  const source=dimensions(image);
  if(!source.width||!source.height) throw new Error('decode_failed:dimensions');

  const scale=maxDimension>0?Math.min(1,maxDimension/Math.max(source.width,source.height)):1;
  const width=Math.max(1,Math.round(source.width*scale));
  const height=Math.max(1,Math.round(source.height*scale));
  const canvas=document.createElement('canvas');
  canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:true});
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality='high';
  ctx.drawImage(image,0,0,width,height);
  onProgress(30);

  const imageFile=opts.imageFile instanceof Blob?opts.imageFile:null;
  if(imageFile){
    const logo=await cachedDecode(imageFile);
    const logoSize=dimensions(logo);
    if(logoSize.width&&logoSize.height){
      const ratio=Math.max(.05,Math.min(.5,Number(opts.imageSize)||.2));
      const fit=Math.min((width*ratio)/logoSize.width,(height*ratio)/logoSize.height);
      const drawW=Math.max(1,Math.round(logoSize.width*fit));
      const drawH=Math.max(1,Math.round(logoSize.height*fit));
      const margin=Math.max(10,Math.round(Math.min(width,height)*.025));
      const point=positionPoint(opts.imagePosition||'tl',width,height,margin,drawW,drawH);
      ctx.save();
      ctx.globalAlpha=Math.max(.1,Math.min(1,Number(opts.imageOpacity)||.8));
      ctx.drawImage(logo,point.x,point.y,drawW,drawH);
      ctx.restore();
    }
  }
  onProgress(58);

  const textMetrics=drawTextWatermark(ctx,String(opts.text||'').trim(),opts,width,height);
  onProgress(82);
  return {canvas,sourceWidth:source.width,sourceHeight:source.height,width,height,textMetrics};
}

export async function renderWatermarkPreview(file,opts={}) {
  return renderWatermarkOverlayCanvas(file,opts,640);
}

export async function applyWatermarks(file,opts={},onProgress=()=>{}) {
  const text=String(opts.text||'').trim();
  const imageFile=opts.imageFile instanceof Blob?opts.imageFile:null;
  if(!text&&!imageFile) throw new Error('watermark_content_required');
  const rendered=await renderWatermarkCanvas(file,opts,{onProgress:p=>onProgress(Math.round(p*.88))});
  const outputType=outputTypeFor(file);
  const blob=await canvasBlob(rendered.canvas,outputType,outputType==='image/png'?undefined:.94);
  onProgress(100);

  const base=file.name.replace(/\.[^.]+$/,'');
  const kinds=[text?'text':null,imageFile?'image':null].filter(Boolean);
  return {
    blob,
    outputName:`${base}_watermarked.${extensionFor(outputType)}`,
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
    operation:'watermark',
    watermarkText:text,
    watermarkTextAlign:['left','center','right'].includes(opts.textAlign)?opts.textAlign:'left',
    watermarkImageName:imageFile?.name||'',
    watermarkKinds:kinds
  };
}
