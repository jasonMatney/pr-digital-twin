// Tile worker: fetches a terrain tile's elevation and photo, decodes them off the main thread, and returns
// ready-to-upload buffers (vertex positions, a compact height grid, a normal+height map, a photo bitmap).
import { tileLon, tileLat, curveDrop, ORIGIN, M_PER_DEG_LAT, M_PER_DEG_LON } from '../../core/geo.ts';

export interface DemSrc { url: string; z: number; x: number; y: number }
export interface TileJob {
  type: 'tile'; id: number; z: number; x: number; y: number; grid: number;
  dem: DemSrc[];                 // candidates in order of preference (exact tile, then an ancestor to upsample)
  img: string[][];               // candidates: four z+1 urls (nw, ne, sw, se) or one url; empty = no photo wanted
  crop?: DemSrc | null;          // nearest ancestor photo, cropped, when the tile adds elevation detail but has no photo of its own
  root: boolean;                 // roots never fail: flat sea level and no photo instead
}
export interface TileResult {
  id: number; ok: boolean; aborted?: boolean; failed: string[]; okUrls: string[]; degraded?: boolean;
  pos?: Float32Array; hts?: Int16Array; norm?: Uint8Array; photo?: ImageBitmap | null;
  minH?: number; maxH?: number; cx?: number; cy?: number; cz?: number; demZ?: number; imgZ?: number;
}

const tag = (e: any, url: string) => (/^Error: (http|not an image)/.test(String(e)) ? 'http|' : 'net|') + url;
const HN = 129;                  // compact height grid kept on the main thread for heightAt (0.5 m steps)
const demCache = new Map<string, { w: number; h: Float32Array }>();
const ctl = new Map<number, AbortController>();
let dcv: OffscreenCanvas | null = null;
let pcv: OffscreenCanvas | null = null;

async function fetchBitmap(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  const r = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
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

async function loadDem(url: string, signal: AbortSignal) {
  const hit = demCache.get(url);
  if (hit) { demCache.delete(url); demCache.set(url, hit); return hit; }
  const bmp = await fetchBitmap(url, signal);
  const dem = decodeTerrarium(bmp);
  bmp.close();
  demCache.set(url, dem);
  if (demCache.size > 20) demCache.delete(demCache.keys().next().value!);
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
  const hAt = (u: number, v: number) => sample(H, W, (u0 + u / s) * W - 0.5, (v0 + v / s) * W - 0.5);

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

  // ---- normal map from the full-resolution heights; B carries height near sea level ----
  const T = 256, G = new Float32Array((T + 2) * (T + 2));
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
      const hc = (G[k] + 96) / 128;                       // -96 m .. +32 m in 0.5 m steps
      norm[o + 2] = hc <= 0 ? 0 : hc >= 1 ? 255 : Math.round(hc * 255);
      norm[o + 3] = 255;
    }
  }

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
  const res: TileResult = { id: job.id, ok: true, failed, okUrls, degraded: failed.length > 0, pos, hts, norm, photo: photo.bmp, minH, maxH, cx, cy, cz, demZ: src!.z, imgZ: photo.imgZ };
  const transfer: Transferable[] = [pos.buffer, hts.buffer, norm.buffer];
  if (photo.bmp) transfer.push(photo.bmp);
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
