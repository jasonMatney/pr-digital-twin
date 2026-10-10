// Place names drawn on the marker canvas: municipio names from the store (name + interior point), most populous
// first, more as the camera descends, greedy collision avoidance, fading out where street-scale detail takes over.
import * as S from '../core/state';
import { curveDrop, lonLatToXZ } from '../core/geo';
import type { TwinStore } from '../ontology/types';
import type { World } from './types';
import { smooth, type OccPt, type View } from './markers/view';

interface Place extends OccPt { name: string; text: string; x: number; z: number; h: number; hStamp: number; pop: number; tw: number; a: number }

export const LABEL_FONT = "600 condensed 11px 'Archivo Variable', 'Archivo', system-ui, sans-serif";
const LABEL_FONT_L = "650 condensed 12.5px 'Archivo Variable', 'Archivo', system-ui, sans-serif";
export const NAME_FONT = "600 condensed 12.5px 'Archivo Variable', 'Archivo', system-ui, sans-serif";

export function setSpacing(g: CanvasRenderingContext2D, px: number) { if ('letterSpacing' in g) (g as any).letterSpacing = px + 'px'; }

/** Text with a dark halo. The caller sets font, alignment and baseline. */
export function haloText(g: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, halo = 'rgba(3,11,16,0.86)', width = 3.2) {
  g.lineJoin = 'round'; g.lineWidth = width; g.strokeStyle = halo; g.strokeText(text, x, y);
  g.fillStyle = fill; g.fillText(text, x, y);
}

export function createLabels(world: World, store: TwinStore, onData: () => void) {
  let places: Place[] = [];
  let measured = false;
  const boxes = new Float32Array(4 * 96);
  let drawn = 0;

  const load = async () => {
    const rows = await store.listObjects('municipio', { limit: 200, props: ['population'] });
    places = rows.filter((r) => r.lon != null && r.lat != null).map((r) => {
      const [x, z] = lonLatToXZ(r.lon!, r.lat!);
      return { name: r.name, text: r.name.toUpperCase(), x, z, h: 0, hStamp: -1, pop: +(r.props?.population ?? 0) || 0, tw: 0, a: 0, wx: x, wy: 0, wz: z, dist: 0, vis: 1, occ: false, occStamp: -1 };
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
    draw(g: CanvasRenderingContext2D, view: View, range: number, terrainStamp: number, dt: number): boolean {
      drawn = 0;
      const fade = smooth(4500, 8000, range);
      if (fade <= 0.01 || !places.length) return false;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if (!measured) {
        g.font = LABEL_FONT; setSpacing(g, 1.3);
        for (const p of places) p.tw = g.measureText(p.text).width;
        measured = true;
      }
      // How many names the view can carry: 8 from orbit, all 78 once a region fills the screen.
      const n = range > 320000 ? 6 : range > 200000 ? 12 : range > 120000 ? 22 : range > 70000 ? 40 : places.length;
      const big = range > 120000 ? 6 : 12;
      let nb = 0, busy = false;
      for (let i = 0; i < places.length; i++) {
        const p = places[i];
        let want = i < n;
        let sx = 0, sy = 0;
        if (want) {
          if (p.hStamp !== terrainStamp) { p.h = Math.max(world.terrain.heightAt(p.x, p.z) ?? 0, world.seaLevel); p.hStamp = terrainStamp; p.wy = p.h - curveDrop(p.x, p.z); }
          want = view.project(p.wx, p.wy, p.wz) && view.sx > -20 && view.sx < view.w + 20 && view.sy > 10 && view.sy < view.h + 10;
          sx = view.sx; sy = view.sy;
          if (want) {
            const ex = p.wx - view.cx, ey = p.wy - view.cy, ez = p.wz - view.cz;
            p.dist = Math.sqrt(ex * ex + ey * ey + ez * ez);
            want = view.occlude(p, dt) > 0.02;
          }
        }
        if (want) {
          const scale = i < big ? 1.14 : 1;
          const hw = p.tw * scale / 2 + 5, hh = 8;
          for (let k = 0; k < nb; k++) {
            const b = k * 4;
            if (sx - hw < boxes[b + 2] && sx + hw > boxes[b] && sy - hh < boxes[b + 3] && sy + hh > boxes[b + 1]) { want = false; break; }
          }
          if (want && nb < 96) { const b = nb++ * 4; boxes[b] = sx - hw; boxes[b + 1] = sy - hh; boxes[b + 2] = sx + hw; boxes[b + 3] = sy + hh; }
        }
        // Ease in and out so names do not blink as the collision order changes.
        const target = want ? 1 : 0;
        if (p.a !== target) { p.a = target > p.a ? Math.min(1, p.a + dt * 4) : Math.max(0, p.a - dt * 6); if (p.a !== target) busy = true; }
        if (!want || p.a <= 0.01) continue;
        g.globalAlpha = p.a * p.vis * fade * 0.94;
        g.font = i < big ? LABEL_FONT_L : LABEL_FONT;
        setSpacing(g, i < big ? 1.6 : 1.3);
        haloText(g, p.text, sx, sy, '#eef5f2');
        drawn++;
      }
      g.globalAlpha = 1; setSpacing(g, 0);
      return busy;
    },
  };
}
