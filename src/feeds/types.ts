// The feed contract. A feed fetches one public source, maps it onto the ontology and returns IngestBatches.
// Feeds never touch the UI or the scene; the scheduler (index.ts) hands the batches to the store.
import type { IngestBatch, TwinStore } from '../ontology/types.ts';

export interface FeedContext {
  /** Adds a timeout and records bytes; in fixtures mode maps the URL to a recorded file. */
  fetchJson<T = any>(url: string, init?: RequestInit): Promise<T>;
  fetchText(url: string, init?: RequestInit): Promise<string>;
  /** Epoch ms (injectable for tests). */
  now(): number;
  /** Read access for joins (e.g. municipio centroids); may be null in unit tests. */
  store: Pick<TwinStore, 'listObjects' | 'getObject' | 'query'> | null;
  fixtures: boolean;
  signal?: AbortSignal;
}
export interface Feed {
  /** A SourceDef.id from ontology.json. */
  id: string;
  label: string;
  cadenceMs: number;
  run(ctx: FeedContext): Promise<IngestBatch[]>;
}
export interface FeedStatus {
  state: 'idle' | 'running' | 'ok' | 'error' | 'stale';
  lastOkAt?: number;
  lastError?: string;
  lastObjects?: number;
  lastMs?: number;
  nextAt?: number;
  /** Epoch ms of the newest data delivered: the relay's fetch time for relay feeds, else the newest observation time. */
  dataAt?: number;
}
/** What the pure mappers need from the outside world. */
export interface MapContext {
  /** Epoch ms of the fetch. */
  now: number;
  /** Municipio centroids for nearest-place joins; omit to skip the join. */
  municipios?: { id: string; lon: number; lat: number }[];
}
/** Shape of every file on the `relay` branch (written by pipeline/relay.mjs). */
export interface RelayFile<T = any> { fetchedAt: number; source: string; data: T }
