import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const executablePath=[process.env.CHROME_PATH,process.env.PUPPETEER_EXECUTABLE_PATH,process.env.CHROMIUM_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/opt/google/chrome/chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>p&&fs.existsSync(p));
assert(executablePath,'A real Chrome/Chromium browser is required');
const report=path.resolve(process.argv[2]||path.join(process.env.TMPDIR||os.tmpdir(),`PixelQuota-ui-controls-${Date.now()}.json`));
fs.mkdirSync(path.dirname(report),{recursive:true});
const compiled=await build({entryPoints:[path.join(root,'src/numeric-controls.js')],bundle:true,write:false,format:'iife',globalName:'PQNumeric'});
const overlayCompiled=await build({entryPoints:[path.join(root,'src/overlay-manager.js')],bundle:true,write:false,format:'iife',globalName:'PQOverlay'});
const positionCompiled=await build({entryPoints:[path.join(root,'src/position-picker.js')],bundle:true,write:false,format:'iife',globalName:'PQPosition'});
const colorCompiled=await build({entryPoints:[path.join(root,'src/color-picker.js')],bundle:true,write:false,format:'iife',globalName:'PQColor'});
const browser=await puppeteer.launch({headless:true,executablePath,userDataDir:path.join(path.dirname(report),`chrome-${process.pid}-${Date.now()}`),args:['--no-sandbox','--disable-dev-shm-usage']});
const checks=[],errors=[],layoutResults=[],screenshots=[];
let productServer=null;
const persistProgress=()=>fs.writeFileSync(report,JSON.stringify({ok:false,checks,errors,layoutRegression:{expected:15,completed:layoutResults.length,results:layoutResults,screenshots}},null,2));
try{
 const page=await browser.newPage();
 await page.setViewport({width:1440,height:980});
 page.on('pageerror',e=>errors.push(String(e)));
 await page.setContent('<div id="app"><section class="settings-sheet"><div class="setting-control"><label class="control-label" for="watermarkSize">Size</label><input id="watermarkSize" type="range" min="1" max="100" step="1" value="12"></div></section></div>');
 await page.addStyleTag({content:fs.readFileSync(path.join(root,'src/app.css'),'utf8')});
 await page.addStyleTag({content:'.settings-sheet .setting-control{width:240px!important;max-width:240px!important}'});
 await page.addScriptTag({content:compiled.outputFiles[0].text});
 await page.evaluate(()=>{window.controlEvents={begin:0,end:0};PQNumeric.createNumericControls({onDragStart:()=>controlEvents.begin++,onDragEnd:()=>controlEvents.end++});});
 const label=await page.$('label[for="watermarkSize"]');
 await label.evaluate(e=>e.scrollIntoView({block:'center'}));
 const rect=await label.boundingBox();
 assert(rect&&rect.width>8&&rect.height>8,'Draggable label must be measurable');
 const initial={x:rect.x+2,y:rect.y+rect.height/2};
 const outside={x:Math.min(1430,rect.x+rect.width+48),y:initial.y};
 assert(outside.x>rect.x+rect.width,'The fast drag must actually leave the label');
 await page.mouse.move(initial.x,initial.y);
 await page.mouse.down();
 await page.mouse.move(outside.x,outside.y,{steps:1});
 await page.mouse.up();
 const afterRelease=await page.evaluate(()=>({value:document.querySelector('#watermarkSize').value,...controlEvents}));
 await page.mouse.move(rect.x+rect.width/2,initial.y,{steps:1});
 await new Promise(r=>setTimeout(r,50));
 const afterHover=await page.evaluate(()=>({value:document.querySelector('#watermarkSize').value,...controlEvents}));
 checks.push({name:'fast label drag releases outside and cannot change values on a later hover',pass:afterRelease.begin===1&&afterRelease.end===1&&afterHover.value===afterRelease.value&&afterHover.begin===1&&afterHover.end===1,afterRelease,afterHover});
 const geometry=await page.evaluate(()=>[...document.querySelectorAll('.numeric-control button,.numeric-control input')].map(e=>{const r=e.getBoundingClientRect();return{tag:e.tagName,y:r.y,height:r.height,bottom:r.bottom};}));
 checks.push({name:'numeric input and step buttons share exact 40px height and baseline',pass:geometry.length===3&&geometry.every(r=>Math.abs(r.height-40)<.25&&Math.abs(r.y-geometry[0].y)<.25&&Math.abs(r.bottom-geometry[0].bottom)<.25),geometry});
 const captionContrast=await page.evaluate(()=>{
  const stage=document.createElement('div');stage.style.cssText='position:relative;background:#fff;width:600px;height:100px';
  const label=document.createElement('div');label.className='canvas-file-label';label.innerHTML='<span>1 / 2</span><strong>sample.png</strong><span>Live preview</span>';stage.append(label);document.querySelector('#app').append(stage);
  const rgba=value=>value.match(/[\d.]+/g).map(Number),c=rgba(getComputedStyle(label).backgroundColor),alpha=c[3]??1,bg=c.slice(0,3).map(v=>v*alpha+255*(1-alpha));
  const luminance=rgb=>rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  return [...label.children].map(e=>{const fg=rgba(getComputedStyle(e).color),a=luminance(fg),b=luminance(bg);return{text:e.textContent,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
 });
 checks.push({name:'canvas captions remain readable over a worst-case white image',pass:captionContrast.length===3&&captionContrast.every(x=>x.ratio>=4.5),captionContrast});
 await page.setViewport({width:390,height:844});
 const touchText=await page.evaluate(()=>{
  const toast=document.createElement('div');toast.className='toast show';toast.textContent='Processing complete.';document.body.append(toast);
  const button=document.createElement('button');button.className='stage-action-button';button.innerHTML='<span>Reset crop</span>';document.querySelector('#app').append(button);
  return [toast,button.querySelector('span')].map(e=>({text:e.textContent,fontSize:parseFloat(getComputedStyle(e).fontSize)}));
 });
 checks.push({name:'touch toast and stage-action text retain the 13px floor outside settings',pass:touchText.length===2&&touchText.every(x=>x.fontSize>=13),touchText});
 await page.setViewport({width:1440,height:980});
 const presets=await page.evaluate(()=>{
  const row=document.createElement('div');row.className='preset-row';row.innerHTML='<button type="button">50</button><button type="button">100</button>';const bar=document.createElement('div');bar.className='settings-primary bar';bar.append(row);document.querySelector('.settings-sheet').append(bar);
  const r=row.getBoundingClientRect();return{height:r.height,padding:getComputedStyle(row).padding,selectorMatch:row.matches('#app#app .settings-sheet .preset-row'),viewport:innerWidth,children:[...row.children].map(e=>{const b=e.getBoundingClientRect();return{height:b.height,topOffset:b.top-r.top,bottomOffset:r.bottom-b.bottom};})};
 });
 checks.push({name:'preset wrapper introduces no hidden vertical padding or baseline offset',pass:presets.height===40&&presets.children.length===2&&presets.children.every(x=>x.height===40&&Math.abs(x.topOffset)<.25&&Math.abs(x.bottomOffset)<.25),presets});
 const numericPage=await browser.newPage();
 await numericPage.setContent('<div><input id="watermarkSize" type="range" min="2" max="30" step="1" value="12"><input id="watermarkOpacity" type="range" min="0" max="100" step="1" value="1"><input id="watermarkImageSize" type="number" min="2" max="30" step="1" value=""></div>');
 await numericPage.addScriptTag({content:compiled.outputFiles[0].text});
 await numericPage.evaluate(()=>{PQNumeric.createNumericControls();window.numericEvents=[];for(const input of document.querySelectorAll('input'))for(const type of ['input','change'])input.addEventListener(type,()=>numericEvents.push({id:input.id,type,value:input.value}));});
 const setTypedValue=async(value,key='Tab')=>{await numericPage.click('#watermarkSize');await numericPage.keyboard.down('Control');await numericPage.keyboard.press('A');await numericPage.keyboard.up('Control');if(value!=='')await numericPage.keyboard.type(value);else await numericPage.keyboard.press('Backspace');await numericPage.keyboard.press(key);await new Promise(r=>setTimeout(r,30));return numericPage.$eval('#watermarkSize',e=>({value:e.value,valid:e.validity.valid,overflow:e.validity.rangeOverflow,underflow:e.validity.rangeUnderflow,events:window.numericEvents.slice()}));};
 const upper=await setTypedValue('999');
 checks.push({name:'direct numeric typing clamps above max on blur',pass:upper.value==='30'&&upper.valid&&!upper.overflow,upper});
 await numericPage.evaluate(()=>{document.querySelector('#watermarkSize').value='12';numericEvents=[];});
 const lower=await setTypedValue('-999');
 checks.push({name:'direct numeric typing clamps below min on blur',pass:lower.value==='2'&&lower.valid&&!lower.underflow,lower});
 await numericPage.evaluate(()=>{document.querySelector('#watermarkSize').value='12';numericEvents=[];});
 const enter=await setTypedValue('999','Enter');
 const enterSync=enter.events.filter(e=>e.id==='watermarkSize'&&(e.type==='input'||e.type==='change'));
 checks.push({name:'Enter commits a clamped value and emits synchronized input/change',pass:enter.value==='30'&&enter.valid&&enterSync.some(e=>e.type==='input'&&e.value==='30')&&enterSync.some(e=>e.type==='change'&&e.value==='30')&&enterSync.filter(e=>e.type==='change').length===1,enter});
 await numericPage.evaluate(()=>{document.querySelector('#watermarkSize').value='12';numericEvents=[];});
 await setTypedValue('18');
 await numericPage.evaluate(()=>{numericEvents=[];});
 const blank=await setTypedValue('','Enter');
 checks.push({name:'blank Enter restores the last committed valid value and emits one final change',pass:blank.value==='18'&&blank.valid&&blank.events.filter(e=>e.type==='change'&&e.value==='18').length===1,blank});
 const emptyDefault=await numericPage.evaluate(async()=>{const input=document.querySelector('#watermarkImageSize');window.numericEvents=[];input.focus();input.blur();await new Promise(resolve=>setTimeout(resolve,30));return{value:input.value,valid:input.validity.valid,events:window.numericEvents.filter(e=>e.id===input.id)};});
 checks.push({name:'an initially empty field commits to its legal min and synchronizes change',pass:emptyDefault.value==='2'&&emptyDefault.valid&&emptyDefault.events.some(e=>e.type==='change'&&e.value==='2'),emptyDefault});
 const legacyControls=await numericPage.evaluate(async()=>{
  const input=document.querySelector('#watermarkSize'),opacity=document.querySelector('#watermarkOpacity');
  input.value='12';input.nextElementSibling?.click();
  const plus=input.closest('.numeric-control').querySelector('[data-numeric-step="1"]'),minus=input.closest('.numeric-control').querySelector('[data-numeric-step="-1"]');
  plus.click();minus.click();input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));input.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowUp',bubbles:true}));
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',shiftKey:true,bubbles:true}));input.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowUp',shiftKey:true,bubbles:true}));
  opacity.closest('.numeric-control').querySelector('[data-numeric-step="-1"]').click();
  return{value:input.value,zero:opacity.value,zeroValid:opacity.validity.valid};
 });
 checks.push({name:'plus/minus, Arrow, Shift+Arrow and a valid zero remain effective',pass:legacyControls.value==='23'&&legacyControls.zero==='0'&&legacyControls.zeroValid,legacyControls});
 const overlayPage=await browser.newPage();
 await overlayPage.setContent('<div id="app"><button id="firstTrigger" type="button">First</button><div id="firstPopover" hidden><button id="firstItem" type="button">Item</button></div><input id="outsideInput"><div id="blankOutside">Blank</div><button id="secondTrigger" type="button">Second</button><div id="secondPopover" hidden><button id="secondItem" type="button">Other item</button></div><div id="positionControl" class="setting-control"><span class="control-label">Position</span><div id="positionPopover" hidden><button type="button" data-position="tc">Top</button></div></div><input id="colorInput" value="#ffffff"><button id="colorToggle" type="button">Color</button><span id="colorPreview"></span><span id="colorLabel"></span><div id="colorPopover" hidden><div id="colorField"><span id="colorCursor"></span></div><input id="colorHue" type="range" min="0" max="360" value="0"><input id="colorHexInput" value="#ffffff"></div></div>');
 await overlayPage.addStyleTag({content:'#firstPopover,#secondPopover,#positionPopover,#colorPopover{position:fixed;left:4px;top:4px}'});
 await overlayPage.addScriptTag({content:overlayCompiled.outputFiles[0].text});
 await overlayPage.addScriptTag({content:positionCompiled.outputFiles[0].text});
 await overlayPage.addScriptTag({content:colorCompiled.outputFiles[0].text});
 await overlayPage.evaluate(()=>{
  window.testOverlays=PQOverlay.createOverlayManager(document);
  window.overlayClickCounts={};const register=(id,triggerId,popoverId)=>{const trigger=document.querySelector(`#${triggerId}`),popover=document.querySelector(`#${popoverId}`);testOverlays.register(id,{trigger,popover,open:()=>{popover.hidden=false;},close:()=>{popover.hidden=true;}});trigger.addEventListener('click',()=>{overlayClickCounts[id]=(overlayClickCounts[id]||0)+1;testOverlays.isOpen(id)?testOverlays.close(id):testOverlays.open(id);});};
  register('first','firstTrigger','firstPopover');register('second','secondTrigger','secondPopover');
  window.positionPicker=PQPosition.setupPositionPicker({popover:document.querySelector('#positionPopover'),id:'position',overlayManager:testOverlays});
  window.colorPicker=PQColor.createColorPicker({input:document.querySelector('#colorInput'),toggle:document.querySelector('#colorToggle'),preview:document.querySelector('#colorPreview'),hexLabel:document.querySelector('#colorLabel'),popover:document.querySelector('#colorPopover'),field:document.querySelector('#colorField'),cursor:document.querySelector('#colorCursor'),hue:document.querySelector('#colorHue'),hexInput:document.querySelector('#colorHexInput'),overlayManager:testOverlays,overlayId:'color'});
 });
 await overlayPage.click('#firstTrigger');await overlayPage.focus('#firstItem');await overlayPage.click('#blankOutside');await new Promise(r=>setTimeout(r,60));
 const blankFocus=await overlayPage.evaluate(()=>({open:testOverlays.isOpen('first'),active:document.activeElement.id}));
 checks.push({name:'real blank outside pointerdown closes and restores trigger focus after native default',pass:!blankFocus.open&&blankFocus.active==='firstTrigger',blankFocus});
 await overlayPage.click('#firstTrigger');await overlayPage.focus('#firstItem');await overlayPage.click('#outsideInput');await new Promise(r=>setTimeout(r,60));
 const inputFocus=await overlayPage.evaluate(()=>({open:testOverlays.isOpen('first'),active:document.activeElement.id}));
 checks.push({name:'outside input keeps its native focus after closing overlay',pass:!inputFocus.open&&inputFocus.active==='outsideInput',inputFocus});
 await overlayPage.click('#firstTrigger');await overlayPage.focus('#firstItem');await overlayPage.click('#secondTrigger');await new Promise(r=>setTimeout(r,60));
 const mutualFocus=await overlayPage.evaluate(()=>({first:testOverlays.isOpen('first'),second:testOverlays.isOpen('second'),active:testOverlays.activeId,secondHidden:document.querySelector('#secondPopover').hidden,clicks:overlayClickCounts,focused:document.activeElement.id}));
 checks.push({name:'opening a new overlay stays exclusive and never restores the old trigger',pass:!mutualFocus.first&&mutualFocus.second&&mutualFocus.active==='second'&&mutualFocus.focused==='secondTrigger',mutualFocus});
 await overlayPage.evaluate(()=>{testOverlays.close('second');testOverlays.open('first');document.querySelector('#firstItem').focus();testOverlays.close('first');});await new Promise(r=>setTimeout(r,60));
 const programmaticFocus=await overlayPage.evaluate(()=>({active:document.activeElement.id,firstOpen:testOverlays.isOpen('first')}));
 checks.push({name:'programmatic close does not move focus to the old trigger',pass:!programmaticFocus.firstOpen&&programmaticFocus.active!=='firstTrigger',programmaticFocus});
 await overlayPage.click('#firstTrigger');await overlayPage.focus('#firstItem');await overlayPage.keyboard.press('Escape');
 const escapeFocus=await overlayPage.evaluate(()=>({open:testOverlays.isOpen('first'),active:document.activeElement.id}));
 checks.push({name:'Escape closes and restores trigger focus',pass:!escapeFocus.open&&escapeFocus.active==='firstTrigger',escapeFocus});
 await overlayPage.click('[data-position-trigger="position"]');await overlayPage.click('[data-position="tc"]');await new Promise(r=>setTimeout(r,20));
 const positionFocus=await overlayPage.evaluate(()=>({open:testOverlays.isOpen('position'),active:document.activeElement.dataset.positionTrigger||document.activeElement.id}));
 checks.push({name:'completing a position selection closes and restores trigger focus',pass:!positionFocus.open&&positionFocus.active==='position',positionFocus});
 await overlayPage.click('#colorToggle');await overlayPage.click('#colorHexInput');await overlayPage.keyboard.down('Control');await overlayPage.keyboard.press('A');await overlayPage.keyboard.up('Control');await overlayPage.keyboard.type('#abc');await overlayPage.keyboard.press('Enter');await new Promise(r=>setTimeout(r,20));
 const hexFocus=await overlayPage.evaluate(()=>({open:testOverlays.isOpen('color'),active:document.activeElement.id,color:document.querySelector('#colorInput').value}));
 checks.push({name:'hex Enter applies color, closes and restores trigger focus',pass:!hexFocus.open&&hexFocus.active==='colorToggle'&&hexFocus.color==='#aabbcc',hexFocus});

 const productHtml=path.resolve(process.env.PIXELQUOTA_UI_TEST_HTML||path.join(root,'dist','PixelQuota.html'));
 assert(fs.existsSync(productHtml),`Built dist/PixelQuota.html not found: ${productHtml}`);
 const productRoot=path.dirname(productHtml);
 const mimeTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.wasm':'application/wasm'};
 productServer=http.createServer((request,response)=>{
  try{
   const pathname=new URL(request.url,'http://127.0.0.1').pathname;
   const decoded=decodeURIComponent(pathname==='/'?'/PixelQuota.html':pathname);
   let file=path.resolve(productRoot,`.${decoded}`);
   const relative=path.relative(productRoot,file);
   if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)){response.writeHead(403).end();return;}
   if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
   if(!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404).end();return;}
   response.setHeader('Content-Type',mimeTypes[path.extname(file).toLowerCase()]||'application/octet-stream');
   fs.createReadStream(file).pipe(response);
  }catch{response.writeHead(400).end();}
 });
 await new Promise((resolve,reject)=>{productServer.once('error',reject);productServer.listen(0,'127.0.0.1',resolve);});
 const productUrl=`http://127.0.0.1:${productServer.address().port}/PixelQuota.html`;
 const fixturePage=await browser.newPage();
 const pngBytes=await fixturePage.evaluate(async()=>{
  const canvas=document.createElement('canvas');canvas.width=32;canvas.height=24;
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob)throw new Error('Canvas could not create the diagnostic PNG');
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
 });
 await fixturePage.close();
 const diagnosticPng=path.join(path.dirname(report),'pixelquota-numeric-layout-probe.png');
 fs.writeFileSync(diagnosticPng,Buffer.from(pngBytes));
 const localeList=['en','zh-TW','zh-CN','ja','ko'];
 const controlIds=['watermarkSize','watermarkOpacity','watermarkImageOpacity','watermarkImageSize'];
 const describeLayout=touchRequired=>layoutPage.evaluate((ids,needsTouchText)=>{
  const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
  const controls=ids.map(id=>{
   const e=document.querySelector(`.numeric-control[data-numeric-control="${id}"]`);
   if(!e)return null;
   const cell=e.parentElement;
   return{id,box:rect(e),parent:rect(cell),labelFontSize:parseFloat(getComputedStyle(cell.querySelector('.control-label')).fontSize),inputFontSize:parseFloat(getComputedStyle(e.querySelector('input')).fontSize),parts:[...e.querySelectorAll('button,input')].map(part=>({tag:part.tagName,text:part.textContent||part.value,step:part.dataset.numericStep||null,borderRadius:getComputedStyle(part).borderRadius,box:rect(part)}))};
  }).filter(Boolean);
  const collisions=[];
  for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++)for(const a of controls[i].parts)for(const b of controls[j].parts){
   const w=Math.min(a.box.right,b.box.right)-Math.max(a.box.x,b.box.x),h=Math.min(a.box.bottom,b.box.bottom)-Math.max(a.box.y,b.box.y);
   if(w>.5&&h>.5)collisions.push({a:controls[i].id,b:controls[j].id,partA:a.text,partB:b.text,width:w,height:h});
  }
  const outOfCell=controls.filter(c=>c.box.x<c.parent.x-.5||c.box.y<c.parent.y-.5||c.box.right>c.parent.right+.5||c.box.bottom>c.parent.bottom+.5).map(c=>c.id);
  const heightAligned=controls.every(c=>Math.abs(c.box.h-40)<.25&&c.parts.length===3&&c.parts.every(p=>Math.abs(p.box.h-40)<.25&&Math.abs(p.box.y-c.box.y)<.25&&Math.abs(p.box.bottom-c.box.bottom)<.25));
  const fourPixelGaps=controls.every(c=>{const parts=[...c.parts].sort((a,b)=>a.box.x-b.box.x);return parts.length===3&&parts.slice(1).every((p,i)=>Math.abs(p.box.x-parts[i].box.right-4)<.25)});
  const targetsAtLeast40=controls.every(c=>c.parts.filter(p=>p.tag==='BUTTON').every(p=>p.box.w>=40&&p.box.h>=40));
  const roundedControls=controls.every(c=>c.parts.every(p=>p.borderRadius==='8px'));
  const touchTextReadable=!needsTouchText||controls.every(c=>c.labelFontSize>=13&&c.inputFontSize>=13);
  return{controls,collisions,outOfCell,heightAligned,fourPixelGaps,targetsAtLeast40,roundedControls,touchTextReadable};
 },controlIds,touchRequired);
 let layoutPage;
 const waitForNumericLayout=async()=>{
  await layoutPage.waitForFunction(()=>{
   const ancestors=new Set();
   for(const control of document.querySelectorAll('.numeric-control')){
    if(!control.offsetParent)continue;
    for(let el=control;el;el=el.parentElement)ancestors.add(el);
   }
   return document.getAnimations().every(animation=>!ancestors.has(animation.effect?.target)||animation.effect.getComputedTiming().iterations===Infinity||['finished','idle'].includes(animation.playState));
  },{timeout:5000});
  await layoutPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 };
 const hitTest=async(id,step)=>{
  const selector=`.numeric-control[data-numeric-control="${id}"] button[data-numeric-step="${step}"]`;
  await layoutPage.$eval(selector,e=>e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
  return layoutPage.$eval(selector,button=>{
   const r=button.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
   return{id:button.closest('.numeric-control').dataset.numericControl,step:Number(button.dataset.numericStep),x,y,hitTag:hit?.tagName||null,reachable:!!hit&&(hit===button||button.contains(hit))};
  });
 };
 const clickCenter=async step=>{
  const selector=`.numeric-control[data-numeric-control="watermarkSize"] button[data-numeric-step="${step}"]`;
  await layoutPage.$eval(selector,e=>e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
  const point=await layoutPage.$eval(selector,e=>{const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};});
  await layoutPage.mouse.click(point.x,point.y);
  return layoutPage.$eval('#watermarkSize',e=>Number(e.value));
 };
 for(const width of [1440,768,390]){
  layoutPage=await browser.newPage();layoutPage.on('pageerror',e=>errors.push(`layout:${e.message}`));
  await layoutPage.setViewport({width,height:1000,deviceScaleFactor:1,isMobile:width===390,hasTouch:width<1000});
  await layoutPage.goto(productUrl,{waitUntil:'load'});await layoutPage.waitForFunction(()=>window.PixelQuotaTest);
  await layoutPage.click('#toolModeSwitch [data-tool-mode="watermark"]');
  await layoutPage.waitForFunction(()=>window.PixelQuotaTest.state.toolMode==='watermark');
  const [fileChooser]=await Promise.all([layoutPage.waitForFileChooser(),layoutPage.click('#browseBtn')]);
  await fileChooser.accept([diagnosticPng]);
  await layoutPage.waitForFunction(()=>window.PixelQuotaTest.state.files.length===1&&document.querySelector('#compareOriginal')?.naturalWidth>0);
  await layoutPage.waitForFunction(()=>[...document.querySelectorAll('.numeric-control')].filter(e=>e.getBoundingClientRect().width&&e.offsetParent).length===4);
  for(const locale of localeList){
   await layoutPage.evaluate(()=>window.scrollTo(0,0));
   if(await layoutPage.$eval('html',e=>e.lang)!==locale){
    await layoutPage.click('#languageToggle');await layoutPage.click(`#languageOptions [data-locale="${locale}"]`);
    await layoutPage.waitForFunction(expected=>document.documentElement.lang===expected,{},locale);
   }
   const animationProbe=width===768&&locale==='en';
   if(animationProbe)await layoutPage.evaluate(()=>{
    const control=document.querySelector('.numeric-control[data-numeric-control="watermarkSize"]');
    window.__pqGeometryAnimation=control.parentElement.animate([{transform:'translateY(4px)'},{transform:'none'}],{duration:500,easing:'linear'});
   });
   await waitForNumericLayout();
   const geometry=await describeLayout(width<1000);
   if(animationProbe){
    const animationState=await layoutPage.evaluate(()=>({state:window.__pqGeometryAnimation.playState,currentTime:window.__pqGeometryAnimation.currentTime,duration:window.__pqGeometryAnimation.effect.getTiming().duration}));
    checks.push({name:'numeric geometry waits for a finite ancestor animation to finish without disabling it or relaxing 40px targets',pass:animationState.state==='finished'&&animationState.currentTime>=animationState.duration&&geometry.targetsAtLeast40,animationState,targetsAtLeast40:geometry.targetsAtLeast40});
   }
   const hitTests=[];
   for(const id of controlIds)for(const step of [-1,1])hitTests.push(await hitTest(id,step));
   const before=await layoutPage.$eval('#watermarkSize',e=>Number(e.value));
   const afterPlus=await clickCenter(1),afterMinus=await clickCenter(-1);
   const interaction={before,afterPlus,afterMinus,plusChanged:afterPlus!==before,minusChanged:afterMinus!==afterPlus,restored:afterMinus===before};
   const pass=geometry.controls.length===4&&geometry.collisions.length===0&&geometry.outOfCell.length===0&&geometry.heightAligned&&geometry.fourPixelGaps&&geometry.targetsAtLeast40&&geometry.roundedControls&&geometry.touchTextReadable&&hitTests.length===8&&hitTests.every(hit=>hit.reachable)&&interaction.plusChanged&&interaction.minusChanged&&interaction.restored;
   layoutResults.push({width,locale,pass,...geometry,hitTests,interaction});
   if(locale==='zh-TW'){
    await layoutPage.evaluate(()=>window.scrollTo(0,0));
    const screenshot=path.resolve(path.dirname(report),`watermark-layout-${width}.png`);
    await layoutPage.screenshot({path:screenshot,fullPage:true});screenshots.push(screenshot);
   }
   persistProgress();
  }
  await layoutPage.close();
 }
 checks.push({name:'built-product numeric geometry, 40px height/targets, 4px gaps, touch text, cell containment, hit tests and clicks across 5 locales × 3 widths',pass:layoutResults.length===15&&layoutResults.every(item=>item.pass),expected:15,completed:layoutResults.length,failures:layoutResults.filter(item=>!item.pass).map(item=>({width:item.width,locale:item.locale,collisions:item.collisions,outOfCell:item.outOfCell,heightAligned:item.heightAligned,fourPixelGaps:item.fourPixelGaps,targetsAtLeast40:item.targetsAtLeast40,roundedControls:item.roundedControls,touchTextReadable:item.touchTextReadable,unreachable:item.hitTests.filter(hit=>!hit.reachable),interaction:item.interaction})),screenshots});
} catch(e){errors.push(String(e.stack||e));}
finally{if(productServer)await new Promise(resolve=>productServer.close(resolve));await browser.close();}
const layoutRegression={expected:15,completed:layoutResults.length,results:layoutResults,screenshots};
const result={ok:checks.length>0&&checks.every(x=>x.pass)&&errors.length===0,checks,errors,layoutRegression};
fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
process.exitCode=result.ok?0:1;
