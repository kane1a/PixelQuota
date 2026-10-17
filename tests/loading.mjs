import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const expectedVersion=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const root=path.resolve(process.env.PIXELQUOTA_LOADING_TEST_DIST||'dist');
const out=path.resolve(process.env.PIXELQUOTA_LOADING_TEST_OUT||path.join(os.tmpdir(),`pixelquota-loading-${process.pid}-${Date.now()}`));
fs.mkdirSync(out,{recursive:true});
const assertFile=file=>assert.ok(fs.existsSync(path.join(root,file)),`missing ${file} in ${root}`);
const htmlPath=path.join(root,'index.html');
assertFile('index.html');assertFile('PixelQuota.html');assertFile('privacy.html');assertFile('licenses');
const html=fs.readFileSync(htmlPath,'utf8');
assert.ok(Buffer.byteLength(html)<200_000,`online HTML too large: ${Buffer.byteLength(html)} bytes`);
assert.ok(html.includes(`name="application-version" content="${expectedVersion}"`),'version metadata missing');
assert.doesNotMatch(html,/data:application\/(?:wasm|octet-stream)/i,'inline wasm in online HTML');
assert.doesNotMatch(html,/avif_enc\.wasm|avifEncoderFactory/i,'inline AVIF codec in online HTML');
const assetTags=[...html.matchAll(/(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g)].map(m=>m[1]);
assert.ok(assetTags.length>=2,'online HTML must reference external JS and CSS assets');
const allFiles=[];const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else allFiles.push(file);}};walk(path.join(root,'assets'));
assert.ok(allFiles.some(file=>/\.js$/i.test(file)),'online JS module graph missing');
assert.ok(allFiles.some(file=>/\.css$/i.test(file)),'online CSS missing');
const graph=allFiles.filter(file=>/\.js$/i.test(file)).map(file=>fs.readFileSync(file,'utf8')).join('\n');
assert.match(graph,/import\(/,'online graph must contain dynamic imports');
assert.ok(!html.includes('data:application/wasm'),'heavy codec must not be inline in shell');

const pngPath=path.join(out,'fixture.png');
const chromeCandidates=[process.env.CHROME_PATH,process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':null,process.platform==='win32'?'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe':null,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean);
const chrome=chromeCandidates.find(candidate=>fs.existsSync(candidate));
assert.ok(chrome,'Chrome/Chromium not found; set CHROME_PATH');
const browser=await puppeteer.launch({headless:true,executablePath:chrome,userDataDir:path.join(out,'profile'),args:['--no-sandbox','--allow-file-access-from-files']});
const observations={requests:[],pageErrors:[],consoleErrors:[],timings:{},onlineHtmlBytes:Buffer.byteLength(html),assetTags};
let server;
let activeRetryFault=null;
try{
  const fixturePage=await browser.newPage();
  const fixture=await fixturePage.evaluate(async()=>{const c=document.createElement('canvas');c.width=96;c.height=64;const ctx=c.getContext('2d');ctx.fillStyle='#477';ctx.fillRect(0,0,c.width,c.height);const b=await new Promise(resolve=>c.toBlob(resolve,'image/png'));return Array.from(new Uint8Array(await b.arrayBuffer()));});
  await fixturePage.close();fs.writeFileSync(pngPath,Buffer.from(fixture));
  const page=await browser.newPage();
  page.on('request',request=>observations.requests.push(request.url()));
  page.on('pageerror',error=>observations.pageErrors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')observations.consoleErrors.push(message.text());});

  server=http.createServer((req,res)=>{
    let pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
    if(pathname.startsWith('/PixelQuota/'))pathname=pathname.slice('/PixelQuota'.length);
    const retryTarget=activeRetryFault&&(activeRetryFault.kind==='chunk'?/\/avif-codec-[^/]+\.js$/.test(pathname):/\/avif_enc-[^/]+\.wasm$/.test(pathname));
    if(retryTarget){
      const status=activeRetryFault.injected?200:503;
      activeRetryFault.requests.push({pathname,status});
      if(status===503){activeRetryFault.injected=true;activeRetryFault.failedUrl=pathname;res.writeHead(503,{'content-type':'text/plain'});res.end('injected one-shot AVIF network failure');return;}
    }
    const resolved=path.resolve(root,`.${pathname}`);
    if(pathname==='/PixelQuota.html'){
      const body=fs.readFileSync(path.join(root,'PixelQuota.html'));
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(body);return;
    }
    if(resolved!==root&&!resolved.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
    let file=resolved;if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
    if(!fs.existsSync(file)){res.writeHead(404);res.end('not found');return;}
    const ext=path.extname(file).toLowerCase();const type=ext==='.html'?'text/html; charset=utf-8':ext==='.js'?'text/javascript':ext==='.css'?'text/css':ext==='.wasm'?'application/wasm':ext==='.svg'?'image/svg+xml':'application/octet-stream';
    const body=fs.readFileSync(file);res.writeHead(200,{'content-type':type,'content-length':body.length});res.end(body);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  await page.goto(`${origin}/index.html`,{waitUntil:'load',timeout:60000});
  await page.waitForFunction(()=>!!window.PixelQuotaTest&&document.querySelector('#browseBtn')&&document.querySelector('#formatButtons'),{timeout:15000});
  observations.timings.onlineReadyMs=await page.evaluate(()=>performance.now());
  assert.equal(await page.$eval('meta[name="application-version"]',node=>node.content),expectedVersion);
  assert.ok((await page.$eval('#toolModeSwitch [data-tool-mode="compress"]',node=>node.textContent.trim())).length>0,'tool UI did not initialize');
  const earlyRequests=[...observations.requests];
  assert.ok(!earlyRequests.some(url=>/heic-to|tiff|avif.*(?:\.wasm|codec)|\.wasm(?:\?|$)/i.test(url)),`default startup fetched heavy codec: ${earlyRequests.join(', ')}`);
  const initialReady=await page.evaluate(()=>({title:document.title,interactive:!!document.querySelector('#browseBtn')&&!document.querySelector('#browseBtn').disabled,html:performance.getEntriesByType('navigation')[0]?.encodedBodySize||0}));
  assert.ok(initialReady.interactive,'app did not initialize');
  observations.timings.onlineInitial=initialReady;
  const fileInput=await page.$('#fileInput');await fileInput.uploadFile(pngPath);
  await page.waitForFunction(()=>document.querySelectorAll('.result-card').length===1,{timeout:15000});
  const pngRequests=observations.requests.slice(earlyRequests.length);
  assert.ok(!pngRequests.some(url=>/heic-to|tiff|avif.*(?:\.wasm|codec)|\.wasm(?:\?|$)/i.test(url)),`native PNG requested lazy codec: ${pngRequests.join(', ')}`);
  observations.timings.pngReadyMs=await page.evaluate(()=>performance.now());
  observations.retryRecovery=[];
  // ES-module fetch failures remain in the browser's module map; the no-store WASM fetch is retryable in-page.
  for(const kind of ['wasm']){
    const fault={kind,injected:false,requests:[]};activeRetryFault=fault;
    const retryPage=await browser.newPage(),retryPageErrors=[],retryConsoleErrors=[];
    retryPage.on('pageerror',error=>retryPageErrors.push(error.message));
    retryPage.on('console',message=>{if(message.type()==='error')retryConsoleErrors.push({text:message.text(),location:message.location()});});
    const evidence={kind,fault,pageErrors:retryPageErrors,consoleErrors:retryConsoleErrors};observations.retryRecovery.push(evidence);
    try{
      const retryCdp=await retryPage.createCDPSession();await retryCdp.send('Network.enable');await retryCdp.send('Network.setCacheDisabled',{cacheDisabled:true});
      await retryPage.goto(`${origin}/index.html`,{waitUntil:'load',timeout:60000});
      await retryPage.waitForFunction(()=>!!window.PixelQuotaTest&&document.querySelector('#browseBtn'),{timeout:15000});
      const retryInput=await retryPage.$('#fileInput');await retryInput.uploadFile(pngPath);
      await retryPage.waitForFunction(()=>document.querySelectorAll('.result-card').length===1,{timeout:15000});
      await retryPage.click('#compressModeSwitch [data-compress-mode="convert"]');await retryPage.click('#formatButtons [data-format="image/avif"]');
      // Selecting AVIF schedules automatic processing; wait for that first failure rather than queuing a manual run.
      await retryPage.waitForFunction(()=>{const s=window.PixelQuotaTest.state;return !s.busy&&s.errors[0]?.message==='encode_unsupported:image/avif';},{timeout:45000});
      evidence.first=await retryPage.evaluate(()=>({type:window.PixelQuotaTest.state.results[0]?.blob?.type,error:window.PixelQuotaTest.state.errors[0]?.message}));
      assert.equal(evidence.first.error,'encode_unsupported:image/avif',`${kind} injected network fault must fail the first AVIF operation`);
      assert.ok(fault.injected,`${kind} test did not receive its intentional HTTP 503`);
      assert.match(fault.failedUrl,kind==='chunk'?/\/avif-codec-[^/]+\.js$/:/\/avif_enc-[^/]+\.wasm$/);
      assert.equal(fault.requests.filter(request=>request.status===503).length,1,`${kind} must inject exactly one HTTP 503`);
      await new Promise(resolve=>setTimeout(resolve,800));
      assert.equal(fault.requests.length,1,`${kind} automatic failure must remain deduplicated until manual retry`);
      // Functional integration probe of the existing bound manual callback, not physical-UI E2E.
      await retryPage.evaluate(()=>{const state=window.PixelQuotaTest.state,button=document.querySelector('#processBtn');if(!button||state.busy||button.disabled)throw new Error('Manual retry control is unavailable');button.click();});
      await retryPage.waitForFunction(()=>{const s=window.PixelQuotaTest.state;return !s.busy&&(!!s.results[0]||!!s.errors[0]);},{timeout:45000});
      evidence.sameFileRetry=await retryPage.evaluate(async()=>{
        const blob=window.PixelQuotaTest.state.results[0]?.blob;
        return blob?{type:blob.type,size:blob.size,signature:String.fromCharCode(...new Uint8Array(await blob.slice(4,12).arrayBuffer()))}:{error:window.PixelQuotaTest.state.errors[0]?.message};
      });
      assert.equal(evidence.sameFileRetry.type,'image/avif',`${kind} same-file manual retry must succeed without reupload or reload: ${JSON.stringify(evidence.sameFileRetry)}`);
      assert.equal(evidence.sameFileRetry.signature,'ftypavif',`${kind} same-file retry must produce genuine AVIF bytes`);
      assert.ok(evidence.sameFileRetry.size>12,`${kind} same-file retry AVIF output is empty`);
      assert.ok(fault.requests.some(request=>request.pathname===fault.failedUrl&&request.status===200),`${kind} same-file retry did not fetch the recovered resource`);
      await retryInput.uploadFile(pngPath);
      await retryPage.waitForFunction(()=>window.PixelQuotaTest.state.files.length===2&&document.querySelectorAll('.result-card').length===2,{timeout:15000});
      await retryPage.waitForFunction(()=>{const s=window.PixelQuotaTest.state;return !s.busy&&(!!s.results[1]||!!s.errors[1]);},{timeout:45000});
      evidence.retry=await retryPage.evaluate(async()=>{
        const blob=window.PixelQuotaTest.state.results[1]?.blob;
        return blob?{type:blob.type,size:blob.size,signature:String.fromCharCode(...new Uint8Array(await blob.slice(4,12).arrayBuffer()))}:{error:window.PixelQuotaTest.state.errors[1]?.message};
      });
      assert.equal(evidence.retry.type,'image/avif',`${kind} retry must succeed in the same page: ${JSON.stringify(evidence.retry)}`);
      assert.equal(evidence.retry.signature,'ftypavif',`${kind} retry must produce genuine AVIF bytes`);
      assert.ok(evidence.retry.size>12,`${kind} retry AVIF output is empty`);
      assert.ok(fault.requests.some(request=>request.pathname===fault.failedUrl&&request.status===200),`${kind} retry did not fetch the recovered resource`);
      evidence.expectedConsoleErrors=retryConsoleErrors.filter(entry=>{
        if(!fault.failedUrl||!/503|failed to load resource|ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(entry.text))return false;
        try{return new URL(entry.location?.url||'',origin).pathname===fault.failedUrl;}catch{return false;}
      });
      evidence.unexpectedConsoleErrors=retryConsoleErrors.filter(entry=>!evidence.expectedConsoleErrors.includes(entry));
      assert.deepEqual(retryPageErrors,[],`${kind} failure/retry page errors`);
      assert.deepEqual(evidence.unexpectedConsoleErrors,[],`${kind} unexpected console errors`);
    }finally{activeRetryFault=null;await retryPage.close();}
  }
  const mode=await page.evaluate(()=>({active:document.querySelector('#formatButtons [data-format="image/avif"]')?.disabled,hidden:document.querySelector('#formatButtons').hidden}));
  assert.equal(mode.active,false,'AVIF option must remain actionable until used');
  const downloads=path.join(out,'online-downloads');fs.mkdirSync(downloads,{recursive:true});
  const cdp=await page.createCDPSession();await cdp.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await page.click('#compressModeSwitch [data-compress-mode="convert"]');
  await page.click('#formatButtons [data-format="image/avif"]');
  const start=Date.now();await page.evaluate(()=>document.querySelector('#processBtn').click());
  await page.waitForFunction(()=>{const s=window.PixelQuotaTest.state;return !s.busy&&(!!s.results[0]||!!s.errors[0]);},{timeout:45000});
  const onlineResult=await page.evaluate(()=>({type:window.PixelQuotaTest.state.results[0]?.blob?.type,error:window.PixelQuotaTest.state.errors[0]?.message}));
  assert.equal(onlineResult.type,'image/avif',JSON.stringify(onlineResult));
  await page.evaluate(()=>document.querySelector('#downloadCurrentBtn').click());
  const avifFile=await waitForFile(downloads,/\.avif$/i,60000);
  assert.ok(avifFile,`AVIF download did not complete; files=${fs.readdirSync(downloads).join(',')}`);
  const avifBytes=fs.readFileSync(avifFile);assert.equal(avifBytes.subarray(4,12).toString('ascii'),'ftypavif','AVIF output signature');
  observations.timings.avifOutput={elapsedMs:Date.now()-start,bytes:avifBytes.length,file:path.basename(avifFile),signature:avifBytes.subarray(4,12).toString('ascii')};
  assert.ok(observations.requests.some(url=>/avif|chunks/i.test(url)),`AVIF codec chunk was not requested: ${observations.requests.join(', ')}`);
  assert.deepEqual(observations.pageErrors,[],'page errors');
  assert.deepEqual(observations.consoleErrors,[],'console errors');
  const loadedCodecs=observations.requests.filter(url=>/avif-codec|avif_enc/.test(url)).length;
  await page.evaluate(()=>document.querySelector('#processBtn').click());
  await page.waitForFunction(()=>!window.PixelQuotaTest.state.busy,{timeout:45000});
  assert.equal(observations.requests.filter(url=>/avif-codec|avif_enc/.test(url)).length,loadedCodecs,'repeat use must reuse the in-memory codec');
  assert.equal(await page.evaluate(()=>window.PixelQuotaTest.state.lastSkipped),1,'an already-current successful item must remain skipped');
  await page.reload({waitUntil:'load',timeout:60000});
  await page.waitForFunction(()=>!!window.PixelQuotaTest);
  observations.timings.reloadMs=await page.evaluate(()=>performance.now());
  assert.ok(observations.timings.reloadMs<15000,'normal reload did not complete');
  await page.goto(`${origin}/compress-image-to-50kb/`,{waitUntil:'load',timeout:30000});
  assert.equal(new URL(page.url()).pathname,'/compress-image-to-50kb/');
  await page.waitForFunction(()=>!!window.PixelQuotaTest,{timeout:15000});
  assert.ok(await page.$('meta[name="application-version"]'),'nested route did not load external shell');
  await page.goto(`${origin}/PixelQuota/index.html`,{waitUntil:'load',timeout:30000});
  assert.equal(new URL(page.url()).pathname,'/PixelQuota/index.html','prefixed index route should load');
  await page.waitForFunction(()=>!!window.PixelQuotaTest,{timeout:15000});
  await page.goto(`${origin}/PixelQuota/compress-image-to-50kb/`,{waitUntil:'load',timeout:30000});
  assert.equal(new URL(page.url()).pathname,'/PixelQuota/compress-image-to-50kb/','prefixed nested route should load');
  await page.waitForFunction(()=>!!window.PixelQuotaTest,{timeout:15000});
  const alias=await browser.newPage();await alias.goto(`${origin}/PixelQuota.html`,{waitUntil:'load',timeout:30000});
  assert.equal(new URL(alias.url()).pathname,'/index.html','legacy HTTP alias should redirect to online shell');
  await alias.close();
  await page.goto(`${origin}/PixelQuota/PixelQuota.html`,{waitUntil:'load',timeout:30000});
  assert.equal(new URL(page.url()).pathname,'/PixelQuota/index.html','prefixed legacy alias should redirect to the prefixed online shell');
  await page.waitForFunction(()=>!!window.PixelQuotaTest,{timeout:15000});
  const standalone=await browser.newPage();
  const standaloneRequests=[];standalone.on('request',request=>standaloneRequests.push(request.url()));
  const standaloneErrors=[];standalone.on('pageerror',error=>standaloneErrors.push(error.message));
  const standaloneConsoleErrors=[];standalone.on('console',message=>{if(message.type()==='error')standaloneConsoleErrors.push(message.text());});
  await standalone.setRequestInterception(true);
  standalone.on('request',request=>/^https?:/i.test(request.url())?request.abort():request.continue());
  await standalone.goto(pathToFileURL(path.join(root,'PixelQuota.html')).href,{waitUntil:'load',timeout:60000});
  await standalone.waitForFunction(()=>!!window.PixelQuotaTest&&document.querySelector('#browseBtn'),{timeout:15000});
  const standaloneInput=await standalone.$('#fileInput');await standaloneInput.uploadFile(pngPath);
  await standalone.waitForFunction(()=>document.querySelectorAll('.result-card').length===1,{timeout:15000});
  const standaloneDownloads=path.join(out,'standalone-downloads');fs.mkdirSync(standaloneDownloads,{recursive:true});
  const standaloneCdp=await standalone.createCDPSession();await standaloneCdp.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:standaloneDownloads});
  await standalone.click('#compressModeSwitch [data-compress-mode="convert"]');await standalone.click('#formatButtons [data-format="image/avif"]');
  await standalone.evaluate(()=>document.querySelector('#processBtn').click());
  await standalone.waitForFunction(()=>{const s=window.PixelQuotaTest.state;return !s.busy&&(!!s.results[0]||!!s.errors[0]);},{timeout:45000});
  const standaloneResult=await standalone.evaluate(()=>({type:window.PixelQuotaTest.state.results[0]?.blob?.type,error:window.PixelQuotaTest.state.errors[0]?.message}));
  assert.equal(standaloneResult.type,'image/avif',JSON.stringify(standaloneResult));
  await standalone.evaluate(()=>document.querySelector('#downloadCurrentBtn').click());
  const standaloneAvif=await waitForFile(standaloneDownloads,/\.avif$/i,60000);
  assert.ok(standaloneAvif,'standalone AVIF export did not complete');
  assert.equal(fs.readFileSync(standaloneAvif).subarray(4,12).toString('ascii'),'ftypavif','standalone AVIF signature');
  assert.equal(standaloneRequests.filter(url=>/^https?:/i.test(url)).length,0,'standalone file:// must not request network resources');
  observations.standaloneRequests=standaloneRequests;
  observations.standaloneReadyMs=await standalone.evaluate(()=>performance.now());
  observations.timings.standaloneAvif={file:path.basename(standaloneAvif),bytes:fs.statSync(standaloneAvif).size,signature:fs.readFileSync(standaloneAvif).subarray(4,12).toString('ascii')};
  assert.deepEqual(standaloneErrors,[],'standalone page errors');
  observations.standaloneConsoleErrors=standaloneConsoleErrors;
  assert.deepEqual(standaloneConsoleErrors,[],'standalone console errors');
  observations.standalonePageErrors=standaloneErrors;
  assert.deepEqual(observations.pageErrors,[],'online page errors after reload and prefixed routes');
  assert.deepEqual(observations.consoleErrors,[],'online console errors after reload and prefixed routes');
  await standalone.close();
  fs.writeFileSync(path.join(out,'loading-observations.json'),JSON.stringify(observations,null,2));
  console.log(JSON.stringify({pass:true,root,out,observations},null,2));
} catch(error) {
  observations.failed=true;observations.error={message:error.message,stack:error.stack};
  fs.writeFileSync(path.join(out,'loading-observations.json'),JSON.stringify(observations,null,2));
  throw error;
} finally {await browser.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}

async function waitForFile(dir,pattern,timeout){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const file=fs.readdirSync(dir).find(name=>pattern.test(name)&&!name.endsWith('.crdownload'));if(file)return path.join(dir,file);await new Promise(resolve=>setTimeout(resolve,150));}
  return null;
}
