import { decodeFile } from './compress.js';

const decodeCache=new WeakMap();
const aiMatteCache=new WeakMap();
const TRANSFORMERS_CDN='https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';
// The original 1024px BiRefNet Lite ONNX graph is too memory-heavy for
// reliable onnxruntime-web inference. This browser-oriented export predicts
// a fixed-size matte; PixelQuota reuses that same matte for preview/refinement
// and scales it to the source dimensions when composing the final PNG.
const AI_MODEL_ID='studioludens/birefnet-lite-512';
const AI_CACHE_DB='pixelquota-ai-cache-v1',AI_CACHE_STORE='responses';
let transformersModule=null,aiModel=null,aiProcessor=null,aiPipelinePromise=null,cacheProbePromise=null;
const aiState={status:'idle',progress:0,message:'',modelId:AI_MODEL_ID,dtype:'fp16',device:'',cached:false,persistent:false};

function cacheKey(input){return typeof input==='string'?input:input?.url||String(input);}
function openAICacheDb(){
  if(!globalThis.indexedDB)return Promise.reject(new Error('indexeddb_unavailable'));
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(AI_CACHE_DB,1);
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(AI_CACHE_STORE))db.createObjectStore(AI_CACHE_STORE,{keyPath:'url'});};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error('indexeddb_open_failed'));
  });
}
async function idbGet(url){
  const db=await openAICacheDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(AI_CACHE_STORE,'readonly'),request=tx.objectStore(AI_CACHE_STORE).get(url);
    request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);
    tx.oncomplete=()=>db.close();tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
async function idbPut(record){
  const db=await openAICacheDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(AI_CACHE_STORE,'readwrite');tx.objectStore(AI_CACHE_STORE).put(record);
    tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
async function idbKeys(){
  const db=await openAICacheDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(AI_CACHE_STORE,'readonly'),request=tx.objectStore(AI_CACHE_STORE).getAllKeys();
    request.onsuccess=()=>resolve(request.result||[]);request.onerror=()=>reject(request.error);
    tx.oncomplete=()=>db.close();tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
const persistentAICache={
  async match(input){
    try{
      const record=await idbGet(cacheKey(input));if(!record)return undefined;
      return new Response(record.blob,{status:record.status||200,statusText:record.statusText||'OK',headers:record.headers||{}});
    }catch{return undefined;}
  },
  async put(input,response){
    const url=cacheKey(input),clone=response.clone(),headers={};clone.headers.forEach((value,key)=>{headers[key]=value;});
    const blob=await clone.blob();
    await idbPut({url,blob,status:clone.status,statusText:clone.statusText,headers,storedAt:Date.now()});
  }
};

function dimensions(image){
  return{width:image.naturalWidth||image.width||0,height:image.naturalHeight||image.height||0};
}

async function cachedDecode(file){
  let pending=decodeCache.get(file);
  if(!pending){pending=decodeFile(file);decodeCache.set(file,pending);}
  return pending;
}

export function clearBackgroundRemovalCache(file){
  if(file){decodeCache.delete(file);aiMatteCache.delete(file);}
}

export function hasBackgroundAIMatte(file){return !!(file&&aiMatteCache.has(file));}

function median(values){
  const sorted=[...values].sort((a,b)=>a-b);
  const mid=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
}

function estimateEdgeColor(data,width,height){
  const points=[];
  const add=(x,y)=>{
    const i=(Math.max(0,Math.min(height-1,y))*width+Math.max(0,Math.min(width-1,x)))*4;
    if(data[i+3]>8)points.push([data[i],data[i+1],data[i+2]]);
  };
  const xs=[0,Math.round(width*.12),Math.round(width*.5),Math.round(width*.88),width-1];
  const ys=[0,Math.round(height*.12),Math.round(height*.5),Math.round(height*.88),height-1];
  xs.forEach(x=>{add(x,0);add(x,height-1);});
  ys.forEach(y=>{add(0,y);add(width-1,y);});
  if(!points.length)return[255,255,255];
  return[
    Math.round(median(points.map(p=>p[0]))),
    Math.round(median(points.map(p=>p[1]))),
    Math.round(median(points.map(p=>p[2])))
  ];
}

function applyDemoMask(ctx,width,height,sensitivity=.48){
  const imageData=ctx.getImageData(0,0,width,height),data=imageData.data;
  const [br,bg,bb]=estimateEdgeColor(data,width,height);
  const normalized=Math.max(0,Math.min(1,Number(sensitivity)||.48));
  const threshold=18+normalized*92;
  const feather=34;
  let transparentPixels=0;
  for(let i=0;i<data.length;i+=4){
    const dr=data[i]-br,dg=data[i+1]-bg,db=data[i+2]-bb;
    const distance=Math.sqrt(dr*dr+dg*dg+db*db);
    const keep=Math.max(0,Math.min(1,(distance-threshold)/feather));
    data[i+3]=Math.round(data[i+3]*keep);
    if(data[i+3]<8)transparentPixels++;
  }
  ctx.putImageData(imageData,0,0);
  return{backgroundColor:[br,bg,bb],transparentRatio:transparentPixels/(width*height),threshold};
}

async function render(file,opts={},maxDimension=0,onProgress=()=>{}){
  onProgress(6);
  const image=await cachedDecode(file),source=dimensions(image);
  if(!source.width||!source.height)throw new Error('decode_failed:dimensions');
  const scale=maxDimension>0?Math.min(1,maxDimension/Math.max(source.width,source.height)):1;
  const width=Math.max(1,Math.round(source.width*scale)),height=Math.max(1,Math.round(source.height*scale));
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:true,willReadFrequently:true});
  ctx.clearRect(0,0,width,height);
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.drawImage(image,0,0,width,height);onProgress(34);
  const mask=applyDemoMask(ctx,width,height,opts.sensitivity);onProgress(86);
  return{canvas,width,height,sourceWidth:source.width,sourceHeight:source.height,mask};
}

function canvasBlob(canvas){
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('encode_failed')),'image/png'));
}

export const BACKGROUND_REMOVAL_ENGINE={
  id:'local-edge-demo',
  aiId:'birefnet-lite-512-fp16',
  aiModelId:AI_MODEL_ID,
  state:'demo',
  productionModelBundled:false,
  uploadsImages:false
};

export function getBackgroundAIState(){return{...aiState,ready:!!aiModel&&!!aiProcessor};}

function emitAIProgress(callback,patch={}){
  Object.assign(aiState,patch);callback?.(getBackgroundAIState());
}

async function chooseAIExecutionDevice(){
  if(!globalThis.navigator?.gpu)return'wasm';
  try{
    const adapter=await globalThis.navigator.gpu.requestAdapter();
    return adapter?'webgpu':'wasm';
  }catch{return'wasm';}
}

export async function probeBackgroundAICache(){
  if(cacheProbePromise)return cacheProbePromise;
  cacheProbePromise=(async()=>{
    let cached=false,persistent=false;
    try{
      const keys=await idbKeys(),needle=AI_MODEL_ID.toLowerCase();
      cached=keys.some(key=>String(key).toLowerCase().includes(needle)&&/model_fp16\.onnx|model\.onnx/.test(String(key)));
      if(navigator.storage?.persisted)persistent=await navigator.storage.persisted();
    }catch{}
    emitAIProgress(()=>{},{cached,persistent,status:cached?'cached':aiState.status});
    return getBackgroundAIState();
  })();
  return cacheProbePromise;
}

async function configureTransformersCache(transformers){
  if(!transformers?.env)return;
  transformers.env.allowLocalModels=false;
  if('useBrowserCache' in transformers.env)transformers.env.useBrowserCache=false;
  if('useCustomCache' in transformers.env)transformers.env.useCustomCache=true;
  if('customCache' in transformers.env)transformers.env.customCache=persistentAICache;
  if('useWasmCache' in transformers.env)transformers.env.useWasmCache=true;
  try{
    if(navigator.storage?.persist){
      const persistent=await navigator.storage.persist();
      emitAIProgress(()=>{},{persistent:!!persistent});
    }
  }catch{}
}

export async function loadBackgroundAIModel(onState=()=>{}){
  if(aiModel&&aiProcessor){emitAIProgress(onState,{status:'ready',progress:100,message:'',cached:true});return{model:aiModel,processor:aiProcessor,transformers:transformersModule};}
  if(aiPipelinePromise)return aiPipelinePromise;
  const testAdapter=globalThis.__PIXELQUOTA_AI_ADAPTER__;
  if(testAdapter?.load){
    aiPipelinePromise=Promise.resolve(testAdapter.load(state=>emitAIProgress(onState,state))).then(pipe=>{aiModel=pipe||testAdapter;aiProcessor=testAdapter;transformersModule=testAdapter;emitAIProgress(onState,{status:'ready',progress:100,message:'',cached:true});return{model:aiModel,processor:aiProcessor,transformers:transformersModule};}).catch(error=>{aiPipelinePromise=null;emitAIProgress(onState,{status:'error',message:String(error?.message||error)});throw error;});
    return aiPipelinePromise;
  }
  emitAIProgress(onState,{status:'loading',progress:1,message:''});
  aiPipelinePromise=(async()=>{
    try{
      const dynamicImport=new Function('url','return import(url)');
      const transformers=await dynamicImport(TRANSFORMERS_CDN);transformersModule=transformers;
      emitAIProgress(onState,{status:'loading',progress:5});
      await configureTransformersCache(transformers);
      const device=await chooseAIExecutionDevice();
      emitAIProgress(onState,{status:'loading',device});
      const progress_callback=event=>{
        const progress=Number(event?.progress);
        if(Number.isFinite(progress))emitAIProgress(onState,{status:'loading',progress:Math.max(5,Math.min(99,progress)),message:event?.file||''});
        else emitAIProgress(onState,{status:'loading',message:event?.file||event?.status||''});
      };
      aiModel=await transformers.AutoModel.from_pretrained(AI_MODEL_ID,{
        dtype:'fp16',
        device,
        progress_callback
      });
      aiProcessor=await transformers.AutoProcessor.from_pretrained(AI_MODEL_ID,{progress_callback});
      cacheProbePromise=null;await probeBackgroundAICache();
      emitAIProgress(onState,{status:'ready',progress:100,message:'',cached:true,device});
      return{model:aiModel,processor:aiProcessor,transformers};
    }catch(error){
      aiModel=null;aiProcessor=null;aiPipelinePromise=null;
      emitAIProgress(onState,{status:'error',message:String(error?.message||error)});
      throw error;
    }
  })();
  return aiPipelinePromise;
}

function canvasToBlob(canvas,type='image/png',quality){
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('encode_failed')),type,quality));
}

function refineAlpha(value,threshold=.5,feather=.18){
  const alpha=Math.max(0,Math.min(1,Number(value)/255));
  const center=Math.max(.08,Math.min(.92,Number(threshold)||.5));
  const spread=Math.max(.01,Math.min(.7,Number(feather)||.18));
  const low=center-spread/2,high=center+spread/2;
  if(alpha<=low)return 0;if(alpha>=high)return 255;
  const x=(alpha-low)/(high-low),smooth=x*x*(3-2*x);
  return Math.round(smooth*255);
}

function drawMaskToCanvas(mask,width,height,opts={}){
  const maskWidth=Number(mask?.width||0),maskHeight=Number(mask?.height||0),channels=Number(mask?.channels||1),data=mask?.data;
  if(!maskWidth||!maskHeight||!data)throw new Error('ai_mask_invalid');
  const raw=document.createElement('canvas');raw.width=maskWidth;raw.height=maskHeight;
  const ctx=raw.getContext('2d',{alpha:true}),imageData=ctx.createImageData(maskWidth,maskHeight);
  for(let i=0;i<maskWidth*maskHeight;i++){
    const value=refineAlpha(data[i*channels]??0,opts.aiThreshold,opts.aiFeather),j=i*4;
    imageData.data[j]=255;imageData.data[j+1]=255;imageData.data[j+2]=255;imageData.data[j+3]=value;
  }
  ctx.putImageData(imageData,0,0);
  if(maskWidth===width&&maskHeight===height)return raw;
  const scaled=document.createElement('canvas');scaled.width=width;scaled.height=height;
  const sx=scaled.getContext('2d',{alpha:true});sx.imageSmoothingEnabled=true;sx.imageSmoothingQuality='high';sx.drawImage(raw,0,0,width,height);
  return scaled;
}

async function inferAIMatte(file,onProgress=()=>{}){
  const cached=aiMatteCache.get(file);
  if(cached){onProgress(72);return cached;}
  const testAdapter=globalThis.__PIXELQUOTA_AI_ADAPTER__;
  if(testAdapter?.infer){
    const inferred=await testAdapter.infer(file,onProgress);
    if(!inferred?.data||!inferred?.width||!inferred?.height)throw new Error('ai_test_matte_invalid');
    const matte={width:inferred.width,height:inferred.height,channels:inferred.channels||1,data:new Uint8Array(inferred.data),sourceWidth:inferred.sourceWidth,sourceHeight:inferred.sourceHeight};
    aiMatteCache.set(file,matte);return matte;
  }
  const loaded=await loadBackgroundAIModel(state=>onProgress(Math.max(0,Math.min(55,Math.round((state.progress||0)*.55)))));
  const {model,processor,transformers}=loaded;
  const image=await cachedDecode(file),source=dimensions(image);
  if(!source.width||!source.height)throw new Error('decode_failed:dimensions');
  // Inference is deliberately independent from preview/export size. BiRefNet
  // itself predicts one 512px matte; that exact raw matte is cached and reused
  // for both the on-screen preview and full-resolution PNG export.
  const inferenceScale=Math.min(1,1024/Math.max(source.width,source.height));
  const inferenceWidth=Math.max(1,Math.round(source.width*inferenceScale)),inferenceHeight=Math.max(1,Math.round(source.height*inferenceScale));
  const inferenceCanvas=document.createElement('canvas');inferenceCanvas.width=inferenceWidth;inferenceCanvas.height=inferenceHeight;
  const inferenceCtx=inferenceCanvas.getContext('2d',{alpha:true});inferenceCtx.drawImage(image,0,0,inferenceWidth,inferenceHeight);onProgress(60);
  const sourceBlob=await canvasToBlob(inferenceCanvas,'image/png');
  let pixelValues,output,tensor;
  try{
    const rawImage=await transformers.RawImage.fromBlob(sourceBlob);
    const processed=await processor(rawImage);pixelValues=processed.pixel_values;onProgress(68);
    output=await model({input_image:pixelValues});onProgress(90);
    const logits=output?.logits||output?.output_image;
    if(!logits)throw new Error(`ai_output_missing:${Object.keys(output||{}).join(',')}`);
    tensor=logits[0].sigmoid().mul(255).to('uint8');
    const mask=await transformers.RawImage.fromTensor(tensor);
    const matte={width:mask.width,height:mask.height,channels:mask.channels||1,data:new Uint8Array(mask.data),sourceWidth:source.width,sourceHeight:source.height};
    aiMatteCache.set(file,matte);onProgress(94);return matte;
  }finally{
    tensor?.dispose?.();pixelValues?.dispose?.();
    if(output&&typeof output==='object')Object.values(output).forEach(value=>value?.dispose?.());
  }
}

async function renderAI(file,opts={},maxDimension=0,onProgress=()=>{}){
  const matte=await inferAIMatte(file,onProgress);
  const image=await cachedDecode(file),source=dimensions(image);
  const scale=maxDimension>0?Math.min(1,maxDimension/Math.max(source.width,source.height)):1;
  const width=Math.max(1,Math.round(source.width*scale)),height=Math.max(1,Math.round(source.height*scale));
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:true});ctx.clearRect(0,0,width,height);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(image,0,0,width,height);
  const maskCanvas=drawMaskToCanvas(matte,width,height,opts);
  ctx.globalCompositeOperation='destination-in';ctx.drawImage(maskCanvas,0,0,width,height);ctx.globalCompositeOperation='source-over';onProgress(99);
  return{canvas,width,height,sourceWidth:source.width,sourceHeight:source.height,mask:{engine:'ai',threshold:opts.aiThreshold,feather:opts.aiFeather,rawWidth:matte.width,rawHeight:matte.height}};
}

export async function renderBackgroundRemovalPreview(file,opts={}){
  return opts.engine==='ai'?renderAI(file,opts,760):render(file,opts,760);
}

export async function renderBackgroundRemovalInspection(file,opts={}){
  // Edge inspection uses a larger composition canvas, but for AI it reuses
  // the cached raw matte instead of invoking BiRefNet again.
  return opts.engine==='ai'?renderAI(file,opts,3072):render(file,opts,3072);
}

export async function removeBackgroundDemo(file,opts={},onProgress=()=>{}){
  const isAI=opts.engine==='ai';
  const rendered=isAI?await renderAI(file,opts,0,onProgress):await render(file,opts,0,p=>onProgress(Math.round(p*.92)));
  const blob=await canvasBlob(rendered.canvas);onProgress(100);
  const base=file.name.replace(/\.[^.]+$/,'');
  return{
    blob,
    outputName:`${base}_background_removed.png`,
    outputType:'image/png',
    quality:1,
    metTarget:true,
    targetBytes:Number.POSITIVE_INFINITY,
    originalSize:file.size,
    originalWidth:rendered.sourceWidth,
    originalHeight:rendered.sourceHeight,
    outputWidth:rendered.sourceWidth,
    outputHeight:rendered.sourceHeight,
    sourceName:file.name,
    operation:'remove-bg',
    engine:isAI?BACKGROUND_REMOVAL_ENGINE.aiId:BACKGROUND_REMOVAL_ENGINE.id,
    transparentRatio:rendered.mask.transparentRatio??null,
    aiMatteWidth:isAI?rendered.mask.rawWidth??null:null,
    aiMatteHeight:isAI?rendered.mask.rawHeight??null:null,
    aiThreshold:isAI?rendered.mask.threshold??null:null,
    aiFeather:isAI?rendered.mask.feather??null:null
  };
}
