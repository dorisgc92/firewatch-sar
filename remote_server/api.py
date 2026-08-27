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
    GET /health
        -> feature counts + crawl progress, for a quick "is this alive
           and how much has it crawled" check (curl it, or point an
           uptime monitor at it).

No auth on /infrastructure: this only ever serves read-only, already-
public OpenStreetMap data (hospitals, fire stations, etc.) -- there's
nothing sensitive to protect, and the Vercel proxy in front of this
(frontend/api/infrastructure.js) is the only intended caller anyway.

Run with:
    uvicorn api:app --host 0.0.0.0 --port 8000
"""

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

import store

app = FastAPI(title="FireWatch SAR - Infrastructure API")

# Server-to-server calls (Vercel's serverless function -> this API) aren't
# subject to browser CORS at all, so this is only relevant if someone
# calls this API directly from a browser for debugging. Left permissive
# since the data itself isn't sensitive (see module docstring).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
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


# Global (no bbox), just Industrial Zone + Urban Area points -- what
# fetch_firms.py's vegetation-vs-urban/industrial classification needs.
# Kept as its own endpoint rather than reusing /infrastructure with a huge
# bbox, since /infrastructure's bbox filter is the whole reason it's fast
# for a zone query -- this one is deliberately unbounded and only ever
# needs two cheap categories, not everything.
LANDCOVER_INDEX_TYPES = ("Industrial Zone", "Urban Area")


@app.get("/landcover-index")
def get_landcover_index():
    conn = store.get_connection()
    try:
        features = store.query_by_types(conn, LANDCOVER_INDEX_TYPES)
    finally:
        conn.close()
    return {"type": "FeatureCollection", "features": features}


@app.get("/health")
def health():
    conn = store.get_connection()
    try:
        stats = store.get_stats(conn)
        progress = store.get_crawl_state(conn)
    finally:
        conn.close()
    return {**stats, "crawl_progress": progress}
