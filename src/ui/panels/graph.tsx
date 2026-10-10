// Graph: the selected object and what it is linked to, as a force-directed diagram on a canvas (d3-force).
// Neighbours are grouped by (link type, direction, object type): a municipio with 343 schools gets one "343 Schools"
// node that expands on click, so the picture stays readable. Counts come from the links themselves.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from 'd3-force';
import type { TwinStore, LinkRecord } from '../../ontology/types';
import * as S from '../../core/state';
import { tr, L } from '../../i18n/index';
import { Icon } from '../icons';
import { num } from '../format';
import { storeTick, useQuery, typeDef, linkDef, explorerType } from '../uistate';

const INLINE = 3, EXPAND = 12;
interface GNode { id: string; kind: 'focus' | 'obj' | 'group' | 'more'; label: string; type: string; color: string; r: number; verb: string; count?: number; x?: number; y?: number; fx?: number | null; fy?: number | null }
interface GLink { source: any; target: any; verb: string }

function build(focus: { id: string; name: string; type: string }, links: LinkRecord[], expanded: Set<string>) {
  const color = (ty: string) => typeDef(ty)?.color ?? '#a8c1c3';
  const nodes: GNode[] = [{ id: focus.id, kind: 'focus', label: focus.name, type: focus.type, color: color(focus.type), r: 13, verb: '' }];
  const edges: GLink[] = [];
  const groups = new Map<string, { verb: string; type: string; members: { id: string; name: string }[] }>();
  for (const l of links) {
    const out = l.src === focus.id;
    const other = out ? l.dst : l.src, oType = (out ? l.dstType : l.srcType) ?? other.slice(0, other.indexOf(':'));
    const def = linkDef(l.type);
    const key = `${l.type}|${out ? 'out' : 'in'}|${oType}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { verb: def ? L(out ? def.label : def.inverse) : l.type, type: oType, members: [] }));
    if (!g.members.some((m) => m.id === other)) g.members.push({ id: other, name: (out ? l.dstName : l.srcName) ?? other });
  }
  const seen = new Set<string>([focus.id]);
  const addObj = (m: { id: string; name: string }, type: string, verb: string, parent: string) => {
    if (!seen.has(m.id)) { seen.add(m.id); nodes.push({ id: m.id, kind: 'obj', label: m.name, type, color: color(type), r: 7, verb }); }
    edges.push({ source: parent, target: m.id, verb });
  };
  for (const [key, g] of groups) {
    if (g.members.length <= INLINE) { for (const m of g.members) addObj(m, g.type, g.verb, focus.id); continue; }
    const gid = 'group:' + key, ty = typeDef(g.type);
    nodes.push({ id: gid, kind: 'group', label: ty ? L(ty.plural) : g.type, type: g.type, color: color(g.type), r: 11 + 2.2 * String(g.members.length).length, verb: g.verb, count: g.members.length });
    edges.push({ source: focus.id, target: gid, verb: g.verb });
    if (!expanded.has(key)) continue;
    for (const m of g.members.slice(0, EXPAND)) addObj(m, g.type, g.verb, gid);
    if (g.members.length > EXPAND) {
      const mid = 'more:' + key;
      nodes.push({ id: mid, kind: 'more', label: `+${num(g.members.length - EXPAND)} ${tr('more in Explorer', 'más en Explorador')}`, type: g.type, color: '#6d8b90', r: 9, verb: g.verb });
      edges.push({ source: gid, target: mid, verb: g.verb });
    }
  }
  return { nodes, edges };
}

export function GraphPanel({ store }: { store: TwinStore }) {
  const id = S.selectedId.value;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<GNode | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pos = useRef(new Map<string, { x: number; y: number; fx?: number | null; fy?: number | null }>());
  const view = useRef({ k: 1, tx: 0, ty: 0 });
  const touched = useRef(false);          // once the user pans or zooms, stop auto-fitting
  const live = useRef<{ nodes: GNode[]; edges: GLink[]; sim: any; hover: GNode | null; draw: () => void } | null>(null);
  useEffect(() => { setExpanded(new Set()); pos.current.clear(); view.current = { k: 1, tx: 0, ty: 0 }; touched.current = false; }, [id]);

  const data = useQuery(async () => {
    if (!id) return null;
    const [o, links] = await Promise.all([store.getObject(id), store.getLinks(id, { direction: 'both', limit: 5000 })]);
    return o ? { id, focus: { id: o.id, name: o.name || o.key, type: o.type }, links } : { id, focus: null, links: [] as LinkRecord[] };
  }, [id, storeTick.value]);
  const model = useMemo(() => (data?.focus && data.id === id ? build(data.focus, data.links, expanded) : null), [data, expanded, S.lang.value]);

  useEffect(() => {
    const cv = canvas.current, box = wrap.current;
    if (!cv || !box || !model) return;
    const ctx = cv.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let W = 0, Hh = 0, ay = 1;      // ay stretches the layout vertically in a tall pane: labels are wide and short
    const nodes = model.nodes.map((n) => ({ ...n, ...(pos.current.get(n.id) ?? {}) }));
    const edges = model.edges.map((e) => ({ ...e }));
    const focus = nodes[0]; if (focus.fx == null) { focus.fx = 0; focus.fy = 0; }
    const toScreen = (x: number, y: number) => [W / 2 + view.current.tx + x * view.current.k, Hh / 2 + view.current.ty + y * ay * view.current.k];
    const toWorld = (sx: number, sy: number) => [(sx - W / 2 - view.current.tx) / view.current.k, (sy - Hh / 2 - view.current.ty) / (view.current.k * ay)];
    const state = { nodes, edges, sim: null as any, hover: null as GNode | null, draw: () => {} };
    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, Hh);
      const k = view.current.k, h = state.hover;
      ctx.lineWidth = 1;
      for (const e of edges) {
        const [x1, y1] = toScreen(e.source.x, e.source.y), [x2, y2] = toScreen(e.target.x, e.target.y);
        const hot = h && (e.target === h || e.source === h);
        ctx.strokeStyle = hot ? '#ff6a3d' : 'rgba(190,232,236,0.2)'; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        if (hot && e.target === h) {
          ctx.font = "500 10.5px 'Archivo Variable', sans-serif"; const tw = ctx.measureText(e.verb).width, mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
          ctx.fillStyle = '#06161f'; ctx.fillRect(mx - tw / 2 - 4, my - 8, tw + 8, 16); ctx.fillStyle = '#ffb49c'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(e.verb, mx, my);
        }
      }
      for (const n of nodes) {
        const [x, y] = toScreen(n.x ?? 0, n.y ?? 0), r = n.r * Math.max(0.7, Math.min(1.4, k));
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.kind === 'group' ? '#0a1b24' : n.color; ctx.globalAlpha = n.kind === 'more' ? 0.5 : 1; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = n.kind === 'focus' || n === h ? 2.5 : 1.5; ctx.strokeStyle = n.kind === 'focus' || n === h ? '#ff6a3d' : n.kind === 'group' ? n.color : '#06161f';
        if (n.kind === 'more') ctx.setLineDash([3, 2]); ctx.stroke(); ctx.setLineDash([]);
        if (n.kind === 'group') { ctx.font = "500 10.5px 'IBM Plex Mono', monospace"; ctx.fillStyle = '#e9f2ef'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(num(n.count), x, y + 0.5); }
        if (n.fx != null && n.kind !== 'focus') { ctx.fillStyle = '#e9f2ef'; ctx.fillRect(x + r - 2, y - r - 2, 4, 4); }       // pinned
        if (n.kind !== 'obj' || n === h || k > 1.6 || nodes.length <= 14 || (h && edges.some((e) => e.source === h && e.target === n))) {
          const text = n.label.length > 22 && n !== h ? n.label.slice(0, 21) + '…' : n.label;
          ctx.font = `${n.kind === 'focus' ? 650 : n.kind === 'group' ? 600 : 400} ${n.kind === 'focus' ? 12.5 : 11}px 'Archivo Variable', sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(6,22,31,0.9)'; ctx.strokeText(text, x, y + r + 3);
          ctx.fillStyle = n.kind === 'obj' && n !== h ? '#a8c1c3' : '#e9f2ef'; ctx.fillText(text, x, y + r + 3);
        }
      }
    };
    const fit = () => {
      if (touched.current || !W) return;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const n of nodes) { x0 = Math.min(x0, n.x ?? 0); x1 = Math.max(x1, n.x ?? 0); y0 = Math.min(y0, n.y ?? 0); y1 = Math.max(y1, n.y ?? 0); }
      const k = Math.max(0.5, Math.min(1.15, (W - 170) / Math.max(60, x1 - x0), (Hh - 90) / Math.max(60, (y1 - y0) * ay)));
      view.current = { k, tx: -((x0 + x1) / 2) * k, ty: -((y0 + y1) / 2) * ay * k };
    };
    state.draw = draw;
    const resize = () => { W = box.clientWidth; Hh = box.clientHeight; ay = Math.max(1, Math.min(1.9, Hh / Math.max(1, W))); cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr); cv.style.width = W + 'px'; cv.style.height = Hh + 'px'; draw(); };
    // Labels are wide and short, so circles are the wrong collision shape for them: nudge labelled nodes apart
    // vertically whenever their label boxes would overlap on screen.
    const labelled = nodes.filter((n) => n.kind !== 'obj' || nodes.length <= 14);
    const lw = (n: GNode) => Math.min(22, n.label.length) * 6.4 + 10;
    const labelForce = (alpha: number) => {
      for (let i = 0; i < labelled.length; i++) for (let j = i + 1; j < labelled.length; j++) {
        const a: any = labelled[i], b: any = labelled[j];
        const dx = b.x - a.x, dy = (b.y - a.y) * ay, need = a.r + b.r + 22;
        if (Math.abs(dx) >= (lw(a) + lw(b)) / 2 || Math.abs(dy) >= need) continue;
        void alpha;      // not scaled by alpha: the other forces fade as the layout cools, this one must still win
        const s = ((need - Math.abs(dy)) / ay) * 0.3, sg = dy >= 0 ? 1 : -1;
        a.vy -= sg * s; b.vy += sg * s;
      }
    };
    const sim = forceSimulation(nodes as any)
      .force('link', forceLink(edges as any).id((d: any) => d.id).distance((e: any) => (e.source.kind === 'group' ? 52 : e.target.kind === 'group' ? 118 : 66)).strength(0.6))
      .force('charge', forceManyBody().strength(-420).distanceMax(420))
      .force('collide', forceCollide().radius((d: any) => d.r + (d.kind === 'obj' ? 9 : 30)))
      .force('labels', labelForce as any)
      .force('x', forceX(0).strength(0.07)).force('y', forceY(0).strength(0.07))
      .on('tick', () => { for (const n of nodes) pos.current.set(n.id, { x: n.x!, y: n.y!, fx: n.fx, fy: n.fy }); fit(); draw(); });
    state.sim = sim; live.current = state;
    const dbg = (globalThis as any).__garita; if (dbg) dbg.graph = { nodes, toScreen: (n: GNode) => { const r = cv.getBoundingClientRect(), [x, y] = toScreen(n.x ?? 0, n.y ?? 0); return [r.left + x, r.top + y]; } };   // for automated checks
    const ro = new ResizeObserver(resize); ro.observe(box); resize();

    const hit = (sx: number, sy: number) => { for (let i = nodes.length - 1; i >= 0; i--) { const [x, y] = toScreen(nodes[i].x ?? 0, nodes[i].y ?? 0); if (Math.hypot(sx - x, sy - y) <= nodes[i].r + 5) return nodes[i]; } return null; };
    let drag: GNode | null = null, pan: { x: number; y: number } | null = null, moved = false;
    const at = (e: PointerEvent | WheelEvent) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const down = (e: PointerEvent) => { const [sx, sy] = at(e); drag = hit(sx, sy); pan = drag ? null : { x: e.clientX, y: e.clientY }; moved = false; cv.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => {
      const [sx, sy] = at(e);
      if (drag) { const [wx, wy] = toWorld(sx, sy); if (!moved && Math.hypot(wx - (drag.x ?? 0), wy - (drag.y ?? 0)) < 3) return; moved = true; drag.fx = wx; drag.fy = wy; sim.alphaTarget(0.25).restart(); }
      else if (pan) { view.current.tx += e.clientX - pan.x; view.current.ty += e.clientY - pan.y; pan = { x: e.clientX, y: e.clientY }; moved = true; touched.current = true; draw(); }
      else { const h = hit(sx, sy); if (h !== state.hover) { state.hover = h; setHover(h); cv.style.cursor = h ? 'pointer' : 'grab'; draw(); } }
    };
    const up = () => {
      const n = drag; drag = null; pan = null; sim.alphaTarget(0);
      if (!n || moved) return;
      if (n.kind === 'obj') S.selectedId.value = n.id;                                   // stay on the graph and re-centre
      else if (n.kind === 'focus') S.select(n.id, { fly: true });
      else if (n.kind === 'group') { const key = n.id.slice(6); setExpanded((s) => { const x = new Set(s); if (x.has(key)) x.delete(key); else x.add(key); return x; }); }
      else if (n.kind === 'more') { explorerType.value = n.type; S.rightPanel.value = 'explorer'; }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); touched.current = true; const [sx, sy] = at(e), [wx, wy] = toWorld(sx, sy);
      view.current.k = Math.max(0.3, Math.min(4, view.current.k * Math.exp(-e.deltaY * 0.0015)));
      view.current.tx = sx - W / 2 - wx * view.current.k; view.current.ty = sy - Hh / 2 - wy * view.current.k; draw();
    };
    const leave = () => { if (state.hover) { state.hover = null; setHover(null); draw(); } };
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', leave); cv.addEventListener('wheel', wheel, { passive: false });
    return () => { sim.stop(); ro.disconnect(); cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up); cv.removeEventListener('pointerleave', leave); cv.removeEventListener('wheel', wheel); };
  }, [model]);

  if (!id) return <div class="pane is-blank"><div class="blank"><Icon name="graph" size={28} /><h2>{tr('Nothing selected', 'Nada seleccionado')}</h2><p>{tr('Select an object to see what it is linked to.', 'Selecciona un objeto para ver con qué está vinculado.')}</p></div></div>;
  const ty = data?.focus ? typeDef(data.focus.type) : undefined;
  return (
    <div class="pane graph">
      <header class="pane-head">
        <div class="gr-title">
          <span class="label">{ty ? L(ty.label) : ''} · {data ? num(data.links.length) : '—'} {tr('links', 'vínculos')}</span>
          <h2>{data?.focus?.name ?? (data ? tr('This object is no longer in the store.', 'Este objeto ya no está en la base de datos.') : '…')}</h2>
        </div>
        <button class="btn" onClick={() => { S.rightPanel.value = 'object'; }}><Icon name="object" size={14} />{tr('Details', 'Detalles')}</button>
      </header>
      <div class="gr-wrap" ref={wrap}>
        <canvas ref={canvas} aria-label={tr('Link diagram', 'Diagrama de vínculos')} />
        {data?.focus && data.links.length === 0 && <p class="muted gr-empty">{tr('No links recorded for this object.', 'No hay vínculos registrados para este objeto.')}</p>}
      </div>
      <footer class="gr-foot">
        {hover ? <span><b>{hover.label}</b>{hover.verb ? <i> · {data?.focus?.name} {hover.verb}</i> : null}{hover.kind === 'group' ? <i> · {tr('click to expand or fold', 'clic para abrir o cerrar')}</i> : null}</span>
          : <span class="muted">{tr('Click a node to go there · click a count to expand · drag to pin · wheel to zoom', 'Clic en un nodo para ir · clic en un conteo para abrir · arrastra para fijar · rueda para acercar')}</span>}
      </footer>
    </div>
  );
}
