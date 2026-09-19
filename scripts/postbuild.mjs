import fs from 'node:fs';
import path from 'node:path';

const dist=path.resolve('dist');
const indexPath=path.join(dist,'index.html');
const {version}=JSON.parse(fs.readFileSync(path.resolve('package.json'),'utf8').replace(/^\uFEFF/,''));
let html=fs.readFileSync(indexPath,'utf8');
const fileFromHref=ref=>path.join(dist,ref.replace(/^\.\//,'').replace(/^\//,''));
const cssTag=html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
if(!cssTag) throw new Error('Built CSS tag not found');
html=html.replace(cssTag[0],()=>`<style>${fs.readFileSync(fileFromHref(cssTag[1]),'utf8')}</style>`);
const scriptTag=html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/);
if(!scriptTag) throw new Error('Built JS tag not found');
const js=fs.readFileSync(fileFromHref(scriptTag[1]),'utf8').replace(/<\/script/gi,'<\\/script');
html=html.replace(scriptTag[0],()=>`<script type="module">${js}</script>`);
const configPath=path.join(dist,'config.js');
if(fs.existsSync(configPath)){const config=fs.readFileSync(configPath,'utf8').replace(/<\/script/gi,'<\\/script');html=html.replace(/<script src="\.\/config\.js"><\/script>/,()=>`<script>${config}</script>`);}
fs.writeFileSync(indexPath,html); fs.writeFileSync(path.join(dist,'PixelQuota.html'),html);
fs.writeFileSync(path.join(dist,'START-HERE.txt'),`PixelQuota ${version}\r\n\r\n直接雙擊 PixelQuota.html 即可使用，不需要安裝、不需要終端機。\r\nDouble-click PixelQuota.html to use the app. No install or local server required.\r\n`);
const pages=[['compress-image-to-20kb','Compress Image to 20KB - PixelQuota','Compress JPG, PNG, WebP, AVIF, or HEIC under 20KB in your browser. No upload, no account, no watermark.'],['compress-image-to-50kb','Compress Image to 50KB - PixelQuota','Compress any image under 50KB with the highest quality that fits. Private browser processing.'],['compress-image-to-100kb','Compress Image to 100KB - PixelQuota','Make an image fit a 100KB upload limit without guessing quality sliders. Private and free.'],['compress-image-to-200kb','Compress Image to 200KB - PixelQuota','Compress photos under 200KB for forms, applications, and uploads. Runs locally in your browser.'],['compress-image-to-500kb','Compress Image to 500KB - PixelQuota','Reduce any image under 500KB while keeping as much quality as possible. No upload required.'],['compress-image-to-1mb','Compress Image to 1MB - PixelQuota','Compress images under 1MB, resize, convert formats, and download privately in your browser.'],['heic-to-jpg','HEIC to JPG Converter - PixelQuota','Convert iPhone HEIC and HEIF photos to JPG locally, with an optional KB limit and resize in the same pass.']];
function nestedLinks(source){return source.replaceAll('href="./index.html"','href="../index.html"').replaceAll('href="./privacy.html"','href="../privacy.html"').replaceAll('href="./tools/index.html"','href="../tools/index.html"').replaceAll('href="./compress-image-to-','href="../compress-image-to-');}
for(const [slug,title,description] of pages){let page=nestedLinks(html).replace(/<title>.*?<\/title>/,`<title>${title}</title>`).replace(/<meta name="description" content="[^"]*"\s*\/>/,`<meta name="description" content="${description}" />`);const dir=path.join(dist,slug);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'index.html'),page);}
fs.mkdirSync(path.join(dist,'tools'),{recursive:true});fs.writeFileSync(path.join(dist,'tools','index.html'),nestedLinks(html).replace(/<title>.*?<\/title>/,'<title>Free Image Tools - PixelQuota</title>'));fs.writeFileSync(path.join(dist,'robots.txt'),'User-agent: *\nAllow: /\n');
const assetsDir=path.join(dist,'assets'); if(fs.existsSync(assetsDir)) fs.rmSync(assetsDir,{recursive:true,force:true}); if(fs.existsSync(configPath)) fs.rmSync(configPath,{force:true});
