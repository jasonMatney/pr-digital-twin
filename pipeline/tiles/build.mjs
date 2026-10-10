// Mirrors the base map tiles for Puerto Rico and builds the island mosaics. Runs on the Actions runner
// (the dev sandbox has no network). Output goes to OUT (default ./out), laid out exactly as on gh-pages:
//   tiles/dem/{z}/{x}/{y}.png  tiles/img/{z}/{x}/{y}.jpg  tiles/index.json  data/island/*
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  ROOT_X0, ROOT_X1, ROOT_Y0, ROOT_Y1, tileBounds, tileTouchesLand, lonToTileX, latToTileY,
  terrariumToMetres, metresPerPixel,
} from '../../src/core/geo.ts';

const STAGE = Number(process.env.TILES_STAGE || 2);          // 1 = zooms 8..10 only, 2 = everything
const OUT = path.resolve(process.env.TILES_OUT || 'out');
const CACHE = path.resolve(process.env.TILES_CACHE || 'cache');
const UA = 'garita-pr-digital-twin (github.com/jasonMatney/pr-digital-twin)';
const DEM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const IMG_URL = (z, x, y) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`;
const SAN_JUAN = { west: -66.17, east: -65.97, south: 18.36, north: 18.48 };
const DEEP_BLUE = { r: 11, g: 42, b: 74 };                    // mosaic only: pixels with no imagery at any zoom
const NODATA_WHITE = { r: 255, g: 255, b: 255 };              // upstream's own no-data colour in its JPEG tiles
const JPEG_Q = 85;
const MOSAIC_Z = 10;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (n) => (n / 1024).toFixed(0) + ' kB';
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';

// ---- coverage ----
function underRoot(z) {
  const f = 2 ** (z - 8), out = [];
  for (let x = ROOT_X0 * f; x < (ROOT_X1 + 1) * f; x++) for (let y = ROOT_Y0 * f; y < (ROOT_Y1 + 1) * f; y++) out.push([x, y]);
  return out;
}
const land = (z) => underRoot(z).filter(([x, y]) => tileTouchesLand(z, x, y));
function box(z, b) {
  const out = [];
  const x0 = Math.floor(lonToTileX(b.west, z)), x1 = Math.floor(lonToTileX(b.east, z));
  const y0 = Math.floor(latToTileY(b.north, z)), y1 = Math.floor(latToTileY(b.south, z));
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
}
function coverage() {
  const dem = { 8: underRoot(8), 9: underRoot(9), 10: underRoot(10) };
  const img = { 8: underRoot(8), 9: underRoot(9), 10: underRoot(10) };
  if (STAGE >= 2) {
    for (const z of [11, 12]) dem[z] = land(z);
    for (const z of [13, 14, 15]) dem[z] = box(z, SAN_JUAN);
    for (const z of [11, 12, 13]) img[z] = land(z);
    for (const z of [14, 15, 16]) img[z] = box(z, SAN_JUAN);
  }
  return { dem, img };
}

// ---- download (per-host pool of 8, retry with backoff, raw cache keyed by tile) ----
async function fetchTile(url, file) {
  if (existsSync(file)) return 'cached';
  if (existsSync(file + '.404')) return 'cached404';
  let last, seen404 = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await sleep(600 * 2 ** (attempt - 1) + Math.random() * 400);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*,*/*' }, signal: AbortSignal.timeout(40000) });
      if (res.status === 404) {
        await res.arrayBuffer().catch(() => {});
        if (!seen404) { seen404 = true; last = 'HTTP 404'; attempt--; await sleep(700); continue; }   // ask twice
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file + '.404', '');
        return '404';
      }
      if (!res.ok) { last = 'HTTP ' + res.status; await res.arrayBuffer().catch(() => {}); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 64) { last = 'short body ' + buf.length; continue; }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file + '.part', buf);
      await fs.rename(file + '.part', file);
      return 'fetched';
    } catch (e) { last = String(e && e.message || e); }
  }
  return 'error: ' + last;
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
async function downloadLayer(name, cov, urlFn, ext) {
  const jobs = [];
  for (const z of Object.keys(cov)) for (const [x, y] of cov[z]) jobs.push({ z: +z, x, y });
  const tally = {}, errors = [];
  let done = 0;
  await pool(jobs, 8, async (t) => {
    const r = await fetchTile(urlFn(t.z, t.x, t.y), path.join(CACHE, name, String(t.z), String(t.x), t.y + ext));
    const k = r.startsWith('error') ? 'error' : r;
    tally[k] = (tally[k] || 0) + 1;
    if (k === 'error') errors.push(`${name} ${t.z}/${t.x}/${t.y} ${r}`);
    if (++done % 500 === 0) log(`  ${name}: ${done}/${jobs.length}`);
  });
  log(`download ${name}: ${jobs.length} tiles`, JSON.stringify(tally));
  for (const e of errors.slice(0, 40)) log('  FAILED', e);
  return { jobs, errors };
}

// ---- elevation ----
async function decodeRGB(buf) {
  const { data, info } = await sharp(buf).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  if (info.width !== 256 || info.height !== 256 || info.channels !== 3) throw new Error(`unexpected raster ${info.width}x${info.height}x${info.channels}`);
  return data;
}
/** Raw Terrarium RGB -> half-metre integers (Int32), i.e. round(metres * 2). */
function halfMetres(rgb) {
  const n = rgb.length / 3, q = new Int32Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.round(terrariumToMetres(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) * 2);
  return q;
}
/** Half-metre integers -> Terrarium RGB with B in {0, 128}; decodes with the unchanged formula. */
function encodeTerrarium(q) {
  const out = Buffer.allocUnsafe(q.length * 3);
  for (let i = 0; i < q.length; i++) {
    const v = q[i] + 65536;                    // half metres above -32768 m
    out[i * 3] = v >> 9; out[i * 3 + 1] = (v >> 1) & 255; out[i * 3 + 2] = (v & 1) << 7;
  }
  return out;
}
async function pngBest(rgb, width, height) {
  const mk = (adaptiveFiltering) => sharp(rgb, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 9, adaptiveFiltering, palette: false }).toBuffer();
  const [a, b] = await Promise.all([mk(false), mk(true)]);
  return a.length <= b.length ? a : b;
}

async function buildDem(cov) {
  const present = {}, z10 = new Map(), noData = {}, range = {}, spikes = {};
  let rawBytes = 0, outBytes = 0, maxErr = 0, n = 0, hMin = Infinity, hMax = -Infinity;
  const jobs = [];
  for (const z of Object.keys(cov)) for (const [x, y] of cov[z]) jobs.push({ z: +z, x, y });
  await pool(jobs, 4, async ({ z, x, y }) => {
    const src = path.join(CACHE, 'dem', String(z), String(x), y + '.png');
    if (!existsSync(src)) return;
    const raw = await fs.readFile(src);
    const rgb = await decodeRGB(raw);
    const q = halfMetres(rgb);
    const png = await pngBest(encodeTerrarium(q), 256, 256);
    let nd = 0; const rg = (range[z] ||= [Infinity, -Infinity]);
    for (let i = 0; i < q.length; i++) { if (q[i] <= -65536) nd++; else { if (q[i] < rg[0]) rg[0] = q[i]; if (q[i] > rg[1]) rg[1] = q[i]; } }
    if (nd) (noData[z] ||= []).push([x, y, nd]);
    // garbage pixels upstream: more than 250 m from the median of the 4 neighbours (counted, never corrected)
    let sp = 0;
    for (let r = 1; r < 255; r++) for (let c = 1; c < 255; c++) {
      const i = r * 256 + c; let a = q[i - 1], b = q[i + 1], e = q[i - 256], f = q[i + 256], t;
      if (a > b) { t = a; a = b; b = t; } if (e > f) { t = e; e = f; f = t; }
      const med = (Math.max(a, e) + Math.min(b, f)) / 2;
      if (Math.abs(q[i] - med) > 500) sp++;
    }
    if (sp) (spikes[z] ||= []).push([x, y, sp]);
    // round trip through the file we are about to publish, against the raw tile
    const back = await decodeRGB(png);
    for (let i = 0; i < q.length; i++) {
      if (back[i * 3 + 2] !== 0 && back[i * 3 + 2] !== 128) throw new Error(`dem ${z}/${x}/${y}: B=${back[i * 3 + 2]}`);
      const h0 = terrariumToMetres(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
      const h1 = terrariumToMetres(back[i * 3], back[i * 3 + 1], back[i * 3 + 2]);
      const e = Math.abs(h1 - h0);
      if (e > maxErr) maxErr = e;
      if (h1 < hMin) hMin = h1; if (h1 > hMax) hMax = h1;
    }
    const dst = path.join(OUT, 'tiles/dem', String(z), String(x), y + '.png');
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, png);
    rawBytes += raw.length; outBytes += png.length; n++;
    (present[z] ||= []).push([x, y]);
    if (z === MOSAIC_Z) z10.set(x + '/' + y, q);
  });
  log(`dem: ${n} tiles, raw ${mb(rawBytes)} -> re-encoded ${mb(outBytes)} (${(100 * outBytes / rawBytes).toFixed(1)} %), round-trip max abs error ${maxErr.toFixed(4)} m, range ${hMin} .. ${hMax} m`);
  log('dem range per zoom (m, no-data excluded):', Object.entries(range).map(([z, r]) => `z${z} ${r[0] / 2}..${r[1] / 2}`).join('  '));
  log('dem tiles with no-data pixels (-32768 m, RGB 0,0,0 upstream) [x,y,pixels]:', JSON.stringify(noData));
  log('dem tiles with spike pixels (> 250 m from the median of the 4 neighbours):', Object.entries(spikes).map(([z, t]) => `z${z}: ${t.length} tiles, ${t.reduce((n, v) => n + v[2], 0)} px`).join('; '));
  if (maxErr > 0.25 + 1e-9) throw new Error('dem round trip error above 0.25 m: ' + maxErr);
  return { present, z10, rawBytes, outBytes, maxErr, hMin, hMax, noData, spikes };
}

// ---- photo ----
const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const WHITE = 248;
/** Pixels that are pure white upstream (= outside the imagery footprint). Returns a 0/1 mask and the count. */
function whiteMask(d, ch) {
  const n = d.length / ch, m = new Uint8Array(n); let c = 0;
  for (let i = 0; i < n; i++) if (d[i * ch] >= WHITE && d[i * ch + 1] >= WHITE && d[i * ch + 2] >= WHITE && (ch < 4 || d[i * ch + 3] > 0)) { m[i] = 1; c++; }
  return { m, c };
}
const flatRGB = (buf) => sharp(buf).flatten({ background: NODATA_WHITE }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });

async function buildImg(cov) {
  const present = {}, partial = {}, white = {}, stats = {};
  const odd = [];
  const jobs = [];
  for (const z of Object.keys(cov)) for (const [x, y] of cov[z]) jobs.push({ z: +z, x, y });
  await pool(jobs, 4, async ({ z, x, y }) => {
    const s = (stats[z] ||= { want: 0, jpeg: 0, png: 0, pngAlpha: 0, missing404: 0, failed: 0, bytes: 0, rawBytes: 0 });
    s.want++;
    const src = path.join(CACHE, 'img', String(z), String(x), y + '.bin');
    if (existsSync(src + '.404')) { s.missing404++; return; }
    if (!existsSync(src)) { s.failed++; return; }
    const raw = await fs.readFile(src);
    let jpg;
    try {
      const meta = await sharp(raw).metadata();
      const sized = meta.width === 256 && meta.height === 256;
      if (isJpeg(raw) && sized) { jpg = raw; s.jpeg++; }
      else if (isPng(raw) || isJpeg(raw)) {
        if (!sized) odd.push(`${z}/${x}/${y} ${meta.format} ${meta.width}x${meta.height} resized`);
        if (meta.hasAlpha) { const st = await sharp(raw).stats(); if (st.channels[3] && st.channels[3].min < 255) { s.pngAlpha++; (partial[z] ||= []).push([x, y]); } }
        let p = sharp(raw).flatten({ background: NODATA_WHITE });   // same convention as upstream JPEG tiles: white = no imagery
        if (!sized) p = p.resize(256, 256, { fit: 'fill' });
        jpg = await p.jpeg({ quality: JPEG_Q, mozjpeg: true }).toBuffer();
        s.png++;
      } else throw new Error('not an image: ' + raw.subarray(0, 60).toString('latin1').replace(/\s+/g, ' '));
    } catch (e) { s.failed++; odd.push(`${z}/${x}/${y} ${String(e.message).slice(0, 120)}`); return; }
    const dst = path.join(OUT, 'tiles/img', String(z), String(x), y + '.jpg');
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, jpg);
    s.bytes += jpg.length; s.rawBytes += raw.length;
    (present[z] ||= []).push([x, y]);
    const wm = whiteMask((await flatRGB(jpg)).data, 3);
    if (wm.c >= 65536 * 0.005) { (white[z] ||= []).push([x, y, Math.round(100 * wm.c / 65536)]); s.white = (s.white || 0) + 1; if (wm.c >= 65536 * 0.995) s.allWhite = (s.allWhite || 0) + 1; }
  });
  let total = 0;
  for (const z of Object.keys(stats)) {
    const s = stats[z]; total += s.bytes;
    log(`img z${z}: wanted ${s.want}, written ${s.jpeg + s.png} (jpeg kept ${s.jpeg}, png->jpeg ${s.png}, of which with transparency ${s.pngAlpha}), 404 ${s.missing404}, failed ${s.failed}, with >=0.5 % pure white ${s.white || 0} (entirely white ${s.allWhite || 0}), ${mb(s.bytes)} (raw ${mb(s.rawBytes)})`);
  }
  for (const o of odd.slice(0, 40)) log('  img odd:', o);
  log(`img: total ${mb(total)}`);
  return { present, partial, white, stats, total, odd };
}

// ---- mosaics ----
async function buildMosaics(dem, img) {
  const x0 = ROOT_X0 * 4, y0 = ROOT_Y0 * 4, nx = (ROOT_X1 - ROOT_X0 + 1) * 4, ny = (ROOT_Y1 - ROOT_Y0 + 1) * 4;
  const W = nx * 256, H = ny * 256;
  const dir = path.join(OUT, 'data/island');
  await fs.mkdir(dir, { recursive: true });

  // elevation
  const q = new Int32Array(W * H);
  const demMissing = [];
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const t = dem.z10.get(`${x0 + tx}/${y0 + ty}`);
    if (!t) { demMissing.push([x0 + tx, y0 + ty]); continue; }
    for (let r = 0; r < 256; r++) q.set(t.subarray(r * 256, r * 256 + 256), (ty * 256 + r) * W + tx * 256);
  }
  if (demMissing.length) throw new Error('elevation mosaic: missing z10 tiles ' + JSON.stringify(demMissing));
  const demPng = await pngBest(encodeTerrarium(q), W, H);
  await fs.writeFile(path.join(dir, 'dem_z10.png'), demPng);
  let hMin = Infinity, hMax = -Infinity, landPx = 0;
  for (let i = 0; i < q.length; i++) { if (q[i] < hMin) hMin = q[i]; if (q[i] > hMax) hMax = q[i]; if (q[i] > 0) landPx++; }
  log(`mosaic dem_z10.png ${W}x${H} ${kb(demPng.length)}, ${hMin / 2} .. ${hMax / 2} m, land ${(100 * landPx / q.length).toFixed(1)} % of pixels`);

  // upstream glitches: isolated garbage pixels (hundreds of metres off their neighbours). Left untouched, but listed.
  const outliers = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const nb = [q[(y - 1) * W + x - 1], q[(y - 1) * W + x], q[(y - 1) * W + x + 1], q[y * W + x - 1], q[y * W + x + 1], q[(y + 1) * W + x - 1], q[(y + 1) * W + x], q[(y + 1) * W + x + 1]].sort((a, b) => a - b);
    const med = (nb[3] + nb[4]) / 4, h = q[y * W + x] / 2;
    if (Math.abs(h - med) > 250) {
      const b = tileBounds(MOSAIC_Z + 8, (x0 << 8) + x, (y0 << 8) + y);
      outliers.push({ px: [x, y], lon: +((b.west + b.east) / 2).toFixed(5), lat: +((b.north + b.south) / 2).toFixed(5), m: h, neighbourMedian_m: med });
    }
  }
  log(`dem_z10 outliers (> 250 m from the median of the 8 neighbours, upstream artefacts, NOT corrected): ${outliers.length}`, JSON.stringify(outliers.slice(0, 8)));

  // photo: the service has no tiles at some zooms (z9 and z10 are HTTP 404 over the whole area), so the mosaic is
  // resampled from the real tiles of every mirrored zoom up to 13, painted coarse to fine (finer wins, alpha respected).
  const rgb = Buffer.alloc(W * H * 3), painted = new Uint8Array(W * H), layers = [];
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = DEEP_BLUE.r; rgb[i * 3 + 1] = DEEP_BLUE.g; rgb[i * 3 + 2] = DEEP_BLUE.b; }
  const blend = (src, sw, sh, px, py) => {
    for (let r = 0; r < sh; r++) {
      const y = py + r; if (y < 0 || y >= H) continue;
      for (let c = 0; c < sw; c++) {
        const x = px + c; if (x < 0 || x >= W) continue;
        const a = src[(r * sw + c) * 4 + 3]; if (!a) continue;
        const o = (y * W + x) * 3, i = (r * sw + c) * 4, k = a / 255;
        rgb[o] += (src[i] - rgb[o]) * k; rgb[o + 1] += (src[i + 1] - rgb[o + 1]) * k; rgb[o + 2] += (src[i + 2] - rgb[o + 2]) * k;
        if (a > 127) painted[y * W + x] = 1;
      }
    }
  };
  const rawOf = (z, x, y) => fs.readFile(path.join(CACHE, 'img', String(z), String(x), y + '.bin'));
  const rgba = (p) => p.ensureAlpha().toColourspace('srgb').raw().toBuffer();
  for (const z of Object.keys(img.present).map(Number).filter((z) => z <= 13).sort((a, b) => a - b)) {
    const tiles = img.present[z];
    if (z < MOSAIC_Z) {
      // coarser than the mosaic: assemble at native size, then enlarge in one piece so no tile seams appear
      const f = 2 ** (z - 8), nW = nx / 4 * f * 256, nH = ny / 4 * f * 256, native = Buffer.alloc(nW * nH * 4);
      for (const [x, y] of tiles) {
        const t = await rgba(sharp(await rawOf(z, x, y)));
        const px = (x - ROOT_X0 * f) * 256, py = (y - ROOT_Y0 * f) * 256;
        for (let r = 0; r < 256; r++) t.copy(native, ((py + r) * nW + px) * 4, r * 1024, r * 1024 + 1024);
      }
      blend(await sharp(native, { raw: { width: nW, height: nH, channels: 4 } }).resize(W, H, { kernel: 'cubic' }).raw().toBuffer(), W, H, 0, 0);
      layers.push({ zoom: z, tiles: tiles.length, method: `assembled, enlarged ${2 ** (MOSAIC_Z - z)}x (bicubic)` });
    } else {
      const sz = 256 >> (z - MOSAIC_Z); let masked = 0;
      await pool(tiles, 4, async ([x, y]) => {
        const { data: d, info } = await sharp(await rawOf(z, x, y)).ensureAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
        const tw = info.width, th = info.height, { m: w, c } = whiteMask(d, 4);
        if (c >= 12) {
          // white = outside the imagery footprint. Only runs of >= 12 white pixels along a row or a column count
          // (roofs and surf are shorter); cut them out 2 px wider for JPEG ringing.
          const m = new Uint8Array(tw * th); let any = 0;
          for (let yy = 0; yy < th; yy++) for (let xx = 0, run = 0; xx <= tw; xx++) {
            if (xx < tw && w[yy * tw + xx]) run++; else { if (run >= 12) { for (let k = xx - run; k < xx; k++) m[yy * tw + k] = 1; any = 1; } run = 0; }
          }
          for (let xx = 0; xx < tw; xx++) for (let yy = 0, run = 0; yy <= th; yy++) {
            if (yy < th && w[yy * tw + xx]) run++; else { if (run >= 12) { for (let k = yy - run; k < yy; k++) m[k * tw + xx] = 1; any = 1; } run = 0; }
          }
          for (let yy = 0; yy < th; yy++) for (let xx = 0; xx < tw; xx++) if (m[yy * tw + xx])
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
              const ax = xx + dx, ay = yy + dy;
              if (ax >= 0 && ay >= 0 && ax < tw && ay < th) d[(ay * tw + ax) * 4 + 3] = 0;
            }
          masked += any;
        }
        let p = sharp(d, { raw: { width: tw, height: th, channels: 4 } });
        if (sz !== tw) p = p.resize(sz, sz, { kernel: 'lanczos3', fit: 'fill' });
        blend(await p.raw().toBuffer(), sz, sz, x * sz - x0 * 256, y * sz - y0 * 256);
      });
      layers.push({ zoom: z, tiles: tiles.length, method: sz === 256 ? 'as served' : `each tile reduced ${256 / sz}x (lanczos3)`, tilesWithWhiteNoDataCutOut: masked });
    }
  }
  let nPainted = 0; for (let i = 0; i < painted.length; i++) nPainted += painted[i];
  const unpainted = 1 - nPainted / painted.length;
  const imgJpg = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: JPEG_Q, mozjpeg: true }).toBuffer();
  await fs.writeFile(path.join(dir, 'img_z10.jpg'), imgJpg);
  log(`mosaic img_z10.jpg ${W}x${H} ${kb(imgJpg.length)}, layers ${JSON.stringify(layers)}, pixels with no imagery at any zoom (neutral deep blue): ${(100 * unpainted).toFixed(2)} %`);

  // QA hillshade with the 0 m contour
  const cs = metresPerPixel(MOSAIC_Z), qa = Buffer.alloc(W * H * 3);
  const az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
  const lx = Math.sin(az) * Math.cos(alt), ly = Math.cos(az) * Math.cos(alt), lz = Math.sin(alt);  // x east, y north
  const at = (x, y) => q[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))] / 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const h = at(x, y), zf = h > 0 ? 6 : 1.2;
    const dzdx = (at(x + 1, y) - at(x - 1, y)) / (2 * cs) * zf, dzdy = (at(x, y - 1) - at(x, y + 1)) / (2 * cs) * zf;  // row up = north
    const inv = 1 / Math.hypot(dzdx, dzdy, 1);
    const s = Math.max(0, (-dzdx * lx - dzdy * ly + lz) * inv) / lz;      // 1 on flat ground
    let r, g, b;
    if (h > 0) { const t = Math.min(1, h / 1200); r = 120 + 110 * t; g = 160 + 50 * t; b = 110 + 90 * t; }
    else { const t = Math.min(1, -h / 6000); r = 90 - 70 * t; g = 150 - 100 * t; b = 200 - 90 * t; }
    const k = Math.min(1.35, 0.25 + 0.75 * s);
    const o = (y * W + x) * 3;
    const coast = (h > 0) !== (at(x + 1, y) > 0) || (h > 0) !== (at(x, y + 1) > 0) || (h > 0) !== (at(x - 1, y) > 0) || (h > 0) !== (at(x, y - 1) > 0);
    if (coast) { qa[o] = 200; qa[o + 1] = 20; qa[o + 2] = 20; }
    else { qa[o] = Math.min(255, r * k); qa[o + 1] = Math.min(255, g * k); qa[o + 2] = Math.min(255, b * k); }
  }
  let qaJpg, qaQ = 82, qaW = W;
  for (;;) {
    qaJpg = await sharp(qa, { raw: { width: W, height: H, channels: 3 } }).resize({ width: qaW }).jpeg({ quality: qaQ, mozjpeg: true }).toBuffer();
    if (qaJpg.length <= 400 * 1024) break;
    if (qaQ > 60) qaQ -= 8; else { qaW = Math.round(qaW * 0.8); qaQ = 76; }
  }
  await fs.writeFile(path.join(dir, 'qa_hillshade.jpg'), qaJpg);
  log(`qa_hillshade.jpg ${qaW} px wide, q${qaQ}, ${kb(qaJpg.length)}`);

  const nw = tileBounds(MOSAIC_Z, x0, y0), se = tileBounds(MOSAIC_Z, x0 + nx - 1, y0 + ny - 1);
  return {
    zoom: MOSAIC_Z, x0, y0, tilesX: nx, tilesY: ny, tileSize: 256, width: W, height: H,
    bounds: { west: nw.west, south: se.south, east: se.east, north: nw.north },
    projection: 'Web Mercator (EPSG:3857): columns are equal steps in longitude, rows equal steps in Mercator y (not latitude); row 0 is north',
    dem: { file: 'dem_z10.png', encoding: 'terrarium: metres = R*256 + G + B/256 - 32768', quantisation_m: 0.5, min_m: hMin / 2, max_m: hMax / 2, bytes: demPng.length,
      outliersNote: 'pixels more than 250 m from the median of their 8 neighbours: garbage in the upstream tiles (present at every zoom near the same places), kept as served. Clamp or median-filter them when meshing.',
      outliers },
    img: {
      file: 'img_z10.jpg', jpegQuality: JPEG_Q, bytes: imgJpg.length,
      composition: 'Resampled from the real USGSImageryOnly tiles of every mirrored zoom <= 13, painted coarse to fine (finer zoom wins where it has data; upstream transparency respected; upstream pure-white no-data areas (runs of >= 12 pixels with all channels >= 248, grown 2 px) are cut out so the coarser layer shows). The service answers 404 for zoom 10 itself, so no zoom-10 tile is used unless listed in layers.',
      layers,
      fill: 'No imagery is invented. Pixels with no imagery at any mirrored zoom are neutral deep blue rgb(11,42,74).',
      neutralFillFraction: Number(unpainted.toFixed(5)),
    },
    qa: { file: 'qa_hillshade.jpg', note: 'hillshade (sun NW, land exaggerated 6x, sea 1.2x) of dem_z10.png, 0 m contour in red' },
  };
}

// ---- main ----
const t0 = Date.now();
log(`stage ${STAGE}, node ${process.version}, sharp ${sharp.versions.sharp}, out ${OUT}, cache ${CACHE}`);
const cov = coverage();
for (const l of ['dem', 'img']) log(`coverage ${l}:`, Object.entries(cov[l]).map(([z, t]) => `z${z}=${t.length}`).join(' '));
await fs.rm(OUT, { recursive: true, force: true });
const [dl1, dl2] = await Promise.all([
  downloadLayer('dem', cov.dem, DEM_URL, '.png'),
  downloadLayer('img', cov.img, IMG_URL, '.bin'),
]);
const dem = await buildDem(cov.dem);
const img = await buildImg(cov.img);
const island = await buildMosaics(dem, img);
const sources = {
  dem: 'AWS Terrain Tiles (Mapzen/Tilezen Terrarium; USGS 3DEP on land, GEBCO/ETOPO1 bathymetry), https://registry.opendata.aws/terrain-tiles/ ; re-encoded, heights quantised to 0.5 m',
  img: 'USGS The National Map: USGSImageryOnly (public domain), https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer',
};
const generated = new Date().toISOString();
await fs.writeFile(path.join(OUT, 'data/island/meta.json'), JSON.stringify({ generated, ...island, sources }, null, 1));
const sortIdx = (o) => Object.fromEntries(Object.keys(o).sort((a, b) => a - b).map((z) => [z, o[z].sort((a, b) => a[0] - b[0] || a[1] - b[1])]));
const index = {
  generated, dem: sortIdx(dem.present), img: sortIdx(img.present), sources,
  notes: {
    dem: 'tiles/dem/{z}/{x}/{y}.png, 256 px Terrarium RGB, 0.5 m steps (B is 0 or 128)',
    img: 'tiles/img/{z}/{x}/{y}.jpg, 256 px JPEG. A tile absent from this list was HTTP 404 upstream or failed; do not request it. See imgUpstream404: whole zooms can be absent.',
    imgUpstream404: Object.fromEntries(Object.entries(img.stats).map(([z, t]) => [z, `${t.missing404} of ${t.want}`])),
    imgPartlyTransparentUpstream: img.partial,
    imgPartlyTransparentNote: 'these tiles came as PNG with transparent pixels; in the mirrored JPEG those pixels are pure white, the colour upstream itself uses for no imagery (see imgWhiteNoData)',
    imgWhiteNoData: img.white,
    imgWhiteNoDataNote: 'USGS paints areas outside the imagery footprint PURE WHITE in its JPEG tiles (coast and open sea at z11..13, some tiles entirely white). Listed [x, y, percent white] for tiles with >= 0.5 % of pixels >= 248 on all channels (thinner slivers exist in other coastal tiles). JPEG tiles are mirrored byte-for-byte; PNG tiles are re-encoded with their transparent pixels also white. So in every mirrored tile pure white = no imagery: mask it (e.g. fall back to the parent tile or water colour).',
    demSpikes: dem.spikes,
    demSpikesNote: 'elevation tiles containing garbage pixels upstream (more than 250 m from the median of their 4 neighbours; values from -22 km to +4 km), [x, y, pixel count]. Kept as served (round trip <= 0.25 m): despike when meshing, e.g. replace by the neighbour median.',
    demNoData: dem.noData,
    demNoDataNote: 'elevation tiles with pixels at -32768 m (RGB 0,0,0 upstream = no data), [x, y, pixel count]; kept as served',
    failed: [...dl1.errors, ...dl2.errors].map((e) => e.split(' ').slice(0, 2).join(' ')),
  },
};
await fs.writeFile(path.join(OUT, 'tiles/index.json'), JSON.stringify(index));
for (const l of ['dem', 'img']) log(`index ${l}:`, Object.entries(index[l]).map(([z, t]) => `z${z}=${t.length}`).join(' '));
log(`sizes: dem tiles ${mb(dem.outBytes)}, img tiles ${mb(img.total)}, total tiles ${mb(dem.outBytes + img.total)}; done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
if (dl1.errors.length) throw new Error(`${dl1.errors.length} elevation tiles failed to download`);
