// A layer is anything drawn in the scene on top of terrain, sky and sea: markers, buildings, outlines, storms.
// Layers are created once the store is open; they read app state (core/state.ts) and the store, never the UI.
import type * as THREE from 'three';
import type { Engine } from './engine';
import type { Frame, World } from './types';
import type { TwinStore } from '../ontology/types';

export interface LayerContext {
  world: World;
  engine: Engine;
  store: TwinStore;
  /** Register a picker. On a click (pointer up without a drag) pickers run in descending priority until one returns true. */
  onPick(priority: number, fn: Picker): () => void;
  /** Same, for hover (throttled to about 10 Hz). Return true when the pointer is over something of yours. */
  onHover(priority: number, fn: Picker): () => void;
}
export interface PickEvent {
  /** Pointer in CSS pixels relative to the canvas, and in normalised device coordinates. */
  x: number; y: number; ndc: THREE.Vector2;
  /** World-space ray from the camera through the pointer. */
  origin: THREE.Vector3; dir: THREE.Vector3;
  /** Where the ray meets the terrain (curved world position), or null. Computed lazily, once per event. */
  ground(): THREE.Vector3 | null;
  shift: boolean;
}
export type Picker = (e: PickEvent) => boolean;
export interface Layer { update?(frame: Frame): void; dispose(): void }
export type LayerFactory = (ctx: LayerContext) => Layer | Promise<Layer>;
