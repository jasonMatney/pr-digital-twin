// Lineage: where every number comes from. One card per source, grouped by how the data reaches the browser.
import type { TwinStore, SourceStatus } from '../../ontology/types';
import { t } from '../../i18n/index';
import { Icon } from '../icons';
import { ago, duration, fmtDateTime, num } from '../format';
import { storeTick, nowTick, useQuery } from '../uistate';
import * as S from '../../core/state';
import { freshness, tallyFeeds, feedSummary, ON_DEMAND } from '../topbar';

const KINDS = ['live', 'relay', 'baked', 'derived', 'user'] as const;

function Card({ s, now }: { s: SourceStatus; now: number }) {
  const f = freshness(s, now);
  const run = s.lastRun;
  // When the data itself is from (not when we fetched it): from the store if it reports it, else from the feed scheduler.
  let dataAt: number | null = (s as any).dataAt ?? null;
  let feedError: string | null = null;
  try {
    const fs = (globalThis as any).__garita?.feeds?.status?.value?.[s.source.id];
    dataAt ??= fs?.dataAt ?? null;
    if (fs?.state === 'error' && fs.lastError && fs.lastError !== run?.note) feedError = String(fs.lastError);
  } catch { /* no scheduler on this page */ }
  return (
    <li class={'src-card fresh-' + f}>
      <div class="src-top">
        <span class={'fdot fresh-' + f} title={t('li.' + f)} />
        <div class="src-title">
          <b>{s.source.name}</b>
          <span class="src-org">{s.source.org}</span>
        </div>
        <span class={'pill fresh-pill fresh-' + f}>{t('li.' + f)}</span>
      </div>
      <dl class="src-facts">
        <div><dt class="label">{t('li.last')}</dt><dd class="num">{run ? <>{ago(run.finishedAt, now)} <i>· {fmtDateTime(run.finishedAt)}</i></> : <i>{t('li.never')}</i>}</dd></div>
        {dataAt != null && <div><dt class="label">{t('li.dataAt')}</dt><dd class="num">{ago(dataAt, now)} <i>· {fmtDateTime(dataAt)}</i></dd></div>}
        {s.source.cadence_s != null && <div><dt class="label">{t('li.cadence')}</dt><dd class="num">{duration(s.source.cadence_s)}</dd></div>}
        <div><dt class="label">{t('li.objects')}</dt><dd class="num">{num(s.objectCount)}{run && run.obs ? <i> · {num(run.obs)} {t('li.obs')}</i> : null}</dd></div>
        <div><dt class="label">{t('li.licence')}</dt><dd>{s.source.license || '—'}</dd></div>
      </dl>
      {f === 'ondemand' && <p class="src-note">{t('li.ondemand.note').replace('{ov}', t('ov.' + ON_DEMAND[s.source.id])).replace('{state}', t(S.overlay.value === ON_DEMAND[s.source.id] ? 'li.ov.on' : 'li.ov.off'))}</p>}
      {run?.note && <p class={'src-note' + (run.status === 'error' ? ' is-error' : '')}>{run.note}</p>}
      {feedError && <p class="src-note is-error">{feedError}</p>}
      {s.source.note && <p class="src-note">{s.source.note}</p>}
      {s.source.url && <a class="src-link" href={s.source.url} target="_blank" rel="noopener noreferrer" title={t('li.open')}><Icon name="external" size={12} /><span class="num">{s.source.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span></a>}
    </li>
  );
}

export function LineagePanel({ store }: { store: TwinStore }) {
  const now = nowTick.value;
  const src = useQuery(() => store.sources(), [storeTick.value, now]);
  return (
    <div class="pane lineage">
      <header class="pane-head pane-head-col">
        <h2>{t('li.title')}</h2>
        <p class="muted">{t('li.lead')}</p>
      </header>
      <div class="pane-scroll">
        {!src && <p class="muted pad">{t('ob.loading')}…</p>}
        {src && (
          <section class="src-group feed-sum">
            <h3 class="label"><span>{t('li.feeds')}</span></h3>
            <ul>{feedSummary(tallyFeeds(src, now)).map((l, i) => <li key={i} class={'src-note' + (i === 0 ? ' feed-sum-top' : '')}>{l}</li>)}</ul>
          </section>
        )}
        {src && KINDS.map((k) => {
          const list = src.filter((s) => s.source.kind === k);
          if (!list.length) return null;
          return (
            <section key={k} class="src-group">
              <h3 class="label"><span>{t('li.kind.' + k)}</span><span class="num">{list.length}</span></h3>
              <ul>{list.map((s) => <Card key={s.source.id} s={s} now={now} />)}</ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
