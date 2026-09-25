import fitCurve from 'fit-curve';

const commandSize={M:2,L:2,Q:4,C:6,Z:0};
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const round=(value,places=2)=>Number(Number(value).toFixed(places));

function pathTokens(d=''){
  return d.match(/[MLQCZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)||[];
}

function parseCommands(d=''){
  const tokens=pathTokens(d),commands=[];let i=0;
  while(i<tokens.length){
    const type=tokens[i++].toUpperCase(),size=commandSize[type];
    if(size===undefined)return null;
    if(type==='Z'){commands.push({type,values:[]});continue;}
    if(i+size>tokens.length)return null;
    const values=tokens.slice(i,i+size).map(Number);i+=size;
    if(values.some(value=>!Number.isFinite(value)))return null;
    commands.push({type,values});
  }
  return commands;
}

const point=(x,y)=>({x:Number(x),y:Number(y)});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const lerp=(a,b,t)=>point(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t);

function quadraticAt(a,c,b,t){
  const u=1-t;
  return point(u*u*a.x+2*u*t*c.x+t*t*b.x,u*u*a.y+2*u*t*c.y+t*t*b.y);
}

function cubicAt(a,c1,c2,b,t){
  const u=1-t;
  return point(
    u*u*u*a.x+3*u*u*t*c1.x+3*u*t*t*c2.x+t*t*t*b.x,
    u*u*u*a.y+3*u*u*t*c1.y+3*u*t*t*c2.y+t*t*t*b.y
  );
}

function approxCurveLength(points){
  let total=0;
  for(let i=1;i<points.length;i++)total+=distance(points[i-1],points[i]);
  return total;
}

function sampleCommands(commands,spacing=1){
  const subpaths=[];let current=null,start=null,active=null,closed=false;
  const finish=()=>{
    if(active&&active.length>2){
      const first=active[0],last=active.at(-1);
      if(closed&&distance(first,last)>.01)active.push({...first});
      subpaths.push({points:active,closed});
    }
    active=null;current=null;start=null;closed=false;
  };
  for(const command of commands||[]){
    if(command.type==='M'){
      finish();
      current=point(command.values[0],command.values[1]);start={...current};active=[{...current}];continue;
    }
    if(!active||!current)continue;
    if(command.type==='Z'){closed=true;current={...start};continue;}
    let end,controls=[],rough=[];
    if(command.type==='L'){
      end=point(command.values[0],command.values[1]);rough=[current,end];
    }else if(command.type==='Q'){
      controls=[point(command.values[0],command.values[1])];end=point(command.values[2],command.values[3]);
      rough=[current,controls[0],end];
    }else if(command.type==='C'){
      controls=[point(command.values[0],command.values[1]),point(command.values[2],command.values[3])];end=point(command.values[4],command.values[5]);
      rough=[current,...controls,end];
    }else continue;
    const length=Math.max(distance(current,end),approxCurveLength(rough));
    const steps=Math.max(1,Math.ceil(length/Math.max(.55,spacing)));
    for(let step=1;step<=steps;step++){
      const t=step/steps;
      active.push(command.type==='L'?lerp(current,end,t):command.type==='Q'?quadraticAt(current,controls[0],end,t):cubicAt(current,controls[0],controls[1],end,t));
    }
    current=end;
  }
  finish();
  return subpaths;
}

function dedupePoints(points,minDistance=.18){
  const out=[];
  for(const p of points){
    if(!out.length||distance(out.at(-1),p)>=minDistance)out.push({...p});
  }
  if(out.length>2&&distance(out[0],out.at(-1))<minDistance)out[out.length-1]={...out[0]};
  return out;
}

function resamplePolyline(points,spacing=1){
  if(points.length<3)return points.map(p=>({...p}));
  const closed=distance(points[0],points.at(-1))<.01;
  const source=closed?points.slice(0,-1):points.slice();
  if(source.length<3)return points.map(p=>({...p}));
  const segments=[],cumulative=[0];let total=0;
  const segmentCount=closed?source.length:source.length-1;
  for(let i=0;i<segmentCount;i++){
    const a=source[i],b=source[(i+1)%source.length],len=distance(a,b);
    segments.push({a,b,len});total+=len;cumulative.push(total);
  }
  const count=Math.max(closed?8:3,Math.ceil(total/Math.max(.65,spacing)));
  const out=[];
  for(let n=0;n<=(closed?count-1:count);n++){
    const target=closed?(n/count)*total:(n/count)*total;
    let idx=0;
    while(idx<segments.length-1&&cumulative[idx+1]<target)idx++;
    const seg=segments[idx],local=seg.len?clamp((target-cumulative[idx])/seg.len,0,1):0;
    out.push(lerp(seg.a,seg.b,local));
  }
  if(closed)out.push({...out[0]});
  return out;
}

function smoothClosed(points,passes=1){
  if(points.length<6||passes<=0)return points.map(p=>({...p}));
  const closed=distance(points[0],points.at(-1))<.01;
  let body=closed?points.slice(0,-1):points.slice();
  for(let pass=0;pass<passes;pass++){
    const next=body.map((p,i)=>{
      if(!closed&&(i===0||i===body.length-1))return{...p};
      const prev=body[(i-1+body.length)%body.length],after=body[(i+1)%body.length];
      return point(prev.x*.16+p.x*.68+after.x*.16,prev.y*.16+p.y*.68+after.y*.16);
    });
    body=next;
  }
  if(closed)body.push({...body[0]});
  return body;
}

function angleAt(points,index,window,closed){
  const n=closed?points.length-1:points.length;
  const left=closed?(index-window+n)%n:Math.max(0,index-window);
  const right=closed?(index+window)%n:Math.min(n-1,index+window);
  if(left===index||right===index)return 0;
  const a=points[left],b=points[index],c=points[right];
  const v1=point(b.x-a.x,b.y-a.y),v2=point(c.x-b.x,c.y-b.y);
  const l1=Math.hypot(v1.x,v1.y),l2=Math.hypot(v2.x,v2.y);
  if(l1<.01||l2<.01)return 0;
  return Math.acos(clamp((v1.x*v2.x+v1.y*v2.y)/(l1*l2),-1,1))*180/Math.PI;
}

function detectCorners(points,{cornerAngle=38,cornerWindow=6,minCornerGap=7}={}){
  const closed=distance(points[0],points.at(-1))<.01,n=closed?points.length-1:points.length;
  if(n<12)return[];
  const w=Math.max(2,Math.min(Math.floor(n/8),Math.round(cornerWindow)));
  const scores=Array.from({length:n},(_,i)=>angleAt(points,i,w,closed));
  const candidates=[];
  for(let i=0;i<n;i++){
    if(scores[i]<cornerAngle)continue;
    let localMax=true;
    for(let d=1;d<=Math.max(2,Math.floor(w/2));d++){
      const li=closed?(i-d+n)%n:i-d,ri=closed?(i+d)%n:i+d;
      if(li>=0&&scores[li]>scores[i])localMax=false;
      if(ri<n&&scores[ri]>scores[i])localMax=false;
    }
    if(localMax)candidates.push({index:i,score:scores[i]});
  }
  candidates.sort((a,b)=>b.score-a.score);
  const kept=[];
  for(const candidate of candidates){
    const farEnough=kept.every(existing=>{
      const raw=Math.abs(existing.index-candidate.index);
      const gap=closed?Math.min(raw,n-raw):raw;
      return gap>=minCornerGap;
    });
    if(farEnough)kept.push(candidate);
  }
  return kept.map(item=>item.index).sort((a,b)=>a-b);
}

function maxDistanceToChord(points){
  if(points.length<=2)return 0;
  const a=points[0],b=points.at(-1),dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);
  if(len<.001)return Infinity;
  let max=0;
  for(let i=1;i<points.length-1;i++){
    const p=points[i],d=Math.abs(dy*p.x-dx*p.y+b.x*a.y-b.y*a.x)/len;
    if(d>max)max=d;
  }
  return max;
}

function segmentClosedLoop(points,corners){
  const body=distance(points[0],points.at(-1))<.01?points.slice(0,-1):points.slice();
  const n=body.length;
  if(n<4)return[body];
  let cuts=[...corners];
  if(cuts.length<2){
    const quarter=Math.floor(n/4);
    cuts=[0,quarter,quarter*2,quarter*3].filter((value,index,array)=>value<n&&array.indexOf(value)===index);
  }
  cuts.sort((a,b)=>a-b);
  const segments=[];
  for(let i=0;i<cuts.length;i++){
    const start=cuts[i],end=cuts[(i+1)%cuts.length];
    const segment=[body[start]];
    let cursor=(start+1)%n,guard=0;
    while(cursor!==end&&guard++<=n){segment.push(body[cursor]);cursor=(cursor+1)%n;}
    segment.push(body[end]);
    if(segment.length>=2)segments.push(segment);
  }
  return segments;
}

function fitSegment(points,error,straightTolerance){
  if(points.length<3)return{type:'L',end:points.at(-1)};
  if(maxDistanceToChord(points)<=straightTolerance)return{type:'L',end:points.at(-1)};
  const curves=fitCurve(points.map(p=>[p.x,p.y]),error);
  if(!curves?.length)return{type:'L',end:points.at(-1)};
  return{type:'C',curves};
}

function serializeNumber(value){const v=round(value,2);return Number.isInteger(v)?String(v):String(v);}

function refitSubpath(subpath,options){
  let points=dedupePoints(subpath.points);
  if(points.length<4)return null;
  points=resamplePolyline(points,options.sampleSpacing);
  points=smoothClosed(points,options.smoothPasses);
  const closed=subpath.closed||distance(points[0],points.at(-1))<.01;
  if(!closed){
    const curves=fitCurve(points.map(p=>[p.x,p.y]),options.fitError);
    if(!curves?.length)return null;
    let d=`M ${serializeNumber(points[0].x)} ${serializeNumber(points[0].y)}`;
    for(const curve of curves){
      d+=` C ${serializeNumber(curve[1][0])} ${serializeNumber(curve[1][1])} ${serializeNumber(curve[2][0])} ${serializeNumber(curve[2][1])} ${serializeNumber(curve[3][0])} ${serializeNumber(curve[3][1])}`;
    }
    return d;
  }
  const corners=detectCorners(points,options),segments=segmentClosedLoop(points,corners);
  if(!segments.length)return null;
  const first=segments[0][0];
  let d=`M ${serializeNumber(first.x)} ${serializeNumber(first.y)}`;
  for(const segment of segments){
    const fit=fitSegment(segment,options.fitError,options.straightTolerance);
    if(fit.type==='L'){
      d+=` L ${serializeNumber(fit.end.x)} ${serializeNumber(fit.end.y)}`;
    }else{
      for(const curve of fit.curves){
        d+=` C ${serializeNumber(curve[1][0])} ${serializeNumber(curve[1][1])} ${serializeNumber(curve[2][0])} ${serializeNumber(curve[2][1])} ${serializeNumber(curve[3][0])} ${serializeNumber(curve[3][1])}`;
      }
    }
  }
  return d+' Z';
}

export function fitClosedPolyline(points,profile){
  if(!Array.isArray(points)||points.length<4)return null;
  const closed=distance(points[0],points.at(-1))<.01?points.map(p=>({...p})):[...points.map(p=>({...p})),{...points[0]}];
  return refitSubpath({points:closed,closed:true},profile);
}

export const CURVE_PROFILES=[
  {id:'fidelity',label:'曲線保真',fitError:.52,cornerAngle:34,cornerWindow:6,minCornerGap:7,sampleSpacing:.8,smoothPasses:1,straightTolerance:.34},
  {id:'balanced',label:'自然平滑',fitError:.82,cornerAngle:40,cornerWindow:7,minCornerGap:8,sampleSpacing:.9,smoothPasses:2,straightTolerance:.42},
  {id:'smooth',label:'高品質平滑',fitError:1.15,cornerAngle:47,cornerWindow:8,minCornerGap:9,sampleSpacing:1,smoothPasses:2,straightTolerance:.52}
];

export function refitSvgCurves(svg,profile=CURVE_PROFILES[1]){
  const doc=new DOMParser().parseFromString(svg,'image/svg+xml'),root=doc.documentElement;
  if(root.nodeName.toLowerCase()!=='svg')throw new Error('curve_refit_invalid_svg');
  let refitPaths=0,failedPaths=0;
  for(const path of [...root.querySelectorAll('path')]){
    const commands=parseCommands(path.getAttribute('d')||'');
    if(!commands){failedPaths++;continue;}
    const subpaths=sampleCommands(commands,profile.sampleSpacing);
    const rebuilt=subpaths.map(subpath=>refitSubpath(subpath,profile)).filter(Boolean);
    if(!rebuilt.length){failedPaths++;continue;}
    path.setAttribute('d',rebuilt.join(' '));refitPaths++;
  }
  const output=new XMLSerializer().serializeToString(root);
  const commands=(output.match(/[MLQCZ](?=\s|\d|-)/gi)||[]);
  const lineCount=commands.filter(command=>command.toUpperCase()==='L').length;
  const curveCount=commands.filter(command=>['Q','C'].includes(command.toUpperCase())).length;
  return{svg:output,profile,refitPaths,failedPaths,lineCount,curveCount,commandCount:commands.length};
}

export function scoreCurveCandidate({similarity=0,edgeSimilarity=similarity,nodeCount=0,lineCount=0,curveCount=0,pathCount=0,expectedPathCount=0}){
  if(expectedPathCount&&pathCount!==expectedPathCount)return-Infinity;
  const fidelity=similarity*.35+edgeSimilarity*.65;
  const complexity=Math.min(.45,nodeCount*.00022);
  const jaggedPenalty=Math.min(2.5,lineCount*.01);
  const curveBonus=Math.min(.12,curveCount*.00035);
  return fidelity-complexity-jaggedPenalty+curveBonus;
}
