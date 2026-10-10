// UI-only chrome state (which flyout is open, palette, sheet) and the hooks that re-query the store.
// Anything the scene or the feeds care about lives in core/state.ts, not here.
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TwinStore, ObjectTypeDef, SourceDef, LinkTypeDef, PropertyDef } from '../ontology/types';

export const railGroup = signal<string | null>(null);       // open flyout: a group id, 'scene' or 'overlays'
export const paletteOpen = signal(false);
export const dockCollapsed = signal(false);
export const sheetVh = signal(46);                         // narrow layout: bottom sheet height, dragged by its grip                 // narrow layout: bottom sheet folded to its tab bar
export const explorerType = signal<string>('earthquake');
export const showExpiredAlerts = signal(false);
export const narrow = signal(false);
/** Bumped (debounced) whenever the store reports a change; panels list it as a dependency to re-query. */
export const storeTick = signal(0);
/** A coarse wall clock (every 30 s) so "x min ago" labels and time windows stay current. */
export const nowTick = signal(Date.now());

let _store: TwinStore;
const types = new Map<string, ObjectTypeDef>();
const sources = new Map<string, SourceDef>();
const linkTypes = new Map<string, LinkTypeDef>();
export function bindStore(s: TwinStore) {
  _store = s;
  types.clear(); sources.clear(); linkTypes.clear();
  for (const x of s.ontology.objectTypes) types.set(x.id, x);
  for (const x of s.ontology.sources) sources.set(x.id, x);
  for (const x of s.ontology.linkTypes) linkTypes.set(x.id, x);
}
export const getStore = () => _store;
export const typeDef = (id: string | undefined | null) => (id ? types.get(id) : undefined);
export const typeOfId = (objectId: string) => types.get(objectId.slice(0, objectId.indexOf(':')));
export const sourceDef = (id: string) => sources.get(id);
export const linkDef = (id: string) => linkTypes.get(id);
export const propDef = (typeId: string, key: string): PropertyDef | undefined => types.get(typeId)?.properties.find((p) => p.id === key);

/** Run an async store query; re-run when deps change (include storeTick.value to follow the store). Keeps the last
 *  result while the next one loads so tables do not flash. `undefined` = not loaded yet. */
export function useQuery<T>(fn: () => Promise<T>, deps: any[]): T | undefined {
  const [data, setData] = useState<T | undefined>(undefined);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    let dead = false;
    fn().then((r) => { if (!dead && my === seq.current) setData(r); }).catch((e) => { console.warn('[ui] query failed', e); if (!dead && my === seq.current) setData(undefined); });
    return () => { dead = true; };
  }, deps);
  return data;
}

/** Event time of earthquakes is `validFrom` on the full record, which summaries do not carry. It never changes, so cache it. */
const eventTimeCache = new Map<string, number>();
export async function eventTimes(ids: string[]): Promise<Map<string, number>> {
  const missing = ids.filter((id) => !eventTimeCache.has(id));
  await Promise.all(missing.map(async (id) => {
    const o = await _store.getObject(id).catch(() => null);
    if (o) eventTimeCache.set(id, o.validFrom ?? o.firstSeen ?? o.updatedAt);
  }));
  return eventTimeCache;
}
const affectsCache = new Map<string, { at: number; n: number }>();
export async function affectsCount(id: string): Promise<number> {
  const c = affectsCache.get(id);
  if (c && Date.now() - c.at < 120e3) return c.n;
  const links = await _store.getLinks(id, { type: 'affects', direction: 'out', limit: 200 }).catch(() => []);
  const n = links.filter((l) => (l.dstType ?? l.dst.split(':')[0]) === 'municipio').length;
  affectsCache.set(id, { at: Date.now(), n });
  return n;
}

export const SEV_FLOOD: Record<string, number> = { action: 1, minor: 2, moderate: 3, major: 4 };
export const sevClass = (s: number | null | undefined) => 'sev-' + Math.max(0, Math.min(4, Math.round(s ?? 0)));
