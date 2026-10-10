// LUMA "regions without service" (via the relay) -> power_region customers out.
import type { IngestBatch, ObjectInput, ObsInput } from '../../ontology/types.ts';
import type { MapContext } from '../types.ts';
import { compact, num, round, slug } from '../util.ts';

export function outageSeverity(pctOut: number | null): number | null {
  if (pctOut == null) return null;
  return pctOut < 0.5 ? 0 : pctOut < 2 ? 1 : pctOut < 10 ? 2 : pctOut < 30 ? 3 : 4;
}
/** LUMA stamps its payload in island time (AST, UTC-4, no daylight saving): '10/10/2026 12:30 AM'. */
export function lumaTime(s: unknown): number | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))? ?([AP]M)$/i.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = (+m[4] % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
  return Date.UTC(+m[3], +m[1] - 1, +m[2], h + 4, +m[5], +(m[6] ?? 0));
}

export function mapLuma(data: any, ctx: MapContext & { fetchedAt?: number }): IngestBatch[] {
  const fetchedAt = ctx.fetchedAt ?? ctx.now;
  const t = lumaTime(data?.timestamp) ?? fetchedAt;
  const objects: ObjectInput[] = [];
  const obs: ObsInput[] = [];
  for (const r of data?.regions ?? []) {
    const key = slug(String(r?.name ?? ''));
    if (!key) continue;
    const customers = num(r.totalClients), out = num(r.totalClientsWithoutService);
    const pct = num(r.percentageClientsWithoutService) ?? (customers && out != null ? round((out / customers) * 100, 2) : null);
    objects.push({
      type: 'power_region', key, name: r.name, severity: outageSeverity(pct),
      status: out == null ? null : out > 0 ? 'outages' : 'normal',
      props: compact({
        customers, customers_out: out, pct_out: pct, customers_planned: num(r.totalClientsAffectedByPlannedOutage),
        customers_load_shed: num(r.totalClientsAffectedByLoadShed),
      }),
    });
    const object = `power_region:${key}`;
    if (out != null) obs.push({ object, metric: 'customers_out', t, value: out });
    if (pct != null) obs.push({ object, metric: 'pct_out', t, value: pct });
  }
  return [{ source: 'luma', fetchedAt, observedAt: t, objects, obs }];
}
