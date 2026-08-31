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
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np

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
# ~3km, not ~1km. This directly controls how often the SAME cache entry
# gets reused -- a finer grid meant that fires scattered within the same
# real-world complex (dozens of nearby VIIRS/MODIS pixels from one
# wildfire) each needed their own fresh WorldCover lookup instead of
# sharing one, which is what made a cold-cache run over ~250k detections
# take hours instead of minutes. Land cover class is stable enough over a
# few km (especially after the majority-vote window on top of this) that
# the accuracy cost of coarsening is negligible next to the latency win.
CACHE_GRID_DEG = 0.03


def _init_cache():
    conn = sqlite3.connect(CACHE_DB_PATH)
    conn.execute("CREATE TABLE IF NOT EXISTS lookups (grid_key TEXT PRIMARY KEY, class_code INTEGER)")
    conn.commit()
    return conn


def _grid_key(lat, lon, window_size):
    # window_size is part of the key on purpose -- a 3x3 and a 5x5 result
    # for the same point are genuinely different values (different amount
    # of averaging), so they need to coexist in the cache rather than one
    # silently overwriting the other when you switch window sizes to
    # compare them, which is exactly the experiment this parameter exists
    # to make easy.
    return f"w{window_size}:{round(lat / CACHE_GRID_DEG) * CACHE_GRID_DEG:.3f},{round(lon / CACHE_GRID_DEG) * CACHE_GRID_DEG:.3f}"


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


def _fetch_pixel_code(lat, lon, window_size):
    """The actual S3 read, with no cache/DB interaction — split out so
    classify_batch can run many of these concurrently (I/O-bound HTTP
    range reads benefit heavily from that) without touching SQLite from
    multiple threads, which isn't safe without real care (see api.py's
    own earlier fix for this exact class of bug in remote_server/).

    Reads a small window_size x window_size pixel window around the point
    and returns the MAJORITY class, not a single pixel (window_size=1
    reduces to a plain single-pixel read). This matters because the
    ground truth this gets compared against (MODIS fire detections) has
    ~1km pixel resolution -- the reported lat/lon is that 1km cell's
    center, not a precise fire location. A single 10m WorldCover pixel
    read at that exact coordinate can easily land on a small bare-soil/
    water/snow sliver inside an otherwise forested or built-up 1km cell
    purely by chance. Majority-vote over a window doesn't fully close a
    10m-vs-1km gap, but it can smooth this out -- window_size is exposed
    as a parameter (see evaluate.py --window-size) specifically so this
    can be tested empirically (1x1, 3x3, 5x5, 7x7...) instead of assumed.

    GDAL_HTTP_TIMEOUT/GDAL_HTTP_MAX_RETRY are set explicitly because
    rasterio's /vsicurl/ driver has NO timeout by default — a single
    stalled connection (flaky wifi, a dropped packet) hangs that thread
    forever instead of failing and moving on, which is what silently
    froze a batch with zero progress output in an earlier run.
    GDAL_DISABLE_READDIR_ON_OPEN avoids an extra, sometimes-slow
    directory-listing call GDAL does by default before reading a single
    remote file."""
    tile = _tile_name(lat, lon)
    url = f"{WORLDCOVER_BASE_URL}/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
    with rasterio.Env(GDAL_HTTP_TIMEOUT=20, GDAL_HTTP_CONNECTTIMEOUT=10,
                       GDAL_HTTP_MAX_RETRY=2, GDAL_HTTP_RETRY_DELAY=1,
                       GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        with rasterio.open(f"/vsicurl/{url}") as src:
            row, col = src.index(lon, lat)
            if window_size <= 1:
                value = src.read(1, window=Window(col, row, 1, 1))[0][0]
                if value == 0:
                    raise ValueError("nodata pixel")
                return int(value)
            half = window_size // 2
            window = Window(col - half, row - half, window_size, window_size)
            values = src.read(1, window=window, boundless=True, fill_value=0)
            values = values[values != 0]  # 0 = nodata, outside the tile/window edge
            if values.size == 0:
                raise ValueError("window entirely nodata")
            vals, counts = np.unique(values, return_counts=True)
            return int(vals[np.argmax(counts)])


def classify_point(lat, lon, conn=None, window_size=5):
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

    key = _grid_key(lat, lon, window_size)
    cached = conn.execute("SELECT class_code FROM lookups WHERE grid_key = ?", (key,)).fetchone()
    if cached is not None:
        code = cached[0]
        if owns_conn:
            conn.close()
        return CLASS_MAP.get(code, "otro"), code

    try:
        code = _fetch_pixel_code(lat, lon, window_size)
    except Exception as e:
        tile = _tile_name(lat, lon)
        print(f"  WorldCover lookup failed for ({lat}, {lon}) tile {tile}: {e}")
        if owns_conn:
            conn.close()
        return None, None

    conn.execute("INSERT OR REPLACE INTO lookups (grid_key, class_code) VALUES (?, ?)", (key, code))
    conn.commit()
    if owns_conn:
        conn.close()
    return CLASS_MAP.get(code, "otro"), code


def classify_batch(points, max_workers=20, window_size=5):
    """
    points: list of (lat, lon) tuples.
    Returns a list of (category, class_code) in the same order.

    Cache lookups happen sequentially first (fast, local SQLite, not the
    bottleneck). Only the actual S3 reads for cache MISSES get
    parallelized -- each worker thread does a self-contained, DB-free S3
    read (_fetch_pixel_code); results get written back to the cache
    afterward from a single connection/thread, avoiding any concurrent
    SQLite access entirely rather than trying to make that safe.
    For a few thousand+ points this is the difference between minutes and
    hours -- worth it once a real sample this size is involved.
    """
    conn = _init_cache()
    keys = [_grid_key(lat, lon, window_size) for lat, lon in points]

    cached_codes = {}
    for key in set(keys):
        row = conn.execute("SELECT class_code FROM lookups WHERE grid_key = ?", (key,)).fetchone()
        if row is not None:
            cached_codes[key] = row[0]

    to_fetch = [(i, lat, lon) for i, (lat, lon) in enumerate(points) if keys[i] not in cached_codes]
    fetched_codes = {}
    if to_fetch:
        print(f"  {len(points) - len(to_fetch)} cached, fetching {len(to_fetch)} new points "
              f"({max_workers} parallel, window_size={window_size})...")
        progress_every = max(1, len(to_fetch) // 20)
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(_fetch_pixel_code, lat, lon, window_size): i for i, lat, lon in to_fetch}
            done = 0
            for future in as_completed(futures):
                i = futures[future]
                try:
                    # Belt-and-suspenders on top of GDAL_HTTP_TIMEOUT: if a
                    # future somehow still doesn't resolve, don't let it
                    # block the whole batch forever waiting on it.
                    fetched_codes[i] = future.result(timeout=30)
                except Exception:
                    fetched_codes[i] = None
                done += 1
                if done % progress_every == 0 or done == len(to_fetch):
                    print(f"    {done}/{len(to_fetch)} fetched...")

    results = []
    for i, key in enumerate(keys):
        if key in cached_codes:
            code = cached_codes[key]
        else:
            code = fetched_codes.get(i)
            if code is not None:
                conn.execute("INSERT OR REPLACE INTO lookups (grid_key, class_code) VALUES (?, ?)", (key, code))
        results.append((CLASS_MAP.get(code, "otro") if code is not None else None, code))
    conn.commit()
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
