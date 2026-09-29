"""
api.py
======
Small read-only HTTP API in front of store.py's SQLite database. This is
the only thing Cloudflare Tunnel needs to expose -- everything else
(crawler.py, the SQLite file itself) stays purely local to Doris's
machine.

Endpoints:
    GET /infrastructure?bbox=west,south,east,north
        -> GeoJSON FeatureCollection of everything in that bbox. Same
           shape the frontend already expects from the old bundled/
           live-Overpass paths (see frontend/api/infrastructure.js and
           frontend/src/hooks/useZoneInfrastructure.js).
    POST /classify-landcover
        -> forestal/urbano/agricola/otro classification per point, via
           ESA WorldCover (see ../ml/worldcover_classifier.py -- same
           validated logic, reused here rather than duplicated). Cached
           in store.py's landcover_cache table so the SAME fire location
           doesn't trigger a fresh S3 read on every hourly fetch_firms.py
           run -- this machine is always-on, unlike the ephemeral GitHub
           Actions runner that calls this.
    GET /health
        -> feature counts + crawl progress, for a quick "is this alive
           and how much has it crawled" check (curl it, or point an
           uptime monitor at it).

No auth: this only ever serves read-only, already-public data -- there's
nothing sensitive to protect, and the Vercel proxy / GitHub Actions
workflow calling these are the only intended callers anyway.

Run with:
    uvicorn api:app --host 0.0.0.0 --port 8000
"""

import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests

import store
import geometry

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "ml"))
import worldcover_classifier as wc  # noqa: E402

app = FastAPI(title="FireWatch SAR - Infrastructure API")

# ONE shared thread pool for the whole process, not one per request. The
# on-demand frontend classification (useZoneLandCover) can easily fire
# several overlapping /classify-landcover calls in quick succession as
# someone pans/zooms the map -- each request spinning up its OWN
# ThreadPoolExecutor(max_workers=40) meant 3 concurrent requests could
# spawn 120 threads all doing blocking GDAL/S3 reads at once, which is
# almost certainly what was hanging this whole server (even /health
# stopped responding) under real map-panning traffic today. Capping the
# GLOBAL concurrent WorldCover fetch count, shared across every request,
# fixes that at the root instead of just tuning the per-request number
# again.
import math

# ── Local FWI (on-demand, fine-grained) ──────────────────────────────────────
# Same simplified Canadian FWI formula as scripts/fetch_weather.py's global
# 10-degree grid (duplicated here, not imported, to avoid cross-directory
# import issues between scripts/ and remote_server/ on the deployed server).
# Note: BUI uses fixed defaults (dmc=20.0, dc=200.0) rather than true
# multi-day-accumulated moisture codes -- same simplification as the global
# grid, so there's no "cold start" problem for a zone queried for the first
# time; this endpoint is exactly as accurate (and exactly as simplified) as
# the existing global FWI layer, just at a much finer spatial resolution.
FWI_CLASSES = [
    (0, 5,   "low",       "#38A800", "Low"),
    (5, 12,  "moderate",  "#FFFF00", "Moderate"),
    (12, 20, "high",      "#FFAA00", "High"),
    (20, 30, "very_high", "#FF0000", "Very High"),
    (30, 999,"extreme",   "#7A0000", "Extreme"),
]

def classify_fwi(fwi_value):
    for low, high, cls, color, label in FWI_CLASSES:
        if low <= fwi_value < high:
            return cls, color, label
    return "extreme", "#7A0000", "Extreme"

def compute_ffmc(temp_c, rh_pct, wind_kmh, rain_mm, prev_ffmc=85.0):
    mo = 147.2 * (101.0 - prev_ffmc) / (59.5 + prev_ffmc)
    if rain_mm > 0.5:
        rf = rain_mm - 0.5
        if mo <= 150:
            mo = mo + 42.5 * rf * math.exp(-100.0 / (251.0 - mo)) * (1.0 - math.exp(-6.93 / rf))
        else:
            mo = mo + 42.5 * rf * math.exp(-100.0 / (251.0 - mo)) * (1.0 - math.exp(-6.93 / rf))
            if mo > 250:
                mo = 250.0
    ed = 0.942 * (rh_pct ** 0.679) + (11.0 * math.exp((rh_pct - 100.0) / 10.0)) + \
         0.18 * (21.1 - temp_c) * (1.0 - math.exp(-0.115 * rh_pct))
    ew = 0.618 * (rh_pct ** 0.753) + (10.0 * math.exp((rh_pct - 100.0) / 10.0)) + \
         0.18 * (21.1 - temp_c) * (1.0 - math.exp(-0.115 * rh_pct))
    if mo > ed:
        ko = 0.424 * (1.0 - ((100.0 - rh_pct) / 100.0) ** 1.7) + \
             0.0694 * math.sqrt(wind_kmh) * (1.0 - ((100.0 - rh_pct) / 100.0) ** 8)
        kd = ko * 0.581 * math.exp(0.0365 * temp_c)
        m = ed + (mo - ed) * math.exp(-2.303 * kd)
    elif mo < ew:
        kl = 0.424 * (1.0 - (rh_pct / 100.0) ** 1.7) + \
             0.0694 * math.sqrt(wind_kmh) * (1.0 - (rh_pct / 100.0) ** 8)
        kw = kl * 0.581 * math.exp(0.0365 * temp_c)
        m = ew - (ew - mo) * math.exp(-2.303 * kw)
    else:
        m = mo
    m = max(0.0, min(250.0, m))
    ffmc = 59.5 * (250.0 - m) / (147.2 + m)
    return max(0.0, min(101.0, ffmc))

def compute_isi(wind_kmh, ffmc):
    fm = 147.2 * (101.0 - ffmc) / (59.5 + ffmc)
    fw = math.exp(0.05039 * wind_kmh)
    ff = 91.9 * math.exp(-0.1386 * fm) * (1.0 + fm ** 5.31 / 49300000.0)
    return 0.208 * fw * ff

def compute_bui(dmc=20.0, dc=200.0):
    if dmc <= 0.4 * dc:
        bui = 0.8 * dmc * dc / (dmc + 0.4 * dc)
    else:
        bui = dmc - (1.0 - 0.8 * dc / (dmc + 0.4 * dc)) * \
              (0.92 + (0.0114 * dmc) ** 1.7)
    return bui

def compute_fwi(isi, bui):
    if bui <= 80:
        fd = 0.626 * (bui ** 0.809) + 2.0
    else:
        fd = 1000.0 / (25.0 + 108.64 * math.exp(-0.023 * bui))
    b = 0.1 * isi * fd
    if b > 1.0:
        fwi = math.exp(2.72 * (0.434 * math.log(b)) ** 0.647)
    else:
        fwi = b
    return round(max(0.0, fwi), 1)

LOCAL_FWI_MAX_POINTS = 200  # safety cap on total cells per request
LOCAL_FWI_TARGET_CELLS_PER_SIDE = 8  # aim for a ~8x8 grid -- fewer points per request, gentler on Open-Meteo's free-tier rate limit
LOCAL_FWI_MIN_STEP_DEG = 0.02  # ~2km floor -- Open-Meteo's own model resolution is
                                # roughly 1-11km, so going finer doesn't add real
                                # meteorological detail, just interpolates the same data
LOCAL_FWI_MAX_STEP_DEG = 0.5   # ~55km ceiling -- zoomed out to country level, keep
                                # cells coarse rather than trying to cover a huge area finely

def step_for_bbox(west, south, east, north):
    """Always covers the FULL visible viewport, at whatever zoom -- sizes
    the cell to the viewport's own span (aiming for ~12 cells per side)
    instead of a fixed zoom lookup, which could stop partway through a
    large viewport and leave gaps (as a fixed-resolution grid did before)."""
    span = max(east - west, north - south, 0.001)
    step = span / LOCAL_FWI_TARGET_CELLS_PER_SIDE
    return max(LOCAL_FWI_MIN_STEP_DEG, min(LOCAL_FWI_MAX_STEP_DEG, step))

class LocalFwiRequest(BaseModel):
    west: float
    south: float
    east: float
    north: float
    zoom: float | None = None

@app.post("/local-fwi")
def local_fwi(req: LocalFwiRequest):
    """
    Fine-grained (~11km) FWI grid for a single zoomed-in zone, computed
    on-demand -- contrast with scripts/fetch_weather.py's coarse (10-degree,
    ~1000km) global grid, which is meant for a world-at-a-glance view, not
    neighborhood-level detail. Returns filled grid-cell polygons (not
    points), ready to render directly.
    """
    step_deg = step_for_bbox(req.west, req.south, req.east, req.north)
    points = []
    lat = req.south
    while lat < req.north and len(points) < LOCAL_FWI_MAX_POINTS:
        lon = req.west
        while lon < req.east and len(points) < LOCAL_FWI_MAX_POINTS:
            points.append((round(lat, 3), round(lon, 3)))
            lon += step_deg
        lat += step_deg

    if not points:
        return {"type": "FeatureCollection", "features": []}

    url = "https://api.open-meteo.com/v1/forecast"
    weather_by_point = {}
    batch_size = 50
    for i in range(0, len(points), batch_size):
        chunk = points[i:i + batch_size]
        params = {
            "latitude": ",".join(str(lat) for lat, lon in chunk),
            "longitude": ",".join(str(lon) for lat, lon in chunk),
            "current": [
                "temperature_2m", "relative_humidity_2m", "wind_speed_10m",
                "wind_direction_10m", "precipitation",
            ],
            "timezone": "auto",
            "wind_speed_unit": "kmh",
        }
        try:
            r = requests.get(url, params=params, timeout=60)
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict):
                data = [data]
            for (lat, lon), point_data in zip(chunk, data):
                weather_by_point[(lat, lon)] = point_data
        except Exception as e:
            print(f"  local-fwi: Open-Meteo batch failed: {type(e).__name__}: {e}")
            for (lat, lon) in chunk:
                weather_by_point[(lat, lon)] = None
    features = []
    half = step_deg / 2
    for (lat, lon) in points:
        data = weather_by_point.get((lat, lon))
        if not data or "current" not in data:
            continue
        c = data["current"]
        temp_c = c.get("temperature_2m")
        rh_pct = c.get("relative_humidity_2m")
        wind_kmh = c.get("wind_speed_10m")
        rain_mm = c.get("precipitation") or 0.0
        if temp_c is None or rh_pct is None or wind_kmh is None:
            continue

        ffmc = compute_ffmc(temp_c, rh_pct, wind_kmh, rain_mm)
        isi = compute_isi(wind_kmh, ffmc)
        bui = compute_bui()
        fwi = compute_fwi(isi, bui)
        risk_class, color, risk_label = classify_fwi(fwi)

        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [lon - half, lat - half], [lon + half, lat - half],
                    [lon + half, lat + half], [lon - half, lat + half],
                    [lon - half, lat - half],
                ]],
            },
            "properties": {
                "fwi": fwi, "risk_class": risk_class, "risk_label": risk_label,
                "temp_c": temp_c, "rh_pct": rh_pct, "wind_kmh": wind_kmh,
                "lat": lat, "lon": lon,
            },
        })

    return {"type": "FeatureCollection", "features": features}
LANDCOVER_POOL = ThreadPoolExecutor(max_workers=20)

# Server-to-server calls (Vercel's serverless function -> this API) aren't
# subject to browser CORS at all, so this is only relevant if someone
# calls this API directly from a browser for debugging. Left permissive
# since the data itself isn't sensitive (see module docstring).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# NOTE: deliberately NOT a single shared connection opened once at import
# time. FastAPI runs sync `def` endpoints (like the two below) in a
# worker thread pool, one thread per in-flight request -- and a sqlite3
# connection can only be used from the thread that created it. Opening a
# fresh connection per request (cheap -- SQLite connect is fast, and WAL
# mode lets many readers coexist with the crawler's writes) sidesteps
# that entirely instead of fighting SQLite's threading rules.
store.init_db()  # just ensures the tables exist; this connection is discarded


@app.get("/infrastructure")
def get_infrastructure(bbox: str = Query(..., description="west,south,east,north")):
    try:
        west, south, east, north = (float(v) for v in bbox.split(","))
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="bbox must be 'west,south,east,north'")
    conn = store.get_connection()
    try:
        features = store.query_bbox(conn, west, south, east, north)
    finally:
        conn.close()
    return {"type": "FeatureCollection", "features": features}


# Global (no bbox), just Industrial Zone + Urban Area points -- kept for
# any future use, but no longer what fetch_firms.py's vegetation
# classification relies on (see /classify-landcover below, which replaced
# it with the validated WorldCover approach: same idea, no dependency on
# the world-crawl having reached a given area yet).
LANDCOVER_INDEX_TYPES = ("Industrial Zone", "Urban Area")


@app.get("/landcover-index")
def get_landcover_index():
    conn = store.get_connection()
    try:
        features = store.query_by_types(conn, LANDCOVER_INDEX_TYPES)
    finally:
        conn.close()
    return {"type": "FeatureCollection", "features": features}


class LandcoverPoint(BaseModel):
    lat: float
    lon: float


class LandcoverBatchRequest(BaseModel):
    points: list[LandcoverPoint]
    window_size: int = 3  # matches the value evaluate.py's comparison settled on


@app.post("/classify-landcover")
def classify_landcover(req: LandcoverBatchRequest):
    """
    Returns one {category, class_code} per input point, same order.
    category is one of forestal/urbano/agricola/otro, or null if the
    point couldn't be classified (tile unavailable, network error).

    Cache lookups happen sequentially first (fast, local, not the
    bottleneck); only cache-miss S3 reads run in parallel, submitted to
    the single shared LANDCOVER_POOL (see its own comment above) rather
    than a fresh pool per call -- caps total concurrent WorldCover
    fetches across every simultaneous request, not just within one.
    Results get written back through a single connection afterward --
    same "don't touch SQLite from multiple threads" split used everywhere
    else in this file, not just within one call but reused as the
    persistent cross-run cache fetch_firms.py depends on to stay fast
    hour over hour.
    """
    conn = store.get_connection()
    keys = [wc._grid_key(p.lat, p.lon, req.window_size) for p in req.points]

    cached = {}
    for key in set(keys):
        row = store.get_landcover(conn, key)
        if row is not None:
            cached[key] = row  # (category, class_code)

    to_fetch = [(i, p.lat, p.lon) for i, p in enumerate(req.points) if keys[i] not in cached]
    fetched = {}
    if to_fetch:
        futures = {LANDCOVER_POOL.submit(wc._fetch_pixel_code, lat, lon, req.window_size): i for i, lat, lon in to_fetch}
        for future in as_completed(futures):
            i = futures[future]
            try:
                fetched[i] = future.result(timeout=30)
            except Exception:
                fetched[i] = None

    results = []
    for i, key in enumerate(keys):
        p = req.points[i]
        if key in cached:
            category, class_code = cached[key]
        else:
            class_code = fetched.get(i)
            category = wc.CLASS_MAP.get(class_code, "otro") if class_code is not None else None
            if class_code is not None:
                store.set_landcover(conn, key, category, class_code)

        # Residential/commercial polygon override: WorldCover's raw
        # per-pixel answer sometimes reads a genuine backyard tree canopy
        # or an undeveloped lot as vegetation even though it sits inside
        # a mapped neighborhood -- a real case found in Mazatlan testing
        # (a point WorldCover called "forestal" that's visibly a
        # residential block on satellite imagery, just with a lot of
        # tree cover). If the point falls inside a landuse=residential/
        # commercial/retail polygon, treat it as urbano regardless of
        # what the pixel said. Only checked when WorldCover DIDN'T
        # already say urbano (no point overriding an answer that already
        # agrees), and applied on every request -- cached or freshly
        # fetched -- rather than baked into the cached value, so newly-
        # crawled polygon coverage improves already-cached points
        # automatically on their next lookup, with no cache invalidation
        # needed.
        if category != "urbano":
            candidates = store.query_polygons_near(conn, p.lat, p.lon)
            if any(geometry.point_in_ring(p.lat, p.lon, ring) for ring in candidates):
                category = "urbano"

        results.append({"category": category, "class_code": class_code})
    conn.close()
    return {"results": results}


@app.get("/health")
def health():
    conn = store.get_connection()
    try:
        stats = store.get_stats(conn)
        progress = store.get_crawl_state(conn)
    finally:
        conn.close()
    return {**stats, "crawl_progress": progress}
