import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root=process.cwd();
const dist=path.join(root,'dist');
const assets=path.join(dist,'assets');
const {version}=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8').replace(/^\uFEFF/,''));
fs.rmSync(dist,{recursive:true,force:true});
fs.mkdirSync(assets,{recursive:true});

await build({
  entryPoints:[path.join(root,'src','main.js')],
  bundle:true,
  minify:true,
  format:'esm',
  platform:'browser',
  target:['es2020'],
  loader:{'.wasm':'binary'},
  outfile:path.join(assets,'app.js'),
  logLevel:'info'
});

for(const name of fs.readdirSync(path.join(root,'public'))){
  const src=path.join(root,'public',name);
  const dst=path.join(dist,name);
  fs.cpSync(src,dst,{recursive:true});
}

let html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const js=fs.readFileSync(path.join(assets,'app.js'),'utf8').replace(/<\/script/gi,'<\\/script');
const cssPath=path.join(assets,'app.css');
const css=fs.existsSync(cssPath)?fs.readFileSync(cssPath,'utf8'):'';
const configPath=path.join(dist,'config.js');
const config=fs.existsSync(configPath)?fs.readFileSync(configPath,'utf8').replace(/<\/script/gi,'<\\/script'):'';

if(css) html=html.replace('</head>',()=>`<style>${css}</style>\n</head>`);
html=html.replace(/<script src="\.\/config\.js"><\/script>/,()=>config?`<script>${config}</script>`:'');
html=html.replace(/<script type="module" src="\/src\/main\.js"><\/script>/,()=>`<script type="module">${js}</script>`);

fs.writeFileSync(path.join(dist,'index.html'),html);
fs.writeFileSync(path.join(dist,'PixelQuota.html'),html);
fs.writeFileSync(path.join(dist,'START-HERE.txt'),`PixelQuota ${version}\r\n\r\n直接雙擊 PixelQuota.html 即可使用，不需要安裝、不需要終端機。\r\nDouble-click PixelQuota.html to use the app. No install or local server required.\r\n`);

const pages=[
  ['compress-image-to-20kb','Compress Image to 20KB - PixelQuota','Compress JPG, PNG, WebP, AVIF, or HEIC under 20KB in your browser. No upload, no account, no watermark.'],
  ['compress-image-to-50kb','Compress Image to 50KB - PixelQuota','Compress any image under 50KB with the highest quality that fits. Private browser processing.'],
  ['compress-image-to-100kb','Compress Image to 100KB - PixelQuota','Make an image fit a 100KB upload limit without guessing quality sliders. Private and free.'],
  ['compress-image-to-200kb','Compress Image to 200KB - PixelQuota','Compress photos under 200KB for forms, applications, and uploads. Runs locally in your browser.'],
  ['compress-image-to-500kb','Compress Image to 500KB - PixelQuota','Reduce any image under 500KB while keeping as much quality as possible. No upload required.'],
  ['compress-image-to-1mb','Compress Image to 1MB - PixelQuota','Compress images under 1MB, resize, convert formats, and download privately in your browser.'],
  ['heic-to-jpg','HEIC to JPG Converter - PixelQuota','Convert iPhone HEIC and HEIF photos to JPG locally, with an optional KB limit and resize in the same pass.']
];
function nestedLinks(source){return source.replaceAll('href="./index.html"','href="../index.html"').replaceAll('href="./privacy.html"','href="../privacy.html"');}
for(const [slug,title,description] of pages){
  let page=nestedLinks(html).replace(/<title>.*?<\/title>/,`<title>${title}</title>`).replace(/<meta name="description" content="[^"]*"\s*\/>/,`<meta name="description" content="${description}" />`);
  const dir=path.join(dist,slug);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'index.html'),page);
}
fs.mkdirSync(path.join(dist,'tools'),{recursive:true});
fs.writeFileSync(path.join(dist,'tools','index.html'),nestedLinks(html).replace(/<title>.*?<\/title>/,'<title>Free Image Tools - PixelQuota</title>'));
fs.writeFileSync(path.join(dist,'robots.txt'),'User-agent: *\nAllow: /\n');
fs.rmSync(assets,{recursive:true,force:true});
if(fs.existsSync(configPath)) fs.rmSync(configPath,{force:true});
console.log('PixelQuota production build ready:',path.join(dist,'PixelQuota.html'));
