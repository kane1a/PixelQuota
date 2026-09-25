// PixelQuota layer tracer: multi-colour, gradient-aware, sub-pixel vectoriser for logos and flat artwork.
//
// Pipeline
//  1. Segment the image into flat or smoothly-varying regions (region growing on a lightly denoised copy).
//  2. Fit each region with a colour model: flat, linear gradient, radial gradient; measure leftover grain.
//  3. Explain every anti-aliased edge pixel as a mix of its two neighbouring regions (premultiplied RGBA),
//     which yields a sub-pixel coverage value per region instead of a hard threshold.
//  4. Pixels no pair of regions can explain are thin strokes (hairlines); straight ones become exact rectangles.
//  5. Merge regions of the same flat colour into one layer; stack layers bottom-up, each layer extending a few
//     px under the layers above it so no seams or background slivers show between colours.
//  6. Contour each layer at coverage 0.5 (marching squares), then rebuild it as corners + straight lines +
//     cubic curves.
import { fitCubic } from 'fit-curve';

const hypot = Math.hypot;
const r2 = v => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

/* ------------------------------------------------------------------ geometry: contour → path ------------------------------------------------------------------ */

function loopArea(loop) { let s = 0; for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; s += a.x * b.y - b.x * a.y; } return s / 2; }

function corners(loop, span, minAngle) {
  const n = loop.length, cum = [0];
  for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + hypot(loop[i % n].x - loop[i - 1].x, loop[i % n].y - loop[i - 1].y));
  const total = cum[n]; if (total < span * 6) return [];
  const at = s => { s = ((s % total) + total) % total; let lo = 0, hi = n; while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; } const a = loop[lo], b = loop[(lo + 1) % n], t = (s - cum[lo]) / ((cum[lo + 1] - cum[lo]) || 1); return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; };
  const ang = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = loop[i], a = at(cum[i] - span), b = at(cum[i] + span);
    const v1x = p.x - a.x, v1y = p.y - a.y, v2x = b.x - p.x, v2y = b.y - p.y, l1 = hypot(v1x, v1y), l2 = hypot(v2x, v2y);
    ang[i] = l1 < 1e-6 || l2 < 1e-6 ? 0 : Math.acos(clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1)) * 180 / Math.PI;
  }
  const picks = [];
  for (let i = 0; i < n; i++) {
    if (ang[i] < minAngle) continue;
    let isMax = true;
    for (let d = 1; d < n && cum[Math.min(n, i + d)] - cum[i] < span; d++) { if (ang[(i + d) % n] > ang[i] || ang[(i - d + n) % n] > ang[i]) { isMax = false; break; } }
    if (isMax && !picks.some(j => Math.abs(cum[j] - cum[i]) < span || total - Math.abs(cum[j] - cum[i]) < span)) picks.push(i);
  }
  return picks.sort((a, b) => a - b);
}

function tlsLine(points) {
  let mx = 0, my = 0; for (const p of points) { mx += p.x; my += p.y; } mx /= points.length; my /= points.length;
  let sxx = 0, syy = 0, sxy = 0; for (const p of points) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let dir = { x: Math.cos(theta), y: Math.sin(theta) };
  const deg = Math.abs(theta * 180 / Math.PI) % 90;
  if (deg < 2 || deg > 88) dir = Math.abs(dir.x) > Math.abs(dir.y) ? { x: 1, y: 0 } : { x: 0, y: 1 };
  let maxDev = 0; for (const p of points) maxDev = Math.max(maxDev, Math.abs((p.x - mx) * dir.y - (p.y - my) * dir.x));
  return { c: { x: mx, y: my }, dir, maxDev };
}
function intersect(a, b) {
  const det = a.dir.x * b.dir.y - a.dir.y * b.dir.x; if (Math.abs(det) < 1e-6) return null;
  const t = ((b.c.x - a.c.x) * b.dir.y - (b.c.y - a.c.y) * b.dir.x) / det;
  return { x: a.c.x + a.dir.x * t, y: a.c.y + a.dir.y * t };
}
function smoothOpen(pts, passes) {
  let cur = pts;
  for (let k = 0; k < passes; k++) { const nx = cur.slice(); for (let i = 1; i < cur.length - 1; i++) nx[i] = { x: (cur[i - 1].x + 2 * cur[i].x + cur[i + 1].x) / 4, y: (cur[i - 1].y + 2 * cur[i].y + cur[i + 1].y) / 4 }; cur = nx; }
  return cur;
}
function smoothClosed(pts, passes) {
  let cur = pts; const n = pts.length;
  for (let k = 0; k < passes; k++) cur = cur.map((p, i) => { const a = cur[(i - 1 + n) % n], c = cur[(i + 1) % n]; return { x: (a.x + 2 * p.x + c.x) / 4, y: (a.y + 2 * p.y + c.y) / 4 }; });
  return cur;
}
const bez = c => `C${r2(c[1][0])} ${r2(c[1][1])} ${r2(c[2][0])} ${r2(c[2][1])} ${r2(c[3][0])} ${r2(c[3][1])}`;
function chordOk(pts, i, j, tol) {
  const a = pts[i], b = pts[j], dx = b.x - a.x, dy = b.y - a.y, L = hypot(dx, dy);
  if (L < 1e-6) return false;
  for (let k = i + 1; k < j; k++) if (Math.abs((pts[k].x - a.x) * dy - (pts[k].y - a.y) * dx) / L > tol) return false;
  return true;
}
// Longest-first straight runs; chains of short chords at shallow angles are arcs, not lines.
function straightRuns(pts, tol, minLen) {
  const n = pts.length, reach = new Int32Array(n);
  for (let i = 0; i < n - 1; i++) {
    let j = Math.max(i + 1, i > 0 ? reach[i - 1] : i + 1);
    if (j > i + 1 && !chordOk(pts, i, j, tol)) j = i + 1;
    while (j + 1 < n && chordOk(pts, i, j + 1, tol)) j++;
    reach[i] = j;
  }
  const cand = [];
  for (let i = 0; i < n - 1; i++) { const L = hypot(pts[reach[i]].x - pts[i].x, pts[reach[i]].y - pts[i].y); if (L >= minLen) cand.push([i, reach[i], L]); }
  // A chord of a gentle arc bows: its middle sits consistently off the line compared with its ends.
  const bowed = (i, j) => {
    const A = pts[i], B = pts[j], dx = B.x - A.x, dy = B.y - A.y, L = hypot(dx, dy); if (L < 1e-6) return false;
    let mid = 0, nm = 0, end = 0, ne = 0;
    for (let k = i; k <= j; k++) { const t = (k - i) / ((j - i) || 1), dev = ((pts[k].x - A.x) * dy - (pts[k].y - A.y) * dx) / L; if (t > 0.33 && t < 0.67) { mid += dev; nm++; } else { end += dev; ne++; } }
    return nm && ne && Math.abs(mid / nm - end / ne) > 0.09;
  };
  for (let k = cand.length - 1; k >= 0; k--) if (bowed(cand[k][0], cand[k][1])) cand.splice(k, 1);
  cand.sort((a, b) => b[2] - a[2]);
  const taken = new Uint8Array(n), runs = [];
  for (const [a, b] of cand) {
    let free = true; for (let k = a + 1; k < b; k++) if (taken[k]) { free = false; break; }
    if (!free || taken[a] === 2 || taken[b] === 2) continue;
    for (let k = a + 1; k < b; k++) taken[k] = 2;
    taken[a] = taken[a] || 1; taken[b] = taken[b] || 1;
    runs.push([a, b]);
  }
  runs.sort((a, b) => a[0] - b[0]);
  const ang = r => Math.atan2(pts[r[1]].y - pts[r[0]].y, pts[r[1]].x - pts[r[0]].x);
  const len = r => hypot(pts[r[1]].x - pts[r[0]].x, pts[r[1]].y - pts[r[0]].y);
  const turn = (a, b) => { let t = Math.abs(ang(a) - ang(b)) * 180 / Math.PI; return t > 180 ? 360 - t : t; };
  const drop = new Set();
  for (let k = 1; k < runs.length; k++) {
    const a = runs[k - 1], b = runs[k];
    if (b[0] - a[1] <= Math.max(4, 0.5 * Math.min(len(a), len(b))) && turn(a, b) < 25) { drop.add(k - 1); drop.add(k); }
  }
  return runs.filter((_, k) => !drop.has(k));
}
const unit = (x, y) => { const l = hypot(x, y) || 1; return [x / l, y / l]; };
function spanPath(pts, o) {
  const runs = straightRuns(pts, o.runTolerance, o.minRunLength);
  for (const r of runs) { if (r[0] <= 3) r[0] = 0; if (r[1] >= pts.length - 4) r[1] = pts.length - 1; }
  let d = '';
  const curve = (i, j, tIn, tOut) => {
    const sub = pts.slice(i, j + 1).map(p => [p.x, p.y]);
    if (sub.length < 3) { d += `L${r2(sub[sub.length - 1][0])} ${r2(sub[sub.length - 1][1])}`; return; }
    const lt = tIn || unit(sub[1][0] - sub[0][0], sub[1][1] - sub[0][1]);
    const rt = tOut || unit(sub[sub.length - 2][0] - sub[sub.length - 1][0], sub[sub.length - 2][1] - sub[sub.length - 1][1]);
    d += fitCubic(sub, lt, rt, o.fitError).map(bez).join('');
  };
  let at = 0, tIn = null;
  for (const [a, b] of runs) {
    const dir = unit(pts[b].x - pts[a].x, pts[b].y - pts[a].y);
    if (a > at) curve(at, a, tIn, [-dir[0], -dir[1]]);
    d += `L${r2(pts[b].x)} ${r2(pts[b].y)}`;
    at = b; tIn = dir;
  }
  if (at < pts.length - 1) curve(at, pts.length - 1, tIn, null);
  return d;
}
// Coarse corners are robust to ripple; fine corners catch the two ends of thin bars that the coarse window merges.
function multiScaleCorners(loop, o) {
  const coarse = corners(loop, o.cornerSpan, o.cornerAngle), fine = corners(loop, 1.2, 55);
  if (!fine.length) return coarse;
  const n = loop.length, near = (i, j) => { const d = Math.abs(i - j); return Math.min(d, n - d) <= 3; };
  const out = coarse.slice();
  for (const f of fine) {
    if (out.some(c => near(c, f))) continue;
    // Only keep a fine corner if a coarse corner sits within ~2×span: it is the second end of a thin tip.
    const partner = coarse.find(c => { const d = Math.abs(c - f); return Math.min(d, n - d) <= o.cornerSpan * 3; });
    if (partner !== undefined) out.push(f);
  }
  // A coarse corner lying between two fine corners of the same tip is the blurred tip itself: replace it.
  const fineSet = fine.filter(f => !coarse.some(c => near(c, f)));
  const final = out.filter(c => !(coarse.includes(c) && fineSet.filter(f => { const d = Math.abs(c - f); return Math.min(d, n - d) <= o.cornerSpan * 1.5; }).length >= 2));
  return [...new Set(final)].sort((a, b) => a - b);
}
function traceLoop(loop, o) {
  if (loop.length < 8) return `M${loop.map(p => `${r2(p.x)} ${r2(p.y)}`).join('L')}Z`;
  const cs = multiScaleCorners(loop, o);
  if (!cs.length) {
    const sm = smoothClosed(loop, o.smoothPasses), ring = [...sm, sm[0]];
    return `M${r2(ring[0].x)} ${r2(ring[0].y)}` + spanPath(ring, o) + 'Z';
  }
  const n = loop.length, segs = [];
  for (let k = 0; k < cs.length; k++) {
    const a = cs[k], b = cs[(k + 1) % cs.length], pts = [];
    // With a single corner the span wraps the whole loop back to itself.
    for (let i = a, steps = 0; ; i = (i + 1) % n, steps++) { pts.push(loop[i]); if (i === b && steps > 0) break; }
    const trim = pts.length > 8 ? Math.min(3, Math.floor(pts.length / 4)) : 0, core = pts.slice(trim, pts.length - trim || undefined);
    const line = core.length >= 2 ? tlsLine(core) : null;
    const tol = pts.length <= 14 ? o.lineTolerance * 2 : o.lineTolerance;
    segs.push({ pts, line: line && line.maxDev <= tol ? line : null });
  }
  const cornerPt = segs.map((s, k) => {
    const prev = segs[(k - 1 + segs.length) % segs.length], raw = s.pts[0];
    if (prev.line && s.line) { const x = intersect(prev.line, s.line); if (x && hypot(x.x - raw.x, x.y - raw.y) < o.maxCornerShift) return x; }
    return raw;
  });
  let d = `M${r2(cornerPt[0].x)} ${r2(cornerPt[0].y)}`;
  segs.forEach((s, k) => {
    const end = cornerPt[(k + 1) % segs.length];
    if (s.line) { d += `L${r2(end.x)} ${r2(end.y)}`; return; }
    const sp = smoothOpen(s.pts, o.smoothPasses);
    sp[0] = cornerPt[k]; sp[sp.length - 1] = end;
    d += sp.length < 3 ? `L${r2(end.x)} ${r2(end.y)}` : spanPath(sp, o);
  });
  return d + 'Z';
}

// Marching squares over a field defined on [x0,x0+bw)×[y0,y0+bh). Returns loops in image coordinates
// (pixel i covers [i,i+1], so its centre sits at i+0.5). Ink (field ≥ iso) is always on the right.
function marchingSquares(field, x0, y0, bw, bh, iso = 0.5) {
  const v = (x, y) => (x <= 0 || y <= 0 || x > bw || y > bh) ? 0 : field[(y - 1) * bw + (x - 1)];
  const next = new Map(), pts = new Map();
  const key = (x, y, h) => (h ? 1 : 0) + 2 * (x + (bw + 3) * y);
  const edge = (x, y, h) => {
    const k = key(x, y, h);
    if (!pts.has(k)) {
      const a = v(x, y), b = h ? v(x + 1, y) : v(x, y + 1), t = (iso - a) / ((b - a) || 1e-9);
      pts.set(k, h ? { x: x0 + x + t - 1 + 0.5, y: y0 + y - 1 + 0.5 } : { x: x0 + x - 1 + 0.5, y: y0 + y + t - 1 + 0.5 });
    }
    return k;
  };
  for (let y = 0; y <= bh; y++) for (let x = 0; x <= bw; x++) {
    const a = v(x, y), b = v(x + 1, y), c = v(x + 1, y + 1), e = v(x, y + 1);
    const idx = (a >= iso ? 8 : 0) | (b >= iso ? 4 : 0) | (c >= iso ? 2 : 0) | (e >= iso ? 1 : 0);
    if (idx === 0 || idx === 15) continue;
    const T = () => edge(x, y, true), B = () => edge(x, y + 1, true), L = () => edge(x, y, false), R = () => edge(x + 1, y, false);
    const centre = (a + b + c + e) / 4 >= iso;
    const seg = { 1: [[L, B]], 2: [[B, R]], 3: [[L, R]], 4: [[R, T]], 6: [[B, T]], 7: [[L, T]], 8: [[T, L]], 9: [[T, B]], 11: [[T, R]], 12: [[R, L]], 13: [[R, B]], 14: [[B, L]],
      5: centre ? [[L, T], [R, B]] : [[L, B], [R, T]], 10: centre ? [[T, R], [B, L]] : [[T, L], [B, R]] }[idx];
    for (const [p, q] of seg) next.set(p(), q());
  }
  const loops = [], used = new Set();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop = []; let k = start, guard = 0;
    while (k !== undefined && !used.has(k) && guard++ < 5e6) { used.add(k); loop.push(pts.get(k)); k = next.get(k); }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/* ------------------------------------------------------------------ colour models ------------------------------------------------------------------ */

// Colours are premultiplied RGBA floats in 0..255.
const dist4 = (a, b) => hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);

function solve3(m, v) {
  const [a, b, c, d, e, f, g, h, i] = m, det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return null;
  const inv = [(e * i - f * h), -(b * i - c * h), (b * f - c * e), -(d * i - f * g), (a * i - c * g), -(a * f - c * d), (d * h - e * g), -(a * h - b * g), (a * e - b * d)].map(x => x / det);
  return [inv[0] * v[0] + inv[1] * v[1] + inv[2] * v[2], inv[3] * v[0] + inv[4] * v[1] + inv[5] * v[2], inv[6] * v[0] + inv[7] * v[1] + inv[8] * v[2]];
}

// 1-D colour profile along parameter t (binned means, empty bins interpolated).
function buildProfile(ts, cols, tmin, tmax) {
  const K = clamp(Math.round((tmax - tmin) / 3), 4, 48), sum = Array.from({ length: K }, () => [0, 0, 0, 0]), cnt = new Float32Array(K);
  const span = (tmax - tmin) || 1;
  for (let i = 0; i < ts.length; i++) { const k = clamp(Math.floor((ts[i] - tmin) / span * K), 0, K - 1); cnt[k]++; for (let c = 0; c < 4; c++) sum[k][c] += cols[i][c]; }
  const val = sum.map((s, k) => cnt[k] ? s.map(x => x / cnt[k]) : null);
  for (let k = 0; k < K; k++) if (!val[k]) { let a = k - 1, b = k + 1; while (a >= 0 && !val[a]) a--; while (b < K && !val[b]) b++; val[k] = a >= 0 && b < K ? val[a].map((x, c) => (x + val[b][c]) / 2) : (a >= 0 ? val[a] : val[b]).slice(); }
  const centers = val.map((_, k) => tmin + (k + 0.5) / K * span);
  const at = t => {
    const f = (t - tmin) / span * K - 0.5, k = clamp(Math.floor(f), 0, K - 1), k2 = Math.min(K - 1, k + 1), w = clamp(f - k, 0, 1);
    return [0, 1, 2, 3].map(c => val[k][c] * (1 - w) + val[k2][c] * w);
  };
  return { tmin, tmax, centers, val, at };
}
function profileRms(ts, cols, prof) { let e = 0; for (let i = 0; i < ts.length; i++) { const p = prof.at(ts[i]); for (let c = 0; c < 4; c++) e += (cols[i][c] - p[c]) ** 2; } return Math.sqrt(e / (ts.length * 4)); }

// Douglas–Peucker on the colour profile → minimal gradient stops.
function profileStops(prof, tol = 2.5) {
  const pts = prof.centers.map((t, k) => ({ t, c: prof.val[k] }));
  pts.unshift({ t: prof.tmin, c: prof.at(prof.tmin) }); pts.push({ t: prof.tmax, c: prof.at(prof.tmax) });
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const rec = (a, b) => {
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) { const w = (pts[i].t - pts[a].t) / ((pts[b].t - pts[a].t) || 1); const lerp = pts[a].c.map((x, c) => x + (pts[b].c[c] - x) * w); const e = dist4(lerp, pts[i].c); if (e > worst) { worst = e; wi = i; } }
    if (worst > tol) { keep[wi] = 1; rec(a, wi); rec(wi, b); }
  };
  rec(0, pts.length - 1);
  const span = (prof.tmax - prof.tmin) || 1;
  return pts.filter((_, i) => keep[i]).map(p => ({ offset: clamp((p.t - prof.tmin) / span, 0, 1), color: p.c }));
}

function fitRegionModel(reg, P, w) {
  const idx = reg.samples, n = idx.length, xs = new Float32Array(n), ys = new Float32Array(n), cols = new Array(n);
  let mx = 0, my = 0; const mean = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) { const p = idx[i]; xs[i] = p % w + 0.5; ys[i] = Math.floor(p / w) + 0.5; mx += xs[i]; my += ys[i]; const c = [P[p * 4], P[p * 4 + 1], P[p * 4 + 2], P[p * 4 + 3]]; cols[i] = c; for (let k = 0; k < 4; k++) mean[k] += c[k]; }
  mx /= n; my /= n; for (let k = 0; k < 4; k++) mean[k] /= n;
  let eF = 0; for (const c of cols) for (let k = 0; k < 4; k++) eF += (c[k] - mean[k]) ** 2;
  const rmsFlat = Math.sqrt(eF / (n * 4));
  const flat = { kind: 'flat', color: mean, rms: rmsFlat, at: () => mean };
  if (rmsFlat <= 2.2 + (reg.noise || 0) * 0.8 || n < 24) return flat;

  // Linear: least squares per channel, then a single dominant direction.
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0; const bx = [0, 0, 0, 0], by = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; sx += dx; sy += dy; }
  for (let k = 0; k < 4; k++) {
    let vx = 0, vy = 0; for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my, dc = cols[i][k] - mean[k]; vx += dx * dc; vy += dy * dc; }
    const s = solve3([n, sx, sy, sx, sxx, sxy, sy, sxy, syy], [0, vx, vy]); if (s) { bx[k] = s[1]; by[k] = s[2]; }
  }
  let a11 = 0, a12 = 0, a22 = 0; for (let k = 0; k < 4; k++) { a11 += bx[k] * bx[k]; a12 += bx[k] * by[k]; a22 += by[k] * by[k]; }
  const th = 0.5 * Math.atan2(2 * a12, a11 - a22); let u = [Math.cos(th), Math.sin(th)];
  const deg = Math.abs(th * 180 / Math.PI) % 90; if (deg < 1.5) u = Math.abs(u[0]) > Math.abs(u[1]) ? [Math.sign(u[0]) || 1, 0] : [0, Math.sign(u[1]) || 1]; else if (deg > 88.5) u = Math.abs(u[0]) > Math.abs(u[1]) ? [Math.sign(u[0]) || 1, 0] : [0, Math.sign(u[1]) || 1];
  const tl = new Float32Array(n); let tmin = Infinity, tmax = -Infinity;
  for (let i = 0; i < n; i++) { tl[i] = (xs[i] - mx) * u[0] + (ys[i] - my) * u[1]; if (tl[i] < tmin) tmin = tl[i]; if (tl[i] > tmax) tmax = tl[i]; }
  const profL = buildProfile(tl, cols, tmin, tmax), rmsLin = profileRms(tl, cols, profL);
  const linear = { kind: 'linear', rms: rmsLin, cx: mx, cy: my, u, prof: profL, at: (x, y) => profL.at((x - mx) * u[0] + (y - my) * u[1]) };

  // Radial: coarse grid search for the centre, then local refinement.
  const { x0, y0, x1, y1 } = reg.bbox, bwid = x1 - x0 + 1, bhei = y1 - y0 + 1;
  const tryCentre = (cx, cy) => {
    let st = 0, st2 = 0; const sc = [0, 0, 0, 0], stc = [0, 0, 0, 0], t = new Float32Array(n);
    for (let i = 0; i < n; i++) { t[i] = hypot(xs[i] - cx, ys[i] - cy); st += t[i]; st2 += t[i] * t[i]; for (let k = 0; k < 4; k++) { sc[k] += cols[i][k]; stc[k] += t[i] * cols[i][k]; } }
    const den = n * st2 - st * st; if (Math.abs(den) < 1e-6) return { e: Infinity };
    let e = 0; const A = [], B = [];
    for (let k = 0; k < 4; k++) { B[k] = (n * stc[k] - st * sc[k]) / den; A[k] = (sc[k] - B[k] * st) / n; }
    for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) e += (cols[i][k] - A[k] - B[k] * t[i]) ** 2;
    return { e, cx, cy };
  };
  let best = { e: Infinity }, step = Math.max(bwid, bhei) * 0.3;
  for (let gy = 0; gy <= 6; gy++) for (let gx = 0; gx <= 6; gx++) { const r = tryCentre(x0 - bwid * 0.3 + gx / 6 * bwid * 1.6, y0 - bhei * 0.3 + gy / 6 * bhei * 1.6); if (r.e < best.e) best = r; }
  for (let it = 0; it < 4 && isFinite(best.e); it++) { const b0 = best; for (let gy = -1; gy <= 1; gy++) for (let gx = -1; gx <= 1; gx++) { const r = tryCentre(b0.cx + gx * step / 2, b0.cy + gy * step / 2); if (r.e < best.e) best = r; } step /= 2; }
  let radial = null;
  if (isFinite(best.e)) {
    const tr = new Float32Array(n); let rmin = Infinity, rmax = 0;
    for (let i = 0; i < n; i++) { tr[i] = hypot(xs[i] - best.cx, ys[i] - best.cy); rmin = Math.min(rmin, tr[i]); rmax = Math.max(rmax, tr[i]); }
    const profR = buildProfile(tr, cols, rmin, rmax), rmsRad = profileRms(tr, cols, profR);
    const cx = best.cx, cy = best.cy;
    radial = { kind: 'radial', rms: rmsRad, cx, cy, prof: profR, at: (x, y) => profR.at(hypot(x - cx, y - cy)) };
  }
  // A gradient must explain clearly more than the noise floor, or a noisy flat fill turns into a fake gradient.
  const gain = (a, b) => b.rms < a.rms * 0.8 && a.rms - b.rms > 1.5 + (reg.noise || 0) * 0.6;
  let model = flat;
  if (gain(flat, linear)) model = linear;
  if (radial && gain(model, radial) && radial.rms < model.rms * 0.85) model = radial;
  return model;
}

/* ------------------------------------------------------------------ main ------------------------------------------------------------------ */

function boxBlur(src, w, h, r) {
  const out = new Float32Array(src.length), tmp = new Float32Array(src.length), win = 2 * r + 1;
  for (let y = 0; y < h; y++) for (let c = 0; c < 4; c++) {
    let acc = 0; for (let k = -r; k <= r; k++) acc += src[(y * w + clamp(k, 0, w - 1)) * 4 + c];
    for (let x = 0; x < w; x++) { tmp[(y * w + x) * 4 + c] = acc / win; acc += src[(y * w + clamp(x + r + 1, 0, w - 1)) * 4 + c] - src[(y * w + clamp(x - r, 0, w - 1)) * 4 + c]; }
  }
  for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    let acc = 0; for (let k = -r; k <= r; k++) acc += tmp[(clamp(k, 0, h - 1) * w + x) * 4 + c];
    for (let y = 0; y < h; y++) { out[(y * w + x) * 4 + c] = acc / win; acc += tmp[(clamp(y + r + 1, 0, h - 1) * w + x) * 4 + c] - tmp[(clamp(y - r, 0, h - 1) * w + x) * 4 + c]; }
  }
  return out;
}

const hex = v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
function cssColor(c) { const a = c[3]; if (a < 0.5) return { fill: '#000000', opacity: 0 }; const un = [0, 1, 2].map(k => c[k] * 255 / a); return { fill: `#${un.map(hex).join('')}`, opacity: a / 255 }; }

export const LAYER_TRACE_DEFAULTS = { gradientMode: 'fit', fitError: 0.45, lineTolerance: 0.45, cornerAngle: 40, cornerSpan: 3.2, maxCornerShift: 4, smoothPasses: 3, runTolerance: 0.3, minRunLength: 18 };

export function traceLayers(imageData, options = {}) {
  const o = { ...LAYER_TRACE_DEFAULTS, ...options };
  const { width: w, height: h, data } = imageData, N = w * h;
  const t0 = performance.now();

  // Premultiplied colour.
  const P = new Float32Array(N * 4);
  for (let p = 0; p < N; p++) { const a = data[p * 4 + 3] / 255; P[p * 4] = data[p * 4] * a; P[p * 4 + 1] = data[p * 4 + 1] * a; P[p * 4 + 2] = data[p * 4 + 2] * a; P[p * 4 + 3] = data[p * 4 + 3]; }

  // Noise estimate (median |Δluma| between horizontal neighbours, ignoring edges).
  const diffs = []; const stride = Math.max(1, Math.floor(N / 60000));
  for (let p = 0; p < N - 1; p += stride) { if ((p + 1) % w === 0) continue; const d = Math.abs(P[p * 4] + P[p * 4 + 1] + P[p * 4 + 2] - P[p * 4 + 4] - P[p * 4 + 5] - P[p * 4 + 6]) / 3; if (d < 40) diffs.push(d); }
  diffs.sort((a, b) => a - b);
  // Clean renders are exactly flat almost everywhere; lossy sources scatter many small non-zero steps.
  const small = diffs.filter(d => d > 0.5 && d < 12), smallRatio = diffs.length ? small.length / diffs.length : 0;
  const est = smallRatio > 0.02 ? small[Math.floor(small.length * 0.5)] : diffs.length ? diffs[Math.floor(diffs.length * 0.75)] : 0;
  const noise = Math.max(est, o.lossy ? 3 : 0);
  const blurR = noise > 5 ? 3 : noise > 1.5 ? 1 : 0;
  let S = P; if (blurR) { S = boxBlur(P, w, h, blurR); if (blurR > 1) S = boxBlur(S, w, h, blurR); }

  // Flat mask + region growing.
  const tauFlat = 9 + noise * 0.6, tauStep = 5 + noise * 0.4;
  const maxDiff = (p, q) => Math.max(Math.abs(S[p * 4] - S[q * 4]), Math.abs(S[p * 4 + 1] - S[q * 4 + 1]), Math.abs(S[p * 4 + 2] - S[q * 4 + 2]), Math.abs(S[p * 4 + 3] - S[q * 4 + 3]));
  const flat = new Uint8Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x; let m = 0;
    if (x > 0) m = Math.max(m, maxDiff(p, p - 1)); if (x < w - 1) m = Math.max(m, maxDiff(p, p + 1));
    if (y > 0) m = Math.max(m, maxDiff(p, p - w)); if (y < h - 1) m = Math.max(m, maxDiff(p, p + w));
    flat[p] = m <= tauFlat ? 1 : 0;
  }
  const labels = new Int32Array(N); const regions = [null]; const stack = new Int32Array(N);
  const minRegion = Math.max(6, Math.round(N * 0.00001));
  for (let s = 0; s < N; s++) {
    if (!flat[s] || labels[s]) continue;
    const id = regions.length; let sp = 0, count = 0; stack[sp++] = s; labels[s] = id;
    const members = [];
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (sp) {
      const p = stack[--sp]; count++; members.push(p);
      const x = p % w, y = (p / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && flat[q] && !labels[q] && maxDiff(p, q) <= tauStep) { labels[q] = id; stack[sp++] = q; }
    }
    if (count < minRegion) { for (const p of members) labels[p] = -1; regions.push(null); continue; }
    // Deterministic sample of up to 5000 member pixels.
    const step = Math.max(1, Math.floor(count / 5000)), samples = [];
    for (let i = 0; i < count; i += step) samples.push(members[i]);
    regions.push({ id, count, bbox: { x0, y0, x1, y1 }, samples });
    if (regions.length > 6000) return { status: 'complex', reason: 'too_many_regions', ms: performance.now() - t0 };
  }
  for (let p = 0; p < N; p++) if (labels[p] < 0) labels[p] = 0;

  // Colour models.
  let complexArea = 0, totalArea = 0;
  const hfEnergy = reg => {
    let e = 0, n = 0;
    for (const p of reg.samples) {
      const x = p % w, y = (p / w) | 0; if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const nb = [p - 1, p + 1, p - w, p + w]; if (nb.some(q => labels[q] !== reg.id)) continue;
      for (let c = 0; c < 3; c++) { const m = (P[nb[0] * 4 + c] + P[nb[1] * 4 + c] + P[nb[2] * 4 + c] + P[nb[3] * 4 + c]) / 4; e += (P[p * 4 + c] - m) ** 2; n++; }
    }
    return n ? Math.sqrt(e / n) : 0;
  };
  for (const reg of regions) {
    if (!reg) continue;
    reg.noise = noise; reg.model = fitRegionModel(reg, P, w);
    reg.grain = 0; reg.complex = false;
    const hf = hfEnergy(reg);
    if (hf > Math.max(2.6, noise * 2.2)) reg.grain = hf * 1.15;                                   // pixel-scale noise = grain / film texture
    const smoothResidual = Math.sqrt(Math.max(0, reg.model.rms ** 2 - (reg.grain ? hf * hf : 0)));
    if (reg.model.kind !== 'flat' && smoothResidual > 4.5 + noise) { reg.complex = true; complexArea += reg.count; }  // colour field too rich for one gradient
    else if (reg.model.kind === 'flat' && !reg.grain && reg.model.rms > 4.5 + noise * 1.5) { reg.complex = true; complexArea += reg.count; }
    totalArea += reg.count;
  }

  // Background: region group dominating the image border.
  const borderCount = new Map(); let borderTotal = 0; // recomputed after pruning
  const addB = p => { borderTotal++; const l = labels[p]; if (l) borderCount.set(l, (borderCount.get(l) || 0) + 1); };
  for (let x = 0; x < w; x++) { addB(x); addB((h - 1) * w + x); } for (let y = 1; y < h - 1; y++) { addB(y * w); addB(y * w + w - 1); }

  // Group flat regions by colour; gradient / grain / complex regions stay on their own.
  const groups = [];
  const flatRegs = regions.filter(r => r && r.model.kind === 'flat' && !r.grain && !r.complex).sort((a, b) => b.count - a.count);
  for (const r of flatRegs) {
    let g = groups.find(g => g.kind === 'flat' && dist4(g.color, r.model.color) <= 12 + 1.2 * noise);
    if (!g) { g = { kind: 'flat', color: r.model.color.slice(), members: [], area: 0 }; groups.push(g); }
    g.members.push(r); g.color = g.color.map((c, k) => (c * g.area + r.model.color[k] * r.count) / (g.area + r.count)); g.area += r.count;
  }
  for (const r of regions) if (r && !flatRegs.includes(r)) groups.push({ kind: r.model.kind === 'flat' ? 'textured' : r.model.kind, color: r.model.color, grain: r.grain, complex: r.complex, model: r.model, members: [r], area: r.count });
  // Colour layers smaller than this are compression debris or anti-aliasing plateaus, not artwork.
  const minLayer = Math.max(30, Math.round(N * (noise > 1.5 ? 0.0004 : 0.0001)));
  const pruned = new Uint8Array(regions.length);
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi]; if (g.area >= minLayer) continue;
    for (const r of g.members) { pruned[r.id] = 1; regions[r.id] = null; }
    groups.splice(gi, 1);
  }
  for (let p = 0; p < N; p++) if (pruned[labels[p]]) labels[p] = 0;
  // Anti-aliasing / JPEG plateaus: thin bands whose colour is a blend of two bigger flat layers.
  {
    const big = groups.filter(g => g.kind === 'flat').sort((a, b) => b.area - a.area);
    const edgeCount = g => { let e = 0; for (const r of g.members) for (const p of r.samples) { const x = p % w, y = (p / w) | 0; if ((x > 0 && labels[p - 1] !== r.id) || (x < w - 1 && labels[p + 1] !== r.id) || (y > 0 && labels[p - w] !== r.id) || (y < h - 1 && labels[p + w] !== r.id)) e++; } return e / g.members.reduce((t, r) => t + r.samples.length, 0); };
    const killed = new Uint8Array(regions.length); let any = false;
    for (const g of big) {
      if (g.area > N * 0.02) continue;
      const blend = big.some(A => A !== g && A.area > g.area * 2 && big.some(B => {
        if (B === A || B === g || B.area <= g.area * 2) return false;
        const d = A.color.map((v, k) => v - B.color[k]), dd = d.reduce((t, v) => t + v * v, 0); if (dd < 1) return false;
        const t = clamp(d.reduce((s2, v, k) => s2 + v * (g.color[k] - B.color[k]), 0) / dd, 0, 1);
        return t > 0.08 && t < 0.92 && hypot(...d.map((v, k) => g.color[k] - B.color[k] - t * v)) < 14 + 2 * noise;
      }));
      if (blend && edgeCount(g) > 0.35) { for (const r of g.members) { killed[r.id] = 1; regions[r.id] = null; } g.dead = true; any = true; }
    }
    if (any) { for (let p = 0; p < N; p++) if (killed[labels[p]]) labels[p] = 0; for (let gi = groups.length - 1; gi >= 0; gi--) if (groups[gi].dead) groups.splice(gi, 1); }
  }
  // Gradient models only make sense on large areas; tiny "gradients" are edge debris.
  for (const g of groups) if ((g.kind === 'linear' || g.kind === 'radial') && g.area < N * 0.003) {
    const m = g.model, c = m.at((m.cx || 0), (m.cy || 0)); g.kind = 'flat'; g.color = c; g.model = { kind: 'flat', color: c, rms: m.rms, at: () => c };
    for (const r of g.members) r.model = g.model;
  }
  for (const g of groups) for (const r of g.members) r.group = g;
  borderCount.clear(); borderTotal = 0;
  for (let x = 0; x < w; x++) { addB(x); addB((h - 1) * w + x); } for (let y = 1; y < h - 1; y++) { addB(y * w); addB(y * w + w - 1); }
  let bgGroup = null, bgScore = 0;
  for (const [l, n] of borderCount) { if (!regions[l]) continue; const g = regions[l].group; g.border = (g.border || 0) + n; }
  for (const g of groups) if ((g.border || 0) > bgScore) { bgScore = g.border; bgGroup = g; }
  if (bgGroup && bgScore < borderTotal * 0.5) bgGroup = null;
  const transparentBg = bgGroup && bgGroup.kind === 'flat' && bgGroup.color[3] < 8;

  // Snap flat group colours to the exact dominant interior colour (kills 19/20-style near duplicates).
  for (const g of groups) if (g.kind === 'flat' && g.color) { g.color = g.color.map(c => Math.round(c)); for (const r of g.members) r.model = { ...r.model, color: g.color, at: () => g.color }; }

  // Pixel colour predicted by a region's model.
  const regColor = (id, p) => { const r = regions[id]; return r.model.kind === 'flat' ? r.model.color : r.model.at(p % w + 0.5, Math.floor(p / w) + 0.5); };
  const bgColor = transparentBg ? [0, 0, 0, 0] : bgGroup && bgGroup.kind === 'flat' ? bgGroup.color : null;

  // Edge pixels: best explanation as a mix of two neighbouring regions.
  const lab1 = new Int32Array(N), lab2 = new Int32Array(N), al1 = new Float32Array(N), al2 = new Float32Array(N);
  const unexplained = [], mixErr = new Float32Array(N).fill(1e9), mix1 = new Int32Array(N), mix2 = new Int32Array(N), mixA1 = new Float32Array(N), mixA2 = new Float32Array(N);
  const R = noise > 1.5 ? 3 : 2;
  const cand = [];
  for (let p = 0; p < N; p++) {
    if (labels[p]) { lab1[p] = labels[p]; al1[p] = 1; continue; }
    const x = p % w, y = (p / w) | 0; cand.length = 0;
    for (let dy = -R; dy <= R; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -R; dx <= R; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; const l = labels[yy * w + xx]; if (l && !cand.includes(l)) cand.push(l); } }
    const c = [P[p * 4], P[p * 4 + 1], P[p * 4 + 2], P[p * 4 + 3]];
    let best = null, bestE = Infinity;
    const cols = cand.map(l => {
      const r = regions[l]; if (r.model.kind === 'flat' && !r.grain && !r.complex) return r.model.color;
      const acc = [0, 0, 0, 0]; let k = 0;
      for (let dy = -R; dy <= R; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -R; dx <= R; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; const q = yy * w + xx; if (labels[q] !== l) continue; for (let ch = 0; ch < 4; ch++) acc[ch] += S[q * 4 + ch]; k++; } }
      return k ? acc.map(v => v / k) : regColor(l, p);
    });
    for (let i = 0; i < cand.length; i++) {
      const A = cols[i], eA = dist4(c, A); if (eA < bestE) { bestE = eA; best = [cand[i], 1, 0, 0]; }
      for (let j = i + 1; j < cand.length; j++) {
        const B = cols[j], d = [A[0] - B[0], A[1] - B[1], A[2] - B[2], A[3] - B[3]], dd = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 + d[3] ** 2; if (dd < 1) continue;
        const a = clamp(((c[0] - B[0]) * d[0] + (c[1] - B[1]) * d[1] + (c[2] - B[2]) * d[2] + (c[3] - B[3]) * d[3]) / dd, 0, 1);
        const e = hypot(c[0] - B[0] - a * d[0], c[1] - B[1] - a * d[1], c[2] - B[2] - a * d[2], c[3] - B[3] - a * d[3]);
        if (e < bestE) { bestE = e; best = [cand[i], a, cand[j], 1 - a]; }
      }
    }
    const grain = best ? Math.max(regions[best[0]].grain, best[2] ? regions[best[2]].grain : 0) : 0;
    if (best) { lab1[p] = mix1[p] = best[0]; al1[p] = mixA1[p] = best[1]; lab2[p] = mix2[p] = best[2]; al2[p] = mixA2[p] = best[3]; mixErr[p] = bestE; }
    if (!best || bestE > 24 + 3 * grain + 4 * noise) unexplained.push(p);
  }

  // Thin strokes: explain leftovers as (base colour) + α·(some flat layer colour).
  const thinGroup = new Int32Array(N).fill(-1), thinAlpha = new Float32Array(N), thinBase = new Int32Array(N);
  const flatGroups = groups.filter(g => g.kind === 'flat' && g !== bgGroup);
  const orphan = [], lossyChroma = noise > 1.5;
  for (const p of unexplained) {
    const c = [P[p * 4], P[p * 4 + 1], P[p * 4 + 2], P[p * 4 + 3]];
    // base = nearest region colour in a wider window, else background
    const x = p % w, y = (p / w) | 0; let baseL = 0, baseE = Infinity;
    for (let dy = -4; dy <= 4; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -4; dx <= 4; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; const l = labels[yy * w + xx]; if (!l) continue; const e = Math.abs(dx) + Math.abs(dy); if (e < baseE) { baseE = e; baseL = l; } } }
    const B = baseL ? regColor(baseL, p) : bgColor || [255, 255, 255, 255];
    let bg = -1, ba = 0, be = Infinity;
    const Y = v => 0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2];
    flatGroups.forEach((g, gi) => {
      const G = g.color, d = [G[0] - B[0], G[1] - B[1], G[2] - B[2], G[3] - B[3]], dd = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 + d[3] ** 2; if (dd < 1) return;
      let a, e;
      const dY = Y(G) - Y(B);
      if (lossyChroma && Math.abs(dY) > 20) {
        // JPEG keeps brightness per pixel but smears colour over 2×2 blocks: fit coverage on luma, tolerate chroma drift.
        a = clamp((Y(c) - Y(B)) / dY, 0, 1);
        const rgbE = hypot(c[0] - B[0] - a * d[0], c[1] - B[1] - a * d[1], c[2] - B[2] - a * d[2]);
        e = Math.abs(c[3] - B[3] - a * d[3]) + 0.3 * rgbE;
      } else {
        a = clamp(((c[0] - B[0]) * d[0] + (c[1] - B[1]) * d[1] + (c[2] - B[2]) * d[2] + (c[3] - B[3]) * d[3]) / dd, 0, 1);
        e = hypot(c[0] - B[0] - a * d[0], c[1] - B[1] - a * d[1], c[2] - B[2] - a * d[2], c[3] - B[3] - a * d[3]);
      }
      if (e < be) { be = e; bg = gi; ba = a; }
    });
    thinBase[p] = baseL;
    const hasMix = mixErr[p] < 1e8;
    // A thin stroke must explain the pixel clearly better than the best two-region blend (JPEG ringing does not).
    if (bg >= 0 && be <= 26 && ba >= 0.04 && (!hasMix || be < mixErr[p] * 0.5)) { thinGroup[p] = groups.indexOf(flatGroups[bg]); thinAlpha[p] = ba; lab1[p] = lab2[p] = 0; al1[p] = al2[p] = 0; }
    else if (dist4(c, B) > 30 && (!hasMix || mixErr[p] > 70)) { orphan.push(p); lab1[p] = lab2[p] = 0; }
    else if (!hasMix && baseL) { lab1[p] = baseL; al1[p] = 1; }
  }
  // Orphan ink (thin art with no solid area of its colour): cluster by colour into new thin-only groups.
  if (orphan.length > Math.max(40, N * (noise > 1.5 ? 0.003 : 0.0003))) {
    const seeds = [];
    for (const p of orphan) {
      const c = [P[p * 4], P[p * 4 + 1], P[p * 4 + 2], P[p * 4 + 3]], B = thinBase[p] ? regColor(thinBase[p], p) : bgColor || [255, 255, 255, 255];
      seeds.push({ p, c, B, strength: dist4(c, B) });
    }
    seeds.sort((a, b) => b.strength - a.strength);
    const newGroups = [];
    for (const s of seeds.slice(0, Math.max(1, Math.ceil(seeds.length * 0.15)))) {
      let g = newGroups.find(g => dist4(g.color, s.c) < 40);
      if (!g) { g = { kind: 'flat', color: s.c.slice(), members: [], area: 0, thinOnly: true, n: 0 }; newGroups.push(g); }
      g.color = g.color.map((v, k) => (v * g.n + s.c[k]) / (g.n + 1)); g.n++;
    }
    for (const g of newGroups) { g.color = g.color.map(Math.round); groups.push(g); }
    for (const s of seeds) {
      let bgI = -1, ba = 0, be = Infinity;
      for (const g of newGroups) { const G = g.color, d = G.map((v, k) => v - s.B[k]), dd = d.reduce((t, v) => t + v * v, 0); if (dd < 1) continue; const a = clamp(d.reduce((t, v, k) => t + v * (s.c[k] - s.B[k]), 0) / dd, 0, 1); const e = hypot(...d.map((v, k) => s.c[k] - s.B[k] - a * v)); if (e < be) { be = e; bgI = groups.indexOf(g); ba = a; } }
      if (bgI >= 0 && ba >= 0.04) { thinGroup[s.p] = bgI; thinAlpha[s.p] = ba; }
    }
  }

  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi]; if (!g.thinOnly) continue;
    let px = 0; for (let p = 0; p < N; p++) if (thinGroup[p] === gi) px++;
    if (px < Math.max(30, N * 0.0004)) { for (let p = 0; p < N; p++) if (thinGroup[p] === gi) { thinGroup[p] = -1; lab1[p] = thinBase[p] || 0; al1[p] = 1; } g.dead = true; }
  }
  // Layer order: background first, then by area (large under small).
  const order = groups.filter(g => g !== bgGroup && !g.dead).sort((a, b) => (b.area + (b.thinOnly ? 0 : 0)) - a.area);
  if (bgGroup) order.unshift(bgGroup);
  order.forEach((g, i) => { g.order = i; g.index = groups.indexOf(g); });
  const groupOfLabel = l => regions[l].group;

  // Lossy sources: a "thin" pixel that a blend with a neighbouring solid colour already explains reasonably is edge
  // ringing, not a stroke. Revert it before grouping, so ringing cannot chain real marks into one giant component.
  if (noise > 1.5) for (const p of unexplained) {
    if (thinGroup[p] < 0 || mixErr[p] > 60) continue;
    const base = thinBase[p] ? groupOfLabel(thinBase[p]) : null, g1 = mix1[p] ? groupOfLabel(mix1[p]) : null, g2 = mix2[p] ? groupOfLabel(mix2[p]) : null;
    if ((g1 && g1 !== base && mixA1[p] > 0.1) || (g2 && g2 !== base && mixA2[p] > 0.1)) { thinGroup[p] = -1; lab1[p] = mix1[p]; al1[p] = mixA1[p]; lab2[p] = mix2[p]; al2[p] = mixA2[p]; }
  }
  const nearestLabel = p => { const x = p % w, y = (p / w) | 0; for (let r = 1; r <= 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const l = labels[yy * w + xx]; if (l) return l; } return 0; };
  // Thin components per group → straight hairlines become rectangles; the rest boosts coverage.
  const thinRect = new Uint8Array(N), thinBoost = new Float32Array(N);
  const rectsByGroup = new Map();
  const seen = new Uint8Array(N);
  for (const p0 of unexplained) {
    if (seen[p0] || thinGroup[p0] < 0) continue;
    const gi = thinGroup[p0], comp = []; const st = [p0]; seen[p0] = 1;
    while (st.length) { const p = st.pop(); comp.push(p); const x = p % w, y = (p / w) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const q = yy * w + xx; if (!seen[q] && thinGroup[q] === gi) { seen[q] = 1; st.push(q); } } }
    let m = 0, cx = 0, cy = 0; for (const p of comp) { const a = thinAlpha[p]; m += a; cx += a * (p % w + 0.5); cy += a * (((p / w) | 0) + 0.5); }
    const peak = comp.reduce((t, p) => Math.max(t, thinAlpha[p]), 0);
    const baseG = thinBase[comp[0]] ? groupOfLabel(thinBase[comp[0]]) : null;
    let hug = 0;
    for (const p of comp) { const x = p % w, y = (p / w) | 0; let touch = false; for (let dy = -1; dy <= 1 && !touch; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const l = labels[yy * w + xx]; if (l && (groupOfLabel(l) !== baseG || groupOfLabel(l) === groups[gi])) { touch = true; break; } } if (touch) hug++; }
    if (hug > comp.length * 0.3) { for (const p of comp) { thinGroup[p] = -1; lab1[p] = thinBase[p] || nearestLabel(p); al1[p] = 1; } continue; }
    if (m < 1.5 + noise || peak < 0.3 + noise * 0.04) { for (const p of comp) { thinGroup[p] = -1; if (thinBase[p]) { lab1[p] = thinBase[p]; al1[p] = 1; } } continue; }
    cx /= m; cy /= m;
    let sxx = 0, syy = 0, sxy = 0; for (const p of comp) { const a = thinAlpha[p], dx = p % w + 0.5 - cx, dy = ((p / w) | 0) + 0.5 - cy; sxx += a * dx * dx; syy += a * dy * dy; sxy += a * dx * dy; }
    let th = 0.5 * Math.atan2(2 * sxy, sxx - syy); const deg = Math.abs(th * 180 / Math.PI) % 90; if (deg < 1 || deg > 89) th = Math.round(th / (Math.PI / 2)) * (Math.PI / 2);
    const ux = Math.cos(th), uy = Math.sin(th);
    let tmin = Infinity, tmax = -Infinity, perp = 0;
    for (const p of comp) { const dx = p % w + 0.5 - cx, dy = ((p / w) | 0) + 0.5 - cy, t = dx * ux + dy * uy, s = -dx * uy + dy * ux; if (thinAlpha[p] > 0.12) { tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); } perp += thinAlpha[p] * s * s; }
    const L = tmax - tmin + 1, wd = m / L, sPerp = Math.sqrt(perp / m);
    // A real stroke is a ridge: the same surface on both sides. Edge ringing has two different surfaces.
    const labelNear = (px, py) => { const X = Math.floor(px), Y = Math.floor(py); for (let r = 0; r <= 1; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = X + dx, yy = Y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const l = labels[yy * w + xx]; if (l) return groupOfLabel(l); } return null; };
    let agree = 0, valid = 0; const off = wd / 2 + 3;
    for (let k = 0; k < 9; k++) { const t = tmin + (tmax - tmin) * (k + 0.5) / 9, px = cx + ux * t, py = cy + uy * t; const A = labelNear(px - uy * off, py + ux * off), B = labelNear(px + uy * off, py - ux * off); if (!A || !B) continue; valid++; if (A === B && A !== groups[gi]) agree++; }
    if (noise > 1.5 && (valid < 3 || agree < valid * 0.6) && L / Math.max(wd, 0.2) >= 5) { for (const p of comp) { thinGroup[p] = -1; lab1[p] = thinBase[p] || nearestLabel(p); al1[p] = 1; lab2[p] = 0; } continue; }
    if (L >= 6 && L / Math.max(wd, 0.2) >= 5 && sPerp <= 0.95 && wd <= 2.6) {
      // Extend ends that touch a solid part of the same colour so the hairline joins it without a gap.
      const touches = t => { const px = cx + ux * t, py = cy + uy * t; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = Math.floor(px) + dx, yy = Math.floor(py) + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const l = labels[yy * w + xx]; if (l && groupOfLabel(l) === groups[gi]) return true; } return false; };
      // Width profile along the stroke: fit w(t) = w0 + k·t so tapers (swoosh tips, serifs) stay tapered.
      const bins = new Map();
      for (const p of comp) { const dx = p % w + 0.5 - cx, dy = ((p / w) | 0) + 0.5 - cy, t = Math.round(dx * ux + dy * uy); bins.set(t, (bins.get(t) || 0) + thinAlpha[p]); }
      let st = 0, sw = 0, stt = 0, stw = 0, nb = 0;
      for (const [t, v] of bins) { if (t < tmin + 1 || t > tmax - 1) continue; st += t; sw += v; stt += t * t; stw += t * v; nb++; }
      const den = nb * stt - st * st, k = nb > 3 && Math.abs(den) > 1e-6 ? (nb * stw - st * sw) / den : 0, w0 = nb ? (sw - k * st) / nb : wd;
      const a = tmin - 0.5 - (touches(tmin - 1.5) ? 2 : 0), b = tmax + 0.5 + (touches(tmax + 1.5) ? 2 : 0);
      const ha = clamp(w0 + k * a, 0.05, 3) / 2, hb = clamp(w0 + k * b, 0.05, 3) / 2;
      const rect = [[a, -ha], [b, -hb], [b, hb], [a, ha]].map(([t, s]) => ({ x: cx + ux * t - uy * s, y: cy + uy * t + ux * s }));
      if (!rectsByGroup.has(gi)) rectsByGroup.set(gi, []);
      rectsByGroup.get(gi).push(rect);
      for (const p of comp) thinRect[p] = 1;
    } else {
      const sorted = comp.map(p => thinAlpha[p]).sort((a, b) => a - b), p90 = sorted[Math.floor(sorted.length * 0.9)] || 1;
      const k = p90 < 0.6 ? 0.6 / p90 : 1; for (const p of comp) thinBoost[p] = Math.min(1, thinAlpha[p] * k);
    }
  }

  // Per-group coverage, extension under higher layers, contour, fit.
  const covAt = (p, g) => {
    let v = 0;
    if (lab1[p] && groupOfLabel(lab1[p]) === g) v += al1[p];
    if (lab2[p] && groupOfLabel(lab2[p]) === g) v += al2[p];
    if (thinGroup[p] >= 0 && groups[thinGroup[p]] === g) v += thinRect[p] ? 0 : (thinBoost[p] || thinAlpha[p]);
    else if (thinGroup[p] >= 0 && thinBase[p] && groupOfLabel(thinBase[p]) === g) v += 1 - thinAlpha[p];
    return v;
  };
  const aboveAt = (p, g) => {
    let v = 0;
    if (lab1[p] && groupOfLabel(lab1[p]).order > g.order) v += al1[p];
    if (lab2[p] && groupOfLabel(lab2[p]).order > g.order) v += al2[p];
    if (thinGroup[p] >= 0 && groups[thinGroup[p]].order > g.order) v += thinAlpha[p];
    return v;
  };
  // bbox per group
  const bbox = new Map(); for (const g of groups) bbox.set(g, { x0: w, y0: h, x1: -1, y1: -1 });
  const grow = (g, p) => { const b = bbox.get(g), x = p % w, y = (p / w) | 0; if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y; };
  for (let p = 0; p < N; p++) { if (lab1[p]) grow(groupOfLabel(lab1[p]), p); if (lab2[p]) grow(groupOfLabel(lab2[p]), p); if (thinGroup[p] >= 0) grow(groups[thinGroup[p]], p); }

  const defs = [], body = []; let pathCount = 0, nodeCount = 0, curveCount = 0, lineCount = 0, gradCount = 0, grainCount = 0, rasterCount = 0;
  const fillFor = (g, id) => {
    if (g.kind === 'flat' && !g.grain) { const c = cssColor(g.color); return { attr: `fill="${c.fill}"${c.opacity < 0.995 ? ` fill-opacity="${r2(c.opacity)}"` : ''}` }; }
    const m = g.model;
    let fill;
    if (m.kind === 'flat') { const c = cssColor(m.color); fill = `fill="${c.fill}"${c.opacity < 0.995 ? ` fill-opacity="${r2(c.opacity)}"` : ''}`; }
    else {
      const stops = profileStops(m.prof).map(s => { const c = cssColor(s.color); return `<stop offset="${r2(s.offset)}" stop-color="${c.fill}"${c.opacity < 0.995 ? ` stop-opacity="${r2(c.opacity)}"` : ''}/>`; }).join('');
      if (m.kind === 'linear') {
        const { cx, cy, u, prof } = m;
        defs.push(`<linearGradient id="g${id}" gradientUnits="userSpaceOnUse" x1="${r2(cx + u[0] * prof.tmin)}" y1="${r2(cy + u[1] * prof.tmin)}" x2="${r2(cx + u[0] * prof.tmax)}" y2="${r2(cy + u[1] * prof.tmax)}">${stops}</linearGradient>`);
      } else {
        const { cx, cy, prof } = m, rr = Math.max(prof.tmax, 1);
        const rs = profileStops({ ...m.prof, tmin: 0, at: t => prof.at(t) }).map(s => { const c = cssColor(s.color); return `<stop offset="${r2(s.offset)}" stop-color="${c.fill}"${c.opacity < 0.995 ? ` stop-opacity="${r2(c.opacity)}"` : ''}/>`; }).join('');
        defs.push(`<radialGradient id="g${id}" gradientUnits="userSpaceOnUse" cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(rr)}">${rs}</radialGradient>`);
      }
      gradCount++;
      fill = `fill="url(#g${id})"`;
    }
    let filter = '';
    if (g.grain || g.complex) {
      const amp = clamp((g.grain || m.rms) / 255 / 0.18, 0.02, 0.9);
      defs.push(`<filter id="n${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="${id}" result="t"/><feColorMatrix in="t" type="matrix" values="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1" result="n"/><feComposite in="SourceGraphic" in2="n" operator="arithmetic" k1="0" k2="1" k3="${r2(amp)}" k4="${r2(-amp / 2)}" result="m"/><feComposite in="m" in2="SourceAlpha" operator="in"/></filter>`);
      filter = ` filter="url(#n${id})"`; grainCount++;
    }
    return { attr: fill + filter };
  };

  const traceOpts = { fitError: o.fitError, lineTolerance: o.lineTolerance, cornerAngle: o.cornerAngle, cornerSpan: o.cornerSpan, maxCornerShift: o.maxCornerShift, smoothPasses: o.smoothPasses, runTolerance: o.runTolerance, minRunLength: o.minRunLength };
  let layerId = 0;
  for (const g of order) {
    layerId++;
    if (g === bgGroup) {
      if (transparentBg || (o.dropBackground && g.kind === 'flat')) continue;
      const f = fillFor(g, layerId);
      const wantRasterBg = o.gradientMode === 'raster' ? (g.grain || g.complex) : o.gradientMode !== 'vector' && g.complex;
      if (wantRasterBg) { body.push(rasterLayer(imageData, `<rect width="${w}" height="${h}"/>`, { x0: 0, y0: 0, x1: w - 1, y1: h - 1 }, layerId, o.gradientMode === 'raster' ? 1 : 0)); rasterCount++; }
      else body.push(`<rect width="${w}" height="${h}" ${f.attr}/>`);
      pathCount++; nodeCount += 4; continue;
    }
    const b = bbox.get(g); if (b.x1 < 0) continue;
    const pad = 4, bx0 = Math.max(0, b.x0 - pad), by0 = Math.max(0, b.y0 - pad), bx1 = Math.min(w - 1, b.x1 + pad), by1 = Math.min(h - 1, b.y1 + pad);
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, cov = new Float32Array(bw * bh), dist = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const p = (by0 + y) * w + bx0 + x, v = covAt(p, g); cov[y * bw + x] = v; dist[y * bw + x] = v >= 0.5 ? 0 : 99; }
    const ownCov = cov.slice();
    // chamfer distance to the layer's own solid pixels
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const i = y * bw + x; let d = dist[i]; if (x) d = Math.min(d, dist[i - 1] + 1); if (y) d = Math.min(d, dist[i - bw] + 1); if (x && y) d = Math.min(d, dist[i - bw - 1] + 1.4142); if (y && x < bw - 1) d = Math.min(d, dist[i - bw + 1] + 1.4142); dist[i] = d; }
    for (let y = bh - 1; y >= 0; y--) for (let x = bw - 1; x >= 0; x--) { const i = y * bw + x; let d = dist[i]; if (x < bw - 1) d = Math.min(d, dist[i + 1] + 1); if (y < bh - 1) d = Math.min(d, dist[i + bw] + 1); if (x < bw - 1 && y < bh - 1) d = Math.min(d, dist[i + bw + 1] + 1.4142); if (y < bh - 1 && x) d = Math.min(d, dist[i + bw - 1] + 1.4142); dist[i] = d; }
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const i = y * bw + x, ext = clamp(2.5 - dist[i], 0, 1); if (ext > 0) { const p = (by0 + y) * w + bx0 + x; cov[i] = Math.min(1, cov[i] + ext * aboveAt(p, g)); } else cov[i] = Math.min(1, cov[i]); }
    const loops = marchingSquares(cov, bx0, by0, bw, bh).filter(l => Math.abs(loopArea(l)) >= 4);
    const rects = rectsByGroup.get(g.index) || [];
    if (!loops.length && !rects.length) continue;
    const outerSign = loops.length ? Math.sign(loopArea(loops.reduce((a, l) => Math.abs(loopArea(l)) > Math.abs(loopArea(a)) ? l : a))) : 1;
    let d = loops.map(l => traceLoop(l, traceOpts)).join('');
    for (const r of rects) { const pts = Math.sign(loopArea(r)) === outerSign ? r : r.slice().reverse(); d += `M${pts.map(p => `${r2(p.x)} ${r2(p.y)}`).join('L')}Z`; }
    const wantRaster = o.gradientMode === 'raster' ? (g.grain || g.complex) : o.gradientMode !== 'vector' && g.complex;
    if (wantRaster) { body.push(rasterLayer(imageData, `<path d="${d}"/>`, { x0: bx0, y0: by0, x1: bx1, y1: by1 }, layerId, o.gradientMode === 'raster' ? 1 : 0, ownCov)); rasterCount++; }
    else { const f = fillFor(g, layerId); body.push(`<path ${f.attr} d="${d}"/>`); }
    pathCount++;
    nodeCount += (d.match(/[MLC]/g) || []).length; curveCount += (d.match(/C/g) || []).length; lineCount += (d.match(/L/g) || []).length;
  }

  const sw = options.sourceWidth || w, sh = options.sourceHeight || h;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${sw}" height="${sh}" viewBox="0 0 ${w} ${h}">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${body.join('')}</svg>`;
  const complexRatio = totalArea ? complexArea / totalArea : 0;
  return {
    status: complexRatio > 0.25 ? 'complex' : 'ok', reason: complexRatio > 0.25 ? 'photo_like' : '',
    svg, pathCount, nodeCount, curveCount, lineCount, gradientCount: gradCount, grainCount, rasterCount,
    layerCount: order.length - (transparentBg || (o.dropBackground && bgGroup && bgGroup.kind === 'flat') ? 1 : 0), hairlineCount: [...rectsByGroup.values()].reduce((a, r) => a + r.length, 0),
    colors: order.filter(g => !(g === bgGroup && transparentBg)).map(g => g.kind === 'flat' ? cssColor(g.color).fill : g.kind),
    background: transparentBg ? 'transparent' : bgGroup ? (bgGroup.kind === 'flat' ? cssColor(bgGroup.color).fill : bgGroup.kind) : 'none',
    noise: r2(noise), complexRatio: r2(complexRatio), ms: Math.round(performance.now() - t0)
  };
}

// Raster mode: keep the original pixels for grainy/complex areas, clipped by the traced shape.
// full=1 keeps every pixel (grain included); full=0 stores a small smooth colour field (gradients are low-frequency).
// Pixels outside the layer are filled from the nearest inside pixel first, so the upscaled edge never bleeds in foreign colours.
function rasterLayer(imageData, clipShape, b, id, full = 0, ownMask = null) {
  const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
  const src = document.createElement('canvas'); src.width = imageData.width; src.height = imageData.height; src.getContext('2d').putImageData(imageData, 0, 0);
  const scale = full ? 1 : Math.min(1, 96 / Math.max(bw, bh));
  const crop = document.createElement('canvas'); crop.width = bw; crop.height = bh; const kx = crop.getContext('2d');
  kx.drawImage(src, b.x0, b.y0, bw, bh, 0, 0, bw, bh);
  if (!full && ownMask) {
    // Replace every pixel not owned by this layer with the nearest owned pixel (BFS flood from the inside).
    const id2 = kx.getImageData(0, 0, bw, bh), d = id2.data, own = new Int32Array(bw * bh).fill(-1), q = new Int32Array(bw * bh); let qh = 0, qt = 0;
    for (let i = 0; i < bw * bh; i++) if (ownMask[i] >= 0.95) { own[i] = i; q[qt++] = i; }
    while (qh < qt) { const i = q[qh++], x = i % bw, y = (i / bw) | 0; for (const j of [x > 0 ? i - 1 : -1, x < bw - 1 ? i + 1 : -1, y > 0 ? i - bw : -1, y < bh - 1 ? i + bw : -1]) if (j >= 0 && own[j] < 0) { own[j] = own[i]; q[qt++] = j; } }
    for (let i = 0; i < bw * bh; i++) if (own[i] >= 0 && own[i] !== i) for (let c = 0; c < 4; c++) d[i * 4 + c] = d[own[i] * 4 + c];
    kx.putImageData(id2, 0, 0);
  }
  const c = document.createElement('canvas'); c.width = Math.max(2, Math.round(bw * scale)); c.height = Math.max(2, Math.round(bh * scale));
  const cx = c.getContext('2d'); cx.imageSmoothingQuality = 'high'; cx.drawImage(crop, 0, 0, c.width, c.height);
  const url = full ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9);
  return `<clipPath id="c${id}">${clipShape}</clipPath><image x="${b.x0}" y="${b.y0}" width="${bw}" height="${bh}" preserveAspectRatio="none" clip-path="url(#c${id})" xlink:href="${url}"/>`;
}
