// The site's entry point. Scene layers are created once the store is open, in this order.
import { bootApp } from './app';
import { mountUI } from './ui/index';
import type { LayerFactory } from './world/layers';
import { createBoundaries } from './world/boundaries';
import { createOverlays } from './world/overlays';
import { createBuildings } from './world/buildings/index';
import { createStorms } from './world/storms';
import { createMarkers } from './world/markers';

const layers: LayerFactory[] = [createOverlays, createBoundaries, createBuildings, createStorms, createMarkers];
bootApp({ layers, ui: mountUI });
