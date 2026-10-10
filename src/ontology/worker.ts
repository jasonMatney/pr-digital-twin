// The store's home in the browser: SQLite (wasm) in a module Worker, persisted in OPFS through the
// `opfs-sahpool` VFS, which needs no COOP/COEP headers (GitHub Pages cannot send them). Every call is forwarded
// to the same engine object Node uses. This file must not import src/core/config.ts: a worker has no page
// `location`, so the client sends absolute URLs.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { getMeta, housekeeping, looksLikeSqlite, makeStore, openMemoryDb, prepareDb, readCarryOver, wrapSqlite, writeCarryOver } from './engine.ts';
import type { CarryOver, EngineStore } from './engine.ts';
import { SCHEMA_VERSION } from './schema.ts';
import type { Ontology } from './types.ts';

export interface InitMessage { type: 'init'; ontology: Ontology; seedUrl?: string; seedVersion?: string; wasmUrl?: string }
export interface StoreDetail {
  /** 'opfs-sahpool' when the database survives a reload, 'memory' otherwise. */
  vfs: 'opfs-sahpool' | 'memory';
  /** How this session's database came to be. */
  origin: 'existing' | 'seed' | 'empty';
  file: string;
  sqlite: string;
  carriedOver: { actions: number; userProps: number; obs: number } | null;
  cleaned: { obs: number; objects: number };
  notes: string[];
}

const METHODS = new Set(['query', 'getObject', 'getLinks', 'listObjects', 'search', 'series', 'neighborhood', 'countByType', 'sources', 'ingest', 'reportRun', 'annotate', 'actionLog']);
const post = (m: any) => (self as any).postMessage(m);
let store: EngineStore | null = null;

async function fetchSeed(url: string | undefined, notes: string[]): Promise<Uint8Array | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) { notes.push(`seed ${res.status} at ${url}`); return null; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // A dev server or a static host may answer a missing file with an HTML page and status 200.
    if (!looksLikeSqlite(bytes)) { notes.push(`seed at ${url} is not a SQLite file`); return null; }
    return bytes;
  } catch (e) {
    notes.push(`seed fetch failed: ${(e as Error).message}`);
    return null;
  }
}

async function init(msg: InitMessage): Promise<void> {
  const t0 = performance.now();
  const notes: string[] = [];
  const sqlite3: any = await (sqlite3InitModule as any)({
    print: () => {}, printErr: (m: string) => notes.push(String(m)),
    ...(msg.wasmUrl ? { locateFile: () => msg.wasmUrl } : {}),
  });
  const seedVersion = msg.seedVersion ?? msg.ontology.version;
  const file = `/twin-${seedVersion.replace(/[^\w.-]/g, '_')}.db`;
  const detail: StoreDetail = { vfs: 'memory', origin: 'empty', file, sqlite: sqlite3.version.libVersion, carriedOver: null, cleaned: { obs: 0, objects: 0 }, notes };
  let raw: any = null;
  let carry: CarryOver | null = null;

  let pool: any = null;
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'opfs-sahpool', directory: '.garita-db', initialCapacity: 8 });
  } catch (e) {
    // Typical causes: no OPFS (private window, old browser) or another tab of the app already holds the files.
    notes.push(`opfs-sahpool unavailable: ${(e as Error).message}`);
  }
  if (pool) {
    try {
      const names: string[] = pool.getFileNames();
      if (names.includes(file)) detail.origin = 'existing';
      else {
        const old = names.filter((n) => /^\/twin-.*\.db$/.test(n)).sort();
        if (old.length) {
          try {
            const prev = wrapSqlite(sqlite3, new pool.OpfsSAHPoolDb(old[old.length - 1]));
            try { carry = readCarryOver(prev); } finally { prev.close?.(); }
          } catch (e) { notes.push(`carry-over from ${old[old.length - 1]} skipped: ${(e as Error).message}`); }
        }
        // Journals of the old files go too; this VFS has a fixed number of slots.
        for (const n of names) if (n !== file && /^\/twin-/.test(n)) pool.unlink(n);
        const bytes = await fetchSeed(msg.seedUrl, notes);
        if (bytes) { await pool.importDb(file, bytes); detail.origin = 'seed'; }
      }
      raw = new pool.OpfsSAHPoolDb(file);
      const found = getMeta(wrapSqlite(sqlite3, raw), 'schema_version');
      if (found != null && found !== String(SCHEMA_VERSION)) {
        // Not migrated on purpose: everything but the user's own input can be fetched again.
        notes.push(`database has schema ${found}, this build needs ${SCHEMA_VERSION}: starting empty`);
        raw.close(); pool.unlink(file);
        raw = new pool.OpfsSAHPoolDb(file);
        detail.origin = 'empty';
      }
      detail.vfs = 'opfs-sahpool';
    } catch (e) {
      notes.push(`opfs-sahpool open failed: ${(e as Error).message}`);
      try { raw?.close(); } catch { /* already closed */ }
      raw = null;
    }
  }
  if (!raw) {
    const bytes = await fetchSeed(msg.seedUrl, notes);
    raw = openMemoryDb(sqlite3, bytes ?? undefined);
    detail.origin = bytes ? 'seed' : 'empty';
    const found = bytes ? getMeta(wrapSqlite(sqlite3, raw), 'schema_version') : null;
    if (found != null && found !== String(SCHEMA_VERSION)) { raw.close(); raw = openMemoryDb(sqlite3); detail.origin = 'empty'; notes.push(`seed has schema ${found}: starting empty`); }
  }

  const db = wrapSqlite(sqlite3, raw);
  db.exec('PRAGMA temp_store = MEMORY; PRAGMA cache_size = -32000;');
  prepareDb(db, msg.ontology, seedVersion);
  if (carry) {
    try {
      writeCarryOver(db, carry);
      detail.carriedOver = { actions: carry.actions.length, userProps: carry.userProps.length, obs: carry.obs.length };
    } catch (e) { notes.push(`carry-over not applied: ${(e as Error).message}`); }
  }
  try { detail.cleaned = housekeeping(db, msg.ontology); } catch (e) { notes.push(`housekeeping failed: ${(e as Error).message}`); }

  store = makeStore(db, msg.ontology, { persistent: detail.vfs === 'opfs-sahpool', seedVersion, openedMs: Math.round(performance.now() - t0) });
  store.onChange((event) => post({ type: 'change', event }));
  post({ type: 'ready', info: await store.ready, detail });
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m?.type === 'init') {
    init(m).catch((e) => post({ type: 'failed', error: String((e as Error)?.message ?? e) }));
    return;
  }
  if (m?.type !== 'call') return;
  if (!store || !METHODS.has(m.method)) { post({ type: 'result', id: m.id, error: !store ? 'store is not open' : `unknown method ${m.method}` }); return; }
  (store as any)[m.method](...(m.args ?? [])).then(
    (result: any) => post({ type: 'result', id: m.id, result }),
    (e: any) => post({ type: 'result', id: m.id, error: String(e?.message ?? e) }),
  );
};
