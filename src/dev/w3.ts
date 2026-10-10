// Test page for the overlays, the municipio boundaries and the storm replay.
//   ?overlay=radar|goes|nfhl|slr|choropleth|elevation   ?prop=<municipio property>   ?opacity=<0..1>
//   ?storm=<id in data/replay/storms.json>&t=<ISO>   ?select=<object id>   plus the flags of app.ts (?cam ?sea ?ui=0 ?nofeeds=1 ...)
import { effect } from '@preact/signals';
import * as S from '../core/state';
import { params } from '../core/config';
import { bootApp } from '../app';
import { mountUI } from '../ui/index';
import { createOverlays } from '../world/overlays';
import { createBoundaries } from '../world/boundaries';
import { availableChoroplethProps } from '../world/choropleth';
import { createStorms, liveCyclones, replayInfo, stormLegend } from '../world/storms';

if (params.get('prop')) S.choroplethProp.value = params.get('prop')!;
if (params.has('opacity')) S.overlayOpacity.value = +params.get('opacity')!;
const storm = params.get('storm');
if (storm) {
  S.replayStormId.value = storm;
  S.clockMode.value = 'manual';
  const t = params.get('t');
  if (t && !Number.isNaN(Date.parse(t))) S.sceneTime.value = Date.parse(t);
}
bootApp({ layers: [createOverlays, createBoundaries, createStorms], ui: mountUI });
if (params.get('select')) S.selectedId.value = params.get('select');
(globalThis as any).__garita.replayInfo = replayInfo;
(globalThis as any).__garita.choroplethProps = () => availableChoroplethProps(S.store.value!, S.lang.value);
{ const g: any = (globalThis as any).__garita, d = g.debug; g.debug = () => ({ ...d(), w3: g.w3note ?? null, liveCyclones: liveCyclones.value, legend: S.overlayLegend.value, stormLegend: stormLegend.value && stormLegend.value.title, highlightIds: S.highlightIds.value.length, selectedId: S.selectedId.value }); }

// The site's UI does not draw the legend or the hover text yet: a plain read-out so they can be checked here.
const box = document.createElement('div');
box.style.cssText = 'position:fixed;left:10px;bottom:10px;max-width:300px;padding:10px 12px;border-radius:10px;background:rgba(5,15,21,.84);color:#e9f2ef;font:12px/1.4 system-ui,sans-serif;z-index:40;pointer-events:none;white-space:normal';
document.body.appendChild(box);
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
effect(() => {
  const l = S.overlayLegend.value ?? stormLegend.value, h = S.hoverText.value, r = replayInfo.value;
  let html = '';
  if (l) {
    html += `<b>${esc(l.title)}${l.unit ? ` (${esc(l.unit)})` : ''}</b>`;
    for (const s of l.stops) html += `<div><i style="display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:6px;vertical-align:-2px;background:${s.color}"></i>${esc(s.label)}</div>`;
    if (l.note) html += `<div style="opacity:.8;margin-top:4px">${esc(l.note)}</div>`;
    if (l.source) html += `<div style="opacity:.6;margin-top:4px">${esc(l.source)}</div>`;
  }
  if (r?.band_counts) html += `<div style="margin-top:6px">municipios inside 34 / 50 / 64 kt: ${r.band_counts[34]} / ${r.band_counts[50]} / ${r.band_counts[64]}</div>`;
  if (h) html += `<div style="margin-top:6px;color:#ffd166">${esc(h)}</div>`;
  box.innerHTML = html;
  box.style.display = html ? '' : 'none';
});
