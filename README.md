# Garita

*A live digital twin of Puerto Rico for housing recovery and disaster response.* Real terrain, aerial photo and
bathymetry; 1.5 million buildings; live public feeds; and an ontology-backed database that runs in the browser.
Named for the sentry boxes on the walls of Old San Juan.

**[Open the twin → webgpu-demos.github.io/garita](https://webgpu-demos.github.io/garita/)**

An independent demonstrator. Not affiliated with the Departamento de la Vivienda, FEMA, HUD, NOAA or USGS, and
not for operational use.

It follows three references: [`simplifaisoul/osiris`](https://github.com/simplifaisoul/osiris) for the genre
(feeds on a map, layers, a heads-up display), and adds the two things that project lacks, an ontology and a
store; [`clear-Vieques`](https://github.com/webgpu-demos/clear-Vieques) for water shaded from real depth; and
[`procedural-sanjuan`](https://github.com/webgpu-demos/procedural-sanjuan) for the sky, clouds and buildings.

## What it does

- **The island in 3D, from orbit to street level.** A streamed quadtree of USGS elevation and aerial photo, NOAA
  bathymetry merged in near shore, a physical sky with aerial perspective and volumetric clouds, an ocean shaded
  from the actual water depth, sun shadows near the ground, town lights at night, and the scene clock on San
  Juan time.
- **Buildings.** 1,500,471 OpenStreetMap footprints, each with its ground elevation and FEMA flood class, roofed
  with the aerial photo itself.
- **A database, not a pile of layers.** About 7,000 seeded objects of 25 types (municipios, barrios, tracts,
  public housing, shelters, hospitals, gauges, tide stations, disaster declarations…; four more types are filled
  only by live feeds), 12,800 typed links and 58,000 property values. Every value carries its source and a time:
  the measurement's own time for live feeds, the time it was fetched for most baked sources. A fifth of the
  values are computed by Garita (ground elevation, flood zone, counts) and are marked as derived. SQLite compiled to WebAssembly,
  persisted in the browser, queryable from a SQL console in the app.
- **Live feeds** written into that same store: weather alerts, earthquakes, stream and reservoir gauges, flood
  stages, tides, weather and sea state, power outages, buoys, tropical cyclones with forecast cones, aircraft.
- **Questions the Department would ask.** Raise the sea and count what sits at or below it, by municipio, with
  NOAA's scenarios for San Juan as presets and NOAA's own inundation mapping as a comparison overlay. Replay
  María or any of 29 other storms since 1980. For the 19 with wind radii in the record (2004 on), see which
  municipios and how many of today's residents fall inside each wind radius, and which of today's public housing
  developments and listed shelters fall inside the 64 kt radius, hour by hour. Open any object and walk its links.

## What is real, what is modelled, what is procedural

**Real, with its source recorded in the store or in the tile index:**

| What | Source | Notes |
|---|---|---|
| Terrain | USGS 3DEP through AWS Terrain Tiles | 10 m on land; mirrored to zoom 12 island-wide, streamed to zoom 15 |
| Nearshore depth | NOAA NCEI CUDEM topo-bathy, 1/9″ and 1/3″ (doi:10.25921/ds9v-ky35) | Used wherever it has data below +1 m; 1,136 tiles |
| Aerial photo | USGS The National Map orthoimagery | Public domain; mirrored to zoom 13, streamed to zoom 16 |
| Building footprints | OpenStreetMap (Geofabrik Puerto Rico extract), ODbL | 1,500,471; 13.8 % carry a height |
| Ground elevation per building | 3DEP at the footprint centroid | One point per building; the source terraces at whole metres in coastal plains |
| Flood class per building | FEMA National Flood Hazard Layer, 4,894 zone polygons | Point in polygon at the centroid. Facilities, housing and shelters use a reduced file of 3,830 polygons |
| Municipios, barrios, tracts | US Census TIGERweb | 78 / 901 / 981. The Census counts 939 county subdivisions; the 38 that are water only are left out. 42 of the tracts are water only |
| Vulnerability and housing stock | CDC/ATSDR SVI 2022; ACS 5-year through Esri Living Atlas | Municipio and tract level |
| Public and assisted housing | HUD: Public Housing Developments (304), Multifamily Assisted (196), LIHTC (231) | |
| Low and moderate income areas | HUD, Puerto Rico CDBG-DR | |
| Emergency shelters | Departamento de la Vivienda, *Refugios, Temporada de Huracanes 2026* | 343 listed; 332 located from the list's own map links, 4 by matching the name in OpenStreetMap, 7 not located |
| Disaster history | OpenFEMA: 51 declarations, housing assistance by disaster and municipio | |
| Facilities | OpenStreetMap: hospitals, clinics, schools, fire, police, power, water, air and sea ports | 3,083. Only named ones are kept, except substations and power plants: 267 of those have no name in OpenStreetMap and are labelled "Unnamed" |
| Sensors' reference data | NOAA CO-OPS, USGS, NWS/NWPS, NDBC | Datums, flood stages, sea level projections |
| Storm tracks | NOAA HURDAT2 | 30 storms whose centre passed within 100 km of a municipio's interior point since 1980; 11 predate wind radii in the record |

**Live** (age shown in the Lineage panel): NWS alerts and observations, USGS earthquakes and gauges, NOAA flood
categories and tides, Open-Meteo wind, cloud, waves and Saharan dust (model output, labelled as such), RainViewer
radar, NASA GOES imagery, FEMA and NOAA map overlays. Four sources send no CORS headers (NHC, NDBC, LUMA outages,
ADS-B); a scheduled job relays them every five minutes, so aircraft positions are minutes old and say so.

**Modelled, screening level:** the sea-level panel is a bathtub: one ground elevation per structure against a
flat water level. No waves, drainage, levees or hydraulic connection. The panel says so and offers NOAA's
connected-inundation mapping beside it. Storm-replay counts use each wind radius's maximum extent per quadrant,
so the true area is smaller.

**Procedural:** clouds and waves (driven by live wind and cloud cover, not observed), building heights where
OpenStreetMap has none (the tooltip says "height estimated"), wall colours and windows, town lights (placed where
the building data and the photo show built-up ground).

Nothing is invented and presented as data. There are no synthetic cases, inspections or grants.

## The store and the ontology

`src/ontology/ontology.json` defines object types, link types and sources as data. Everything the twin knows is
an object (`<type>:<key>`, keyed by the type's canonical id: Census GEOID, USGS site number, NOAA station id,
HUD development code, OSM id), a typed link, a property value from one source at one time, or an observation.
Two sources naming the same thing merge through an identity table; two sources disagreeing on a value are both
kept and both shown. Baked data, live feeds and notes typed into the app all enter through one function,
`ingest(batch)`, so there is one lineage and one audit log.

The same engine (`src/ontology/engine.ts`) runs in a Web Worker in the browser and in Node, where the pipeline
uses it to build `data/twin.db`, the 10 MB seed the site ships. In the browser the database lives in OPFS, so
history accumulates across visits; a second tab opens in memory.

The in-app SQL console is read-only and comes with ten saved queries, each run against the seed before it was
added: public housing developments and units by municipio and the share of developments whose HUD point is in a FEMA flood zone, shelters at or below 3 m,
María's housing assistance per registration, properties where sources disagree.

## Run it

```bash
npm install
git worktree add site gh-pages        # tiles/ and data/ live on the gh-pages branch
SITE_DIR=site npm run dev             # http://127.0.0.1:5280
npm test                              # store and feed mappers, on recorded real payloads
```

URL flags: `?cam=lon,lat,range,heading,pitch` · `?t=<ISO time>` · `?sea=<metres>` · `?overlay=radar|goes|nfhl|slr|choropleth|elevation`
· `?q=low|medium|high` · `?lang=es` · `?ui=0` · `?fixtures=1` (recorded feeds, no network) · `?post=basic` (analytic sky).

Controls: drag pans; right-drag or Ctrl-drag rotates and tilts; the wheel zooms to the cursor; double-click
flies; ⌘K or `/` searches; click anything to open it.

## How it is built

There is no server. The site is static files on GitHub Pages.

- **Baked data** is fetched and compiled by GitHub Actions (`pipeline/`, one workflow per stage: tiles, vector,
  bathymetry, seed) and committed to `gh-pages`. The development sandbox had no route to any data host, so the
  runner is also where the pipeline was developed: push, run, pull, look.
- **The relay** (`.github/workflows/relay.yml`) snapshots the four sources without CORS to the `relay` branch.
  One run covers half an hour and queues the next. To stop it, disable the workflow in the Actions tab.
- **Screenshots** for review are rendered on a runner too (`tools/cloudshot.sh`, software GL, live network), and
  locally on mirrored tiles (`tools/shot.sh`).

```
src/core/        world frame and tile maths, app state, storm maths
src/ontology/    types (the contract), ontology.json, schema, engine, worker, Node build
src/feeds/       one mapper per live source, scheduler, fixtures
src/world/       terrain quadtree, sky and ocean, buildings, markers, overlays, boundaries, storms
src/ui/          panels (Preact): alerts, object, scenario, replay, explorer, graph, SQL, lineage
pipeline/        scripts the Actions runner executes
tests/           node:test on recorded payloads
docs/critique/   before/after stills from each review round
```

`ARCHITECTURE.md` has the contracts between the parts.

## Review rounds

Each round: render, find what is visibly wrong, fix the cause. Stills are in `docs/critique/`.

| Found | Cause and fix | Stills |
|---|---|---|
| Brown seabed, sand-coloured lowlands | Photo graded and classified; seabed painted for the ocean pass to tint | `r1-02…06` |
| Clouds as specks from orbit, grey-lavender smoke up close | Cumulus at 600–2,200 m in fields with lanes; a 2D cloud field takes over above 60–150 km | `r2-09…12` |
| White static on the sea near San Juan | Foam flickering where the seabed sat exactly at sea level in the depth buffer | `r2-09/10` |
| A white slab in the sea north of San Juan | The photo service paints no-data white; a coverage mask built from a 5×5 test | `r1-09…12` |
| Beaded shorelines, stepped shallows, pale platforms off Old San Juan | Lidar water-surface returns at ±1 m; CUDEM is now the surface wherever it has data below +1 m | `r1-17…20`, `r1-23/24` |
| Town lights spread evenly over the mountains | Weighted by building density from the 1.5 M footprints | `r1-21/22` |
| Dusk washed to beige | The physical sky's tables never finished in a hidden page, so the fallback sky was showing; exposure at low sun cut | `r2-17/18` |
| Buildings pasted on, uniform grey roofs | Sun shadow map near the ground; roofs textured from the aerial photo | `r2-19/20`, `w2-07` |
| The island buried under pins | Density by camera range: dots from orbit, glyphs for what matters, fade with distance | `w1-01…06` |
| Rain overlay vanishing over the sea | Overlay coverage carried in alpha and mixed back above the water | |

## Known limits

- **Bathtub flooding** only, on a 10 m elevation model that terraces at whole metres in the coastal plain: low
  elevation counts are order-of-magnitude until lidar-grade elevation replaces it.
- **OpenStreetMap completeness varies by municipio.** Footprints are not a structure inventory. This build puts 20.3 % of Toa Baja's buildings and 36.6 % of Cataño's in the 1 % zone.
- **HUD points are not always the property.** 31 housing records have only a city and ZIP code for an address and
  are geocoded to the ZIP code area; two more fall in water or below sea level. No flood zone or elevation is
  derived for those 33, and each says why.
- **Storm replay counts use today's inventories** (residents, housing, shelters), not those of the storm's year.
  The best track's landfall fixes of 2004–2011 carry no wind radii; they are interpolated from the fixes either side.
- **No parcels, cases, inspections or grants.** The ontology has room for them; the data is the Department's.
- **LUMA's regions are not linked to municipios**: no authoritative public mapping was found, so none was made up.
- **The NHC forecast cone** is parsed from a service response shape that was not available to test against.
- **Reviewed on** an Apple M3 in Chrome for the early rounds (about 64 fps, 140,000 buildings in view), then
  under software rendering only. Safari, Firefox, phones and integrated GPUs are untested. On older machines use
  Low quality.
- **Memory**: one tab holds a few hundred megabytes of textures. It was not profiled.

## Credits and licences

Elevation: USGS 3DEP via AWS Terrain Tiles (Mapzen/Tilezen). Bathymetry: NOAA NCEI CUDEM. Imagery: USGS The
National Map. Buildings, facilities and coastline: © OpenStreetMap contributors, ODbL; the compiled building
tiles are a derived database under the ODbL. Flood zones: FEMA NFHL. Housing: HUD. Vulnerability: CDC/ATSDR SVI.
Shelters: Departamento de la Vivienda de Puerto Rico. Storm tracks: NOAA NHC HURDAT2. Weather model output:
Open-Meteo (CC BY 4.0). Radar: RainViewer. Sky and clouds: Takram three-geospatial (MIT). three.js,
postprocessing, SQLite WASM, Preact, d3-force.
