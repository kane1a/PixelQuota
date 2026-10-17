import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const source=path.resolve(process.argv[2]||'public/privacy.html');
const chrome=[process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>p&&fs.existsSync(p));
if(!chrome)throw new Error('Chrome/Chromium not found; set CHROME_PATH');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pixelquota-privacy-'));
const checks=[],errors=[],requests=[];
const check=(name,pass,detail=null)=>checks.push({name,pass:!!pass,...(pass?{}:{detail})});
const browser=await puppeteer.launch({executablePath:chrome,headless:true,userDataDir:profile,args:process.env.CI?['--no-sandbox']:[]});
try{
 const page=await browser.newPage();page.setDefaultTimeout(5000);
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
 await page.evaluateOnNewDocument(()=>{window.__storageCalls=[];for(const method of['getItem','setItem','removeItem','clear']){const fn=Storage.prototype[method];Storage.prototype[method]=function(...args){window.__storageCalls.push({method,key:args[0]});return fn.apply(this,args);};}});
 await page.goto(pathToFileURL(source).href,{waitUntil:'load'});await page.waitForSelector('#content h1');
 const initial=await page.evaluate(()=>document.documentElement.lang);
 check('standalone_home_link',await page.$eval('.brand',e=>new URL(e.href).pathname.endsWith('/PixelQuota.html')));
 const labels={en:'Language','zh-TW':'語言','zh-CN':'语言',ja:'言語',ko:'언어'},runtime={en:'runtime','zh-TW':'執行階段','zh-CN':'运行时',ja:'ランタイム',ko:'런타임'};
 for(const width of[1440,768,390]){
  await page.setViewport({width,height:1000,hasTouch:width<980});
  for(const locale of Object.keys(labels)){
   await page.evaluate(()=>scrollTo(0,0));await page.click('#langToggle');await page.click(`#langOptions [data-locale="${locale}"]`);
   const selected=await page.evaluate(()=>({locale:document.documentElement.lang,closed:document.querySelector('#langOptions').hidden,focus:document.activeElement.id,storage:window.__storageCalls}));
   check(`locale_${width}_${locale}`,selected.locale===locale&&selected.closed&&selected.focus==='langToggle',selected);
   check(`accessible_label_${width}_${locale}`,await page.$eval('#langToggle',(e,s)=>e.getAttribute('aria-label')===s,labels[locale]));
   check(`runtime_disclosed_${width}_${locale}`,await page.$eval('#content',(e,s)=>e.textContent.includes(s),runtime[locale]));
   await page.click('#langToggle');
   const geometry=await page.evaluate(()=>{
    const menu=document.querySelector('#langOptions'),rect=menu.getBoundingClientRect(),controls=[document.querySelector('#langToggle'),...menu.querySelectorAll('button')];
    const hit=e=>{const r=e.getBoundingClientRect(),t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>=40&&r.height>=40&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&!!t&&(t===e||e.contains(t));};
    const font=[...document.querySelectorAll('a,button,h1,h2,p,span')].filter(e=>e.getClientRects().length&&e.textContent.trim()).map(e=>parseFloat(getComputedStyle(e).fontSize));
    return{overflow:document.documentElement.scrollWidth>innerWidth,inside:rect.x>=0&&rect.right<=innerWidth&&rect.y>=0&&rect.bottom<=innerHeight,hit:controls.every(hit),minFont:Math.min(...font),radii:[document.querySelector('main'),menu,menu.querySelector('button')].map(e=>parseFloat(getComputedStyle(e).borderRadius))};
   });
   check(`geometry_${width}_${locale}`,!geometry.overflow&&geometry.inside&&geometry.hit&&geometry.minFont>=(width<980?13:12)&&geometry.radii.join(',')==='12,12,8',geometry);
   await page.keyboard.press('Escape');check(`escape_${width}_${locale}`,await page.evaluate(()=>document.querySelector('#langOptions').hidden&&document.activeElement.id==='langToggle'));
   await page.click('#langToggle');await page.click('#content h1');check(`outside_${width}_${locale}`,await page.evaluate(()=>document.querySelector('#langOptions').hidden&&document.activeElement.id==='langToggle'));
  }
 }
 await page.reload({waitUntil:'load'});check('reload_uses_browser_language',await page.evaluate(()=>document.documentElement.lang)===initial);
 check('no_storage_calls',await page.evaluate(()=>window.__storageCalls.length===0));check('no_external_requests',requests.length===0,requests);check('no_page_errors',errors.length===0,errors);
}catch(e){check('browser_execution',false,{message:e.message,stack:e.stack});}
finally{await browser.close();}
const failed=checks.filter(c=>!c.pass);console.log(JSON.stringify({ok:!failed.length,source,checks:checks.length,failed,errors,requests,profile:failed.length?profile:undefined},null,2));
if(!failed.length)fs.rmSync(profile,{recursive:true});process.exitCode=failed.length?1:0;
