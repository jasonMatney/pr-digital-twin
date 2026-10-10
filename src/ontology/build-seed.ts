// Builds the seed database the site ships as data/twin.db.
//   node src/ontology/build-seed.ts <dirWithBatchJson> <out.db> [--lenient] [--version <seedVersion>]
// Reads every *.batch.json in the directory (one IngestBatch or an array of them), checks each against the
// ontology, ingests them in filename order through the same engine the browser uses, and writes one SQLite file.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openNodeStore } from './node.ts';
import { validateBatch } from './validate.ts';
import type { IngestBatch, Ontology } from './types.ts';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const lenient = args.includes('--lenient');
  const vi = args.indexOf('--version');
  const version = vi >= 0 ? args[vi + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith('--') && (vi < 0 || i !== vi + 1));
  if (positional.length < 2) {
    console.error('usage: node src/ontology/build-seed.ts <dirWithBatchJson> <out.db> [--lenient] [--version <seedVersion>]');
    return 2;
  }
  const [dir, out] = positional.map((p) => resolve(p));
  const ontology: Ontology = JSON.parse(readFileSync(new URL('./ontology.json', import.meta.url), 'utf8'));
  const seedVersion = version ?? ontology.version;
  const files = readdirSync(dir).filter((f) => f.endsWith('.batch.json')).sort();
  if (!files.length) { console.error(`no *.batch.json files in ${dir}`); return 2; }

  const store = await openNodeStore({ ontology, seedVersion });
  let errors = 0;
  const t0 = Date.now();
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    const parsed = JSON.parse(text);
    const batches: IngestBatch[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const [i, batch] of batches.entries()) {
      const label = batches.length > 1 ? `${file}[${i}]` : file;
      const problems = validateBatch(batch, ontology);
      for (const p of problems) console.error(`  ${p.level.toUpperCase()} ${label} ${p.where}: ${p.message}`);
      const bad = problems.filter((p) => p.level === 'error').length;
      errors += bad;
      if (bad && !lenient) continue;
      try {
        const r = await store.ingest(batches.length === 1 && batch.bytes == null ? { ...batch, bytes: Buffer.byteLength(text) } : batch);
        console.log(`${label}: source ${r.source}, ${r.objects} objects (${r.created} new, ${r.changed} changed), ${r.links} links, ${r.obs} obs, ${r.ms} ms`);
      } catch (e) {
        errors++;
        console.error(`  ERROR ${label}: ${(e as Error).message}`);
      }
    }
  }
  if (errors && !lenient) {
    console.error(`${errors} error(s); nothing written. Fix the batches or pass --lenient to skip the bad parts.`);
    return 1;
  }

  // The file is downloaded by every first-time visitor: compact it and store planner statistics.
  store.execRaw(`INSERT OR REPLACE INTO meta (key, value) VALUES ('seed_version', '${seedVersion.replace(/'/g, "''")}'), ('built_at', '${new Date().toISOString()}')`);
  store.execRaw('ANALYZE; VACUUM;');
  const bytes = store.exportBytes();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);

  const counts = await store.countByType();
  const info = await store.query<{ links: number; obs: number; props: number }>('SELECT (SELECT COUNT(*) FROM link) AS links, (SELECT COUNT(*) FROM obs) AS obs, (SELECT COUNT(*) FROM prop) AS props');
  console.log(`\n${out}: ${(bytes.byteLength / 1e6).toFixed(2)} MB, seed version ${seedVersion}, built in ${Date.now() - t0} ms${errors ? `, ${errors} error(s) skipped (--lenient)` : ''}`);
  for (const [type, n] of Object.entries(counts)) console.log(`  ${type.padEnd(24)} ${String(n).padStart(8)}`);
  console.log(`  ${'(links)'.padEnd(24)} ${String(info[0].links).padStart(8)}\n  ${'(properties)'.padEnd(24)} ${String(info[0].props).padStart(8)}\n  ${'(observations)'.padEnd(24)} ${String(info[0].obs).padStart(8)}`);
  store.close();
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 1; });
