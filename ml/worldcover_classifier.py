"""
worldcover_classifier.py
=========================
Nivel 1: classifies a fire's land cover by reading a single pixel from
ESA WorldCover -- a free, global, 10m resolution land cover map already
produced by a state-of-the-art classifier (trained on millions of
labeled Sentinel-1+2 pixels). No model runs here at inference time; this
is a lookup against someone else's already-finished classification,
which is exactly what makes it fast enough for hourly batch runs over
thousands of detections without adding meaningful latency.

Hosted as Cloud-Optimized GeoTIFFs on AWS Open Data (s3://esa-worldcover),
public, no auth, no API key. rasterio reads only the byte range needed
for one pixel -- not the whole ~100MB+ tile -- so a single lookup is fast
even without pre-downloading anything.

Requires network access to AWS S3 (not available from this sandbox --
run and test this on your own machine).
"""

import math
import os
import sqlite3

try:
    import rasterio
    from rasterio.windows import Window
except ImportError:
    rasterio = None

WORLDCOVER_BASE_URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map"

# ESA WorldCover class codes -> this app's forestal/urbano/agricola/otro
# scheme. Shrubland and grassland count as "forestal" here on purpose --
# both are wildfire-carrying vegetation types (chaparral, savanna, prairie
# fires are real wildfires), even though they aren't literally forest.
CLASS_MAP = {
    10: "forestal",    # Tree cover
    20: "forestal",    # Shrubland
    30: "forestal",    # Grassland
    40: "agricola",    # Cropland
    50: "urbano",       # Built-up
    60: "otro",        # Bare / sparse vegetation
    70: "otro",        # Snow and ice
    80: "otro",        # Permanent water bodies (a "fire" here is a sensor artifact)
    90: "forestal",    # Herbaceous wetland (still natural vegetation fire risk)
    95: "forestal",    # Mangroves
    100: "otro",       # Moss and lichen
}

CACHE_DB_PATH = os.path.join(os.path.dirname(__file__), "worldcover_cache.db")
CACHE_GRID_DEG = 0.01  # ~1km -- land cover doesn't meaningfully change within this


def _init_cache():
    conn = sqlite3.connect(CACHE_DB_PATH)
    conn.execute("CREATE TABLE IF NOT EXISTS lookups (grid_key TEXT PRIMARY KEY, class_code INTEGER)")
    conn.commit()
    return conn


def _grid_key(lat, lon):
    return f"{round(lat / CACHE_GRID_DEG) * CACHE_GRID_DEG:.3f},{round(lon / CACHE_GRID_DEG) * CACHE_GRID_DEG:.3f}"


def _tile_name(lat, lon):
    """
    WorldCover tiles are 3x3 degree, named by their lower-left corner,
    e.g. lat=19.5, lon=-103.3 -> the tile starting at N18, W105 (WorldCover
    tiles snap to multiples of 3 degrees) -> "N18W105".
    """
    tile_lat = math.floor(lat / 3) * 3
    tile_lon = math.floor(lon / 3) * 3
    lat_str = f"N{tile_lat:02d}" if tile_lat >= 0 else f"S{-tile_lat:02d}"
    lon_str = f"E{tile_lon:03d}" if tile_lon >= 0 else f"W{-tile_lon:03d}"
    return f"{lat_str}{lon_str}"


def classify_point(lat, lon, conn=None):
    """
    Returns (category, class_code) for a single lat/lon, e.g.
    ("forestal", 10). category is None if the point can't be classified
    (tile doesn't exist -- e.g. open ocean far from any 3x3 tile, or a
    network error reading the COG).
    """
    if rasterio is None:
        raise RuntimeError("rasterio not installed -- run: pip install rasterio")

    owns_conn = conn is None
    if owns_conn:
        conn = _init_cache()

    key = _grid_key(lat, lon)
    cached = conn.execute("SELECT class_code FROM lookups WHERE grid_key = ?", (key,)).fetchone()
    if cached is not None:
        code = cached[0]
        if owns_conn:
            conn.close()
        return CLASS_MAP.get(code, "otro"), code

    tile = _tile_name(lat, lon)
    url = f"{WORLDCOVER_BASE_URL}/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
    try:
        with rasterio.open(f"/vsicurl/{url}") as src:
            row, col = src.index(lon, lat)
            window = Window(col, row, 1, 1)
            value = src.read(1, window=window)[0][0]
            code = int(value)
    except Exception as e:
        print(f"  WorldCover lookup failed for ({lat}, {lon}) tile {tile}: {e}")
        if owns_conn:
            conn.close()
        return None, None

    conn.execute("INSERT OR REPLACE INTO lookups (grid_key, class_code) VALUES (?, ?)", (key, code))
    conn.commit()
    if owns_conn:
        conn.close()
    return CLASS_MAP.get(code, "otro"), code


def classify_batch(points):
    """
    points: list of (lat, lon) tuples.
    Returns a list of (category, class_code) in the same order, reusing
    one cache connection across the whole batch instead of opening/
    closing SQLite per point.
    """
    conn = _init_cache()
    results = [classify_point(lat, lon, conn=conn) for lat, lon in points]
    conn.close()
    return results


if __name__ == "__main__":
    # Quick manual sanity check -- pick a couple of known points.
    test_points = [
        ("Bosque cerca de Tlaquepaque", 20.55, -103.35),
        ("Centro de Guadalajara (urbano)", 20.6767, -103.3475),
    ]
    for label, lat, lon in test_points:
        category, code = classify_point(lat, lon)
        print(f"{label}: {category} (WorldCover class {code})")
