// The store in Node: the same wasm build of SQLite and the same engine as the browser worker, on an in-memory
// database. Used by tests and by build-seed.ts.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Ontology } from './types.ts';
import { makeStore, openMemoryDb, prepareDb, setMeta, wrapSqlite } from './engine.ts';
import type { EngineStore } from './engine.ts';

export interface NodeStore extends EngineStore {
  /** The database as the bytes of a SQLite file (what build-seed.ts writes to data/twin.db). */
  exportBytes(): Uint8Array;
  /** Runs SQL that writes (VACUUM, ANALYZE, test setup). Not part of TwinStore on purpose. */
  execRaw(sql: string): void;
}

let sqlite3Promise: Promise<any> | null = null;
function sqlite(): Promise<any> {
  // print/printErr silenced: the Node build reports the missing OPFS on stderr at every start.
  sqlite3Promise ??= (sqlite3InitModule as any)({ print: () => {}, printErr: () => {} });
  return sqlite3Promise!;
}

export async function openNodeStore(opts: { ontology: Ontology; seedVersion?: string; bytes?: Uint8Array }): Promise<NodeStore> {
  const t0 = Date.now();
  const sqlite3 = await sqlite();
  const raw = openMemoryDb(sqlite3, opts.bytes);
  const db = wrapSqlite(sqlite3, raw);
  const seedVersion = opts.seedVersion ?? opts.ontology.version;
  prepareDb(db, opts.ontology, seedVersion);
  if (opts.seedVersion) setMeta(db, 'seed_version', opts.seedVersion);
  const store = makeStore(db, opts.ontology, { persistent: false, seedVersion, openedMs: Date.now() - t0 });
  return Object.assign(store, {
    exportBytes: (): Uint8Array => sqlite3.capi.sqlite3_js_db_export(raw.pointer),
    execRaw: (sql: string) => { raw.exec(sql); },
  });
}
