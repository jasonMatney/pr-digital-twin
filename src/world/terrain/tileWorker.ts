// Tile worker: fetches a terrain tile's elevation and photo, decodes them off the main thread, and returns
// ready-to-upload buffers (vertex positions, a compact height grid, a normal+height map, a photo bitmap).
import { tileLon, tileLat, curveDrop, ORIGIN, M_PER_DEG_LAT, M_PER_DEG_LON } from '../../core/geo.ts';

export interface DemSrc { url: string; z: number; x: number; y: number }
export interface TileJob {
  type: 'tile'; id: number; z: number; x: number; y: number; grid: number;
  dem: DemSrc[];                 // candidates in order of preference (exact tile, then an ancestor to upsample)
  img: string[][];               // candidates: four z+1 urls (nw, ne, sw, se) or one url; empty = no photo wanted
  crop?: DemSrc | null;          // nearest ancestor photo, cropped, when the tile adds elevation detail but has no photo of its own
  cudem?: DemSrc | null;         // topo-bathy layer (NOAA CUDEM): one continuous surface through the waterline; no-data = -32768
  cudemKids?: (DemSrc | null)[] | null;   // one zoom above the layer's coarsest: its four children (nw, ne, sw, se), averaged 2x2
  bathy?: DemSrc[];              // coarse stand-in where there is no topo-bathy: an elevation ancestor that carries bathymetry
  root: boolean;                 // roots never fail: flat sea level and no photo instead
}
export interface TileResult {
  id: number; ok: boolean; aborted?: boolean; failed: string[]; okUrls: string[]; degraded?: boolean;
  pos?: Float32Array; hts?: Int16Array; norm?: Uint8Array; photo?: Uint8Array | null; photoW?: number;
  minH?: number; maxH?: number; cx?: number; cy?: number; cz?: number; demZ?: number; imgZ?: number;
}

const tag = (e: any, url: string) => (/^Error: (http|not an image)/.test(String(e)) ? 'http|' : 'net|') + url;
const HN = 129;                  // compact height grid kept on the main thread for heightAt (0.5 m steps)
const demCache = new Map<string, { w: number; h: Float32Array }>();
const ctl = new Map<number, AbortController>();
let dcv: OffscreenCanvas | null = null;
let pcv: OffscreenCanvas | null = null;

async function fetchBitmap(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  // A request that hangs counts as a network failure after 20 s, so the tile is retried instead of waiting for ever.
  const to = (AbortSignal as any).timeout ? (AbortSignal as any).any?.([signal, (AbortSignal as any).timeout(20000)]) ?? signal : signal;
  const r = await fetch(url, { signal: to, mode: 'cors', credentials: 'omit' });
  if (!r.ok) throw new Error('http ' + r.status);
  const ct = r.headers.get('content-type') || '';
  if (ct.startsWith('text/') || ct.includes('json')) throw new Error('not an image');   // a dev server answers a missing file with its HTML page
  const blob = await r.blob();
  // No colour management and no premultiplication: the bytes are data (elevation), not a picture.
  return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}

/** Terrarium RGB -> metres. Exactness is checked by the page's self-test against a Node decode of the same PNG. */
function decodeTerrarium(bmp: ImageBitmap): { w: number; h: Float32Array } {
  const w = bmp.width;
  if (!dcv || dcv.width !== w) dcv = new OffscreenCanvas(w, w);
  const g = dcv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' }) as OffscreenCanvasRenderingContext2D;
  g.globalCompositeOperation = 'copy';
  g.imageSmoothingEnabled = false;
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, w, w, { colorSpace: 'srgb' }).data;
  const h = new Float32Array(w * w);
  for (let i = 0, p = 0; i < h.length; i++, p += 4) h[i] = d[p] * 256 + d[p + 1] + d[p + 2] / 256 - 32768;
  return { w, h };
}

/** Upstream elevation has isolated garbage cells (2,448 m spikes, -22 km holes): replace them by the median of their neighbours. */
const med = new Float32Array(8);
function sanitize(H: Float32Array, w: number) {
  const src = H.slice();
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, h = src[k];
    const l = src[i > 0 ? k - 1 : k], r = src[i < w - 1 ? k + 1 : k], u = src[j > 0 ? k - w : k], d = src[j < w - 1 ? k + w : k];
    const range = h < -9000 || h > 1400;
    if (!range && Math.abs(h - (l + r + u + d) * 0.25) < 60) continue;
    let n = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ii = Math.min(w - 1, Math.max(0, i + di)), jj = Math.min(w - 1, Math.max(0, j + dj));
      med[n++] = src[jj * w + ii];
    }
    med.sort();
    let m = (med[3] + med[4]) * 0.5;
    if (m < -9000 || m > 1400) m = med[3] >= -9000 && med[3] <= 1400 ? med[3] : med[4] >= -9000 && med[4] <= 1400 ? med[4] : 0;
    if (range || Math.abs(h - m) > 120) H[k] = m;
  }
}

/** 1 where the photo has no picture: large exactly-white (or exactly-black) blocks. Real roofs, sand and surf survive
 *  because a pixel only counts when its whole 5x5 neighbourhood is blank too; the blank core is then grown back out
 *  over the near-blank fringe that JPEG leaves at the block edge. Pixels beyond the tile edge count as blank. */
function blankMask(d: Uint8ClampedArray, w: number): { mask: Uint8Array; count: number } {
  const n = w * w, a = new Uint8Array(n), b = new Uint8Array(n), near = new Uint8Array(n);
  let any = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p], g = d[p + 1], bl = d[p + 2];
    const mn = r < g ? (r < bl ? r : bl) : (g < bl ? g : bl), mx = r > g ? (r > bl ? r : bl) : (g > bl ? g : bl);
    if (mn >= 250) { a[i] = 1; any = 1; } else if (mx <= 5) { a[i] = 2; any = 1; }
    near[i] = mn >= 232 ? 1 : mx <= 22 ? 2 : 0;
  }
  const mask = new Uint8Array(n);
  if (!any) return { mask, count: 0 };
  // erode 5x5 (separable), per class
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, c = a[k];
    if (!c) continue;
    let ok = 1;
    for (let di = -2; di <= 2; di++) { const ii = i + di; if (ii >= 0 && ii < w && a[k + di] !== c) { ok = 0; break; } }
    if (ok) b[k] = c;
  }
  const core = new Uint8Array(n);
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, c = b[k];
    if (!c) continue;
    let ok = 1;
    for (let dj = -2; dj <= 2; dj++) { const jj = j + dj; if (jj >= 0 && jj < w && b[jj * w + i] !== c) { ok = 0; break; } }
    if (ok) core[k] = c;
  }
  // grow back 3 px over near-blank pixels of the same class
  let count = 0, cur = core;
  for (let it = 0; it < 3; it++) {
    const nx = cur.slice();
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (cur[k] || !near[k]) continue;
      const c = near[k];
      if ((i > 0 && cur[k - 1] === c) || (i < w - 1 && cur[k + 1] === c) || (j > 0 && cur[k - w] === c) || (j < w - 1 && cur[k + w] === c)) nx[k] = c;
    }
    cur = nx;
  }
  for (let i = 0; i < n; i++) if (cur[i]) { mask[i] = 1; count++; }
  return { mask, count };
}

let rcv: OffscreenCanvas | null = null;
function pixels(bmp: ImageBitmap, w: number, sx = 0, sy = 0, sw = bmp.width, sh = bmp.height): Uint8ClampedArray {
  if (!rcv || rcv.width !== w) rcv = new OffscreenCanvas(w, w);
  const g = rcv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' }) as OffscreenCanvasRenderingContext2D;
  g.globalCompositeOperation = 'copy'; g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, w);
  return g.getImageData(0, 0, w, w, { colorSpace: 'srgb' }).data;
}

async function loadDem(url: string, signal: AbortSignal, topoBathy = false) {
  const hit = demCache.get(url);
  if (hit) { demCache.delete(url); demCache.set(url, hit); return hit; }
  const bmp = await fetchBitmap(url, signal);
  const dem = decodeTerrarium(bmp);
  bmp.close();
  // Topo-bathy tiles mark no-data as -32768: keep it as NaN so every interpolated sample that touches it is NaN too.
  if (topoBathy) { const h = dem.h; for (let i = 0; i < h.length; i++) if (h[i] < -12000) h[i] = NaN; } else sanitize(dem.h, dem.w);
  demCache.set(url, dem);
  if (demCache.size > 28) demCache.delete(demCache.keys().next().value!);
  return dem;
}

/** A topo-bathy grid for a tile one zoom above the layer's coarsest zoom: the four children, each averaged 2x2 without
 *  letting no-data into the mean. The sea then has the same depths on both sides of a zoom-11 / zoom-12 tile boundary. */
async function loadCudemQuad(kids: (DemSrc | null)[], signal: AbortSignal, okUrls: string[], failed: string[]) {
  const key = 'quad|' + kids.map((k) => (k ? k.url : '-')).join('|');
  const hit = demCache.get(key);
  if (hit) { demCache.delete(key); demCache.set(key, hit); return hit; }
  const W = 256, h = new Float32Array(W * W).fill(NaN);
  let any = false;
  for (let q = 0; q < 4; q++) {
    const k = kids[q];
    if (!k) continue;
    let cd: { w: number; h: Float32Array };
    try { cd = await loadDem(k.url, signal, true); okUrls.push(k.url); } catch (e) { if (signal.aborted) throw e; failed.push(tag(e, k.url)); continue; }
    const cw = cd.w, f = cw / (W / 2), ox = (q & 1) * (W / 2), oy = (q >> 1) * (W / 2);
    for (let j = 0; j < W / 2; j++) for (let i = 0; i < W / 2; i++) {
      let sum = 0, n = 0;
      for (let dj = 0; dj < f; dj++) for (let di = 0; di < f; di++) { const v = cd.h[(j * f + dj) * cw + i * f + di]; if (v === v) { sum += v; n++; } }
      if (n) { h[(oy + j) * W + ox + i] = sum / n; any = true; }
    }
  }
  if (!any) return null;
  const dem = { w: W, h };
  demCache.set(key, dem);
  if (demCache.size > 28) demCache.delete(demCache.keys().next().value!);
  return dem;
}

function sample(H: Float32Array, w: number, px: number, py: number): number {
  if (px < 0) px = 0; else if (px > w - 1) px = w - 1;
  if (py < 0) py = 0; else if (py > w - 1) py = w - 1;
  const x0 = px | 0, y0 = py | 0, x1 = x0 < w - 1 ? x0 + 1 : x0, y1 = y0 < w - 1 ? y0 + 1 : y0;
  const fx = px - x0, fy = py - y0;
  const a = H[y0 * w + x0], b = H[y0 * w + x1], c = H[y1 * w + x0], d = H[y1 * w + x1];
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

async function buildTile(job: TileJob, signal: AbortSignal): Promise<{ res: TileResult; transfer: Transferable[] }> {
  const { z, x, y, grid: N } = job;
  const failed: string[] = [], okUrls: string[] = [];

  // ---- photo (started first so it downloads while the elevation decodes) ----
  const photoP = (async (): Promise<{ bmp: ImageBitmap | null; imgZ: number; ok: boolean }> => {
    if (!job.img.length) return { bmp: null, imgZ: 0, ok: !job.crop };
    for (const urls of job.img) {
      const got = await Promise.allSettled(urls.map((u) => fetchBitmap(u, signal)));
      if (signal.aborted) { for (const g of got) if (g.status === 'fulfilled') g.value.close(); throw new DOMException('aborted', 'AbortError'); }
      let all = true;
      got.forEach((g, i) => { if (g.status === 'fulfilled') okUrls.push(urls[i]); else { all = false; failed.push(tag((g as PromiseRejectedResult).reason, urls[i])); } });
      if (!all) { for (const g of got) if (g.status === 'fulfilled') g.value.close(); continue; }
      const bm = got.map((g) => (g as PromiseFulfilledResult<ImageBitmap>).value);
      if (bm.length === 1) return { bmp: bm[0], imgZ: z, ok: true };
      const s = bm[0].width;
      if (!pcv || pcv.width !== s * 2) pcv = new OffscreenCanvas(s * 2, s * 2);
      const g = pcv.getContext('2d') as OffscreenCanvasRenderingContext2D;
      g.globalCompositeOperation = 'copy';
      for (let i = 0; i < 4; i++) { g.drawImage(bm[i], (i & 1) * s, (i >> 1) * s, s, s); g.globalCompositeOperation = 'source-over'; bm[i].close(); }
      return { bmp: pcv.transferToImageBitmap(), imgZ: z + 1, ok: true };
    }
    return { bmp: null, imgZ: 0, ok: false };
  })();
  photoP.catch(() => {});

  // ---- elevation ----
  let dem: { w: number; h: Float32Array } | null = null, src: DemSrc | null = null;
  for (const c of job.dem) {
    try { dem = await loadDem(c.url, signal); src = c; okUrls.push(c.url); break; } catch (e) { if (signal.aborted) throw e; failed.push(tag(e, c.url)); }
  }
  if (!dem) {
    if (!job.root) { const p = await photoP.catch(() => null); p?.bmp?.close(); return { res: { id: job.id, ok: false, failed, okUrls }, transfer: [] }; }
    dem = { w: 2, h: new Float32Array(4).fill(-60) }; src = { url: '', z, x, y };   // flat, just under the sea, so the page never shows nothing
  }
  const W = dem.w, H = dem.h;
  const s = 2 ** (z - src!.z), u0 = (x - src!.x * s) / s, v0 = (y - src!.y * s) / s;
  const hRaw = (u: number, v: number) => sample(H, W, (u0 + u / s) * W - 0.5, (v0 + v / s) * W - 0.5);

  // ---- seabed for cells the elevation holds at about 0 m (lidar tiles have no bathymetry) ----
  // Topo-bathy first: where it has data it is the surface for the whole nearshore zone.
  let cAt: ((u: number, v: number) => number) | null = null, cudemFull = false, cStep = 1 / 256;   // cStep: one topo-bathy cell in tile uv
  if (job.cudem) {
    try {
      const c = job.cudem, cd = await loadDem(c.url, signal, true);
      okUrls.push(c.url);
      const CW = cd.w, CH = cd.h, cs = 2 ** (z - c.z), cu0 = (x - c.x * cs) / cs, cv0 = (y - c.y * cs) / cs;
      cAt = (u, v) => sample(CH, CW, (cu0 + u / cs) * CW - 0.5, (cv0 + v / cs) * CW - 0.5);
      cStep = cs / CW;
      cudemFull = true;
      for (let j = 0; j <= 16 && cudemFull; j++) for (let i = 0; i <= 16; i++) { const v = cAt(i / 16, j / 16); if (v !== v) { cudemFull = false; break; } }
    } catch (e) { if (signal.aborted) throw e; failed.push(tag(e, job.cudem.url)); }
  } else if (job.cudemKids) {
    const cd = await loadCudemQuad(job.cudemKids, signal, okUrls, failed);
    if (cd) {
      const CW = cd.w, CH = cd.h;
      cAt = (u, v) => sample(CH, CW, u * CW - 0.5, v * CW - 0.5);
      cStep = 1 / CW;
      cudemFull = true;
      for (let j = 0; j <= 16 && cudemFull; j++) for (let i = 0; i <= 16; i++) { const v = cAt(i / 16, j / 16); if (v !== v) { cudemFull = false; break; } }
    }
  }
  let bath: { w: number; h: Float32Array } | null = null, bsrc: DemSrc | null = null;
  if (job.bathy?.length && !cudemFull) {
    let band = false;
    const a0 = Math.max(0, Math.floor(u0 * W) - 1), a1 = Math.min(W - 1, Math.ceil((u0 + 1 / s) * W)), b0 = Math.max(0, Math.floor(v0 * W) - 1), b1 = Math.min(W - 1, Math.ceil((v0 + 1 / s) * W));
    for (let j = b0; j <= b1 && !band; j++) for (let i = a0; i <= a1; i++) { const h = H[j * W + i]; if (h > -0.6 && h < 0.6) { band = true; break; } }
    if (band) for (let ci = 0; ci < job.bathy.length; ci++) {
      const c = job.bathy[ci];
      if (c.url === src!.url) break;
      try { bath = await loadDem(c.url, signal); bsrc = c; okUrls.push(c.url); break; } catch (e) { if (signal.aborted) throw e; failed.push(tag(e, c.url)); }
    }
  }
  let bAt: ((u: number, v: number) => number) | null = null;
  if (bath && bsrc) {
    const BW = bath.w, BH = bath.h, bs = 2 ** (z - bsrc.z), bu0 = (x - bsrc.x * bs) / bs, bv0 = (y - bsrc.y * bs) / bs;
    bAt = (u, v) => sample(BH, BW, (bu0 + u / bs) * BW - 0.5, (bv0 + v / bs) * BW - 0.5);
  }

  // ---- photo: pixels, coverage mask, what it shows (water / built-up) ----
  const T = 256;
  let photo = await photoP;
  if (!photo.ok && job.crop && src!.z === z) {
    // Finer relief under the parent's picture is still an improvement.
    try {
      const c = job.crop, bmp = await fetchBitmap(c.url, signal), cs = 2 ** (z - c.z), w = bmp.width / cs;
      if (!pcv || pcv.width !== 256) pcv = new OffscreenCanvas(256, 256);
      const g = pcv.getContext('2d') as OffscreenCanvasRenderingContext2D;
      g.globalCompositeOperation = 'copy'; g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, (x - c.x * cs) * w, (y - c.y * cs) * w, w, w, 0, 0, 256, 256);
      bmp.close();
      photo = { bmp: pcv.transferToImageBitmap(), imgZ: c.z, ok: true };
    } catch (e) { if (signal.aborted) throw e; failed.push(tag(e, job.crop.url)); }
  }
  if (!photo.ok && !job.root) return { res: { id: job.id, ok: false, failed, okUrls }, transfer: [] };
  let px: Uint8Array | null = null, PW = 0;
  const cls = new Uint8Array(T * T).fill(128);          // 0 = the photo shows water, 128 = neither, 255 = built-up
  let wd: Float32Array | null = null;                   // depth (m) read off the photo's water colour, 0 = not water
  let blank: Uint8Array | null = null;                  // 1 = the photo has no picture in this cell
  if (photo.bmp) {
    PW = photo.bmp.width >= 512 ? 512 : 256;
    const d = pixels(photo.bmp, PW);
    photo.bmp.close();
    const { mask, count } = blankMask(d, PW);
    if (count > PW * PW * 0.002 && job.crop && photo.imgZ > job.crop.z) {
      // Blank on land: fill from the nearest ancestor photo where that one has a picture.
      let land = false;
      for (let j = 0; j < 32 && !land; j++) for (let i = 0; i < 32; i++) {
        if (mask[(((j + 0.5) / 32 * PW) | 0) * PW + (((i + 0.5) / 32 * PW) | 0)] && hRaw((i + 0.5) / 32, (j + 0.5) / 32) > 0.6) { land = true; break; }
      }
      if (land) {
        try {
          const c = job.crop, bmp = await fetchBitmap(c.url, signal), cs = 2 ** (z - c.z), w = bmp.width / cs;
          const keep = d.slice();
          const pd = pixels(bmp, PW, (x - c.x * cs) * w, (y - c.y * cs) * w, w, w);
          bmp.close();
          const pm = blankMask(pd, PW).mask;
          for (let i = 0, p = 0; i < PW * PW; i++, p += 4) if (mask[i] && !pm[i]) { keep[p] = pd[p]; keep[p + 1] = pd[p + 1]; keep[p + 2] = pd[p + 2]; mask[i] = 0; }
          d.set(keep);
        } catch (e) { if (signal.aborted) throw e; }
      }
    }
    // Alpha = coverage; blank pixels go black so that rgb / alpha in the shader gives the picture's own colour at block edges.
    for (let i = 0, p = 0; i < PW * PW; i++, p += 4) { if (mask[i]) { d[p] = d[p + 1] = d[p + 2] = d[p + 3] = 0; } else d[p + 3] = 255; }
    px = new Uint8Array(d.buffer);
    // classify on the 256 grid
    const wraw = new Float32Array(T * T);
    let anyW = false;
    const f = PW / T, lum = new Float32Array(T * T), cr = new Float32Array(T * T), cg = new Float32Array(T * T), cb = new Float32Array(T * T), nd = new Uint8Array(T * T);
    for (let j = 0, k = 0; j < T; j++) for (let i = 0; i < T; i++, k++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dj = 0; dj < f; dj++) for (let di = 0; di < f; di++) {
        const p = ((j * f + dj) * PW + i * f + di) * 4;
        if (d[p + 3]) { r += d[p]; g += d[p + 1]; b += d[p + 2]; n++; }
      }
      if (!n) { nd[k] = 1; wraw[k] = 9; anyW = true; continue; }
      r /= n; g /= n; b /= n;
      cr[k] = r; cg[k] = g; cb[k] = b; lum[k] = 0.3 * r + 0.59 * g + 0.11 * b;
    }
    blank = nd;
    for (let j = 0, k = 0; j < T; j++) for (let i = 0; i < T; i++, k++) {
      if (nd[k]) continue;
      let lo = 255, hi = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= T || jj >= T || nd[jj * T + ii]) continue;
        const l = lum[jj * T + ii]; if (l < lo) lo = l; if (l > hi) hi = l;
      }
      const r = cr[k], g = cg[k], b = cb[k], l = lum[k], range = hi - lo, mx = Math.max(r, g, b), mn = Math.min(r, g, b), gb = Math.max(g, b);
      if (r < 128 && b > g - 14 && gb > r + 8 && gb > r * 1.12 && range < 26) {
        cls[k] = 0; anyW = true;
        wraw[k] = Math.min(10, Math.max(0.9, (148 - l) * 0.11));
      } else if (l > 96 && (mx - mn) / mx < 0.27 && range > 26) {
        // Grey and busy = roofs and roads; tan (dry fields, bare soil, sand) is too saturated to count.
        cls[k] = 128 + Math.round(127 * Math.min(1, (range - 26) / 36) * Math.min(1, (l - 96) / 44) * Math.min(1, (0.27 - (mx - mn) / mx) / 0.07));
      }
    }
    // Surf is bright, grey and busy like a roof: nothing next to water counts as built-up.
    if (anyW) for (let j = 0, k = 0; j < T; j++) for (let i = 0; i < T; i++, k++) {
      if (cls[k] <= 128) continue;
      search: for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < T && jj < T && wraw[jj * T + ii]) { cls[k] = 128; break search; }
      }
    }
    if (anyW) {
      wd = new Float32Array(T * T);
      for (let j = 0, k = 0; j < T; j++) for (let i = 0; i < T; i++, k++) {
        if (!wraw[k]) continue;
        let sum = 0, n = 0;
        for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= T || jj >= T) continue;
          const v = wraw[jj * T + ii]; if (v) { sum += v; n++; }
        }
        // An isolated blue cell is a pool or a tarp, not the sea.
        wd[k] = n >= 10 ? sum / n : 0;
        if (n < 10 && !nd[k]) cls[k] = 128;
      }
    }
  }
  const WD = wd;
  const CAT = cAt;
  const hAt = (u: number, v: number) => {
    let h = hRaw(u, v);
    if (CAT) {
      // One continuous surface through the waterline: topo-bathy below +1 m, eased into the base elevation by +3 m.
      const c = CAT(u, v);
      if (c === c) {
        let m = c >= 3 ? h : c;
        if (c > 1 && c < 3) { const t = (c - 1) / 2, w = 1 - t * t * (3 - 2 * t); m = h + (c - h) * w; }
        // A cell of the layer that straddles a sea wall or a quay is the mean of the wall top and the seabed. Below
        // +3 m that is a flat step at about sea level; above, the base elevation is used and that holds the sea at
        // 0 m. Either way a shelf one cell wide (37 m at zoom 12) stood out from the shore in blocks. Where the photo
        // shows water on such a cell (high ground and seabed both among its neighbours) it takes the seabed's side.
        if (WD && (c >= 3 || m > -0.5) && m < 1.2 && sample(WD, T, u * T - 0.5, v * T - 0.5) > 0.45) {
          let lo = m, hi = c;
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const n = CAT(u + di * cStep, v + dj * cStep);
            if (n < lo) lo = n; else if (n > hi) hi = n;
          }
          if (lo < -0.5 && hi > 2.5) m = lo;
        }
        return m;
      }
    }
    // No topo-bathy here: the coarse stand-in, then the depth guessed from the water's colour.
    if (h > -0.6 && h < 0.6) {
      if (bAt) { const b = bAt(u, v); if (b < -0.3) h = b; }
      // Still at sea level where the photo shows water: take the depth read off the water's colour (the real
      // bathymetry layer is trusted, so there only the minimum is applied).
      if (WD && h > -3) { const w = sample(WD, T, u * T - 0.5, v * T - 0.5); if (w > 0.05) h = Math.min(h, -w); }
    }
    return h;
  };

  // compact heights for heightAt
  const hts = new Int16Array(HN * HN);
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0, k = 0; j < HN; j++) for (let i = 0; i < HN; i++, k++) {
    const h = hAt(i / (HN - 1), j / (HN - 1));
    if (h < minH) minH = h; if (h > maxH) maxH = h;
    hts[k] = Math.max(-32768, Math.min(32767, Math.round(h * 2)));
  }

  // ---- mesh: (N+3)^2 vertices, the outer ring is the skirt ----
  const lonW = tileLon(x, z), lonE = tileLon(x + 1, z);
  const cLon = (lonW + lonE) / 2, cLat = tileLat(y + 0.5, z);
  const cx = (cLon - ORIGIN.lon) * M_PER_DEG_LON, cz = -(cLat - ORIGIN.lat) * M_PER_DEG_LAT, cy = -curveDrop(cx, cz);
  const widthM = (lonE - lonW) * M_PER_DEG_LON;
  const skirt = widthM * 0.012 + 8;
  const V = N + 3, pos = new Float32Array(V * V * 3);
  const rowZ = new Float64Array(N + 1);
  for (let j = 0; j <= N; j++) rowZ[j] = -(tileLat(y + j / N, z) - ORIGIN.lat) * M_PER_DEG_LAT;
  for (let j = 0, k = 0; j < V; j++) {
    const gj = Math.min(N, Math.max(0, j - 1));
    for (let i = 0; i < V; i++, k += 3) {
      const gi = Math.min(N, Math.max(0, i - 1));
      const wx = (lonW + (lonE - lonW) * gi / N - ORIGIN.lon) * M_PER_DEG_LON, wz = rowZ[gj];
      let h = hAt(gi / N, gj / N);
      if (i === 0 || j === 0 || i === V - 1 || j === V - 1) h -= skirt;
      pos[k] = wx - cx; pos[k + 1] = h - curveDrop(wx, wz) - cy; pos[k + 2] = wz - cz;
    }
  }

  // ---- normal map from the full-resolution heights; B carries height near sea level, A what the photo shows ----
  const G = new Float32Array((T + 2) * (T + 2));
  for (let j = 0, k = 0; j < T + 2; j++) for (let i = 0; i < T + 2; i++, k++) G[k] = hAt((i - 0.5) / T, (j - 0.5) / T);
  const norm = new Uint8Array(T * T * 4);
  const dx2 = 2 * widthM / T;
  for (let j = 0, o = 0; j < T; j++) {
    const dz2 = 2 * (tileLat(y + j / T, z) - tileLat(y + (j + 1) / T, z)) * M_PER_DEG_LAT;
    for (let i = 0; i < T; i++, o += 4) {
      const k = (j + 1) * (T + 2) + i + 1;
      const nx = -(G[k + 1] - G[k - 1]) / dx2, nz = -(G[k + T + 2] - G[k - T - 2]) / dz2;
      const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      norm[o] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      norm[o + 1] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      // Height code, companded so that the waterline is exact: metres = sign(e) e^2 96 with e = B * 2 - 1
      // (5 cm steps at 0.1 m, 15 cm at 1 m, 0.5 m at 10 m; beyond +-96 m the shader uses the mesh height).
      const g = G[k], e = g < 0 ? -Math.sqrt(Math.min(1, -g / 96)) : Math.sqrt(Math.min(1, g / 96));
      norm[o + 2] = Math.round((e * 0.5 + 0.5) * 255);
      // A: 0 = sea level here may be painted as seabed (the photo shows water, or shows nothing), 128 = neither,
      // 255 = built-up. Where the topo-bathy layer has data its surface alone decides what is under the sea: a lagoon
      // it holds at its water level, and dark mangrove that the photo test takes for water, keep their photo.
      let a = cls[j * T + i];
      if (CAT) { const c = CAT((i + 0.5) / T, (j + 0.5) / T); if (c === c) { if (a < 128) a = 128; } else if (!blank || blank[j * T + i]) a = 0; }
      else if (!blank || blank[j * T + i]) a = 0;
      norm[o + 3] = a;
    }
  }

  const res: TileResult = { id: job.id, ok: true, failed, okUrls, degraded: failed.length > 0, pos, hts, norm, photo: px, photoW: PW, minH, maxH, cx, cy, cz, demZ: src!.z, imgZ: photo.imgZ };
  const transfer: Transferable[] = [pos.buffer, hts.buffer, norm.buffer];
  if (px) transfer.push(px.buffer);
  return { res, transfer };
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type === 'abort') { ctl.get(m.id)?.abort(); return; }
  if (m.type === 'decodeTest') {
    // Decode through exactly the path tiles take and report an exact integer checksum (heights * 256).
    try {
      const bmp = await fetchBitmap(m.url, new AbortController().signal);
      const { w, h } = decodeTerrarium(bmp);
      let sum = 0, min = Infinity, max = -Infinity;
      for (let i = 0; i < h.length; i++) { sum += Math.round(h[i] * 256); if (h[i] < min) min = h[i]; if (h[i] > max) max = h[i]; }
      (self as any).postMessage({ type: 'decodeTest', id: m.id, w, sum, min, max, samples: [h[0], h[255], h[128 * 256 + 128], h[200 * 256 + 37], h[65535]] });
    } catch (e) { (self as any).postMessage({ type: 'decodeTest', id: m.id, error: String(e) }); }
    return;
  }
  if (m.type === 'tile') {
    const ac = new AbortController();
    ctl.set(m.id, ac);
    try {
      const { res, transfer } = await buildTile(m as TileJob, ac.signal);
      (self as any).postMessage(res, transfer);
    } catch (e) {
      (self as any).postMessage({ id: m.id, ok: false, aborted: ac.signal.aborted, failed: [], okUrls: [], error: String(e) });
    } finally { ctl.delete(m.id); }
  }
};
