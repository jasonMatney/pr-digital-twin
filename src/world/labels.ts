// Place names drawn on the marker canvas: municipio names (most populous first, more as the camera descends,
// greedy collision avoidance, fading out where street-scale detail takes over) and, from orbit, the names of the seas.
import * as S from '../core/state';
import { curveDrop, lonLatToXZ } from '../core/geo';
import type { TwinStore } from '../ontology/types';
import type { World } from './types';
import { loadMunicipios } from './choropleth';
import { smooth, type OccPt, type View } from './markers/view';

interface Place extends OccPt { key: string; text: string; x: number; z: number; h: number; hStamp: number; pop: number; tw: number; a: number; k: number; sx: number; sy: number; big: boolean }
interface Sea { en: string; es: string; x: number; z: number; min: number; max: number; a: number }

export const LABEL_FONT = "600 condensed 11px 'Archivo Variable', 'Archivo', system-ui, sans-serif";
const LABEL_FONT_L = "650 condensed 12.5px 'Archivo Variable', 'Archivo', system-ui, sans-serif";
const SEA_FONT = "italic 400 12px 'Archivo Variable', 'Archivo', system-ui, sans-serif";
export const NAME_FONT = "600 condensed 12.5px 'Archivo Variable', 'Archivo', system-ui, sans-serif";

export function setSpacing(g: CanvasRenderingContext2D, px: number) { if ('letterSpacing' in g) (g as any).letterSpacing = px + 'px'; }

/** Text with a dark halo. The caller sets font, alignment and baseline. */
export function haloText(g: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, halo = 'rgba(3,11,16,0.86)', width = 3.2) {
  g.lineJoin = 'round'; g.lineWidth = width; g.strokeStyle = halo; g.strokeText(text, x, y);
  g.fillStyle = fill; g.fillText(text, x, y);
}

/** Area-weighted centroid of a flat [lon, lat, ...] ring and its (signed) area, in degrees. */
function ringCentroid(r: Float64Array): [number, number, number] {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const f = r[j] * r[i + 1] - r[i] * r[j + 1];
    a += f; cx += (r[j] + r[i]) * f; cy += (r[j + 1] + r[i + 1]) * f;
  }
  return a === 0 ? [r[0], r[1], 0] : [cx / (3 * a), cy / (3 * a), Math.abs(a / 2)];
}
function inRing(r: Float64Array, lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const yi = r[i + 1], yj = r[j + 1];
    if ((yi > lat) !== (yj > lat) && lon < ((r[j] - r[i]) * (lat - yi)) / (yj - yi) + r[i]) inside = !inside;
  }
  return inside;
}
/** Where a municipio's name goes: the centroid of its largest land polygon (the Census interior point of
 *  Mayagüez is out by Mona Island); if that falls outside a concave shape, the middle of the widest span on its latitude. */
function labelPoint(polys: Float64Array[][]): [number, number] | null {
  let best: Float64Array | null = null, bestC: [number, number, number] = [0, 0, 0];
  for (const poly of polys) { const c = ringCentroid(poly[0]); if (c[2] > bestC[2]) { bestC = c; best = poly[0]; } }
  if (!best) return null;
  let [lon, lat] = bestC;
  if (!inRing(best, lon, lat)) {
    const xs: number[] = [];
    for (let i = 0, j = best.length - 2; i < best.length; j = i, i += 2) {
      const yi = best[i + 1], yj = best[j + 1];
      if ((yi > lat) !== (yj > lat)) xs.push(((best[j] - best[i]) * (lat - yi)) / (yj - yi) + best[i]);
    }
    xs.sort((a, b) => a - b);
    let w = 0;
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > w) { w = xs[i + 1] - xs[i]; lon = (xs[i] + xs[i + 1]) / 2; }
  }
  return [lon, lat];
}

// Name, Spanish name, lon, lat, and the camera ranges (m) between which the name is shown.
const SEAS: [string, string, number, number, number, number][] = [
  ['ATLANTIC OCEAN', 'OCÉANO ATLÁNTICO', -66.45, 19.12, 230000, 1e9],
  ['CARIBBEAN SEA', 'MAR CARIBE', -66.45, 17.5, 230000, 1e9],
  ['MONA PASSAGE', 'CANAL DE LA MONA', -67.6, 18.42, 150000, 1e9],
  ['VIEQUES SOUND', 'SONDA DE VIEQUES', -65.47, 18.24, 50000, 220000],
];

export function createLabels(world: World, store: TwinStore, onData: () => void) {
  let places: Place[] = [];
  let measured = false;
  const boxes = new Float32Array(4 * 96);
  let drawn = 0;
  const seas: Sea[] = SEAS.map(([en, es, lon, lat, min, max]) => { const [x, z] = lonLatToXZ(lon, lat); return { en, es, x, z, min, max, a: 0 }; });

  const load = async () => {
    const rows = await store.listObjects('municipio', { limit: 200, props: ['population'] });
    const land = await loadMunicipios().catch(() => []);
    const pts = new Map<string, [number, number]>();
    for (const m of land) { const p = labelPoint(m.polys); if (p) pts.set(m.geoid, p); }
    places = rows.filter((r) => r.lon != null && r.lat != null).map((r) => {
      const at = pts.get(r.key) ?? [r.lon!, r.lat!];
      const [x, z] = lonLatToXZ(at[0], at[1]);
      return { key: r.key, text: r.name.toUpperCase(), x, z, h: 0, hStamp: -1, pop: +(r.props?.population ?? 0) || 0, tw: 0, a: 0, k: 1, sx: 0, sy: 0, big: false, wx: x, wy: 0, wz: z, dist: 0, vis: 1, occ: false, occStamp: -1 };
    }).sort((a, b) => b.pop - a.pop);
    measured = false;
    onData();
  };
  load().catch((e) => console.error('[garita] labels: municipios failed to load', e));
  // The condensed face arrives with the UI's stylesheet; widths measured before it loads would be wrong.
  (document as any).fonts?.load?.(LABEL_FONT).then(() => { measured = false; onData(); }).catch(() => {});
  (document as any).fonts?.ready?.then(() => { measured = false; onData(); });

  return {
    count: () => places.length,
    drawn: () => drawn,
    /** Draws the labels; returns true when a fade is still running. */
    draw(g: CanvasRenderingContext2D, view: View, range: number, terrainStamp: number, dt: number, noOcc: boolean): boolean {
      drawn = 0;
      let busy = false;
      g.textAlign = 'center'; g.textBaseline = 'middle';

      // ---- seas: orbit only, quiet ----
      const es = S.lang.value === 'es';
      for (let i = 0; i < seas.length; i++) {
        const s = seas[i];
        const want = range > s.min && range < s.max && view.project(s.x, world.seaLevel - curveDrop(s.x, s.z), s.z) && view.sx > 60 && view.sx < view.w - 60 && view.sy > 30 && view.sy < view.h - 30;
        const target = want ? 1 : 0;
        if (s.a !== target) { s.a = target > s.a ? Math.min(1, s.a + dt * 2) : Math.max(0, s.a - dt * 3); if (s.a !== target) busy = true; }
        if (!want || s.a <= 0.01) continue;
        g.globalAlpha = s.a * 0.5;
        g.font = SEA_FONT; setSpacing(g, 4.5);
        haloText(g, es ? s.es : s.en, view.sx, view.sy, '#cfe3ea', 'rgba(3,11,16,0.35)', 2);
      }

      const fade = smooth(4500, 8000, range);
      if (fade <= 0.01 || !places.length) { g.globalAlpha = 1; setSpacing(g, 0); return busy; }
      if (!measured) {
        g.font = LABEL_FONT; setSpacing(g, 1.3);
        for (const p of places) p.tw = g.measureText(p.text).width;
        measured = true;
      }
      // How many names the view can carry: a handful from orbit, all 78 once a region fills the screen.
      const n = range > 320000 ? 6 : range > 200000 ? 12 : range > 120000 ? 22 : range > 70000 ? 40 : places.length;
      const big = range > 120000 ? 6 : 12;
      let nb = 0;
      for (let i = 0; i < places.length; i++) {
        const p = places[i];
        let want = i < n;
        if (want) {
          if (p.hStamp !== terrainStamp) { p.h = Math.max(world.terrain.heightAt(p.x, p.z) ?? 0, world.seaLevel); p.hStamp = terrainStamp; p.wy = p.h - curveDrop(p.x, p.z); }
          want = view.project(p.wx, p.wy, p.wz) && view.sx > -20 && view.sx < view.w + 20 && view.sy > 10 && view.sy < view.h + 10;
          if (want) {
            p.sx = view.sx; p.sy = view.sy; p.dist = view.depth; p.big = i < big;
            // Names far beyond what the camera is looking at would stack up along the skyline.
            const df = 1 - smooth(4, 11, p.dist / range);
            if (noOcc) { p.vis = 1; p.occ = false; p.occStamp = -1; } else view.occlude(p, dt);
            want = df * p.vis > 0.03;
            if (want) {
              const hw = p.tw * (p.big ? 1.14 : 1) / 2 + 5, hh = 8;
              for (let k = 0; k < nb; k++) {
                const b = k * 4;
                if (p.sx - hw < boxes[b + 2] && p.sx + hw > boxes[b] && p.sy - hh < boxes[b + 3] && p.sy + hh > boxes[b + 1]) { want = false; break; }
              }
              if (want && nb < 96) { const b = nb++ * 4; boxes[b] = p.sx - hw; boxes[b + 1] = p.sy - hh; boxes[b + 2] = p.sx + hw; boxes[b + 3] = p.sy + hh; }
            }
            if (want) p.k = df * p.vis;
          }
        }
        // Ease in and out so names do not blink as the collision order changes.
        const target = want ? 1 : 0;
        if (p.a !== target) { p.a = target > p.a ? Math.min(1, p.a + dt * 4) : Math.max(0, p.a - dt * 4); if (p.a !== target) busy = true; }
        if (p.a <= 0.01) continue;
        g.globalAlpha = p.a * p.k * fade * 0.94;
        g.font = p.big ? LABEL_FONT_L : LABEL_FONT;
        setSpacing(g, p.big ? 1.6 : 1.3);
        haloText(g, p.text, p.sx, p.sy, '#eef5f2');
        drawn++;
      }
      g.globalAlpha = 1; setSpacing(g, 0);
      return busy;
    },
  };
}
