// Real-browser regression for v1.6.1/v1.6.2 control contrast: selected segmented controls, visible #HEX on both
// custom-colour buttons, and the redaction Continue editing / Compare result switch (both states).
// Usage: node tests/ui-contrast.mjs [outDir|report.json]
//   PIXELQUOTA_UI_TEST_HTML      built single-file product (default: <repo>/dist/PixelQuota.html)
//   PIXELQUOTA_UI_CONTRAST_OUT   output dir or report .json (argv[2] wins; default: unique dir under TMPDIR)
//   PIXELQUOTA_UI_TEST_FIXTURE   optional image to upload (default: a diagnostic PNG generated in the output dir)
//   CHROME_PATH / PUPPETEER_EXECUTABLE_PATH / CHROMIUM_PATH  browser override
// Exit code 0 only when every check passes, every width x locale combo completed and no page error occurred.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.resolve(process.env.PIXELQUOTA_UI_TEST_HTML || path.join(root, 'dist', 'PixelQuota.html'));
const executablePath = [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROMIUM_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => p && fs.existsSync(p));
const outArg = process.argv[2] || process.env.PIXELQUOTA_UI_CONTRAST_OUT;
let outDir, reportPath;
if (outArg && /\.json$/i.test(outArg)) { reportPath = path.resolve(outArg); outDir = path.dirname(reportPath); }
else { outDir = path.resolve(outArg || fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pixelquota-ui-contrast-'))); reportPath = path.join(outDir, 'report.json'); }
const shotDir = path.join(outDir, 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });

const allWidths = [{ w: 1440, h: 1000 }, { w: 768, h: 1000 }, { w: 390, h: 844 }];
const allLocales = ['en', 'zh-TW', 'zh-CN', 'ja', 'ko'];
const widthFilter = process.env.PIXELQUOTA_UI_CONTRAST_WIDTHS?.split(',').map(Number);
const localeFilter = process.env.PIXELQUOTA_UI_CONTRAST_LOCALES?.split(',');
if (widthFilter?.some(w => !allWidths.some(v => v.w === w)) || localeFilter?.some(l => !allLocales.includes(l))) throw new Error('Unknown UI contrast width or locale filter');
const WIDTHS = allWidths.filter(v => !widthFilter || widthFilter.includes(v.w));
const LOCALES = allLocales.filter(l => !localeFilter || localeFilter.includes(l));
if (!WIDTHS.length || !LOCALES.length) throw new Error('UI contrast selection cannot be empty');
const expectedCombos = WIDTHS.length * LOCALES.length;
const checks = [], pageErrors = [], completedCombos = [], comboErrors = [], shots = [];
const report = { passed: false, htmlPath, htmlBytes: fs.existsSync(htmlPath) ? fs.statSync(htmlPath).size : 0, expectedCombos, actualCombos: 0, checks: [], pageErrors, comboErrors, screenshots: shots, summary: {} };
function persist() {
  const failed = checks.filter(c => !c.pass);
  report.checks = checks; report.actualCombos = completedCombos.length;
  report.summary = { total: checks.length, passedChecks: checks.length - failed.length, failedChecks: failed.length, failedNames: [...new Set(failed.map(c => c.name))] };
  report.passed = checks.length > 0 && failed.length === 0 && pageErrors.length === 0 && comboErrors.length === 0 && completedCombos.length === expectedCombos;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}
function fail(msg) { console.error(msg); persist(); process.exit(1); }
if (!executablePath) fail('A real Chrome/Chromium browser is required (set CHROME_PATH)');
if (!fs.existsSync(htmlPath)) fail(`Product HTML not found: ${htmlPath}`);
persist();

const sleep = ms => new Promise(r => setTimeout(r, ms));
let combo = '';
const check = (name, pass, detail) => checks.push({ name, combo, pass: !!pass, detail });

// ---- pixel analysis, runs inside the page: decodes a real screenshot and measures it ----
async function analyze({ b64, cells, trackKey }) {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
  const W = c.width, H = c.height, d = ctx.getImageData(0, 0, W, H).data;
  const px = (x, y) => { x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y)); const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  const lin = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
  const lum = p => .2126 * lin(p[0]) + .7152 * lin(p[1]) + .0722 * lin(p[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const mode = (cell, inset) => {
    const m = new Map(); let best = null, bc = 0;
    for (let y = cell.y + inset; y < cell.y + cell.h - inset; y++) for (let x = cell.x + inset; x < cell.x + cell.w - inset; x++) {
      const p = px(x, y), k = p.join(','), n = (m.get(k) || 0) + 1; m.set(k, n); if (n > bc) { bc = n; best = p; }
    }
    return best || px(cell.x, cell.y);
  };
  const out = {};
  for (const cell of cells) out[cell.key] = { bg: mode(cell, Math.min(3, Math.floor(Math.min(cell.w, cell.h) / 4))) };
  const track = out[trackKey] ? out[trackKey].bg : null;
  for (const cell of cells) {
    const o = out[cell.key], bg = o.bg;
    const fg = cell.fg ? cell.fg.map((v, i) => i < 3 ? Math.round(v * cell.fg[3] * cell.op + bg[i] * (1 - cell.fg[3] * cell.op)) : v) : null;
    o.fgRatio = fg ? ratio(fg, bg) : null;
    const inset = Math.min(3, Math.floor(Math.min(cell.w, cell.h) / 4)); let ink = 1;
    for (let y = cell.y + inset; y < cell.y + cell.h - inset; y++) for (let x = cell.x + inset; x < cell.x + cell.w - inset; x++) ink = Math.max(ink, ratio(px(x, y), bg));
    o.inkRatio = ink;
    if (cell.ring && track) {
      const sides = {}, span = (a, n) => { const s = Math.floor(n * .25), e = Math.ceil(n * .75); return [a + s, a + e]; };
      const sample = side => {
        let pass = 0, tot = 0, sum = 0;
        const [a0, a1] = side === 'top' || side === 'bottom' ? span(cell.x, cell.w) : span(cell.y, cell.h);
        for (let a = a0; a < a1; a++) {
          let best = 1;
          for (let depth = 0; depth < 4; depth++) {
            const p = side === 'top' ? px(a, cell.y + depth) : side === 'bottom' ? px(a, cell.y + cell.h - 1 - depth) : side === 'left' ? px(cell.x + depth, a) : px(cell.x + cell.w - 1 - depth, a);
            best = Math.max(best, ratio(p, track));
          }
          tot++; sum += best; if (best >= 3) pass++;
        }
        return { frac: tot ? pass / tot : 0, mean: tot ? sum / tot : 0 };
      };
      for (const s of ['top', 'right', 'bottom', 'left']) sides[s] = sample(s);
      o.ring = sides; o.track = track; o.lighterThanTrack = lum(bg) > lum(track) && ratio(bg, track) >= 1.03;
    }
  }
  return out;
}

// ---- helpers executed in the page ----
const pageHelpers = {
  groupInfo: (id) => {
    const g = document.getElementById(id);
    if (!g) return { missing: true };
    const gr = g.getBoundingClientRect(), cs = getComputedStyle(g);
    const parse = s => {
      let m = /rgba?\(([^)]+)\)/.exec(s); if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
      m = /color\(srgb ([^)]+)\)/.exec(s); if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
      return [0, 0, 0, 1];
    };
    const opacity = el => { let o = 1; for (let n = el; n && n !== document.body; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
    const textEl = b => { const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.textContent.trim()) return n.parentElement; return b; };
    const buttons = [...g.children].filter(b => b.tagName === 'BUTTON' && !b.hidden && b.offsetWidth).map((b, i) => {
      const r = b.getBoundingClientRect(), te = textEl(b), tcs = getComputedStyle(te);
      const vis = r.left >= gr.left - 1 && r.right <= gr.right + 1 && r.top >= gr.top - 1 && r.bottom <= gr.bottom + 1;
      const pts = [[.5, .5], [.12, .2], [.88, .2], [.12, .8], [.88, .8]].map(([fx, fy]) => { const x = r.left + r.width * fx, y = r.top + r.height * fy; const el = document.elementFromPoint(x, y); return !!el && (el === b || b.contains(el)); });
      const ind = g.querySelector(':scope > .seg-ind'), surf = b.classList.contains('active') ? (ind && parseFloat(getComputedStyle(ind).opacity) > 0 ? ind : b) : null;
      const shadow = surf ? getComputedStyle(surf).boxShadow : 'none';
      const dropShadow = shadow !== 'none' && shadow.split(/,(?![^(]*\))/).some(l => !/inset/.test(l) && (l.match(/-?[\d.]+px/g) || []).slice(1, 3).some(v => parseFloat(v) > 0));
      return { shadow, dropShadow, index: [...g.children].indexOf(b), text: b.textContent.trim(), active: b.classList.contains('active'), disabled: b.disabled, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, fully: vis, hits: pts, fg: parse(tcs.webkitTextFillColor && tcs.webkitTextFillColor !== 'rgba(0, 0, 0, 0)' ? tcs.webkitTextFillColor : tcs.color), op: opacity(te), fontSize: parseFloat(tcs.fontSize), fontWeight: tcs.fontWeight, radius: parseFloat(getComputedStyle(b).borderRadius) };
    });
    const vw = document.documentElement.clientWidth, vh = innerHeight;
    return { radius:parseFloat(cs.borderRadius), indicatorRadius:g.querySelector(':scope > .seg-ind')?parseFloat(getComputedStyle(g.querySelector(':scope > .seg-ind')).borderRadius):null, gr: { x: gr.x, y: gr.y, w: gr.width, h: gr.height }, display: cs.display, visible: gr.width > 0 && gr.height > 0 && cs.visibility !== 'hidden', inViewportX: gr.left >= -1 && gr.right <= vw + 1, buttons, scrollX: scrollX, scrollY: scrollY, vw, vh, docOverflow: document.documentElement.scrollWidth - vw };
  }
};

async function settle(page, id) {
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForFunction(gid => { const g = document.getElementById(gid); return !g || g.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length === 0; }, { timeout: 3000 }, id).catch(() => {});
  await sleep(140);
}
async function shotEl(page, selector, name, pad = 8) {
  const box = await page.evaluate((sel, pad) => { const e = document.querySelector(sel); if (!e) return null; e.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + scrollX - pad, y: r.y + scrollY - pad, w: r.width + pad * 2, h: r.height + pad * 2 }; }, selector, pad);
  if (!box) return null;
  const file = path.join(shotDir, `${combo.replace(/[^a-z0-9-]/gi, '_')}-${name}.png`);
  await page.screenshot({ path: file, clip: { x: Math.max(0, Math.floor(box.x)), y: Math.max(0, Math.floor(box.y)), width: Math.ceil(box.w), height: Math.ceil(box.h) } });
  shots.push(path.relative(outDir, file)); return file;
}

async function measureGroup(page, id, label, tag, opts = {}) {
  const prefix = `${label}${tag ? ' [' + tag + ']' : ''}`;
  const fontFloor=Number(combo.split('x')[0])<=980?13:12;
  await page.evaluate(gid => { const g = document.getElementById(gid); if (!g) return; g.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); const a = g.querySelector('button.active'); if (a) a.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'center' }); }, id);
  await page.mouse.move(1, 1);
  await settle(page, id);
  const info = await page.evaluate(pageHelpers.groupInfo, id);
  if (info.missing || !info.visible) { check(`${prefix}: group exists and is visible`, false, info); return info; }
  check(`${prefix}: group exists and is visible`, true);
  const pad = 6, sx = info.scrollX, sy = info.scrollY;
  const clip = { x: Math.max(0, Math.floor(info.gr.x + sx - pad)), y: Math.max(0, Math.floor(info.gr.y + sy - pad)), width: Math.ceil(info.gr.w + pad * 2), height: Math.ceil(info.gr.h + pad * 2) };
  const b64 = await page.screenshot({ clip, encoding: 'base64', captureBeyondViewport: false });
  const usable = info.buttons.filter(b => b.fully);
  const cells = usable.map(b => ({ key: 'b' + b.index, x: Math.round(b.rect.x + sx - clip.x), y: Math.round(b.rect.y + sy - clip.y), w: Math.max(1, Math.round(b.rect.x + b.rect.w + sx - clip.x) - Math.round(b.rect.x + sx - clip.x)), h: Math.max(1, Math.round(b.rect.y + b.rect.h + sy - clip.y) - Math.round(b.rect.y + sy - clip.y)), fg: b.fg, op: b.op, ring: b.active }));
  const trackBtn = usable.find(b => !b.active && !b.disabled) || null;
  const trackKey = trackBtn ? 'b' + trackBtn.index : (cells[0] ? cells[0].key : null);
  const res = await page.evaluate(analyze, { b64, cells, trackKey });
  const active = usable.filter(b => b.active);
  check(`${prefix}: exactly one visible selected button`, active.length === 1, { active: active.map(a => a.text), visible: usable.length, total: info.buttons.length });
  if (info.buttons.some(b => b.active && !b.fully)) check(`${prefix}: selected button not clipped`, false, info.buttons.filter(b => b.active).map(b => b.rect));
  for (const b of usable) {
    const r = res['b' + b.index], sel = b.active, kind = sel ? 'selected' : 'unselected';
    if (b.disabled) continue;
    check(`${prefix}: ${kind} text contrast >= 4.5:1 (computed colour on rendered background)`, r.fgRatio >= 4.5, { text: b.text, ratio: +r.fgRatio.toFixed(2), bg: r.bg, fg: b.fg, opacity: b.op });
    check(`${prefix}: ${kind} rendered text ink contrast >= 3.5:1`, r.inkRatio >= 3.5, { text: b.text, ratio: +r.inkRatio.toFixed(2), bg: r.bg });
    check(`${prefix}: ${kind} font size >= ${fontFloor}px`, b.fontSize >= fontFloor, { text: b.text, fontSize: b.fontSize });
    if (sel && trackBtn) {
      check(`${prefix}: selected option is a raised pill with an outer drop shadow (not removed by overrides)`, b.dropShadow, { text: b.text, shadow: b.shadow });
      check(`${prefix}: selected pill renders lighter than the unselected track`, r.lighterThanTrack, { text: b.text, bg: r.bg, track: r.track });
    }
    if (opts.heights !== false) {
      check(`${prefix}: ${kind} control corner is 8px`, b.radius===8, {text:b.text,radius:b.radius});
      check(`${prefix}: ${kind} button height is 40px`, Math.abs(b.rect.h - 40) <= .5 && b.rect.w >= 40, { text: b.text, rect: b.rect });
    }
    check(`${prefix}: ${kind} button hit-test reaches the button at centre and corners`, b.hits.every(Boolean), { text: b.text, hits: b.hits });
  }
  if (opts.heights !== false) check(`${prefix}: group height is 40px`, Math.abs(info.gr.h - 40) <= .5, { h: info.gr.h });
  if(info.indicatorRadius!==null)check(`${prefix}: selected indicator corner is 8px`,info.indicatorRadius===8,{radius:info.indicatorRadius});
  if(id==='redactViewSwitch')check(`${prefix}: view-switch corner is 8px`,info.radius===8,{radius:info.radius});
  check(`${prefix}: group inside viewport without horizontal page scroll`, info.inViewportX && info.docOverflow <= 0, { inViewportX: info.inViewportX, docOverflow: info.docOverflow });
  return info;
}

async function auditStates(page, id, label, extra = 1, opts = {}) {
  await measureGroup(page, id, label, 'initial', opts);
  const idxs = await page.evaluate(gid => { const g = document.getElementById(gid); if (!g) return []; return [...g.children].filter(b => b.tagName === 'BUTTON' && !b.hidden && b.offsetWidth && !b.disabled && !b.classList.contains('active')).map(b => [...g.children].indexOf(b)); }, id);
  for (const idx of idxs.slice(0, extra)) {
    const pt = await page.evaluate((gid, i) => { const b = document.getElementById(gid).children[i]; b.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, id, idx);
    await page.mouse.click(pt.x, pt.y);
    const ok = await page.waitForFunction((gid, i) => document.getElementById(gid).children[i].classList.contains('active'), { timeout: 3000 }, id, idx).then(() => true, () => false);
    check(`${label}: real click selects option ${idx}`, ok);
    await measureGroup(page, id, label, `after click ${idx}`, opts);
  }
}

// ---- colour pickers: visible, correct, synced #HEX ----
async function auditColor(page, kind, expectedHex0) {
  const ids = kind === 'watermark'
    ? { toggle: 'colorPickerToggle', hex: 'colorPickerHex', preview: 'colorPickerPreview', hexInput: 'colorHexInput', hidden: 'watermarkColor', pop: 'colorPickerPopover', preset: '#watermarkColorPresets [data-color]', attr: 'color', read: () => window.PixelQuotaTest.watermarkOptions().color }
    : { toggle: 'redactColorPickerToggle', hex: 'redactColorPickerHex', preview: 'redactColorPickerPreview', hexInput: 'redactColorHexInput', hidden: 'redactColor', pop: 'redactColorPickerPopover', preset: '#redactColorPresets [data-redact-color]', attr: 'redact-color', read: () => window.PixelQuotaTest.state.redactColor };
  const label = `${kind} custom colour button`;
  const probe = async () => page.evaluate(({ ids }) => {
    const $ = id => document.getElementById(id), t = $(ids.toggle), h = $(ids.hex), p = $(ids.preview);
    if (!t || !h || !p) return { missing: true };
    t.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    const tr = t.getBoundingClientRect(), hr = h.getBoundingClientRect(), pr = p.getBoundingClientRect(), hs = getComputedStyle(h), tcs = getComputedStyle(t);
    const chev = t.querySelector('.color-picker-chevron'), cr = chev ? chev.getBoundingClientRect() : null;
    const rgb = s => (/rgba?\(([^)]+)\)/.exec(s) || [])[1] || '';
    const stateColor = ids.read ? null : null;
    const containers = [t.closest('.color-inline'), t.closest('.color-control')].filter(Boolean);
    const layoutContained = containers.every(c => { const b = c.getBoundingClientRect(); return [...c.children].filter(e => e.getBoundingClientRect().width).every(e => { const r = e.getBoundingClientRect(); return r.left >= b.left && r.right <= b.right && r.top >= b.top && r.bottom <= b.bottom; }); });
    const wrap=t.closest('.color-control');
    const siblingOverlap=wrap?[...document.querySelectorAll('#redactSettings .redact-actions button')].some(e=>{const a=e.getBoundingClientRect(),b=wrap.getBoundingClientRect();return a.width>0&&a.height>0&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;}):false;
    return { siblingOverlap, layoutContained, text: h.textContent.trim(), displayed: hs.display !== 'none' && hs.visibility !== 'hidden' && parseFloat(hs.opacity) > 0 && hr.width >= 24 && hr.height >= 10, hexRect: { x: hr.x, y: hr.y, w: hr.width, h: hr.height }, toggleRect: { x: tr.x, y: tr.y, w: tr.width, h: tr.height }, inside: hr.left >= tr.left - 1 && hr.right <= tr.right + 1 && hr.top >= tr.top - 1 && hr.bottom <= tr.bottom + 1, truncated: t.scrollWidth > t.clientWidth || h.scrollWidth > h.clientWidth, fontSize: parseFloat(hs.fontSize), color: hs.color, swatch: rgb(getComputedStyle(p).backgroundColor), swatchRect: { w: pr.width, h: pr.height }, chevron: cr ? { w: cr.width, h: cr.height, shown: getComputedStyle(chev).display !== 'none' } : null, hiddenValue: $(ids.hidden).value, hexInputValue: $(ids.hexInput).value, toggleH: tr.height, inViewport: tr.left >= -1 && tr.right <= document.documentElement.clientWidth + 1, sx: scrollX, sy: scrollY, expanded: t.getAttribute('aria-expanded') };
  }, { ids: { toggle: ids.toggle, hex: ids.hex, preview: ids.preview, hexInput: ids.hexInput, hidden: ids.hidden } });
  const toRgb = hex => { const n = parseInt(hex.slice(1), 16); return `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}`; };
  const stateColor = () => page.evaluate(kind => kind === 'watermark' ? window.PixelQuotaTest.watermarkOptions().color : window.PixelQuotaTest.state.redactColor, kind);
  const verify = async (tag, expectedHex) => {
    const p = await probe();
    if (p.missing) { check(`${label} [${tag}]: toggle, #HEX and swatch elements exist`, false, p); return; }
    const exp = expectedHex.toUpperCase();
    const fontFloor=Number(combo.split('x')[0])<=980?13:12;
    check(`${label} [${tag}]: colour rows do not overlap sibling actions`,!p.siblingOverlap,p);
    check(`${label} [${tag}]: wrapped colour controls stay inside their layout rows`, p.layoutContained, p);
    check(`${label} [${tag}]: #HEX is displayed (not display:none, non-zero box)`, p.displayed, p);
    check(`${label} [${tag}]: #HEX text equals ${exp}`, p.text === exp, { text: p.text, expected: exp });
    check(`${label} [${tag}]: #HEX sits inside the button and is not truncated`, p.inside && !p.truncated, { inside: p.inside, truncated: p.truncated, hex: p.hexRect, toggle: p.toggleRect });
    check(`${label} [${tag}]: #HEX font >= ${fontFloor}px`, p.fontSize >= fontFloor, { fontSize: p.fontSize });
    check(`${label} [${tag}]: swatch circle shows ${exp}`, p.swatch === toRgb(expectedHex) && p.swatchRect.w >= 12, { swatch: p.swatch, expected: toRgb(expectedHex), rect: p.swatchRect });
    check(`${label} [${tag}]: caret is shown`, !!p.chevron && p.chevron.shown && p.chevron.w > 0, p.chevron);
    check(`${label} [${tag}]: hidden input, popover HEX input and app state are synced`, p.hiddenValue.toUpperCase() === exp && p.hexInputValue.toUpperCase() === exp && (await stateColor()).toUpperCase() === exp, { hidden: p.hiddenValue, hexInput: p.hexInputValue, state: await stateColor() });
    check(`${label} [${tag}]: button is 40px high and inside viewport`, Math.abs(p.toggleH - 40) <= .5 && p.inViewport, { h: p.toggleH, inViewport: p.inViewport });
    if (p.displayed) {
      const clip = { x: Math.max(0, Math.floor(p.toggleRect.x + p.sx)), y: Math.max(0, Math.floor(p.toggleRect.y + p.sy)), width: Math.ceil(p.toggleRect.w), height: Math.ceil(p.toggleRect.h) };
      const b64 = await page.screenshot({ clip, encoding: 'base64', captureBeyondViewport: false });
      const hx = Math.round(p.hexRect.x + p.sx - clip.x), hy = Math.round(p.hexRect.y + p.sy - clip.y);
      const fgm = /rgba?\(([^)]+)\)/.exec(p.color)[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      const r = await page.evaluate(analyze, { b64, trackKey: 'hex', cells: [{ key: 'hex', x: Math.max(0, hx), y: Math.max(0, hy), w: Math.max(1, Math.round(p.hexRect.w)), h: Math.max(1, Math.round(p.hexRect.h)), fg: [fgm[0], fgm[1], fgm[2], fgm.length > 3 ? fgm[3] : 1], op: 1 }] });
      check(`${label} [${tag}]: #HEX text contrast >= 4.5:1 and rendered ink >= 3.5:1`, r.hex.fgRatio >= 4.5 && r.hex.inkRatio >= 3.5, { computed: +r.hex.fgRatio.toFixed(2), ink: +r.hex.inkRatio.toFixed(2), bg: r.hex.bg });
    }
    return p;
  };
  await verify('initial', expectedHex0);
  // preset swatch -> everything follows
  const presetHex = await page.evaluate(({ sel, attr, cur }) => { const b = [...document.querySelectorAll(sel)].find(x => (x.dataset[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] || '').toLowerCase() !== cur.toLowerCase() && !/^#f{6}$|^#ffffff$/i.test(x.dataset[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] || '')); if (!b) return null; b.scrollIntoView({ behavior: 'instant', block: 'center' }); const r = b.getBoundingClientRect(); return { hex: b.dataset[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())], x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, { sel: ids.preset, attr: ids.attr, cur: expectedHex0 });
  check(`${label}: a preset swatch exists to click`, !!presetHex);
  if (presetHex) { await page.mouse.click(presetHex.x, presetHex.y); await sleep(120); await verify('after preset click', presetHex.hex); }
  // typed HEX in the popover -> toggle follows
  const typed = kind === 'watermark' ? '#d97706' : '#7c3aed';
  await page.click('#' + ids.toggle); await sleep(160);
  const opened = await page.evaluate(({ pop, hexInput }) => { const p = document.getElementById(pop), r = p.getBoundingClientRect(); return { open: !p.hidden, inside: r.left >= -1 && r.top >= -1 && r.right <= document.documentElement.clientWidth + 1 && r.bottom <= innerHeight + 1, hexInputVisible: document.getElementById(hexInput).getBoundingClientRect().width > 40, rect: { x: r.x, y: r.y, w: r.width, h: r.height } }; }, { pop: ids.pop, hexInput: ids.hexInput });
  check(`${label}: popover opens fully inside viewport with a visible HEX input`, opened.open && opened.inside && opened.hexInputVisible, opened);
  await shotEl(page, '#' + ids.pop, `${kind}-color-popover`, 8).catch(() => {});
  await page.click('#' + ids.hexInput, { clickCount: 3 }); await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
  await page.keyboard.type(typed); await page.keyboard.press('Enter'); await sleep(160);
  await verify('after typing HEX in popover', typed);
  await page.keyboard.press('Escape'); await sleep(60);
  await page.click('#' + ids.toggle); await sleep(120);
  const reopened = await page.evaluate(id => document.getElementById(id).value.toUpperCase(), ids.hexInput);
  check(`${label}: re-opened popover HEX input equals the toggle #HEX`, reopened === typed.toUpperCase(), { reopened, typed });
  await page.keyboard.press('Escape'); await sleep(80);
  const stillOpen = await page.evaluate(id => !document.getElementById(id).hidden, ids.pop);
  if (stillOpen) await page.mouse.click(2, 2);
  await sleep(60);
  // Shorthand expands only on commit, never midway through a six-digit entry.
  await page.click('#' + ids.toggle); await sleep(100);
  await page.click('#' + ids.hexInput, { clickCount: 3 });
  await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
  await page.keyboard.type('#abc');
  check(`${label}: three-digit text stays unexpanded while typing`, await page.$eval('#' + ids.hexInput, e => e.value) === '#abc');
  await page.keyboard.press('Enter'); await sleep(100);
  await verify('after shorthand commit', '#aabbcc');
  // Replacing a character inside a complete HEX must not move the caret to the end.
  await page.click('#' + ids.toggle); await sleep(100);
  await page.click('#' + ids.hexInput);
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
  await page.keyboard.type('1');
  const caret = await page.$eval('#' + ids.hexInput, e => ({ value: e.value, start: e.selectionStart, end: e.selectionEnd }));
  check(`${label}: editing a complete HEX preserves the caret position`, caret.value.toUpperCase() === '#A1BBCC' && caret.start === 3 && caret.end === 3, caret);
  await page.keyboard.press('Enter'); await sleep(100);
  await verify('after middle-character edit', '#a1bbcc');
}

// ---- main ----
const browser = await puppeteer.launch({ headless: true, executablePath, userDataDir: path.join(outDir, `chrome-${process.pid}`), args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'] });
let fixture = process.env.PIXELQUOTA_UI_TEST_FIXTURE ? path.resolve(process.env.PIXELQUOTA_UI_TEST_FIXTURE) : null;
try {
  if (!fixture) {
    fs.mkdirSync(path.join(outDir, 'fixtures'), { recursive: true });
    const gen = await browser.newPage();
    const dataUrl = await gen.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 960; c.height = 640; const x = c.getContext('2d');
      [['#ef3340', 0, 0], ['#22b366', 480, 0], ['#3569dc', 0, 320], ['#ffbd1f', 480, 320]].forEach(([col, px, py]) => { x.fillStyle = col; x.fillRect(px, py, 480, 320); });
      x.strokeStyle = '#111'; x.lineWidth = 3; for (let i = -640; i < 960; i += 28) { x.beginPath(); x.moveTo(i, 640); x.lineTo(i + 640, 0); x.stroke(); }
      return c.toDataURL('image/png');
    });
    await gen.close();
    fixture = path.join(outDir, 'fixtures', 'diagnostic-generated.png');
    fs.writeFileSync(fixture, Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  report.fixture = fixture;
  for (const vp of WIDTHS) {
    const page = await browser.newPage();
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
    page.on('pageerror', e => pageErrors.push(`${vp.w}: ${e.message}`));
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.PixelQuotaTest, { timeout: 30000 });
    for (const locale of LOCALES) {
      if (locale !== LOCALES[0]) {
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
        await page.waitForFunction(() => !!window.PixelQuotaTest, { timeout: 30000 });
      }
      combo = `${vp.w}x${locale}`;
      const before = checks.length;
      try {
        const setLocale = async l => { if (await page.evaluate(() => document.documentElement.lang) === l) return; await page.click('#languageToggle'); await page.click(`#languageOptions [data-locale="${l}"]`); await page.waitForFunction(x => document.documentElement.lang === x, {}, l); await sleep(120); };
        const openTool = async mode => {
          await page.evaluate(() => scrollTo({top:0, behavior:'instant'}));
          await page.evaluate(m => document.querySelector(`#toolModeSwitch [data-tool-mode="${m}"]`).scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'center' }), mode);
          await page.click(`#toolModeSwitch [data-tool-mode="${mode}"]`);
          await page.waitForFunction(m => window.PixelQuotaTest.state.toolMode === m, {}, mode);
          if (!await page.evaluate(() => window.PixelQuotaTest.state.files.length)) {
            await (await page.$('#fileInput')).uploadFile(fixture);
            await page.waitForFunction(() => window.PixelQuotaTest.state.files.length === 1, { timeout: 20000 });
          }
          await sleep(700);
        };
        await setLocale(locale);

        // compress/convert: mode, preset, format and RESIZE MODE groups
        await openTool('compress');
        await auditStates(page, 'compressModeSwitch', 'compress mode', 1);
        await auditStates(page, 'presetRow', 'size presets', 1);
        await auditStates(page, 'formatButtons', 'format', 1);
        await auditStates(page, 'resizeButtons', 'resize mode', 1);
        await shotEl(page, '#resizeButtons', 'resize-mode', 12);

        // watermark: ALIGN group + custom colour #HEX
        await openTool('watermark');
        await auditStates(page, 'watermarkAlignButtons', 'watermark align', 2);
        await shotEl(page, '#watermarkAlignButtons', 'watermark-align', 12);
        await page.evaluate(() => document.getElementById('colorPickerToggle').scrollIntoView({ behavior: 'instant', block: 'center' }));
        await auditColor(page, 'watermark', '#ffffff');
        await shotEl(page, '#colorPickerToggle', 'watermark-color', 16);

        // crop groups
        await openTool('crop');
        await auditStates(page, 'cropPlatformButtons', 'crop platform', 1);
        if (await page.evaluate(() => { const g = document.getElementById('cropPresetGrid'); return !!g && g.getBoundingClientRect().width > 0 && g.querySelector('button.active'); })) await auditStates(page, 'cropPresetGrid', 'crop preset grid', 1, { heights: false });

        // redact: method group, block colour #HEX, real region + auto export, both switch states
        await openTool('redact');
        await auditStates(page, 'redactModeButtons', 'redact method', 2);
        await page.evaluate(() => document.querySelector('#redactModeButtons [data-redact-mode="block"]').click());
        await page.waitForFunction(() => !document.getElementById('redactColorWrap').hidden, { timeout: 5000 });
        await sleep(200);
        await auditColor(page, 'redact', '#111827');
        await shotEl(page, '#redactColorWrap', 'redact-color', 16);
        await page.evaluate(() => document.getElementById('redactOverlayCanvas').scrollIntoView({ behavior: 'instant', block: 'center' }));
        const cb = await page.$eval('#redactOverlayCanvas', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
        check('redact: overlay canvas is available to draw a region', cb.w > 50 && cb.h > 50, cb);
        await page.mouse.move(cb.x + cb.w * .2, cb.y + cb.h * .22); await page.mouse.down();
        await page.mouse.move(cb.x + cb.w * .62, cb.y + cb.h * .55, { steps: 10 }); await page.mouse.up();
        const drew = await page.waitForFunction(() => window.PixelQuotaTest.state.redactRegions[0]?.length === 1, { timeout: 10000 }).then(() => true, () => false);
        check('redact: a real region was drawn on the canvas', drew);
        const exported = await page.waitForFunction(() => { const b = document.querySelector('#redactViewSwitch [data-redact-view="compare"]'); const s = window.PixelQuotaTest.state; return b && !b.disabled && !s.busy && !!s.results[0]; }, { timeout: 30000 }).then(() => true, () => false);
        check('redact: automatic export produced a current result (Compare result enabled)', exported, await page.evaluate(() => ({ busy: window.PixelQuotaTest.state.busy, result: !!window.PixelQuotaTest.state.results[0], view: window.PixelQuotaTest.state.redactView })));
        await sleep(400);
        const switchState = () => page.evaluate(() => window.PixelQuotaTest.state.redactView);
        const stage = async tag => {
          const geo = await page.evaluate(() => {
            const s = document.getElementById('redactViewSwitch'), r = s.getBoundingClientRect(), st = document.getElementById('comparisonStage').getBoundingClientRect();
            const others = ['canvasFileLabel', 'canvasPrevBtn', 'canvasNextBtn', 'cropReset', 'backgroundInspectBtn'].map(id => document.getElementById(id)).filter(e => e && !e.hidden && e.getBoundingClientRect().width > 0).map(e => { const o = e.getBoundingClientRect(); return { id: e.id, overlap: !(o.right <= r.left || o.left >= r.right || o.bottom <= r.top || o.top >= r.bottom) }; });
            return { inStage: r.left >= st.left - 1 && r.right <= st.right + 1 && r.top >= st.top - 1 && r.bottom <= st.bottom + 1, inViewport: r.left >= 0 && r.right <= document.documentElement.clientWidth, others, hidden: s.hidden, w: r.width, h: r.height };
          });
          check(`redact view switch [${tag}]: visible, inside stage and viewport, not overlapping other canvas controls`, !geo.hidden && geo.inStage && geo.inViewport && geo.others.every(o => !o.overlap), geo);
        };
        await page.evaluate(() => document.getElementById('comparisonStage').scrollIntoView({ behavior: 'instant', block: 'center' }));
        const v0 = await switchState();
        check('redact view switch: starts in Continue editing state after auto export', v0 === 'edit', v0);
        await stage('edit');
        await measureGroup(page, 'redactViewSwitch', 'redact view switch', 'Continue editing selected');
        await shotEl(page, '#comparisonStage', 'redact-view-edit', 0);
        const clickBtn = async v => { const pt = await page.evaluate(v => { const b = document.querySelector(`#redactViewSwitch [data-redact-view="${v}"]`); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, v); await page.mouse.click(pt.x, pt.y); await sleep(80); };
        await clickBtn('compare');
        check('redact view switch: real click on Compare result switches the view', await switchState() === 'compare', await switchState());
        await page.evaluate(() => document.getElementById('comparisonStage').scrollIntoView({ behavior: 'instant', block: 'center' }));
        await stage('compare');
        await measureGroup(page, 'redactViewSwitch', 'redact view switch', 'Compare result selected');
        await shotEl(page, '#comparisonStage', 'redact-view-compare', 0);
        await clickBtn('edit');
        check('redact view switch: real click on Continue editing switches back', await switchState() === 'edit', await switchState());
        check('page has no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]));
        completedCombos.push(combo);
      } catch (e) {
        comboErrors.push({ combo, error: String(e && e.stack || e) });
        check('combo completed without exception', false, String(e && e.message || e));
      }
      combo = `${vp.w}x${locale}`;
      console.log(`${combo}: ${checks.length - before} checks, ${checks.slice(before).filter(c => !c.pass).length} failed`);
      persist();
    }
    await page.close();
  }
} finally {
  await browser.close().catch(() => {});
  try { fs.rmSync(path.join(outDir, `chrome-${process.pid}`), { recursive: true, force: true }); } catch {}
}
persist();
console.log(JSON.stringify({ passed: report.passed, checks: report.summary, expectedCombos, actualCombos: completedCombos.length, pageErrors: pageErrors.length, report: reportPath }, null, 2));
process.exit(report.passed ? 0 : 1);
