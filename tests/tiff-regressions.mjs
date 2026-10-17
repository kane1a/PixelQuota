import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

function tiff({tiled=false,lengths=null,type=4,offsetOverride=null}={}){
 const width=tiled?16:1,height=tiled?32:2,n=tiled?256:1;lengths??=[n,n];
 const entries=[[256,4,[width]],[257,4,[height]],[258,3,[8]],[259,3,[1]],[262,3,[1]],[277,3,[1]]];
 if(tiled)entries.push([322,4,[16]],[323,4,[16]],[324,4,[0,0]],[325,type,lengths]);else entries.push([273,4,[0,0]],[278,4,[1]],[279,type,lengths]);
 entries.sort((a,b)=>a[0]-b[0]);const size=t=>t===3?2:[5,12].includes(t)?8:4;let cursor=8+2+12*entries.length+4;
 for(const e of entries){e[3]=e[2].length*size(e[1])<=4?null:cursor;if(e[3]!==null)cursor+=e[2].length*size(e[1]);}
 const pixelStart=cursor;entries.find(e=>e[0]===(tiled?324:273))[2]=offsetOverride||[pixelStart,pixelStart+n];
 const bytes=Buffer.alloc(pixelStart+2*n);bytes.write('II');bytes.writeUInt16LE(42,2);bytes.writeUInt32LE(8,4);bytes.writeUInt16LE(entries.length,8);
 for(let i=0;i<entries.length;i++){
  const[tag,kind,values,extra]=entries[i],offset=10+i*12;bytes.writeUInt16LE(tag,offset);bytes.writeUInt16LE(kind,offset+2);bytes.writeUInt32LE(values.length,offset+4);if(extra!==null)bytes.writeUInt32LE(extra,offset+8);const start=extra??offset+8;
  values.forEach((v,j)=>{const at=start+j*size(kind);if(kind===3)bytes.writeUInt16LE(v,at);else if(kind===12)bytes.writeDoubleLE(v,at);else if(kind===9)bytes.writeInt32LE(v,at);else if(kind===5){bytes.writeUInt32LE(v[0],at);bytes.writeUInt32LE(v[1],at+4);}else bytes.writeUInt32LE(v,at);});
 }
 bytes.fill(64,pixelStart,pixelStart+n);bytes.fill(192,pixelStart+n);return{bytes,width,height};
}

const typeBytes={1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8,13:4};
function advancedTiff(o={}){
 const width=o.width??1,height=o.height??2,channels=o.channels??1,planar=o.planar??1;
 const tiled=!!o.tiled,both=!!o.both,hasTiles=tiled||both,hasStrips=!tiled||both;
 const tileWidth=o.tileWidth??(tiled?16:1),tileHeight=o.tileHeight??(tiled?16:1);
 const rowsPerStrip=o.rowsPerStrip??1,rps=rowsPerStrip>0?Math.min(rowsPerStrip,height):1;
 const stripsPerPlane=Math.ceil(height/rps),tilesPerPlane=tileWidth>0&&tileHeight>0?Math.ceil(width/tileWidth)*Math.ceil(height/tileHeight):1;
 const stripCount=o.stripCount??stripsPerPlane*(planar===2?channels:1),tileCount=o.tileCount??tilesPerPlane*(planar===2?channels:1);
 const samples=planar===2?1:channels;
 const bits=o.bits??8;
 const stripSizes=Array.from({length:stripCount},(_,i)=>Math.max(1,Math.ceil(width*bits*samples/8)*Math.min(rps,Math.max(1,height-(i%stripsPerPlane)*rps))));
 const tileSizes=Array(Math.max(0,tileCount)).fill(Math.max(1,Math.ceil(tileWidth*tileHeight*bits*samples/8)));
 const chosenSizes=tiled?tileSizes:stripSizes,pixels=Buffer.alloc(chosenSizes.reduce((a,b)=>a+b,0));
 if(o.pixelBytes)Buffer.from(o.pixelBytes).copy(pixels);
 else{let at=0;const fills=o.segmentFills??(planar===2?[64,80,100,110,150,160]:[64,192]);for(let i=0;i<chosenSizes.length;i++){pixels.fill(fills[i%fills.length]??64,at,at+chosenSizes[i]);at+=chosenSizes[i];}}
 const entries=[
  {tag:256,type:4,values:[width]},{tag:257,type:4,values:[height]},
  {tag:258,type:3,values:Array(channels).fill(bits)},{tag:259,type:3,values:[1]},
  {tag:262,type:3,values:[o.photometric??1]},{tag:277,type:3,values:[channels]}
 ];
 if(planar===2)entries.push({tag:284,type:3,values:[2]});
 if(hasStrips){if(!o.omitRowsPerStrip)entries.push({tag:278,type:4,values:[rowsPerStrip]});entries.push({tag:273,type:4,values:Array(stripCount).fill(0)},{tag:279,type:o.stripType??o.type??4,values:o.stripLengths??(both?stripSizes:o.lengths??stripSizes)});}
 if(hasTiles)entries.push({tag:322,type:4,values:[tileWidth]},{tag:323,type:4,values:[tileHeight]},{tag:324,type:4,values:Array(tileCount).fill(0)},{tag:325,type:o.tileType??o.type??4,values:o.tileLengths??(both?tileSizes:o.lengths??tileSizes)});
 if(o.metadata)entries.push({tag:330,type:4,values:[0]},{tag:34665,type:4,values:[0]},{tag:34853,type:4,values:[0]});
 if(o.subCycle)entries.push({tag:330,type:4,values:[8]});
 for(const [tag,type,values,count] of o.extraEntries??[])entries.push({tag,type,values,count});
 for(const entry of entries)if(o.countOverrides?.[entry.tag]!==undefined)entry.count=o.countOverrides[entry.tag];
 entries.sort((a,b)=>a.tag-b.tag);
 let cursor=8+2+entries.length*12+4;
 for(const entry of entries){const count=entry.count??entry.values.length,size=typeBytes[entry.type];entry.external=count*size>4;entry.valueOffset=entry.external?cursor:null;if(entry.external)cursor+=entry.values.length*size;}
 const pixelStart=cursor,metadataStart=pixelStart+pixels.length;
 if(o.metadata){const offsets=[metadataStart,metadataStart+18,metadataStart+36];for(const tag of[330,34665,34853])entries.find(e=>e.tag===tag).values[0]=offsets.shift();}
 const metadataCount=o.metadata?3:0,total=metadataStart+metadataCount*18,bytes=Buffer.alloc(Math.max(total,o.truncateTo??0));
 bytes.write('II');bytes.writeUInt16LE(42,2);bytes.writeUInt32LE(8,4);bytes.writeUInt16LE(entries.length,8);
 function put(target,at,type,value){if(type===3)target.writeUInt16LE(Number(value)&65535,at);else if(type===5||type===10){target.writeUInt32LE(Number(value[0])>>>0,at);target.writeUInt32LE(Number(value[1])>>>0,at+4);}else if(type===8)target.writeInt16LE(Number(value),at);else if(type===9)target.writeInt32LE(Number(value),at);else if(type===11)target.writeFloatLE(Number(value),at);else if(type===12)target.writeDoubleLE(Number(value),at);else if(type===1||type===6||type===7)target[at]=Number(value)&255;else target.writeUInt32LE(Number(value)>>>0,at);}
 for(let i=0;i<entries.length;i++){const e=entries[i],at=10+i*12,count=e.count??e.values.length;bytes.writeUInt16LE(e.tag,at);bytes.writeUInt16LE(e.type,at+2);bytes.writeUInt32LE(count,at+4);if(e.external)bytes.writeUInt32LE(e.valueOffset,at+8);else e.values.forEach((v,j)=>put(bytes,at+8+j*typeBytes[e.type],e.type,v));if(e.external)e.values.forEach((v,j)=>put(bytes,e.valueOffset+j*typeBytes[e.type],e.type,v));}
 const offsets=[];let dataAt=pixelStart;for(const n of chosenSizes){offsets.push(dataAt);dataAt+=n;}
 function replace(tag,values){const e=entries.find(x=>x.tag===tag);if(e)e.values=values;}
 if(hasStrips)replace(273,o.stripOffsets??Array.from({length:stripCount},(_,i)=>offsets[i]??pixelStart));
 if(hasTiles)replace(324,o.tileOffsets??Array.from({length:tileCount},(_,i)=>offsets[i]??pixelStart));
 for(let i=0;i<entries.length;i++){const e=entries[i];if(e.tag!==273&&e.tag!==324)continue;const at=10+i*12;if(e.external)e.values.forEach((v,j)=>put(bytes,e.valueOffset+j*4,4,v));else e.values.forEach((v,j)=>put(bytes,at+8+j*4,4,v));}
 pixels.copy(bytes,pixelStart);const nextAt=10+entries.length*12;bytes.writeUInt32LE(o.nextCycle?8:0,nextAt);
 if(o.metadata)for(const at of[metadataStart,metadataStart+18,metadataStart+36]){bytes.writeUInt16LE(1,at);bytes.writeUInt16LE(274,at+2);bytes.writeUInt16LE(3,at+4);bytes.writeUInt32LE(1,at+6);bytes.writeUInt16LE(1,at+10);bytes.writeUInt32LE(0,at+14);}
 return{bytes:o.truncateTo===undefined?bytes:bytes.subarray(0,o.truncateTo),width,height};
}
function hugeCountTiff(){
 const bytes=Buffer.alloc(124);bytes.write('II');bytes.writeUInt16LE(42,2);bytes.writeUInt32LE(8,4);bytes.writeUInt16LE(7,8);
 const entries=[[256,4,1,1],[257,4,1,2],[258,3,1,8],[259,3,1,1],[273,4,1000000,98],[277,3,1,1],[279,4,1,2]];
 for(let i=0;i<entries.length;i++){const[tag,type,count,value]=entries[i],at=10+i*12;bytes.writeUInt16LE(tag,at);bytes.writeUInt16LE(type,at+2);bytes.writeUInt32LE(count,at+4);if(type===3)bytes.writeUInt16LE(value,at+8);else bytes.writeUInt32LE(value,at+8);}
 bytes.writeUInt32LE(0,94);bytes.writeUInt32LE(102,98);bytes[102]=64;bytes[103]=192;return{bytes,width:1,height:2};
}
const baseCases=[
 {id:'valid-strips',reject:false},{id:'valid-tiles',tiled:true,reject:false},
 {id:'strips-short-bytecounts',lengths:[1],reject:true},{id:'strips-extra-bytecounts',lengths:[1,1,1],reject:true},
 {id:'strips-zero-bytecount',lengths:[1,0],reject:true},{id:'strips-negative-bytecount',type:9,lengths:[1,-1],reject:true},
 {id:'strips-fractional-bytecount',type:12,lengths:[1,.5],reject:true},{id:'strips-nan-bytecount',type:12,lengths:[1,NaN],reject:true},
 {id:'strips-infinite-bytecount',type:12,lengths:[1,Infinity],reject:true},{id:'strips-rational-bytecount',type:5,lengths:[[1,1],[1,2]],reject:true},
 {id:'strips-out-of-bounds',lengths:[1,999],reject:true},{id:'strips-invalid-offset',offsetOverride:[1,2],reject:true},
 {id:'tiles-short-bytecounts',tiled:true,lengths:[256],reject:true},{id:'tiles-extra-bytecounts',tiled:true,lengths:[256,256,256],reject:true},
 {id:'tiles-zero-bytecount',tiled:true,lengths:[256,0],reject:true},{id:'valid-strips-recovery',reject:false},{id:'valid-tiles-recovery',tiled:true,reject:false}
];
const regressionCases=[
 {id:'preflight-large-strip-count',reject:true,errorPrefix:'decode_failed:tiff_ifd_value_limit'},
 {id:'preflight-oversized-value-product',extraEntries:[[65000,12,[],65536]],reject:true,errorPrefix:'decode_failed:tiff_ifd_value_bounds'},
 {id:'preflight-subifd-cycle',subCycle:true,reject:true,errorPrefix:'decode_failed:tiff_ifd_cycle'},
 {id:'preflight-tag50740-payload-cycle',extraEntries:[[50740,7,[8,0,0,0]]],reject:true,errorPrefix:'decode_failed:tiff_ifd_cycle'},
 {id:'preflight-next-ifd-cycle',nextCycle:true,reject:true,errorPrefix:'decode_failed:tiff_ifd_cycle'},
 {id:'preflight-truncated-directory',truncateTo:20,reject:true,errorPrefix:'decode_failed:tiff_ifd_bounds'},
 {id:'preflight-truncated-value-array',truncateTo:123,reject:true,errorPrefix:'decode_failed:tiff_ifd_value_bounds'},
 {id:'valid-metadata-exif-gps-subifd',metadata:true,reject:false},
 {id:'valid-1x1-no-worker-png-encoder',width:1,height:1,pixelBytes:[192],expectedFirst:[192,192,192,255],expectedLast:[192,192,192,255],reject:false},
 {id:'valid-rows-per-strip-whole-image',rowsPerStrip:2,pixelBytes:[64,192],reject:false},
 {id:'reject-missing-strip-segment',stripCount:1,reject:true,errorPrefix:'decode_failed:tiff_pixel_layout'},
 {id:'reject-missing-tile-segment',tiled:true,width:17,height:2,tileWidth:16,tileHeight:16,tileCount:1,reject:true,errorPrefix:'decode_failed:tiff_pixel_layout',recovery:{tiled:true,width:17,height:2,tileWidth:16,tileHeight:16,tileCount:2,segmentFills:[64,192]}},
 {id:'reject-zero-rows-per-strip',rowsPerStrip:0,reject:true,errorPrefix:'decode_failed:tiff_pixel_layout'},
 {id:'reject-zero-tile-width',tiled:true,tileWidth:0,reject:true,errorPrefix:'decode_failed:tiff_pixel_layout'},
 {id:'valid-planar-strips',channels:3,planar:2,photometric:2,segmentFills:[64,80,100,110,150,160],reject:false,expectedFirst:[64,100,150,255],expectedLast:[80,110,160,255]},
 {id:'valid-planar-tiles',tiled:true,width:1,height:2,tileWidth:1,tileHeight:1,channels:3,planar:2,photometric:2,segmentFills:[64,80,100,110,150,160],reject:false,expectedFirst:[64,100,150,255],expectedLast:[80,110,160,255]},
 {id:'reject-missing-planar-segment',channels:3,planar:2,photometric:2,stripCount:3,reject:true,errorPrefix:'decode_failed:tiff_pixel_layout'},
 {id:'reject-invalid-tile-even-with-valid-strip',both:true,tileOffsets:[999999,999999],reject:true,errorPrefix:'decode_failed:tiff_pixel_range'},
 {id:'valid-tile-selected-over-invalid-strip',both:true,stripOffsets:[999999,999999],reject:false},
 {id:'reject-unpaired-tile-bytecounts',tiled:true,width:17,height:2,tileWidth:16,tileHeight:16,lengths:[1],reject:true,errorPrefix:'decode_failed:tiff_pixel_layout'},
 {id:'reject-short-uncompressed-strip-bytecount',width:2,height:2,rowsPerStrip:1,lengths:[1,2],reject:true,errorPrefix:'decode_failed:tiff_pixel_bytes'},
 {id:'reject-short-uncompressed-tile-bytecount',tiled:true,lengths:[1],reject:true,errorPrefix:'decode_failed:tiff_pixel_bytes'},
 {id:'valid-one-bit-row-padded-strips',width:9,height:2,bits:1,rowsPerStrip:1,pixelBytes:[255,0,0,128],reject:false,expectedFirst:[255,255,255,255],expectedLast:[255,255,255,255]}
];
let cases=[...baseCases,...regressionCases].flatMap(c=>c.reject?[c,{...(c.recovery??{tiled:!!c.tiled,...(c.tiled?{pixelBytes:Array.from({length:17},(_,i)=>i===0?64:i===16?192:0)}:{})}),id:c.id+'-then-valid',reject:false}]:[c]);
const onlyArg=process.argv.find(value=>value.startsWith('--only='))?.slice(7);
if(onlyArg){const only=new Set(onlyArg.split(',').filter(Boolean));cases=cases.filter(c=>only.has(c.id)||[...only].some(id=>c.id===`${id}-then-valid`));}
function makeSample(c){return c.id==='preflight-large-strip-count'?hugeCountTiff():advancedTiff(c);}
function passes(c,actual,sample){
 if(c.errorPrefix)return !actual.decoded&&actual.error?.startsWith(c.errorPrefix);
 if(c.reject)return !actual.decoded&&actual.error?.startsWith('decode_failed:');
 const first=c.expectedFirst??[64,64,64,255],last=c.expectedLast??[192,192,192,255];
 return actual.decoded&&actual.width===sample.width&&actual.height===sample.height&&actual.first.join(',')===first.join(',')&&actual.last.join(',')===last.join(',');
}
const url=process.argv.find(value=>/^(?:file:|https?:)/.test(value))||pathToFileURL(path.resolve('dist/PixelQuota.html')).href;
const chrome=[process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(p=>p&&fs.existsSync(p));
if(!chrome)throw new Error('Chrome/Chromium not found; set CHROME_PATH');
const profileRoot=process.env.PIXELQUOTA_TIFF_QA_DIR||os.tmpdir();fs.mkdirSync(profileRoot,{recursive:true});const profile=fs.mkdtempSync(path.join(profileRoot,'chrome-profile-')),checks=[],errors=[];
const browser=await puppeteer.launch({headless:true,executablePath:chrome,userDataDir:profile,args:process.env.CI?['--no-sandbox']:[]});
const modes=['native-worker','no-offscreen-or-image-data','no-convert-to-blob'];
try{
 for(const mode of modes){
  const page=await browser.newPage();page.on('pageerror',e=>errors.push({mode,error:e.message}));
  if(mode==='no-offscreen-or-image-data')await page.evaluateOnNewDocument(()=>{
   const NativeBlob=globalThis.Blob;
   function BlobWithWorkerCapabilities(parts,options){const workerScript=/(?:java|ecma)script/i.test(options?.type||'');return new NativeBlob(workerScript?['self.OffscreenCanvas=undefined;self.ImageData=undefined;\n',...(parts||[])]:parts,options);}
   BlobWithWorkerCapabilities.prototype=NativeBlob.prototype;Object.setPrototypeOf(BlobWithWorkerCapabilities,NativeBlob);globalThis.Blob=BlobWithWorkerCapabilities;
  });
  if(mode==='no-convert-to-blob')await page.evaluateOnNewDocument(()=>{
   const NativeBlob=globalThis.Blob;
   function BlobWithWorkerCapabilities(parts,options){const workerScript=/(?:java|ecma)script/i.test(options?.type||'');const prefix='if(typeof OffscreenCanvas!=="function"||typeof ImageData!=="function")throw new Error("missing worker constructors");Object.defineProperty(OffscreenCanvas.prototype,"convertToBlob",{value:undefined,configurable:true});';return new NativeBlob(workerScript?[prefix,...(parts||[])]:parts,options);}
   BlobWithWorkerCapabilities.prototype=NativeBlob.prototype;Object.setPrototypeOf(BlobWithWorkerCapabilities,NativeBlob);globalThis.Blob=BlobWithWorkerCapabilities;
  });
  try{
   await page.goto(url,{waitUntil:'load'});await page.waitForFunction(()=>window.PixelQuotaTest);
   for(const c of cases){const sample=c.id.startsWith('valid-strips')||c.id.startsWith('valid-tiles')||baseCases.some(item=>item.id===c.id||`${item.id}-then-valid`===c.id)?tiff(c):makeSample(c);const actual=await page.evaluate(async({id,b64})=>{
    const started=performance.now();
    try{
     const input=new File([Uint8Array.from(atob(b64),v=>v.charCodeAt(0))],id+'.tif',{type:'image/tiff'});
     const result=await window.PixelQuotaTest.compressImage(input,{compressionMode:'convert',outputFormat:'image/png',stripMetadata:true});
     const image=await createImageBitmap(result.blob),canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;const out={decoded:true,width:image.width,height:image.height,first:[...pixels.slice(0,4)],last:[...pixels.slice(-4)]};image.close();return{...out,elapsedMs:performance.now()-started};
    }catch(e){return{decoded:false,error:e.message,elapsedMs:performance.now()-started};}
   },{id:c.id,b64:sample.bytes.toString('base64')});
   const pass=passes(c,actual,sample);
   checks.push({mode,name:c.id,pass:!!pass,...(pass?{}:{actual})});}
  }finally{await page.close();}
 }
}catch(e){errors.push({message:e.message,stack:e.stack});}finally{await browser.close();}
const failed=checks.filter(c=>!c.pass),expectedChecks=cases.length*modes.length,ok=!failed.length&&!errors.length&&checks.length===expectedChecks;
console.log(JSON.stringify({ok,url,modes,baseCases:baseCases.length,addedCases:regressionCases.length,selectedCases:cases.length,checks:checks.length,expectedChecks,failed,errors,profile:ok?undefined:profile},null,2));
if(ok)fs.rmSync(profile,{recursive:true});process.exitCode=ok?0:1;
