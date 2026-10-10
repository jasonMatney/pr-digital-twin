#!/usr/bin/env node
// Snapshots the public feeds that do not send CORS headers (or are too large to parse in the browser) into small
// JSON files. Runs on GitHub Actions every ten minutes (.github/workflows/relay.yml); the files are published
// on the single-commit `relay` branch and read by src/feeds/ from raw.githubusercontent.com.
//
//   node pipeline/relay.mjs --out <dir>                         live
//   node pipeline/relay.mjs --from-fixtures tests/fixtures --out <dir>   offline, from recorded payloads
//
// Every file is { fetchedAt: <epoch ms>, source: <url>, data: <payload or trimmed payload> }. Each source is
// independent: when one fails its previous file is left in place and the error goes into status.json.
// Node 22, no dependencies.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const UA = 'garita-relay (+https://github.com/jasonMatney/pr-digital-twin)';
const TIMEOUT_MS = 30_000;
export const BOX = { south: 16.5, north: 20, west: -69, east: -63.5 };

// ---------- parsers (pure; tested against tests/fixtures) ----------
const numOrNull = (v) => { if (v == null || v === '' || v === 'MM') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

/** NDBC latest_obs.txt: whitespace-separated columns under a '#STN LAT LON YYYY MM DD hh mm ...' header, 'MM' = missing. */
export function parseNdbcLatestObs(text, box = BOX) {
  const lines = text.split(/\r?\n/);
  const header = (lines.find((l) => l.startsWith('#STN')) ?? '').replace(/^#/, '').trim().split(/\s+/);
  if (header.length < 8) throw new Error('NDBC latest_obs: header line not found');
  const col = (name) => header.indexOf(name);
  const out = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    if (f.length < header.length) continue;
    const g = (name) => { const i = col(name); return i < 0 ? null : numOrNull(f[i]); };
    const lat = g('LAT'), lon = g('LON');
    if (lat == null || lon == null || lat < box.south || lat > box.north || lon < box.west || lon > box.east) continue;
    const [y, mo, d, h, mi] = ['YYYY', 'MM', 'DD', 'hh', 'mm'].map((n) => numOrNull(f[col(n)]));
    if (y == null || mo == null || d == null || h == null || mi == null) continue;
    out.push({
      station: f[col('STN')], lat, lon, time: new Date(Date.UTC(y, mo - 1, d, h, mi)).toISOString(),
      wdir: g('WDIR'), wspd: g('WSPD'), gst: g('GST'), wvht: g('WVHT'), dpd: g('DPD'), apd: g('APD'), mwd: g('MWD'),
      pres: g('PRES'), ptdy: g('PTDY'), atmp: g('ATMP'), wtmp: g('WTMP'), dewp: g('DEWP'), vis: g('VIS'), tide: g('TIDE'),
    });
  }
  return out;
}

const ADSB_KEEP = ['hex', 'flight', 'r', 't', 'lat', 'lon', 'alt_baro', 'alt_geom', 'gs', 'track', 'baro_rate', 'squawk', 'emergency', 'category', 'seen'];
/** adsb.lol ({ ac, now: ms }) and adsb.fi ({ aircraft, now: s }) -> { now: ms, ac: [trimmed] }. */
export function trimAdsb(payload) {
  const list = payload?.ac ?? payload?.aircraft;
  if (!Array.isArray(list)) throw new Error('ADS-B: no aircraft array in the payload');
  let now = numOrNull(payload.now);
  if (now != null && now < 1e11) now = Math.round(now * 1000);        // seconds -> ms
  const ac = list.map((a) => { const o = {}; for (const k of ADSB_KEEP) if (a[k] !== undefined) o[k] = a[k]; return o; });
  return { now, total: ac.length, ac };
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const stripTags = (s) => decode(s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
const tag = (xml, name) => { const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml); return m ? m[1] : null; };
/** tsunami.gov Atom feed -> { title, updated, entries: [{ id, title, updated, summary, link, lat, lon }] }. */
export function parseTsunamiAtom(xml) {
  if (!/<feed\b/.test(xml)) throw new Error('tsunami: not an Atom feed');
  const head = xml.split(/<entry\b/)[0];
  const entries = [];
  for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const links = [...e.matchAll(/<link\b([^>]*)\/?>/g)].map((l) => ({ rel: /rel="([^"]*)"/.exec(l[1])?.[1] ?? null, href: /href="([^"]*)"/.exec(l[1])?.[1] ?? null }));
    const summary = tag(e, 'summary');
    entries.push({
      id: tag(e, 'id')?.trim() ?? null,
      title: stripTags(tag(e, 'title') ?? ''),
      updated: tag(e, 'updated')?.trim() ?? null,
      summary: summary == null ? null : stripTags(summary),
      link: decode((links.find((l) => l.rel === 'alternate') ?? links[0])?.href ?? '') || null,
      lat: numOrNull(tag(e, 'geo:lat')?.trim()), lon: numOrNull(tag(e, 'geo:long')?.trim()),
    });
  }
  return { title: stripTags(tag(head, 'title') ?? ''), updated: tag(head, 'updated')?.trim() ?? null, entries };
}

function checkNhc(payload) { if (!Array.isArray(payload?.activeStorms)) throw new Error('NHC: activeStorms missing'); return payload; }
function checkLuma(payload) { if (!Array.isArray(payload?.regions)) throw new Error('LUMA: regions missing'); return payload; }

// ---------- sources ----------
export const SOURCES = [
  { file: 'nhc.json', urls: ['https://www.nhc.noaa.gov/CurrentStorms.json'], fixture: 'nhc_current.json', type: 'json', parse: checkNhc },
  { file: 'ndbc.json', urls: ['https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt'], fixture: 'ndbc_latest_obs.txt', type: 'text', parse: (t) => parseNdbcLatestObs(t) },
  { file: 'luma.json', urls: ['https://api.miluma.lumapr.com/miluma-outage-api/outage/regionsWithoutService'], fixture: 'luma_regions.json', type: 'json', parse: checkLuma },
  { file: 'adsb.json', urls: ['https://api.adsb.lol/v2/point/18.2/-66.4/160', 'https://opendata.adsb.fi/api/v2/lat/18.2/lon/-66.4/dist/160'], fixture: 'adsb_lol.json', type: 'json', parse: trimAdsb },
  { file: 'tsunami.json', urls: ['https://www.tsunami.gov/events/xml/PAAQAtom.xml'], fixture: 'tsunami_atom.xml', type: 'text', parse: parseTsunamiAtom },
];

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
/** Tries each URL in order; returns the first that fetches AND parses. */
async function snapshot(src, fixturesDir) {
  const errors = [];
  for (const url of src.urls) {
    try {
      const text = fixturesDir ? await readFile(path.join(fixturesDir, src.fixture), 'utf8') : await fetchText(url);
      const data = src.parse(src.type === 'json' ? JSON.parse(text) : text);
      return { fetchedAt: Date.now(), source: url, data, bytes: text.length };
    } catch (e) {
      errors.push(`${new URL(url).host}: ${e?.message ?? e}`);
      if (fixturesDir) break;
    }
  }
  throw new Error(errors.join('; '));
}

async function readJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } }

export async function main(argv = process.argv.slice(2)) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const out = arg('--out') ?? 'relay-out';
  const fixturesDir = arg('--from-fixtures');
  await mkdir(out, { recursive: true });
  const previous = (await readJson(path.join(out, 'status.json')))?.files ?? {};
  const files = {};
  await Promise.all(SOURCES.map(async (src) => {
    const started = Date.now();
    try {
      const { bytes, ...snap } = await snapshot(src, fixturesDir);
      const body = JSON.stringify(snap);
      await writeFile(path.join(out, src.file), body);
      files[src.file] = { ok: true, fetchedAt: snap.fetchedAt, lastOkAt: snap.fetchedAt, source: snap.source, upstreamBytes: bytes, bytes: body.length, ms: Date.now() - started };
      console.log(`ok    ${src.file}  ${body.length} bytes  ${Date.now() - started} ms  ${snap.source}`);
    } catch (e) {
      // Keep whatever was published last time; record why this run has nothing newer.
      const kept = await readJson(path.join(out, src.file));
      files[src.file] = { ok: false, error: String(e?.message ?? e).slice(0, 500), failedAt: Date.now(), lastOkAt: kept?.fetchedAt ?? previous[src.file]?.lastOkAt ?? null, source: src.urls[0], ms: Date.now() - started };
      console.error(`FAIL  ${src.file}  ${files[src.file].error}`);
    }
  }));
  const ordered = Object.fromEntries(SOURCES.map((s) => [s.file, files[s.file]]));
  await writeFile(path.join(out, 'status.json'), JSON.stringify({ generatedAt: Date.now(), fixtures: !!fixturesDir, files: ordered }, null, 1));
  const failed = Object.values(ordered).filter((f) => !f.ok).length;
  console.log(`${SOURCES.length - failed}/${SOURCES.length} sources refreshed -> ${out}`);
  return failed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A partial failure still publishes (the others are fresh); only a crash fails the job.
  main().catch((e) => { console.error(e); process.exit(1); });
}
