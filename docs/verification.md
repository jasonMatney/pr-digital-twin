# Garita: independent verification of numbers and claims

Reviewed 2026-10-10 against seed `2026.10.10c` (`site/data/twin.db`, built 2026-10-10T21:28Z), the published data
files under `site/data` and `site/tiles`, the pipeline scripts, and public sources fetched the same day. The
reviewer did not build Garita. Scripts used are in the session scratchpad (`verify/*.js`); nothing in the project
or the site was changed except this file.

Verdicts: **confirmed** / **wrong** / **imprecise** (true in part, or stated with more certainty or precision than
the data supports) / **could not check** (reason given).

Totals: 66 claims checked. 38 confirmed, 7 wrong, 15 imprecise, 6 could not check.

## The tract question (981 vs 1,039)

Both numbers are real; they count different things.

- **981 is right for Census tracts.** The Census Bureau's 2020 tallies give Puerto Rico 78 county equivalents, 939
  county subdivisions and 981 census tracts (https://www.census.gov/geographies/reference-files/2020/geo/tallies.html).
  `data/geo/tracts.geojson` has 981 features and the store has 981 tract objects created by `census_tiger`.
  42 of the 981 are water-only tracts (GEOID tract code 99xx, land area 0); CDC SVI 2022 covers the other 939.
- **The database really holds 1,039 tract objects.** The extra 58 were created by the `hud_cdbg_dr` batch
  (`03-cdbg-lmi.batch.json`). HUD's CDBG-DR low/moderate-income layer uses an older tract vintage (the batch note
  says so; probably 2010); 58 of its GEOIDs do not exist among the 2020 tracts, and `ingest` created a new object
  for each instead of rejecting it.
- **They are stale orphans, not duplicates.** `object.id` is unique, so nothing is doubled. Each of the 58 has its
  GEOID as its name, no coordinates, no geometry, no link to a municipio, and exactly one property
  (`cdbg_dr_lmi_pct`). None of the 58 GEOIDs appears in `tracts.geojson`.
- A related risk that could not be measured: the other 827 CDBG-DR rows matched a 2020 GEOID by string. Where a
  tract kept its number but changed its boundary between vintages, the LMI share is attached to a different area.

## Claims checked

### A. Counts in the README against the database and data files

| # | Claim | Where | Found | Verdict |
|---|---|---|---|---|
| 1 | 1,500,471 building footprints | README, What it does; Real table | `tiles/bld/index.json` total 1,500,471; recounted record by record from all 1,771 `.bin` tiles: 1,500,471 | confirmed |
| 2 | 13.8 % carry a height | README, Real table | 206,488 / 1,500,471 = 13.76 % (203,069 from a height tag, 3,419 from levels) | confirmed |
| 3 | About 7,000 seeded objects | README | 7,018 (includes the 58 stale tracts) | confirmed |
| 4 | ...of 29 types | README | 29 types are defined; 25 have objects in the seed. `aircraft`, `earthquake`, `tropical_cyclone`, `weather_alert` are live-only and empty | imprecise |
| 5 | 12,800 typed links | README | 12,792 | confirmed |
| 6 | 58,000 property values | README | 58,423 | confirmed |
| 7 | Every value carries its source and observation time | README | Source: yes, all 58,423. Observation time: only `cdc_svi` (2022-12-31), `census_acs5` (2023-12-31) and `prdoh_shelters` (2026-05-27) carry a data date. The other 14 sources stamp every value with the fetch or build time (2026-10-10), including María registrations from 2017-18 | imprecise |
| 8 | The 10 MB seed | README | 10,305,536 bytes | confirmed |
| 9 | 78 municipios | README, Real table | 78 in store and geojson; Census tallies 78 (URL above) | confirmed |
| 10 | 939 barrios | README, Real table | 939 is the Census count of county subdivisions and the feature count of `barrios.geojson`, but 38 of those are water-only "Municipio subdivision not defined" (land area 0, population 0). The store has 901 barrio objects (827 barrios + 74 barrios-pueblo) | imprecise |
| 11 | 981 tracts | README, Real table | Census 981; geojson 981; store 1,039 (see above) | confirmed (README); database wrong |
| 12 | FEMA NFHL, 4,894 zones | README, Real table | `qa.json` records 4,894 polygons fetched and used for buildings. The published `nfhl_zones.geojson`, which `derive.mjs` uses for shelters, housing and facilities, has 3,830. Not compared with FEMA's own count | imprecise |
| 13 | HUD Public Housing Developments: 304 | README | Store 304. HUD's service returns `{"count":304}` for `STD_ST='PR'` (https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Public_Housing_Developments/FeatureServer/0/query?where=STD_ST%3D%27PR%27&returnCountOnly=true&f=json). These are HUD records, not residenciales: 280 distinct names; HUD's housing authority profile listed 325 projects with 53,828 units in 2020 (https://en.wikipedia.org/wiki/Public_housing_in_Puerto_Rico). Store total 54,034 units | confirmed |
| 14 | HUD Multifamily Assisted: 196 | README | Store 196; HUD service `{"count":196}` (same host, `Multifamily_Properties_Assisted`, `STD_ST='PR'`) | confirmed |
| 15 | HUD LIHTC: 231 | README | Store 231; HUD service `{"count":231}` (same host, `LIHTC`, `PROJ_ST='PR'`). 163 of the 231 have no coordinates, so they are absent from every map and exposure figure | confirmed |
| 16 | 343 shelters listed | README | Store 343. The Department's PDF could not be retrieved. Press coverage of the 2026 plan quotes the Department at 344 active shelters, capacity 47,561 (https://plateapr.com/que-saber/gobierno-presenta-plan-emergencia-temporada-huracanes-2026, 1 June 2026). The seed report logs two dropped fragments on pages 12 and 18 of the PDF | could not check |
| 17 | 336 located from the list's own map links | README | 336 have coordinates, but `report.json` says 332 came from the list's map links and 4 from an OpenStreetMap name match only; 7 are not located | wrong |
| 18 | 51 disaster declarations | README | Store 51 (36 DR, 15 EM; DR-62 of 1956 to DR-4850 of 2024). OpenFEMA `FemaWebDisasterDeclarations`, `stateCode eq 'PR'`: 51 records, 36 major disaster, 15 emergency (https://www.fema.gov/api/open/v1/FemaWebDisasterDeclarations?$filter=stateCode%20eq%20%27PR%27). USAFacts lists 44 since 1980 (https://usafacts.org/answers/how-many-disasters-are-declared-in-the-us/territory/puerto-rico/); the store has 44 since 1980 | confirmed |
| 19 | Facilities: 3,083 named | README | 3,083 objects, but 267 have no name in OpenStreetMap (230 substations, 37 power plants). `derive.mjs` lets them through and writes a name such as "Substation 115 kV" | wrong |
| 20 | 30 storms in the replay file | README | `storms.json` has 30; all have `closest_km` ≤ 81.7; the earliest is Gert 1981 | confirmed |
| 21 | Those are all the storms within 100 km since 1980 | README | HURDAT2 could not be downloaded to the shell and is too large to count through the web tool. Note the distance is to the nearest municipio interior point, not the coast (stated in `storms.meta.json`, not in the README) | could not check |
| 22 | CUDEM used in 1,136 tiles | README | `tiles/bathy/index.json`: 227 + 836 + 73 = 1,136 | confirmed |
| 23 | Terrain mirrored to zoom 12 island-wide, photo to zoom 13 | README | `tiles/index.json`: elevation z8-12 island-wide plus partial z13-15; photo to z13 plus partial z14-16 | confirmed |
| 24 | Ten saved queries, each run against the seed | README | Ten; all run and return rows (section D) | confirmed |
| 25 | Relay runs every five minutes | README | `relay.yml`: cron at :11 and :41, each run loops six times, 290 s apart | confirmed |
| 26 | Relay "refreshed every ~10 min" | ARCHITECTURE.md; comment in `pipeline/relay.mjs` | Contradicts the workflow and the README | wrong |
| 27 | `data/manifest.json` holds "versions, counts, build time, tile index" | ARCHITECTURE.md | It holds `seedVersion` and `built` only | wrong |

### B. Derived headline numbers

| # | Claim | Where | Found | Verdict |
|---|---|---|---|---|
| 28 | 12,344 buildings at or below +1 m | App, Scenario panel; `buildings_le_1m` | `exposure.json` island total 12,344 = sum of the 78 municipio values. But 4,178 of them sit on the DEM's exact 1.0 m terrace (strictly below 1 m: 8,757), and my recount from the building tiles, which store ground to 0.1 m, gives 13,531. The README itself calls these counts order-of-magnitude. No published figure was found to compare | imprecise (five significant figures on an order-of-magnitude number) |
| 29 | 139,248 buildings in the FEMA 1 % zone (9.3 %) | Store, `buildings_sfha` | Recounted from tiles: classes 2 + 3 = 135,886 + 3,362 = 139,248 | confirmed |
| 30 | Toa Baja: 20 % of buildings in the 1 % zone | README, Known limits | Store 6,281 / 30,977 = 20.3 %. Recount with the published boundaries 20.2 %, with land-clipped boundaries 19.7 % | confirmed |
| 31 | Cataño: 37-38 % | README, Known limits | Store 3,381 / 9,237 = 36.6 %. The figure is boundary-sensitive: recount with the published simplified boundary gives 39.3 % | imprecise |
| 32 | "An earlier study with the same FEMA layer found the same shares... with about 7 % more buildings" | README, Known limits | No citation is given and no such study was found | could not check |
| 33 | María at landfall: 47 of 78 municipios inside the 64 kt radius | App, Replay panel | Reproduced from `storms.json` and the store at 2017-09-20 10:15 UTC: 47 at 64 kt, 76 at 50 kt, 77 at 34 kt; 2,226,234 people, 205 public housing records, 210 shelters inside 64 kt. Context the panel does not give: 76 of 78 municipio points are inside the 64 kt radius at some moment of the passage, and 68 at once at 14:10 UTC | confirmed |
| 34 | María landfall fix: 10:15 UTC 20 Sep 2017, 18.0 N 65.9 W, 135 kt, 920 mb | `storms.json` | NHC Tropical Cyclone Report, best-track table: identical. The 00, 06, 12 and 18 UTC fixes also match (https://www.nhc.noaa.gov/data/tcr/AL152017_Maria.pdf) | confirmed |
| 35 | María wind radii at landfall: 64 kt 50/45/35/40 n mi, 34 kt 130/110/100/110 n mi | `storms.json` | The HURDAT2 line was not retrieved. NHC advisory 18 says hurricane-force winds reached 60 miles (52 n mi) and tropical-storm-force 150 miles (130 n mi) from the centre (https://www.nhc.noaa.gov/archive/2017/al15/al152017.public.018.shtml): consistent | confirmed |
| 36 | Storm maths: units, quadrants, bearing | `src/core/storms.ts` | Radii are read as n mi and multiplied by 1.852; quadrant index = floor(bearing / 90) with bearing from the storm to the point, matching the [NE, SE, SW, NW] order; haversine argument order is correct in both the app and the pipeline; Saffir-Simpson thresholds are correct | confirmed |
| 37 | "Storm-replay counts use each wind radius's maximum extent per quadrant, so the true area is smaller" | README; Replay panel | Matches the code | confirmed |
| 38 | Radii are interpolated between fixes | `stormAt`, `lerpArr` | Bug. In this file 18 landfall fixes, all in storms from 2004 to 2011, carry no radii although the fixes either side do. `lerpArr` returns `null` when the nearer fix has none, and `windBandAt` turns that into "nothing inside"; four storms lose their wind field for 3 to 6 hours around their Puerto Rico passage: Jeanne 2004, Olga 2007, Fay 2008, Irene 2011. At Olga's closest approach the panel reports 0 of 78 municipios in tropical-storm winds although the fixes either side have radii | wrong |
| 39 | "Replay María or any of 30 historical storms and see which municipios, how many people, which public housing developments and shelters were inside each wind radius, hour by hour" | README | 11 of the 30 (all before 2004, including Hugo and Georges) have no radii, so nothing can be counted. Housing and shelters are counted for 64 kt only. Population is ACS 2018-2022, housing is HUD's current list, shelters are the 2026 list: none is what existed when the storm passed | imprecise |
| 40 | NOAA scenarios for San Juan (station 9755371) | Scenario panel; `slr_projections.json` | CO-OPS API returns, in cm, Low 19/37, Int-Low 23/56, Intermediate 27/103, Int-High 33/153, High 39/207 for 2050/2100, zero in 2005 (https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/slr_projections.json?station=9755371&units=metric). File and store match exactly | confirmed |

### C. The ten saved queries

All ten run and return rows. `prop_best` returns one row per object and key, so none of the joins double counts.

| # | Query | Rows | Finding | Verdict |
|---|---|---|---|---|
| 41 | `ph_by_muni` Public housing by municipio, share in the FEMA 1% flood zone | 75 | The share is of HUD records, not units or residents: island-wide 58 of 304 records (19.1 %) but 13,643 of 54,034 units (25.2 %). The README describes it as "units... and the share in a flood zone". The zone is read at one HUD point per record; 31 records have no street address (city and ZIP only), 61 share exact coordinates with another record, and 4 points are not on land | imprecise |
| 42 | `shelters_3m` Shelters with ground at or below 3 m | 24 | The comment says "10 m DEM"; 299 of 336 located shelters were sampled from zoom-12 tiles (about 38 m, confidence 0.5). The 7 unlocated shelters are silently absent. `capacity` is always NULL (the list has none) | imprecise |
| 43 | `sfha_per_1000` | 78 | Arithmetic and denominator correct | confirmed |
| 44 | `maria_ihp` FEMA housing assistance per valid registration | 78 | `approved_usd` is the total Individuals and Households Program amount (housing plus other needs), not housing assistance. Sum $1,335,440,923 over 1,114,012 registrations; FEMA's DR-4339 page gives $1,336,692,163.26 IHP approved (https://www.fema.gov/disaster/4339), a 0.09 % difference explained by the excluded "Statewide" row | imprecise (title) |
| 45 | `disagree` | 4 | Four gauges whose municipio differs between NWPS and USGS. Correct. For 50061800 the USGS county code (029, Canóvanas) backs the USGS value, but the app's best value is the NWPS one (Loíza) because it was fetched four seconds later | confirmed |
| 46 | `per_source` | 32 | Correct; "objects" counts the creating source only | confirmed |
| 47 | `most_linked` | 20 | Correct | confirmed |
| 48 | `runs` | 21 | Correct. Times are when the seed was built, not when each source was fetched | confirmed |
| 49 | `types` Objects by type | 29 | The four empty types show `without_point = 1` (the LEFT JOIN's NULL row is counted). Tract shows 1,039 | wrong |
| 50 | `ph_low` Public housing residents by ground elevation band | 6 | The "0-1 m" band (6 records, 2,267 units, 3,311 residents) is mostly artefact: two Luis Llorens Torres records hold 1,742 of the units; RQ005010008 (855 units, address "San Juan, 00913") sits at 18.4569 N 66.0436 W, which is not on land, with elevation 0.0 m and zone VE; RQ005010009 is given -1.0 m. 212 of 304 elevations come from zoom-12 tiles | imprecise |

### D. Spot checks of individual objects

| # | Object | Found | Verdict |
|---|---|---|---|
| 51 | Tide station 9755371, San Juan (metro): `mhhw_m` 0.246 | NOAA datums: MHHW 1.512, MSL 1.266, difference 0.246 m (https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9755371/datums.json?units=metric) | confirmed |
| 52 | Tide station 9759110, Magueyes Island (Lajas) | NOAA: Magueyes Island, 17.970112, -67.04639: identical (https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9759110.json) | confirmed |
| 53 | Stream gauge 50061800, Río Canóvanas near Campo Rico | USGS: same name, 10.2 sq mi (store 26.42 km², correct conversion), county 029. Coordinates agree to about 220 m; the difference looks like the datum of the USGS degrees-minutes-seconds field (https://waterservices.usgs.gov/nwis/site/?format=rdb&sites=50061800,50144000&siteOutput=expanded) | confirmed |
| 54 | Stream gauge 50144000, Río Grande de Añasco near San Sebastián | USGS: same name, 134 sq mi (store 347.06 km²), county 011 Añasco (same URL) | confirmed |
| 55 | Municipio San Juan: population 340,903 | Data USA, 2022: 340,903 (https://denali.datausa.io/profile/geo/05000US72127) | confirmed |
| 56 | Municipio San Juan: 52.6 % below 150 % of poverty; Adjuntas: population 17,972, 80.4 % | The Census API needs a key and Census Reporter's API refused the fetch. Census Reporter's page shows 34.6 % below the poverty line (ACS 2024 1-year), which does not contradict a 150 % figure of 52.6 % (https://censusreporter.org/profiles/05000US72127-san-juan-municipio-pr) | could not check |
| 57 | Declaration DR-4339: declared 20 Sep 2017, incident 17 Sep to 15 Nov 2017, 78 municipios | FEMA: identical (https://www.fema.gov/disaster/4339) | confirmed |
| 58 | Storm María 2017 | See rows 34 and 35 | confirmed |
| 59 | Airport SJU (Carolina, metro) | Wikipedia: 18.43917 N 66.00194 W, SJU/TJSJ, 9 ft (2.7 m), Carolina (https://en.wikipedia.org/wiki/Luis_Mu%C3%B1oz_Mar%C3%ADn_International_Airport). Store: 18.4389, -66.0001 (about 190 m away, an area centroid), SJU/TJSJ, 3 m, Carolina. The store's `operator` (Puerto Rico Ports Authority) is the owner; Aerostar operates it. That is OpenStreetMap's tag, passed through | confirmed |
| 60 | Public housing Luis Llorens Torres (San Juan, metro) | Three HUD records, 2,567 units. No outside page could be fetched for its coordinates or ground level. Internal evidence that one point is offshore is in row 50 | could not check |
| 61 | Hospital Ashford Presbyterian (San Juan, metro) and shelter Esc. Dr. Pedro Albizu Campos (Toa Baja) | The hospital's reference page failed to load. The shelter's only source is a Google short link, which cannot be resolved from here | could not check |

### E. Wording: modelled or derived content presented as observed

| # | Text | Where | Found | Verdict |
|---|---|---|---|---|
| 62 | "Real: Every object and property in the store, each with its source" | About panel | 11,603 of 58,423 values (19.9 %) come from `garita_derived`: ground elevations, flood zones, building counts including the bathtub counts. The same panel lists the bathtub screen as modelled. Also inferred, not observed: 159 housing-to-municipio links taken from a city name (confidence 0.7), 78 municipio-to-forecast-zone links, 4 shelter locations from name matching | wrong |
| 63 | "Real: Building footprints (OpenStreetMap) with FEMA flood class and ground elevation" | About panel; README Real table | Footprints are real. Flood class is a centroid test; ground elevation is one sample of a 10 m model that terraces at whole metres (23.7 % of buildings between 0.5 and 15.5 m sit exactly on a whole metre, `qa.json`). The README's notes column says this; the About panel does not | imprecise |
| 64 | "Nothing is invented and presented as data" | README | No synthetic records found. The exceptions are the 267 generated facility names (row 19) and the two offshore housing points whose flood zone and elevation read as facts (row 50) | imprecise |
| 65 | Tract property `poverty_pct` | `ontology.json`, store | It holds CDC's EP_POV150, the share below 150 % of the poverty level. The label says so but the key does not, and the municipio type defines a `poverty_pct` ("Below poverty level") that has no values. Anyone writing SQL on the key will take it for the poverty rate | imprecise |
| 66 | "the 'best' value is the newest from the highest-ranked source" | ARCHITECTURE.md | `prop_best` has no source ranking: a user value wins, otherwise the latest `observed_at`. Because most sources stamp fetch time (row 7), "latest" mostly means "fetched or built last"; derived values are stamped 15 hours after the rest | imprecise |

## Corrections, most serious first

### Data and code

1. **Stale tracts (pipeline, `pipeline/seed/sources` CDBG-DR batch).** Do not create tract objects from the HUD
   layer. Attach `cdbg_dr_lmi_pct` only to tracts that already exist, and log the 58 that do not; better, map the
   layer's vintage to 2020 tracts with the Census relationship file before attaching anything. Expected result:
   1,039 → 981 tract objects.
2. **Storm replay, missing radii (`src/core/storms.ts`, `lerpArr`).** When one neighbouring fix has no radii,
   interpolate between the nearest fixes on each side that do, or carry the nearest valid radii, instead of
   returning `null`. Where no radii exist at all, show a dash, never "0 / 78". Affects Jeanne 2004, Olga 2007,
   Fay 2008, Irene 2011 around their Puerto Rico passage.
3. **Public housing points that are not real locations (`pipeline/derive.mjs`, batch 53).** Do not derive a flood
   zone or ground elevation for a HUD record whose point is off land or whose address has no street. At minimum
   drop RQ005010008 (Llorens Torres, offshore, VE, 0.0 m), RQ005010062, RQ005010004 and RQ005005025, and review the
   31 city-and-ZIP-only addresses. Check RQ005010009's -1.0 m against lidar.
4. **`types` saved query.** Replace `SUM(CASE WHEN o.lon IS NULL THEN 1 ELSE 0 END)` with
   `SUM(CASE WHEN o.id IS NOT NULL AND o.lon IS NULL THEN 1 ELSE 0 END)`.
5. **Unnamed facilities (`pipeline/derive.mjs`).** Either drop the 267 unnamed substations and power plants or keep
   them and stop calling the set "named"; do not write generated text into `name` without marking it.
6. **Observation times.** Give each baked batch an `observedAt` that is the data's own date (HUD extract date,
   OpenFEMA `lastRefresh`, ACS period end), or stop describing `observed_at` as an observation time.
7. **Property key.** Rename tract `poverty_pct` to `poverty150_pct`, as the municipio type already has it.

### README text

| Old | New |
|---|---|
| `Municipios, barrios, tracts \| US Census TIGERweb \| 78 / 939 / 981` | `Municipios, barrios, tracts \| US Census TIGERweb \| 78 / 901 / 981 (Census counts 939 county subdivisions; 38 are water-only and are left out. 42 of the 981 tracts are water-only.)` |
| `343 listed, 336 located from the list's own map links` | `343 listed; 332 located from the list's own map links, 4 by matching the name in OpenStreetMap, 7 not located` |
| `3,083 named` | `3,083, of which 267 substations and power plants have no name in OpenStreetMap` |
| `About 7,000 seeded objects of 29 types` | `About 7,000 seeded objects of 25 types (29 with the four live-only types)` |
| `every value carrying its source and observation time` | `every value carrying its source and the time it was fetched (the data's own date where the source gives one)` |
| `Replay María or any of 30 historical storms and see which municipios, how many people, which public housing developments and shelters were inside each wind radius, hour by hour.` | `Replay María or any of 29 other storms since 1980. For the 19 with wind radii in the record (2004 on), see which municipios and how many of today's residents fall inside each wind radius, and which of today's public housing developments and listed shelters fall inside the 64 kt radius, hour by hour.` |
| `(20 % and 37–38 % of buildings in the 1 % zone)` | `(20 % and 37 %; this build gives 20.3 % and 36.6 %)`, and cite the study or remove the sentence |
| `FEMA National Flood Hazard Layer, 4,894 zones` | `FEMA National Flood Hazard Layer, 4,894 zone polygons for buildings; a reduced file of 3,830 polygons is used for facilities, housing and shelters` |
| `public housing units by municipio and the share in a FEMA flood zone` | `public housing developments and units by municipio and the share of developments whose HUD point is in a FEMA flood zone` |
| `30 storms within 100 km since 1980` | `30 storms whose centre passed within 100 km of a municipio's interior point since 1980` |

### App strings

| Where | Old | New |
|---|---|---|
| `src/ui/about.tsx`, Real list | `Every object and property in the store, each with its source` | `Objects and properties from public sources, each with its source. Values Garita computed (ground elevation, flood zone, building counts) are marked "derived".` (ES: `Objetos y propiedades de fuentes públicas, cada uno con su fuente. Los valores calculados por Garita (elevación del terreno, zona inundable, conteos de edificios) se marcan como "derivados".`) |
| `src/ui/about.tsx`, Real list | `Building footprints (OpenStreetMap) with FEMA flood class and ground elevation` | `Building footprints (OpenStreetMap)`; move `FEMA flood class and ground elevation per building (one point each, screening level)` to the modelled list |
| `saved-queries.ts`, `ph_by_muni` title | `Public housing by municipio, share in the FEMA 1% flood zone` | `Public housing by municipio, share of developments in the FEMA 1% flood zone` |
| `saved-queries.ts`, `maria_ihp` title | `FEMA housing assistance per valid registration` | `FEMA individual assistance (IHP) approved per valid registration` |
| `saved-queries.ts`, `shelters_3m` comment | `(one point, 10 m DEM)` | `(one point; 10 m DEM resampled to about 38 m outside the San Juan metro; 7 shelters without a location are not included)` |
| Scenario panel count | `12,344` | Round to two significant figures (`about 12,000`) while the elevation source terraces at whole metres |
| Replay panel, María | `47 / 78` at landfall | Keep, and add the count over the whole passage (76 of 78) so the landfall instant is not read as the storm's reach |

### ARCHITECTURE.md

- `refreshed every ~10 min` → `refreshed every 5 min` (and the same comment in `pipeline/relay.mjs`).
- `data/manifest.json \| versions, counts, build time, tile index` → `seed version and build time`.
- `the "best" value is the newest from the highest-ranked source` → `the "best" value is a user's if there is one, otherwise the most recently observed`.

## Not checked, and why

- HURDAT2 completeness of the 30 storms (row 21): file not reachable from the shell, too large for the web tool.
- The Department's shelter PDF (row 16) and any shelter coordinate (row 61): PDF not retrieved; Google short links not resolvable.
- The uncited "earlier study" (row 32).
- ACS poverty figures and Adjuntas population (row 56): Census API key required.
- Llorens Torres and Ashford hospital reference pages (rows 60, 61): fetch failed.
- Not attempted: live feeds, rendering and performance claims (64 fps, 140,000 buildings in view), the OSM building
  count against Geofabrik (the extract changes daily), NFHL polygon count against FEMA, CUDEM coverage against NCEI,
  SVI values tract by tract.
