"""Shared by the hazard stages (lidar, surge, slide): where the buildings and the assets are, and how results are
written. Each stage samples its own raster at these points and publishes under its own paths (see README.md).

    from common import load_buildings, load_assets, write_stage
    lon, lat, stamp = load_buildings(site)          # numpy float64 arrays, canonical order, 1.5 million points
    assets = load_assets(site)                      # [(id, lon, lat)], id = "<type>:<key>" as in the store

site = a checkout of the gh-pages branch with at least tiles/bld, data/seed and data/osm.
Pure Python + numpy; no GDAL needed here.
"""
import json, math, os, struct, glob
import numpy as np

Z = 14
N = 1 << Z


def tile_lon(tx):
    return tx / N * 360.0 - 180.0


def tile_lat(ty):
    return math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * ty / N))))


def load_buildings(site):
    """Centroid (area centroid of the outer ring) of every building in tiles/bld, in CANONICAL ORDER: the tiles in
    the order tiles/bld/index.json lists them, the buildings in the order they are stored in each tile. Every
    stage's buildings.bin uses this order, so the i-th record of each belongs to the same building."""
    idx = json.load(open(os.path.join(site, 'tiles/bld/index.json')))
    lons, lats = [], []
    for x, y, count in idx['tiles']:
        b = open(os.path.join(site, f'tiles/bld/{Z}/{x}/{y}.bin'), 'rb').read()
        assert b[:4] == b'GBL1', (x, y)
        n = struct.unpack_from('<I', b, 4)[0]
        assert n == count, (x, y, n, count)
        o = 8
        for _ in range(n):
            nv = struct.unpack_from('<H', b, o)[0]
            o += 8
            uv = struct.unpack_from('<%dH' % (2 * nv), b, o)
            o += 4 * nv
            # area centroid in stored units (shoelace); falls back to the vertex mean for degenerate rings
            a = cx = cy = 0.0
            for i in range(nv):
                x0, y0 = uv[2 * i], uv[2 * i + 1]
                j = (i + 1) % nv
                x1, y1 = uv[2 * j], uv[2 * j + 1]
                c = x0 * y1 - x1 * y0
                a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c
            if abs(a) > 1e-9:
                u, v = cx / (3 * a), cy / (3 * a)
            else:
                u, v = sum(uv[0::2]) / nv, sum(uv[1::2]) / nv
            fx, fy = u / 65535 * 1.5 - 0.25, v / 65535 * 1.5 - 0.25
            lons.append(tile_lon(x + fx)); lats.append(tile_lat(y + fy))
    assert len(lons) == idx['total'], (len(lons), idx['total'])
    return np.array(lons), np.array(lats), idx['generated']


ASSET_TYPES = ('shelter', 'public_housing', 'assisted_housing')


def load_assets(site):
    """Shelters and HUD housing from the seed batches, facilities from the OSM extract: [(id, lon, lat)]."""
    out, seen = [], set()
    for f in sorted(glob.glob(os.path.join(site, 'data/seed/[0-4]*.batch.json'))):
        j = json.load(open(f))
        for b in (j if isinstance(j, list) else [j]):
            for o in b.get('objects', []):
                if o.get('type') in ASSET_TYPES and o.get('lon') is not None and o.get('lat') is not None:
                    i = f"{o['type']}:{o['key']}"
                    if i not in seen:
                        seen.add(i); out.append((i, float(o['lon']), float(o['lat'])))
    fac = json.load(open(os.path.join(site, 'data/osm/facilities.json')))
    for f in fac['facilities']:
        i = f"{f['type']}:{f['osm']}"
        if i not in seen and f.get('lon') is not None:
            seen.add(i); out.append((i, float(f['lon']), float(f['lat'])))
    return out


def write_stage(out, stage, buildings, dtype, assets, meta, bld_stamp):
    """out/data/hazards/<stage>/{buildings.bin, assets.json, meta.json}. buildings: numpy array whose first axis is
    the canonical building order; dtype: a little-endian numpy dtype string such as '<i2' or 'u1'."""
    d = os.path.join(out, 'data/hazards', stage)
    os.makedirs(d, exist_ok=True)
    arr = np.ascontiguousarray(buildings, dtype=np.dtype(dtype))
    arr.tofile(os.path.join(d, 'buildings.bin'))
    json.dump(assets, open(os.path.join(d, 'assets.json'), 'w'), separators=(',', ':'))
    meta = dict(meta)
    meta.update({'stage': stage, 'buildings': {'file': 'buildings.bin', 'dtype': dtype, 'shape': list(arr.shape), 'order': 'tiles/bld/index.json order, then tile order', 'bld_generated': bld_stamp}, 'assets': len(assets)})
    json.dump(meta, open(os.path.join(d, 'meta.json'), 'w'), indent=1)
    return d


if __name__ == '__main__':
    import sys, time
    t = time.time()
    lon, lat, stamp = load_buildings(sys.argv[1])
    a = load_assets(sys.argv[1])
    print(len(lon), 'buildings', stamp, 'lon', lon.min(), lon.max(), 'lat', lat.min(), lat.max(), '|', len(a), 'assets', a[0], '| %.1f s' % (time.time() - t))
