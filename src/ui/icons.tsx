// One icon set, one stroke: 16-unit grid, 1.4 stroke, round joins, no fills except small dots.
// Names match `ObjectTypeDef.icon` in ontology.json, plus the chrome glyphs the panels need.
import type { JSX } from 'preact';

const P: Record<string, JSX.Element> = {
  // ---- ontology ----
  boundary: <><path d="M2.5 4.5 6 3l4 1.5L13.5 3v8.5L10 13l-4-1.5L2.5 13z" stroke-dasharray="2.2 1.6" /><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" /></>,
  bolt: <path d="M9 1.8 3.8 9H8l-1 5.2L12.2 7H8z" />,
  shelter: <><path d="M1.8 8.2 8 2.5l6.2 5.7" /><path d="M3.6 7v6.4h8.8V7" /><path d="M6.6 13.4V9.6h2.8v3.8" /></>,
  housing: <><path d="M2.5 13.5v-9h5v9" /><path d="M7.5 7h6v6.5" /><path d="M1.5 13.5h13" /><path d="M4.4 6.7h1.2M4.4 9.2h1.2M9.9 9.4h1.2" /></>,
  hospital: <><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M8 5.2v5.6M5.2 8h5.6" /></>,
  school: <><path d="M1.5 6.2 8 3l6.5 3.2L8 9.4z" /><path d="M4.2 7.8v3.1c1 .9 2.3 1.4 3.8 1.4s2.8-.5 3.8-1.4V7.8" /><path d="M14.5 6.2v3.6" /></>,
  fire: <path d="M8 1.8c.4 2.4 3.8 4 3.8 7.3A3.8 3.8 0 0 1 8 13.9a3.8 3.8 0 0 1-3.8-3.8c0-1.4.7-2.4 1.6-3.2.2 1.1.8 1.7 1.4 1.9C6.9 6.600 7 4.200 8 1.800z" />,
  police: <><path d="M8 1.8 13 3.6v4.2c0 3-2 5.2-5 6.400-3-1.200-5-3.400-5-6.400V3.600z" /><path d="m6 7.900 1.500 1.500L10.200 6.600" /></>,
  drop: <path d="M8 1.900c2.300 3 4.200 5.200 4.200 7.700A4.200 4.200 0 0 1 8 13.900a4.200 4.200 0 0 1-4.200-4.300C3.800 7.100 5.700 4.900 8 1.900z" />,
  plane: <path d="M8 1.600c.700 0 1.100.900 1.100 2.200v2.300l5 3v1.500l-5-1.500v2.800l1.600 1.200v1.200L8 13.600l-2.700.700v-1.200l1.600-1.200V9.100l-5 1.500V9.100l5-3V3.800c0-1.300.400-2.200 1.100-2.200z" />,
  anchor: <><circle cx="8" cy="3.400" r="1.500" /><path d="M8 4.900v9" /><path d="M5.400 7.400h5.200" /><path d="M2.600 9.800c.300 2.400 2.500 4.100 5.400 4.100s5.100-1.700 5.400-4.100" /></>,
  gauge: <><path d="M4.500 1.800v12.400" /><path d="M4.500 3.200h2.400M4.500 5.800h1.500M4.500 8.400h2.400M4.500 11h1.500" /><path d="M8.300 12.200c.900-.800 1.800-.800 2.700 0s1.800.800 2.700 0" /><path d="M8.300 9.400c.900-.800 1.800-.800 2.700 0s1.800.800 2.700 0" /></>,
  wave: <><path d="M1.500 6c1.100-1.200 2.200-1.200 3.300 0s2.100 1.200 3.200 0 2.200-1.200 3.300 0 2.100 1.200 3.200 0" /><path d="M1.500 10.400c1.100-1.200 2.200-1.200 3.300 0s2.100 1.200 3.200 0 2.200-1.200 3.300 0 2.100 1.200 3.200 0" /></>,
  buoy: <><path d="M8 1.600v3" /><path d="M6.300 2.600h3.400" /><path d="M5.600 4.600h4.800l1.400 6H4.200z" /><path d="M1.500 12.800c1.100-.900 2.200-.900 3.300 0s2.100.900 3.200 0 2.200-.900 3.300 0 2.100.900 3.200 0" /></>,
  wind: <><path d="M1.800 5.800h7.400a1.900 1.900 0 1 0-1.900-1.900" /><path d="M1.800 8.400h10.600a1.900 1.900 0 1 1-1.900 1.900" /><path d="M1.800 11h4.600" /></>,
  alert: <><path d="M8 2.200 14.300 13H1.700z" /><path d="M8 6.400v3.200" /><circle cx="8" cy="11.200" r=".7" fill="currentColor" stroke="none" /></>,
  quake: <path d="M1.300 8.400h2.300l1.200-3.600 1.900 7.600 2-10 1.700 8.200 1.200-2.200h3.100" />,
  cyclone: <><circle cx="8" cy="8" r="1.700" /><path d="M8 3.600c2.600 0 4.600 1.800 4.600 4.200" /><path d="M8 12.400c-2.600 0-4.600-1.800-4.600-4.200" /><path d="M12.600 7.800c1.200-.900 1.800-2.400 1.600-4.400" /><path d="M3.400 8.200c-1.200.900-1.800 2.400-1.600 4.400" /></>,
  fema: <><path d="M3.500 1.800h6.200l2.800 2.800v9.600h-9z" /><path d="M9.500 1.800v3h3" /><path d="M5.600 8h4.800M5.600 10.600h4.800" /></>,
  // ---- chrome ----
  search: <><circle cx="7" cy="7" r="4.300" /><path d="m10.300 10.300 3.700 3.700" /></>,
  layers: <><path d="M8 2 14 5.200 8 8.400 2 5.200z" /><path d="m2 8.200 6 3.200 6-3.200" /><path d="m2 11 6 3.200 6-3.200" /></>,
  scene: <><path d="M1.500 12.500 6 5.500l3 4.300 1.800-2.300 3.700 5z" /><circle cx="11.800" cy="3.800" r="1.300" /></>,
  overlay: <><rect x="2" y="2" width="8.500" height="8.500" rx=".8" /><rect x="5.500" y="5.500" width="8.500" height="8.500" rx=".8" stroke-dasharray="2 1.500" /></>,
  inbox: <><path d="M2 9.200 4 3h8l2 6.200V13H2z" /><path d="M2 9.200h3.500l.9 1.800h3.200l.9-1.800H14" /></>,
  object: <><path d="M8 1.800 13.500 5v6L8 14.200 2.500 11V5z" /><path d="M2.500 5 8 8.200 13.500 5M8 8.200v6" /></>,
  table: <><rect x="2" y="2.500" width="12" height="11" rx=".8" /><path d="M2 6h12M2 9.700h12M6.200 6v7.500" /></>,
  lineage: <><circle cx="3.500" cy="8" r="1.600" /><circle cx="12.500" cy="3.600" r="1.600" /><circle cx="12.500" cy="12.400" r="1.600" /><path d="M5.100 8c3 0 2.800-4.400 5.800-4.400M5.100 8c3 0 2.800 4.400 5.800 4.400" /></>,
  close: <path d="m3.500 3.500 9 9M12.500 3.500l-9 9" />,
  chevDown: <path d="m3.500 6 4.500 4.500L12.500 6" />,
  chevUp: <path d="m3.500 10.500 4.500-4.500 4.500 4.500" />,
  chevRight: <path d="m6 3.500 4.500 4.500L6 12.500" />,
  play: <path d="M4.500 3v10l8.500-5z" />,
  pause: <path d="M5 3v10M11 3v10" />,
  fly: <><circle cx="8" cy="8" r="2" /><path d="M8 1.500v2.700M8 11.800v2.700M1.500 8h2.700M11.800 8h2.700" /></>,
  copy: <><rect x="5.500" y="5.500" width="8" height="8" rx=".8" /><path d="M10.500 5.500v-3h-8v8h3" /></>,
  note: <><path d="M2.500 2.500h11v7.500l-3.500 3.500h-7.500z" /><path d="M10 13.500V10h3.500" /><path d="M5 5.500h6M5 8h3.500" /></>,
  flag: <><path d="M3.500 14.200V2" /><path d="M3.500 2.800h8.700l-2 2.900 2 2.900H3.500" /></>,
  link: <><path d="M6.800 9.200a2.800 2.800 0 0 0 4 0l2.200-2.200a2.800 2.800 0 0 0-4-4l-.900.900" /><path d="M9.200 6.800a2.800 2.800 0 0 0-4 0L3 9a2.800 2.800 0 0 0 4 4l.900-.900" /></>,
  external: <><path d="M9 2.500h4.500V7" /><path d="M13.500 2.500 7.500 8.500" /><path d="M11.500 9.500v4h-9v-9h4" /></>,
  sun: <><circle cx="8" cy="8" r="2.600" /><path d="M8 1.500v1.700M8 12.800v1.700M1.500 8h1.700M12.800 8h1.700M3.400 3.400l1.200 1.200M11.400 11.400l1.200 1.200M3.400 12.600l1.200-1.200M11.400 4.600l1.200-1.200" /></>,
  dot: <circle cx="8" cy="8" r="2.500" fill="currentColor" stroke="none" />,
};

export function Icon({ name, size = 16, class: cls, title }: { name: string; size?: number; class?: string; title?: string }) {
  const body = P[name] ?? P.dot;
  return (
    <svg class={'ico ' + (cls ?? '')} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined} aria-label={title}>
      {body}
    </svg>
  );
}
export const hasIcon = (name: string) => name in P;

/** The mark: a garita, the domed sentry box on the walls of El Morro, seen from the sea side. */
export function GaritaMark({ size = 22 }: { size?: number }) {
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 1.800v1.600" />
      <path d="M7.600 9.200c0-3.300 1.900-5.800 4.400-5.800s4.400 2.500 4.400 5.800" />
      <path d="M6.400 9.200h11.200" />
      <path d="M7.800 9.200v7.200h8.400V9.200" />
      <path d="M11.200 11.400v3h1.600v-3z" fill="var(--flame)" stroke="var(--flame)" stroke-width="1" />
      <path d="M6.600 16.400h10.800l-1.800 2.600h-7.200z" />
      <path d="M2 22.200h20" />
      <path d="M9.800 19v3.200M14.200 19v3.200" />
    </svg>
  );
}
