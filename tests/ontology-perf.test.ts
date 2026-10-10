// Bulk load: the seed database holds tens of thousands of objects (buildings of interest, tracts, facilities), and
// the browser has to be able to rebuild it. The objects here are synthetic load, labelled as such and never shipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openNodeStore } from '../src/ontology/node.ts';
import type { IngestBatch, ObjectInput, Ontology } from '../src/ontology/types.ts';

const ontology: Ontology = JSON.parse(readFileSync(new URL('../src/ontology/ontology.json', import.meta.url), 'utf8'));

test('ingest of 50,000 objects x 8 properties', async () => {
  const s = await openNodeStore({ ontology });
  const N = 50000;
  const objects: ObjectInput[] = [];
  for (let i = 0; i < N; i++) {
    // A regular grid over the island's bounding box, so the R*Tree gets a realistic spread.
    const lon = -67.3 + (i % 250) * 0.0068, lat = 17.9 + Math.floor(i / 250) * 0.003;
    objects.push({
      type: 'school', key: `node/${9000000 + i}`, name: `Load test object ${i}`, lon, lat,
      props: { p1: i, p2: i * 0.5, p3: `text ${i % 97}`, p4: i % 2 === 0, p5: i % 13, p6: lon, p7: lat, p8: `v${i}` },
    });
  }
  const batch: IngestBatch = { source: 'garita_derived', fetchedAt: Date.now(), objects, note: 'synthetic load test' };
  // Wall time on a shared machine says little, so CPU time is measured too and is what the limit applies to.
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const r = await s.ingest(batch);
  const ms = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  assert.equal(r.created, N);
  assert.equal((await s.query<any>('SELECT COUNT(*) AS n FROM prop'))[0].n, N * 8);

  const t1 = performance.now();
  const again = await s.ingest({ ...batch, fetchedAt: batch.fetchedAt + 1 });
  const msAgain = performance.now() - t1;
  assert.deepEqual([again.created, again.changed], [0, 0]);

  const t2 = performance.now();
  const box = await s.listObjects('school', { bbox: [-66.2, 18.3, -66.0, 18.5], limit: 5000 });
  const msBox = performance.now() - t2;
  assert.ok(box.length > 0 && box.every((o) => o.lon! >= -66.2 && o.lon! <= -66.0 && o.lat! >= 18.3 && o.lat! <= 18.5));

  const t3 = performance.now();
  const top = await s.listObjects('school', { where: { p5: 7, p1: ['>', 40000] }, orderBy: '-p2', limit: 50, props: ['p1', 'p2'] });
  const msWhere = performance.now() - t3;
  assert.equal(top.length, 50);
  assert.ok(top.every((o, i) => o.props!.p1 as number > 40000 && (i === 0 || (o.props!.p2 as number) <= (top[i - 1].props!.p2 as number))));

  const t4 = performance.now();
  const hit = await s.search('load test object 31415');
  const msSearch = performance.now() - t4;
  assert.equal(hit[0].key, 'node/9031415');

  const bytes = s.exportBytes().byteLength;
  console.log(`# 50,000 x 8 ingest: ${ms.toFixed(0)} ms wall, ${cpuMs.toFixed(0)} ms CPU; identical re-ingest: ${msAgain.toFixed(0)} ms; bbox list (${box.length} rows): ${msBox.toFixed(0)} ms; where + orderBy on properties: ${msWhere.toFixed(0)} ms; search: ${msSearch.toFixed(1)} ms; file: ${(bytes / 1e6).toFixed(1)} MB`);
  assert.ok(cpuMs < 20000, `ingest took ${cpuMs.toFixed(0)} ms of CPU`);
  s.close();
});
