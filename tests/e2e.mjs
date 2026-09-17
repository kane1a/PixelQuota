import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const chromeCandidates=[process.env.CHROME_PATH,process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':null,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean);
const chrome=chromeCandidates.find(candidate=>fs.existsSync(candidate));
if(!chrome)throw new Error('Chrome/Chromium not found. Set CHROME_PATH to run the browser tests.');
const root=path.resolve('dist');
const fileUrl=`file:///${path.join(root,'PixelQuota.html').replace(/\\/g,'/')}`;
const artifacts=path.resolve('tests','artifacts');
const downloads=path.resolve('tests','downloads');
fs.mkdirSync(artifacts,{recursive:true});fs.mkdirSync(downloads,{recursive:true});
for(const f of fs.readdirSync(downloads))fs.rmSync(path.join(downloads,f),{force:true,recursive:true});

const browser=await puppeteer.launch({headless:true,executablePath:chrome,args:['--no-sandbox','--allow-file-access-from-files']});
const page=await browser.newPage();
const errors=[];
page.on('pageerror',e=>errors.push(`page:${e.message}`));
page.on('console',m=>{if(m.type()==='error')errors.push(`console:${m.text()}`)});
const client=await page.createCDPSession();
await client.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
await page.setViewport({width:1440,height:1050,deviceScaleFactor:1});
await page.goto(fileUrl,{waitUntil:'load'});
await page.waitForFunction(()=>!!window.PixelQuotaTest);

if(await page.$('#cameraBtn')||await page.$('#cameraInput'))throw new Error('camera controls still exist');

await page.select('#languageSelect','zh-TW');
const zh=await page.evaluate(()=>({hero:document.querySelector('#heroTitle').textContent,drop:document.querySelector('.drop-zone strong').textContent,guide:document.querySelector('[data-i18n="guideLabel"]').textContent,privacy:document.querySelector('footer [data-i18n="privacyLink"]').textContent,placeholder:document.querySelector('#maxWidth').placeholder}));
if(!zh.hero.includes('精準 KB')||!zh.drop.includes('圖片')||!zh.guide.includes('使用說明')||zh.privacy!=='隱私說明'||zh.placeholder!=='不限')throw new Error(`zh translation incomplete ${JSON.stringify(zh)}`);
const beforeCommon=await page.url();
await page.click('#commonLimitButtons [data-kb="50"]');
await new Promise(r=>setTimeout(r,250));
const commonZh=await page.evaluate(()=>({href:location.href,target:document.querySelector('#targetKb').value,lang:document.querySelector('#languageSelect').value,hero:document.querySelector('#heroTitle').textContent,labels:[...document.querySelectorAll('#commonLimitButtons span')].map(x=>x.textContent)}));
if(commonZh.href!==beforeCommon||commonZh.target!=='50'||commonZh.lang!=='zh-TW'||!commonZh.hero.includes('精準 KB')||commonZh.labels.some(x=>/applications|photo uploads|common limit/i.test(x)))throw new Error(`common limit language/navigation regression ${JSON.stringify(commonZh)}`);

await page.click('#presetRow [data-custom]');
await page.$eval('#targetKb',e=>{e.value='137';e.dispatchEvent(new Event('input',{bubbles:true}))});
const custom=await page.evaluate(()=>({active:document.querySelector('#presetRow [data-custom]').classList.contains('active'),gate:document.querySelector('#gateBadge').textContent,value:document.querySelector('#targetKb').value}));
if(!custom.active||custom.value!=='137'||!custom.gate.includes('137'))throw new Error(`custom size failed ${JSON.stringify(custom)}`);

await page.click('#presetRow [data-kb="100"]');
await page.click('[data-format="image/jpeg"]');
if(!(await page.$eval('[data-format="image/jpeg"]',e=>e.classList.contains('active'))))throw new Error('format selector failed');
await page.click('#advancedSettings summary');
await page.click('[data-resize="exact"]');
await page.$eval('#maxWidth',e=>e.value='600');await page.$eval('#maxHeight',e=>e.value='600');
await page.click('[data-resize="limit"]');
await page.$eval('#maxWidth',e=>e.value='');await page.$eval('#maxHeight',e=>e.value='');

const fixtureB64=await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=1800;c.height=1200;const x=c.getContext('2d');const g=x.createLinearGradient(0,0,1800,1200);g.addColorStop(0,'#173a72');g.addColorStop(.45,'#f1a33d');g.addColorStop(1,'#2c8b68');x.fillStyle=g;x.fillRect(0,0,c.width,c.height);for(let i=0;i<2400;i++){x.fillStyle=`rgba(${i%255},${(i*7)%255},${(i*13)%255},.45)`;x.fillRect((i*41)%1800,(i*97)%1200,18,18)}const b=await new Promise(r=>c.toBlob(r,'image/jpeg',.98));return new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result.split(',')[1]);fr.readAsDataURL(b)});});
const fixture=path.resolve('tests','fixture.jpg');fs.writeFileSync(fixture,Buffer.from(fixtureB64,'base64'));
const chooserPromise=page.waitForFileChooser();await page.click('#browseBtn');const chooser=await chooserPromise;await chooser.accept([fixture]);
await page.waitForSelector('.result-card.queued');
await page.click('#processBtn');
await page.waitForFunction(()=>window.PixelQuotaTest.state.results[0]&& !document.querySelector('#processBtn').classList.contains('busy'),{timeout:30000});
const first=await page.evaluate(()=>{const s=window.PixelQuotaTest.state,r=s.results[0];return {size:r.blob.size,target:r.targetBytes,met:r.metTarget,key:s.processKeys[0],skipped:s.lastSkipped,status:document.querySelector('.status').textContent}});
if(!first.met||first.size>first.target||first.skipped!==0)throw new Error(`first processing failed ${JSON.stringify(first)}`);
const compareFirst=await page.evaluate(()=>({hidden:document.querySelector('#comparisonPanel').hidden,rangeHidden:document.querySelector('#compareRange').hidden,filename:document.querySelector('#compareFilename').textContent,original:document.querySelector('#compareOriginalSize').textContent,output:document.querySelector('#compareOutputSize').textContent,status:document.querySelector('#compareStatus').textContent,selected:window.PixelQuotaTest.state.selectedIndex,position:getComputedStyle(document.querySelector('#comparisonStage')).getPropertyValue('--compare-position').trim()}));
if(compareFirst.hidden||compareFirst.rangeHidden||compareFirst.filename!=='fixture.jpg'||compareFirst.selected!==0||!compareFirst.output.includes('KB')||!compareFirst.status.includes('通過'))throw new Error(`comparison preview missing ${JSON.stringify(compareFirst)}`);
await page.$eval('#compareRange',e=>{e.value='72';e.dispatchEvent(new Event('input',{bubbles:true}))});
const compareDrag=await page.evaluate(()=>({value:document.querySelector('#compareRange').value,position:getComputedStyle(document.querySelector('#comparisonStage')).getPropertyValue('--compare-position').trim(),state:window.PixelQuotaTest.state.comparePosition}));
if(compareDrag.value!=='72'||compareDrag.position!=='72%'||compareDrag.state!==72)throw new Error(`comparison slider failed ${JSON.stringify(compareDrag)}`);

await page.click('#processBtn');await new Promise(r=>setTimeout(r,300));
const repeated=await page.evaluate(()=>({key:window.PixelQuotaTest.state.processKeys[0],skipped:window.PixelQuotaTest.state.lastSkipped,summary:document.querySelector('#resultsSummary').textContent,toast:document.querySelector('#toast').textContent}));
if(repeated.key!==first.key||repeated.skipped!==1||!repeated.toast.includes('設定沒有變更'))throw new Error(`repeat skip failed ${JSON.stringify(repeated)}`);

await page.click('#presetRow [data-kb="200"]');
await page.click('#processBtn');
await page.waitForFunction(old=>window.PixelQuotaTest.state.processKeys[0]!==old&&!document.querySelector('#processBtn').classList.contains('busy'),{},first.key);
const changed=await page.evaluate(()=>{const s=window.PixelQuotaTest.state,r=s.results[0];return {key:s.processKeys[0],skipped:s.lastSkipped,target:r.targetBytes,met:r.metTarget}});
if(changed.key===first.key||changed.skipped!==0||changed.target<190000)throw new Error(`changed-setting reprocess failed ${JSON.stringify(changed)}`);
const fixture2=path.resolve('tests','fixture-2.jpg');fs.copyFileSync(fixture,fixture2);
const chooser2Promise=page.waitForFileChooser();await page.click('#browseBtn');const chooser2=await chooser2Promise;await chooser2.accept([fixture2]);
await page.waitForFunction(()=>window.PixelQuotaTest.state.files.length===2);
await page.click('#processBtn');await page.waitForFunction(()=>window.PixelQuotaTest.state.results[1]&&!document.querySelector('#processBtn').classList.contains('busy'),{timeout:30000});
await page.click('[data-result-index="1"]');
const switched=await page.evaluate(()=>({selected:window.PixelQuotaTest.state.selectedIndex,filename:document.querySelector('#compareFilename').textContent,active:[...document.querySelectorAll('.result-card')].findIndex(x=>x.classList.contains('selected')),rangeHidden:document.querySelector('#compareRange').hidden}));
if(switched.selected!==1||switched.filename!=='fixture-2.jpg'||switched.active!==1||switched.rangeHidden)throw new Error(`batch comparison selection failed ${JSON.stringify(switched)}`);

await page.click('.result-action button');await page.click('#downloadAllBtn');await new Promise(r=>setTimeout(r,1000));
const downloaded=fs.readdirSync(downloads);if(!downloaded.some(n=>/\.jpe?g$/i.test(n))||!downloaded.some(n=>/\.zip$/i.test(n)))throw new Error(`downloads missing ${downloaded.join(',')}`);

await page.click('[data-resize="exact"]');
await page.$eval('#maxWidth',e=>e.value='600');await page.$eval('#maxHeight',e=>e.value='600');
await page.click('[data-format="image/png"]');
await page.click('#presetRow [data-custom]');
await page.$eval('#targetKb',e=>{e.value='5';e.dispatchEvent(new Event('input',{bubbles:true}))});
await page.click('#processBtn');
await page.waitForFunction(()=>window.PixelQuotaTest.state.results[0]&&!window.PixelQuotaTest.state.results[0].metTarget&&!document.querySelector('#processBtn').classList.contains('busy'),{timeout:30000});
const zhFail=await page.evaluate(()=>({reason:document.querySelector('.result-reason')?.textContent||'',status:document.querySelector('.status').textContent,result:{w:window.PixelQuotaTest.state.results[0].outputWidth,h:window.PixelQuotaTest.state.results[0].outputHeight,met:window.PixelQuotaTest.state.results[0].metTarget}}));
if(zhFail.result.met||zhFail.result.w!==600||zhFail.result.h!==600||!zhFail.reason.includes('600×600')||!zhFail.reason.includes('5 KB')||!zhFail.reason.includes('PNG')||!zhFail.reason.includes('無法'))throw new Error(`localized failure reason missing ${JSON.stringify(zhFail)}`);

await page.select('#languageSelect','en');
const enAfter=await page.evaluate(()=>({reason:document.querySelector('.result-reason')?.textContent||'',hero:document.querySelector('#heroTitle').textContent,guide:document.querySelector('[data-i18n="guideLabel"]').textContent,common:[...document.querySelectorAll('#commonLimitButtons span')].map(x=>x.textContent)}));
if(!enAfter.reason.includes('Could not reach')||!enAfter.hero.includes('Exact KB. Exact pixels. No uploads.')||enAfter.guide!=='PIXELQUOTA GUIDE'||enAfter.common.some(x=>/[\u4e00-\u9fff]/.test(x)))throw new Error(`english rerender incomplete ${JSON.stringify(enAfter)}`);

const widths=[320,375,768,1024,1440];const layouts=[];
for(const w of widths){await page.setViewport({width:w,height:w<500?844:1000,deviceScaleFactor:1});await new Promise(r=>setTimeout(r,80));const layout=await page.evaluate(()=>({w:innerWidth,scroll:document.documentElement.scrollWidth,browseH:document.querySelector('#browseBtn').getBoundingClientRect().height,processH:document.querySelector('#processBtn').getBoundingClientRect().height,helper:parseFloat(getComputedStyle(document.querySelector('.helper')).fontSize)}));if(layout.scroll>layout.w+2||layout.browseH<44||layout.processH<58||layout.helper<10)throw new Error(`responsive/readability failed ${JSON.stringify(layout)}`);layouts.push(layout);}
async function typographyProfile(locale){await page.select('#languageSelect',locale);const rows=[];for(const w of widths){await page.setViewport({width:w,height:w<500?844:1000,deviceScaleFactor:1});await new Promise(r=>setTimeout(r,80));const profile=await page.evaluate(()=>{const measure=selector=>{const el=document.querySelector(selector);const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);const lines=new Map();while(walker.nextNode()){const node=walker.currentNode;for(let i=0;i<node.textContent.length;i++){if(/\s/.test(node.textContent[i]))continue;const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);const rect=range.getBoundingClientRect();if(!rect.width||!rect.height)continue;const key=Math.round(rect.top);const line=lines.get(key)||{left:rect.left,right:rect.right,chars:0};line.left=Math.min(line.left,rect.left);line.right=Math.max(line.right,rect.right);line.chars++;lines.set(key,line);} }const out=[...lines.values()].sort((a,b)=>a.left-b.left).map(line=>({width:Math.round(line.right-line.left),chars:line.chars}));const max=Math.max(...out.map(x=>x.width),1);return{text:el.textContent.trim(),lines:out,lastRatio:out.length>1?out.at(-1).width/max:1};};return{common:measure('.limit-copy h2'),guide:measure('#seoHeading'),overflow:document.documentElement.scrollWidth-innerWidth};});for(const [name,value] of Object.entries({common:profile.common,guide:profile.guide})){if(value.lines.length>1&&value.lastRatio<.34)throw new Error(`typography orphan ${locale} ${w}px ${name} ${JSON.stringify(value)}`);}if(profile.overflow>2)throw new Error(`typography overflow ${locale} ${w}px ${JSON.stringify(profile)}`);rows.push({w,...profile});}return rows;}
const typography={zh:await typographyProfile('zh-TW'),en:await typographyProfile('en')};
await page.click('#presetRow [data-kb="100"]');await page.click('[data-format="image/jpeg"]');await page.click('[data-resize="limit"]');await page.$eval('#maxWidth',e=>e.value='');await page.$eval('#maxHeight',e=>e.value='');await page.click('#processBtn');await page.waitForFunction(()=>window.PixelQuotaTest.state.results.every(r=>r?.metTarget)&&!document.querySelector('#processBtn').classList.contains('busy'),{timeout:30000});await page.evaluate(()=>window.PixelQuotaTest.selectResult(0,false));
await page.setViewport({width:1440,height:1050,deviceScaleFactor:1});
for(const locale of ['en','zh-TW']){await page.select('#languageSelect',locale);await new Promise(r=>setTimeout(r,80));const heroLine=await page.evaluate(()=>{const el=document.querySelector('#heroTitle');const range=document.createRange();range.selectNodeContents(el);return{rects:range.getClientRects().length,scroll:el.scrollWidth,client:el.clientWidth,whiteSpace:getComputedStyle(el).whiteSpace,text:el.textContent}});if(heroLine.rects!==1||heroLine.scroll>heroLine.client+2||heroLine.whiteSpace!=='nowrap')throw new Error(`desktop hero must stay on one line ${locale} ${JSON.stringify(heroLine)}`);}
await page.select('#languageSelect','zh-TW');await page.setViewport({width:1440,height:1050,deviceScaleFactor:1});await page.screenshot({path:path.join(artifacts,'desktop-zh-v1.3.1.png'),fullPage:true});await page.setViewport({width:390,height:844,deviceScaleFactor:1});await page.screenshot({path:path.join(artifacts,'mobile-zh-v1.3.1.png'),fullPage:true});
await page.select('#languageSelect','en');await page.setViewport({width:1440,height:1050,deviceScaleFactor:1});await page.screenshot({path:path.join(artifacts,'desktop-en-v1.3.1.png'),fullPage:true});await page.setViewport({width:390,height:844,deviceScaleFactor:1});await page.screenshot({path:path.join(artifacts,'mobile-en-v1.3.1.png'),fullPage:true});
if(errors.length)throw new Error(`browser errors: ${errors.join(' | ')}`);
console.log(JSON.stringify({ok:true,directFile:true,translations:{zh,commonZh,enAfter},custom,first,compareFirst,compareDrag,repeated,changed,switched,zhFail,downloads:downloaded,layouts,typography,screenshots:['tests/artifacts/desktop-zh-v1.3.1.png','tests/artifacts/mobile-zh-v1.3.1.png','tests/artifacts/desktop-en-v1.3.1.png','tests/artifacts/mobile-en-v1.3.1.png']},null,2));
await browser.close();
