import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const candidates=[
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome','/usr/bin/chromium'
].filter(Boolean).filter(fs.existsSync);
if(!candidates.length)throw new Error('Chrome/Chromium not found');

const root=path.resolve('.'),out=path.join(root,'docs','images'),fixture=path.join(root,'tests','fixture.jpg');
fs.mkdirSync(out,{recursive:true});
const browser=await puppeteer.launch({headless:true,executablePath:candidates[0],args:['--no-sandbox','--allow-file-access-from-files']});
const page=await browser.newPage();page.setDefaultTimeout(60000);await page.setViewport({width:1440,height:1050,deviceScaleFactor:1});
const appUrl='file:///'+path.join(root,'dist','PixelQuota.html').replace(/\\/g,'/');

async function loadLocale(locale){
  await page.goto(appUrl,{waitUntil:'load'});await page.waitForFunction(()=>!!window.PixelQuotaTest);
  await page.evaluate(l=>localStorage.setItem('pixelquota_lang',l),locale);await page.reload({waitUntil:'load'});await page.waitForFunction(()=>!!window.PixelQuotaTest);
}
async function addFixture(){
  const chooserPromise=page.waitForFileChooser();await page.click('#browseBtn');const chooser=await chooserPromise;await chooser.accept([fixture]);await page.waitForFunction(()=>window.PixelQuotaTest.state.files.length===1);
}
async function shotElement(selector,filename){
  const el=await page.$(selector);if(!el)throw new Error(`missing ${selector}`);await el.screenshot({path:path.join(out,filename)});
}
async function workspace(locale,filename){
  await loadLocale(locale);await addFixture();await page.click('#processBtn');await page.waitForFunction(()=>window.PixelQuotaTest.state.results.some(Boolean)&&!document.querySelector('#processBtn').classList.contains('busy'),{timeout:45000});await shotElement('#app',filename);
}
async function installAiAdapter(){
  await page.evaluate(()=>{
    const adapter={
      async load(cb){cb?.({status:'loading',progress:55,message:'model_fp16.onnx'});await new Promise(r=>setTimeout(r,80));return adapter;},
      async infer(file,onProgress=()=>{}){onProgress(70);const bitmap=await createImageBitmap(file),sourceWidth=bitmap.width,sourceHeight=bitmap.height,width=96,height=96,data=new Uint8Array(width*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const nx=(x-width*.53)/(width*.34),ny=(y-height*.5)/(height*.45),d=Math.sqrt(nx*nx+ny*ny),hair=Math.sin(x*.9+y*.25)*.07;data[y*width+x]=Math.max(0,Math.min(255,Math.round((1.16-d+hair)*460)));}bitmap.close();onProgress(96);return{width,height,channels:1,data,sourceWidth,sourceHeight};}
    };window.__PIXELQUOTA_AI_ADAPTER__=adapter;
  });
}
async function background(locale,aiFile,inspectFile){
  await loadLocale(locale);await installAiAdapter();await page.click('#toolModeSwitch [data-tool-mode="remove-bg"]');await addFixture();await page.click('#bgEngineSwitch [data-bg-engine="ai"]');await page.click('#bgLoadModel');await page.waitForFunction(()=>window.PixelQuotaTest.getBackgroundAIState().ready&&window.PixelQuotaTest.state.bgPreviewMeta?.engine==='ai'&&!document.querySelector('#backgroundPreviewCanvas').hidden,{timeout:45000});
  await shotElement('#app',aiFile);
  await page.evaluate(()=>window.PixelQuotaTest.openBackgroundInspector());await page.waitForFunction(()=>!document.querySelector('#backgroundInspectModal').hidden&&document.querySelector('#backgroundInspectBusy').hidden&&document.querySelector('#backgroundInspectCanvas').width>1,{timeout:15000});await page.evaluate(()=>window.PixelQuotaTest.setBackgroundInspectorZoom(2));await shotElement('.edge-inspect-shell',inspectFile);await page.click('#backgroundInspectClose');
}

await workspace('en','workspace.png');
await workspace('zh-TW','workspace-zh.png');
await background('en','background-ai.png','background-edge-inspector.png');
await background('zh-TW','background-ai-zh.png','background-edge-inspector-zh.png');

async function marketingCard(filename,width,height,locale='en'){
  const screenshot=fs.readFileSync(path.join(out,locale==='zh-TW'?'workspace-zh.png':'workspace.png')).toString('base64');
  const zh=locale==='zh-TW',title=zh?'私密圖片工具，直接在瀏覽器裡完成。':'Private image tools. Right in your browser.',sub=zh?'壓縮・轉檔・浮水印・敏感遮蔽・社群裁切・AI 去背':'Compress · Convert · Watermark · Redact · Social Crop · AI Background Removal',badge=zh?'圖片不上傳':'NO IMAGE UPLOAD';
  await page.setViewport({width,height,deviceScaleFactor:1});
  await page.setContent(`<!doctype html><style>*{box-sizing:border-box}body{margin:0;width:${width}px;height:${height}px;overflow:hidden;font-family:Inter,Arial,sans-serif;background:radial-gradient(circle at 82% 10%,#dceaff 0,transparent 38%),linear-gradient(135deg,#f8fbff,#eef4ff);color:#17233d}.wrap{height:100%;padding:${Math.round(height*.09)}px ${Math.round(width*.07)}px;display:grid;grid-template-columns:.9fr 1.1fr;align-items:center;gap:${Math.round(width*.045)}px}.brand{display:flex;align-items:center;gap:13px;font-weight:900;font-size:${Math.round(height*.045)}px}.logo{width:${Math.round(height*.075)}px;height:${Math.round(height*.075)}px;border-radius:14px;background:#1f7cff;position:relative;box-shadow:0 12px 28px #1f7cff38}.logo:before{content:'';position:absolute;left:22%;right:22%;bottom:25%;height:30%;background:#fff;clip-path:polygon(0 100%,35% 20%,55% 62%,72% 10%,100% 100%)}.copy h1{font-size:${Math.round(height*.083)}px;line-height:1.02;letter-spacing:-.055em;margin:${Math.round(height*.06)}px 0 ${Math.round(height*.03)}px;max-width:620px}.copy p{font-size:${Math.round(height*.028)}px;line-height:1.5;color:#627493;margin:0;max-width:650px}.badge{display:inline-flex;margin-top:${Math.round(height*.045)}px;padding:10px 15px;border-radius:999px;background:#e4f8ec;color:#168a57;font-size:${Math.round(height*.018)}px;font-weight:900;letter-spacing:.08em}.shot{position:relative}.shot:before{content:'';position:absolute;inset:8% -3% -6% 7%;border-radius:28px;background:#9ab9ef3b;filter:blur(24px)}.shot img{position:relative;display:block;width:100%;max-height:${Math.round(height*.76)}px;object-fit:cover;object-position:top;border:1px solid #cadbf6;border-radius:22px;box-shadow:0 25px 70px #233c6d28}</style><div class="wrap"><div class="copy"><div class="brand"><span class="logo"></span><span>Pixel<span style="color:#1f7cff">Quota</span></span></div><h1>${title}</h1><p>${sub}</p><span class="badge">◆ ${badge}</span></div><div class="shot"><img src="data:image/png;base64,${screenshot}"></div></div>`,{waitUntil:'load'});await page.screenshot({path:path.join(out,filename)});
}
await marketingCard('social-preview.png',1280,640,'en');
await marketingCard('release-v1.4.0.png',1600,900,'en');

await browser.close();
console.log('release screenshots ready',fs.readdirSync(out).filter(x=>/workspace|background-|social-preview|release-v1\.4\.0/.test(x)));
