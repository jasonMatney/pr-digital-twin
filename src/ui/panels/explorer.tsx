// Explorer: any object type as a sortable, filterable table of its primary properties. Capped at 500 drawn rows.
import { useMemo, useState } from 'preact/hooks';
import type { TwinStore, ObjectSummary } from '../../ontology/types';
import * as S from '../../core/state';
import { t, L } from '../../i18n/index';
import { Icon } from '../icons';
import { formatProp, num, unitLabel } from '../format';
import { storeTick, useQuery, explorerType, typeDef } from '../uistate';

const CAP = 500;

export function ExplorerPanel({ store }: { store: TwinStore }) {
  const typeId = explorerType.value;
  const ty = typeDef(typeId) ?? store.ontology.objectTypes[0];
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [expired, setExpired] = useState(false);
  const cols = useMemo(() => ty.properties.filter((p) => p.primary && p.type !== 'json'), [ty.id]);
  const counts = useQuery(() => store.countByType(), [storeTick.value]);
  const rows = useQuery(() => store.listObjects(ty.id, { limit: 5000, includeExpired: expired, props: cols.map((c) => c.id) }), [storeTick.value, ty.id, expired]);

  const shown = useMemo(() => {
    if (!rows) return [] as ObjectSummary[];
    const f = filter.trim().toLowerCase();
    let r = rows.filter((o) => o.type === ty.id);
    if (f) r = r.filter((o) => o.name.toLowerCase().includes(f) || o.id.toLowerCase().includes(f) || cols.some((c) => String(o.props?.[c.id] ?? '').toLowerCase().includes(f)));
    const val = (o: ObjectSummary) => (sort.key === 'name' ? o.name : sort.key === 'status' ? o.status : o.props?.[sort.key]);
    return [...r].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;            // unknowns last in both directions
      if (y == null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir;
    });
  }, [rows, filter, sort, ty.id]);

  const setSortKey = (key: string, numeric: boolean) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: numeric ? -1 : 1 }));
  const Th = ({ k, label, numeric, unit }: { k: string; label: string; numeric?: boolean; unit?: string }) => (
    <th class={(numeric ? 'r ' : '') + (sort.key === k ? 'sorted' : '')} aria-sort={sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
      <button onClick={() => setSortKey(k, !!numeric)}>
        <span>{label}{unit ? <i> {unit}</i> : null}</span>
        <span class="sort-mark">{sort.key === k ? (sort.dir > 0 ? '▲' : '▼') : ''}</span>
      </button>
    </th>
  );
  const groups = [...new Set(store.ontology.objectTypes.map((x) => x.group))];
  const total = shown.length;
  return (
    <div class="pane explorer">
      <header class="pane-head pane-head-col">
        <div class="ex-controls">
          <label class="field field-inline">
            <span class="type-badge" style={{ '--c': ty.color } as any}><Icon name={ty.icon} size={14} /></span>
            <select aria-label={t('ex.type')} value={ty.id} onChange={(e) => { explorerType.value = (e.target as HTMLSelectElement).value; setSort({ key: 'name', dir: 1 }); }}>
              {groups.map((g) => (
                <optgroup key={g} label={t('grp.' + g)}>
                  {store.ontology.objectTypes.filter((x) => x.group === g).map((x) => <option key={x.id} value={x.id}>{L(x.plural)}{counts ? ` (${num(counts[x.id] ?? 0)})` : ''}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <input class="text" type="search" placeholder={t('ex.filter')} aria-label={t('ex.filter')} value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
        </div>
        <div class="ex-meta">
          <span class="num">{rows ? (total > CAP ? `${t('ex.showing')} ${CAP} ${t('ex.of')} ${num(total)}` : `${num(total)} ${t('ex.rows')}`) : '—'}</span>
          {ty.ephemeral && (
            <label class="check">
              <input type="checkbox" checked={expired} onChange={(e) => setExpired((e.target as HTMLInputElement).checked)} />
              <span class="check-mark" /><span>{t('ex.expired')}</span>
            </label>
          )}
        </div>
      </header>
      <div class="pane-scroll table-wrap">
        {rows && total === 0 ? <p class="muted pad">{filter ? t('ex.nomatch') : t('ex.empty')}</p> : (
          <table class="grid">
            <thead>
              <tr>
                <Th k="name" label={t('ex.name')} />
                {cols.map((c) => <Th key={c.id} k={c.id} label={L(c.label)} numeric={c.type === 'number' || c.type === 'date'} unit={c.format === 'pct' || c.format === 'usd' ? '' : unitLabel(c.unit)} />)}
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, CAP).map((o) => (
                <tr key={o.id} class={S.selectedId.value === o.id ? 'is-selected' : ''} tabIndex={0} onClick={() => S.select(o.id, { fly: true })}
                  onKeyDown={(e) => { if (e.key === 'Enter') S.select(o.id, { fly: true }); }}>
                  <td class="name-cell" title={o.id}>{o.name || o.key}</td>
                  {cols.map((c) => { const f = formatProp(c, o.props?.[c.id]); return <td key={c.id} class={f.numeric ? 'r num' : ''}>{f.text}</td>; })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
