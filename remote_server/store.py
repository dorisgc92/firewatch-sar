"""
store.py
========
SQLite-backed storage for the world infrastructure dataset, running on
Doris's own always-on machine instead of as a GeoJSON file committed to
GitHub. Replaces data/infrastructure.geojson + data/infra_progress.json.

Why SQLite instead of a "real" database server (Postgres/PostGIS): this
runs on one dedicated machine with a single writer (the crawler) and a
single reader process (the API) sharing one file -- WAL mode handles that
concurrency pattern fine without needing a separate DB server to install,
configure, and keep running. If this ever needs to scale beyond one
machine, the query_bbox()/upsert_tile_features() functions below are the
only two places that would need to change to point at Postgres instead --
everything else (crawler.py, api.py) only calls through this module.

Table layout mirrors the world-crawl's own tiling (WORLD_TILE_SIZE_DEG,
see scripts/fetch_infrastructure.py): every feature is tagged with which
10x10 degree tile it came from, exactly like the old GeoJSON's `_tile`
property. A bbox query for a responder's zone (typically well under 10
degrees wide) almost always touches just 1-4 tiles, so this doesn't need
a fancier spatial index (R-Tree, geohash, etc.) to stay fast -- straight
SQL range filters on indexed lat/lon columns are enough at this scale.
"""

import json
import os
import sqlite3
import time

DB_PATH = os.path.join(os.path.dirname(__file__), "infrastructure.db")


def get_connection(db_path=DB_PATH):
    conn = sqlite3.connect(db_path, timeout=30)
    # WAL lets the API (reader) keep serving requests while the crawler
    # (writer) is mid-upsert, instead of blocking each other.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db(db_path=DB_PATH):
    conn = get_connection(db_path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS features (
            osm_type TEXT NOT NULL,
            osm_id INTEGER NOT NULL,
            tile TEXT NOT NULL,
            name TEXT,
            type TEXT,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            extra TEXT,
            PRIMARY KEY (osm_type, osm_id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tile ON features(tile)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_lat ON features(lat)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_lon ON features(lon)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS crawl_state (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    # Land cover classifications (ESA WorldCover lookups) for the
    # fetch_firms.py forestal/urbano/agricola/otro classification --
    # persisted here (this machine is always-on) rather than in the
    # ephemeral GitHub Actions runner, so the same fire location doesn't
    # trigger a fresh S3 read every single hourly run. See api.py's
    # /classify-landcover.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS landcover_cache (
            grid_key TEXT PRIMARY KEY,
            category TEXT,
            class_code INTEGER
        )
    """)
    # Urban landuse polygon boundaries (landuse=residential/commercial/
    # retail) -- the override signal for a specific, real failure mode:
    # a fire that WorldCover's raw 10m pixel reads as "vegetation" (a
    # backyard tree canopy, an undeveloped lot) but that sits squarely
    # inside a mapped neighborhood boundary. bbox_* columns exist purely
    # so /classify-landcover can cheaply pre-filter candidates with a
    # plain indexed range query before running the more expensive exact
    # point-in-polygon test (see geometry.py) on just the handful of
    # polygons whose bbox could plausibly contain the point.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS landuse_polygons (
            osm_id INTEGER PRIMARY KEY,
            tile TEXT NOT NULL,
            bbox_west REAL NOT NULL,
            bbox_south REAL NOT NULL,
            bbox_east REAL NOT NULL,
            bbox_north REAL NOT NULL,
            ring_json TEXT NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_landuse_tile ON landuse_polygons(tile)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_landuse_bbox ON landuse_polygons(bbox_west, bbox_east, bbox_south, bbox_north)")
    conn.commit()
    return conn


def upsert_tile_features(conn, tile_bbox_str, features):
    """
    Replaces everything stored for this one tile with the freshly-fetched
    features -- same "refresh this tile, leave every other tile alone"
    behavior as the old merge_features() in fetch_infrastructure.py, just
    expressed as SQL delete+insert instead of a Python list rebuild. A
    single DB transaction per tile, so a crash mid-tile can't leave that
    tile half-written.
    """
    cur = conn.cursor()
    cur.execute("DELETE FROM features WHERE tile = ?", (tile_bbox_str,))
    rows = []
    for f in features:
        props = f.get("properties", {})
        lon, lat = f["geometry"]["coordinates"]
        extra = {k: v for k, v in props.items()
                  if k not in ("name", "type", "osm_id", "osm_type", "_tile")}
        rows.append((
            props.get("osm_type"), props.get("osm_id"), tile_bbox_str,
            props.get("name"), props.get("type"), lat, lon,
            json.dumps(extra) if extra else None,
        ))
    cur.executemany(
        "INSERT OR REPLACE INTO features "
        "(osm_type, osm_id, tile, name, type, lat, lon, extra) "
        "VALUES (?,?,?,?,?,?,?,?)",
        rows,
    )
    conn.commit()
    return len(rows)


def upsert_landuse_polygons(conn, tile_bbox_str, polygons):
    """
    Same "wipe this tile's rows, insert the fresh set" pattern as
    upsert_tile_features -- a re-crawled tile cleanly replaces its own
    polygons without touching any other tile's. polygons: list of
    {"osm_id", "ring", "bbox": (west, south, east, north)} dicts, as
    returned by fetch_infrastructure.py's parse_urban_polygons.
    """
    cur = conn.cursor()
    cur.execute("DELETE FROM landuse_polygons WHERE tile = ?", (tile_bbox_str,))
    rows = [
        (p["osm_id"], tile_bbox_str, *p["bbox"], json.dumps(p["ring"]))
        for p in polygons
    ]
    cur.executemany(
        "INSERT OR REPLACE INTO landuse_polygons "
        "(osm_id, tile, bbox_west, bbox_south, bbox_east, bbox_north, ring_json) "
        "VALUES (?,?,?,?,?,?,?)",
        rows,
    )
    conn.commit()
    return len(rows)


def query_polygons_near(conn, lat, lon, margin=0.02):
    """
    Cheap bbox pre-filter (indexed range query) for candidate polygons
    that MIGHT contain (lat, lon) -- exact point-in-polygon (see
    geometry.point_in_ring) only needs to run against these few
    candidates, not every landuse polygon on the planet. margin=0.02deg
    (~2km) is generous relative to a typical neighborhood polygon's size,
    so a polygon whose bbox merely overlaps the point's small search
    window still gets a chance at the real test -- false candidates get
    filtered out by point_in_ring itself, which is what actually decides.
    """
    cur = conn.cursor()
    cur.execute(
        "SELECT ring_json FROM landuse_polygons "
        "WHERE bbox_west <= ? AND bbox_east >= ? AND bbox_south <= ? AND bbox_north >= ?",
        (lon + margin, lon - margin, lat + margin, lat - margin),
    )
    return [json.loads(row[0]) for row in cur.fetchall()]


def query_bbox(conn, west, south, east, north):
    """
    Returns a list of GeoJSON Feature dicts for everything inside the
    given bbox. This is the one function the API's /infrastructure
    endpoint calls -- keeps the query shape identical to what the
    frontend already expects from the old bundled/live-Overpass paths,
    so no other frontend code needs to know storage moved to SQLite.
    """
    cur = conn.cursor()
    cur.execute(
        "SELECT osm_type, osm_id, name, type, lat, lon, extra FROM features "
        "WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
        (south, north, west, east),
    )
    features = []
    for osm_type, osm_id, name, ftype, lat, lon, extra_json in cur.fetchall():
        props = {"name": name, "type": ftype, "osm_id": osm_id, "osm_type": osm_type}
        if extra_json:
            props.update(json.loads(extra_json))
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": props,
        })
    return features


def query_by_types(conn, types):
    """
    Returns every stored feature matching any of the given `type` labels,
    world-wide, no bbox filter -- used for the /landcover-index endpoint
    (fetch_firms.py's vegetation-vs-urban/industrial classification needs
    a global index, not a per-zone one, since fires can be anywhere on
    Earth on any given run).
    """
    cur = conn.cursor()
    placeholders = ",".join("?" for _ in types)
    cur.execute(
        f"SELECT osm_type, osm_id, name, type, lat, lon, extra FROM features WHERE type IN ({placeholders})",
        tuple(types),
    )
    features = []
    for osm_type, osm_id, name, ftype, lat, lon, extra_json in cur.fetchall():
        props = {"name": name, "type": ftype, "osm_id": osm_id, "osm_type": osm_type}
        if extra_json:
            props.update(json.loads(extra_json))
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": props,
        })
    return features


def get_stats(conn):
    cur = conn.cursor()
    total = cur.execute("SELECT COUNT(*) FROM features").fetchone()[0]
    by_type = dict(cur.execute("SELECT type, COUNT(*) FROM features GROUP BY type ORDER BY COUNT(*) DESC").fetchall())
    tiles_covered = cur.execute("SELECT COUNT(DISTINCT tile) FROM features").fetchone()[0]
    return {"total_features": total, "tiles_covered": tiles_covered, "by_type": by_type, "checked_at": time.time()}


def get_crawl_state(conn):
    cur = conn.cursor()
    row = cur.execute("SELECT value FROM crawl_state WHERE key = 'progress'").fetchone()
    if row:
        return json.loads(row[0])
    return {"next_index": 0, "laps_completed": 0, "last_tile_bbox": None}


def save_crawl_state(conn, state):
    conn.execute(
        "INSERT INTO crawl_state (key, value) VALUES ('progress', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (json.dumps(state),),
    )
    conn.commit()


def get_landcover(conn, grid_key):
    """Returns (category, class_code) or None if not cached yet."""
    return conn.execute(
        "SELECT category, class_code FROM landcover_cache WHERE grid_key = ?", (grid_key,)
    ).fetchone()


def set_landcover(conn, grid_key, category, class_code):
    conn.execute(
        "INSERT OR REPLACE INTO landcover_cache (grid_key, category, class_code) VALUES (?, ?, ?)",
        (grid_key, category, class_code),
    )
    conn.commit()
