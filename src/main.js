import './app.css';
import { zipSync } from 'fflate';
import { compressImage, detectEncoderSupport } from './compress.js';
import { applyWatermarks, renderWatermarkPreview, clearWatermarkCache } from './watermark.js';
import { applyRedactions, renderRedactPreview, clearRedactCache } from './redact.js';
import { CROP_PRESETS, applyCrop, renderCropPreview, clearCropCache, defaultCropRect } from './crop.js';
import { BACKGROUND_REMOVAL_ENGINE, removeBackgroundDemo, renderBackgroundRemovalPreview, renderBackgroundRemovalInspection, clearBackgroundRemovalCache, loadBackgroundAIModel, getBackgroundAIState, probeBackgroundAICache, hasBackgroundAIMatte } from './remove-bg.js';
import { createColorPicker } from './color-picker.js';
import { strings, detectLocale } from './i18n.js';

const $ = id => document.getElementById(id);
const state = {
  files:[], results:[], errors:[], previews:[], processKeys:[], resultOptions:[],
  locale:detectLocale(), busy:false, outputFormat:'auto', resizeMode:'limit', compressionMode:'limit',
  customMode:false, pageMode:'default', pagePresetKb:null, lastSkipped:0,
  selectedIndex:null, selectionManual:false, comparePosition:50, toolMode:'compress', watermarkPosition:'br', watermarkImagePosition:'tl', watermarkTextAlign:'left',
  watermarkImageFile:null, watermarkImagePreviewUrl:null, liveWatermarkPreviewIndex:null, liveWatermarkPreviewMeta:null, watermarkPreviewToken:0, watermarkPanel:'text',
  redactMode:'pixelate', redactStrength:45, redactColor:'#111827', redactRegions:[], redactHistory:[], redactSelected:null, redactPreviewIndex:null, redactPreviewMeta:null, redactPreviewToken:0, redactView:'edit',
  cropPlatform:'instagram', cropPreset:'ig-tall', cropRects:[], cropSourceMeta:[],
  bgSensitivity:48, bgAiThreshold:50, bgAiFeather:18, bgPreviewIndex:null, bgPreviewMeta:null, bgPreviewToken:0, bgEngine:'demo',
  outputGeneration:0, activeRun:null
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
function formatName(type) { return type==='image/png'?'PNG':type==='image/webp'?'WebP':type==='image/jpeg'?'JPG':type==='image/avif'?'AVIF':type==='image/bmp'?'BMP':'Auto'; }
function setHeroLines(line1,line2) { $('heroTitle').textContent=[line1,line2].filter(Boolean).join(' '); }
function setDocumentMeta(title,description){
  document.title=title;
  const meta=document.querySelector('meta[name="description"]');if(meta)meta.setAttribute('content',description);
  const ogTitle=document.querySelector('meta[property="og:title"]');if(ogTitle)ogTitle.setAttribute('content',title);
  const ogDescription=document.querySelector('meta[property="og:description"]');if(ogDescription)ogDescription.setAttribute('content',description);
}
function sourceDimensionsText(width,height){return width&&height?`${t('sourceDimensions')}: ${Math.round(width)}×${Math.round(height)}`:t('sourceDimensions');}

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

function applyRouteMeta() {
  if (state.pageMode==='preset') {
    const limit=formatLimit(state.pagePresetKb);
    setDocumentMeta(template('presetPageTitle',{limit}),template('presetPageDescription',{limit}));
    return;
  }
  if (state.pageMode==='heic') {
    setDocumentMeta(t('heicPageTitle'),t('heicPageDescription'));
    return;
  }
  setDocumentMeta(t('pageTitle'),t('pageDescription'));
}

function applyPageCopy() {
  applyRouteMeta();
  if (state.toolMode==='watermark') {
    document.querySelector('.hero-section .eyebrow').textContent=t('watermarkEyebrow');
    setHeroLines(t('watermarkHeroTitle'),'');
    $('heroSub').textContent=t('watermarkHeroSub');
    $('seoHeading').textContent=t('watermarkSeoHeading');
    $('seoParagraph1').textContent=t('watermarkSeoParagraph1');
    $('seoParagraph2').textContent=t('watermarkSeoParagraph2');
    return;
  }
  if (state.toolMode==='redact') {
    document.querySelector('.hero-section .eyebrow').textContent=t('redactEyebrow');
    setHeroLines(t('redactHeroTitle'),'');
    $('heroSub').textContent=t('redactHeroSub');
    $('seoHeading').textContent=t('redactSeoHeading');
    $('seoParagraph1').textContent=t('redactSeoParagraph1');
    $('seoParagraph2').textContent=t('redactSeoParagraph2');
    return;
  }
  if (state.toolMode==='crop') {
    document.querySelector('.hero-section .eyebrow').textContent=t('cropEyebrow');
    setHeroLines(t('cropHeroTitle'),'');
    $('heroSub').textContent=t('cropHeroSub');
    $('seoHeading').textContent=t('cropSeoHeading');
    $('seoParagraph1').textContent=t('cropSeoParagraph1');
    $('seoParagraph2').textContent=t('cropSeoParagraph2');
    return;
  }
  if (state.toolMode==='remove-bg') {
    document.querySelector('.hero-section .eyebrow').textContent=t('bgEyebrow');
    setHeroLines(t('bgHeroTitle'),'');
    $('heroSub').textContent=t('bgHeroSub');
    $('seoHeading').textContent=t('bgSeoHeading');
    $('seoParagraph1').textContent=t('bgSeoParagraph1');
    $('seoParagraph2').textContent=t('bgSeoParagraph2');
    return;
  }
  document.querySelector('.hero-section .eyebrow').textContent=t('eyebrow');
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

function syncLanguageMenu(){
  const value={en:'EN','zh-TW':'繁中','zh-CN':'简中',ja:'日本語',ko:'한국어'}[state.locale]||'EN';
  if($('languageValue'))$('languageValue').textContent=value;
  document.querySelectorAll('#languageOptions [data-locale]').forEach(button=>{
    const active=button.dataset.locale===state.locale;
    button.classList.toggle('active',active);
    button.setAttribute('aria-selected',String(active));
  });
}
function closeLanguageMenu(){
  const options=$('languageOptions'),toggle=$('languageToggle');if(!options||!toggle)return;
  options.hidden=true;toggle.setAttribute('aria-expanded','false');
}
function toggleLanguageMenu(force){
  const options=$('languageOptions'),toggle=$('languageToggle');if(!options||!toggle)return;
  const open=typeof force==='boolean'?force:options.hidden;
  options.hidden=!open;toggle.setAttribute('aria-expanded',String(open));
  if(open)document.querySelector('#languageOptions [aria-selected="true"]')?.focus();
}

function applyLocale(locale) {
  state.locale = strings[locale] ? locale : 'en';
  try { localStorage.setItem('pixelquota_lang',state.locale); } catch {}
  document.documentElement.lang=state.locale;
  document.querySelectorAll('[data-i18n]').forEach(el=>{const value=t(el.dataset.i18n);if(value)el.textContent=value;});
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el=>{el.placeholder=t(el.dataset.i18nPlaceholder);});
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el=>{el.setAttribute('aria-label',t(el.dataset.i18nAriaLabel));});
  syncLanguageMenu();
  updateToolModeUI(); applyPageCopy(); updateGate(); updateQueue();
  if (state.files.length) renderCards();
}

function updateGate() {
  const kb=targetKb(); $('gateBadge').textContent=`≤ ${formatLimit(kb)}`;
  $('gateBadge').hidden=state.toolMode!=='compress'||state.compressionMode==='convert';
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
    targetKb:targetKb(), outputFormat:state.outputFormat, resizeMode:state.resizeMode, compressionMode:state.compressionMode,
    maxWidth:Number($('maxWidth').value||0), maxHeight:Number($('maxHeight').value||0),
    stripMetadata:$('stripMetadata').checked
  };
}
function settingsKey(opts) { return JSON.stringify({compressionMode:opts.compressionMode,targetKb:opts.compressionMode==='convert'?null:opts.targetKb,outputFormat:opts.outputFormat,resizeMode:opts.resizeMode,maxWidth:opts.maxWidth,maxHeight:opts.maxHeight,stripMetadata:!!opts.stripMetadata}); }

let staleCardsFrame=0;
function syncDownloadAvailability(){
  const button=$('downloadAllBtn');if(!button)return;
  const available=state.results.some(Boolean);
  button.hidden=!available;button.disabled=!available||state.busy;
}
// Any in-flight processAll() run started before a bump must not commit its results.
function bumpOutputGeneration(){state.outputGeneration=(state.outputGeneration||0)+1;}
function invalidateAllOutputs(){
  let changed=false;
  for(let i=0;i<state.files.length;i++){
    const result=state.results[i];
    if(result?.previewUrl)URL.revokeObjectURL(result.previewUrl);
    if(result||state.errors[i]||state.processKeys[i]||state.resultOptions[i]){
      state.results[i]=null;state.errors[i]=null;state.processKeys[i]=null;state.resultOptions[i]=null;changed=true;
    }
  }
  bumpOutputGeneration();
  state.lastSkipped=0;syncDownloadAvailability();
  document.querySelectorAll('#resultList [data-download-index]').forEach(button=>button.closest('.result-action')?.remove());
  if(changed&&!staleCardsFrame){
    staleCardsFrame=requestAnimationFrame(()=>{staleCardsFrame=0;renderCards();});
  }
  return changed;
}

function watermarkOptions() {
  return {
    text:$('watermarkText').value.trim(),
    color:$('watermarkColor').value||'#ffffff',
    opacity:Number($('watermarkOpacity').value||55)/100,
    size:Number($('watermarkSize').value||6)/100,
    position:state.watermarkPosition,
    textAlign:state.watermarkTextAlign,
    imageFile:state.watermarkImageFile,
    imageOpacity:Number($('watermarkImageOpacity').value||80)/100,
    imageSize:Math.min(.5,Number($('watermarkImageSize').value||20)/100),
    imagePosition:state.watermarkImagePosition
  };
}
function watermarkSettingsKey(opts){return JSON.stringify({mode:'watermark',text:opts.text,color:opts.color,opacity:opts.opacity,size:opts.size,position:opts.position,textAlign:opts.textAlign,image:opts.imageFile?[`${opts.imageFile.name}`,opts.imageFile.size,opts.imageFile.lastModified].join(':'):'',imageOpacity:opts.imageOpacity,imageSize:opts.imageSize,imagePosition:opts.imagePosition});}
let watermarkPreviewFrame=0,watermarkPreviewBusy=false,watermarkPreviewQueued=false;
function clearLiveWatermarkPreview(preserveCanvas=false){
  state.watermarkPreviewToken++;watermarkPreviewQueued=false;
  if(watermarkPreviewFrame)cancelAnimationFrame(watermarkPreviewFrame);watermarkPreviewFrame=0;
  state.liveWatermarkPreviewIndex=null;state.liveWatermarkPreviewMeta=null;
  if(!preserveCanvas){const canvas=$('watermarkLiveCanvas');if(canvas){canvas.width=1;canvas.height=1;}}
}
async function requestWatermarkPreviewFrame(){
  if(watermarkPreviewBusy||!watermarkPreviewQueued)return;
  watermarkPreviewQueued=false;watermarkPreviewBusy=true;
  const token=state.watermarkPreviewToken;
  await updateWatermarkLivePreview(token);
  watermarkPreviewBusy=false;
  if(watermarkPreviewQueued)scheduleWatermarkPreview(false);
}
function scheduleWatermarkPreview(bumpToken=true){
  if(state.toolMode!=='watermark'||!state.files.length)return;
  if(bumpToken)state.watermarkPreviewToken++;
  watermarkPreviewQueued=true;
  if(watermarkPreviewFrame)return;
  watermarkPreviewFrame=requestAnimationFrame(()=>{watermarkPreviewFrame=0;requestWatermarkPreviewFrame();});
}
function watermarkSettingsChanged(){
  invalidateAllOutputs();
  scheduleWatermarkPreview();
}
async function updateWatermarkLivePreview(token=state.watermarkPreviewToken){
  if(state.toolMode!=='watermark'||!state.files.length)return;
  const index=Number.isInteger(state.selectedIndex)?state.selectedIndex:0;
  const file=state.files[index];if(!file)return;
  try{
    const preview=await renderWatermarkPreview(file,watermarkOptions());
    if(token!==state.watermarkPreviewToken||state.toolMode!=='watermark')return;
    const canvas=$('watermarkLiveCanvas'),ctx=canvas.getContext('2d',{alpha:true});
    canvas.width=preview.width;canvas.height=preview.height;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(preview.canvas,0,0);
    state.liveWatermarkPreviewIndex=index;state.liveWatermarkPreviewMeta={width:preview.width,height:preview.height,sourceWidth:preview.sourceWidth,sourceHeight:preview.sourceHeight,textMetrics:preview.textMetrics};
    renderComparison();
  }catch(error){
    if(token!==state.watermarkPreviewToken)return;
    console.warn('Watermark live preview failed:',error);
  }
}
function backgroundOptions(){return{engine:state.bgEngine,sensitivity:Number($('bgSensitivity')?.value||state.bgSensitivity||48)/100,aiThreshold:Number($('bgAiThreshold')?.value||state.bgAiThreshold||50)/100,aiFeather:Number($('bgAiFeather')?.value||state.bgAiFeather||18)/100};}
function backgroundSettingsKey(opts=backgroundOptions()){return JSON.stringify({mode:'remove-bg',engine:opts.engine,sensitivity:opts.engine==='demo'?opts.sensitivity:null,aiThreshold:opts.engine==='ai'?opts.aiThreshold:null,aiFeather:opts.engine==='ai'?opts.aiFeather:null});}
function syncBackgroundEngineUI(){
  const ai=state.bgEngine==='ai',model=getBackgroundAIState();
  document.querySelectorAll('#bgEngineSwitch [data-bg-engine]').forEach(button=>button.classList.toggle('active',button.dataset.bgEngine===state.bgEngine));
  $('bgAiModelPanel').hidden=!ai;$('bgSensitivityWrap').hidden=ai;
  $('bgAiRefineControls').hidden=!ai||!model.ready;
  $('bgEngineBadge').textContent=ai?'AI':t('bgEngineDemo');
  $('bgCurrentEngineValue').textContent=t(ai?'bgAiCurrent':'bgEngineReady');
  $('bgModelState').textContent=model.ready?t('bgModelLoaded'):model.cached?t('bgModelCached'):t(model.status==='loading'?'bgModelLoading':model.status==='error'?'bgModelError':'bgModelNotLoaded');
  $('bgLoadModel').disabled=model.status==='loading'||model.ready;
  $('bgLoadModel').textContent=model.ready?t('bgModelLoaded'):model.status==='loading'?t('bgModelLoadingShort'):model.cached?t('bgModelCached'):t('bgLoadModel');
  $('bgModelProgress').hidden=model.status!=='loading';
  const pct=Math.max(0,Math.min(100,Number(model.progress)||0));$('bgModelProgressBar').style.width=`${pct}%`;
  if(model.status==='error'&&model.message)$('bgModelProgressText').textContent=`${t('bgModelErrorDetail')} ${model.message}`;
  else if(model.ready)$('bgModelProgressText').textContent=template('bgModelReadyHint',{device:model.device==='webgpu'?'WebGPU':'WASM'});
  else if(model.cached)$('bgModelProgressText').textContent=t('bgModelCachedHint');
  else $('bgModelProgressText').textContent=t('bgModelInitialHint');
}
function setBackgroundEngine(engine){
  if(!['demo','ai'].includes(engine)||state.bgEngine===engine)return;
  state.bgEngine=engine;invalidateAllOutputs();clearBackgroundPreview();syncBackgroundEngineUI();
  if(engine==='demo'||getBackgroundAIState().ready)scheduleBackgroundPreview();
  else if(getBackgroundAIState().cached)loadBackgroundModelUI({silent:true});
  else renderComparison();
}
async function loadBackgroundModelUI({silent=false}={}){
  if(state.bgEngine!=='ai')setBackgroundEngine('ai');
  try{
    await loadBackgroundAIModel(()=>syncBackgroundEngineUI());
    syncBackgroundEngineUI();if(!silent)toast(t('bgModelReadyToast'));scheduleBackgroundPreview();
  }catch(error){
    syncBackgroundEngineUI();const detail=String(error?.message||error||'Unknown error');$('bgModelProgressText').textContent=`${t('bgModelErrorDetail')} ${detail}`;toast(`${t('bgModelErrorDetail')} ${detail}`);console.warn('Background AI model failed:',error);
  }
}
async function initBackgroundAICacheState(){
  await probeBackgroundAICache();syncBackgroundEngineUI();
}
let backgroundPreviewFrame=0,backgroundPreviewBusy=false,backgroundPreviewQueued=false,backgroundAiRefineTimer=0;
const backgroundInspector={token:0,zoom:1,panX:0,panY:0,pointer:null,baseWidth:0,baseHeight:0};
function setBackgroundBusy(active,text=''){
  const busy=$('backgroundBusy'),label=$('backgroundBusyText');if(!busy)return;
  busy.hidden=!active;if(label&&text)label.textContent=text;
}
function applyBackgroundInspectorTransform(){
  const canvas=$('backgroundInspectCanvas'),viewport=$('backgroundInspectViewport');if(!canvas||!viewport)return;
  const view=viewport.getBoundingClientRect(),baseWidth=backgroundInspector.baseWidth||canvas.clientWidth,baseHeight=backgroundInspector.baseHeight||canvas.clientHeight;
  const maxX=Math.max(0,(baseWidth*backgroundInspector.zoom-view.width)/2),maxY=Math.max(0,(baseHeight*backgroundInspector.zoom-view.height)/2);
  backgroundInspector.panX=Math.max(-maxX,Math.min(maxX,backgroundInspector.panX));backgroundInspector.panY=Math.max(-maxY,Math.min(maxY,backgroundInspector.panY));
  canvas.style.transform=`translate3d(${backgroundInspector.panX}px,${backgroundInspector.panY}px,0) scale(${backgroundInspector.zoom})`;
  viewport.classList.toggle('drag-ready',backgroundInspector.zoom>1);$('backgroundInspectZoomLabel').textContent=`${Math.round(backgroundInspector.zoom*100)}%`;
  document.querySelectorAll('[data-edge-zoom]').forEach(button=>button.classList.toggle('active',Number(button.dataset.edgeZoom)===backgroundInspector.zoom));
}
function setBackgroundInspectorZoom(value){
  const zoom=[1,2,4].includes(Number(value))?Number(value):1;backgroundInspector.zoom=zoom;
  if(zoom===1){backgroundInspector.panX=0;backgroundInspector.panY=0;}applyBackgroundInspectorTransform();
}
function closeBackgroundInspector({restoreFocus=true}={}){
  const modal=$('backgroundInspectModal');if(!modal||modal.hidden)return;
  backgroundInspector.token++;backgroundInspector.pointer=null;backgroundInspector.zoom=1;backgroundInspector.panX=0;backgroundInspector.panY=0;backgroundInspector.baseWidth=0;backgroundInspector.baseHeight=0;
  modal.hidden=true;document.body.classList.remove('edge-inspect-open');$('backgroundInspectViewport')?.classList.remove('dragging','drag-ready');
  if(restoreFocus&&!$('backgroundInspectBtn')?.hidden)$('backgroundInspectBtn').focus();
}
async function openBackgroundInspector(){
  const index=Number.isInteger(state.selectedIndex)?state.selectedIndex:0,file=state.files[index];
  if(state.toolMode!=='remove-bg'||!file||state.bgPreviewIndex!==index||!state.bgPreviewMeta)return;
  const modal=$('backgroundInspectModal'),canvas=$('backgroundInspectCanvas'),busy=$('backgroundInspectBusy');if(!modal||!canvas)return;
  const token=++backgroundInspector.token;backgroundInspector.zoom=1;backgroundInspector.panX=0;backgroundInspector.panY=0;backgroundInspector.baseWidth=0;backgroundInspector.baseHeight=0;
  modal.hidden=false;document.body.classList.add('edge-inspect-open');busy.hidden=false;canvas.width=1;canvas.height=1;canvas.style.transform='none';$('backgroundInspectDimensions').textContent=t('bgInspectBuilding');
  await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
  try{
    const preview=await renderBackgroundRemovalInspection(file,backgroundOptions());
    if(token!==backgroundInspector.token||modal.hidden)return;
    canvas.width=preview.width;canvas.height=preview.height;const ctx=canvas.getContext('2d',{alpha:true});ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(preview.canvas,0,0);
    $('backgroundInspectDimensions').textContent=template('bgInspectDimensions',{width:preview.width,height:preview.height,sourceWidth:preview.sourceWidth,sourceHeight:preview.sourceHeight});busy.hidden=true;
    requestAnimationFrame(()=>{if(token!==backgroundInspector.token||modal.hidden)return;backgroundInspector.baseWidth=canvas.getBoundingClientRect().width;backgroundInspector.baseHeight=canvas.getBoundingClientRect().height;setBackgroundInspectorZoom(2);});
  }catch(error){
    if(token!==backgroundInspector.token)return;busy.hidden=true;toast(template('bgInspectError',{error:String(error?.message||error||'Unknown error')}));closeBackgroundInspector({restoreFocus:true});
  }
}
function onBackgroundInspectPointerDown(event){
  if(backgroundInspector.zoom<=1)return;
  const viewport=$('backgroundInspectViewport');backgroundInspector.pointer={id:event.pointerId,x:event.clientX,y:event.clientY,panX:backgroundInspector.panX,panY:backgroundInspector.panY};viewport.setPointerCapture?.(event.pointerId);viewport.classList.add('dragging');event.preventDefault();
}
function onBackgroundInspectPointerMove(event){
  const pointer=backgroundInspector.pointer;if(!pointer||pointer.id!==event.pointerId)return;
  backgroundInspector.panX=pointer.panX+(event.clientX-pointer.x);backgroundInspector.panY=pointer.panY+(event.clientY-pointer.y);applyBackgroundInspectorTransform();
}
function onBackgroundInspectPointerUp(event){
  if(!backgroundInspector.pointer||backgroundInspector.pointer.id!==event.pointerId)return;
  backgroundInspector.pointer=null;$('backgroundInspectViewport')?.classList.remove('dragging');
}
function clearBackgroundPreview(preserveCanvas=false){
  closeBackgroundInspector({restoreFocus:false});
  state.bgPreviewToken++;backgroundPreviewQueued=false;
  if(backgroundPreviewFrame)cancelAnimationFrame(backgroundPreviewFrame);backgroundPreviewFrame=0;
  if(backgroundAiRefineTimer)clearTimeout(backgroundAiRefineTimer);backgroundAiRefineTimer=0;setBackgroundBusy(false);
  state.bgPreviewIndex=null;state.bgPreviewMeta=null;
  if(!preserveCanvas){const canvas=$('backgroundPreviewCanvas');if(canvas){canvas.width=1;canvas.height=1;}}
}
async function requestBackgroundPreviewFrame(){
  if(backgroundPreviewBusy||!backgroundPreviewQueued)return;
  backgroundPreviewQueued=false;backgroundPreviewBusy=true;
  const token=state.bgPreviewToken;await updateBackgroundPreview(token);backgroundPreviewBusy=false;
  if(backgroundPreviewQueued)scheduleBackgroundPreview(false);
}
function scheduleBackgroundPreview(bumpToken=true){
  if(state.toolMode!=='remove-bg'||!state.files.length)return;
  if(state.bgEngine==='ai'&&!getBackgroundAIState().ready){renderComparison();return;}
  if(bumpToken)state.bgPreviewToken++;
  backgroundPreviewQueued=true;if(backgroundPreviewFrame)return;
  backgroundPreviewFrame=requestAnimationFrame(()=>{backgroundPreviewFrame=0;requestBackgroundPreviewFrame();});
}
function backgroundSettingsChanged(){
  state.bgSensitivity=Number($('bgSensitivity').value||48);
  invalidateAllOutputs();scheduleBackgroundPreview();
}
function backgroundAISettingsChanged(immediate=false){
  state.bgAiThreshold=Number($('bgAiThreshold').value||50);state.bgAiFeather=Number($('bgAiFeather').value||18);
  invalidateAllOutputs();
  if(backgroundAiRefineTimer)clearTimeout(backgroundAiRefineTimer);
  if(immediate){backgroundAiRefineTimer=0;scheduleBackgroundPreview();return;}
  backgroundAiRefineTimer=setTimeout(()=>{backgroundAiRefineTimer=0;scheduleBackgroundPreview();},90);
}
async function updateBackgroundPreview(token=state.bgPreviewToken){
  if(state.toolMode!=='remove-bg'||!state.files.length)return;
  if(state.bgEngine==='ai'&&!getBackgroundAIState().ready)return;
  const index=Number.isInteger(state.selectedIndex)?state.selectedIndex:0,file=state.files[index];if(!file)return;
  if(state.bgEngine==='ai')setBackgroundBusy(true,t(hasBackgroundAIMatte(file)?'bgBusyRefine':'bgBusyAnalyze'));
  try{
    const preview=await renderBackgroundRemovalPreview(file,backgroundOptions());
    if(token!==state.bgPreviewToken||state.toolMode!=='remove-bg'||index!==state.selectedIndex)return;
    const canvas=$('backgroundPreviewCanvas'),ctx=canvas.getContext('2d',{alpha:true});
    canvas.width=preview.width;canvas.height=preview.height;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(preview.canvas,0,0);
    state.bgPreviewIndex=index;state.bgPreviewMeta={width:preview.width,height:preview.height,sourceWidth:preview.sourceWidth,sourceHeight:preview.sourceHeight,transparentRatio:preview.mask.transparentRatio??null,engine:state.bgEngine,rawMatteWidth:preview.mask.rawWidth??null,rawMatteHeight:preview.mask.rawHeight??null};
    renderComparison();
  }catch(error){
    if(token!==state.bgPreviewToken)return;
    const detail=String(error?.message||error||'Unknown error');
    console.warn('Background removal preview failed:',error);
    if(state.bgEngine==='ai')$('bgModelProgressText').textContent=`${t('bgPreviewFailed')} ${detail}`;
    toast(`${t('bgPreviewFailed')} ${detail}`);
  }finally{if(token===state.bgPreviewToken)setBackgroundBusy(false);}
}
function cropPreset(){return CROP_PRESETS[state.cropPreset]||CROP_PRESETS['ig-tall'];}
function ensureCropRect(index,width,height,reset=false){
  if(!Number.isInteger(index)||!width||!height)return null;
  state.cropSourceMeta[index]={width,height};
  if(reset||!state.cropRects[index]){
    const preset=cropPreset();
    state.cropRects[index]=defaultCropRect(width,height,preset.width,preset.height);
  }
  return state.cropRects[index];
}
function cropOptions(index=state.selectedIndex??0){
  const preset=cropPreset(),meta=state.cropSourceMeta[index];
  const rect=meta?ensureCropRect(index,meta.width,meta.height):state.cropRects[index]||null;
  return{preset:state.cropPreset,rect:rect?{...rect}:null,width:preset.width,height:preset.height};
}
function cropSettingsKey(value=state.selectedIndex??0){
  const opts=typeof value==='object'&&value?value:cropOptions(value);
  return JSON.stringify({mode:'crop',preset:opts.preset,rect:opts.rect});
}
const CROP_PLATFORM_DEFAULTS={instagram:'ig-tall',x:'x-header',youtube:'youtube-thumb',facebook:'facebook-cover',linkedin:'linkedin-cover'};
function setCropPlatform(platform){
  if(!CROP_PLATFORM_DEFAULTS[platform])return;
  const changed=state.cropPlatform!==platform;state.cropPlatform=platform;
  document.querySelectorAll('#cropPlatformButtons [data-crop-platform]').forEach(button=>button.classList.toggle('active',button.dataset.cropPlatform===platform));
  const presetButtons=[...document.querySelectorAll('#cropPresetGrid [data-crop-platform]')];presetButtons.forEach(button=>{button.hidden=button.dataset.cropPlatform!==platform;});
  $('cropPresetGrid').classList.toggle('single',presetButtons.filter(button=>button.dataset.cropPlatform===platform).length===1);
  const current=document.querySelector(`#cropPresetGrid [data-crop-preset="${state.cropPreset}"]`);
  if(changed||!current||current.dataset.cropPlatform!==platform)setCropPreset(CROP_PLATFORM_DEFAULTS[platform]);
}
function invalidateCropResult(index){
  bumpOutputGeneration();
  const result=state.results[index];if(result?.previewUrl)URL.revokeObjectURL(result.previewUrl);
  state.results[index]=null;state.errors[index]=null;state.processKeys[index]=null;state.resultOptions[index]=null;syncDownloadAvailability();
}
function setCropPreset(preset){
  if(!CROP_PRESETS[preset])return;
  const changed=state.cropPreset!==preset;state.cropPreset=preset;
  document.querySelectorAll('#cropPresetGrid [data-crop-preset]').forEach(button=>button.classList.toggle('active',button.dataset.cropPreset===preset));
  if(!changed)return;
  bumpOutputGeneration();
  state.cropRects=state.cropRects.map(()=>null);
  state.files.forEach((_,index)=>{if(state.results[index]?.operation==='crop'||state.processKeys[index]?.includes('"mode":"crop"'))invalidateCropResult(index);});
  if(state.files.length){renderCards();requestCropOverlayRender();}
}
function resetCropFrame(){
  const index=state.selectedIndex??0,meta=state.cropSourceMeta[index];if(!meta)return;
  ensureCropRect(index,meta.width,meta.height,true);invalidateCropResult(index);renderCard(index);updateResultsSummary();requestCropOverlayRender();
}
let cropOverlayFrame=0,cropPointer=null;
function clearCropEditor(preserveCanvas=false){
  cropPointer=null;
  if(cropOverlayFrame){cancelAnimationFrame(cropOverlayFrame);cropOverlayFrame=0;}
  if(!preserveCanvas){const canvas=$('cropOverlayCanvas');if(canvas){canvas.width=1;canvas.height=1;}}
}
function requestCropOverlayRender(){
  if(cropOverlayFrame)return;
  cropOverlayFrame=requestAnimationFrame(()=>{cropOverlayFrame=0;renderCropOverlay();});
}
function cropCanvasMetrics(canvas){
  const rect=canvas.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1);
  const width=Math.max(1,Math.round(rect.width)),height=Math.max(1,Math.round(rect.height));
  const pixelWidth=Math.max(1,Math.round(width*dpr)),pixelHeight=Math.max(1,Math.round(height*dpr));
  if(canvas.width!==pixelWidth)canvas.width=pixelWidth;if(canvas.height!==pixelHeight)canvas.height=pixelHeight;
  return{rect,width,height,dpr};
}
function renderCropOverlay(){
  const canvas=$('cropOverlayCanvas');if(!canvas||state.toolMode!=='crop'||!state.files.length||canvas.hidden)return;
  const index=state.selectedIndex??0,meta=state.cropSourceMeta[index];if(!meta)return;
  const crop=ensureCropRect(index,meta.width,meta.height),m=cropCanvasMetrics(canvas),ctx=canvas.getContext('2d',{alpha:true});
  ctx.setTransform(m.dpr,0,0,m.dpr,0,0);ctx.clearRect(0,0,m.width,m.height);
  const x=crop.x*m.width,y=crop.y*m.height,w=crop.w*m.width,h=crop.h*m.height;
  ctx.fillStyle='rgba(10,20,38,.48)';ctx.fillRect(0,0,m.width,m.height);ctx.clearRect(x,y,w,h);
  ctx.save();ctx.strokeStyle='rgba(255,255,255,.98)';ctx.lineWidth=2;ctx.strokeRect(x+1,y+1,Math.max(0,w-2),Math.max(0,h-2));
  ctx.strokeStyle='rgba(255,255,255,.52)';ctx.lineWidth=1;
  for(const f of [1/3,2/3]){ctx.beginPath();ctx.moveTo(x+w*f,y);ctx.lineTo(x+w*f,y+h);ctx.stroke();ctx.beginPath();ctx.moveTo(x,y+h*f);ctx.lineTo(x+w,y+h*f);ctx.stroke();}
  const handle=Math.max(8,Math.min(12,Math.min(m.width,m.height)*.025));ctx.fillStyle='#fff';ctx.strokeStyle='#1675ff';ctx.lineWidth=2;
  [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([hx,hy])=>{const px=Math.max(handle/2,Math.min(m.width-handle/2,hx)),py=Math.max(handle/2,Math.min(m.height-handle/2,hy));ctx.beginPath();ctx.roundRect(px-handle/2,py-handle/2,handle,handle,2);ctx.fill();ctx.stroke();});ctx.restore();
}
function cropPoint(event){
  const rect=$('cropOverlayCanvas').getBoundingClientRect();
  return{x:Math.max(0,Math.min(1,(event.clientX-rect.left)/Math.max(1,rect.width))),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/Math.max(1,rect.height))),rect};
}
function cropHandle(point,crop){
  if(!crop)return null;const tx=16/Math.max(1,point.rect.width),ty=16/Math.max(1,point.rect.height);
  const corners={nw:[crop.x,crop.y],ne:[crop.x+crop.w,crop.y],sw:[crop.x,crop.y+crop.h],se:[crop.x+crop.w,crop.y+crop.h]};
  for(const [name,[x,y]] of Object.entries(corners)){const hx=Math.max(tx/2,Math.min(1-tx/2,x)),hy=Math.max(ty/2,Math.min(1-ty/2,y));if(Math.abs(point.x-hx)<=tx&&Math.abs(point.y-hy)<=ty)return name;}
  return null;
}
function cropContains(point,crop){return!!crop&&point.x>=crop.x&&point.x<=crop.x+crop.w&&point.y>=crop.y&&point.y<=crop.y+crop.h;}
function cropCursor(handle){return handle==='nw'||handle==='se'?'nwse-resize':'nesw-resize';}
function updateCropCursor(event){
  const canvas=$('cropOverlayCanvas');if(!canvas||state.toolMode!=='crop'||!state.files.length)return;
  if(cropPointer){canvas.style.cursor=cropPointer.action==='move'?'grabbing':cropCursor(cropPointer.handle);return;}
  const point=cropPoint(event),crop=state.cropRects[state.selectedIndex??0],handle=cropHandle(point,crop);
  canvas.style.cursor=handle?cropCursor(handle):cropContains(point,crop)?'grab':'default';
}
function resizeCropRect(pointer,point){
  const index=pointer.index,meta=state.cropSourceMeta[index],preset=cropPreset(),origin=pointer.origin,handle=pointer.handle;
  if(!meta)return origin;
  const normalizedRatio=(preset.width/preset.height)*(meta.height/meta.width);
  const anchorX=handle.includes('w')?origin.x+origin.w:origin.x,anchorY=handle.includes('n')?origin.y+origin.h:origin.y;
  const sx=handle.includes('w')?-1:1,sy=handle.includes('n')?-1:1;
  const rawW=Math.abs(point.x-anchorX),rawH=Math.abs(point.y-anchorY),wanted=(rawW+rawH*normalizedRatio)/2;
  const maxW=Math.min(sx>0?1-anchorX:anchorX,(sy>0?1-anchorY:anchorY)*normalizedRatio);
  const minW=Math.min(maxW,Math.max(.04,.04*normalizedRatio));
  const w=Math.max(minW,Math.min(maxW,wanted)),h=w/normalizedRatio;
  return{x:sx>0?anchorX:anchorX-w,y:sy>0?anchorY:anchorY-h,w,h};
}
function onCropPointerDown(event){
  if(state.toolMode!=='crop'||!state.files.length||state.busy)return;
  const canvas=$('cropOverlayCanvas'),index=state.selectedIndex??0,meta=state.cropSourceMeta[index];if(!meta)return;
  const crop=ensureCropRect(index,meta.width,meta.height),point=cropPoint(event),handle=cropHandle(point,crop);
  if(!handle&&!cropContains(point,crop))return;
  event.preventDefault();canvas.setPointerCapture?.(event.pointerId);
  cropPointer={action:handle?'resize':'move',handle,index,start:point,origin:{...crop},before:{...crop},pointerId:event.pointerId};
  canvas.style.cursor=handle?cropCursor(handle):'grabbing';
}
function onCropPointerMove(event){
  if(!cropPointer||event.pointerId!==cropPointer.pointerId){updateCropCursor(event);return;}
  event.preventDefault();const point=cropPoint(event),pointer=cropPointer;
  if(pointer.action==='move'){
    const dx=point.x-pointer.start.x,dy=point.y-pointer.start.y,o=pointer.origin;
    state.cropRects[pointer.index]={...o,x:Math.max(0,Math.min(1-o.w,o.x+dx)),y:Math.max(0,Math.min(1-o.h,o.y+dy))};
  }else state.cropRects[pointer.index]=resizeCropRect(pointer,point);
  requestCropOverlayRender();updateCropCursor(event);
}
function onCropPointerUp(event){
  if(!cropPointer||event.pointerId!==cropPointer.pointerId)return;
  const canvas=$('cropOverlayCanvas'),pointer=cropPointer;cropPointer=null;canvas.releasePointerCapture?.(event.pointerId);
  const changed=JSON.stringify(pointer.before)!==JSON.stringify(state.cropRects[pointer.index]);
  if(changed){invalidateCropResult(pointer.index);renderCard(pointer.index);updateResultsSummary();}
  requestCropOverlayRender();updateCropCursor(event);
}

function updateToolModeUI(){
  const isCompress=state.toolMode==='compress',isWatermark=state.toolMode==='watermark',isRedact=state.toolMode==='redact',isCrop=state.toolMode==='crop',isBackground=state.toolMode==='remove-bg';
  $('compressSettings').hidden=!isCompress;$('watermarkSettings').hidden=!isWatermark;$('redactSettings').hidden=!isRedact;$('cropSettings').hidden=!isCrop;$('backgroundSettings').hidden=!isBackground;
  $('watermarkBatchNote').hidden=!isWatermark;$('gateBadge').hidden=!isCompress||state.compressionMode==='convert';
  $('specLabel').textContent=t(isWatermark?'watermarkSettingsLabel':isRedact?'redactSettingsLabel':isCrop?'cropSettingsLabel':isBackground?'bgSettingsLabel':'outputSpec');
  document.querySelector('#processBtn b').textContent=t(isWatermark?'watermarkProcessButton':isRedact?'redactProcessButton':isCrop?'cropProcessButton':isBackground?'bgProcessButton':state.compressionMode==='convert'?'convertProcessButton':'processButton');
  document.querySelectorAll('#toolModeSwitch [data-tool-mode]').forEach(b=>b.classList.toggle('active',b.dataset.toolMode===state.toolMode));
  $('compressOnlyLimits').hidden=!isCompress||state.compressionMode==='convert';
  const trust1Title=document.querySelector('[data-i18n="trust1Title"]'),trust1Body=document.querySelector('[data-i18n="trust1Body"]'),trust3Title=document.querySelector('[data-i18n="trust3Title"]'),trust3Body=document.querySelector('[data-i18n="trust3Body"]');
  if(isWatermark){trust1Title.textContent=t('watermarkTrust1Title');trust1Body.textContent=t('watermarkTrust1Body');trust3Title.textContent=t('watermarkTrust3Title');trust3Body.textContent=t('watermarkTrust3Body');}
  else if(isRedact){trust1Title.textContent=t('redactTrust1Title');trust1Body.textContent=t('redactTrust1Body');trust3Title.textContent=t('redactTrust3Title');trust3Body.textContent=t('redactTrust3Body');}
  else if(isCrop){trust1Title.textContent=t('cropTrust1Title');trust1Body.textContent=t('cropTrust1Body');trust3Title.textContent=t('cropTrust3Title');trust3Body.textContent=t('cropTrust3Body');}
  else if(isBackground){trust1Title.textContent=t('bgTrust1Title');trust1Body.textContent=t('bgTrust1Body');trust3Title.textContent=t('bgTrust3Title');trust3Body.textContent=t('bgTrust3Body');}
  else{trust1Title.textContent=t('trust1Title');trust1Body.textContent=t('trust1Body');trust3Title.textContent=t('trust3Title');trust3Body.textContent=t('trust3Body');}
  if(isCompress)syncCompressionModeUI();
}
function syncCompressionModeUI(){
  const convert=state.compressionMode==='convert';
  document.querySelectorAll('#compressModeSwitch [data-compress-mode]').forEach(button=>button.classList.toggle('active',button.dataset.compressMode===state.compressionMode));
  $('compressTargetSettings').hidden=convert;$('gateBadge').hidden=state.toolMode!=='compress'||convert;$('compressOnlyLimits').hidden=state.toolMode!=='compress'||convert;
  if(state.toolMode==='compress')document.querySelector('#processBtn b').textContent=t(convert?'convertProcessButton':'processButton');
}
function setCompressionMode(mode){
  if(!['limit','convert'].includes(mode)||state.compressionMode===mode)return;
  state.compressionMode=mode;invalidateAllOutputs();syncCompressionModeUI();updateQueue();renderComparison();
}
async function initFormatCapabilities(){
  const avif=$('formatButtons')?.querySelector('[data-format-capability="avif"]');if(!avif)return;
  const supported=await detectEncoderSupport('image/avif');
  avif.disabled=!supported;avif.classList.toggle('unsupported',!supported);avif.title=supported?'':t('formatUnavailable');
}
function setToolMode(mode){
  if(!['compress','watermark','redact','crop','remove-bg'].includes(mode)||state.toolMode===mode||state.busy)return;
  resetAll();clearWatermarkImage();state.toolMode=mode;state.redactSelected=null;updateToolModeUI();applyPageCopy();updateQueue();
}
function setWatermarkPanel(panel){
  if(!['text','image'].includes(panel))return;
  state.watermarkPanel=panel;
  document.querySelectorAll('#watermarkSubtoolSwitch [data-watermark-panel]').forEach(button=>{
    const active=button.dataset.watermarkPanel===panel;
    button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));
  });
  document.querySelectorAll('[data-watermark-panel-content]').forEach(section=>section.hidden=section.dataset.watermarkPanelContent!==panel);
  closeColorPicker();
}
function updateWatermarkStateIndicators(){
  const textActive=!!$('watermarkText')?.value.trim();
  $('textWatermarkState')?.classList.toggle('configured',textActive);
  $('imageWatermarkState')?.classList.toggle('configured',!!state.watermarkImageFile);
}
let watermarkColorPicker=null,redactColorPicker=null;
function setWatermarkColor(color){return watermarkColorPicker?.setColor(color,true)??false;}
function closeColorPicker(){watermarkColorPicker?.close();redactColorPicker?.close();}
function setWatermarkTextAlign(align){
  if(!['left','center','right'].includes(align)||state.watermarkTextAlign===align)return;
  state.watermarkTextAlign=align;
  document.querySelectorAll('#watermarkAlignButtons [data-align]').forEach(button=>button.classList.toggle('active',button.dataset.align===align));
  watermarkSettingsChanged();
}
function setWatermarkPosition(position){
  if(state.watermarkPosition===position)return;
  state.watermarkPosition=position;
  document.querySelectorAll('#watermarkPositions [data-position]').forEach(b=>b.classList.toggle('active',b.dataset.position===position));
  watermarkSettingsChanged();
}
function setWatermarkImagePosition(position){
  if(state.watermarkImagePosition===position)return;
  state.watermarkImagePosition=position;
  document.querySelectorAll('#watermarkImagePositions [data-position]').forEach(b=>b.classList.toggle('active',b.dataset.position===position));
  watermarkSettingsChanged();
}
function currentDateStamp(){
  const d=new Date();return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}
function applyWatermarkPreset(name){
  const key={bank:'watermarkPresetBankText',job:'watermarkPresetJobText',rent:'watermarkPresetRentText',card:'watermarkPresetCardText'}[name];if(!key)return;
  $('watermarkText').value=template(key,{date:currentDateStamp()});updateWatermarkStateIndicators();watermarkSettingsChanged();
}
function clearWatermarkImage(){
  if(state.watermarkImageFile)clearWatermarkCache(state.watermarkImageFile);
  if(state.watermarkImagePreviewUrl)URL.revokeObjectURL(state.watermarkImagePreviewUrl);
  state.watermarkImageFile=null;state.watermarkImagePreviewUrl=null;
  if($('watermarkImageInput'))$('watermarkImageInput').value='';
  if($('watermarkImageInfo'))$('watermarkImageInfo').hidden=true;
  if($('watermarkImageThumb'))$('watermarkImageThumb').removeAttribute('src');
  if($('watermarkImageName'))$('watermarkImageName').textContent='';
  updateWatermarkStateIndicators();watermarkSettingsChanged();
}
function setWatermarkImage(file){
  if(!file||!file.type.startsWith('image/'))return;
  if(state.watermarkImageFile)clearWatermarkCache(state.watermarkImageFile);
  if(state.watermarkImagePreviewUrl)URL.revokeObjectURL(state.watermarkImagePreviewUrl);
  state.watermarkImageFile=file;state.watermarkImagePreviewUrl=URL.createObjectURL(file);
  $('watermarkImageThumb').src=state.watermarkImagePreviewUrl;$('watermarkImageName').textContent=file.name;$('watermarkImageInfo').hidden=false;
  updateWatermarkStateIndicators();watermarkSettingsChanged();
}

function redactRegionsFor(index){
  if(!state.redactRegions[index])state.redactRegions[index]=[];
  return state.redactRegions[index];
}
function redactHistoryFor(index){
  if(!state.redactHistory[index])state.redactHistory[index]={undo:[],redo:[]};
  return state.redactHistory[index];
}
function cloneRegions(regions){return regions.map(region=>({...region}));}
function redactSettingsKey(index){return JSON.stringify({mode:'redact',regions:redactRegionsFor(index)});}
function invalidateRedactResult(index){
  bumpOutputGeneration();
  const result=state.results[index];if(result?.previewUrl)URL.revokeObjectURL(result.previewUrl);
  state.results[index]=null;state.errors[index]=null;state.processKeys[index]=null;state.resultOptions[index]=null;state.redactView='edit';syncDownloadAvailability();
}
function syncRedactViewSwitch(resultCurrent=false){
  const root=$('redactViewSwitch');if(!root)return;
  root.hidden=state.toolMode!=='redact'||!resultCurrent;
  root.querySelectorAll('[data-redact-view]').forEach(button=>{button.classList.toggle('active',button.dataset.redactView===state.redactView);button.disabled=button.dataset.redactView==='compare'&&!resultCurrent;});
}
function setRedactView(view){
  if(!['edit','compare'].includes(view))return;
  const index=state.selectedIndex??0,result=state.results[index],current=result?.operation==='redact'&&state.processKeys[index]===redactSettingsKey(index);
  if(view==='compare'&&!current)return;
  if(state.redactView===view){syncRedactViewSwitch(current);return;}
  state.redactView=view;syncRedactViewSwitch(current);renderComparison();
  if(view==='edit')scheduleRedactPreview(0,true,true);
}
function redactModeLabel(mode){
  return t(mode==='blur'?'redactBlur':mode==='block'?'redactBlock':'redactPixelate');
}
function renderRedactLayers(){
  const list=$('redactLayerList');if(!list)return;
  if(!state.files.length||state.selectedIndex===null){list.innerHTML=`<div class="redact-layer-empty">${escapeHtml(t('redactLayerEmpty'))}</div>`;return;}
  const regions=redactRegionsFor(state.selectedIndex);
  if(!regions.length){list.innerHTML=`<div class="redact-layer-empty">${escapeHtml(t('redactLayerEmpty'))}</div>`;return;}
  list.innerHTML=regions.map((region,i)=>{
    const selected=i===state.redactSelected,detail=region.mode==='block'?(region.color||'#111827').toUpperCase():`${Math.round(region.strength||45)}%`;
    const swatchStyle=region.mode==='block'?` style="--layer-color:${escapeHtml(region.color||'#111827')}"`:'';
    return `<div class="redact-layer-row${selected?' selected':''}" data-redact-layer-row="${i}"><button type="button" class="redact-layer-main" data-redact-layer-index="${i}" aria-pressed="${selected}"><span class="redact-layer-swatch ${region.mode}"${swatchStyle}></span><span class="redact-layer-copy"><b>${escapeHtml(t('redactLayer'))} ${i+1}</b><small><span data-redact-layer-type>${escapeHtml(redactModeLabel(region.mode))}</span> · <span data-redact-layer-detail>${escapeHtml(detail)}</span></small></span></button><button type="button" class="redact-layer-remove" data-redact-layer-delete="${i}" aria-label="${escapeHtml(t('deleteRegion'))}" title="${escapeHtml(t('deleteRegion'))}">×</button></div>`;
  }).join('');
}
function updateRedactLayerSelection(){
  document.querySelectorAll('#redactLayerList [data-redact-layer-row]').forEach(row=>{
    const index=Number(row.dataset.redactLayerRow),selected=index===state.redactSelected;
    row.classList.toggle('selected',selected);
    row.querySelector('[data-redact-layer-index]')?.setAttribute('aria-pressed',String(selected));
  });
}
function updateRedactLayerDetail(index){
  const row=document.querySelector(`#redactLayerList [data-redact-layer-row="${index}"]`),region=state.selectedIndex===null?null:redactRegionsFor(state.selectedIndex)[index];
  if(!row||!region)return;
  const type=row.querySelector('[data-redact-layer-type]'),detail=row.querySelector('[data-redact-layer-detail]'),swatch=row.querySelector('.redact-layer-swatch');
  if(type)type.textContent=redactModeLabel(region.mode);
  if(detail)detail.textContent=region.mode==='block'?(region.color||'#111827').toUpperCase():`${Math.round(region.strength||45)}%`;
  if(swatch){swatch.className=`redact-layer-swatch ${region.mode}`;swatch.style.setProperty('--layer-color',region.color||'#111827');}
}
function updateRedactActions(renderLayers=true){
  if(!state.files.length||state.selectedIndex===null){
    $('redactRegionCount').textContent='0';$('redactUndo').disabled=true;$('redactRedo').disabled=true;$('redactDelete').disabled=true;if(renderLayers)renderRedactLayers();else updateRedactLayerSelection();return;
  }
  const index=state.selectedIndex,regions=redactRegionsFor(index),history=redactHistoryFor(index);
  $('redactRegionCount').textContent=String(regions.length);
  $('redactUndo').disabled=!history.undo.length;
  $('redactRedo').disabled=!history.redo.length;
  $('redactDelete').disabled=state.redactSelected===null||!regions[state.redactSelected];
  if(renderLayers)renderRedactLayers();else updateRedactLayerSelection();
}
function setRedactMode(mode){
  if(!['pixelate','blur','block'].includes(mode))return;
  state.redactMode=mode;
  document.querySelectorAll('#redactModeButtons [data-redact-mode]').forEach(button=>button.classList.toggle('active',button.dataset.redactMode===mode));
  $('redactStrengthWrap').hidden=mode==='block';$('redactColorWrap').hidden=mode!=='block';
}
let redactStrengthEdit=null;
function beginRedactStrengthEdit(){
  if(redactStrengthEdit||state.selectedIndex===null||state.redactSelected===null)return;
  const region=redactRegionsFor(state.selectedIndex)[state.redactSelected];
  if(!region||region.mode==='block')return;
  redactStrengthEdit={index:state.selectedIndex,before:cloneRegions(redactRegionsFor(state.selectedIndex))};
}
function setRedactStrength(value,applySelected=true){
  state.redactStrength=Math.max(1,Math.min(100,Number(value)||45));
  const input=$('redactStrength');input.value=String(state.redactStrength);$('redactStrengthValue').textContent=`${state.redactStrength}%`;syncRangeVisual(input);
  if(!applySelected||state.selectedIndex===null||state.redactSelected===null)return;
  const region=redactRegionsFor(state.selectedIndex)[state.redactSelected];
  if(!region||region.mode==='block'||region.strength===state.redactStrength)return;
  beginRedactStrengthEdit();region.strength=state.redactStrength;invalidateRedactResult(state.selectedIndex);updateRedactLayerDetail(state.redactSelected);
}
function finishRedactStrengthEdit(){
  if(!redactStrengthEdit)return;
  const edit=redactStrengthEdit;redactStrengthEdit=null;
  if(JSON.stringify(edit.before)!==JSON.stringify(redactRegionsFor(edit.index)))commitRedactHistory(edit.index,edit.before);
}
function syncRedactControlsFromRegion(region){
  if(!region)return;
  setRedactMode(region.mode||'pixelate');
  if(region.mode!=='block')setRedactStrength(region.strength||45,false);
  if(region.color){state.redactColor=region.color;redactColorPicker?.setColor(region.color,false);}
}
function currentRedactStyle(){
  return{mode:state.redactMode,strength:state.redactStrength,color:state.redactColor};
}
function commitRedactHistory(index,before){
  const history=redactHistoryFor(index);
  history.undo.push(cloneRegions(before));
  if(history.undo.length>60)history.undo.shift();
  history.redo=[];
  invalidateRedactResult(index);updateRedactActions();renderCard(index);updateResultsSummary();requestRedactOverlayRender();scheduleRedactPreview(0,true,true);
}
function undoRedact(){
  const index=state.selectedIndex??0,history=redactHistoryFor(index);
  if(!history.undo.length)return;
  history.redo.push(cloneRegions(redactRegionsFor(index)));
  state.redactRegions[index]=history.undo.pop();state.redactSelected=null;
  invalidateRedactResult(index);updateRedactActions();renderCard(index);updateResultsSummary();requestRedactOverlayRender();scheduleRedactPreview(0,true,true);
}
function redoRedact(){
  const index=state.selectedIndex??0,history=redactHistoryFor(index);
  if(!history.redo.length)return;
  history.undo.push(cloneRegions(redactRegionsFor(index)));
  state.redactRegions[index]=history.redo.pop();state.redactSelected=null;
  invalidateRedactResult(index);updateRedactActions();renderCard(index);updateResultsSummary();requestRedactOverlayRender();scheduleRedactPreview(0,true,true);
}
function deleteRedactRegion(){
  const index=state.selectedIndex??0,regions=redactRegionsFor(index),selected=state.redactSelected;
  if(selected===null||!regions[selected])return;
  const before=cloneRegions(regions);regions.splice(selected,1);state.redactSelected=null;commitRedactHistory(index,before);
}
function selectRedactLayer(layerIndex){
  if(state.selectedIndex===null)return;
  const regions=redactRegionsFor(state.selectedIndex);if(!regions[layerIndex])return;
  state.redactSelected=layerIndex;syncRedactControlsFromRegion(regions[layerIndex]);updateRedactActions(false);renderRedactOverlay();
}
function deleteRedactLayer(layerIndex){
  if(state.selectedIndex===null)return;
  const regions=redactRegionsFor(state.selectedIndex);if(!regions[layerIndex])return;
  state.redactSelected=layerIndex;deleteRedactRegion();
}
let redactPreviewTimer=0,redactPreviewBusy=false,redactPreviewQueued=false,redactPreviewForceAfterBusy=false;
function clearRedactPreview(preserveCanvas=false){
  state.redactPreviewToken++;redactPreviewQueued=false;redactPreviewForceAfterBusy=false;
  if(redactPreviewTimer)clearTimeout(redactPreviewTimer);redactPreviewTimer=0;
  state.redactPreviewIndex=null;state.redactPreviewMeta=null;state.redactSelected=null;redactPointer=null;redactStrengthEdit=null;
  const canvas=$('redactCanvas'),overlay=$('redactOverlayCanvas');
  if(!preserveCanvas&&canvas){canvas.width=1;canvas.height=1;}
  if(!preserveCanvas&&overlay){overlay.width=1;overlay.height=1;}
  if(overlay)overlay.style.cursor='crosshair';
}
async function requestRedactPreviewFrame(){
  if(redactPreviewBusy||!redactPreviewQueued)return;
  redactPreviewQueued=false;redactPreviewBusy=true;
  const token=state.redactPreviewToken;
  await updateRedactPreview(token);
  redactPreviewBusy=false;
  if(redactPreviewQueued){
    const force=redactPreviewForceAfterBusy;redactPreviewForceAfterBusy=false;
    scheduleRedactPreview(force?0:85,false,force);
  }
}
function scheduleRedactPreview(delay=85,bumpToken=true,force=false){
  if(state.toolMode!=='redact'||!state.files.length)return;
  if(bumpToken)state.redactPreviewToken++;
  redactPreviewQueued=true;
  if(force){
    redactPreviewForceAfterBusy=true;
    if(redactPreviewTimer){clearTimeout(redactPreviewTimer);redactPreviewTimer=0;}
    if(!redactPreviewBusy)redactPreviewTimer=setTimeout(()=>{redactPreviewTimer=0;redactPreviewForceAfterBusy=false;requestRedactPreviewFrame();},0);
    return;
  }
  if(redactPreviewBusy||redactPreviewTimer)return;
  redactPreviewTimer=setTimeout(()=>{redactPreviewTimer=0;requestRedactPreviewFrame();},delay);
}
function drawRedactSelection(canvas,index){
  const region=redactRegionsFor(index)[state.redactSelected];if(!region)return;
  const ctx=canvas.getContext('2d'),x=region.x*canvas.width,y=region.y*canvas.height,w=region.w*canvas.width,h=region.h*canvas.height;
  const handle=Math.max(10,Math.min(16,Math.round(Math.min(canvas.width,canvas.height)*.02)));
  ctx.save();ctx.strokeStyle='#1675ff';ctx.lineWidth=Math.max(2,canvas.width/500);ctx.setLineDash([8,5]);ctx.strokeRect(x,y,w,h);ctx.setLineDash([]);
  ctx.fillStyle='#fff';ctx.strokeStyle='#1675ff';ctx.lineWidth=Math.max(2,canvas.width/600);
  [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([hx,hy])=>{ctx.beginPath();ctx.rect(hx-handle/2,hy-handle/2,handle,handle);ctx.fill();ctx.stroke();});
  ctx.restore();
}
let redactOverlayFrame=0;
function requestRedactOverlayRender(){
  if(redactOverlayFrame)return;
  redactOverlayFrame=requestAnimationFrame(()=>{redactOverlayFrame=0;renderRedactOverlay();});
}
function renderRedactOverlay(){
  const overlay=$('redactOverlayCanvas'),effect=$('redactCanvas');
  if(!overlay||!effect||state.toolMode!=='redact'||!state.files.length)return;
  const width=Math.max(1,effect.width||state.redactPreviewMeta?.width||1),height=Math.max(1,effect.height||state.redactPreviewMeta?.height||1);
  if(overlay.width!==width)overlay.width=width;if(overlay.height!==height)overlay.height=height;
  const ctx=overlay.getContext('2d',{alpha:true});ctx.clearRect(0,0,overlay.width,overlay.height);
  drawRedactSelection(overlay,state.selectedIndex??0);
}
async function updateRedactPreview(token=state.redactPreviewToken){
  if(state.toolMode!=='redact'||!state.files.length)return;
  const index=Number.isInteger(state.selectedIndex)?state.selectedIndex:0,file=state.files[index];if(!file)return;
  try{
    const preview=await renderRedactPreview(file,cloneRegions(redactRegionsFor(index)),redactPointer?760:1200);
    if(token!==state.redactPreviewToken||state.toolMode!=='redact'||index!==state.selectedIndex)return;
    const canvas=$('redactCanvas'),ctx=canvas.getContext('2d',{alpha:true});
    canvas.width=preview.width;canvas.height=preview.height;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(preview.canvas,0,0);
    state.redactPreviewIndex=index;state.redactPreviewMeta={width:preview.width,height:preview.height,sourceWidth:preview.sourceWidth,sourceHeight:preview.sourceHeight};
    updateRedactActions(false);renderComparison();
  }catch(error){
    if(token!==state.redactPreviewToken)return;
    console.warn('Redact live preview failed:',error);
  }
}
function redactPoint(event){
  const rect=$('redactOverlayCanvas').getBoundingClientRect();
  return{x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height)),rect};
}
function redactRegionFromPoints(a,b){
  return{x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(b.x-a.x),h:Math.abs(b.y-a.y),...currentRedactStyle()};
}
function redactHitRegion(point,regions){
  for(let i=regions.length-1;i>=0;i--){const r=regions[i];if(point.x>=r.x&&point.x<=r.x+r.w&&point.y>=r.y&&point.y<=r.y+r.h)return i;}
  return-1;
}
function redactHandle(point,region,rect){
  if(!region)return null;
  const tx=16/Math.max(1,rect.width),ty=16/Math.max(1,rect.height);
  const corners={nw:[region.x,region.y],ne:[region.x+region.w,region.y],sw:[region.x,region.y+region.h],se:[region.x+region.w,region.y+region.h]};
  for(const [name,[x,y]]of Object.entries(corners))if(Math.abs(point.x-x)<=tx&&Math.abs(point.y-y)<=ty)return name;
  return null;
}
function redactCursorForHandle(handle){return handle==='nw'||handle==='se'?'nwse-resize':'nesw-resize';}
function updateRedactCursor(event){
  const canvas=$('redactOverlayCanvas');if(!canvas||state.toolMode!=='redact'||!state.files.length)return;
  if(redactPointer){
    canvas.style.cursor=redactPointer.action==='resize'?redactCursorForHandle(redactPointer.handle):redactPointer.action==='move'?'grabbing':'crosshair';return;
  }
  const point=redactPoint(event),regions=redactRegionsFor(state.selectedIndex??0),selected=state.redactSelected===null?null:regions[state.redactSelected],handle=redactHandle(point,selected,point.rect);
  if(handle){canvas.style.cursor=redactCursorForHandle(handle);return;}
  canvas.style.cursor=redactHitRegion(point,regions)>=0?'grab':'crosshair';
}
let redactPointer=null;
function onRedactPointerDown(event){
  if(state.toolMode!=='redact'||!state.files.length||state.busy)return;
  const overlay=$('redactOverlayCanvas');event.preventDefault();overlay.setPointerCapture?.(event.pointerId);
  const index=state.selectedIndex??0,regions=redactRegionsFor(index),point=redactPoint(event),before=cloneRegions(regions);
  const selectedRegion=state.redactSelected===null?null:regions[state.redactSelected],handle=redactHandle(point,selectedRegion,point.rect);
  if(handle&&selectedRegion){
    redactPointer={action:'resize',index,start:point,before,region:{...selectedRegion},handle,pointerId:event.pointerId};
    overlay.style.cursor=redactCursorForHandle(handle);return;
  }
  const hit=redactHitRegion(point,regions);
  if(hit>=0){
    state.redactSelected=hit;syncRedactControlsFromRegion(regions[hit]);
    redactPointer={action:'move',index,start:point,before,region:{...regions[hit]},pointerId:event.pointerId};
    overlay.style.cursor='grabbing';updateRedactActions(false);requestRedactOverlayRender();return;
  }
  state.redactSelected=regions.length;
  regions.push(redactRegionFromPoints(point,point));
  redactPointer={action:'draw',index,start:point,before,pointerId:event.pointerId};
  overlay.style.cursor='crosshair';updateRedactActions();requestRedactOverlayRender();
}
function onRedactPointerMove(event){
  if(!redactPointer||event.pointerId!==redactPointer.pointerId){updateRedactCursor(event);return;}
  event.preventDefault();updateRedactCursor(event);
  const point=redactPoint(event),regions=redactRegionsFor(redactPointer.index),selected=state.redactSelected;
  if(selected===null||!regions[selected])return;
  if(redactPointer.action==='draw'){
    regions[selected]={...redactRegionFromPoints(redactPointer.start,point)};
  }else if(redactPointer.action==='move'){
    const origin=redactPointer.region,dx=point.x-redactPointer.start.x,dy=point.y-redactPointer.start.y;
    regions[selected]={...origin,x:Math.max(0,Math.min(1-origin.w,origin.x+dx)),y:Math.max(0,Math.min(1-origin.h,origin.y+dy))};
  }else if(redactPointer.action==='resize'){
    const origin=redactPointer.region,handle=redactPointer.handle;
    const anchorX=handle.includes('w')?origin.x+origin.w:origin.x,anchorY=handle.includes('n')?origin.y+origin.h:origin.y;
    const x=Math.max(0,Math.min(1,Math.min(point.x,anchorX))),y=Math.max(0,Math.min(1,Math.min(point.y,anchorY)));
    const maxX=Math.max(0,Math.min(1,Math.max(point.x,anchorX))),maxY=Math.max(0,Math.min(1,Math.max(point.y,anchorY)));
    regions[selected]={...origin,x,y,w:Math.max(.005,maxX-x),h:Math.max(.005,maxY-y)};
  }
  requestRedactOverlayRender();
}
function onRedactPointerUp(event){
  if(!redactPointer||event.pointerId!==redactPointer.pointerId)return;
  const overlay=$('redactOverlayCanvas'),pointer=redactPointer;redactPointer=null;overlay.releasePointerCapture?.(event.pointerId);
  const regions=redactRegionsFor(pointer.index),selected=state.redactSelected,region=selected===null?null:regions[selected];
  if(pointer.action==='draw'&&(!region||region.w<.008||region.h<.008)){
    state.redactRegions[pointer.index]=cloneRegions(pointer.before);state.redactSelected=null;updateRedactActions();requestRedactOverlayRender();scheduleRedactPreview(0,true,true);updateRedactCursor(event);return;
  }
  if(JSON.stringify(pointer.before)!==JSON.stringify(regions))commitRedactHistory(pointer.index,pointer.before);
  else{updateRedactActions(false);requestRedactOverlayRender();}
  updateRedactCursor(event);
}

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
  if(/encode_unsupported/.test(message))return t('formatUnavailableError');
  if(/^too_large:/.test(message))return t('failTooLarge');
  if(/ai_mask|background ai|model|onnx|transformers/i.test(message))return t('bgAiInferenceError');
  return /decode_failed|heic|decoder|image/i.test(message)?t('failDecode'):t('failUnknown');
}
function selectedClass(index) { return state.selectedIndex===index?' selected':''; }
function updateComparisonPosition(value=state.comparePosition) {
  state.comparePosition=Math.max(0,Math.min(100,Number(value)||0));
  const stage=$('comparisonStage'); if(stage) stage.style.setProperty('--compare-position',`${state.comparePosition}%`);
  const range=$('compareRange'); if(range&&Number(range.value)!==state.comparePosition) range.value=String(state.comparePosition);
}
function fitPreviewSurface(width,height){
  const panel=$('comparisonPanel'),stage=$('comparisonStage'),surface=$('previewSurface');
  width=Number(width)||0;height=Number(height)||0;
  if(!panel||!stage||!surface||width<=0||height<=0)return;
  const panelStyle=getComputedStyle(panel),stageStyle=getComputedStyle(stage);
  const contentWidth=Math.max(180,panel.clientWidth-parseFloat(panelStyle.paddingLeft)-parseFloat(panelStyle.paddingRight));
  const padX=parseFloat(stageStyle.paddingLeft)+parseFloat(stageStyle.paddingRight);
  const padY=parseFloat(stageStyle.paddingTop)+parseFloat(stageStyle.paddingBottom);
  const maxSurfaceWidth=Math.max(150,contentWidth-padX),maxSurfaceHeight=innerWidth<=700?390:520;
  const scale=Math.min(maxSurfaceWidth/width,maxSurfaceHeight/height);
  const displayWidth=Math.max(1,Math.round(width*scale)),displayHeight=Math.max(1,Math.round(height*scale));
  surface.style.width=`${displayWidth}px`;surface.style.height=`${displayHeight}px`;
  stage.style.width=`${Math.min(contentWidth,displayWidth+padX)}px`;stage.style.height=`${displayHeight+padY}px`;
  stage.dataset.orientation=height>width?'portrait':width>height?'landscape':'square';
}
function fitCurrentPreviewSurface(){
  if(!state.files.length)return;
  const index=state.selectedIndex??0,result=state.results[index];
  if(state.toolMode==='watermark'&&state.liveWatermarkPreviewMeta)return fitPreviewSurface(state.liveWatermarkPreviewMeta.width,state.liveWatermarkPreviewMeta.height);
  if(state.toolMode==='redact'&&state.redactPreviewMeta)return fitPreviewSurface(state.redactPreviewMeta.width,state.redactPreviewMeta.height);
  if(state.toolMode==='crop'&&state.cropSourceMeta[index])return fitPreviewSurface(state.cropSourceMeta[index].width,state.cropSourceMeta[index].height);
  if(state.toolMode==='remove-bg'&&state.bgPreviewMeta)return fitPreviewSurface(state.bgPreviewMeta.width,state.bgPreviewMeta.height);
  if(result?.outputWidth&&result?.outputHeight)return fitPreviewSurface(result.outputWidth,result.outputHeight);
  const original=$('compareOriginal');if(original?.naturalWidth&&original?.naturalHeight)fitPreviewSurface(original.naturalWidth,original.naturalHeight);
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
function setImageSource(image,url,alt=''){
  if(!image)return;
  image.alt=alt;
  if((image.getAttribute('src')||'')!==(url||''))image.src=url||'';
}
function renderComparison() {
  const panel=$('comparisonPanel'); if(!panel)return;
  if(!state.files.length){panel.hidden=true;return;}
  chooseDefaultResult();
  const index=state.selectedIndex??0,file=state.files[index],result=state.results[index],error=state.errors[index];
  if(!file){panel.hidden=true;return;} panel.hidden=false;
  const original=$('compareOriginal'),liveCanvas=$('watermarkLiveCanvas'),redactCanvas=$('redactCanvas'),redactOverlay=$('redactOverlayCanvas'),cropOverlay=$('cropOverlayCanvas'),backgroundCanvas=$('backgroundPreviewCanvas'),previewSurface=$('previewSurface'),redactLayersDock=$('redactLayersDock'),originalBadge=$('compareOriginalBadge'),output=$('compareOutput'),mask=$('compareOutputMask'),badge=$('compareOutputBadge'),divider=$('compareDivider'),range=$('compareRange'),failure=$('compareFailure'),unavailable=$('compareUnavailable');
  const comparisonHint=document.querySelector('.comparison-copy-actions>span'),redactViewSwitch=$('redactViewSwitch'),backgroundInspectBtn=$('backgroundInspectBtn');
  failure.hidden=true;$('compareFailureText').textContent='';unavailable.hidden=true;
  mask.hidden=true;badge.hidden=true;divider.hidden=true;range.hidden=true;originalBadge.hidden=false;liveCanvas.hidden=true;redactCanvas.hidden=true;redactOverlay.hidden=true;cropOverlay.hidden=true;backgroundCanvas.hidden=true;redactLayersDock.hidden=true;redactViewSwitch.hidden=true;backgroundInspectBtn.hidden=true;original.hidden=false;previewSurface.classList.toggle('checkerboard',state.toolMode==='remove-bg');
  $('compareFilename').textContent=file.name;$('compareOriginalSize').textContent=formatBytes(file.size);

  if(state.toolMode==='watermark'){
    document.querySelector('.comparison-copy p').textContent=t('watermarkPreviewLabel');$('comparisonTitle').textContent=t('watermarkLiveTitle');comparisonHint.textContent=t('watermarkLiveHint');originalBadge.hidden=true;
    const liveReady=state.liveWatermarkPreviewIndex===index&&state.liveWatermarkPreviewMeta;
    liveCanvas.hidden=!liveReady;original.hidden=false;
    const ready=()=>{unavailable.hidden=true;const meta=state.liveWatermarkPreviewMeta;fitPreviewSurface(meta?.width||original.naturalWidth,meta?.height||original.naturalHeight);$('compareDimensions').textContent=sourceDimensionsText(meta?.sourceWidth||original.naturalWidth,meta?.sourceHeight||original.naturalHeight);};
    original.onload=ready;original.onerror=()=>{unavailable.hidden=false;};setImageSource(original,state.previews[index]||'',`${file.name} ${t('livePreview')}`);if(original.complete&&original.naturalWidth)ready();
    $('compareDimensions').textContent=sourceDimensionsText(state.liveWatermarkPreviewMeta?.sourceWidth,state.liveWatermarkPreviewMeta?.sourceHeight);
    $('compareSaving').textContent=t('livePreview');$('compareStatus').className='status pass';$('compareStatus').textContent=t('live');
    document.querySelectorAll('.result-card').forEach(card=>card.classList.toggle('selected',Number(card.dataset.resultIndex)===index));return;
  }

  if(state.toolMode==='redact'){
    redactLayersDock.hidden=false;
    const resultCurrent=result?.operation==='redact'&&state.processKeys[index]===redactSettingsKey(index);
    const regions=redactRegionsFor(index).length;
    syncRedactViewSwitch(resultCurrent);
    if(resultCurrent&&state.redactView==='compare'){
      document.querySelector('.comparison-copy p').textContent=t('redactCompareLabel');$('comparisonTitle').textContent=t('redactCompareTitle');comparisonHint.textContent=t('redactCompareHint');
      mask.hidden=false;badge.hidden=false;divider.hidden=false;range.hidden=false;originalBadge.hidden=false;original.hidden=false;
      original.onload=()=>{unavailable.hidden=true;fitPreviewSurface(result.outputWidth,result.outputHeight);};original.onerror=()=>{unavailable.hidden=false;};setImageSource(original,state.previews[index]||'',`${file.name} ${t('original')}`);
      if(!result.previewUrl)result.previewUrl=safeUrl(result.blob);setImageSource(output,result.previewUrl,`${file.name} ${t('redacted')}`);badge.querySelector('span').textContent=t('redacted');
      $('compareOutputSize').textContent=formatBytes(result.blob.size);$('compareDimensions').textContent=sourceDimensionsText(result.originalWidth,result.originalHeight);
      $('compareSaving').textContent=`${regions} ${t('redactRegions')}`;$('compareStatus').className='status pass';$('compareStatus').textContent=t('ready');fitPreviewSurface(result.outputWidth,result.outputHeight);updateComparisonPosition();
      document.querySelectorAll('.result-card').forEach(card=>card.classList.toggle('selected',Number(card.dataset.resultIndex)===index));return;
    }
    document.querySelector('.comparison-copy p').textContent=t('redactPreviewLabel');$('comparisonTitle').textContent=t('redactPreviewTitle');comparisonHint.textContent=resultCurrent?t('redactResumeHint'):t('redactPreviewHint');originalBadge.hidden=true;
    const liveReady=state.redactPreviewIndex===index&&state.redactPreviewMeta;
    redactCanvas.hidden=!liveReady;redactOverlay.hidden=!liveReady;original.hidden=!!liveReady;
    if(liveReady){fitPreviewSurface(state.redactPreviewMeta.width,state.redactPreviewMeta.height);renderRedactOverlay();}
    else{original.onload=()=>{unavailable.hidden=true;fitPreviewSurface(original.naturalWidth,original.naturalHeight);};original.onerror=()=>{unavailable.hidden=false;};setImageSource(original,state.previews[index]||'',`${file.name} ${t('redactPreviewTitle')}`);}
    $('compareDimensions').textContent=sourceDimensionsText(state.redactPreviewMeta?.sourceWidth,state.redactPreviewMeta?.sourceHeight);
    $('compareSaving').textContent=`${regions} ${t('redactRegions')}`;$('compareStatus').className='status pass';$('compareStatus').textContent=t('editing');
    document.querySelectorAll('.result-card').forEach(card=>card.classList.toggle('selected',Number(card.dataset.resultIndex)===index));return;
  }

  if(state.toolMode==='crop'){
    document.querySelector('.comparison-copy p').textContent=t('cropPreviewLabel');$('comparisonTitle').textContent=t('cropPreviewTitle');comparisonHint.textContent=t('cropPreviewHint');originalBadge.hidden=true;cropOverlay.hidden=false;original.hidden=false;
    const sourceUrl=state.previews[index]||'';
    const ready=()=>{
      if(state.toolMode!=='crop'||state.selectedIndex!==index||!original.naturalWidth||!original.naturalHeight)return;
      unavailable.hidden=true;ensureCropRect(index,original.naturalWidth,original.naturalHeight);fitPreviewSurface(original.naturalWidth,original.naturalHeight);$('compareDimensions').textContent=sourceDimensionsText(original.naturalWidth,original.naturalHeight);requestCropOverlayRender();
    };
    original.onload=ready;original.onerror=()=>{unavailable.hidden=false;cropOverlay.hidden=true;};setImageSource(original,sourceUrl,`${file.name} ${t('cropPreviewTitle')}`);if(original.complete&&original.naturalWidth)ready();
    $('compareDimensions').textContent=sourceDimensionsText(state.cropSourceMeta[index]?.width,state.cropSourceMeta[index]?.height);$('compareSaving').textContent=t('editing');$('compareStatus').className='status pass';$('compareStatus').textContent=t('editing');
    document.querySelectorAll('.result-card').forEach(card=>card.classList.toggle('selected',Number(card.dataset.resultIndex)===index));return;
  }

  if(state.toolMode==='remove-bg'){
    const aiModel=getBackgroundAIState();
    document.querySelector('.comparison-copy p').textContent=t('bgPreviewLabel');$('comparisonTitle').textContent=t('bgPreviewTitle');comparisonHint.textContent=state.bgEngine==='ai'&&!aiModel.ready?(aiModel.cached?t('bgPreviewCachedLoading'):t('bgPreviewNeedsModel')):t('bgPreviewHint');originalBadge.hidden=true;
    const liveReady=state.bgPreviewIndex===index&&state.bgPreviewMeta;
    backgroundInspectBtn.hidden=!liveReady;
    backgroundCanvas.hidden=!liveReady;original.hidden=!!liveReady;
    if(liveReady){fitPreviewSurface(state.bgPreviewMeta.width,state.bgPreviewMeta.height);$('compareDimensions').textContent=sourceDimensionsText(state.bgPreviewMeta.sourceWidth,state.bgPreviewMeta.sourceHeight);}
    else{original.onload=()=>{unavailable.hidden=true;fitPreviewSurface(original.naturalWidth,original.naturalHeight);$('compareDimensions').textContent=sourceDimensionsText(original.naturalWidth,original.naturalHeight);};original.onerror=()=>{unavailable.hidden=false;};setImageSource(original,state.previews[index]||'',`${file.name} ${t('bgPreviewTitle')}`);}
    $('compareSaving').textContent=t(state.bgEngine==='ai'?'bgEngineAi':'bgEngineDemo');$('compareStatus').className=`status ${state.bgEngine==='ai'&&aiModel.ready?'pass':'pending'}`;$('compareStatus').textContent=state.bgEngine==='ai'?(aiModel.ready?t('bgStatusReady'):aiModel.cached?t('bgStatusCacheLoading'):t('bgStatusNeedsModel')):t('bgPrototypeStatus');
    document.querySelectorAll('.result-card').forEach(card=>card.classList.toggle('selected',Number(card.dataset.resultIndex)===index));return;
  }

  original.onload=()=>{unavailable.hidden=true;fitPreviewSurface(original.naturalWidth,original.naturalHeight);$('compareDimensions').textContent=sourceDimensionsText(result?.originalWidth||original.naturalWidth,result?.originalHeight||original.naturalHeight);};original.onerror=()=>{unavailable.hidden=false;};setImageSource(original,state.previews[index]||'',`${file.name} ${t('original')}`);
  const showCompare=!!result?.metTarget;
  if(showCompare){
    const converted=result.operation==='convert';document.querySelector('.comparison-copy p').textContent=t(converted?'convertCompareLabel':'compareLabel');$('comparisonTitle').textContent=t(converted?'convertCompareTitle':'compareTitle');comparisonHint.textContent=t(converted?'convertCompareHint':'compareHint');badge.querySelector('span').textContent=t(converted?'converted':'compressed');
    mask.hidden=false;badge.hidden=false;divider.hidden=false;range.hidden=false;
    if(!result.previewUrl)result.previewUrl=safeUrl(result.blob);setImageSource(output,result.previewUrl,`${file.name} ${t(converted?'converted':'compressed')}`);
    fitPreviewSurface(result.outputWidth,result.outputHeight);
    $('compareOutputSize').textContent=formatBytes(result.blob.size);$('compareDimensions').textContent=sourceDimensionsText(result.originalWidth,result.originalHeight);
    const saved=Math.max(0,Math.round((1-result.blob.size/file.size)*100));$('compareSaving').textContent=converted?formatName(result.outputType):`${saved}% ${t('smaller')}`;$('compareStatus').className='status pass';$('compareStatus').textContent=t(converted?'ready':'pass');updateComparisonPosition();
  }else{
    document.querySelector('.comparison-copy p').textContent=t('previewLabel');$('comparisonTitle').textContent=t('previewTitle');comparisonHint.textContent=t(state.compressionMode==='convert'?'convertPreviewHint':'previewHint');$('compareOutputSize').textContent='—';
    $('compareDimensions').textContent=sourceDimensionsText(original.naturalWidth,original.naturalHeight);$('compareSaving').textContent=t('previewOnly');
    $('compareStatus').className=`status ${result||error?'fail':'pending'}`;$('compareStatus').textContent=result||error?t('failed'):t('preview');
    if(result||error){failure.hidden=false;$('compareFailureText').textContent=result?failureReason(result,state.resultOptions[index]):errorReason(error);}
  }
  document.querySelectorAll('.result-card').forEach(card=>card.classList.toggle('selected',Number(card.dataset.resultIndex)===index));
}
function warmImage(url){
  if(!url)return Promise.resolve();
  return new Promise(resolve=>{const image=new Image();image.onload=image.onerror=()=>resolve();image.src=url;});
}
function selectResult(index,manual=true){
  if(!Number.isInteger(index)||index<0||index>=state.files.length)return;
  if(state.selectedIndex===index){if(manual)state.selectionManual=true;return;}
  state.selectedIndex=index;if(manual)state.selectionManual=true;state.comparePosition=50;state.redactSelected=null;
  $('compareFilename').textContent=state.files[index]?.name||'—';
  document.querySelectorAll('.result-card').forEach(card=>card.classList.toggle('selected',Number(card.dataset.resultIndex)===index));
  if(state.toolMode==='watermark'){clearLiveWatermarkPreview(true);scheduleWatermarkPreview();return;}
  if(state.toolMode==='remove-bg'){clearBackgroundPreview(true);scheduleBackgroundPreview();return;}
  if(state.toolMode==='redact'){
    clearRedactPreview(true);updateRedactActions();
    const result=state.results[index],current=result?.operation==='redact'&&state.processKeys[index]===redactSettingsKey(index);
    if(current){if(!result.previewUrl)result.previewUrl=safeUrl(result.blob);Promise.all([warmImage(state.previews[index]),warmImage(result.previewUrl)]).then(()=>{if(state.selectedIndex===index)renderComparison();});}
    else scheduleRedactPreview(0);
    return;
  }
  if(state.toolMode==='crop'){renderComparison();requestCropOverlayRender();return;}
  const result=state.results[index];if(result&&!result.previewUrl)result.previewUrl=safeUrl(result.blob);
  Promise.all([warmImage(state.previews[index]),warmImage(result?.previewUrl)]).then(()=>{if(state.selectedIndex===index)renderComparison();});
}

function removeButtonHtml(index){return `<button class="remove-result" type="button" data-remove-index="${index}" aria-label="${escapeHtml(t('removeImage'))}" title="${escapeHtml(t('removeImage'))}">×</button>`;}
function resultCardHtml(file,index,result) {
  if (!result.previewUrl) result.previewUrl=safeUrl(result.blob);
  const isWatermark=result.operation==='watermark',isRedact=result.operation==='redact',isCrop=result.operation==='crop',isBackground=result.operation==='remove-bg',isConvert=result.operation==='convert';
  const saved=Math.max(0,Math.round((1-result.blob.size/file.size)*100));
  const reason=result.metTarget?'':failureReason(result,state.resultOptions[index]);
  const kinds=result.watermarkKinds||[],watermarkKind=kinds.length===2?t('textAndImage'):kinds.includes('image')?t('imageOnly'):t('textOnly');
  const cropLabel=CROP_PRESETS[result.cropPreset]?.label||`${result.outputWidth}×${result.outputHeight}`;
  const detail=isWatermark?`<div class="saving-note"><span>${t('watermark')}</span><b>${watermarkKind}</b></div>`:isRedact?`<div class="saving-note"><span>${t('redact')}</span><b>${result.regionCount} ${t('redactRegions')}</b></div>`:isCrop?`<div class="saving-note"><span>${t('crop')}</span><b>${escapeHtml(cropLabel)}</b></div>`:isBackground?`<div class="saving-note"><span>${t('bgResultLabel')}</span><b>${result.engine===BACKGROUND_REMOVAL_ENGINE.aiId?'AI':t('bgEngineDemo')} · PNG</b></div>`:isConvert?`<div class="saving-note"><span>${t('converted')}</span><b>${formatName(result.outputType)}</b></div>`:`<div class="saving-note"><span>${t('saved')}</span><b>${saved}%</b></div>`;
  const status=isWatermark||isRedact||isCrop||isBackground||isConvert?t('ready'):(result.metTarget?t('pass'):t('failed'));
  return `<article class="result-card done${result.metTarget?'':' over-limit'}${selectedClass(index)}" data-result-index="${index}" data-select-result="${index}" tabindex="0">${removeButtonHtml(index)}<div class="thumb"><img src="${result.previewUrl}" alt="" /></div><div class="result-info"><strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong><span>${formatBytes(file.size)}</span></div><div class="size-flow"><div><span>${t('original')}</span><b>${formatBytes(file.size)}</b></div><i>→</i><div><span>${t('output')}</span><b>${formatBytes(result.blob.size)}</b></div><div class="dimension-note"><span>${t('dimensions')}</span><b>${result.outputWidth}×${result.outputHeight}</b></div>${detail}</div><div class="result-status"><span class="status ${result.metTarget?'pass':'fail'}">${status}</span></div>${reason?`<div class="result-reason"><strong>!</strong><span>${escapeHtml(reason)}</span></div>`:''}<div class="result-action"><button type="button" data-download-index="${index}">${t('download')}</button></div></article>`;
}
function errorCardHtml(file,index,error) {
  return `<article class="result-card failed${selectedClass(index)}" data-result-index="${index}" data-select-result="${index}" tabindex="0">${removeButtonHtml(index)}<div class="thumb placeholder error-thumb"><span>!</span></div><div class="result-info"><strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong><span>${formatBytes(file.size)}</span></div><div class="size-flow"><div><span>${t('original')}</span><b>${formatBytes(file.size)}</b></div><i>→</i><div><span>${t('output')}</span><b>—</b></div></div><div class="result-status"><span class="status fail">${t('failed')}</span></div><div class="result-reason"><strong>!</strong><span>${escapeHtml(errorReason(error))}</span></div></article>`;
}
function queuedCardHtml(file,index) {
  const editable=state.toolMode==='watermark'||state.toolMode==='redact'||state.toolMode==='crop'||state.toolMode==='remove-bg',stateText=state.toolMode==='redact'?t('editing'):editable?t('preview'):t('waiting');
  return `<article class="result-card queued${selectedClass(index)}" data-result-index="${index}" data-select-result="${index}" tabindex="0">${removeButtonHtml(index)}${queueThumb(file,index)}<div class="result-info"><strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong><span>${formatBytes(file.size)}</span></div><div class="size-flow"><div><span>${t('original')}</span><b>${formatBytes(file.size)}</b></div><i>→</i><div><span>${editable?t('export'):t('output')}</span><b>${stateText}</b></div></div><div class="result-status"><span class="status pending">${stateText}</span><div class="progress"><i></i></div></div></article>`;
}
function renderCard(index) {
  const existing=document.querySelector(`[data-result-index="${index}"]`); if(!existing)return;
  const html=state.results[index]?resultCardHtml(state.files[index],index,state.results[index]):state.errors[index]?errorCardHtml(state.files[index],index,state.errors[index]):queuedCardHtml(state.files[index],index);
  existing.outerHTML=html; renderComparison();
}
function renderCards() {
  if(!state.files.length){$('resultsSection').hidden=true;$('emptyResults').hidden=false;$('resultList').innerHTML='';syncDownloadAvailability();return;}
  $('emptyResults').hidden=true;$('resultsSection').hidden=false;
  chooseDefaultResult(); $('resultList').innerHTML=state.files.map((file,i)=>state.results[i]?resultCardHtml(file,i,state.results[i]):state.errors[i]?errorCardHtml(file,i,state.errors[i]):queuedCardHtml(file,i)).join('');
  syncDownloadAvailability(); updateResultsSummary(); renderComparison();
}
function updateResultsSummary() {
  if(!state.files.length)return;
  const completed=state.results.filter(Boolean).length+state.errors.filter(Boolean).length;
  if(!completed){$('resultsSummary').textContent=t('queuedTitle');return;}
  const passed=state.results.filter(r=>r?.metTarget).length;
  let text=state.toolMode==='watermark'?`${passed}/${state.files.length} ${t('watermarkSummary')}`:state.toolMode==='redact'?`${passed}/${state.files.length} ${t('redactSummary')}`:state.toolMode==='crop'?`${passed}/${state.files.length} ${t('cropSummary')}`:state.toolMode==='remove-bg'?`${passed}/${state.files.length} ${t('bgSummary')}`:state.compressionMode==='convert'?`${passed}/${state.files.length} ${t('convertSummary')}`:`${passed}/${state.files.length} ${t('passSummary')}`;
  if(state.lastSkipped) text+=` · ${state.lastSkipped} ${t('skippedSummary')}`;
  $('resultsSummary').textContent=text;
}

function addFiles(files) {
  const incoming=[...files].filter(f=>f.type.startsWith('image/')||/\.(jpe?g|png|webp|avif|heic|heif|bmp)$/i.test(f.name));
  if(!incoming.length)return;
  const room=30-state.files.length; if(room<=0)return toast(t('tooMany')); if(incoming.length>room)toast(t('tooMany'));
  incoming.slice(0,room).forEach(file=>{state.files.push(file);state.previews.push(URL.createObjectURL(file));state.results.push(null);state.errors.push(null);state.processKeys.push(null);state.resultOptions.push(null);state.redactRegions.push([]);state.redactHistory.push({undo:[],redo:[]});state.cropRects.push(null);state.cropSourceMeta.push(null);});
  if(state.selectedIndex===null)state.selectedIndex=0; state.lastSkipped=0;$('fileInput').value='';renderCards();updateQueue();if(state.toolMode==='watermark')scheduleWatermarkPreview();if(state.toolMode==='redact'){updateRedactActions();scheduleRedactPreview();}if(state.toolMode==='crop')requestCropOverlayRender();if(state.toolMode==='remove-bg')scheduleBackgroundPreview();
}
function resetAll() {
  bumpOutputGeneration();
  clearLiveWatermarkPreview();clearRedactPreview();clearCropEditor();clearBackgroundPreview();clearWatermarkCache();clearRedactCache();clearCropCache();state.files.forEach(file=>clearBackgroundRemovalCache(file));state.results.forEach(r=>r?.previewUrl&&URL.revokeObjectURL(r.previewUrl));state.previews.forEach(url=>URL.revokeObjectURL(url));
  state.files=[];state.results=[];state.errors=[];state.previews=[];state.processKeys=[];state.resultOptions=[];state.redactRegions=[];state.redactHistory=[];state.cropRects=[];state.cropSourceMeta=[];state.busy=false;state.lastSkipped=0;state.selectedIndex=null;state.selectionManual=false;state.comparePosition=50;state.redactSelected=null;state.redactView='edit';
  $('fileInput').value='';$('resultsSection').hidden=true;$('emptyResults').hidden=false;$('comparisonPanel').hidden=true;$('resultList').innerHTML='';syncDownloadAvailability();updateQueue();updateRedactActions();
}
function removeFile(index){
  if(state.busy||!Number.isInteger(index)||index<0||index>=state.files.length)return;
  clearWatermarkCache(state.files[index]);clearRedactCache(state.files[index]);clearCropCache(state.files[index]);clearBackgroundRemovalCache(state.files[index]);state.results[index]?.previewUrl&&URL.revokeObjectURL(state.results[index].previewUrl);state.previews[index]&&URL.revokeObjectURL(state.previews[index]);
  state.files.splice(index,1);state.results.splice(index,1);state.errors.splice(index,1);state.previews.splice(index,1);state.processKeys.splice(index,1);state.resultOptions.splice(index,1);state.redactRegions.splice(index,1);state.redactHistory.splice(index,1);state.cropRects.splice(index,1);state.cropSourceMeta.splice(index,1);
  clearLiveWatermarkPreview();clearRedactPreview();clearCropEditor();clearBackgroundPreview();state.lastSkipped=0;state.selectionManual=false;state.redactSelected=null;
  if(!state.files.length)state.selectedIndex=null;else state.selectedIndex=Math.min(index,state.files.length-1);
  $('fileInput').value='';renderCards();updateQueue();if(state.toolMode==='watermark')scheduleWatermarkPreview();if(state.toolMode==='redact'){updateRedactActions();scheduleRedactPreview();}if(state.toolMode==='crop')requestCropOverlayRender();if(state.toolMode==='remove-bg')scheduleBackgroundPreview();
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
  const isWatermark=state.toolMode==='watermark',isRedact=state.toolMode==='redact',isCrop=state.toolMode==='crop',isBackground=state.toolMode==='remove-bg';
  const opts=isWatermark?watermarkOptions():isBackground?backgroundOptions():isCrop?null:isRedact?null:inputOptions();
  if(isWatermark&&!opts.text&&!opts.imageFile)return toast(t('watermarkContentRequired'));
  if(isBackground&&opts.engine==='ai'&&!getBackgroundAIState().ready)return toast(t('bgModelRequiredToast'));
  if(!isWatermark&&!isRedact&&!isCrop&&!isBackground&&opts.resizeMode==='exact'&&(!opts.maxWidth||!opts.maxHeight))return toast(t('invalidExact'));
  const todo=[];let skipped=0;
  if(isRedact){
    let anyRegion=false;
    for(let i=0;i<state.files.length;i++){
      const regions=redactRegionsFor(i);if(!regions.length)continue;anyRegion=true;
      const key=redactSettingsKey(i);if(state.processKeys[i]===key)skipped++;else todo.push(i);
    }
    if(!anyRegion)return toast(t('redactNeedRegion'));
  }else if(isCrop){
    for(let i=0;i<state.files.length;i++){const key=cropSettingsKey(i);if(state.processKeys[i]===key)skipped++;else todo.push(i);}
  }else{
    const key=isWatermark?watermarkSettingsKey(opts):isBackground?backgroundSettingsKey(opts):settingsKey(opts);
    for(let i=0;i<state.files.length;i++){if(state.processKeys[i]===key)skipped++;else todo.push(i);}
  }
  state.lastSkipped=skipped;
  if(!todo.length){updateResultsSummary();toast(t('alreadyProcessed'));return;}
  state.busy=true;syncDownloadAvailability();updateQueue();$('processBtn').classList.add('busy');toast(t(isWatermark?'watermarkWorking':isRedact?'redactWorking':isCrop?'cropWorking':isBackground?'bgWorking':state.compressionMode==='convert'?'convertWorking':'working'));
  const generation=state.outputGeneration,run={};state.activeRun=run;let staleRun=false;
  const isStale=()=>state.outputGeneration!==generation;
  // Undo the in-progress card for file i, but only if that file is still in the list at the same index.
  const abandon=(i,file,result)=>{if(result?.previewUrl)URL.revokeObjectURL(result.previewUrl);if(state.files[i]===file){state.resultOptions[i]=null;renderCard(i);}staleRun=true;};
  try{
  for(const i of todo){
    if(isStale()){staleRun=true;break;}
    const file=state.files[i];
    prepareCard(i);
    const itemOpts=isCrop?cropOptions(i):opts;
    const key=isRedact?redactSettingsKey(i):isWatermark?watermarkSettingsKey(opts):isCrop?cropSettingsKey(itemOpts):isBackground?backgroundSettingsKey(opts):settingsKey(opts);
    state.resultOptions[i]=isRedact?{regions:cloneRegions(redactRegionsFor(i))}:{...itemOpts};
    try{
      const progress=p=>{if(!isStale()&&state.files[i]===file)updateCardProgress(i,p);};
      const result=await (isWatermark? applyWatermarks(state.files[i],opts,progress):isRedact?await applyRedactions(state.files[i],cloneRegions(redactRegionsFor(i)),progress):isCrop?await applyCrop(state.files[i],itemOpts,progress):isBackground?await removeBackgroundDemo(state.files[i],opts,progress):compressImage(state.files[i],opts,progress));
      if(isStale()){abandon(i,file,result);break;}
      state.results[i]=result;state.errors[i]=null;state.processKeys[i]=key;if(result.metTarget&&!state.selectionManual&&!state.results[state.selectedIndex]?.metTarget)state.selectedIndex=i;renderCard(i);
    }catch(error){
      if(isStale()){abandon(i,file,null);break;}
      console.warn('PixelQuota processing failure:',state.files[i]?.name,error);
      state.results[i]=null;state.errors[i]={message:String(error?.message||error)};state.processKeys[i]=key;renderCard(i);
    }
  }
  }finally{
    // A newer run (possible after Clear all) owns the busy state and UI from here.
    if(state.activeRun!==run)return;
    state.activeRun=null;state.busy=false;$('processBtn').classList.remove('busy');
  }
  if(!state.files.length){syncDownloadAvailability();updateQueue();return;}
  state.busy=false;if(isRedact&&!staleRun){state.redactView='compare';renderComparison();}$('processBtn').classList.remove('busy');syncDownloadAvailability();updateQueue();updateResultsSummary();if(staleRun)return toast(t('settingsChangedRerun'));toast(t(isWatermark?'watermarkDone':isRedact?'redactDone':isCrop?'cropDone':isBackground?'bgDone':state.compressionMode==='convert'?'convertDone':'done'));
}

function downloadBlob(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1600);}
async function downloadAll(){const good=state.results.filter(Boolean);if(!good.length)return toast(t('noOutputs'));const entries={};for(const r of good){let name=r.outputName,n=2;const dot=name.lastIndexOf('.'),stem=dot>0?name.slice(0,dot):name,ext=dot>0?name.slice(dot):'';while(name in entries)name=`${stem} (${n++})${ext}`;entries[name]=new Uint8Array(await r.blob.arrayBuffer());}const zipped=zipSync(entries,{level:6});const name=state.toolMode==='watermark'?'pixelquota-watermarked.zip':state.toolMode==='redact'?'pixelquota-redacted.zip':state.toolMode==='crop'?'pixelquota-social-crops.zip':state.toolMode==='remove-bg'?'pixelquota-background-removed.zip':'pixelquota-images.zip';downloadBlob(new Blob([zipped],{type:'application/zip'}),name);toast(t('zipReady'));}
function setPreset(kb){const changed=targetKb()!==kb;state.customMode=false;$('targetKb').value=kb;if(changed)invalidateAllOutputs();updateGate();}
function setCustom(){state.customMode=true;updateGate();$('targetKb').focus();$('targetKb').select();}
function setFormat(format){const button=document.querySelector(`#formatButtons [data-format="${format}"]`);if(button?.disabled)return toast(t('formatUnavailable'));const changed=state.outputFormat!==format;state.outputFormat=format;if(changed)invalidateAllOutputs();document.querySelectorAll('#formatButtons [data-format]').forEach(b=>b.classList.toggle('active',b.dataset.format===format));}
function setResize(mode){const changed=state.resizeMode!==mode;state.resizeMode=mode;if(changed)invalidateAllOutputs();document.querySelectorAll('#resizeButtons button').forEach(b=>b.classList.toggle('active',b.dataset.resize===mode));}

function initMonetization(){const m=cfg.monetization||{};if(m.sponsorText&&m.sponsorUrl){const slot=$('adTop');slot.hidden=false;$('adTopInner').innerHTML=`<a class="sponsor-link" href="${escapeHtml(m.sponsorUrl)}" rel="sponsored noopener" target="_blank">${escapeHtml(m.sponsorText)}</a>`;return;}if(m.adsenseClient&&m.adsenseSlotTop&&location.protocol.startsWith('http')){const s=document.createElement('script');s.async=true;s.crossOrigin='anonymous';s.src=`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(m.adsenseClient)}`;document.head.appendChild(s);const slot=$('adTop');slot.hidden=false;$('adTopInner').innerHTML=`<ins class="adsbygoogle" style="display:block" data-ad-client="${escapeHtml(m.adsenseClient)}" data-ad-slot="${escapeHtml(m.adsenseSlotTop)}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;try{(window.adsbygoogle=window.adsbygoogle||[]).push({});}catch{}}}
function syncRangeVisual(input){
  if(!input)return;
  const min=Number(input.min||0),max=Number(input.max||100),value=Number(input.value||min);
  const percent=max===min?0:Math.max(0,Math.min(100,((value-min)/(max-min))*100));
  input.style.setProperty('--range-fill',`${percent}%`);
}
function bindPercentRange(inputId,outputId){
  const input=$(inputId),output=$(outputId);
  const refresh=()=>{output.textContent=`${input.value}%`;syncRangeVisual(input);watermarkSettingsChanged();};
  input.oninput=refresh;input.onchange=()=>{output.textContent=`${input.value}%`;syncRangeVisual(input);};syncRangeVisual(input);
}

function initColorPickers(){
  watermarkColorPicker=createColorPicker({
    input:$('watermarkColor'),toggle:$('colorPickerToggle'),preview:$('colorPickerPreview'),hexLabel:$('colorPickerHex'),
    popover:$('colorPickerPopover'),field:$('colorField'),cursor:$('colorFieldCursor'),hue:$('colorHue'),hexInput:$('colorHexInput'),
    presetRoot:$('watermarkColorPresets'),presetAttribute:'data-color',onChange:()=>watermarkSettingsChanged()
  });
  redactColorPicker=createColorPicker({
    input:$('redactColor'),toggle:$('redactColorPickerToggle'),preview:$('redactColorPickerPreview'),hexLabel:$('redactColorPickerHex'),
    popover:$('redactColorPickerPopover'),field:$('redactColorField'),cursor:$('redactColorFieldCursor'),hue:$('redactColorHue'),hexInput:$('redactColorHexInput'),
    presetRoot:$('redactColorPresets'),presetAttribute:'data-redact-color',onChange:color=>{state.redactColor=color;}
  });
}

function bind(){
  $('toolModeSwitch').onclick=e=>{const b=e.target.closest('[data-tool-mode]');if(b)setToolMode(b.dataset.toolMode);};
  $('compressModeSwitch').onclick=e=>{const b=e.target.closest('[data-compress-mode]');if(b)setCompressionMode(b.dataset.compressMode);};
  $('watermarkSubtoolSwitch').onclick=e=>{const b=e.target.closest('[data-watermark-panel]');if(b)setWatermarkPanel(b.dataset.watermarkPanel);};
  $('watermarkPresets').onclick=e=>{const b=e.target.closest('[data-watermark-preset]');if(b)applyWatermarkPreset(b.dataset.watermarkPreset);};
  $('watermarkAlignButtons').onclick=e=>{const b=e.target.closest('[data-align]');if(b)setWatermarkTextAlign(b.dataset.align);};
  $('watermarkPositions').onclick=e=>{const b=e.target.closest('[data-position]');if(b)setWatermarkPosition(b.dataset.position);};
  $('watermarkImagePositions').onclick=e=>{const b=e.target.closest('[data-position]');if(b)setWatermarkImagePosition(b.dataset.position);};
  document.addEventListener('pointerdown',e=>{if(!e.target.closest('.custom-color-picker'))closeColorPicker();if(!e.target.closest('#languageMenu'))closeLanguageMenu();});
  $('redactModeButtons').onclick=e=>{const b=e.target.closest('[data-redact-mode]');if(b){setRedactView('edit');setRedactMode(b.dataset.redactMode);}};
  $('redactViewSwitch').onclick=e=>{const b=e.target.closest('[data-redact-view]');if(b)setRedactView(b.dataset.redactView);};
  $('redactStrength').onpointerdown=()=>{setRedactView('edit');beginRedactStrengthEdit();};
  $('redactStrength').onkeydown=e=>{if(e.key.startsWith('Arrow')||e.key==='Home'||e.key==='End'||e.key==='PageUp'||e.key==='PageDown')beginRedactStrengthEdit();};
  $('redactStrength').oninput=e=>setRedactStrength(e.target.value,true);
  $('redactStrength').onchange=finishRedactStrengthEdit;$('redactStrength').onpointerup=finishRedactStrengthEdit;$('redactStrength').onpointercancel=finishRedactStrengthEdit;
  $('redactUndo').onclick=()=>{setRedactView('edit');undoRedact();};$('redactRedo').onclick=()=>{setRedactView('edit');redoRedact();};$('redactDelete').onclick=()=>{setRedactView('edit');deleteRedactRegion();};
  $('redactLayerList').onclick=e=>{setRedactView('edit');const remove=e.target.closest('[data-redact-layer-delete]');if(remove){deleteRedactLayer(Number(remove.dataset.redactLayerDelete));return;}const layer=e.target.closest('[data-redact-layer-index]');if(layer)selectRedactLayer(Number(layer.dataset.redactLayerIndex));};
  $('redactOverlayCanvas').addEventListener('pointerdown',onRedactPointerDown);$('redactOverlayCanvas').addEventListener('pointermove',onRedactPointerMove);$('redactOverlayCanvas').addEventListener('pointerup',onRedactPointerUp);$('redactOverlayCanvas').addEventListener('pointercancel',onRedactPointerUp);$('redactOverlayCanvas').addEventListener('pointerleave',()=>{if(!redactPointer)$('redactOverlayCanvas').style.cursor='crosshair';});
  $('watermarkText').oninput=()=>{updateWatermarkStateIndicators();watermarkSettingsChanged();};
  bindPercentRange('watermarkOpacity','watermarkOpacityValue');
  bindPercentRange('watermarkSize','watermarkSizeValue');
  bindPercentRange('watermarkImageOpacity','watermarkImageOpacityValue');
  bindPercentRange('watermarkImageSize','watermarkImageSizeValue');
  $('watermarkImageBtn').onclick=()=>$('watermarkImageInput').click();
  $('watermarkImageInput').onchange=e=>setWatermarkImage(e.target.files?.[0]);
  $('watermarkImageClear').onclick=clearWatermarkImage;
  const bgSensitivity=$('bgSensitivity');bgSensitivity.oninput=()=>{$('bgSensitivityValue').textContent=`${bgSensitivity.value}%`;syncRangeVisual(bgSensitivity);backgroundSettingsChanged();};bgSensitivity.onchange=()=>{$('bgSensitivityValue').textContent=`${bgSensitivity.value}%`;syncRangeVisual(bgSensitivity);};syncRangeVisual(bgSensitivity);
  const bgAiThreshold=$('bgAiThreshold');bgAiThreshold.oninput=()=>{$('bgAiThresholdValue').textContent=`${bgAiThreshold.value}%`;syncRangeVisual(bgAiThreshold);backgroundAISettingsChanged();};bgAiThreshold.onchange=()=>{$('bgAiThresholdValue').textContent=`${bgAiThreshold.value}%`;syncRangeVisual(bgAiThreshold);backgroundAISettingsChanged(true);};syncRangeVisual(bgAiThreshold);
  const bgAiFeather=$('bgAiFeather');bgAiFeather.oninput=()=>{$('bgAiFeatherValue').textContent=`${bgAiFeather.value}%`;syncRangeVisual(bgAiFeather);backgroundAISettingsChanged();};bgAiFeather.onchange=()=>{$('bgAiFeatherValue').textContent=`${bgAiFeather.value}%`;syncRangeVisual(bgAiFeather);backgroundAISettingsChanged(true);};syncRangeVisual(bgAiFeather);
  $('bgEngineSwitch').onclick=e=>{const b=e.target.closest('[data-bg-engine]');if(b)setBackgroundEngine(b.dataset.bgEngine);};
  $('bgLoadModel').onclick=loadBackgroundModelUI;
  $('backgroundInspectBtn').onclick=openBackgroundInspector;
  $('backgroundInspectClose').onclick=()=>closeBackgroundInspector();
  document.querySelector('.edge-inspect-zoom').onclick=e=>{const b=e.target.closest('[data-edge-zoom]');if(b)setBackgroundInspectorZoom(Number(b.dataset.edgeZoom));};
  $('backgroundInspectViewport').addEventListener('pointerdown',onBackgroundInspectPointerDown);
  $('backgroundInspectViewport').addEventListener('pointermove',onBackgroundInspectPointerMove);
  $('backgroundInspectViewport').addEventListener('pointerup',onBackgroundInspectPointerUp);
  $('backgroundInspectViewport').addEventListener('pointercancel',onBackgroundInspectPointerUp);
  $('backgroundInspectModal').addEventListener('pointerdown',e=>{if(e.target===$('backgroundInspectModal'))closeBackgroundInspector();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('backgroundInspectModal').hidden){e.preventDefault();closeBackgroundInspector();}});
  $('cropPlatformButtons').onclick=e=>{const b=e.target.closest('[data-crop-platform]');if(b)setCropPlatform(b.dataset.cropPlatform);};
  $('cropPresetGrid').onclick=e=>{const b=e.target.closest('[data-crop-preset]');if(b)setCropPreset(b.dataset.cropPreset);};
  $('cropReset').onclick=resetCropFrame;
  $('cropOverlayCanvas').addEventListener('pointerdown',onCropPointerDown);$('cropOverlayCanvas').addEventListener('pointermove',onCropPointerMove);$('cropOverlayCanvas').addEventListener('pointerup',onCropPointerUp);$('cropOverlayCanvas').addEventListener('pointercancel',onCropPointerUp);$('cropOverlayCanvas').addEventListener('pointerleave',()=>{if(!cropPointer)$('cropOverlayCanvas').style.cursor='default';});
  $('browseBtn').onclick=e=>{e.stopPropagation();$('fileInput').click();};
  $('dropZone').onclick=e=>{if(!e.target.closest('button'))$('fileInput').click();};
  $('dropZone').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('fileInput').click();}};
  $('fileInput').onchange=e=>addFiles(e.target.files);
  ['dragenter','dragover'].forEach(ev=>$('dropZone').addEventListener(ev,e=>{e.preventDefault();$('dropZone').classList.add('dragging')}));
  ['dragleave','drop'].forEach(ev=>$('dropZone').addEventListener(ev,e=>{e.preventDefault();$('dropZone').classList.remove('dragging')}));
  $('dropZone').addEventListener('drop',e=>addFiles(e.dataTransfer.files));
  window.addEventListener('paste',e=>{const files=[...(e.clipboardData?.files||[])];if(files.length)addFiles(files);});
  $('presetRow').onclick=e=>{const preset=e.target.closest('[data-kb]');if(preset)return setPreset(Number(preset.dataset.kb));const custom=e.target.closest('[data-custom]');if(custom)setCustom();};
  $('targetKb').addEventListener('input',()=>{state.customMode=true;invalidateAllOutputs();updateGate();});
  ['maxWidth','maxHeight'].forEach(id=>$(id).addEventListener('input',invalidateAllOutputs));$('stripMetadata').addEventListener('change',invalidateAllOutputs);
  $('commonLimitButtons').onclick=e=>{const b=e.target.closest('[data-kb]');if(!b)return;setPreset(Number(b.dataset.kb));document.querySelector('.spec-pane').scrollIntoView({behavior:'smooth',block:'center'});};
  $('formatButtons').onclick=e=>{const b=e.target.closest('[data-format]');if(b)setFormat(b.dataset.format);};
  $('resizeButtons').onclick=e=>{const b=e.target.closest('[data-resize]');if(b)setResize(b.dataset.resize);};
  $('processBtn').onclick=processAll;$('clearBtn').onclick=resetAll;$('downloadAllBtn').onclick=downloadAll;
  $('compareRange').oninput=e=>updateComparisonPosition(e.target.value);
  $('resultList').onclick=e=>{const remove=e.target.closest('[data-remove-index]');if(remove){e.stopPropagation();removeFile(Number(remove.dataset.removeIndex));return;}const b=e.target.closest('[data-download-index]');if(b){e.stopPropagation();const r=state.results[Number(b.dataset.downloadIndex)];if(r)downloadBlob(r.blob,r.outputName);return;}const card=e.target.closest('[data-select-result]');if(card)selectResult(Number(card.dataset.selectResult));};
  $('resultList').onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target.closest('[data-select-result]')&&!e.target.closest('button')){e.preventDefault();selectResult(Number(e.target.closest('[data-select-result]').dataset.selectResult));}};
  $('languageToggle').onclick=()=>toggleLanguageMenu();
  $('languageOptions').onclick=e=>{const option=e.target.closest('[data-locale]');if(!option)return;applyLocale(option.dataset.locale);updateRedactActions();closeLanguageMenu();$('languageToggle').focus();};
  $('languageMenu').onkeydown=e=>{const options=[...document.querySelectorAll('#languageOptions [data-locale]')];if(e.key==='Escape'){e.preventDefault();closeLanguageMenu();$('languageToggle').focus();return;}if((e.key==='ArrowDown'||e.key==='ArrowUp')&&!$('languageOptions').hidden){e.preventDefault();const current=Math.max(0,options.indexOf(document.activeElement)),next=(current+(e.key==='ArrowDown'?1:-1)+options.length)%options.length;options[next]?.focus();}};
  let resizeFrame=0;window.addEventListener('resize',()=>{if(resizeFrame)return;resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;fitCurrentPreviewSurface();requestCropOverlayRender();if(!$('backgroundInspectModal').hidden){const canvas=$('backgroundInspectCanvas');backgroundInspector.baseWidth=canvas.getBoundingClientRect().width/backgroundInspector.zoom;backgroundInspector.baseHeight=canvas.getBoundingClientRect().height/backgroundInspector.zoom;applyBackgroundInspectorTransform();}});});
}
// Selection is shown with an .active class; mirror it to aria-pressed so assistive tech can read it.
function initPressedStateSync(){
  const groups=['toolModeSwitch','compressModeSwitch','formatButtons','resizeButtons','watermarkAlignButtons','redactModeButtons','cropPlatformButtons','cropPresetGrid','bgEngineSwitch','redactViewSwitch'].map(id=>$(id)).filter(Boolean);
  const sync=button=>button.setAttribute('aria-pressed',String(button.classList.contains('active')));
  for(const group of groups){
    group.querySelectorAll('button').forEach(sync);
    new MutationObserver(records=>{for(const r of records)if(r.target.tagName==='BUTTON')sync(r.target);}).observe(group,{subtree:true,attributes:true,attributeFilter:['class']});
  }
}
function init(){initPressedStateSync();initPageMode();initColorPickers();bind();applyLocale(state.locale);setFormat(state.outputFormat);setResize(state.resizeMode);syncCompressionModeUI();initFormatCapabilities();setWatermarkPanel(state.watermarkPanel);setWatermarkColor('#ffffff');setRedactMode(state.redactMode);setRedactStrength(state.redactStrength,false);redactColorPicker.setColor(state.redactColor,false);setCropPlatform(state.cropPlatform);setCropPreset(state.cropPreset);updateWatermarkStateIndicators();updateRedactActions();syncBackgroundEngineUI();initBackgroundAICacheState();syncDownloadAvailability();initMonetization();window.PixelQuotaTest={addFiles,removeFile,processAll,state,compressImage,detectEncoderSupport,applyWatermarks,renderWatermarkPreview,applyRedactions,renderRedactPreview,applyCrop,renderCropPreview,removeBackgroundDemo,renderBackgroundRemovalPreview,renderBackgroundRemovalInspection,BACKGROUND_REMOVAL_ENGINE,loadBackgroundAIModel,getBackgroundAIState,probeBackgroundAICache,setPreset,setCustom,setFormat,setResize,setCompressionMode,setToolMode,setWatermarkPanel,setWatermarkPosition,setWatermarkImagePosition,setWatermarkTextAlign,setWatermarkColor,setRedactMode,setRedactStrength,setRedactView,setBackgroundEngine,loadBackgroundModelUI,syncBackgroundEngineUI,setCropPlatform,setCropPreset,resetCropFrame,applyWatermarkPreset,settingsKey,inputOptions,watermarkOptions,backgroundOptions,backgroundSettingsKey,cropOptions,cropSettingsKey,redactRegionsFor,redactSettingsKey,undoRedact,redoRedact,deleteRedactRegion,selectRedactLayer,deleteRedactLayer,renderRedactLayers,renderRedactOverlay,renderCropOverlay,redactHandle,updateRedactCursor,syncRangeVisual,selectResult,renderComparison,fitPreviewSurface,updateComparisonPosition,updateWatermarkLivePreview,updateRedactPreview,updateBackgroundPreview,openBackgroundInspector,closeBackgroundInspector,setBackgroundInspectorZoom,backgroundInspector};}
init();
