import { useEffect, useState } from 'preact/hooks';
import type { TwinStore, SourceStatus } from '../ontology/types';
import * as S from '../core/state';
import { t } from '../i18n/index';
import { Icon, GaritaMark } from './icons';
import { fmtTime, fmtDay } from './format';
import { paletteOpen, storeTick, nowTick, useQuery } from './uistate';

export type Fresh = 'ok' | 'stale' | 'error' | 'static' | 'unknown';
/** ok / stale (older than 3x the expected cadence) / error. Sources without a cadence are static. */
export function freshness(s: SourceStatus, now: number): Fresh {
  const live = s.source.kind === 'live' || s.source.kind === 'relay';
  if (!s.lastRun) return live ? 'unknown' : 'static';
  if (s.lastRun.status === 'error') return 'error';
  if (s.lastRun.status === 'stale') return 'stale';
  if (s.source.cadence_s && now - s.lastRun.finishedAt > 3 * s.source.cadence_s * 1000) return 'stale';
  return live ? 'ok' : 'static';
}

function Clock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  return (
    <div class="tb-clock" title="Atlantic Standard Time (UTC−4)">
      <span class="num tb-time">{fmtTime(now, true)}</span>
      <span class="label">{t('app.ast')}</span>
      <span class="num tb-date">{fmtDay(now)}</span>
    </div>
  );
}

function FeedChip({ store }: { store: TwinStore }) {
  const src = useQuery(() => store.sources(), [storeTick.value, nowTick.value]);
  const now = nowTick.value;
  const live = (src ?? []).filter((s) => s.source.kind === 'live' || s.source.kind === 'relay');
  const states = live.map((s) => freshness(s, now));
  const ok = states.filter((x) => x === 'ok').length;
  const bad = states.filter((x) => x === 'error').length;
  const late = states.filter((x) => x === 'stale').length;
  const state = !src || ok + bad + late === 0 ? 'unknown' : bad ? 'error' : late ? 'stale' : 'ok';
  const title = state === 'unknown' ? t('feeds.none') : state === 'ok' ? t('feeds.ok') : t('feeds.problem');
  return (
    <button class={'chip feed-chip fresh-' + state} title={title} onClick={() => { S.rightPanel.value = 'lineage'; }}>
      <span class={'fdot fresh-' + state} />
      <span class="num">{src ? `${ok}/${live.length}` : '—'}</span>
      <span class="label tb-hide-narrow">{t('feeds.chip')}</span>
    </button>
  );
}

export function TopBar({ store }: { store: TwinStore }) {
  const q = S.quality.value;
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  return (
    <header class="topbar panel">
      <div class="tb-brand">
        <GaritaMark />
        <span class="wordmark">GARITA</span>
        <span class="tb-sub">{t('app.subtitle')}</span>
      </div>
      <button class="tb-search" onClick={() => { paletteOpen.value = true; }} aria-label={t('app.search')}>
        <Icon name="search" size={14} />
        <span class="tb-search-text">{t('app.search')}</span>
        <kbd class="num">{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <div class="tb-right">
        <Clock />
        <FeedChip store={store} />
        <div class="seg" role="group" aria-label={t('app.lang')}>
          {(['en', 'es'] as const).map((l) => (
            <button key={l} class={S.lang.value === l ? 'on' : ''} aria-pressed={S.lang.value === l} onClick={() => { S.lang.value = l; }}>{l.toUpperCase()}</button>
          ))}
        </div>
        <div class="seg seg-quality" role="group" aria-label={t('app.quality')} title={t('app.quality')}>
          {(['low', 'medium', 'high'] as const).map((k) => (
            <button key={k} class={q === k ? 'on' : ''} aria-pressed={q === k} onClick={() => { S.quality.value = k; }}>{t('q.' + k)}</button>
          ))}
        </div>
      </div>
    </header>
  );
}
