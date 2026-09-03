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
