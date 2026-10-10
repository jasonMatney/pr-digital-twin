// Search palette (Cmd/Ctrl+K or "/"): full-text search over the store, grouped by type; "lat, lon" flies there.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TwinStore, ObjectSummary } from '../ontology/types';
import * as S from '../core/state';
import { t, L } from '../i18n/index';
import { Icon } from './icons';
import { dmm } from './format';
import { paletteOpen, typeDef } from './uistate';

/** "18.46, -66.10", "18.46 -66.10", "18.46N 66.10W". Longitude without a sign is taken as west near Puerto Rico. */
export function parseLatLon(q: string): { lat: number; lon: number } | null {
  const m = q.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([EWO])?$/i);
  if (!m) return null;
  let lat = +m[1], lon = +m[3];
  if (m[2]?.toUpperCase() === 'S') lat = -Math.abs(lat);
  if (m[4]) lon = /E/i.test(m[4]) ? Math.abs(lon) : -Math.abs(lon);
  else if (lon > 0 && lon > 60 && lon < 70) lon = -lon;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
const inPR = (p: { lat: number; lon: number }) => p.lat > 17.4 && p.lat < 19 && p.lon > -68.2 && p.lon < -64.9;

export function SearchPalette({ store }: { store: TwinStore }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<ObjectSummary[] | null>(null);
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const coord = parseLatLon(q);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2 || coord) { setRes(null); S.highlightIds.value = []; return; }
    let dead = false;
    const id = setTimeout(() => {
      store.search(text, { limit: 40 }).then((r) => { if (!dead) { setRes(r); setIdx(0); S.highlightIds.value = r.slice(0, 40).map((x) => x.id); } }).catch(() => { if (!dead) setRes([]); });
    }, 140);
    return () => { dead = true; clearTimeout(id); };
  }, [q]);
  useEffect(() => () => { S.highlightIds.value = []; }, []);

  // Group by type, keeping the store's ranking inside and between groups; `flat` is the keyboard order.
  const groups: { type: string; rows: ObjectSummary[] }[] = [];
  for (const r of res ?? []) { let g = groups.find((x) => x.type === r.type); if (!g) groups.push((g = { type: r.type, rows: [] })); g.rows.push(r); }
  const flat = groups.flatMap((g) => g.rows);
  const close = () => { paletteOpen.value = false; };
  const open = (o: ObjectSummary) => { S.select(o.id, { fly: true }); close(); };
  const go = () => {
    if (coord) { S.flyTo.value = { lon: coord.lon, lat: coord.lat, range: 8000 }; close(); return; }
    if (flat[idx]) open(flat[idx]);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  useEffect(() => { list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }); }, [idx]);
  let k = -1;
  return (
    <div class="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="palette panel" role="dialog" aria-modal="true" aria-label={t('app.search')}>
        <div class="palette-input">
          <Icon name="search" size={16} />
          <input ref={input} type="text" value={q} placeholder={t('se.ph')} aria-label={t('app.search')} spellcheck={false} autocomplete="off"
            onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={onKey} />
          <button class="icon-btn" onClick={close} aria-label={t('dock.close')}><Icon name="close" size={14} /></button>
        </div>
        <div class="palette-list" ref={list}>
          {coord && (
            <button class="pal-row is-active" onClick={go}>
              <span class="type-badge"><Icon name="fly" size={14} /></span>
              <span class="pal-name">{t('se.coord')}</span>
              <span class="num pal-meta">{dmm(coord.lat, 'lat')}  {dmm(coord.lon, 'lon')}{!inPR(coord) ? ` · ${t('se.outside')}` : ''}</span>
            </button>
          )}
          {!coord && res == null && <p class="muted pad">{t('se.hint')}</p>}
          {!coord && res != null && res.length === 0 && <p class="muted pad">{t('se.none')} “{q.trim()}”.</p>}
          {!coord && groups.map((g) => {
            const ty = typeDef(g.type);
            return (
              <div key={g.type} class="pal-group">
                <h3 class="label"><span>{ty ? L(ty.plural) : g.type}</span><span class="num">{g.rows.length}</span></h3>
                {g.rows.map((o) => {
                  k++; const mine = k;
                  return (
                    <button key={o.id} class={'pal-row' + (mine === idx ? ' is-active' : '')} onMouseMove={() => { if (idx !== mine) setIdx(mine); }} onClick={() => open(o)}>
                      <span class="type-badge" style={{ '--c': ty?.color } as any}><Icon name={ty?.icon ?? 'dot'} size={14} /></span>
                      <span class="pal-name">{o.name || o.key}</span>
                      <span class="num pal-meta">{o.key}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <footer class="palette-foot num">{t('se.keys')}</footer>
      </div>
    </div>
  );
}
