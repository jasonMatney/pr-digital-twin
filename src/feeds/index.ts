// Feed scheduler. Runs every feed once at start (most important first), then on its cadence with jitter and
// exponential backoff, pauses while the tab is hidden, and hands each IngestBatch to the store.
import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { TwinStore } from '../ontology/types.ts';
import * as S from '../core/state';
import { dataUrl } from '../core/config';
import type { Feed, FeedContext, FeedStatus } from './types.ts';
import { fixtureFor } from './fixtures.ts';
import { FEEDS } from './registry.ts';

export { FEEDS };
export type { Feed, FeedContext, FeedStatus } from './types.ts';

const TIMEOUT_MS = 25_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 15 * 60_000;
const STAGGER_MS = 450;
const STALE_RELAY_MS = 45 * 60_000;

export interface FeedsHandle {
  stop(): void;
  /** Runs one feed (or all of them, in order) now, regardless of schedule. */
  runNow(id?: string): Promise<void>;
  status: Signal<Record<string, FeedStatus>>;
}

export function startFeeds(store: TwinStore, opts: { fixtures?: boolean; only?: string[] } = {}): FeedsHandle {
  const fixtures = opts.fixtures ?? S.fixturesMode.value;
  const feeds = FEEDS.filter((f) => !opts.only || opts.only.includes(f.id));
  const status = signal<Record<string, FeedStatus>>(Object.fromEntries(feeds.map((f) => [f.id, { state: 'idle' } as FeedStatus])));
  const patch = (id: string, p: Partial<FeedStatus>) => { status.value = { ...status.value, [id]: { ...status.value[id], ...p } }; };
  const relayIds = new Set(store.ontology.sources.filter((s) => s.kind === 'relay').map((s) => s.id));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Map<string, Promise<void>>();
  const fails = new Map<string, number>();
  const due = new Set<string>();           // came up while the tab was hidden
  const abort = new AbortController();
  let stopped = false;
  const hidden = () => typeof document !== 'undefined' && document.hidden;

  function makeContext(counter: { bytes: number }): FeedContext {
    async function get(url: string, init?: RequestInit): Promise<Response> {
      let target = url;
      if (fixtures) {
        const name = fixtureFor(url);
        if (!name) throw new Error(`no recorded fixture for ${url}`);
        target = dataUrl('fixtures/' + name);
      }
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new DOMException('timed out', 'TimeoutError')), TIMEOUT_MS);
      const onStop = () => timeout.abort();
      abort.signal.addEventListener('abort', onStop, { once: true });
      try {
        const res = await fetch(target, { ...(fixtures ? {} : init), signal: timeout.signal, cache: fixtures ? 'default' : 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
        return res;
      } catch (e: any) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(`${new URL(url).host} did not answer in ${TIMEOUT_MS / 1000} s`);
        throw e;
      } finally {
        clearTimeout(timer);
        abort.signal.removeEventListener('abort', onStop);
      }
    }
    const text = async (url: string, init?: RequestInit) => { const t = await (await get(url, init)).text(); counter.bytes += t.length; return t; };
    return {
      fetchText: text,
      async fetchJson(url, init) {
        const t = await text(url, init);
        try { return JSON.parse(t); } catch { throw new Error(`${new URL(url).host} did not return JSON`); }
      },
      now: () => Date.now(),
      store, fixtures, signal: abort.signal,
    };
  }

  function schedule(feed: Feed, delayMs: number) {
    if (stopped || fixtures) return;        // fixtures mode: one run from the recorded files, never rescheduled
    clearTimeout(timers.get(feed.id));
    patch(feed.id, { nextAt: Date.now() + delayMs });
    timers.set(feed.id, setTimeout(() => {
      if (hidden()) { due.add(feed.id); return; }
      void run(feed);
    }, delayMs));
  }

  function run(feed: Feed): Promise<void> {
    const active = running.get(feed.id);
    if (active) return active;              // one run at a time per feed
    const p = (async () => {
      const started = Date.now();
      const counter = { bytes: 0 };
      patch(feed.id, { state: 'running', nextAt: undefined });
      try {
        const batches = await feed.run(makeContext(counter));
        if (stopped) return;
        let objects = 0, newest = 0;
        for (let i = 0; i < batches.length; i++) {
          const b = batches[i];
          if (b.bytes == null && i === 0) b.bytes = counter.bytes;
          await store.ingest(b);
          objects += b.objects?.length ?? 0;
          newest = Math.max(newest, b.fetchedAt);
        }
        fails.set(feed.id, 0);
        // A relay file that stopped updating still downloads fine: say so instead of showing it as fresh. Judged by
        // the relay's fetch time (batch.fetchedAt), not the data time: NHC advisories are six hours apart. Scheduled
        // Actions routinely start late, hence the generous threshold.
        const stale = !fixtures && relayIds.has(feed.id) && newest > 0 && Date.now() - newest > STALE_RELAY_MS;
        patch(feed.id, { state: stale ? 'stale' : 'ok', lastOkAt: Date.now(), lastError: undefined, lastObjects: objects, lastMs: Date.now() - started });
        schedule(feed, feed.cadenceMs * (0.9 + Math.random() * 0.2));
      } catch (e: any) {
        if (stopped) return;
        const message = String(e?.message ?? e).slice(0, 300);
        const n = (fails.get(feed.id) ?? 0) + 1;
        fails.set(feed.id, n);
        patch(feed.id, { state: 'error', lastError: message, lastMs: Date.now() - started });
        try { await store.reportRun(feed.id, 'error', message, counter.bytes); } catch { /* the store being down must not stop the scheduler */ }
        schedule(feed, Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (n - 1)) * (0.9 + Math.random() * 0.2));
      } finally {
        running.delete(feed.id);
      }
    })();
    running.set(feed.id, p);
    return p;
  }

  function onVisibility() {
    if (hidden() || stopped) return;
    let i = 0;
    for (const f of feeds) if (due.delete(f.id)) setTimeout(() => void run(f), i++ * STAGGER_MS);
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  // First run, staggered in registry order so alerts and cyclones land before aircraft.
  feeds.forEach((f, i) => {
    patch(f.id, { nextAt: Date.now() + i * STAGGER_MS });
    timers.set(f.id, setTimeout(() => void run(f), i * STAGGER_MS));
  });

  return {
    status,
    stop() {
      stopped = true;
      abort.abort();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    },
    async runNow(id?: string) {
      const list = id ? feeds.filter((f) => f.id === id) : feeds;
      if (id && !list.length) throw new Error(`unknown feed "${id}"`);
      for (const f of list) { clearTimeout(timers.get(f.id)); due.delete(f.id); await run(f); }
    },
  };
}
