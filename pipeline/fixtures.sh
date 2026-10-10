#!/usr/bin/env bash
# Records one real response per source into out/. Never fails the job: a dead endpoint is recorded in status.tsv.
set -u
mkdir -p out && cd out
UA="garita (github.com/webgpu-demos/garita)"
D30=$(date -u -d '30 days ago' +%F); D7=$(date -u -d '7 days ago' +%F); NOW=$(date -u +%FT%TZ)
date -u +%FT%TZ > recorded_at.txt
: > status.tsv
get() { # name url [extra curl args]
  local name="$1" url="$2"; shift 2
  local code; code=$(curl -sS -L -m 90 -A "$UA" -o "$name" -w '%{http_code}\t%{size_download}\t%{content_type}' "$@" "$url" 2>>errors.txt) || code="ERR\t0\t-"
  printf '%s\t%b\t%s\n' "$name" "$code" "$url" >> status.tsv
}
# --- live, CORS-enabled (fetched by the browser in production) ---
get nws_alerts.json "https://api.weather.gov/alerts/active?area=PR"
get nws_alerts_all_recent.json "https://api.weather.gov/alerts?area=PR&limit=40"
get nws_obs_TJSJ.json "https://api.weather.gov/stations/TJSJ/observations/latest"
get nws_stations_pr.json "https://api.weather.gov/stations?state=PR&limit=500"
get nws_zones_forecast_pr.json "https://api.weather.gov/zones?area=PR&type=forecast&include_geometry=false"
get nws_zones_county_pr.json "https://api.weather.gov/zones?area=PR&type=county&include_geometry=false"
get nws_points_sanjuan.json "https://api.weather.gov/points/18.4655,-66.1057"
get usgs_quakes_30d.json "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=16.8&maxlatitude=19.8&minlongitude=-68.6&maxlongitude=-64.2&starttime=${D30}&minmagnitude=2&orderby=time"
get usgs_nwis_iv.json "https://waterservices.usgs.gov/nwis/iv/?format=json&stateCd=pr&parameterCd=00065,00060,00045,62614&siteStatus=active"
get usgs_nwis_sites.rdb "https://waterservices.usgs.gov/nwis/site/?format=rdb&stateCd=pr&siteStatus=active&hasDataTypeCd=iv&siteOutput=expanded"
get nwps_gauges.json "https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-67.99&bbox.ymin=17.6&bbox.xmax=-65.1&bbox.ymax=18.7&srid=EPSG_4326"
get coops_stations.json "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels"
get coops_wl_9755371.json "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?range=72&station=9755371&product=water_level&datum=MSL&time_zone=gmt&units=metric&format=json&application=garita"
get coops_pred_9755371.json "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?range=72&station=9755371&product=predictions&datum=MSL&time_zone=gmt&units=metric&interval=6&format=json&application=garita"
get coops_latest_9755371.json "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?date=latest&station=9755371&product=water_level&datum=MSL&time_zone=gmt&units=metric&format=json&application=garita"
get coops_datums_9755371.json "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9755371/datums.json?units=metric"
get coops_floodlevels_9755371.json "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9755371/floodlevels.json?units=metric"
get coops_slr_9755371.json "https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/slr_projections.json?station=9755371&units=metric"
get coops_slr_9759110.json "https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/slr_projections.json?station=9759110&units=metric"
get coops_met_9755371.json "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?date=latest&station=9755371&product=wind&time_zone=gmt&units=metric&format=json&application=garita"
get openfema_declarations.json "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?\$filter=state%20eq%20'PR'&\$orderby=declarationDate%20desc&\$top=1000"
get openfema_ha_owners_sample.json "https://www.fema.gov/api/open/v2/HousingAssistanceOwners?\$filter=state%20eq%20'PR'&\$top=5"
get openfema_ha_renters_sample.json "https://www.fema.gov/api/open/v2/HousingAssistanceRenters?\$filter=state%20eq%20'PR'&\$top=5"
get openfema_datasets.json "https://www.fema.gov/api/open/v1/OpenFemaDataSets?\$select=name,title,version,recordCount,lastRefresh&\$top=200"
get open_meteo_grid.json "https://api.open-meteo.com/v1/forecast?latitude=18.46,18.01,18.2,18.47,18.15,18.34&longitude=-66.1,-66.61,-67.14,-66.72,-65.44,-65.65&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,cloud_cover,pressure_msl&hourly=precipitation,wind_speed_10m,cloud_cover&forecast_days=2&wind_speed_unit=ms&timezone=GMT"
get open_meteo_marine.json "https://marine-api.open-meteo.com/v1/marine?latitude=18.6,17.85,18.25,18.25&longitude=-66.1,-66.5,-67.4,-65.1&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,sea_surface_temperature,sea_level_height_msl&timezone=GMT"
get open_meteo_air.json "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=18.46,18.01&longitude=-66.1,-66.61&current=pm10,pm2_5,dust,us_aqi,aerosol_optical_depth&timezone=GMT"
get rainviewer.json "https://api.rainviewer.com/public/weather-maps.json"
get celestrak_stations.json "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json"
get openfreemap_planet.json "https://tiles.openfreemap.org/planet"
get nhc_arcgis_layers.json "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer/layers?f=json"
# --- no CORS: relayed ---
get nhc_current.json "https://www.nhc.noaa.gov/CurrentStorms.json"
get ndbc_41053.txt "https://www.ndbc.noaa.gov/data/realtime2/41053.txt"
get ndbc_41043.txt "https://www.ndbc.noaa.gov/data/realtime2/41043.txt"
get ndbc_42085.txt "https://www.ndbc.noaa.gov/data/realtime2/42085.txt"
get ndbc_latest_obs.txt "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt"
get ndbc_stations.xml "https://www.ndbc.noaa.gov/activestations.xml"
get luma_regions.json "https://api.miluma.lumapr.com/miluma-outage-api/outage/regionsWithoutService"
get luma_towns.json "https://api.miluma.lumapr.com/miluma-outage-api/outage/municipality/towns" -X POST -H 'Content-Type: application/json' -d '["Arecibo","Bayamon","Caguas","Carolina","Mayaguez","Ponce","San Juan"]'
get adsb_lol.json "https://api.adsb.lol/v2/point/18.2/-66.4/160"
get adsb_fi.json "https://opendata.adsb.fi/api/v2/lat/18.2/lon/-66.4/dist/160"
get airplanes_live.json "https://api.airplanes.live/v2/point/18.2/-66.4/160"
get tsunami_atom.xml "https://www.tsunami.gov/events/xml/PAAQAtom.xml"
get prsn_recent.json "https://redsismica.uprm.edu/spanish/sismos/recent.json"
# --- probes for the bake pipeline ---
get census_acs.json "https://api.census.gov/data/2023/acs/acs5?get=NAME,B01003_001E,B25001_001E,B25002_003E,B19013_001E,B17001_002E,B17001_001E&for=county:*&in=state:72"
get census_acs_2022.json "https://api.census.gov/data/2022/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:72"
get tigerweb_layers.json "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/layers?f=json"
get hud_catalog.json "https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services?f=json"
get usgs_img_meta.json "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer?f=json"
get usgs_img_8.jpg "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/8/114/80"
get usgs_img_10.jpg "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/10/458/323"
get usgs_img_13.jpg "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/13/3668/2592"
get usgs_img_16.jpg "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/16/29347/20741"
get terrarium_12.png "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/1296/1834.png"
get terrarium_15.png "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/10370/14673.png"
get nfhl_count.json "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?where=DFIRM_ID%20LIKE%20'72%25'&returnCountOnly=true&f=json"
get slr_services.json "https://coast.noaa.gov/arcgis/rest/services/dc_slr?f=json"
get shelters_2026.pdf "https://docs.pr.gov/files/Vivienda/vivienda.pr.gov/Home/DVAVP_Refugios_Temporada_de_Huracanes_2026.pdf"
get svi_services.json "https://onemap.cdc.gov/OneMapServices/rest/services/SVI?f=json"
get usa_structures_meta.json "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0?f=json"
get hurdat2_index.html "https://www.nhc.noaa.gov/data/hurdat/"
curl -sSI -m 60 "https://download.geofabrik.de/north-america/us/puerto-rico-latest.osm.pbf" -L 2>/dev/null | grep -i -E '^(HTTP|content-length|last-modified)' > geofabrik_head.txt
# trim the big ones so the branch stays small, keep structure
python3 - <<'PY'
import json, os
def trim(name, path, n):
    try:
        d = json.load(open(name))
        cur = d
        for p in path[:-1]: cur = cur[p]
        if isinstance(cur[path[-1]], list) and len(cur[path[-1]]) > n: cur[path[-1]] = cur[path[-1]][:n]
        json.dump(d, open(name, 'w'))
    except Exception as e: print('trim skip', name, e)
trim('coops_stations.json', ['stations'], 400)
PY
ls -la | head -80; cat status.tsv
