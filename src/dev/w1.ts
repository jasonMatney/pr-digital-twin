// Test page for the markers and labels layer on the full scene.
//   ?on=school,clinic   also show these object types   ?all=1   show every type   (plus the app flags: ?cam ?fixtures ?ui=0 ...)
import * as S from '../core/state';
import { params, flag } from '../core/config';
import { bootApp } from '../app';
import { mountUI } from '../ui/index';
import { createMarkers } from '../world/markers';

const on = params.get('on')?.split(',').filter(Boolean) ?? [];
if (on.length || flag('all')) {
  const next = { ...S.layerOn.value };
  if (flag('all')) for (const k in next) next[k] = true;
  for (const k of on) next[k] = true;
  S.layerOn.value = next;
}
bootApp({ layers: [createMarkers], ui: mountUI });
