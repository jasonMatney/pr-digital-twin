// The site's entry point. Scene layers are listed here in draw-independent order.
import { bootApp } from './app';
import { mountUI } from './ui/index';
import type { LayerFactory } from './world/layers';

const layers: LayerFactory[] = [];
bootApp({ layers, ui: mountUI });
