// Shared helpers for the vector pipeline (boundaries, OSM, flood zones, exposure).
import fs from 'node:fs';
import path from 'node:path';

export const UA = 'garita-pr-digital-twin (github.com/jasonMatney/pr-digital-twin)';
export const OUT = path.resolve(process.env.OUT_DIR || 'out');
export const WORK = path.resolve(process.env.WORK_DIR || 'work');
export const CACHE = path.join(WORK, 'cache');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function writeOut(rel, data) {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

/** fetch with User-Agent, timeout, retries and exponential backoff. Returns a Response (ok) or throws. */
export async function fetchRetry(url, opts = {}, { tries = 5, timeout = 120000, okStatus = [] } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(timeout) });
      if (res.ok || okStatus.includes(res.status)) return res;
      lastErr = new Error(`HTTP ${res.status} ${url.slice(0, 160)}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) throw Object.assign(lastErr, { fatal: true });
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
    }
    await sleep(1000 * 2 ** i + Math.random() * 500);
  }
  throw lastErr;
}

/** Run async jobs with a concurrency limit. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ---- geometry ----
/** Douglas-Peucker on an array of [x, y]; keeps first and last. Iterative. */
export function dp(pts, tol) {
  const n = pts.length;
  if (n <= 2 || tol <= 0) return pts;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  const t2 = tol * tol;
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    const ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] - ax, py = pts[i][1] - ay;
      let d;
      if (len2 === 0) d = px * px + py * py;
      else { const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2)); const ex = px - t * dx, ey = py - t * dy; d = ex * ex + ey * ey; }
      if (d > best) { best = d; bi = i; }
    }
    if (best > t2) { keep[bi] = 1; stack.push(a, bi, bi, b); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}
/** Simplify a closed ring (first == last). Splits at the farthest vertex so the start point is not privileged. Returns null if degenerate. */
export function simplifyRing(ring, tol) {
  if (ring.length < 4) return null;
  if (tol <= 0) return ring;
  const n = ring.length - 1;
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const dx = ring[i][0] - ring[0][0], dy = ring[i][1] - ring[0][1], d = dx * dx + dy * dy; if (d > fd) { fd = d; far = i; } }
  const a = dp(ring.slice(0, far + 1), tol), b = dp(ring.slice(far), tol);
  const out = a.concat(b.slice(1));
  return out.length >= 4 ? out : null;
}
export function roundRing(ring, dec) {
  const f = 10 ** dec, out = [];
  let lx, ly;
  for (const p of ring) {
    const x = Math.round(p[0] * f) / f, y = Math.round(p[1] * f) / f;
    if (x !== lx || y !== ly) out.push([x, y]);
    lx = x; ly = y;
  }
  if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) out.push([out[0][0], out[0][1]]);
  return out.length >= 4 ? out : null;
}
export function ringArea(ring) { // signed, degrees^2 (positive = counter-clockwise)
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]);
  return s / 2;
}
export function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  const x0 = ring[0][0], y0 = ring[0][1]; // work relative to the first vertex for precision
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0] - x0, yi = ring[i][1] - y0, xj = ring[j][0] - x0, yj = ring[j][1] - y0;
    const f = xj * yi - xi * yj; a += f; cx += (xi + xj) * f; cy += (yi + yj) * f;
  }
  if (Math.abs(a) < 1e-18) { let sx = 0, sy = 0; for (const p of ring) { sx += p[0]; sy += p[1]; } return [sx / ring.length, sy / ring.length]; }
  return [x0 + cx / (3 * a), y0 + cy / (3 * a)];
}
/** GeoJSON Polygon / MultiPolygon -> array of polygons (each an array of rings). */
export function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}
/** Simplify + round a Polygon / MultiPolygon geometry; drops degenerate rings and polygons. */
export function simplifyGeom(geom, tol, dec, minArea = 0) {
  const polys = [];
  for (const poly of polygonsOf(geom)) {
    const rings = [];
    for (let i = 0; i < poly.length; i++) {
      let r = simplifyRing(poly[i], tol);
      r = r && roundRing(r, dec);
      if (r && Math.abs(ringArea(r)) > minArea) rings.push(r);
      else if (i === 0) { rings.length = 0; break; }
    }
    if (rings.length) polys.push(rings);
  }
  if (!polys.length) return null;
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

/**
 * Point-in-polygon index. Each item is a set of rings tested with the even-odd rule (so holes and multiple parts
 * need no grouping). Edges are bucketed in latitude bands per item; items are bucketed in a coarse grid by bbox.
 */
export class PolyIndex {
  constructor({ band = 0.001, cell = 0.02 } = {}) { this.band = band; this.cell = cell; this.items = []; this.grid = new Map(); }
  add(rings, value) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, ne = 0;
    for (const r of rings) { ne += r.length; for (const p of r) { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; } }
    if (!ne || !(maxx > minx) || !(maxy > miny)) return;
    const E = new Float64Array(ne * 4); let k = 0;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        if (r[i][1] === r[j][1]) continue; // horizontal edges never count
        E[k++] = r[j][0]; E[k++] = r[j][1]; E[k++] = r[i][0]; E[k++] = r[i][1];
      }
    }
    const n = k / 4, band = this.band, nb = Math.max(1, Math.ceil((maxy - miny) / band));
    const cnt = new Uint32Array(nb + 1);
    const b0 = new Int32Array(n), b1 = new Int32Array(n);
    for (let e = 0; e < n; e++) {
      const ya = E[e * 4 + 1], yb = E[e * 4 + 3];
      let lo = Math.floor((Math.min(ya, yb) - miny) / band), hi = Math.floor((Math.max(ya, yb) - miny) / band);
      if (lo < 0) lo = 0; if (hi >= nb) hi = nb - 1;
      b0[e] = lo; b1[e] = hi;
      for (let b = lo; b <= hi; b++) cnt[b + 1]++;
    }
    for (let b = 0; b < nb; b++) cnt[b + 1] += cnt[b];
    const idx = new Uint32Array(cnt[nb]), fill = cnt.slice(0, nb);
    for (let e = 0; e < n; e++) for (let b = b0[e]; b <= b1[e]; b++) idx[fill[b]++] = e;
    const id = this.items.length;
    this.items.push({ minx, miny, maxx, maxy, E, off: cnt, idx, nb, value });
    const c = this.cell;
    for (let gx = Math.floor(minx / c); gx <= Math.floor(maxx / c); gx++) for (let gy = Math.floor(miny / c); gy <= Math.floor(maxy / c); gy++) {
      const key = gx * 100000 + gy; let a = this.grid.get(key); if (!a) this.grid.set(key, a = []); a.push(id);
    }
  }
  _inside(it, x, y) {
    let b = Math.floor((y - it.miny) / this.band); if (b < 0) b = 0; if (b >= it.nb) b = it.nb - 1;
    const { E, idx, off } = it; let c = 0;
    for (let q = off[b], end = off[b + 1]; q < end; q++) {
      const e = idx[q] * 4, y1 = E[e + 1], y2 = E[e + 3];
      if ((y1 > y) !== (y2 > y)) { const xi = E[e] + (y - y1) / (y2 - y1) * (E[e + 2] - E[e]); if (xi > x) c ^= 1; }
    }
    return c === 1;
  }
  /** Calls fn(value) for every item containing the point. */
  query(x, y, fn) {
    const a = this.grid.get(Math.floor(x / this.cell) * 100000 + Math.floor(y / this.cell));
    if (!a) return;
    for (const id of a) { const it = this.items[id]; if (x < it.minx || x > it.maxx || y < it.miny || y > it.maxy) continue; if (this._inside(it, x, y)) fn(it.value); }
  }
  first(x, y) { let v = null; this.query(x, y, (val) => { if (v === null) v = val; }); return v; }
}

/** All rings of a Polygon / MultiPolygon geometry, flat. */
export function flatRings(geom) { const out = []; for (const poly of polygonsOf(geom)) for (const r of poly) out.push(r); return out; }

/** Page an ArcGIS REST layer query as GeoJSON features (resultOffset / resultRecordCount / orderByFields). */
export async function arcgisPaged(layerUrl, params, { page = 100, order = 'OBJECTID', label = '' } = {}) {
  const feats = [];
  for (let offset = 0; ; ) {
    const q = new URLSearchParams({ ...params, f: 'geojson', resultOffset: String(offset), resultRecordCount: String(page), orderByFields: order });
    const res = await fetchRetry(`${layerUrl}/query?${q}`, {}, { timeout: 180000 });
    const j = await res.json();
    if (j.error) throw new Error(`${label} ArcGIS error ${JSON.stringify(j.error).slice(0, 300)}`);
    const got = j.features || [];
    feats.push(...got);
    log(label, 'offset', offset, 'got', got.length, 'total', feats.length);
    if (!got.length) break;
    offset += got.length;
    if (got.length < page && !(j.exceededTransferLimit || j.properties?.exceededTransferLimit)) break;
  }
  return feats;
}
export async function arcgisCount(layerUrl, where) {
  const q = new URLSearchParams({ where, returnCountOnly: 'true', f: 'json' });
  const j = await (await fetchRetry(`${layerUrl}/query?${q}`)).json();
  return j.count;
}
