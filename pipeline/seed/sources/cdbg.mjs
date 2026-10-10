// HUD low and moderate income areas for Puerto Rico's CDBG-DR grant, aggregated to tract and municipio.
import { fetchJson, arcgisAll, num, round, pick } from '../lib.mjs';
const SVC = 'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/LMA_PuertoRico_CDBG_DR/FeatureServer';
export async function build(ctx) {
  const svc = await fetchJson(`${SVC}?f=json`);
  ctx.probe('cdbg_layers', (svc.layers || []).map((l) => `${l.id} ${l.name}`));
  const layer = (svc.layers || [])[0];
  const { rows, fields, name } = await arcgisAll(`${SVC}/${layer.id}`, { log: ctx.log });
  ctx.probe('cdbg_fields', fields); ctx.probe('cdbg_sample', rows[0]);
  // Layer LowModTractCDBG-DR: Est_LowMod = estimated low/moderate income persons, Personas_T = persons in the universe, Est_LowM_1 = their ratio in percent.
  const fLow = fields.find((f) => /^(low_?mod|est_lowmod)$/i.test(f)), fUniv = fields.find((f) => /^(low_?mod_?univ|personas_t)$/i.test(f)), fGeo = fields.find((f) => /^(geoid|geoid10|geoid20|bg_?id|fips)$/i.test(f));
  if (!fLow || !fUniv) throw new Error(`no LOWMOD / LOWMODUNIV fields in ${name}: ${fields.join(',')}`);
  const muni = await ctx.municipios();
  const names = new Map(muni.rows.map((r) => [String(r.GEOID), String(r.BASENAME)]));
  const tr = new Map(), mu = new Map(); let bad = 0;
  for (const r of rows) {
    let g = String((fGeo ? r[fGeo] : null) ?? '').replace(/^15000US/, '').trim();
    if (!/^72\d{9,10}$/.test(g)) { const st = pick(r, ['STATE']), co = pick(r, ['COUNTY']), t = pick(r, ['TRACT']); g = st != null && co != null && t != null ? String(st).padStart(2, '0') + String(co).padStart(3, '0') + String(t).padStart(6, '0') : ''; }
    const low = num(r[fLow]), univ = num(r[fUniv]);
    if (!/^72\d{9}/.test(g) || low == null || univ == null || low > univ * 1.001) { bad++; continue; }
    for (const [m, k] of [[tr, g.slice(0, 11)], [mu, g.slice(0, 5)]]) { const a = m.get(k) || [0, 0]; a[0] += low; a[1] += univ; m.set(k, a); }
  }
  const objects = [];
  for (const [k, a] of tr) if (a[1] > 0) objects.push({ type: 'tract', key: k, props: { cdbg_dr_lmi_pct: round((100 * a[0]) / a[1], 1) } });
  for (const [k, a] of mu) if (a[1] > 0 && names.has(k)) objects.push({ type: 'municipio', key: k, name: names.get(k), props: { cdbg_dr_lmi_pct: round((100 * a[0]) / a[1], 1) } });
  return { file: '03-cdbg-lmi', problems: bad ? [`${bad} of ${rows.length} rows had no usable geography or counts`] : [], batch: { source: 'hud_cdbg_dr', fetchedAt: Date.now(), objects,
    note: `HUD LMA_PuertoRico_CDBG_DR layer "${name}" (${rows.length} rows, geography field ${fGeo}). cdbg_dr_lmi_pct = 100 x sum(${fLow}) / sum(${fUniv}) over the rows of each tract and each municipio. Tract ids are those of the layer's own census vintage and may not all match current (2020) tracts.` } };
}
