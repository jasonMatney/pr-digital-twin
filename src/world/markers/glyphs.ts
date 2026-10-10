// Map glyphs: the UI icon set (src/ui/icons.tsx, 16-unit grid) mirrored as plain path data so the pins on the
// map and the chips in the panels show the same marks, pre-rendered into one sprite atlas.
export type Shape = string | { c: [number, number, number]; fill?: boolean } | { r: [number, number, number, number, number] };

export const ICONS: Record<string, Shape[]> = {
  bolt: ['M9 1.8 3.8 9H8l-1 5.2L12.2 7H8z'],
  shelter: ['M1.8 8.2 8 2.5l6.2 5.7', 'M3.6 7v6.4h8.8V7', 'M6.6 13.4V9.6h2.8v3.8'],
  housing: ['M2.5 13.5v-9h5v9', 'M7.5 7h6v6.5', 'M1.5 13.5h13', 'M4.4 6.7h1.2M4.4 9.2h1.2M9.9 9.4h1.2'],
  hospital: [{ r: [2.5, 2.5, 11, 11, 1] }, 'M8 5.2v5.6M5.2 8h5.6'],
  school: ['M1.5 6.2 8 3l6.5 3.2L8 9.4z', 'M4.2 7.8v3.1c1 .9 2.3 1.4 3.8 1.4s2.8-.5 3.8-1.4V7.8', 'M14.5 6.2v3.6'],
  fire: ['M8 1.8c.4 2.4 3.8 4 3.8 7.3A3.8 3.8 0 0 1 8 13.9a3.8 3.8 0 0 1-3.8-3.8c0-1.4.7-2.4 1.6-3.2.2 1.1.8 1.7 1.4 1.9C6.9 6.6 7 4.2 8 1.8z'],
  police: ['M8 1.8 13 3.6v4.2c0 3-2 5.2-5 6.4-3-1.2-5-3.4-5-6.4V3.6z', 'm6 7.9 1.5 1.5L10.2 6.6'],
  drop: ['M8 1.9c2.3 3 4.2 5.2 4.2 7.7A4.2 4.2 0 0 1 8 13.9a4.2 4.2 0 0 1-4.2-4.3C3.8 7.1 5.7 4.9 8 1.9z'],
  plane: ['M8 1.6c.7 0 1.1.9 1.1 2.2v2.3l5 3v1.5l-5-1.5v2.8l1.6 1.2v1.2L8 13.6l-2.7.7v-1.2l1.6-1.2V9.1l-5 1.5V9.1l5-3V3.8c0-1.3.4-2.2 1.1-2.2z'],
  anchor: [{ c: [8, 3.4, 1.5] }, 'M8 4.9v9', 'M5.4 7.4h5.2', 'M2.6 9.8c.3 2.4 2.5 4.1 5.4 4.1s5.1-1.7 5.4-4.1'],
  gauge: ['M4.5 1.8v12.4', 'M4.5 3.2h2.4M4.5 5.8h1.5M4.5 8.4h2.4M4.5 11h1.5', 'M8.3 12.2c.9-.8 1.8-.8 2.7 0s1.8.8 2.7 0', 'M8.3 9.4c.9-.8 1.8-.8 2.7 0s1.8.8 2.7 0'],
  wave: ['M1.5 6c1.1-1.2 2.2-1.2 3.3 0s2.1 1.2 3.2 0 2.2-1.2 3.3 0 2.1 1.2 3.2 0', 'M1.5 10.4c1.1-1.2 2.2-1.2 3.3 0s2.1 1.2 3.2 0 2.2-1.2 3.3 0 2.1 1.2 3.2 0'],
  buoy: ['M8 1.6v3', 'M6.3 2.6h3.4', 'M5.6 4.6h4.8l1.4 6H4.2z', 'M1.5 12.800c1.1-.9 2.2-.9 3.3 0s2.1.9 3.2 0 2.2-.9 3.3 0 2.1.9 3.2 0'],
  wind: ['M1.8 5.8h7.4a1.9 1.9 0 1 0-1.9-1.9', 'M1.8 8.4h10.6a1.9 1.9 0 1 1-1.9 1.9', 'M1.8 11h4.6'],
  alert: ['M8 2.2 14.3 13H1.7z', 'M8 6.4v3.2', { c: [8, 11.2, 0.7], fill: true }],
  quake: ['M1.3 8.4h2.3l1.2-3.6 1.9 7.6 2-10 1.7 8.2 1.2-2.2h3.1'],
  cyclone: [{ c: [8, 8, 1.7] }, 'M8 3.6c2.6 0 4.6 1.8 4.6 4.2', 'M8 12.4c-2.6 0-4.6-1.8-4.6-4.2', 'M12.6 7.8c1.2-.9 1.8-2.4 1.6-4.4', 'M3.4 8.2c-1.2.9-1.8 2.4-1.6 4.4'],
  dot: [{ c: [8, 8, 2.5], fill: true }],
};

export const INK = '#07161d';
export const SEV = ['#7fa0a6', '#f0e27a', '#f5b31b', '#ff7a3d', '#ff3b5c'];   // mirrors --sev-0..4 in ui/tokens.css
export const ACCENT = '#ff6a3d';

/** Strokes an icon in the current stroke style, centred on (cx, cy), `size` CSS px across. */
export function strokeIcon(g: CanvasRenderingContext2D, name: string, cx: number, cy: number, size: number, width = 1.7) {
  const shapes = ICONS[name] ?? ICONS.dot;
  const s = size / 16;
  g.save();
  g.translate(cx - size / 2, cy - size / 2);
  g.scale(s, s);
  g.lineWidth = width; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const sh of shapes) {
    if (typeof sh === 'string') g.stroke(new Path2D(sh));
    else if ('c' in sh) { g.beginPath(); g.arc(sh.c[0], sh.c[1], sh.c[2], 0, 6.2832); if (sh.fill) { g.fillStyle = g.strokeStyle; g.fill(); } else g.stroke(); }
    else { g.beginPath(); (g as any).roundRect ? (g as any).roundRect(sh.r[0], sh.r[1], sh.r[2], sh.r[3], sh.r[4]) : g.rect(sh.r[0], sh.r[1], sh.r[2], sh.r[3]); g.stroke(); }
  }
  g.restore();
}

/** Sprite cell and disc radius, CSS px. */
export const CELL = 36, DISC_R = 10.5;

export interface Atlas { canvas: HTMLCanvasElement; dpr: number; pill(n: number): HTMLCanvasElement }

/** One cell per type: filled disc in the type colour, dark outline, soft shadow, icon in dark ink. */
export function buildAtlas(types: { icon: string; color: string }[], dpr: number): Atlas {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(CELL * types.length * dpr); canvas.height = Math.ceil(CELL * dpr);
  const g = canvas.getContext('2d')!;
  g.scale(dpr, dpr);
  types.forEach((t, i) => {
    const cx = i * CELL + CELL / 2, cy = CELL / 2;
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 4 * dpr; g.shadowOffsetY = 1.5 * dpr;
    g.fillStyle = t.color; g.beginPath(); g.arc(cx, cy, DISC_R, 0, 6.2832); g.fill();
    g.restore();
    g.strokeStyle = 'rgba(4,14,19,0.92)'; g.lineWidth = 1.3; g.beginPath(); g.arc(cx, cy, DISC_R + 0.4, 0, 6.2832); g.stroke();
    g.strokeStyle = INK;
    strokeIcon(g, t.icon, cx, cy, 14);
  });
  // Count pills for cluster badges, made the first time a count is seen.
  const pills = new Map<number, HTMLCanvasElement>();
  const pill = (n: number) => {
    let c = pills.get(n);
    if (c) return c;
    const text = n > 999 ? Math.round(n / 100) / 10 + 'k' : String(n);
    const w = 9 + text.length * 6.2, h = 14;
    c = document.createElement('canvas');
    c.width = Math.ceil((w + 2) * dpr); c.height = Math.ceil((h + 2) * dpr);
    (c as any)._w = w + 2; (c as any)._h = h + 2;
    const p = c.getContext('2d')!;
    p.scale(dpr, dpr);
    p.fillStyle = 'rgba(6,18,24,0.94)'; p.strokeStyle = 'rgba(233,242,239,0.85)'; p.lineWidth = 1;
    p.beginPath();
    (p as any).roundRect ? (p as any).roundRect(1, 1, w, h, h / 2) : p.rect(1, 1, w, h);
    p.fill(); p.stroke();
    p.fillStyle = '#f2f7f5'; p.font = "700 10.5px 'IBM Plex Mono', ui-monospace, Menlo, monospace"; p.textAlign = 'center'; p.textBaseline = 'middle';
    p.fillText(text, 1 + w / 2, 1 + h / 2 + 0.5);
    pills.set(n, c);
    return c;
  };
  return { canvas, dpr, pill };
}
