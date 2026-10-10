#!/usr/bin/env python3
"""
Garita nearshore bathymetry tiles.

Reads NOAA NCEI CUDEM topo-bathy tiles for Puerto Rico (cloud-optimised GeoTIFF, AWS open-data bucket
noaa-nos-coastal-lidar-pds) and writes Terrarium PNG tiles tiles/bathy/{z}/{x}/{y}.png for Web Mercator zooms 12, 13
(every tile where tileTouchesLand) and 14 (San Juan and La Parguera boxes), plus index.json, a QA picture and a log.

Method
  1. list the bucket (reconnaissance is logged), build a VRT of the 1/9 arc-second tiles;
  2. stage each 1/9" tile locally at 25 % (its 4x COG overview, ~13.7 m) with parallel range reads;
  3. gdalwarp (average) the staged mosaic onto the zoom-13 tile grid (EPSG:3857); zoom 12 = no-data-aware 2x2 mean;
  4. zoom 14 boxes: gdalwarp (average, through the COG overviews) straight from the remote VRT;
  5. where a 1/3 arc-second CUDEM product exists for Puerto Rico it only fills cells the 1/9" product leaves empty;
  6. quantise (0.25 m in -60..+5 m, 0.5 m elsewhere), Terrarium-encode, no-data = R=G=B=0.
Nothing is interpolated, filled or invented: cells with no source data stay no-data.

Needs: gdal-bin, python3 with numpy and Pillow.
"""
import argparse
import datetime
import json
import math
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.parse
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

BUCKET = "https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/"
P19 = "dem/NCEI_ninth_Topobathy_PuertoRico_9525/"
LAND_BOX = dict(west=-67.98, south=17.86, east=-65.2, north=18.54)      # src/core/geo.ts
Z14_BOXES = {
    "san_juan": dict(west=-66.17, east=-65.97, south=18.36, north=18.48),
    "la_parguera": dict(west=-67.12, east=-66.98, south=17.90, north=18.00),
}
SPOTS = [
    ("San Juan Bay entrance channel", 18.467, -66.130),
    ("San Juan Bay entrance channel (b)", 18.4690, -66.1310),
    ("Bahia de Jobos (a)", 17.938, -66.235),
    ("Bahia de Jobos (b)", 17.935, -66.225),
    ("Bahia de Jobos (c)", 17.945, -66.205),
    ("Mosquito Bay, Vieques", 18.102, -65.445),
    ("La Parguera probe", 17.955, -67.05),
]
R = 6378137.0
PI_R = math.pi * R
BUDGET = 40e6

os.environ.update({
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.vrt",
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_HTTP_MULTIPLEX": "YES",
    "GDAL_HTTP_MAX_RETRY": "4",
    "GDAL_HTTP_RETRY_DELAY": "2",
    "GDAL_HTTP_TIMEOUT": "120",
    "VSI_CACHE": "TRUE",
    "VSI_CACHE_SIZE": "100000000",
    "GDAL_CACHEMAX": "2048",
    "AWS_NO_SIGN_REQUEST": "YES",
})

T0 = time.time()
LOG = None


def log(*a):
    s = f"[{time.time() - T0:6.1f}s] " + " ".join(str(x) for x in a)
    print(s, flush=True)
    if LOG:
        with open(LOG, "a") as f:
            f.write(s + "\n")


def run(cmd, timeout=600, check=True):
    cmd = [str(c) for c in cmd]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0 and check:
        raise RuntimeError(f"{' '.join(cmd[:6])} ... failed rc={p.returncode}: {p.stderr[-800:]}")
    return p.stdout


# ---------------------------------------------------------------- tile maths (ported from src/core/geo.ts)
def tile_lon(x, z):
    return x / 2 ** z * 360 - 180


def tile_lat(y, z):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / 2 ** z))))


def lon_to_x(lon, z):
    return (lon + 180) / 360 * 2 ** z


def lat_to_y(lat, z):
    s = math.sin(math.radians(lat))
    return (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * 2 ** z


def touches_land(z, x, y, pad=0.02):
    w, e, n, s = tile_lon(x, z), tile_lon(x + 1, z), tile_lat(y, z), tile_lat(y + 1, z)
    return (e > LAND_BOX["west"] - pad and w < LAND_BOX["east"] + pad
            and n > LAND_BOX["south"] - pad and s < LAND_BOX["north"] + pad)


def land_tiles(z):
    xa, xb = int(lon_to_x(LAND_BOX["west"] - 0.1, z)) - 1, int(lon_to_x(LAND_BOX["east"] + 0.1, z)) + 1
    ya, yb = int(lat_to_y(LAND_BOX["north"] + 0.1, z)) - 1, int(lat_to_y(LAND_BOX["south"] - 0.1, z)) + 1
    return [(x, y) for x in range(xa, xb + 1) for y in range(ya, yb + 1) if touches_land(z, x, y)]


def box_tiles(z, b):
    xa, xb = int(math.floor(lon_to_x(b["west"], z))), int(math.floor(lon_to_x(b["east"], z)))
    ya, yb = int(math.floor(lat_to_y(b["north"], z))), int(math.floor(lat_to_y(b["south"], z)))
    return [(x, y) for x in range(xa, xb + 1) for y in range(ya, yb + 1) if touches_land(z, x, y)]


def merc_te(z, x0, y0, x1, y1):
    ts = 2 * PI_R / 2 ** z
    return (-PI_R + x0 * ts, PI_R - (y1 + 1) * ts, -PI_R + (x1 + 1) * ts, PI_R - y0 * ts)


def px_of(lon, lat, z, x0, y0):
    return (lon_to_x(lon, z) - x0) * 256, (lat_to_y(lat, z) - y0) * 256


# ---------------------------------------------------------------- bucket
def s3_list(prefix, delimiter=None, max_pages=40):
    keys, prefixes, token = [], [], None
    for _ in range(max_pages):
        q = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if delimiter:
            q["delimiter"] = delimiter
        if token:
            q["continuation-token"] = token
        with urllib.request.urlopen(BUCKET + "?" + urllib.parse.urlencode(q), timeout=60) as r:
            xml = r.read().decode()
        keys += [(k, int(s)) for k, s in re.findall(r"<Contents><Key>([^<]+)</Key>.*?<Size>(\d+)</Size>", xml, flags=re.S)]
        prefixes += re.findall(r"<CommonPrefixes><Prefix>([^<]+)</Prefix>", xml)
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", xml)
        if not m:
            break
        token = m.group(1)
    return keys, prefixes


def in_bbox(key):
    m = re.search(r"n(\d+)x(\d+)_w(\d+)x(\d+)", key)
    if not m:
        return True
    north = int(m.group(1)) + int(m.group(2)) / 100.0
    west = -(int(m.group(3)) + int(m.group(4)) / 100.0)
    return west + 0.25 > -68.03 and west < -65.15 and north > 17.80 and north - 0.25 < 18.60


def info(url):
    j = json.loads(run(["gdalinfo", "-json", url], timeout=120))
    b = j["bands"][0]
    return {
        "size": j["size"], "geoTransform": j.get("geoTransform"),
        "crs": (j.get("coordinateSystem", {}).get("wkt", "")[:160].replace("\n", " ")),
        "crs_tail": (j.get("coordinateSystem", {}).get("wkt", "")[-260:].replace("\n", " ")),
        "nodata": b.get("noDataValue"), "type": b.get("type"), "block": b.get("block"),
        "overviews": [o["size"] for o in b.get("overviews", [])],
        "image_structure": j.get("metadata", {}).get("IMAGE_STRUCTURE"),
        "metadata": j.get("metadata", {}).get(""),
        "corners": j.get("cornerCoordinates"),
    }


def nd_arg(nd):
    if nd is None:
        return "-9999"
    if isinstance(nd, str):
        return nd
    return repr(float(nd))


def stage(urls, pct, tag, work):
    d = work / tag
    d.mkdir(parents=True, exist_ok=True)

    def one(u):
        dst = d / os.path.basename(u)
        cmd = ["gdal_translate", "-q"]
        if pct != 100:
            cmd += ["-outsize", f"{pct}%", f"{pct}%", "-r", "average"]
        cmd += ["-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", "/vsicurl/" + u, dst]
        for attempt in (1, 2, 3):
            try:
                run(cmd, timeout=420)
                return str(dst)
            except Exception as e:  # noqa: BLE001
                log(f"  stage {os.path.basename(u)} attempt {attempt} failed: {str(e)[-200:]}")
        return None

    with ThreadPoolExecutor(12) as ex:
        res = list(ex.map(one, urls))
    ok = [r for r in res if r]
    size = sum(os.path.getsize(r) for r in ok)
    log(f"staged {len(ok)}/{len(urls)} {tag} tiles at {pct}% -> {size / 1e6:.1f} MB local")
    return ok


def read_raster(path, work):
    """Float32 array of band 1. Uses the GDAL python bindings when present, otherwise a raw ENVI copy."""
    try:
        from osgeo import gdal  # noqa: PLC0415
        ds = gdal.Open(str(path))
        a = ds.GetRasterBand(1).ReadAsArray().astype(np.float32)
        ds = None
        return a
    except ImportError:
        raw = work / "_read.bin"
        p = subprocess.run(["gdal_translate", "-of", "ENVI", "-ot", "Float32", str(path), str(raw)], capture_output=True, text=True, timeout=600)
        if p.returncode != 0:
            raise RuntimeError(f"gdal_translate to ENVI failed rc={p.returncode}: out={p.stdout[-300:]} err={p.stderr[-500:]}")
        hdr = open(str(raw)[:-4] + ".hdr").read()
        ns, nl = int(re.search(r"samples\s*=\s*(\d+)", hdr).group(1)), int(re.search(r"lines\s*=\s*(\d+)", hdr).group(1))
        return np.fromfile(raw, dtype="<f4").reshape(nl, ns).copy()


def warp(src, z, x0, y0, x1, y1, resampling, name, work, nd, timeout=900):
    w, h = (x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256
    te = merc_te(z, x0, y0, x1, y1)
    out = work / f"{name}.tif"
    t = time.time()
    base = ["gdalwarp", "-overwrite", "-t_srs", "EPSG:3857", "-te", *[f"{v:.6f}" for v in te], "-ts", str(w), str(h),
            "-r", resampling, "-srcnodata", nd_arg(nd), "-dstnodata", "-9999", "-ot", "Float32", "-of", "GTiff"]
    variants = [
        ["-multi", "-wo", "NUM_THREADS=ALL_CPUS", "-wm", "1500"],
        ["-wo", "NUM_THREADS=ALL_CPUS"],
        ["-s_srs", "EPSG:4269"],
        ["--debug", "ON", "-s_srs", "EPSG:4269"],
    ]
    done = False
    for i, v in enumerate(variants):
        cmd = base + v + [str(src), str(out)]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if p.returncode == 0 and out.exists():
            done = True
            if i:
                log(f"  gdalwarp variant {i} ({' '.join(v)}) succeeded")
            break
        log(f"  gdalwarp variant {i} ({' '.join(v)}) rc={p.returncode}\n    cmd: {' '.join(cmd)}\n    stdout: {p.stdout[-600:]!r}\n    stderr: {p.stderr[-1500:]!r}")
    if not done:
        raise RuntimeError(f"gdalwarp failed for {name} in every variant")
    a = read_raster(out, work)
    if a.shape != (h, w):
        raise RuntimeError(f"warp {name}: got {a.shape}, wanted {(h, w)}")
    bad = ~np.isfinite(a) | (a < -9000) | (a > 9000)
    a[bad] = np.nan
    log(f"warp {name}: {w}x{h} px z{z} {resampling} in {time.time() - t:.1f}s, valid {100 * (1 - bad.mean()):.1f}%, "
        f"min {np.nanmin(a) if (~bad).any() else None} max {np.nanmax(a) if (~bad).any() else None}")
    return a


def encode(m):
    nod = np.isnan(m)
    v = np.where(nod, 0.0, m).astype(np.float64)
    fine = (v >= -60.0) & (v <= 5.0)
    q = np.where(fine, np.round(v * 4) / 4, np.round(v * 2) / 2)
    q = np.clip(q, -11000.0, 9000.0)
    t = q + 32768.0
    fl = np.floor(t)
    r = np.floor(fl / 256)
    g = fl - r * 256
    b = np.round((t - fl) * 256)
    rgb = np.stack([r, g, b], -1).astype(np.uint8)
    rgb[nod] = 0
    return rgb


def write_tiles(mosaic, z, x0, y0, tiles, out, rec):
    n = 0
    for (x, y) in tiles:
        r0, c0 = (y - y0) * 256, (x - x0) * 256
        if r0 < 0 or c0 < 0 or r0 + 256 > mosaic.shape[0] or c0 + 256 > mosaic.shape[1]:
            continue
        sub = mosaic[r0:r0 + 256, c0:c0 + 256]
        nod = np.isnan(sub)
        share = float(nod.mean())
        if share >= 1.0:
            rec["skipped_all_nodata"].setdefault(str(z), []).append([x, y])
            continue
        with np.errstate(invalid="ignore"):
            wet = float((sub < 0).mean())
        p = out / "tiles" / "bathy" / str(z) / str(x)
        p.mkdir(parents=True, exist_ok=True)
        f = p / f"{y}.png"
        Image.fromarray(encode(sub), "RGB").save(f, optimize=True)
        rec["tiles"].setdefault(str(z), {})[(x, y)] = dict(nodata=share, wet=wet, bytes=os.path.getsize(f), path=str(f))
        n += 1
    log(f"z{z}: wrote {n} tiles of {len(tiles)} candidates "
        f"({sum(t['bytes'] for t in rec['tiles'].get(str(z), {}).values()) / 1e6:.2f} MB)")


def colourise(c, dmax=50.0):
    """depth 0..-dmax light->dark, land grey, no-data near-black, 0 m line black."""
    h, w = c.shape
    img = np.zeros((h, w, 3), np.float32)
    nod = np.isnan(c)
    v = np.where(nod, 0.0, c)
    water = (~nod) & (v < 0)
    land = (~nod) & (v >= 0)
    t = np.clip(-v / dmax, 0, 1)[..., None]
    c0, c1, c2 = np.array([222, 246, 238.0]), np.array([58, 168, 202.0]), np.array([6, 34, 104.0])
    ramp = np.where(t < 0.5, c0 + (c1 - c0) * (t / 0.5), c1 + (c2 - c1) * ((t - 0.5) / 0.5))
    img[water] = ramp[water]
    gl = 128 + 90 * np.clip(v / 900.0, 0, 1)
    img[land] = np.stack([gl, gl, gl], -1)[land]
    img[nod] = (26, 22, 26)
    edge = np.zeros((h, w), bool)
    edge[:-1, :] |= land[:-1, :] & water[1:, :]
    edge[1:, :] |= land[1:, :] & water[:-1, :]
    edge[:, :-1] |= land[:, :-1] & water[:, 1:]
    edge[:, 1:] |= land[:, 1:] & water[:, :-1]
    img[edge] = (0, 0, 0)
    return img.astype(np.uint8)


def block_mean(a, k):
    h, w = (a.shape[0] // k) * k, (a.shape[1] // k) * k
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return np.nanmean(a[:h, :w].reshape(h // k, k, w // k, k), axis=(1, 3)).astype(np.float32)


def qa_image(m13, x0, y0, out):
    isl = block_mean(m13, 4)                                   # zoom 11
    valid = ~np.isnan(isl)
    rows, cols = np.where(valid.any(1))[0], np.where(valid.any(0))[0]
    r0, r1 = max(rows[0] - 12, 0), min(rows[-1] + 13, isl.shape[0])
    c0, c1 = max(cols[0] - 12, 0), min(cols[-1] + 13, isl.shape[1])
    top = Image.fromarray(colourise(isl[r0:r1, c0:c1], 50.0), "RGB")
    b = Z14_BOXES["la_parguera"]
    pxa, pya = px_of(b["west"], b["north"], 13, x0, y0)
    pxb, pyb = px_of(b["east"], b["south"], 13, x0, y0)
    crop = m13[int(pya):int(pyb) + 1, int(pxa):int(pxb) + 1]
    par = Image.fromarray(colourise(crop, 30.0), "RGB")
    par = par.resize((par.width * 2, par.height * 2), Image.NEAREST)
    W = max(top.width, par.width)
    canvas = Image.new("RGB", (W, top.height + par.height + 44), (255, 255, 255))
    d = ImageDraw.Draw(canvas)
    d.text((6, 4), "Garita bathy QA - CUDEM topo-bathy, zoom 11. Depth 0 (pale) to -50 m (dark blue), deeper = dark, "
                   "land grey, no-data near-black, 0 m line black.", fill=(0, 0, 0))
    canvas.paste(top, (0, 20))
    d.text((6, top.height + 26), "La Parguera, zoom 13 x2 (lon -67.12..-66.98, lat 17.90..18.00). Depth 0 to -30 m.", fill=(0, 0, 0))
    canvas.paste(par, (0, top.height + 44))
    f = out / "data" / "island" / "bathy_qa.jpg"
    f.parent.mkdir(parents=True, exist_ok=True)
    for q in (88, 82, 76, 70, 64, 58, 52, 46, 40, 34, 28):
        canvas.save(f, "JPEG", quality=q, optimize=True)
        if os.path.getsize(f) <= 480_000:
            break
    log(f"QA image {canvas.size} quality {q} -> {os.path.getsize(f) / 1e3:.0f} kB")


def spot_window(vrt, lat, lon, work, d=0.0004):
    out = work / "spot.tif"
    try:
        p = subprocess.run(["gdal_translate", "-projwin", str(lon - d), str(lat + d), str(lon + d), str(lat - d), "-projwin_srs", "EPSG:4326",
                            "-of", "GTiff", "-ot", "Float32", str(vrt), str(out)], capture_output=True, text=True, timeout=120)
        if p.returncode != 0:
            return dict(error=(p.stdout[-150:] + " | " + p.stderr[-300:]))
        a = read_raster(out, work)
        nl, ns = a.shape
        ok = np.isfinite(a) & (a > -9000) & (a < 9000)
        if not ok.any():
            return dict(n=int(a.size), valid=0.0)
        v = a[ok]
        ctr = a[nl // 2, ns // 2]
        return dict(n=int(a.size), valid=round(float(ok.mean()), 3), centre=round(float(ctr), 2), min=round(float(v.min()), 2),
                    median=round(float(np.median(v)), 2), max=round(float(v.max()), 2))
    except Exception as e:  # noqa: BLE001
        return dict(error=str(e)[-300:])


def extra_layer(m13, prefix, pct, tag, work, grid, used):
    """Fill cells that are still empty from another CUDEM product (never overrides existing cells). Failure is logged, not fatal."""
    try:
        keys, _ = s3_list(prefix)
        tifs = sorted(k for k, _ in keys if k.endswith(".tif"))
        use = [k for k in tifs if in_bbox(k)]
        log(f"{prefix}: {len(tifs)} tif, {len(use)} inside the island box:", " ".join(os.path.basename(k) for k in use))
        if not use:
            return m13
        i = info("/vsicurl/" + BUCKET + use[0])
        log("gdalinfo", os.path.basename(use[0]), json.dumps({k: i[k] for k in ("size", "geoTransform", "crs", "nodata", "overviews", "metadata")}))
        loc = stage([BUCKET + k for k in use], pct, tag, work)
        vrt = str(work / f"local_{tag}.vrt")
        run(["gdalbuildvrt", "-q", "-overwrite", "-srcnodata", nd_arg(i["nodata"]), "-vrtnodata", nd_arg(i["nodata"]), vrt] + loc)
        m = warp(vrt, 13, *grid, "average", f"m13_{tag}", work, i["nodata"])
        hole = np.isnan(m13) & ~np.isnan(m)
        log(f"{tag} fills {100 * hole.mean():.2f}% of the z13 mosaic that was still empty")
        if hole.any():
            used.append({"path": "s3://noaa-nos-coastal-lidar-pds/" + prefix, "tiles": [os.path.basename(k) for k in use],
                         "vertical": (i.get("metadata") or {}).get("TIFFTAG_IMAGEDESCRIPTION"), "share_of_mosaic": round(float(hole.mean()), 4)})
            return np.where(np.isnan(m13), m, m13)
        return m13
    except Exception:  # noqa: BLE001
        log(f"extra layer {prefix} failed, continuing without it:\n" + traceback.format_exc()[-600:])
        return m13


def main():
    global LOG
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--work", required=True)
    args = ap.parse_args()
    out, work = Path(args.out), Path(args.work)
    (out / "tiles" / "bathy").mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    LOG = out / "tiles" / "bathy" / "build.log"
    open(LOG, "w").write("")
    log("bathy build start", datetime.datetime.now(datetime.timezone.utc).isoformat(), "commit", os.environ.get("GITHUB_SHA", "?")[:7])
    log(run(["gdalinfo", "--version"]).strip())

    # ---------------- 1. reconnaissance
    _, prefixes = s3_list("dem/", delimiter="/")
    log(f"bucket dem/ has {len(prefixes)} dataset prefixes")
    rel = [p for p in prefixes if re.search(r"(?i)puerto|_PR_|PR_|usvi|virgin|carib", p)]
    log("prefixes that look like Puerto Rico / USVI:")
    for p in rel:
        log("   ", p)
    log("all NCEI (CUDEM) prefixes:")
    for p in prefixes:
        if "NCEI" in p:
            log("   ", p)

    keys19, _ = s3_list(P19)
    log(f"{P19}: {len(keys19)} objects, {sum(s for _, s in keys19) / 1e9:.2f} GB")
    for k, s in keys19:
        if not k.endswith(".tif"):
            log("    non-tif:", k, s)
    tifs19 = sorted(k for k, _ in keys19 if k.endswith(".tif"))
    log("1/9\" tif names:", " ".join(os.path.basename(k) for k in tifs19))
    use19 = [k for k in tifs19 if in_bbox(k)]
    log(f"1/9\" tiles inside the island box: {len(use19)} of {len(tifs19)}")
    if not use19:
        raise RuntimeError("no CUDEM 1/9 arc-second tiles found for Puerto Rico")
    i19 = info("/vsicurl/" + BUCKET + use19[0])
    log("gdalinfo", os.path.basename(use19[0]), json.dumps(i19))
    nd19 = i19["nodata"]

    third = [p for p in prefixes if re.search(r"(?i)third", p) and re.search(r"(?i)puerto|_PR_", p)]
    use3, nd3, i3 = [], None, None
    for p in third:
        k3, _ = s3_list(p)
        t3 = sorted(k for k, _ in k3 if k.endswith(".tif"))
        log(f"1/3\" candidate {p}: {len(k3)} objects, {len(t3)} tif, {sum(s for _, s in k3) / 1e9:.2f} GB")
        log("    names:", " ".join(os.path.basename(k) for k in t3[:80]))
        use3 += [k for k in t3 if in_bbox(k)]
    if use3:
        try:
            i3 = info("/vsicurl/" + BUCKET + use3[0])
            log("gdalinfo", os.path.basename(use3[0]), json.dumps(i3))
            nd3 = i3["nodata"]
        except Exception as e:  # noqa: BLE001
            log("1/3\" gdalinfo failed, not using it:", str(e)[-200:])
            use3 = []
    else:
        log("no CUDEM 1/3 arc-second product for Puerto Rico found in the bucket: 1/9\" is the only source")

    rvrt19 = str(work / "remote19.vrt")
    t = time.time()
    run(["gdalbuildvrt", "-q", "-overwrite", "-srcnodata", nd_arg(nd19), "-vrtnodata", nd_arg(nd19), rvrt19]
        + ["/vsicurl/" + BUCKET + k for k in use19], timeout=600)
    j = json.loads(run(["gdalinfo", "-json", rvrt19], timeout=300))
    log(f"remote 1/9\" VRT built in {time.time() - t:.1f}s: size {j['size']}, corners {json.dumps(j.get('cornerCoordinates'))}")

    log("probe off La Parguera (17.955 N, 67.05 W), 3x3 points 0.004 deg apart, metres:")
    for dy in (0.004, 0.0, -0.004):
        row = []
        for dx in (-0.004, 0.0, 0.004):
            v = run(["gdallocationinfo", "-wgs84", "-valonly", rvrt19, -67.05 + dx, 17.955 + dy], timeout=120, check=False).strip()
            row.append(v or "none")
        log("    ", "  ".join(row))

    # ---------------- 2. stage + warp zoom 13
    t12, t13 = land_tiles(12), land_tiles(13)
    log(f"candidate tiles: z12 {len(t12)}, z13 {len(t13)}")
    X0, X1 = min(x for x, _ in t12) * 2, max(x for x, _ in t12) * 2 + 1
    Y0, Y1 = min(y for _, y in t12) * 2, max(y for _, y in t12) * 2 + 1
    loc19 = stage([BUCKET + k for k in use19], 25, "c19", work)
    lvrt19 = str(work / "local19.vrt")
    run(["gdalbuildvrt", "-q", "-overwrite", "-srcnodata", nd_arg(nd19), "-vrtnodata", nd_arg(nd19), lvrt19] + loc19)
    m13 = warp(lvrt19, 13, X0, Y0, X1, Y1, "average", "m13_19", work, nd19)
    src_note = "CUDEM 1/9 arc-second only"
    lvrt3 = None
    extra_used = []
    # the Puerto Rico 1/9" product stops at 65.25 W: the USVI 1/9" product carries the east end of Culebra and its shelf
    m13 = extra_layer(m13, "dem/NCEI_ninth_Topobathy_USVI_9529/", 25, "u19", work, (X0, Y0, X1, Y1), extra_used)
    if use3:
        try:
            loc3 = stage([BUCKET + k for k in use3], 100, "c3", work)
            lvrt3 = str(work / "local3.vrt")
            run(["gdalbuildvrt", "-q", "-overwrite", "-srcnodata", nd_arg(nd3), "-vrtnodata", nd_arg(nd3), lvrt3] + loc3)
            m3 = warp(lvrt3, 13, X0, Y0, X1, Y1, "average", "m13_3", work, nd3)
            hole = np.isnan(m13) & ~np.isnan(m3)
            log(f"1/3\" underlay fills {100 * hole.mean():.2f}% of the z13 mosaic that 1/9\" leaves empty")
            m13 = np.where(np.isnan(m13), m3, m13)
            del m3
            src_note = "CUDEM 1/9 arc-second, with CUDEM 1/3 arc-second only where 1/9 has no data"
        except Exception as e:  # noqa: BLE001
            log("1/3\" underlay failed, continuing with 1/9\" only:", str(e)[-300:])
            lvrt3 = None

    m13 = extra_layer(m13, "dem/NCEI_third_Topobathy_USVI_9528/", 100, "u3", work, (X0, Y0, X1, Y1), extra_used)
    if extra_used:
        src_note += "; east of 65.25 W filled from the CUDEM USVI products (see source.also_used)"

    rec = {"tiles": {}, "skipped_all_nodata": {}}
    write_tiles(m13, 13, X0, Y0, t13, out, rec)
    m12 = block_mean(m13, 2)
    write_tiles(m12, 12, X0 // 2, Y0 // 2, t12, out, rec)

    # ---------------- 3. statistics + QA (before zoom 14 so they exist even if a box fails)
    v = m13[~np.isnan(m13)]
    wet = v[v < 0]
    log(f"z13 mosaic: valid {100 * v.size / m13.size:.1f}% of {m13.shape[1]}x{m13.shape[0]} px, min {v.min():.2f} m, max {v.max():.2f} m, "
        f"below 0 m: {100 * wet.size / v.size:.1f}% of valid cells")
    edges = [0, -2, -5, -10, -15, -20, -30, -40, -50, -60, -100, -200, -500, -1000, -9000]
    log("depth histogram (z13 cells below 0 m):")
    for a, b in zip(edges[:-1], edges[1:]):
        n = int(((wet < a) & (wet >= b)).sum()) if a != 0 else int(((wet < 0) & (wet >= b)).sum())
        log(f"    {a:>6} .. {b:>6} m : {n:>10}  {100 * n / max(wet.size, 1):5.1f}%")
    log("land histogram (z13 cells >= 0 m): 0..1 m %d, 1..5 m %d, 5..100 m %d, >100 m %d" % (
        int(((v >= 0) & (v < 1)).sum()), int(((v >= 1) & (v < 5)).sum()), int(((v >= 5) & (v < 100)).sum()), int((v >= 100).sum())))
    spots = {}
    log("spot depths (native 1/9\" window ~90 m square: centre / min / median / max; and the z13 tile cell):")
    for name, lat, lon in SPOTS:
        s = spot_window(rvrt19, lat, lon, work)
        px, py = px_of(lon, lat, 13, X0, Y0)
        zv = m13[int(py), int(px)]
        s["z13_cell"] = None if np.isnan(zv) else round(float(zv), 2)
        s["lat"], s["lon"] = lat, lon
        spots[name] = s
        log(f"    {name} ({lat}, {lon}): {json.dumps(s)}")
    try:
        qa_image(m13, X0, Y0, out)
    except Exception:  # noqa: BLE001
        log("QA image failed:\n" + traceback.format_exc())

    # ---------------- 4. zoom 14 boxes
    for bname, b in Z14_BOXES.items():
        try:
            tl = box_tiles(14, b)
            bx0, bx1 = min(x for x, _ in tl), max(x for x, _ in tl)
            by0, by1 = min(y for _, y in tl), max(y for _, y in tl)
            m14 = warp(rvrt19, 14, bx0, by0, bx1, by1, "average", f"m14_{bname}", work, nd19, timeout=480)
            if lvrt3:
                u = warp(lvrt3, 14, bx0, by0, bx1, by1, "bilinear", f"m14_{bname}_3", work, nd3, timeout=300)
                m14 = np.where(np.isnan(m14), u, m14)
            write_tiles(m14, 14, bx0, by0, tl, out, rec)
        except Exception:  # noqa: BLE001
            log(f"zoom 14 box {bname} failed:\n" + traceback.format_exc())

    # ---------------- 5. budget, index
    total = sum(t["bytes"] for z in rec["tiles"].values() for t in z.values())
    log(f"total before budget check: {total / 1e6:.2f} MB in {sum(len(z) for z in rec['tiles'].values())} tiles")
    omitted = {}
    if total > BUDGET:
        for z, d in rec["tiles"].items():
            for k in [k for k, t in d.items() if t["wet"] <= 0.0]:
                os.remove(d[k]["path"])
                omitted.setdefault(z, []).append(list(k))
                del d[k]
        total = sum(t["bytes"] for z in rec["tiles"].values() for t in z.values())
        log(f"over the 40 MB target: omitted tiles with no cell below 0 m (pure land, no bathymetry in them): "
            f"{ {z: len(v) for z, v in omitted.items()} }; total now {total / 1e6:.2f} MB")
    zooms = sorted(int(z) for z in rec["tiles"] if rec["tiles"][z])
    index = {
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "zooms": zooms,
        "tiles": {str(z): sorted([list(k) for k in rec["tiles"][str(z)]]) for z in zooms},
        "nodata": "R=G=B=0 (−32768 m)",
        "nodata_share": {str(z): {f"{k[0]}/{k[1]}": round(t["nodata"], 4) for k, t in sorted(rec["tiles"][str(z)].items()) if t["nodata"] > 0}
                         for z in zooms},
        "quantisation_m": {"from_-60_to_5_m": 0.25, "elsewhere": 0.5},
        "encoding": "Terrarium: metres = R*256 + G + B/256 - 32768; 256x256 RGB PNG; Web Mercator XYZ",
        "z14_boxes": Z14_BOXES,
        "omitted_land_only": omitted,
        "skipped_all_nodata": {z: len(v) for z, v in rec["skipped_all_nodata"].items()},
        "bytes": {str(z): sum(t["bytes"] for t in rec["tiles"][str(z)].values()) for z in zooms},
        "total_bytes": total,
        "source": {
            "name": "NOAA NCEI Continuously Updated Digital Elevation Model (CUDEM) - Ninth Arc-Second Resolution Bathymetric-Topographic Tiles, Puerto Rico",
            "doi": "10.25921/ds9v-ky35",
            "vintage": "2022 (tiles *_2022v*.tif)",
            "path": "s3://noaa-nos-coastal-lidar-pds/" + P19,
            "tiles_used": [os.path.basename(k) for k in use19],
            "third_arcsec_fill": [os.path.basename(k) for k in use3] if lvrt3 else [],
            "third_arcsec_path": "s3://noaa-nos-coastal-lidar-pds/dem/NCEI_third_Topobathy_PuertoRico_9524/",
            "also_used": extra_used,
            "composition": src_note,
            "priority": "PR 1/9 arc-second, then USVI 1/9, then PR 1/3, then USVI 1/3; a lower-priority product only fills cells the higher ones leave empty",
            "horizontal_crs": "NAD83 geographic, 1/9 arc-second (~3.4 m) cells",
            "vertical_datum": "PRVD02 orthometric height (metres), used as mean sea level with no shift; CUDEM sits about +0.1 m above the 2019 NGS topobathy lidar",
            "nodata_declared": nd19,
        },
        "method": "1/9\" tiles read at their 4x overview (~13.7 m) then gdalwarp -r average onto the zoom-13 grid; zoom 12 = no-data-aware 2x2 mean of zoom 13; "
                  "zoom 14 = gdalwarp -r average from the remote COGs through their overviews. No filling or interpolation of gaps.",
        "spots": spots,
        "note": "Trust values below sea level; land values are bare-earth lidar",
    }
    json.dump(index, open(out / "tiles" / "bathy" / "index.json", "w"), separators=(",", ":"))
    for z in zooms:
        d = rec["tiles"][str(z)]
        part = sum(1 for t in d.values() if t["nodata"] > 0)
        log(f"z{z}: {len(d)} tiles, {index['bytes'][str(z)] / 1e6:.2f} MB, {part} with some no-data, "
            f"{index['skipped_all_nodata'].get(str(z), 0)} skipped as all no-data")
    log(f"TOTAL {total / 1e6:.2f} MB; done")


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        log("FAILED:\n" + traceback.format_exc())
        sys.exit(1)
