import './app.css';
import { zipSync } from 'fflate';
import { compressImage } from './compress.js';
import { strings, detectLocale } from './i18n.js';

const $ = id => document.getElementById(id);
const state = {
  files:[], results:[], errors:[], previews:[], processKeys:[], resultOptions:[],
  locale:detectLocale(), busy:false, outputFormat:'auto', resizeMode:'limit',
  customMode:false, pageMode:'default', pagePresetKb:null, lastSkipped:0,
  selectedIndex:null, selectionManual:false, comparePosition:50
};
const cfg = window.PIXELQUOTA_CONFIG || {};

function t(key) { return strings[state.locale]?.[key] || strings.en[key] || key; }
function template(key, vars={}) { return t(key).replace(/\{(\w+)\}/g,(_,name)=>String(vars[name] ?? `{${name}}`)); }
function formatBytes(bytes) { if (bytes < 1000) return `${bytes} B`; if (bytes < 1e6) return `${(bytes/1000).toFixed(bytes<100000 ? 1 : 0)} KB`; return `${(bytes/1e6).toFixed(2)} MB`; }
function formatLimit(kb) { return kb>=1000 && kb%1000===0 ? `${kb/1000} MB` : `${kb} KB`; }
function escapeHtml(s='') { return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function toast(msg) { const el=$('toast'); el.textContent=msg; el.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove('show'),2600); }
function safeUrl(blob) { return URL.createObjectURL(blob); }
function targetKb() { return Math.max(5, Number($('targetKb').value || 200)); }
function formatName(type) { return type==='image/png'?'PNG':type==='image/webp'?'WebP':type==='image/jpeg'?'JPG':'Auto'; }
function setHeroLines(line1,line2) { $('heroTitle').textContent=[line1,line2].filter(Boolean).join(' '); }

function initPageMode() {
  const path=location.pathname.toLowerCase();
  const match=path.match(/compress-image-to-(\d+)(kb|mb)/);
  if (match) {
    state.pageMode='preset';
    state.pagePresetKb=Number(match[1])*(match[2]==='mb'?1000:1);
    $('targetKb').value=state.pagePresetKb;
    state.customMode=false;
  }
  if (path.includes('heic-to-jpg')) {
    state.pageMode='heic';
    state.outputFormat='image/jpeg';
  }
}

function applyPageCopy() {
  if (state.pageMode==='preset') {
    const limit=formatLimit(state.pagePresetKb);
    setHeroLines(template('presetHeroLine1',{limit}),t('presetHeroLine2'));
    $('heroSub').textContent=template('presetHeroSub',{limit});
    $('seoHeading').textContent=template('presetSeoHeading',{limit});
    $('seoParagraph1').textContent=template('presetSeoParagraph1',{limit});
    $('seoParagraph2').textContent=t('seoParagraph2');
    return;
  }
  if (state.pageMode==='heic') {
    setHeroLines(t('heicHeroLine1'),t('heicHeroLine2'));
    $('heroSub').textContent=t('heicHeroSub');
    $('seoHeading').textContent=t('seoHeading');
    $('seoParagraph1').textContent=t('seoParagraph1');
    $('seoParagraph2').textContent=t('seoParagraph2');
    return;
  }
  const lines=t('heroTitle').split('\n');
  setHeroLines(lines[0]||'',lines[1]||'');
  $('heroSub').textContent=t('heroSub');
  $('seoHeading').textContent=t('seoHeading');
  $('seoParagraph1').textContent=t('seoParagraph1');
  $('seoParagraph2').textContent=t('seoParagraph2');
}

function applyLocale(locale) {
  state.locale = strings[locale] ? locale : 'en';
  try { localStorage.setItem('pixelquota_lang',state.locale); } catch {}
  document.documentElement.lang=state.locale;
  document.querySelectorAll('[data-i18n]').forEach(el=>{const value=t(el.dataset.i18n);if(value)el.textContent=value;});
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el=>{el.placeholder=t(el.dataset.i18nPlaceholder);});
  $('languageSelect').value=state.locale;
  applyPageCopy(); updateGate(); updateQueue();
  if (state.files.length) renderCards();
}

function updateGate() {
  const kb=targetKb(); $('gateBadge').textContent=`≤ ${formatLimit(kb)}`;
  const presets=[...document.querySelectorAll('#presetRow [data-kb]')];
  const hasMatch=presets.some(b=>Number(b.dataset.kb)===kb);
  presets.forEach(b=>b.classList.toggle('active',!state.customMode && Number(b.dataset.kb)===kb));
  const custom=document.querySelector('#presetRow [data-custom]'); if(custom) custom.classList.toggle('active',state.customMode || !hasMatch);
  document.querySelectorAll('#commonLimitButtons [data-kb]').forEach(b=>b.classList.toggle('active',Number(b.dataset.kb)===kb));
}

function updateQueue() {
  const count=state.files.length;
  $('processBtn').disabled=!count||state.busy; $('clearBtn').hidden=!count;
  $('queueText').textContent=count?`${count} ${t('filesQueued')}`:t('queueEmpty');
}

function inputOptions() {
  return {
    targetKb:targetKb(), outputFormat:state.outputFormat, resizeMode:state.resizeMode,
    maxWidth:Number($('maxWidth').value||0), maxHeight:Number($('maxHeight').value||0),
    stripMetadata:$('stripMetadata').checked
  };
}
function settingsKey(opts) { return JSON.stringify({targetKb:opts.targetKb,outputFormat:opts.outputFormat,resizeMode:opts.resizeMode,maxWidth:opts.maxWidth,maxHeight:opts.maxHeight,stripMetadata:!!opts.stripMetadata}); }

function queueThumb(file,index) {
  if (/\.(heic|heif)$/i.test(file.name)||/heic|heif/i.test(file.type)) return '<div class="thumb placeholder"><span>HEIC</span></div>';
  return `<div class="thumb"><img src="${state.previews[index]}" alt="" /></div>`;
}
function failureReason(result,opts) {
  const vars={limit:formatLimit(opts?.targetKb||targetKb()),width:result.outputWidth,height:result.outputHeight,format:formatName(result.outputType||opts?.outputFormat)};
  if (opts?.resizeMode==='exact') return template('failExact',vars);
  if ((result.outputType||opts?.outputFormat)==='image/png') return template('failPng',vars);
  return template('failLimit',vars);
}
function errorReason(error) {
  const message=String(error?.message||error||'');
  return /decode_failed|heic|decoder|image/i.test(message)?t('failDecode'):t('failUnknown');
}
function selectedClass(index) { return state.selectedIndex===index?' selected':''; }
function updateComparisonPosition(value=state.comparePosition) {
  state.comparePosition=Math.max(0,Math.min(100,Number(value)||0));
  const stage=$('comparisonStage'); if(stage) stage.style.setProperty('--compare-position',`${state.comparePosition}%`);
  const range=$('compareRange'); if(range&&Number(range.value)!==state.comparePosition) range.value=String(state.comparePosition);
}
function chooseDefaultResult() {
  if(!state.files.length){state.selectedIndex=null;return;}
  if(Number.isInteger(state.selectedIndex)&&state.selectedIndex>=0&&state.selectedIndex<state.files.length){
    if(state.selectionManual||state.results[state.selectedIndex]?.metTarget)return;
  }
  const passed=state.results.findIndex(r=>r?.metTarget);
  if(passed>=0){state.selectedIndex=passed;return;}
  if(!Number.isInteger(state.selectedIndex)||state.selectedIndex<0||state.selectedIndex>=state.files.length)state.selectedIndex=0;
}
function renderComparison() {
  const panel=$('comparisonPanel'); if(!panel)return;
  if(!state.files.length){panel.hidden=true;return;}
  chooseDefaultResult();
  const index=state.selectedIndex??0; const file=state.files[index]; const result=state.results[index]; const error=state.errors[index];
  if(!file){panel.hidden=true;return;} panel.hidden=false;
  const original=$('compareOriginal'),output=$('compareOutput'),mask=$('compareOutputMask'),badge=$('compareOutputBadge'),divider=$('compareDivider'),range=$('compareRange'),failure=$('compareFailure'),unavailable=$('compareUnavailable');
  unavailable.hidden=true; original.onload=()=>{unavailable.hidden=true;}; original.onerror=()=>{unavailable.hidden=false;}; original.src=state.previews[index]||''; original.alt=`${file.name} ${t('original')}`;
  $('compareFilename').textContent=file.name; $('compareOriginalSize').textContent=formatBytes(file.size);
  failure.hidden=true; $('compareFailureText').textContent='';
  const showSlider=!!result?.metTarget;
  mask.hidden=!showSlider; badge.hidden=!showSlider; divider.hidden=!showSlider; range.hidden=!showSlider;
  if(showSlider){
    if(!result.previewUrl)result.previewUrl=safeUrl(result.blob); output.src=result.previewUrl; output.alt=`${file.name} ${t('compressed')}`;
    $('compareOutputSize').textContent=formatBytes(result.blob.size); const saved=Math.max(0,Math.round((1-result.blob.size/file.size)*100));
    $('compareDimensions').textContent=`${result.outputWidth}×${result.outputHeight} · ${formatName(result.outputType)}`; $('compareSaving').textContent=`${saved}% ${t('smaller')}`;
    $('compareStatus').className='status pass'; $('compareStatus').textContent=t('pass'); updateComparisonPosition();
  }else{
    $('compareOutputSize').textContent='—'; $('compareDimensions').textContent=result?`${result.outputWidth}×${result.outputHeight} · ${formatName(result.outputType)}`:formatBytes(file.size); $('compareSaving').textContent=result?t('targetMissed'):t('waiting');
    $('compareStatus').className=`status ${result||error?'fail':'pending'}`; $('compareStatus').textContent=result||error?t('failed'):t('waiting');
    if(result||error){failure.hidden=false;$('compareFailureText').textContent=result?failureReason(result,state.resultOptions[index]):errorReason(error);}
  }
  document.querySelectorAll('.result-card').forEach(card=>card.classList.toggle('selected',Number(card.dataset.resultIndex)===index));
}
function selectResult(index,manual=true){if(!Number.isInteger(index)||index<0||index>=state.files.length)return;state.selectedIndex=index;if(manual)state.selectionManual=true;state.comparePosition=50;renderComparison();}

function resultCardHtml(file,index,result) {
  if (!result.previewUrl) result.previewUrl=safeUrl(result.blob);
  const saved=Math.max(0,Math.round((1-result.blob.size/file.size)*100));
  const reason=result.metTarget?'':failureReason(result,state.resultOptions[index]);
  return `<article class="result-card done${result.metTarget?'':' over-limit'}${selectedClass(index)}" data-result-index="${index}" data-select-result="${index}" tabindex="0"><div class="thumb"><img src="${result.previewUrl}" alt="" /></div><div class="result-info"><strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong><span>${formatBytes(file.size)}</span></div><div class="size-flow"><div><span>${t('original')}</span><b>${formatBytes(file.size)}</b></div><i>→</i><div><span>${t('output')}</span><b>${formatBytes(result.blob.size)}</b></div><div class="dimension-note"><span>${t('dimensions')}</span><b>${result.outputWidth}×${result.outputHeight}</b></div><div class="saving-note"><span>${t('saved')}</span><b>${saved}%</b></div></div><div class="result-status"><span class="status ${result.metTarget?'pass':'fail'}">${result.metTarget?t('pass'):t('failed')}</span></div>${reason?`<div class="result-reason"><strong>!</strong><span>${escapeHtml(reason)}</span></div>`:''}<div class="result-action"><button type="button" data-download-index="${index}">${t('download')}</button></div></article>`;
}
function errorCardHtml(file,index,error) {
  return `<article class="result-card failed${selectedClass(index)}" data-result-index="${index}" data-select-result="${index}" tabindex="0"><div class="thumb placeholder error-thumb"><span>!</span></div><div class="result-info"><strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong><span>${formatBytes(file.size)}</span></div><div class="size-flow"><div><span>${t('original')}</span><b>${formatBytes(file.size)}</b></div><i>→</i><div><span>${t('output')}</span><b>—</b></div></div><div class="result-status"><span class="status fail">${t('failed')}</span></div><div class="result-reason"><strong>!</strong><span>${escapeHtml(errorReason(error))}</span></div></article>`;
}
function queuedCardHtml(file,index) {
  return `<article class="result-card queued${selectedClass(index)}" data-result-index="${index}" data-select-result="${index}" tabindex="0">${queueThumb(file,index)}<div class="result-info"><strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong><span>${formatBytes(file.size)}</span></div><div class="size-flow"><div><span>${t('original')}</span><b>${formatBytes(file.size)}</b></div><i>→</i><div><span>${t('output')}</span><b>${t('waiting')}</b></div></div><div class="result-status"><span class="status pending">${t('waiting')}</span><div class="progress"><i></i></div></div><div class="result-action"><button type="button" disabled>${t('download')}</button></div></article>`;
}
function renderCard(index) {
  const existing=document.querySelector(`[data-result-index="${index}"]`); if(!existing)return;
  const html=state.results[index]?resultCardHtml(state.files[index],index,state.results[index]):state.errors[index]?errorCardHtml(state.files[index],index,state.errors[index]):queuedCardHtml(state.files[index],index);
  existing.outerHTML=html; renderComparison();
}
function renderCards() {
  if(!state.files.length){$('resultsSection').hidden=true;$('emptyResults').hidden=false;$('resultList').innerHTML='';return;}
  $('emptyResults').hidden=true;$('resultsSection').hidden=false;
  chooseDefaultResult(); $('resultList').innerHTML=state.files.map((file,i)=>state.results[i]?resultCardHtml(file,i,state.results[i]):state.errors[i]?errorCardHtml(file,i,state.errors[i]):queuedCardHtml(file,i)).join('');
  $('downloadAllBtn').disabled=!state.results.some(Boolean); updateResultsSummary(); renderComparison();
}
function updateResultsSummary() {
  if(!state.files.length)return;
  const completed=state.results.filter(Boolean).length+state.errors.filter(Boolean).length;
  if(!completed){$('resultsSummary').textContent=t('queuedTitle');return;}
  const passed=state.results.filter(r=>r?.metTarget).length;
  let text=`${passed}/${state.files.length} ${t('passSummary')}`;
  if(state.lastSkipped) text+=` · ${state.lastSkipped} ${t('skippedSummary')}`;
  $('resultsSummary').textContent=text;
}

function addFiles(files) {
  const incoming=[...files].filter(f=>f.type.startsWith('image/')||/\.(jpe?g|png|webp|avif|heic|heif|bmp)$/i.test(f.name));
  if(!incoming.length)return;
  const room=30-state.files.length; if(room<=0)return toast(t('tooMany')); if(incoming.length>room)toast(t('tooMany'));
  incoming.slice(0,room).forEach(file=>{state.files.push(file);state.previews.push(URL.createObjectURL(file));state.results.push(null);state.errors.push(null);state.processKeys.push(null);state.resultOptions.push(null);});
  if(state.selectedIndex===null)state.selectedIndex=0; state.lastSkipped=0; renderCards(); updateQueue();
}
function resetAll() {
  state.results.forEach(r=>r?.previewUrl&&URL.revokeObjectURL(r.previewUrl)); state.previews.forEach(url=>URL.revokeObjectURL(url));
  state.files=[];state.results=[];state.errors=[];state.previews=[];state.processKeys=[];state.resultOptions=[];state.busy=false;state.lastSkipped=0;state.selectedIndex=null;state.selectionManual=false;state.comparePosition=50;
  $('fileInput').value='';$('resultsSection').hidden=true;$('emptyResults').hidden=false;$('comparisonPanel').hidden=true;$('resultList').innerHTML='';updateQueue();
}
function prepareCard(index) {
  const old=state.results[index]; if(old?.previewUrl)URL.revokeObjectURL(old.previewUrl);
  state.results[index]=null;state.errors[index]=null;state.resultOptions[index]=null;
  renderCard(index);
}
function updateCardProgress(index,pct) {
  const card=document.querySelector(`[data-result-index="${index}"]`);if(!card)return;
  card.classList.remove('queued');card.classList.add('working');const status=card.querySelector('.status');status.textContent=`${t('processing')} ${Math.round(pct)}%`;
  const bar=card.querySelector('.progress i');if(bar)bar.style.width=`${pct}%`;
}

async function processAll() {
  if(!state.files.length)return toast(t('addFirst'));
  const opts=inputOptions();if(opts.resizeMode==='exact'&&(!opts.maxWidth||!opts.maxHeight))return toast(t('invalidExact'));
  const key=settingsKey(opts);const todo=[];let skipped=0;
  for(let i=0;i<state.files.length;i++){if(state.processKeys[i]===key){skipped++;}else todo.push(i);}
  state.lastSkipped=skipped;
  if(!todo.length){updateResultsSummary();toast(t('alreadyProcessed'));return;}
  state.busy=true;updateQueue();$('processBtn').classList.add('busy');toast(t('working'));
  for(const i of todo){
    prepareCard(i);state.resultOptions[i]={...opts};
    try{
      const result=await compressImage(state.files[i],opts,p=>updateCardProgress(i,p));
      state.results[i]=result;state.errors[i]=null;state.processKeys[i]=key;if(result.metTarget&&!state.selectionManual&&!state.results[state.selectedIndex]?.metTarget)state.selectedIndex=i;renderCard(i);
    }catch(error){
      console.warn('PixelQuota decode/compress failure:',state.files[i]?.name,error);
      state.results[i]=null;state.errors[i]={message:String(error?.message||error)};state.processKeys[i]=key;renderCard(i);
    }
  }
  state.busy=false;$('processBtn').classList.remove('busy');updateQueue();$('downloadAllBtn').disabled=!state.results.some(Boolean);updateResultsSummary();toast(t('done'));
}

function downloadBlob(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1600);}
async function downloadAll(){const good=state.results.filter(Boolean);if(!good.length)return toast(t('noOutputs'));const entries={};for(const r of good)entries[r.outputName]=new Uint8Array(await r.blob.arrayBuffer());const zipped=zipSync(entries,{level:6});downloadBlob(new Blob([zipped],{type:'application/zip'}),'pixelquota-images.zip');toast(t('zipReady'));}
function setPreset(kb){state.customMode=false;$('targetKb').value=kb;updateGate();}
function setCustom(){state.customMode=true;updateGate();$('targetKb').focus();$('targetKb').select();}
function setFormat(format){state.outputFormat=format;document.querySelectorAll('#formatButtons button').forEach(b=>b.classList.toggle('active',b.dataset.format===format));}
function setResize(mode){state.resizeMode=mode;document.querySelectorAll('#resizeButtons button').forEach(b=>b.classList.toggle('active',b.dataset.resize===mode));}

function initMonetization(){const m=cfg.monetization||{};if(m.sponsorText&&m.sponsorUrl){const slot=$('adTop');slot.hidden=false;$('adTopInner').innerHTML=`<a class="sponsor-link" href="${escapeHtml(m.sponsorUrl)}" rel="sponsored noopener" target="_blank">${escapeHtml(m.sponsorText)}</a>`;return;}if(m.adsenseClient&&m.adsenseSlotTop&&location.protocol.startsWith('http')){const s=document.createElement('script');s.async=true;s.crossOrigin='anonymous';s.src=`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(m.adsenseClient)}`;document.head.appendChild(s);const slot=$('adTop');slot.hidden=false;$('adTopInner').innerHTML=`<ins class="adsbygoogle" style="display:block" data-ad-client="${escapeHtml(m.adsenseClient)}" data-ad-slot="${escapeHtml(m.adsenseSlotTop)}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;try{(window.adsbygoogle=window.adsbygoogle||[]).push({});}catch{}}}
function bind(){
  $('browseBtn').onclick=e=>{e.stopPropagation();$('fileInput').click();};
  $('dropZone').onclick=e=>{if(!e.target.closest('button'))$('fileInput').click();};
  $('dropZone').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('fileInput').click();}};
  $('fileInput').onchange=e=>addFiles(e.target.files);
  ['dragenter','dragover'].forEach(ev=>$('dropZone').addEventListener(ev,e=>{e.preventDefault();$('dropZone').classList.add('dragging')}));
  ['dragleave','drop'].forEach(ev=>$('dropZone').addEventListener(ev,e=>{e.preventDefault();$('dropZone').classList.remove('dragging')}));
  $('dropZone').addEventListener('drop',e=>addFiles(e.dataTransfer.files));
  window.addEventListener('paste',e=>{const files=[...(e.clipboardData?.files||[])];if(files.length)addFiles(files);});
  $('presetRow').onclick=e=>{const preset=e.target.closest('[data-kb]');if(preset)return setPreset(Number(preset.dataset.kb));const custom=e.target.closest('[data-custom]');if(custom)setCustom();};
  $('targetKb').addEventListener('input',()=>{state.customMode=true;updateGate();});
  $('commonLimitButtons').onclick=e=>{const b=e.target.closest('[data-kb]');if(!b)return;setPreset(Number(b.dataset.kb));document.querySelector('.spec-pane').scrollIntoView({behavior:'smooth',block:'center'});};
  $('formatButtons').onclick=e=>{const b=e.target.closest('[data-format]');if(b)setFormat(b.dataset.format);};
  $('resizeButtons').onclick=e=>{const b=e.target.closest('[data-resize]');if(b)setResize(b.dataset.resize);};
  $('processBtn').onclick=processAll;$('clearBtn').onclick=resetAll;$('downloadAllBtn').onclick=downloadAll;
  $('compareRange').oninput=e=>updateComparisonPosition(e.target.value);
  $('resultList').onclick=e=>{const b=e.target.closest('[data-download-index]');if(b){e.stopPropagation();const r=state.results[Number(b.dataset.downloadIndex)];if(r)downloadBlob(r.blob,r.outputName);return;}const card=e.target.closest('[data-select-result]');if(card)selectResult(Number(card.dataset.selectResult));};
  $('resultList').onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target.closest('[data-select-result]')&&!e.target.closest('button')){e.preventDefault();selectResult(Number(e.target.closest('[data-select-result]').dataset.selectResult));}};
  $('languageSelect').onchange=e=>applyLocale(e.target.value);
}
function init(){initPageMode();bind();applyLocale(state.locale);setFormat(state.outputFormat);setResize(state.resizeMode);initMonetization();window.PixelQuotaTest={addFiles,processAll,state,compressImage,setPreset,setCustom,setFormat,setResize,settingsKey,inputOptions,selectResult,renderComparison,updateComparisonPosition};}
init();
