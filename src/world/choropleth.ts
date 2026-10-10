// Municipio polygons (Census TIGER, clipped to land) and the choropleth drawn from them, tile by tile, in the browser.
// Shared by the overlay layer (fills), the boundaries layer (outlines, hit tests) and the storm replay (interior points).
import { dataUrl } from '../core/config';
import { latToTileY, lonToTileX, tileBounds } from '../core/geo.ts';
import type { OverlaySource } from './types';
import type { Lang, PropertyDef } from '../ontology/types';

export interface Municipio {
  geoid: string; name: string;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  /** Polygons -> rings -> flat [lon, lat, lon, lat, ...]. First ring of a polygon is its outside. */
  polys: Float64Array[][];
  /** Census interior point. */
  lon: number; lat: number;
}

let cache: Promise<Municipio[]> | null = null;
export function loadMunicipios(): Promise<Municipio[]> {
  return (cache ??= fetch(dataUrl('data/geo/municipios_land.geojson')).then((r) => { if (!r.ok) throw new Error('municipio boundaries unavailable'); return r.json(); }).then((g) => {
    const out: Municipio[] = [];
    for (const f of g.features ?? []) {
      const geom = f.geometry;
      if (!geom) continue;
      const raw: number[][][][] = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
      const bbox: [number, number, number, number] = [180, 90, -180, -90];
      const polys = raw.map((poly) => poly.map((ring) => {
        const a = new Float64Array(ring.length * 2);
        for (let i = 0; i < ring.length; i++) {
          const lon = ring[i][0], lat = ring[i][1];
          a[i * 2] = lon; a[i * 2 + 1] = lat;
          if (lon < bbox[0]) bbox[0] = lon; if (lon > bbox[2]) bbox[2] = lon;
          if (lat < bbox[1]) bbox[1] = lat; if (lat > bbox[3]) bbox[3] = lat;
        }
        return a;
      }));
      const p = f.properties ?? {};
      out.push({ geoid: String(p.GEOID), name: String(p.NAME ?? p.GEOID), bbox, polys, lon: +(p.INTPTLON ?? p.CENTLON ?? (bbox[0] + bbox[2]) / 2), lat: +(p.INTPTLAT ?? p.CENTLAT ?? (bbox[1] + bbox[3]) / 2) });
    }
    return out;
  }).catch((e) => { cache = null; throw e; }));
}

function inRing(r: Float64Array, lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const yi = r[i + 1], yj = r[j + 1];
    if ((yi > lat) !== (yj > lat) && lon < ((r[j] - r[i]) * (lat - yi)) / (yj - yi) + r[i]) inside = !inside;
  }
  return inside;
}
/** The municipio whose land polygon holds the point, or null (sea, outside). Bounding boxes reject most candidates first. */
export function municipioAt(list: Municipio[], lon: number, lat: number): Municipio | null {
  for (const m of list) {
    const b = m.bbox;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    for (const poly of m.polys) {
      if (!inRing(poly[0], lon, lat)) continue;
      let hole = false;
      for (let k = 1; k < poly.length && !hole; k++) hole = inRing(poly[k], lon, lat);
      if (!hole) return m;
    }
  }
  return null;
}

// ---- colour ----
/** Sequential ramp, light to dark (ColorBrewer YlGnBu, 7 stops). Higher value = darker. */
export const RAMP = ['#ffffcc', '#c7e9b4', '#7fcdbb', '#41b6c4', '#1d91c0', '#225ea8', '#0c2c84'];
export const NO_DATA = '#8b9296';
const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
export function rampAt(k: number): string {
  const f = Math.min(1, Math.max(0, k)) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(f)), a = hex(RAMP[i]), b = hex(RAMP[i + 1]);
  return '#' + a.map((v, j) => Math.round(v + (b[j] - v) * (f - i)).toString(16).padStart(2, '0')).join('');
}
export function classColors(n: number): string[] { return Array.from({ length: n }, (_, i) => rampAt(n === 1 ? 0.5 : i / (n - 1))); }

/** Upper bounds of the first n-1 quantile classes (so n classes). Fewer when the data has few distinct values. */
export function quantileBreaks(values: number[], n = 5): number[] {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < 2) return [];
  const out: number[] = [];
  for (let i = 1; i < n; i++) {
    const q = v[Math.min(v.length - 1, Math.floor((i * v.length) / n))];
    if (q > v[0] && (!out.length || q > out[out.length - 1])) out.push(q);
  }
  return out;
}
/** Class index of a value: values equal to a break belong to the class above it. */
export function classOf(v: number, breaks: number[]): number { let c = 0; while (c < breaks.length && v >= breaks[c]) c++; return c; }

export function formatValue(v: number, def: PropertyDef | undefined, lang: Lang): string {
  const loc = lang === 'es' ? 'es-PR' : 'en-US';
  const f = def?.format;
  const digits = f === 'fixed2' ? 2 : f === 'fixed1' || f === 'pct' ? 1 : f === 'int' || f === 'usd' ? 0 : Math.abs(v) < 10 ? 1 : 0;
  const s = v.toLocaleString(loc, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return f === 'usd' ? '$' + s : f === 'pct' ? s + ' %' : s;
}

export interface Choropleth { source: OverlaySource; breaks: number[]; colors: string[]; min: number; max: number; missing: number }

let serial = 0;
/** Tiles for one property: `values` maps GEOID to the number shown. A new source (new id) is made for every change of data. */
export function makeChoropleth(list: Municipio[], values: Map<string, number>, name: string): Choropleth {
  const nums = [...values.values()].filter(Number.isFinite);
  const breaks = quantileBreaks(nums, 5), colors = classColors(breaks.length + 1);
  const fill = new Map<string, string>();
  let missing = 0;
  for (const m of list) {
    const v = values.get(m.geoid);
    if (v == null || !Number.isFinite(v)) missing++; else fill.set(m.geoid, colors[classOf(v, breaks)]);
  }
  const tiles = new Map<string, HTMLCanvasElement | null>(), urls = new Map<string, string | null>();
  let hatch: CanvasPattern | null | undefined;
  const noData = (g: CanvasRenderingContext2D) => {
    if (hatch !== undefined) return hatch ?? NO_DATA;
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const h = c.getContext('2d')!;
    h.fillStyle = NO_DATA; h.fillRect(0, 0, 8, 8);
    h.strokeStyle = 'rgba(255,255,255,0.55)'; h.lineWidth = 1.2; h.beginPath(); h.moveTo(-2, 10); h.lineTo(10, -2); h.moveTo(-2, 2); h.lineTo(2, -2); h.moveTo(6, 10); h.lineTo(10, 6); h.stroke();
    return (hatch = g.createPattern(c, 'repeat')) ?? NO_DATA;
  };
  const draw = (z: number, x: number, y: number): HTMLCanvasElement | null => {
    const key = `${z}/${x}/${y}`;
    if (tiles.has(key)) return tiles.get(key)!;
    const b = tileBounds(z, x, y), padLon = (b.east - b.west) * 0.02, padLat = (b.north - b.south) * 0.02;
    let canvas: HTMLCanvasElement | null = null, g: CanvasRenderingContext2D | null = null;
    for (const m of list) {
      if (m.bbox[2] < b.west - padLon || m.bbox[0] > b.east + padLon || m.bbox[3] < b.south - padLat || m.bbox[1] > b.north + padLat) continue;
      if (!g) {
        canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
        g = canvas.getContext('2d')!;
        g.lineJoin = 'round'; g.lineWidth = z >= 11 ? 1.6 : 1.1; g.strokeStyle = 'rgba(255,255,255,0.82)';
      }
      g.beginPath();
      for (const poly of m.polys) for (const r of poly) {
        for (let i = 0; i < r.length; i += 2) {
          const px = (lonToTileX(r[i], z) - x) * 256, py = (latToTileY(r[i + 1], z) - y) * 256;
          if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.closePath();
      }
      g.fillStyle = fill.get(m.geoid) ?? noData(g);
      g.fill('evenodd');
      g.stroke();
    }
    tiles.set(key, canvas);
    return canvas;
  };
  const source: OverlaySource = {
    id: `choropleth:${name}:${++serial}`, minZoom: 8, maxZoom: 12, tileSize: 256,
    draw,
    // Terrain builds without the draw hook fetch this instead: the same canvas as a data URL.
    url(z, x, y) {
      const key = `${z}/${x}/${y}`;
      if (!urls.has(key)) { const c = draw(z, x, y); urls.set(key, c ? c.toDataURL('image/png') : null); }
      return urls.get(key)!;
    },
  };
  return { source, breaks, colors, min: nums.length ? Math.min(...nums) : NaN, max: nums.length ? Math.max(...nums) : NaN, missing };
}
