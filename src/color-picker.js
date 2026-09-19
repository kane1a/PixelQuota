function normalizeHex(value){
  const raw=String(value||'').trim().replace(/^#/,'');
  if(/^[0-9a-f]{3}$/i.test(raw))return '#'+raw.split('').map(c=>c+c).join('').toLowerCase();
  if(/^[0-9a-f]{6}$/i.test(raw))return '#'+raw.toLowerCase();
  return null;
}

function hexToHsv(hex){
  const normalized=normalizeHex(hex)||'#ffffff';
  const r=parseInt(normalized.slice(1,3),16)/255;
  const g=parseInt(normalized.slice(3,5),16)/255;
  const b=parseInt(normalized.slice(5,7),16)/255;
  const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
  let h=0;
  if(delta){
    if(max===r)h=60*(((g-b)/delta)%6);
    else if(max===g)h=60*((b-r)/delta+2);
    else h=60*((r-g)/delta+4);
  }
  if(h<0)h+=360;
  return{h,s:max?delta/max:0,v:max};
}

function hsvToHex(h,s,v){
  const c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c;
  let r=0,g=0,b=0;
  if(h<60){r=c;g=x;}else if(h<120){r=x;g=c;}else if(h<180){g=c;b=x;}else if(h<240){g=x;b=c;}else if(h<300){r=x;b=c;}else{r=c;b=x;}
  return '#'+[r,g,b].map(n=>Math.round((n+m)*255).toString(16).padStart(2,'0')).join('');
}

export function createColorPicker({
  input,toggle,preview,hexLabel,popover,field,cursor,hue,hexInput,presetRoot,presetAttribute='color',onChange=()=>{}
}){
  let hsv={h:0,s:0,v:1};

  function sync(hex){
    const normalized=normalizeHex(hex)||'#ffffff';
    hsv=hexToHsv(normalized);
    input.value=normalized;
    preview.style.background=normalized;
    hexLabel.textContent=normalized.toUpperCase();
    hexInput.value=normalized.toUpperCase();
    hue.value=String(Math.round(hsv.h));
    field.style.setProperty('--picker-hue',String(Math.round(hsv.h)));
    cursor.style.left=`${hsv.s*100}%`;
    cursor.style.top=`${(1-hsv.v)*100}%`;
    if(presetRoot){
      presetRoot.querySelectorAll(`[${presetAttribute}]`).forEach(button=>{
        button.classList.toggle('active',button.dataset[presetAttribute.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]?.toLowerCase?.()===normalized);
      });
    }
    return normalized;
  }

  function setColor(value,emit=true){
    const normalized=normalizeHex(value);
    if(!normalized)return false;
    sync(normalized);
    if(emit)onChange(normalized);
    return true;
  }

  function applyHsv(){
    setColor(hsvToHex(hsv.h,hsv.s,hsv.v),true);
  }

  function pointerToField(event){
    const rect=field.getBoundingClientRect();
    hsv.s=Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width));
    hsv.v=1-Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height));
    applyHsv();
  }

  function open(){popover.hidden=false;toggle.setAttribute('aria-expanded','true');sync(input.value);}
  function close(){popover.hidden=true;toggle.setAttribute('aria-expanded','false');}
  function toggleOpen(){if(popover.hidden)open();else close();}

  toggle.onclick=toggleOpen;
  hue.oninput=e=>{hsv.h=Number(e.target.value)||0;applyHsv();};
  hexInput.oninput=e=>{const normalized=normalizeHex(e.target.value);if(normalized)setColor(normalized,true);};
  hexInput.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();if(setColor(e.target.value,true))close();}};
  field.onpointerdown=e=>{field.setPointerCapture?.(e.pointerId);pointerToField(e);};
  field.onpointermove=e=>{if(field.hasPointerCapture?.(e.pointerId))pointerToField(e);};
  field.onpointerup=e=>field.releasePointerCapture?.(e.pointerId);
  field.onkeydown=e=>{
    const step=e.shiftKey?.05:.01;
    let handled=true;
    if(e.key==='ArrowLeft')hsv.s-=step;
    else if(e.key==='ArrowRight')hsv.s+=step;
    else if(e.key==='ArrowUp')hsv.v+=step;
    else if(e.key==='ArrowDown')hsv.v-=step;
    else handled=false;
    if(handled){
      e.preventDefault();
      hsv.s=Math.max(0,Math.min(1,hsv.s));
      hsv.v=Math.max(0,Math.min(1,hsv.v));
      applyHsv();
    }
  };
  if(presetRoot){
    presetRoot.onclick=e=>{
      const button=e.target.closest(`[${presetAttribute}]`);
      if(!button)return;
      const key=presetAttribute.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
      setColor(button.dataset[key],true);
    };
  }
  sync(input.value);

  return{setColor,open,close,getColor:()=>input.value};
}
