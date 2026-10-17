import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root=process.cwd();
const dist=path.join(root,'dist');
const assets=path.join(dist,'assets');
const {version}=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8').replace(/^\uFEFF/,''));
fs.rmSync(dist,{recursive:true,force:true});
fs.mkdirSync(assets,{recursive:true});

const inlineWorkerPlugin={
  name:'inline-workers',
  setup(api){
    api.onResolve({filter:/\?worker&inline$/},args=>({
      path:path.resolve(args.resolveDir,args.path.replace(/\?worker&inline$/,'')), namespace:'inline-worker'
    }));
    api.onLoad({filter:/.*/,namespace:'inline-worker'},async({path:workerPath})=>{
      const {outputFiles}=await build({entryPoints:[workerPath],bundle:true,minify:true,write:false,
        format:'iife',platform:'browser',target:['es2020'],logLevel:'silent'});
      return{loader:'js',contents:`const source=${JSON.stringify(outputFiles[0].text)};
        export default function InlineWorker(){
          const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
          try{return new Worker(url);}finally{URL.revokeObjectURL(url);}
        }`};
    });
  }
};

const common={plugins:[inlineWorkerPlugin],bundle:true,minify:true,format:'esm',platform:'browser',target:['es2020'],logLevel:'info'};
const online=await build({...common,entryPoints:[path.join(root,'src','main.js')],outdir:assets,
  splitting:true,entryNames:'app-[hash]',chunkNames:'chunks/[name]-[hash]',assetNames:'chunks/[name]-[hash]',
  loader:{'.wasm':'file'},metafile:true});
const entryOutput=Object.entries(online.metafile.outputs).find(([,meta])=>meta.entryPoint?.endsWith('src/main.js'))?.[0];
if(!entryOutput)throw new Error('Unable to locate online main entry output');
const jsUrl=`./assets/${path.relative(assets,path.resolve(entryOutput)).replaceAll(path.sep,'/')}`;
const cssOutput=online.metafile.outputs[entryOutput].cssBundle;
if(!cssOutput)throw new Error('Online build did not emit CSS');
const cssUrl=`./assets/${path.relative(assets,path.resolve(cssOutput)).replaceAll(path.sep,'/')}`;

const standalone=await build({...common,entryPoints:[path.join(root,'src','main.js')],outfile:path.join(assets,'standalone.js'),
  splitting:false,loader:{'.wasm':'binary'},metafile:true});
const standaloneCss=standalone.metafile.outputs[path.relative(root,path.join(assets,'standalone.js')).replaceAll(path.sep,'/')]?.cssBundle;
const standaloneCssPath=standaloneCss?path.resolve(root,standaloneCss):path.join(assets,'standalone.css');
const sourceHtml=fs.readFileSync(path.join(root,'index.html'),'utf8');
const configPath=path.join(root,'public','config.js');
const config=fs.existsSync(configPath)?fs.readFileSync(configPath,'utf8').replace(/<\/script/gi,'<\\/script'):'';
const addMeta=html=>html.replace('</head>',()=>`<meta name="application-version" content="${version}">\n</head>`);
const nestedLinks=source=>source.replaceAll('href="./index.html"','href="../index.html"').replaceAll('href="./privacy.html"','href="../privacy.html"').replaceAll('src="./assets/','src="../assets/').replaceAll('href="./assets/','href="../assets/');
const pages=[
  ['compress-image-to-20kb','Compress Image to 20KB - PixelQuota','Compress JPG, PNG, WebP, AVIF, or HEIC under 20KB in your browser. No upload, no account, no watermark.'],
  ['compress-image-to-50kb','Compress Image to 50KB - PixelQuota','Compress any image under 50KB with the highest quality that fits. Private browser processing.'],
  ['compress-image-to-100kb','Compress Image to 100KB - PixelQuota','Make an image fit a 100KB upload limit without guessing quality sliders. Private and free.'],
  ['compress-image-to-200kb','Compress Image to 200KB - PixelQuota','Compress photos under 200KB for forms, applications, and uploads. Runs locally in your browser.'],
  ['compress-image-to-500kb','Compress Image to 500KB - PixelQuota','Reduce any image under 500KB while keeping as much quality as possible. No upload required.'],
  ['compress-image-to-1mb','Compress Image to 1MB - PixelQuota','Compress images under 1MB, resize, convert formats, and download privately in your browser.'],
  ['heic-to-jpg','HEIC to JPG Converter - PixelQuota','Convert iPhone HEIC and HEIF photos to JPG locally, with an optional KB limit and resize in the same pass.']
];

for(const name of fs.readdirSync(path.join(root,'public'))){
  fs.cpSync(path.join(root,'public',name),path.join(dist,name),{recursive:true});
}
let shell=addMeta(sourceHtml);
shell=shell.replace(/<script src="\.\/config\.js"><\/script>/,()=>config?`<script>${config}</script>`:'');
shell=shell.replace(/<script type="module" src="\/src\/main\.js"><\/script>/,()=>`<script type="module" src="${jsUrl}"></script>`);
shell=shell.replace('</head>',()=>`<link rel="stylesheet" href="${cssUrl}">\n</head>`);
fs.writeFileSync(path.join(dist,'index.html'),shell);
for(const [slug,title,description] of pages){
  const page=nestedLinks(shell).replace(/<title>.*?<\/title>/,`<title>${title}</title>`).replace(/<meta name="description" content="[^"]*"\s*\/>/,`<meta name="description" content="${description}" />`);
  const dir=path.join(dist,slug);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'index.html'),page);
}
fs.mkdirSync(path.join(dist,'tools'),{recursive:true});
fs.writeFileSync(path.join(dist,'tools','index.html'),nestedLinks(shell).replace(/<title>.*?<\/title>/,'<title>Free Image Tools - PixelQuota</title>'));

let offline=addMeta(sourceHtml);
const standaloneJs=fs.readFileSync(path.join(assets,'standalone.js'),'utf8').replace(/<\/script/gi,'<\\/script');
const standaloneCssText=fs.existsSync(standaloneCssPath)?fs.readFileSync(standaloneCssPath,'utf8'):'';
offline=offline.replace('</head>',()=>`${standaloneCssText?`<style>${standaloneCssText}</style>\n`:''}</head>`);
offline=offline.replace(/<head>/i,()=>`<head><script>if(location.protocol==='http:'||location.protocol==='https:')location.replace('./index.html'+location.search+location.hash);</script>`);
offline=offline.replace(/<script src="\.\/config\.js"><\/script>/,()=>config?`<script>${config}</script>`:'');
offline=offline.replace(/<script type="module" src="\/src\/main\.js"><\/script>/,()=>`<script type="module">${standaloneJs}</script>`);
fs.writeFileSync(path.join(dist,'PixelQuota.html'),offline);
fs.writeFileSync(path.join(dist,'START-HERE.txt'),`PixelQuota ${version}\r\n\r\nDouble-click PixelQuota.html to use the standalone app. No install or local server required.\r\nFor web hosting, deploy index.html and assets/ together. AI first use requires internet access.\r\n`);
fs.writeFileSync(path.join(dist,'robots.txt'),'User-agent: *\nAllow: /\n');
// These temporary outputs were already embedded in the standalone HTML.
for(const name of ['standalone.js','standalone.css'])fs.rmSync(path.join(assets,name),{force:true});
fs.rmSync(path.join(dist,'config.js'),{force:true});
console.log('PixelQuota dual production build ready:',path.join(dist,'index.html'),path.join(dist,'PixelQuota.html'));
