// Hover tooltip (follows S.pointerPx) and the legend card for the active overlay (S.overlayLegend).
import type { TwinStore, ObjectRecord } from '../ontology/types';
import * as S from '../core/state';
import { L, t } from '../i18n/index';
import { Icon } from './icons';
import { formatProp, ago } from './format';
import { useQuery, typeDef, storeTick, aircraftFixAt } from './uistate';

const cache = new Map<string, ObjectRecord | null>();
let cacheTick = -1;      // live values change: drop the cache whenever the store reports a change

export function HoverTip({ store }: { store: TwinStore }) {
  const p = S.pointerPx.value, id = S.hoveredId.value, text = S.hoverText.value;
  const o = useQuery(async () => {
    if (!id) return null;
    if (cacheTick !== storeTick.peek()) { cache.clear(); cacheTick = storeTick.peek(); }
    if (!cache.has(id)) { if (cache.size > 300) cache.clear(); cache.set(id, await store.getObject(id).catch(() => null)); }
    return cache.get(id) ?? null;
  }, [id]);
  if (!p || (!id && !text)) return null;
  const ty = o && o.id === id ? typeDef(o.type) : undefined;
  const facts = o && o.id === id && ty ? ty.properties.filter((d) => d.primary && d.type !== 'json' && o.props?.[d.id] != null).slice(0, 2) : [];
  // Aircraft positions are relayed: the tip always says how old this one is.
  const fixAt = o && o.id === id ? aircraftFixAt(o) : null;
  const flip = p.x > window.innerWidth - S.viewPadding.peek().right - 280, up = p.y > window.innerHeight - 170;
  return (
    <div class="hovertip panel" style={{ left: `${p.x}px`, top: `${p.y}px`, transform: `translate(${flip ? 'calc(-100% - 14px)' : '14px'}, ${up ? 'calc(-100% - 14px)' : '14px'})` }}>
      {o && o.id === id && ty ? (
        <>
          <div class="hovertip-head"><span class="type-badge sm" style={{ '--c': ty.color } as any}><Icon name={ty.icon} size={12} /></span><b>{o.name || o.key}</b></div>
          <span class="label">{L(ty.label)}</span>
          {facts.map((d) => { const f = formatProp(d, o.props![d.id]); return <div key={d.id} class="hovertip-fact"><span>{L(d.label)}</span><span class={f.numeric ? 'num' : ''}>{f.text}{f.unit ? ` ${f.unit}` : ''}</span></div>; })}
          {fixAt != null && <div class="hovertip-fact"><span>{t('ac.age')}</span><span class="num">{ago(fixAt)}</span></div>}
        </>
      ) : text ? <b>{text}</b> : null}
    </div>
  );
}

export function LegendCard() {
  const g = S.overlayLegend.value;
  if (!g) return null;
  return (
    <aside class="legend panel" aria-label={g.title}>
      <div class="legend-head"><b>{g.title}</b>{g.unit && <span class="num muted">{g.unit}</span>}</div>
      <ul class="legend-stops">{g.stops.map((s, i) => <li key={i}><span class="legend-sw" style={{ background: s.color }} /><span class="num">{s.label}</span></li>)}</ul>
      {g.note && <p class="legend-note">{g.note}</p>}
      {g.source && <p class="legend-note muted">{g.source}</p>}
    </aside>
  );
}
