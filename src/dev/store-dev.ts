// store.html: opens the store through the worker client, ingests a batch made from a recorded USGS payload and
// prints what came back. A check page for the store alone; it shares no code with the app shell.
import { createStore } from '../ontology/client.ts';
import ontologyJson from '../ontology/ontology.json';
import quakes from '../../tests/fixtures/usgs_quakes_30d.json';
import type { IngestBatch, Ontology } from '../ontology/types.ts';

const ontology = ontologyJson as unknown as Ontology;
const out = document.getElementById('out')!;
const show = (title: string, value: unknown, cls = '') => {
  const pre = document.createElement('pre');
  pre.className = cls;
  pre.textContent = `${title}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}`;
  out.append(pre);
};
const debug: Record<string, any> = {};
(globalThis as any).__garita = { ready: false, debug: () => debug };

async function main() {
  // ?seedVersion=x opens under another version name, which exercises the carry-over from the previous file.
  const seedVersion = new URLSearchParams(location.search).get('seedVersion') ?? ontology.version;
  const stages: string[] = [];
  const store = createStore({ ontology, seedUrl: 'data/twin.db', seedVersion, onProgress: (stage, f) => { if (stages[stages.length - 1]?.split(' ')[0] !== stage || f === 1) stages.push(f == null ? stage : `${stage} ${f.toFixed(2)}`); } });
  const info = await store.ready;
  debug.info = info;
  debug.readyMs = Math.round(performance.now());   // since navigation start: what a visitor waits for
  const detail = await store.detail;
  show('DbInfo (at open)', info);
  show('how it was opened', detail);

  const features = (quakes as any).features as any[];
  const batch: IngestBatch = {
    source: 'usgs_quakes', fetchedAt: (quakes as any).metadata.generated, bytes: JSON.stringify(quakes).length, replaceTypes: ['earthquake'],
    note: 'recorded payload tests/fixtures/usgs_quakes_30d.json',
    objects: features.map((f) => ({
      type: 'earthquake', key: f.id, name: f.properties.title, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
      status: f.properties.status, validFrom: f.properties.time, text: f.properties.place,
      identities: String(f.properties.ids).split(',').filter((x: string) => x && x !== f.id).map((x: string) => ['usgs:eventid', x] as [string, string]),
      props: { magnitude: { value: f.properties.mag, observedAt: f.properties.updated }, depth_km: f.geometry.coordinates[2], place: f.properties.place, network: f.properties.net },
    })),
  };
  const changes: any[] = [];
  store.onChange((e) => changes.push(e));
  const result = await store.ingest(batch);
  show('ingest result', result);
  const counts = await store.countByType();
  show('countByType', counts);
  const hits = await store.search('Guanica', { limit: 3 });
  show('search "Guanica" (accents folded: the titles say Guánica)', hits);
  const strongest = await store.listObjects('earthquake', { orderBy: '-magnitude', limit: 3 });
  show('strongest three (orderBy -magnitude)', strongest.map((o) => `${o.name}  [${o.props?.magnitude}]`).join('\n'));
  if (strongest[0]) await store.annotate(strongest[0].id, 'status_text', 'annotated by the store check page', 'store.html');
  const log = await store.actionLog(50);
  show('annotate() + actionLog()', { entries: log.length, latest: log[0] ?? null });
  let guard = '';
  try { await store.query('DELETE FROM object'); guard = 'NOT REJECTED'; } catch (e) { guard = (e as Error).message; }
  const sql = await store.query('SELECT source_id, status, objects, created, changed FROM ingest_run ORDER BY id DESC LIMIT 3');
  show('query(): last ingest runs', sql);
  show('query("DELETE FROM object") says', guard);

  Object.assign(debug, {
    info, vfs: detail.vfs, persistent: info.persistent, origin: detail.origin, sqlite: detail.sqlite, notes: detail.notes, result, counts,
    search: hits[0] ? { id: hits[0].id, name: hits[0].name } : null, strongest: strongest[0]?.name ?? null, changeEvents: changes.length, guard, actionLog: log.length, carriedOver: detail.carriedOver, file: detail.file, timings: detail.timings, stages,
  });
}

main().catch((e) => { debug.error = String(e?.message ?? e); show('FAILED', String(e?.stack ?? e), 'err'); }).finally(() => { (globalThis as any).__garita.ready = true; });
