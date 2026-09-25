import ImageTracer from 'imagetracerjs';
import { decodeFile } from './compress.js';
import { CURVE_PROFILES, refitSvgCurves, scoreCurveCandidate } from './vector-curve.js';
import { monoLogoCandidates } from './mono-logo.js';

export const VECTOR_PRESETS={
  auto:{label:'Smart Auto',colors:12,maxEdge:1900,baseOmit:2,baseLine:0.55,baseCurve:0.55},
  logo:{label:'Logo / Icon',colors:10,maxEdge:1800,baseOmit:5,baseLine:0.65,baseCurve:0.65},
  illustration:{label:'Illustration',colors:24,maxEdge:1500,baseOmit:4,baseLine:1.1,baseCurve:1.1},
  line:{label:'Line Art',colors:2,maxEdge:1900,baseOmit:5,baseLine:0.55,baseCurve:0.55}
};

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const round=(value,places=2)=>Number(Number(value).toFixed(places));
const commandSize={M:2,L:2,Q:4,C:6,Z:0};

function imageSize(image){
  return{width:image.width||image.naturalWidth||0,height:image.height||image.naturalHeight||0};
}

function pathTokens(d=''){
  return d.match(/[MLQCZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)||[];
}

function parsePath(d=''){
  const tokens=pathTokens(d),commands=[];
  let i=0;
  while(i<tokens.length){
    const type=tokens[i++].toUpperCase();
    const size=commandSize[type];
    if(size===undefined)return null;
    if(type==='Z'){commands.push({type:'Z',values:[]});continue;}
    if(i+size>tokens.length)return null;
    const values=tokens.slice(i,i+size).map(Number);
    if(values.some(value=>!Number.isFinite(value)))return null;
    commands.push({type,values});i+=size;
  }
  return commands;
}

function commandEnd(command,current){
  if(command.type==='M'||command.type==='L')return{x:command.values[0],y:command.values[1]};
  if(command.type==='Q')return{x:command.values[2],y:command.values[3]};
  if(command.type==='C')return{x:command.values[4],y:command.values[5]};
  return current;
}

function distancePointToLine(point,a,b){
  const dx=b.x-a.x,dy=b.y-a.y;
  const length=Math.hypot(dx,dy);
  if(length<1e-6)return Math.hypot(point.x-a.x,point.y-a.y);
  return Math.abs(dy*point.x-dx*point.y+b.x*a.y-b.y*a.x)/length;
}

function snapEndpoint(point,previous,tolerance){
  const next={...point};
  if(Math.abs(next.x-previous.x)<=tolerance)next.x=previous.x;
  if(Math.abs(next.y-previous.y)<=tolerance)next.y=previous.y;
  return next;
}

function simplifyCommands(commands,{simplify=62,snap=72,preserveCorners=true,straightLines=true}={}){
  if(!commands)return null;
  const snapTolerance=0.15+(clamp(snap,0,100)/100)*2.1;
  const lineTolerance=0.08+(clamp(simplify,0,100)/100)*1.9;
  const flattenTolerance=0.15+(clamp(simplify,0,100)/100)*2.5;
  const optimized=[];
  let current={x:0,y:0},subpathStart={x:0,y:0};

  for(const original of commands){
    const command={type:original.type,values:[...original.values]};
    if(command.type==='M'){
      current={x:command.values[0],y:command.values[1]};
      subpathStart={...current};
      optimized.push(command);continue;
    }
    if(command.type==='Z'){
      optimized.push(command);current={...subpathStart};continue;
    }

    if(command.type==='L'){
      let end={x:command.values[0],y:command.values[1]};
      if(preserveCorners||straightLines)end=snapEndpoint(end,current,snapTolerance);
      command.values=[round(end.x),round(end.y)];
    }else if(command.type==='Q'&&straightLines){
      const control={x:command.values[0],y:command.values[1]};
      let end={x:command.values[2],y:command.values[3]};
      if(preserveCorners)end=snapEndpoint(end,current,snapTolerance);
      const axisAligned=Math.abs(end.x-current.x)<=snapTolerance||Math.abs(end.y-current.y)<=snapTolerance;
      if((axisAligned&&distancePointToLine(control,current,end)<=flattenTolerance*1.7)||distancePointToLine(control,current,end)<=flattenTolerance){
        command.type='L';command.values=[round(end.x),round(end.y)];
      }else{
        command.values=[round(control.x),round(control.y),round(end.x),round(end.y)];
      }
    }else{
      command.values=command.values.map(value=>round(value));
    }

    const end=commandEnd(command,current);
    if(command.type==='L'&&Math.hypot(end.x-current.x,end.y-current.y)<0.02)continue;

    if(command.type==='L'&&optimized.length>=2){
      const previous=optimized[optimized.length-1],before=optimized[optimized.length-2];
      if(previous.type==='L'&&(before.type==='L'||before.type==='M')){
        const a=before.type==='M'||before.type==='L'?{x:before.values[0],y:before.values[1]}:null;
        const b={x:previous.values[0],y:previous.values[1]},c=end;
        if(a){
          const forward=(b.x-a.x)*(c.x-b.x)+(b.y-a.y)*(c.y-b.y);
          if(forward>=-0.001&&distancePointToLine(b,a,c)<=lineTolerance){
            optimized[optimized.length-1]=command;current=end;continue;
          }
        }
      }
    }

    optimized.push(command);current=end;
  }
  return optimized;
}

function serializePath(commands){
  return commands.map(command=>{
    if(command.type==='Z')return'Z';
    return`${command.type} ${command.values.map(value=>Number.isInteger(value)?String(value):String(round(value,2))).join(' ')}`;
  }).join(' ');
}

function simpleRect(commands,tolerance=0.25){
  if(!commands||commands.length<5)return null;
  const drawable=commands.filter(command=>command.type!=='Z');
  if(!drawable.length||drawable[0].type!=='M'||drawable.some(command=>command.type!=='M'&&command.type!=='L'))return null;
  let points=drawable.map(command=>({x:command.values[0],y:command.values[1]}));
  if(points.length>1&&Math.hypot(points[0].x-points.at(-1).x,points[0].y-points.at(-1).y)<=tolerance)points=points.slice(0,-1);
  if(points.length!==4)return null;
  for(let i=0;i<4;i++){
    const a=points[i],b=points[(i+1)%4];
    if(Math.abs(a.x-b.x)>tolerance&&Math.abs(a.y-b.y)>tolerance)return null;
  }
  const xs=points.map(point=>point.x),ys=points.map(point=>point.y);
  const x=Math.min(...xs),y=Math.min(...ys),width=Math.max(...xs)-x,height=Math.max(...ys)-y;
  if(width<1||height<1)return null;
  return{x:round(x),y:round(y),width:round(width),height:round(height)};
}

function statsFromDocument(doc){
  const paths=[...doc.querySelectorAll('path')];
  const rects=[...doc.querySelectorAll('rect')];
  const polygons=[...doc.querySelectorAll('polygon,polyline')];
  let nodes=0,curveCount=0,lineCount=0;
  for(const path of paths){const d=path.getAttribute('d')||'';nodes+=(d.match(/[MLQCZ]/gi)||[]).length;curveCount+=(d.match(/[QC]/gi)||[]).length;lineCount+=(d.match(/L/gi)||[]).length;}
  nodes+=rects.length*4;
  for(const shape of polygons)nodes+=(shape.getAttribute('points')?.trim().split(/\s+/).filter(Boolean).length||0);
  return{pathCount:paths.length,nodeCount:nodes,curveCount,lineCount,shapeCount:paths.length+rects.length+polygons.length};
}

function optimizeSvg(svg,{simplify=62,snap=72,preserveCorners=true,straightLines=true,preserveTopology=false,traceWidth,traceHeight,sourceWidth,sourceHeight}={}){
  const parser=new DOMParser();
  const doc=parser.parseFromString(svg,'image/svg+xml');
  const root=doc.documentElement;
  if(root.nodeName.toLowerCase()!=='svg')throw new Error('vectorize_failed:invalid_svg');

  root.removeAttribute('desc');
  root.removeAttribute('version');
  root.setAttribute('viewBox',`0 0 ${traceWidth} ${traceHeight}`);
  root.setAttribute('width',String(sourceWidth));
  root.setAttribute('height',String(sourceHeight));
  root.setAttribute('preserveAspectRatio','xMidYMid meet');
  if(preserveTopology){
    for(const path of [...root.querySelectorAll('path')]){
      const opacity=Number(path.getAttribute('opacity')??1);
      if(opacity<=0.001)path.remove();
    }
    return new XMLSerializer().serializeToString(root);
  }

  for(const path of [...root.querySelectorAll('path')]){
    const opacity=Number(path.getAttribute('opacity')??1);
    if(opacity<=0.001){path.remove();continue;}
    const parsed=parsePath(path.getAttribute('d')||'');
    if(!parsed)continue;
    const simplified=simplifyCommands(parsed,{simplify,snap,preserveCorners,straightLines});
    const rect=preserveCorners?simpleRect(simplified,0.35+(snap/100)*0.85):null;
    if(rect){
      const element=doc.createElementNS('http://www.w3.org/2000/svg','rect');
      for(const attr of [...path.attributes]){
        if(attr.name!=='d')element.setAttribute(attr.name,attr.value);
      }
      element.setAttribute('x',String(rect.x));element.setAttribute('y',String(rect.y));
      element.setAttribute('width',String(rect.width));element.setAttribute('height',String(rect.height));
      path.replaceWith(element);
    }else{
      path.setAttribute('d',serializePath(simplified));
    }
  }

  const serializer=new XMLSerializer();
  return serializer.serializeToString(root);
}

function binaryMask(data,width,height){
  const mask=new Uint8Array(width*height);
  for(let p=0;p<mask.length;p++){
    const i=p*4,alpha=data[i+3]/255,luma=.2126*data[i]+.7152*data[i+1]+.0722*data[i+2];
    mask[p]=alpha>.05&&luma<128?1:0;
  }
  return mask;
}
function edgeMap(mask,width,height){
  const edge=new Uint8Array(mask.length);
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x,v=mask[i];
    if(mask[i-1]!==v||mask[i+1]!==v||mask[i-width]!==v||mask[i+width]!==v)edge[i]=1;
  }
  return edge;
}
function edgeMatchScore(source,candidate,width,height){
  const sourceEdge=edgeMap(source,width,height),candidateEdge=edgeMap(candidate,width,height);
  const near=(map,x,y)=>{
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const nx=x+dx,ny=y+dy;
      if(nx>=0&&ny>=0&&nx<width&&ny<height&&map[ny*width+nx])return true;
    }
    return false;
  };
  let sourceCount=0,candidateCount=0,sourceHit=0,candidateHit=0;
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x;
    if(sourceEdge[i]){sourceCount++;if(near(candidateEdge,x,y))sourceHit++;}
    if(candidateEdge[i]){candidateCount++;if(near(sourceEdge,x,y))candidateHit++;}
  }
  const recall=sourceCount?sourceHit/sourceCount:1,precision=candidateCount?candidateHit/candidateCount:1;
  return round((precision+recall?2*precision*recall/(precision+recall):0)*100,2);
}
async function svgQualityMetrics(svg,sourceImageData,width,height){
  const blob=new Blob([svg],{type:'image/svg+xml'});
  const url=URL.createObjectURL(blob);
  try{
    const image=new Image();
    image.src=url;
    await image.decode();
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.clearRect(0,0,width,height);ctx.drawImage(image,0,0,width,height);
    const renderedImageData=ctx.getImageData(0,0,width,height),rendered=renderedImageData.data,source=sourceImageData.data;
    const maxSamples=24000,totalPixels=width*height,stride=Math.max(1,Math.floor(totalPixels/maxSamples));
    let error=0,samples=0;
    for(let pixel=0;pixel<totalPixels;pixel+=stride){
      const i=pixel*4;
      error+=Math.abs(source[i]-rendered[i])+Math.abs(source[i+1]-rendered[i+1])+Math.abs(source[i+2]-rendered[i+2])+Math.abs(source[i+3]-rendered[i+3]);
      samples+=4;
    }
    const similarity=round(clamp(100-(error/(samples*255))*100,0,100),1);
    const edgeSimilarity=edgeMatchScore(binaryMask(source,width,height),binaryMask(rendered,width,height),width,height);
    return{similarity,edgeSimilarity};
  }finally{URL.revokeObjectURL(url);}
}
async function svgSimilarity(svg,sourceImageData,width,height){return(await svgQualityMetrics(svg,sourceImageData,width,height)).similarity;}

function luminance(r,g,b){return Math.round(.2126*r+.7152*g+.0722*b);}
function colorDistance(a,b){return Math.hypot(a.r-b.r,a.g-b.g,a.b-b.b,(a.a-b.a)*.35);}
function canonicalColor(color){
  const grayscale=Math.max(color.r,color.g,color.b)-Math.min(color.r,color.g,color.b)<=6;
  if(grayscale&&color.r<=10&&color.g<=10&&color.b<=10)return{r:0,g:0,b:0,a:color.a};
  if(grayscale&&color.r>=245&&color.g>=245&&color.b>=245)return{r:255,g:255,b:255,a:color.a};
  return{r:color.r,g:color.g,b:color.b,a:color.a};
}
function percentileFromHistogram(hist,total,ratio){
  const target=Math.max(1,total*ratio);let count=0;
  for(let i=0;i<hist.length;i++){count+=hist[i];if(count>=target)return i;}
  return 255;
}
function sourcePaletteAnalysis(imageData){
  const data=imageData.data,total=imageData.width*imageData.height,maxSamples=120000,stride=Math.max(1,Math.floor(total/maxSamples));
  const counts=new Map(),hist=new Uint32Array(256);let sampled=0,opaque=0,transparent=0,gray=0;
  for(let pixel=0;pixel<total;pixel+=stride){
    const i=pixel*4,r=data[i],g=data[i+1],b=data[i+2],a=data[i+3];sampled++;
    if(a<16){transparent++;continue;}
    opaque++;if(Math.max(r,g,b)-Math.min(r,g,b)<=7)gray++;
    hist[luminance(r,g,b)]++;
    const key=`${r},${g},${b},${a}`;counts.set(key,(counts.get(key)||0)+1);
  }
  const colors=[...counts.entries()].map(([key,count])=>{const [r,g,b,a]=key.split(',').map(Number);return{r,g,b,a,count};}).sort((a,b)=>b.count-a.count);
  const p10=percentileFromHistogram(hist,opaque,.10),p90=percentileFromHistogram(hist,opaque,.90);
  const grayscaleRatio=opaque?gray/opaque:0,transparentRatio=sampled?transparent/sampled:0;
  const anchors=[];
  for(const color of colors){
    if(color.count/Math.max(1,opaque)<.0015&&anchors.length>=2)continue;
    const canonical=canonicalColor(color);
    const close=anchors.find(anchor=>colorDistance(anchor,canonical)<=20);
    if(close){close.count+=color.count;continue;}
    anchors.push({...canonical,count:color.count});
    if(anchors.length>=10)break;
  }
  anchors.sort((a,b)=>b.count-a.count);
  const highContrast=p10<=72&&p90>=185;
  const monoLogo=grayscaleRatio>=.985&&highContrast;
  let palette,kind,label;
  if(monoLogo){
    const dark=canonicalColor(colors.find(color=>luminance(color.r,color.g,color.b)<=Math.min(80,p10+24))||{r:0,g:0,b:0,a:255});
    const light=canonicalColor(colors.find(color=>luminance(color.r,color.g,color.b)>=Math.max(180,p90-20))||{r:255,g:255,b:255,a:255});
    palette=[dark,light];
    if(transparentRatio>.01)palette.push({r:255,g:255,b:255,a:0});
    kind='mono-logo';label='高對比黑白 Logo';
  }else{
    const strong=anchors.filter(anchor=>anchor.count/Math.max(1,opaque)>=.006);
    const covered=colors.reduce((sum,color)=>{
      const nearest=strong.reduce((best,anchor)=>Math.min(best,colorDistance(anchor,color)),Infinity);
      return sum+(nearest<=48?color.count:0);
    },0)/Math.max(1,opaque);
    if(strong.length>=2&&strong.length<=8&&covered>=.93){
      palette=strong.slice(0,8).map(({r,g,b,a})=>canonicalColor({r,g,b,a}));
      if(transparentRatio>.01)palette.push({r:255,g:255,b:255,a:0});
      kind='low-color-logo';label=`低色彩 Logo · ${strong.length} 色`;
    }else{
      palette=null;kind='illustration';label='多色插畫 / 圖像';
    }
  }
  return{kind,label,palette,grayscaleRatio:round(grayscaleRatio*100,1),transparentRatio:round(transparentRatio*100,1),p10,p90,sourceColors:colors.length};
}
function paletteCss(palette=[]){return palette.filter(color=>color.a>0).map(color=>`rgb(${color.r},${color.g},${color.b})`);}
function smartTracerOptions(options,analysis,{locked=false}={}){
  const basePreset=analysis.kind==='illustration'?'illustration':'logo';
  const autoOptions={...options,preset:basePreset,detail:analysis.kind==='illustration'?72:82,simplify:analysis.kind==='illustration'?28:42,snap:analysis.kind==='illustration'?30:38,preserveCorners:analysis.kind!=='illustration',straightLines:analysis.kind!=='illustration',preserveTopology:analysis.kind==='mono-logo'};
  const trace=tracerOptions(autoOptions);
  if(locked&&analysis.palette?.length){
    trace.pal=analysis.palette.map(({r,g,b,a})=>({r,g,b,a}));
    trace.numberofcolors=analysis.palette.length;
    trace.colorquantcycles=1;
    trace.colorsampling=2;
    trace.mincolorratio=0;
    trace.pathomit=analysis.kind==='mono-logo'?1:Math.min(2,trace.pathomit);
    trace.ltres=analysis.kind==='mono-logo'?.35:Math.min(.75,trace.ltres);
    trace.qtres=analysis.kind==='mono-logo'?.35:Math.min(.75,trace.qtres);
    trace.linefilter=false;
  }
  return{trace,cleanup:autoOptions};
}
async function traceVectorCandidate(imageData,traceOptions,cleanup,dimensions){
  const rawSvg=ImageTracer.imagedataToSVG(imageData,traceOptions);
  const rawDoc=new DOMParser().parseFromString(rawSvg,'image/svg+xml');
  const rawStats=statsFromDocument(rawDoc);
  const svg=optimizeSvg(rawSvg,{...cleanup,traceWidth:dimensions.width,traceHeight:dimensions.height,sourceWidth:dimensions.sourceWidth,sourceHeight:dimensions.sourceHeight});
  const cleanDoc=new DOMParser().parseFromString(svg,'image/svg+xml');
  const cleanStats=statsFromDocument(cleanDoc);
  const quality=await svgQualityMetrics(svg,imageData,dimensions.width,dimensions.height),similarity=quality.similarity,edgeSimilarity=quality.edgeSimilarity;
  const bytes=new TextEncoder().encode(svg).byteLength;
  return{svg,rawStats,cleanStats,similarity,edgeSimilarity,bytes};
}

async function nativeMonoCandidate(candidate,imageData,dimensions){
  const quality=await svgQualityMetrics(candidate.svg,imageData,dimensions.width,dimensions.height);
  const cleanDoc=new DOMParser().parseFromString(candidate.svg,'image/svg+xml');
  const cleanStats=statsFromDocument(cleanDoc);
  const bytes=new TextEncoder().encode(candidate.svg).byteLength;
  const score=scoreCurveCandidate({
    similarity:quality.similarity,
    edgeSimilarity:quality.edgeSimilarity,
    nodeCount:cleanStats.nodeCount,
    lineCount:cleanStats.lineCount,
    curveCount:cleanStats.curveCount,
    pathCount:cleanStats.pathCount,
    expectedPathCount:candidate.topologyCount
  });
  return{
    ...candidate,
    rawStats:cleanStats,
    cleanStats,
    similarity:quality.similarity,
    edgeSimilarity:quality.edgeSimilarity,
    bytes,
    score,
    curveProfile:`native-${candidate.profile}-t${candidate.threshold}`,
    curveProfileLabel:`PixelQuota MonoCurve · ${candidate.profileLabel}`,
    vectorEngine:'pixelquota-monocurve'
  };
}

async function refitCurveCandidate(base,profile,imageData,dimensions){
  const rebuilt=refitSvgCurves(base.svg,profile);
  const cleanDoc=new DOMParser().parseFromString(rebuilt.svg,'image/svg+xml');
  const cleanStats=statsFromDocument(cleanDoc);
  const quality=await svgQualityMetrics(rebuilt.svg,imageData,dimensions.width,dimensions.height),similarity=quality.similarity,edgeSimilarity=quality.edgeSimilarity;
  const bytes=new TextEncoder().encode(rebuilt.svg).byteLength;
  const score=scoreCurveCandidate({
    similarity,
    edgeSimilarity,
    nodeCount:cleanStats.nodeCount,
    lineCount:cleanStats.lineCount,
    curveCount:cleanStats.curveCount,
    pathCount:cleanStats.pathCount,
    expectedPathCount:base.cleanStats.pathCount
  });
  return{svg:rebuilt.svg,rawStats:base.rawStats,cleanStats,similarity,edgeSimilarity,bytes,score,curveProfile:profile.id,curveProfileLabel:profile.label,refit:rebuilt};
}

function tracerOptions(options={}){
  const requested=options.preset||'logo';
  const preset=VECTOR_PRESETS[requested]||VECTOR_PRESETS.logo;
  const detail=clamp(Number(options.detail??58),0,100),simplify=clamp(Number(options.simplify??62),0,100);
  const colors=requested==='line'?2:Math.max(3,Math.round(preset.colors*(0.55+detail/125)));
  return{
    ltres:preset.baseLine+(simplify/100)*1.55,
    qtres:preset.baseCurve+(simplify/100)*1.45,
    pathomit:Math.max(1,Math.round(preset.baseOmit+(simplify/100)*8-(detail/100)*4.5)),
    rightangleenhance:options.preserveCorners!==false,
    colorsampling:2,
    numberofcolors:colors,
    mincolorratio:requested==='illustration'?0.001:0.0018,
    colorquantcycles:requested==='illustration'?4:3,
    layering:0,
    strokewidth:0,
    linefilter:requested!=='line',
    scale:1,
    roundcoords:2,
    viewbox:false,
    desc:false,
    blurradius:0,
    blurdelta:20
  };
}

export function vectorOptionsKey(options={}){
  return JSON.stringify({
    preset:options.preset||'auto',
    detail:Number(options.detail??58),
    simplify:Number(options.simplify??62),
    snap:Number(options.snap??72),
    preserveCorners:options.preserveCorners!==false,
    straightLines:options.straightLines!==false
  });
}

export async function vectorizeImage(file,options={},onProgress=()=>{}){
  onProgress(4);
  const image=await decodeFile(file);
  const source=imageSize(image);
  if(!source.width||!source.height)throw new Error('vectorize_failed:decode_dimensions');
  const requestedPreset=options.preset||'auto';
  const preset=VECTOR_PRESETS[requestedPreset]||VECTOR_PRESETS.auto;
  const scale=Math.min(1,preset.maxEdge/Math.max(source.width,source.height));
  const width=Math.max(1,Math.round(source.width*scale)),height=Math.max(1,Math.round(source.height*scale));
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true,alpha:true});
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(image,0,0,width,height);
  if(typeof image.close==='function')image.close();
  const imageData=ctx.getImageData(0,0,width,height);
  onProgress(20);

  const analysis=sourcePaletteAnalysis(imageData);
  let chosen,strategy='manual',candidateCount=1,candidateDiagnostics=[];
  const dimensions={width,height,sourceWidth:source.width,sourceHeight:source.height};
  if(requestedPreset==='auto'){
    const smart=smartTracerOptions(options,analysis,{locked:!!analysis.palette});
    const locked=await traceVectorCandidate(imageData,smart.trace,smart.cleanup,dimensions);
    chosen=locked;strategy=analysis.palette?'palette-locked':'auto-illustration';
    onProgress(46);
    if(analysis.kind==='mono-logo'&&analysis.palette){
      const rawScore=scoreCurveCandidate({
        similarity:locked.similarity,
        edgeSimilarity:locked.edgeSimilarity,
        nodeCount:locked.cleanStats.nodeCount,
        lineCount:locked.cleanStats.lineCount,
        curveCount:locked.cleanStats.curveCount,
        pathCount:locked.cleanStats.pathCount,
        expectedPathCount:locked.cleanStats.pathCount
      });
      let best={...locked,score:rawScore,curveProfile:'raw',curveProfileLabel:'原始拓撲',vectorEngine:'imagetracer-topology'};
      candidateDiagnostics.push({engine:'imagetracer-topology',profile:'raw',similarity:locked.similarity,edgeSimilarity:locked.edgeSimilarity,score:rawScore,pathCount:locked.cleanStats.pathCount,nodeCount:locked.cleanStats.nodeCount,lineCount:locked.cleanStats.lineCount,curveCount:locked.cleanStats.curveCount});
      const qualityFloor=Math.max(98,locked.similarity-.85);
      for(let i=0;i<CURVE_PROFILES.length;i++){
        const candidate=await refitCurveCandidate(locked,CURVE_PROFILES[i],imageData,dimensions);
        candidate.vectorEngine='bezier-refit';
        candidateDiagnostics.push({engine:'bezier-refit',profile:candidate.curveProfile,similarity:candidate.similarity,edgeSimilarity:candidate.edgeSimilarity,score:candidate.score,pathCount:candidate.cleanStats.pathCount,nodeCount:candidate.cleanStats.nodeCount,lineCount:candidate.cleanStats.lineCount,curveCount:candidate.cleanStats.curveCount});
        candidateCount++;
        if(candidate.similarity>=qualityFloor&&candidate.score>best.score)best=candidate;
        onProgress(50+Math.round(((i+1)/CURVE_PROFILES.length)*14));
      }
      try{
        const nativeCandidates=monoLogoCandidates(imageData,{sourceWidth:dimensions.sourceWidth,sourceHeight:dimensions.sourceHeight,thresholds:[112,128,144]});
        for(const rawCandidate of nativeCandidates){
          const candidate=await nativeMonoCandidate(rawCandidate,imageData,dimensions);
          candidateCount++;
          candidateDiagnostics.push({engine:'pixelquota-monocurve',profile:candidate.curveProfile,threshold:candidate.threshold,similarity:candidate.similarity,edgeSimilarity:candidate.edgeSimilarity,score:candidate.score,pathCount:candidate.cleanStats.pathCount,nodeCount:candidate.cleanStats.nodeCount,lineCount:candidate.cleanStats.lineCount,curveCount:candidate.cleanStats.curveCount,blackCount:candidate.blackCount,whiteHoleCount:candidate.whiteHoleCount});
          if(candidate.similarity>=qualityFloor&&candidate.score>best.score)best=candidate;
        }
      }catch(error){
        candidateDiagnostics.push({engine:'pixelquota-monocurve',error:String(error?.message||error)});
      }
      onProgress(78);
      chosen=best;
      strategy=best.vectorEngine==='pixelquota-monocurve'?'mono-native':best.curveProfile==='raw'?'palette-locked':'mono-curve';
    }else if(analysis.palette){
      const fallbackConfig=smartTracerOptions(options,analysis,{locked:false});
      const fallback=await traceVectorCandidate(imageData,fallbackConfig.trace,fallbackConfig.cleanup,dimensions);
      candidateCount=2;onProgress(76);
      const lockedQualityOk=locked.similarity>=96.5&&locked.similarity>=fallback.similarity-1.2;
      if(!lockedQualityOk){
        chosen=fallback;strategy='auto-fidelity-fallback';
      }
    }
  }else{
    chosen=await traceVectorCandidate(imageData,tracerOptions(options),options,dimensions);
  }
  const {svg,rawStats,cleanStats,similarity}=chosen;
  onProgress(92);

  const blob=new Blob([svg],{type:'image/svg+xml;charset=utf-8'});
  const base=file.name.replace(/\.[^.]+$/,'')||'image';
  onProgress(100);
  return{
    operation:'vectorize',
    metTarget:true,
    outputType:'image/svg+xml',
    blob,
    outputName:`${base}_vector.svg`,
    outputWidth:source.width,
    outputHeight:source.height,
    originalWidth:source.width,
    originalHeight:source.height,
    traceWidth:width,
    traceHeight:height,
    svgText:svg,
    preset:requestedPreset,
    autoStrategy:strategy,
    autoLabel:requestedPreset==='auto'?(['mono-curve','mono-native'].includes(strategy)?`${analysis.label} · 高品質曲線重建`:analysis.label):'手動設定',
    autoPalette:requestedPreset==='auto'&&analysis.palette?paletteCss(analysis.palette):[],
    sourceColorCount:analysis.sourceColors,
    grayscaleRatio:analysis.grayscaleRatio,
    candidateCount,
    candidateDiagnostics,
    curveEngine:chosen.curveProfile||null,
    vectorEngine:chosen.vectorEngine||'imagetracer',
    curveMetrics:chosen.curveMetrics||null,
    curveEngineLabel:chosen.curveProfileLabel||null,
    pathCount:cleanStats.pathCount,
    rawPathCount:rawStats.pathCount,
    nodeCount:cleanStats.nodeCount,
    rawNodeCount:rawStats.nodeCount,
    shapeCount:cleanStats.shapeCount,
    curveCount:cleanStats.curveCount,
    lineCount:cleanStats.lineCount,
    rawLineCount:rawStats.lineCount,
    topologyLocked:requestedPreset==='auto'&&analysis.kind==='mono-logo'&&['palette-locked','mono-curve','mono-native'].includes(strategy),
    similarity,
    edgeSimilarity:chosen.edgeSimilarity??similarity
  };
}
