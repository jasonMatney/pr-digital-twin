// Browser-side copy of the NHC forecast for each active Atlantic storm near Puerto Rico, for the scene (cone,
// track points). The same content is written to the store on the tropical_cyclone object (geometry, `advisory`,
// `forecast_points`); this signal saves the scene a query.
import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { CycloneForecast, ForecastPoint } from './sources/nhcForecast.ts';

export type { CycloneForecast, ForecastPoint };
/** Keyed by storm id (e.g. 'al092026'). Replaced on every nhc run; storms that ended drop out. */
export const cycloneForecasts: Signal<Record<string, CycloneForecast>> = signal<Record<string, CycloneForecast>>({});
