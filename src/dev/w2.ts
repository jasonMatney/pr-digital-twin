// Test page for the buildings layer: the whole scene, no UI.
//   ?cam=lon,lat,range,heading,pitch  ?t=<ISO>  ?sea=<m>  ?overlay=nfhl  ?q=low|medium|high  ?pump=1 (see app.ts)
import { bootApp } from '../app';
import { createBuildings } from '../world/buildings/index';

bootApp({ layers: [createBuildings] });
