// One inbox for everything that may need attention, sorted by severity then time. Each section that is empty
// says what would appear there, so "nothing" reads as a finding and not as a broken feed.
import type { TwinStore, ObjectSummary } from '../../ontology/types';
import * as S from '../../core/state';
import { t } from '../../i18n/index';
import { Icon } from '../icons';
import { ago, num, fmtDateTime, toMs, DASH } from '../format';
import { storeTick, nowTick, useQuery, eventTimes, affectsCount, typeDef, showExpiredAlerts, SEV_FLOOD, sevClass } from '../uistate';

interface Item { o: ObjectSummary; section: string; sev: number; time: number; facts: string[]; affects: number | null; expired?: boolean; name?: string }
/** A fact with its label, from a template in the dictionary: "{v} km deep". */
const say = (key: string, v: Record<string, string>) => t(key).replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
const n = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const quakeSev = (m: number) => (m >= 6 ? 4 : m >= 5 ? 3 : m >= 4 ? 2 : 1);

async function load(store: TwinStore, withExpired: boolean, now: number): Promise<{ items: Item[]; empty: string[] }> {
  const [alerts, cyclones, quakes, gauges, regions] = await Promise.all([
    store.listObjects('weather_alert', { includeExpired: withExpired, limit: 300, props: ['event', 'severity_text', 'area_desc', 'expires', 'onset'] }),
    store.listObjects('tropical_cyclone', { props: ['classification', 'intensity_kt', 'pressure_hpa', 'distance_to_pr_km'] }),
    store.listObjects('earthquake', { where: { magnitude: ['>=', 3] }, orderBy: '-updatedAt', limit: 150, props: ['magnitude', 'depth_km', 'place'] }),
    store.listObjects('stream_gauge', { limit: 1000, props: ['flood_category', 'stage_m', 'discharge_m3s', 'municipio_name'] }),
    store.listObjects('power_region', { props: ['customers', 'customers_out', 'pct_out'] }),
  ]);
  const items: Item[] = [];
  for (const o of alerts) {
    const exp = toMs(o.props?.expires);
    const expired = o.status === 'expired' || (exp != null && exp < now);
    if (expired && (!withExpired || (exp ?? o.updatedAt) < now - 7 * 864e5)) continue;
    const facts = [String(o.props?.area_desc ?? '').replace(/, PR/g, '')].filter(Boolean);
    if (exp != null) facts.push(`${expired ? t('al.expiredAt') : t('al.expires')} ${fmtDateTime(exp)}`);
    items.push({ o, section: 'weather', sev: o.severity ?? 1, time: toMs(o.props?.onset) ?? o.updatedAt, facts, affects: null, expired });
  }
  for (const o of cyclones) {
    const facts = [o.props?.classification, n(o.props?.intensity_kt) != null ? say('al.f.wind', { v: String(o.props!.intensity_kt) }) : null, n(o.props?.pressure_hpa) != null ? say('al.f.pressure', { v: String(o.props!.pressure_hpa) }) : null,
      n(o.props?.distance_to_pr_km) != null ? say('al.f.dist', { v: num(o.props!.distance_to_pr_km as number) }) : null].filter(Boolean).map(String);
    items.push({ o, section: 'cyclone', sev: o.severity ?? 2, time: o.updatedAt, facts, affects: null });
  }
  const times = await eventTimes(quakes as any);
  for (const o of quakes) {
    const m = n(o.props?.magnitude); const tm = times.get(o.id) ?? o.updatedAt;
    if (m == null || m < 3 || tm < now - 7 * 864e5) continue;
    const facts = [`M ${m.toFixed(1)}`, n(o.props?.depth_km) != null ? say('al.f.depth', { v: (o.props!.depth_km as number).toFixed(1) }) : null].filter(Boolean).map(String);
    items.push({ o, section: 'quake', sev: o.severity ?? quakeSev(m), time: tm, facts, affects: null });
  }
  for (const o of gauges) {
    const cat = String(o.props?.flood_category ?? ''); const sev = SEV_FLOOD[cat];
    if (sev == null) continue;
    const facts = [t('al.f.cat.' + cat), n(o.props?.stage_m) != null ? say('al.f.stage', { v: (o.props!.stage_m as number).toFixed(2) }) : null, n(o.props?.discharge_m3s) != null ? say('al.f.flow', { v: num(o.props!.discharge_m3s as number, 1) }) : null].filter(Boolean).map(String);
    items.push({ o, section: 'gauge', sev, time: o.updatedAt, facts, affects: null });
  }
  for (const o of regions) {
    const pct = n(o.props?.pct_out);
    if (pct == null || pct < 2) continue;
    // A LUMA region is named after its main town: say that it is the region, and what the two numbers are.
    const out = n(o.props?.customers_out);
    const fact = out != null ? say('al.f.power', { n: num(out), pct: pct.toFixed(2) }) : say('al.f.power.pct', { pct: pct.toFixed(2) });
    const name = /regi[oó]n/i.test(o.name) ? o.name : say('al.f.region', { name: o.name });
    items.push({ o, section: 'power', sev: pct >= 25 ? 4 : pct >= 10 ? 3 : 2, time: o.updatedAt, facts: [fact], affects: null, name });
  }
  items.sort((a, b) => Number(!!a.expired) - Number(!!b.expired) || b.sev - a.sev || b.time - a.time);
  await Promise.all(items.slice(0, 60).filter((i) => i.section !== 'gauge' && i.section !== 'power').map(async (i) => { i.affects = await affectsCount(i.o.id); }));
  const empty = ['weather', 'cyclone', 'quake', 'gauge', 'power'].filter((s) => !items.some((i) => i.section === s));
  return { items, empty };
}

export function AlertsPanel({ store }: { store: TwinStore }) {
  const withExpired = showExpiredAlerts.value;
  const now = nowTick.value;
  const data = useQuery(() => load(store, withExpired, Date.now()), [storeTick.value, withExpired, now, S.lang.value]);
  const sel = S.selectedId.value;
  const active = data?.items.filter((i) => !i.expired).length ?? 0;
  return (
    <div class="pane alerts">
      <header class="pane-head">
        <div>
          <span class="label">{t('al.merged')}</span>
          <h2>{data ? (active ? <><span class="num">{active}</span> {t('al.count')}</> : t('al.count.none')) : t('ob.loading')}</h2>
        </div>
        <label class="check">
          <input type="checkbox" checked={withExpired} onChange={(e) => { showExpiredAlerts.value = (e.target as HTMLInputElement).checked; }} />
          <span class="check-mark" /><span>{t('al.expired')}</span>
        </label>
      </header>
      <div class="pane-scroll">
        {data && data.items.length > 0 && (
          <ul class="inbox">
            {data.items.map((i) => {
              const ty = typeDef(i.o.type);
              return (
                <li key={i.o.id}>
                  <button class={'inbox-row ' + sevClass(i.sev) + (i.expired ? ' is-expired' : '') + (sel === i.o.id ? ' is-selected' : '')} onClick={() => S.select(i.o.id, { fly: true })}>
                    <span class="sev-stripe" />
                    <span class="type-badge" style={{ '--c': ty?.color } as any}><Icon name={ty?.icon ?? 'dot'} size={14} /></span>
                    <span class="inbox-main">
                      <span class="inbox-top">
                        <span class="inbox-name" title={i.name ?? i.o.name}>{i.name ?? i.o.name}</span>
                        <span class="num inbox-ago">{ago(i.time, now)}</span>
                      </span>
                      <span class="inbox-facts">
                        <span class={'pill ' + sevClass(i.sev)}>{t('sev.' + Math.max(0, Math.min(4, i.sev)))}</span>
                        {i.facts.map((f, k) => <span key={k} class={k === 0 && i.section === 'weather' ? 'fact fact-wide' : 'fact'}>{f}</span>)}
                        {i.affects != null && i.affects > 0 && <span class="fact num">{i.affects} {i.affects === 1 ? t('al.affects1') : t('al.affects')}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {data && data.empty.length > 0 && (
          <section class="quiet">
            <h3 class="label">{t('al.sections')}</h3>
            <ul>
              {data.empty.map((s) => (
                <li key={s}><span class="quiet-dot" /><div><b>{t('al.sec.' + s)}</b><p>{t('al.empty.' + s)}</p></div></li>
              ))}
            </ul>
          </section>
        )}
        {!data && <p class="muted pad">{t('ob.loading')}… {DASH}</p>}
      </div>
    </div>
  );
}
