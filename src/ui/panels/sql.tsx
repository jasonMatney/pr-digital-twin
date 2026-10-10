// SQL console: read-only SQL straight against the store. Saved queries live in ../saved-queries.ts and are tested
// against the published seed. Errors are shown exactly as the database reports them.
import { useState } from 'preact/hooks';
import type { TwinStore } from '../../ontology/types';
import { SCHEMA_DOC } from '../../ontology/schema';
import * as S from '../../core/state';
import { tr } from '../../i18n/index';
import { Icon } from '../icons';
import { num } from '../format';
import { useQuery, typeDef } from '../uistate';
import { SAVED_QUERIES } from '../saved-queries';

const CAP = 500;
interface Result { cols: string[]; rows: Record<string, any>[]; ms: number; error?: string }
// Kept at module level so switching tabs does not lose the query or its result.
const keep: { sql: string; res: Result | null; saved: string } = { sql: SAVED_QUERIES[0].sql, res: null, saved: SAVED_QUERIES[0].id };

const isObjectId = (v: any) => typeof v === 'string' && /^[a-z_]+:\S/.test(v) && !!typeDef(v.slice(0, v.indexOf(':')));
function cell(v: any) {
  if (v == null) return <span class="muted">null</span>;
  if (isObjectId(v)) return <button class="sql-id" title={tr('Open this object', 'Abrir este objeto')} onClick={() => S.select(v, { fly: true })}>{v}</button>;
  if (typeof v === 'number') return Number.isInteger(v) ? num(v) : String(Math.round(v * 1000) / 1000);
  return String(v);
}

export function SqlPanel({ store }: { store: TwinStore }) {
  const [sql, setSqlState] = useState(keep.sql);
  const [res, setResState] = useState<Result | null>(keep.res);
  const [busy, setBusy] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const setSql = (s: string) => { keep.sql = s; setSqlState(s); };
  const cols = useQuery(async () => {
    if (!schemaOpen) return null;
    const names = Object.keys(SCHEMA_DOC);
    const out: Record<string, string[]> = {};
    await Promise.all(names.map(async (n) => {
      try { out[n] = (await store.query<{ name: string; type: string }>(`SELECT name, type FROM pragma_table_info('${n}')`)).map((c) => (c.type ? `${c.name} ${String(c.type).toLowerCase()}` : c.name)); } catch { out[n] = []; }
    }));
    return out;
  }, [schemaOpen]);
  const run = async (text = sql) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const t0 = performance.now();
    let r: Result;
    try {
      const rows = await store.query(text);
      r = { cols: rows.length ? Object.keys(rows[0]) : [], rows, ms: performance.now() - t0 };
    } catch (e: any) { r = { cols: [], rows: [], ms: performance.now() - t0, error: String(e?.message ?? e) }; }
    keep.res = r; setResState(r); setBusy(false);
  };
  return (
    <div class="pane sql">
      <header class="pane-head pane-head-col">
        <label class="field field-inline">
          <select aria-label={tr('Saved queries', 'Consultas guardadas')} value={keep.saved}
            onChange={(e) => { const q = SAVED_QUERIES.find((x) => x.id === (e.target as HTMLSelectElement).value); if (q) { keep.saved = q.id; setSql(q.sql); run(q.sql); } }}>
            {SAVED_QUERIES.map((q) => <option key={q.id} value={q.id}>{tr(q.title[0], q.title[1])}</option>)}
          </select>
        </label>
        <textarea class="sql-editor num" rows={8} spellcheck={false} value={sql} aria-label="SQL"
          onInput={(e) => setSql((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } }} />
        <div class="sql-bar">
          <button class="btn primary" disabled={busy} onClick={() => run()}><Icon name="play" size={12} />{tr('Run', 'Ejecutar')}</button>
          <kbd class="num muted">Ctrl/⌘ + Enter</kbd>
          <span class="sql-meta num">{res && !res.error ? `${num(res.rows.length)} ${tr('rows', 'filas')} · ${res.ms < 10 ? res.ms.toFixed(1) : Math.round(res.ms)} ms${res.rows.length > CAP ? ` · ${tr('showing first', 'se muestran las primeras')} ${CAP}` : ''}` : busy ? '…' : ''}</span>
          <button class="link-btn" aria-expanded={schemaOpen} onClick={() => setSchemaOpen(!schemaOpen)}>{tr('Schema', 'Esquema')}</button>
        </div>
        <p class="muted sql-note">{tr('Read-only: SELECT, WITH, EXPLAIN. Times are epoch milliseconds UTC.', 'Solo lectura: SELECT, WITH, EXPLAIN. Las horas son milisegundos epoch UTC.')}</p>
      </header>
      <div class="pane-scroll table-wrap">
        {res?.error && <pre class="sql-error num">{res.error}</pre>}
        {schemaOpen && (
          <section class="sec sql-schema">
            <h3 class="label">{tr('Tables and views', 'Tablas y vistas')}</h3>
            <dl>{Object.entries(SCHEMA_DOC).map(([name, doc]) => (
              <div key={name}>
                <dt><button class="sql-id" onClick={() => setSql(`SELECT * FROM ${name} LIMIT 50`)}>{name}</button></dt>
                <dd>{doc}{cols?.[name]?.length ? <span class="num sql-cols">{cols[name].join(', ')}</span> : null}</dd>
              </div>))}</dl>
          </section>
        )}
        {res && !res.error && res.rows.length === 0 && <p class="muted pad">{tr('The query returned no rows.', 'La consulta no devolvió filas.')}</p>}
        {res && !res.error && res.rows.length > 0 && (
          <table class="grid sql-table">
            <thead><tr>{res.cols.map((c) => <th key={c} class={typeof res.rows[0][c] === 'number' ? 'r' : ''}><span class="sql-th">{c}</span></th>)}</tr></thead>
            <tbody>{res.rows.slice(0, CAP).map((r, i) => (
              <tr key={i}>{res.cols.map((c) => <td key={c} class={typeof r[c] === 'number' ? 'r num' : 'num'} title={typeof r[c] === 'string' && r[c].length > 24 ? r[c] : undefined}>{cell(r[c])}</td>)}</tr>))}</tbody>
          </table>
        )}
        {!res && !schemaOpen && <p class="muted pad">{tr('Pick a saved query or write your own, then Run.', 'Escoge una consulta guardada o escribe la tuya y pulsa Ejecutar.')}</p>}
      </div>
    </div>
  );
}
