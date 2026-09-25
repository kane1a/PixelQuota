import { CURVE_PROFILES, fitClosedPolyline } from './vector-curve.js';

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const pointKey=(x,y)=>`${x},${y}`;

function luminance(r,g,b){return .2126*r+.7152*g+.0722*b;}

function binaryMask(imageData,threshold=128){
  const {width,height,data}=imageData,mask=new Uint8Array(width*height);
  for(let p=0;p<mask.length;p++){
    const i=p*4;
    mask[p]=data[i+3]>12&&luminance(data[i],data[i+1],data[i+2])<threshold?1:0;
  }
  return mask;
}

function components(mask,width,height,target){
  const seen=new Uint8Array(mask.length),queue=new Int32Array(mask.length),out=[];
  for(let start=0;start<mask.length;start++){
    if(seen[start]||mask[start]!==target)continue;
    let head=0,tail=0,touchesBorder=false;
    const pixels=[];
    seen[start]=1;queue[tail++]=start;
    while(head<tail){
      const idx=queue[head++],x=idx%width,y=(idx/width)|0;
      pixels.push(idx);
      if(x===0||y===0||x===width-1||y===height-1)touchesBorder=true;
      const neighbors=[idx-1,idx+1,idx-width,idx+width];
      if(x>0){const n=neighbors[0];if(!seen[n]&&mask[n]===target){seen[n]=1;queue[tail++]=n;}}
      if(x<width-1){const n=neighbors[1];if(!seen[n]&&mask[n]===target){seen[n]=1;queue[tail++]=n;}}
      if(y>0){const n=neighbors[2];if(!seen[n]&&mask[n]===target){seen[n]=1;queue[tail++]=n;}}
      if(y<height-1){const n=neighbors[3];if(!seen[n]&&mask[n]===target){seen[n]=1;queue[tail++]=n;}}
    }
    out.push({pixels,touchesBorder});
  }
  return out;
}

function boundaryLoops(component,mask,width,height,target){
  const outgoing=new Map();
  const add=(x1,y1,x2,y2)=>{
    const key=pointKey(x1,y1);
    if(!outgoing.has(key))outgoing.set(key,[]);
    outgoing.get(key).push({x1,y1,x2,y2,used:false});
  };
  for(const idx of component.pixels){
    const x=idx%width,y=(idx/width)|0;
    if(y===0||mask[idx-width]!==target)add(x,y,x+1,y);
    if(x===width-1||mask[idx+1]!==target)add(x+1,y,x+1,y+1);
    if(y===height-1||mask[idx+width]!==target)add(x+1,y+1,x,y+1);
    if(x===0||mask[idx-1]!==target)add(x,y+1,x,y);
  }
  const loops=[];
  for(const edges of outgoing.values())for(const startEdge of edges){
    if(startEdge.used)continue;
    const loop=[{x:startEdge.x1,y:startEdge.y1}];
    let edge=startEdge,guard=0;
    while(edge&&!edge.used&&guard++<component.pixels.length*8+100){
      edge.used=true;
      loop.push({x:edge.x2,y:edge.y2});
      const nextList=outgoing.get(pointKey(edge.x2,edge.y2))||[];
      edge=nextList.find(candidate=>!candidate.used)||null;
      if(edge&&edge.x1===loop[0].x&&edge.y1===loop[0].y){
        edge.used=true;loop.push({x:edge.x2,y:edge.y2});break;
      }
    }
    if(loop.length>=4)loops.push(loop);
  }
  return loops;
}

function signedArea(points){
  let area=0;
  for(let i=0;i<points.length-1;i++)area+=points[i].x*points[i+1].y-points[i+1].x*points[i].y;
  return area/2;
}

function largestLoop(loops){
  return loops.reduce((best,loop)=>!best||Math.abs(signedArea(loop))>Math.abs(signedArea(best))?loop:best,null);
}

function buildShapes(imageData,threshold){
  const {width,height}=imageData,mask=binaryMask(imageData,threshold);
  const black=components(mask,width,height,1);
  const white=components(mask,width,height,0);
  const holes=white.filter(component=>!component.touchesBorder);
  const blackLoops=black.map(component=>largestLoop(boundaryLoops(component,mask,width,height,1))).filter(Boolean);
  const holeLoops=holes.map(component=>largestLoop(boundaryLoops(component,mask,width,height,0))).filter(Boolean);
  return{mask,blackLoops,holeLoops,blackCount:black.length,holeCount:holes.length,topologyCount:1+black.length+holes.length};
}

function escapeAttr(value){return String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');}

function svgForProfile(imageData,shapes,profile,{sourceWidth,sourceHeight}){
  const {width,height}=imageData;
  const blackPaths=shapes.blackLoops.map(loop=>fitClosedPolyline(loop,profile)).filter(Boolean);
  const whitePaths=shapes.holeLoops.map(loop=>fitClosedPolyline(loop,profile)).filter(Boolean);
  if(blackPaths.length!==shapes.blackCount||whitePaths.length!==shapes.holeCount)throw new Error('monologo_curve_fit_failed');
  const parts=[
    `<svg xmlns="http://www.w3.org/2000/svg" width="${escapeAttr(sourceWidth)}" height="${escapeAttr(sourceHeight)}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">`,
    `<path d="M 0 0 H ${width} V ${height} H 0 Z" fill="#ffffff"/>`,
    ...blackPaths.map(d=>`<path d="${escapeAttr(d)}" fill="#000000"/>`),
    ...whitePaths.map(d=>`<path d="${escapeAttr(d)}" fill="#ffffff"/>`),
    '</svg>'
  ];
  return{svg:parts.join(''),blackPaths:blackPaths.length,whitePaths:whitePaths.length};
}

export function monoLogoCandidates(imageData,options={}){
  const sourceWidth=options.sourceWidth||imageData.width,sourceHeight=options.sourceHeight||imageData.height;
  const thresholds=options.thresholds||[112,128,144];
  const candidates=[];
  for(const threshold of thresholds){
    const shapes=buildShapes(imageData,clamp(threshold,1,254));
    for(const profile of CURVE_PROFILES){
      const built=svgForProfile(imageData,shapes,profile,{sourceWidth,sourceHeight});
      candidates.push({
        svg:built.svg,
        threshold,
        profile:profile.id,
        profileLabel:profile.label,
        engine:'pixelquota-monocurve',
        topologyCount:shapes.topologyCount,
        blackCount:shapes.blackCount,
        whiteHoleCount:shapes.holeCount
      });
    }
  }
  return candidates;
}
