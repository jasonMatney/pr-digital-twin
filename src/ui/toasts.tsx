// Toasts for NEW high-severity events (severity >= 3) that arrive after the page has loaded. At most 3 visible.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TwinStore, ObjectSummary } from '../ontology/types';
import * as S from '../core/state';
import { t, L } from '../i18n/index';
import { Icon } from './icons';
import { typeDef, sevClass } from './uistate';

const EVENT_TYPES = ['weather_alert', 'tropical_cyclone', 'earthquake'];
const TTL = 15000;

export function Toasts({ store }: { store: TwinStore }) {
  const [items, setItems] = useState<{ o: ObjectSummary; at: number }[]>([]);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    let dead = false, busy = false, again = false;
    const scan = async () => {
      if (busy) { again = true; return; }
      busy = true;
      try {
        const rows = (await store.listObjects(EVENT_TYPES, { limit: 500, orderBy: '-updatedAt' })).filter((o) => (o.severity ?? 0) >= 3);
        if (dead) return;
        // The first scan only records what is already there; arriving later is what makes an event "new".
        if (!seen.current) { seen.current = new Set(rows.map((o) => o.id)); return; }
        const fresh = rows.filter((o) => !seen.current!.has(o.id));
        for (const o of fresh) seen.current.add(o.id);
        if (fresh.length) setItems((cur) => [...fresh.map((o) => ({ o, at: Date.now() })), ...cur].slice(0, 3));
      } catch { /* the store is still opening */ } finally { busy = false; if (again && !dead) { again = false; scan(); } }
    };
    store.ready.then(scan).catch(() => {});
    const off = store.onChange((e) => { if (!e.types?.length || e.types.some((x) => EVENT_TYPES.includes(x))) scan(); });
    const sweep = setInterval(() => setItems((cur) => (cur.some((i) => Date.now() - i.at > TTL) ? cur.filter((i) => Date.now() - i.at <= TTL) : cur)), 1000);
    return () => { dead = true; off(); clearInterval(sweep); };
  }, []);
  if (!items.length) return null;
  return (
    <div class="toasts" role="status" aria-live="polite">
      {items.map(({ o }) => {
        const ty = typeDef(o.type);
        return (
          <div key={o.id} class={'toast panel ' + sevClass(o.severity)}>
            <span class="sev-stripe" />
            <button class="toast-main" onClick={() => { S.select(o.id, { fly: true }); setItems((c) => c.filter((i) => i.o.id !== o.id)); }}>
              <span class="type-badge" style={{ '--c': ty?.color } as any}><Icon name={ty?.icon ?? 'alert'} size={14} /></span>
              <span class="toast-text">
                <span class="label">{t('toast.new')} · {ty ? L(ty.label) : o.type} · {t('sev.' + Math.min(4, Math.round(o.severity ?? 3)))}</span>
                <b>{o.name}</b>
              </span>
            </button>
            <button class="icon-btn" aria-label={t('toast.dismiss')} onClick={() => setItems((c) => c.filter((i) => i.o.id !== o.id))}><Icon name="close" size={12} /></button>
          </div>
        );
      })}
    </div>
  );
}
