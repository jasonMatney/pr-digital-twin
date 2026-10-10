// "Island now": seven live counts. Each chip re-queries on store change. No data yet = an em dash, never a zero.
import type { ComponentChildren } from 'preact';
import type { TwinStore } from '../ontology/types';
import * as S from '../core/state';
import { t } from '../i18n/index';
import { Icon } from './icons';
import { DASH, num, compact, compass, haversineKm, toMs } from './format';
import { storeTick, nowTick, useQuery, eventTimes, explorerType, SEV_FLOOD, sevClass } from './uistate';

const PR = { lat: 18.22, lon: -66.45 };
const n = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface Kpi {
  alerts: { count: number; maxSev: number } | null;
  quakes: { count: number; maxMag: number | null } | null;
  gauges: { at: number; total: number; maxSev: number } | null;
  power: { out: number; customers: number | null } | null;
  tide: { level: number; residual: number | null } | null;
  cyclones: { count: number; nearestKm: number | null; maxSev: number } | null;
}

async function loadKpi(store: TwinStore, now: number): Promise<Kpi> {
  const counts = await store.countByType();
  const srcs = await store.sources();
  const ran = (id: string) => srcs.some((s) => s.source.id === id && s.lastRun && s.lastRun.status !== 'error');
  const [alertsAll, quakes, gauges, regions, tide, cyclones] = await Promise.all([
    store.listObjects('weather_alert', { limit: 500, props: ['expires'] }),
    store.listObjects('earthquake', { limit: 300, props: ['magnitude'], orderBy: '-updatedAt' }),   // newest first; event times are looked up once and cached
    store.listObjects('stream_gauge', { limit: 1000, props: ['flood_category'] }),
    store.listObjects('power_region', { props: ['customers', 'customers_out'] }),
    store.getObject('tide_station:9755371'),
    store.listObjects('tropical_cyclone', { props: ['distance_to_pr_km'] }),
  ]);
  // Only alerts still in force: fixtures and slow feeds can leave expired ones in the list.
  const alerts = alertsAll.filter((a) => { const e = toMs(a.props?.expires); return a.status !== 'expired' && (e == null || e > now); });
  const k: Kpi = { alerts: null, quakes: null, gauges: null, power: null, tide: null, cyclones: null };
  // Ephemeral types are legitimately empty; only say "0" once their feed has actually reported.
  if (alerts.length || ran('nws_alerts')) k.alerts = { count: alerts.length, maxSev: Math.max(0, ...alerts.map((a) => a.severity ?? 0)) };
  if (quakes.length || ran('usgs_quakes')) {
    const times = await eventTimes(quakes as any);
    const recent = quakes.filter((q) => (times.get(q.id) ?? 0) >= now - 864e5);
    const mags = recent.map((q) => n(q.props?.magnitude)).filter((x): x is number => x != null);
    k.quakes = { count: recent.length, maxMag: mags.length ? Math.max(...mags) : null };
  }
  if (gauges.length) {
    const at = gauges.filter((g) => SEV_FLOOD[String(g.props?.flood_category ?? '')] != null);
    k.gauges = { at: at.length, total: gauges.length, maxSev: Math.max(0, ...at.map((g) => SEV_FLOOD[String(g.props?.flood_category)])) };
  }
  const outs = regions.map((r) => n(r.props?.customers_out)).filter((x): x is number => x != null);
  if (outs.length) {
    const cust = regions.map((r) => n(r.props?.customers)).filter((x): x is number => x != null);
    k.power = { out: outs.reduce((a, b) => a + b, 0), customers: cust.length === regions.length ? cust.reduce((a, b) => a + b, 0) : null };
  }
  if (tide) {
    const best = (key: string) => n(tide.props?.[key] ?? tide.allProps.find((p) => p.key === key)?.value);
    const level = best('water_level_m');
    if (level != null) k.tide = { level, residual: best('residual_m') };
  }
  if (cyclones.length || ran('nhc')) {
    const d = cyclones.map((c) => n(c.props?.distance_to_pr_km) ?? (c.lat != null && c.lon != null ? haversineKm(PR.lat, PR.lon, c.lat, c.lon) : null)).filter((x): x is number => x != null);
    k.cyclones = { count: cyclones.length, nearestKm: d.length ? Math.min(...d) : null, maxSev: Math.max(0, ...cyclones.map((c) => c.severity ?? 0)) };
  }
  void counts;
  return k;
}

function Chip({ icon, label, value, unit, sub, sev, onClick, live }: { icon: string; label: string; value: ComponentChildren; unit?: string; sub?: ComponentChildren; sev?: number; onClick: () => void; live?: boolean }) {
  const empty = value === DASH;
  return (
    <button class={'kpi ' + (empty ? 'is-empty ' : '') + (sev ? sevClass(sev) + ' has-sev' : '')} onClick={onClick} title={empty ? `${label}: ${t('kpi.nodata')}` : label}>
      <span class="kpi-stripe" />
      <Icon name={icon} size={14} />
      <span class="kpi-body">
        <span class="label kpi-label">{label}</span>
        <span class="kpi-line">
          <span class="num kpi-value">{value}</span>
          {unit && !empty && <span class="kpi-unit">{unit}</span>}
          {sub && !empty && <span class="num kpi-sub">{sub}</span>}
          {live && !empty && <span class="fdot fresh-ok kpi-live" />}
        </span>
      </span>
    </button>
  );
}

export function KpiStrip({ store }: { store: TwinStore }) {
  const now = nowTick.value;
  const k = useQuery(() => loadKpi(store, Date.now()), [storeTick.value, now]);
  const w = S.weather.value;
  const openType = (type: string) => { explorerType.value = type; S.rightPanel.value = 'explorer'; };
  const kmh = w.source === 'live' ? w.windMs * 3.6 : null;
  const pct = k?.power && k.power.customers ? (100 * k.power.out) / k.power.customers : null;
  return (
    <section class="kpis" aria-label={t('kpi.title')}>
      <span class="label kpis-title">{t('kpi.title')}</span>
      <div class="kpis-row">
        <Chip icon="alert" label={t('kpi.alerts')} value={k?.alerts ? num(k.alerts.count) : DASH} sub={t('kpi.alerts.sub')}
          sev={k?.alerts?.count ? Math.max(1, k.alerts.maxSev) : 0} onClick={() => { S.rightPanel.value = 'alerts'; }} />
        <Chip icon="quake" label={t('kpi.quakes')} value={k?.quakes ? num(k.quakes.count) : DASH}
          sub={k?.quakes?.maxMag != null ? `${t('kpi.quakes.max')} M ${k.quakes.maxMag.toFixed(1)}` : undefined}
          sev={k?.quakes?.maxMag != null && k.quakes.maxMag >= 4 ? (k.quakes.maxMag >= 6 ? 4 : k.quakes.maxMag >= 5 ? 3 : 2) : 0} onClick={() => openType('earthquake')} />
        <Chip icon="gauge" label={t('kpi.gauges')} value={k?.gauges ? num(k.gauges.at) : DASH}
          sub={k?.gauges ? `${t('kpi.gauges.of')} ${k.gauges.total}` : undefined} sev={k?.gauges?.maxSev ?? 0} onClick={() => openType('stream_gauge')} />
        <Chip icon="bolt" label={t('kpi.power')} value={k?.power ? compact(k.power.out) : DASH}
          sub={pct != null ? `${pct.toFixed(2)}%` : undefined} sev={pct != null && pct >= 2 ? (pct >= 25 ? 4 : pct >= 10 ? 3 : 2) : 0} onClick={() => openType('power_region')} />
        <Chip icon="wave" label={t('kpi.tide')} value={k?.tide ? (k.tide.level >= 0 ? '+' : '−') + Math.abs(k.tide.level).toFixed(2) : DASH} unit="m"
          sub={k?.tide?.residual != null ? `${k.tide.residual >= 0 ? '+' : '−'}${Math.abs(k.tide.residual).toFixed(2)} ${t('kpi.tide.vs')}` : undefined}
          onClick={() => S.select('tide_station:9755371', { fly: true })} />
        <Chip icon="wind" label={t('kpi.wind')} value={kmh != null ? num(kmh) : DASH} unit="km/h"
          sub={kmh != null ? `${t('kpi.wind.from')} ${compass(w.windDirDeg)}` : undefined} onClick={() => openType('weather_station')} />
        <Chip icon="cyclone" label={t('kpi.cyclones')} value={k?.cyclones ? num(k.cyclones.count) : DASH}
          sub={k?.cyclones?.nearestKm != null ? `${t('kpi.cyclones.nearest')} ${num(k.cyclones.nearestKm)} km` : undefined}
          sev={k?.cyclones?.count ? Math.max(1, k.cyclones.maxSev) : 0} onClick={() => openType('tropical_cyclone')} />
      </div>
    </section>
  );
}
