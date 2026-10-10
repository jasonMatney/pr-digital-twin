// Disaster history: declarations (one object per disaster number) and housing-assistance impact per disaster x municipio.
import { openfemaAll, normMuni, num, round, clean } from '../lib.mjs';
const ms = (s) => { if (!s) return null; const t = Date.parse(s); return Number.isFinite(t) ? t : null; };

export async function build(ctx) {
  const muni = await ctx.municipios();
  const byGeoid = new Map(muni.rows.map((r) => [String(r.GEOID), String(r.BASENAME)]));
  const byName = new Map(muni.rows.map((r) => [normMuni(r.BASENAME), String(r.GEOID)]));
  const out = [];
  const now = Date.now();

  // ---- declarations ----
  const rows = await openfemaAll('DisasterDeclarationsSummaries', "state eq 'PR'", { log: ctx.log });
  const dis = new Map();
  for (const r of rows) {
    let d = dis.get(r.disasterNumber);
    if (!d) dis.set(r.disasterNumber, d = { first: r, areas: new Set(), statewide: false, ih: false, pa: false, hm: false, unknownAreas: new Set() });
    const g = `72${r.fipsCountyCode}`;
    if (r.fipsCountyCode === '000') d.statewide = true; else if (byGeoid.has(g)) d.areas.add(g); else d.unknownAreas.add(`${r.fipsCountyCode} ${r.designatedArea}`);
    d.ih ||= !!(r.ihProgramDeclared || r.iaProgramDeclared); d.pa ||= !!r.paProgramDeclared; d.hm ||= !!r.hmProgramDeclared;
  }
  const objects = [], links = [], perMuni = new Map(), problems = [];
  for (const [n, d] of [...dis].sort((a, b) => a[0] - b[0])) {
    const r = d.first;
    objects.push({ type: 'disaster_declaration', key: String(n), name: `${r.femaDeclarationString} ${r.declarationTitle}`, status: r.disasterCloseoutDate ? 'closed' : 'open',
      validFrom: ms(r.incidentBeginDate), validTo: ms(r.incidentEndDate), identities: [['fema:declaration', r.femaDeclarationString]],
      props: clean({ declaration_type: r.declarationType, incident_type: r.incidentType, title: r.declarationTitle, declared: ms(r.declarationDate), incident_begin: ms(r.incidentBeginDate), incident_end: ms(r.incidentEndDate),
        areas: d.areas.size || (d.statewide ? null : 0), ih_program: d.ih, pa_program: d.pa, hm_program: d.hm }),
      text: `${r.femaDeclarationString} ${r.incidentType}${d.statewide ? ' statewide' : ''}` });
    for (const g of d.areas) { links.push({ src: `disaster_declaration:${n}`, type: 'affects', dst: `municipio:${g}` }); perMuni.set(g, (perMuni.get(g) || 0) + 1); }
    if (d.unknownAreas.size) problems.push(`disaster ${n}: designated areas not matched to a municipio: ${[...d.unknownAreas].join('; ')}`);
  }
  for (const [g, name] of byGeoid) objects.push({ type: 'municipio', key: g, name, props: { fema_declarations: perMuni.get(g) || 0 } });
  out.push({ file: '30-declarations', problems, batch: { source: 'openfema_declarations', fetchedAt: now, objects, links,
    note: `OpenFEMA DisasterDeclarationsSummaries v2, state eq 'PR', ${rows.length} rows -> ${dis.size} declarations. areas = distinct designated municipios (fipsCountyCode); rows with fipsCountyCode 000 are statewide and add no municipio link. ih_program = ihProgramDeclared or iaProgramDeclared on any row. municipio.fema_declarations = declarations (DR, EM, FM) designating that municipio.` } });

  // ---- housing assistance ----
  const [own, ren] = [await openfemaAll('HousingAssistanceOwners', "state eq 'PR'", { log: ctx.log }), await openfemaAll('HousingAssistanceRenters', "state eq 'PR'", { log: ctx.log })];
  const agg = new Map(), unmatched = new Map();
  const cell = (r) => {
    const g = byName.get(normMuni(r.county));
    if (!g) { unmatched.set(r.county, (unmatched.get(r.county) || 0) + (num(r.validRegistrations) || 0)); return null; }
    const k = `${r.disasterNumber}-${g}`;
    let a = agg.get(k);
    if (!a) agg.set(k, a = { dn: r.disasterNumber, g, own: 0, ren: 0, insp: 0, dmg: 0, appr: 0, rep: 0, rent: 0, major: 0 });
    return a;
  };
  for (const r of own) { const a = cell(r); if (!a) continue; a.own += num(r.validRegistrations) || 0; a.insp += num(r.totalInspected) || 0; a.dmg += num(r.totalDamage) || 0; a.appr += num(r.totalApprovedIhpAmount) || 0; a.rep += num(r.repairReplaceAmount) || 0; a.rent += num(r.rentalAmount) || 0; a.major += num(r.femaInspectedDamageGreaterThan30000) || 0; }
  for (const r of ren) { const a = cell(r); if (!a) continue; a.ren += num(r.validRegistrations) || 0; a.insp += num(r.totalInspected) || 0; a.appr += num(r.totalApprovedIhpAmount) || 0; a.rep += num(r.repairReplaceAmount) || 0; a.rent += num(r.rentalAmount) || 0; a.major += (num(r.totalWithMajorDamage) || 0) + (num(r.totalWithSubstantialDamage) || 0); }
  const o2 = [], l2 = [], p2 = [];
  for (const [k, a] of agg) {
    const d = dis.get(a.dn)?.first;
    o2.push({ type: 'disaster_impact', key: k, name: `${d ? d.declarationTitle : `Disaster ${a.dn}`}: ${byGeoid.get(a.g)}`, validFrom: d ? ms(d.incidentBeginDate) : null, validTo: d ? ms(d.incidentEndDate) : null,
      props: clean({ disaster_number: a.dn, municipio_name: byGeoid.get(a.g), valid_registrations: a.own + a.ren, owner_registrations: a.own, renter_registrations: a.ren, total_inspected: a.insp,
        total_damage_usd: round(a.dmg, 2), approved_usd: round(a.appr, 2), repair_replace_usd: round(a.rep, 2), rental_usd: round(a.rent, 2), major_damage_homes: a.major }) });
    if (dis.has(a.dn)) l2.push({ src: `disaster_impact:${k}`, type: 'record_of', dst: `disaster_declaration:${a.dn}` });
    l2.push({ src: `disaster_impact:${k}`, type: 'record_of', dst: `municipio:${a.g}` });
    if (a.dn === 4339) o2.push({ type: 'municipio', key: a.g, name: byGeoid.get(a.g), props: { ihp_registrations_maria: a.own + a.ren, ihp_approved_usd_maria: round(a.appr, 2) } });
  }
  for (const [c, n] of unmatched) p2.push(`county "${c}" not matched to a municipio (${n} registrations left out)`);
  const missingDecl = [...new Set([...agg.values()].map((a) => a.dn))].filter((n) => !dis.has(n));
  if (missingDecl.length) p2.push(`disaster numbers in the PR housing data that have no PR declaration row (impact objects kept, no link to a declaration): ${missingDecl.join(', ')}`);
  out.push({ file: '31-housing-assistance', problems: p2, batch: { source: 'openfema_housing', fetchedAt: now, objects: o2, links: l2,
    note: `OpenFEMA HousingAssistanceOwners v2 (${own.length} rows) + HousingAssistanceRenters v2 (${ren.length} rows), state eq 'PR', summed from disaster x county x city x zip to disaster x municipio (county name normalised and matched to TIGER names). valid_registrations, total_inspected, approved_usd, repair_replace_usd, rental_usd = owners + renters. total_damage_usd = owners totalDamage only (the renters dataset has no dollar damage). major_damage_homes = owners with FEMA-inspected damage > $30,000 + renters with major or substantial damage. ihp_*_maria = DR-4339 row for the municipio.` } });
  return out;
}
