// Checks an IngestBatch against the ontology before it reaches the store. Used by feed tests and by the pipeline.
import type { IngestBatch, Ontology } from './types.ts';

export interface BatchProblem { level: 'error' | 'warn'; where: string; message: string }

export function validateBatch(batch: IngestBatch, ontology: Ontology, opts: { maxProblems?: number } = {}): BatchProblem[] {
  const max = opts.maxProblems ?? 50;
  const out: BatchProblem[] = [];
  const add = (level: 'error' | 'warn', where: string, message: string) => { if (out.length < max) out.push({ level, where, message }); };
  const types = new Map(ontology.objectTypes.map((t) => [t.id, t]));
  const links = new Map(ontology.linkTypes.map((l) => [l.id, l]));
  if (!ontology.sources.some((s) => s.id === batch.source)) add('error', 'batch', `unknown source "${batch.source}"`);
  if (!Number.isFinite(batch.fetchedAt)) add('error', 'batch', 'fetchedAt is not a number');
  const seen = new Set<string>();
  for (const o of batch.objects ?? []) {
    const where = `${o.type}:${o.key}`;
    const def = types.get(o.type);
    if (!def) { add('error', where, `unknown object type "${o.type}"`); continue; }
    if (!o.key || /\s/.test(String(o.key))) add('error', where, 'key is empty or contains whitespace');
    if (seen.has(where)) add('warn', where, 'duplicate object in batch'); seen.add(where);
    if (o.lon != null && (o.lon < -180 || o.lon > 180)) add('error', where, `lon ${o.lon} out of range`);
    if (o.lat != null && (o.lat < -90 || o.lat > 90)) add('error', where, `lat ${o.lat} out of range`);
    if ((o.lon == null) !== (o.lat == null)) add('error', where, 'lon and lat must be given together');
    if (o.severity != null && (o.severity < 0 || o.severity > 4)) add('error', where, `severity ${o.severity} outside 0..4`);
    const props = new Map(def.properties.map((p) => [p.id, p]));
    for (const [k, raw] of Object.entries(o.props ?? {})) {
      const p = props.get(k);
      if (!p) { add('error', where, `property "${k}" is not defined for ${o.type}`); continue; }
      const v = raw != null && typeof raw === 'object' ? (raw as any).value : raw;
      if (v == null) continue;
      if (p.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) add('error', where, `property "${k}" should be a finite number, got ${JSON.stringify(v)}`);
      if (p.type === 'boolean' && typeof v !== 'boolean') add('error', where, `property "${k}" should be boolean`);
      if (p.type === 'date' && typeof v !== 'number') add('error', where, `property "${k}" should be epoch ms`);
      if ((p.type === 'string' || p.type === 'url') && typeof v !== 'string') add('error', where, `property "${k}" should be a string`);
    }
  }
  for (const l of batch.links ?? []) {
    const where = `${l.src} -${l.type}-> ${l.dst}`;
    const def = links.get(l.type);
    if (!def) { add('error', where, `unknown link type "${l.type}"`); continue; }
    const st = l.src.split(':')[0], dt = l.dst.split(':')[0];
    if (!types.has(st)) add('error', where, `src type "${st}" unknown`);
    if (!types.has(dt)) add('error', where, `dst type "${dt}" unknown`);
    if (!def.from.includes('*') && !def.from.includes(st)) add('error', where, `link ${l.type} cannot start at ${st}`);
    if (!def.to.includes('*') && !def.to.includes(dt)) add('error', where, `link ${l.type} cannot end at ${dt}`);
  }
  for (const ob of batch.obs ?? []) {
    const t = types.get(ob.object.split(':')[0]);
    if (!t) { add('error', ob.object, 'observation on unknown object type'); continue; }
    if (!(t.metrics ?? []).some((m) => m.id === ob.metric)) add('error', ob.object, `metric "${ob.metric}" is not defined for ${t.id}`);
    if (!Number.isFinite(ob.value) || !Number.isFinite(ob.t)) add('error', ob.object, 'observation value or time is not finite');
  }
  return out;
}
