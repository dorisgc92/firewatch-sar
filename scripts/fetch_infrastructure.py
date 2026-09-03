"""
fetch_infrastructure.py
=======================
Fetches critical infrastructure from OpenStreetMap via Overpass API.
Focuses on facilities relevant to wildfire emergency response.

Outputs: data/infrastructure.geojson
Progress state: data/infra_progress.json

OpenStreetMap data: © OpenStreetMap contributors, ODbL license
Overpass API: https://overpass-api.de/

WORLD COVERAGE, ONE TILE AT A TIME
-----------------------------------
A single Overpass query for the whole world (or even one big country) times
out on the shared public Overpass server -- we learned this the hard way
when adding just the industrial-landuse tag over the Mexico/US bbox wiped
out a season's worth of data (see the zero-features safety check below).

So instead of one giant request, the world is split into small tiles
(WORLD_TILE_SIZE_DEG degrees square). Each run of this script fetches
exactly ONE tile, merges its features into the existing
data/infrastructure.geojson (features from every other tile are left
untouched), and advances a progress cursor in data/infra_progress.json for
the next run to pick up where this one left off. Scheduling this to run
every ~15-20 minutes means a full pass over the whole world completes in
about a week -- slow, but it never blows a timeout budget, and the
dataset keeps growing/refreshing indefinitely (it just loops back to tile
0 and starts a fresh pass once it reaches the end).

How to run manually:
    python scripts/fetch_infrastructure.py                  # next tile in the crawl
    python scripts/fetch_infrastructure.py --bbox "-118,14,-86,33"   # one-off region, bypasses the crawler
"""

import json
import sys
import os
import argparse
import time
import requests
from datetime import datetime, timezone
from manifest import update_manifest, stabilize_generated_at

OUTPUT_PATH = "data/infrastructure.geojson"
PROGRESS_PATH = "data/infra_progress.json"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# The main public instance times out under load fairly often. Kumi Systems
# runs a well-provisioned public mirror of the same data and explicitly
# welcomes use "for any project" (wiki.openstreetmap.org/wiki/Overpass_API).
# Tried in order; falls through to the next only if the previous one fails.
OVERPASS_URLS = [
    OVERPASS_URL,
    "https://overpass.kumi.systems/api/interpreter",
]

# Default bbox — covers Mexico + US border region (used only for manual
# --bbox one-off runs; the scheduled crawl uses WORLD_TILES instead).
DEFAULT_BBOX = "-118,14,-86,33"

# Tile size for the world crawl. Smaller = safer against timeouts but more
# runs (and more days) needed for full coverage. 10 degrees keeps most
# tiles well within the Overpass timeout even over dense urban areas,
# while keeping the full-world tile count manageable (~650 tiles incl.
# ocean, which return near-instantly).
WORLD_TILE_SIZE_DEG = 10
# Skip the poles -- negligible population/infrastructure, not worth tiles.
WORLD_LAT_RANGE = (-60, 80)
WORLD_LON_RANGE = (-180, 180)


def build_world_tiles():
    """Generates the full list of (west, south, east, north) tile bboxes covering the crawl area."""
    tiles = []
    lat = WORLD_LAT_RANGE[0]
    while lat < WORLD_LAT_RANGE[1]:
        lon = WORLD_LON_RANGE[0]
        while lon < WORLD_LON_RANGE[1]:
            tiles.append((lon, lat, lon + WORLD_TILE_SIZE_DEG, lat + WORLD_TILE_SIZE_DEG))
            lon += WORLD_TILE_SIZE_DEG
        lat += WORLD_TILE_SIZE_DEG
    return tiles


WORLD_TILES = build_world_tiles()

# Infrastructure categories to fetch.
# Each entry: (OSM tag key, OSM tag value, display label, color, icon)
#
# Split into two groups because a WORLD-scale crawl of some of these tags
# would blow past GitHub's 100MB file limit almost immediately -- schools
# alone came to ~10,000 features for just the state of Jalisco in early
# testing; extrapolated worldwide, schools/water bodies/fuel stations would
# be in the millions. So:
#   CORE_WORLD_TYPES  -- relatively rare, high wildfire-response value.
#                        Safe to crawl and store for the whole planet.
#   ZONE_ONLY_TYPES   -- numerous/lower-priority categories. Only fetched
#                        on demand for whatever zone the responder is
#                        actually looking at (see utils/liveInfra.js on the
#                        frontend), never accumulated into the global file.
CORE_WORLD_TYPES = [
    ("amenity",  "hospital",          "Hospital",           "#FF4444", "ðŸ¥"),
    ("amenity",  "fire_station",      "Fire Station",       "#FF6600", "ðŸš’"),
    ("amenity",  "police",            "Police Station",     "#0044FF", "ðŸ‘®"),
    ("power",    "substation",        "Power Substation",   "#FFAA00", "âš¡"),
    ("power",    "plant",             "Power Plant",        "#FF8800", "âš¡"),
    ("aeroway",  "aerodrome",         "Airport/Airfield",   "#44AAFF", "âœˆï¸"),
]

ZONE_ONLY_TYPES = [
    ("amenity",  "clinic",            "Clinic",             "#FF8888", "ðŸ¥"),
    ("amenity",  "school",            "School (shelter)",   "#AA44FF", "ðŸ«"),
    ("man_made", "tower",             "Tower",              "#666666", "ðŸ“¡"),
    ("amenity",  "fuel",              "Fuel Station",       "#FFDD00", "â›½"),
    ("landuse",  "reservoir",         "Water Reservoir",    "#0088FF", "ðŸ’§"),
    ("natural",  "water",             "Water Body",         "#4488FF", "ðŸ’§"),
]

# Kept for anything that still wants "every category" (e.g. a manual --bbox
# refresh of a specific, deliberately small region where size isn't a
# concern) and so classify_element() can label an element regardless of
# which query it came from.
INFRASTRUCTURE_TYPES = CORE_WORLD_TYPES + ZONE_ONLY_TYPES

# Industrial sites (cement plants, factories, refineries, quarries...) run
# hot 24/7 and are a common source of satellite thermal-anomaly false
# positives for wildfire -- VIIRS/MODIS just see "hot pixel", not "kiln" vs
# "wildfire". Fetched separately (own Overpass call) from the rest of
# INFRASTRUCTURE_TYPES: landuse=industrial in particular is an extremely
# common OSM tag, and adding it to the already-large main query caused the
# whole request to time out on the shared public Overpass server, which
# silently produced a *valid but empty* response -- overwriting a season's
# worth of good hospital/school/etc. data with nothing (see main()'s
# zero-features safety check for the other half of this fix). Keeping this
# query separate means a timeout here only loses the industrial layer for
# this run, never the rest of the infrastructure dataset. Included in the
# world crawl (explicitly requested, and needed everywhere for the
# wildfire/false-positive flagging to work globally).
INDUSTRIAL_TYPES = [
    ("landuse",  "industrial",        "Industrial Zone",    "#996633", "factory"),
    ("man_made", "works",             "Industrial Zone",    "#996633", "factory"),
]

# Urban-area markers -- this category never actually existed anywhere in
# this file before: fetch_firms.py's classify_vegetation_likelihood() has
# been checking for a "Urban Area" type this whole time, but nothing here
# ever produced one, so that half of the vegetation-vs-urban heuristic has
# silently done nothing since it was written (industrial-proximity still
# worked; urban-proximity never did). place=city/town/suburb nodes are OSM's
# standard way of marking a settlement's approximate center -- not a
# precise footprint, which is exactly why the heuristic's URBAN_RADIUS_KM
# in fetch_firms.py is generous (2km) rather than tight. Kept as its own
# query for the same reason INDUSTRIAL_TYPES is separate: isolating it
# means a timeout here only loses urban-area data for this run, not the
# whole crawl.
URBAN_TYPES = [
    ("place", "city",   "Urban Area", "#888888", "city"),
    ("place", "town",   "Urban Area", "#888888", "city"),
    ("place", "suburb", "Urban Area", "#888888", "city"),
]

# Actual polygon boundaries (not point markers) of built-up land use --
# the override signal for the specific failure mode this was built to
# catch: a WorldCover pixel reading "vegetation" (a big backyard tree
# canopy, an undeveloped lot) sitting squarely inside a residential
# neighborhood, which a human looking at the same spot on a map would
# unambiguously call "urban". WorldCover answers "what covers this exact
# 10m pixel"; this answers "is this pixel inside a neighborhood's
# boundary" -- a genuinely different question, which is why tuning
# WorldCover's own read (window size 1x1 through 7x7, all tried earlier)
# never closed this gap on its own.
URBAN_LANDUSE_TYPES = [
    ("landuse", "residential", "Urban Landuse", "#888888", "home"),
    ("landuse", "commercial",  "Urban Landuse", "#888888", "store"),
    ("landuse", "retail",      "Urban Landuse", "#888888", "store"),
]


def build_polygon_query(bbox, types):
    """
    Same idea as build_overpass_query, but requests full boundary
    geometry (`out geom;`) instead of just a way's center point --
    point-in-polygon needs the actual ring, not a centroid. Only queries
    `way` (landuse polygons are essentially never simple point nodes) and
    deliberately skips `relation` (OSM multipolygon relations, used for
    landuse areas with holes or multiple disjoint parts) -- the added
    parsing complexity isn't worth it for what's fundamentally still just
    a helpful override signal, not the primary classification.
    """
    west, south, east, north = bbox.split(",")
    bbox_str = f"{south},{west},{north},{east}"
    tag_queries = [f'  way["{key}"="{value}"]({bbox_str});' for key, value, *_ in types]
    return f"""
[out:json][timeout:60];
(
{chr(10).join(tag_queries)}
);
out geom;
"""


def parse_polygon_response(data):
    """
    Converts an `out geom;` Overpass response into a list of
    {osm_id, bbox: (west, south, east, north), ring: [(lat, lon), ...]}
    dicts, ready for remote_server/store.py's landuse_polygons table.
    Ways with fewer than 3 vertices (degenerate/incomplete geometry) are
    skipped -- not a valid polygon.
    """
    polygons = []
    for el in data.get("elements", []):
        if el.get("type") != "way":
            continue
        geometry = el.get("geometry")
        if not geometry or len(geometry) < 3:
            continue
        ring = [(pt["lat"], pt["lon"]) for pt in geometry]
        lats = [p[0] for p in ring]
        lons = [p[1] for p in ring]
        polygons.append({
            "osm_id": el["id"],
            "bbox": (min(lons), min(lats), max(lons), max(lats)),
            "ring": ring,
        })
    return polygons


def fetch_urban_polygons(bbox, max_retries_per_server=2):
    """Same retry/mirror-fallback pattern as fetch_overpass, but for
    polygon boundary data via build_polygon_query/parse_polygon_response.
    Returns None (not an empty list) if every attempt failed outright --
    same "don't trust this, don't overwrite good data with it" signal
    fetch_overpass uses."""
    query = build_polygon_query(bbox, URBAN_LANDUSE_TYPES)
    headers = {"User-Agent": "FireWatchSAR/1.0 (IEEE Response Quest 2026; contact: dorisgc92@github.com)"}

    for server_url in OVERPASS_URLS:
        for attempt in range(1, max_retries_per_server + 1):
            try:
                r = requests.post(server_url, data={"data": query}, timeout=90, headers=headers)
                r.raise_for_status()
                polygons = parse_polygon_response(r.json())
                print(f"  Got {len(polygons)} urban landuse polygons (via {server_url})")
                return polygons
            except Exception as e:
                print(f"  urban landuse polygons attempt {attempt}/{max_retries_per_server} on {server_url} failed: {e}")
                if attempt < max_retries_per_server:
                    time.sleep(5)

    print("  ERROR: all Overpass mirrors failed for urban landuse polygons.")
    return None


def build_overpass_query(bbox, types):
    """Build Overpass QL query for the given infrastructure types within bbox."""
    west, south, east, north = bbox.split(",")
    bbox_str = f"{south},{west},{north},{east}"  # Overpass uses S,W,N,E

    tag_queries = []
    for key, value, *_ in types:
        tag_queries.append(f'  node["{key}"="{value}"]({bbox_str});')
        tag_queries.append(f'  way["{key}"="{value}"]({bbox_str});')

    query = f"""
[out:json][timeout:60];
(
{chr(10).join(tag_queries)}
);
out center;
"""
    return query


def classify_element(tags, types):
    """Determine infrastructure type and display properties from OSM tags."""
    for key, value, label, color, icon in types:
        if tags.get(key) == value:
            return label, color, icon
    return "Other", "#888888", "ðŸ“"


def fetch_overpass(bbox, types, label, max_retries_per_server=2):
    """
    Runs one Overpass query for a given set of tag types. Returns the parsed
    feature list, or None if every server/attempt failed outright (network
    error, HTTP error) or the response looked like a silent timeout. None
    signals "don't trust this, don't overwrite good data with it" to the
    caller.

    The main public instance (overpass-api.de) has been timing out (504)
    frequently under load. Rather than just retrying the same overloaded
    server, this tries each configured mirror in turn, with a couple of
    quick attempts per server, before giving up entirely.
    """
    query = build_overpass_query(bbox, types)
    headers = {"User-Agent": "FireWatchSAR/1.0 (IEEE Response Quest 2026; contact: dorisgc92@github.com)"}

    for server_url in OVERPASS_URLS:
        for attempt in range(1, max_retries_per_server + 1):
            try:
                r = requests.post(server_url, data={"data": query}, timeout=90, headers=headers)
                r.raise_for_status()
                resp_data = r.json()
                features = parse_overpass_response(resp_data, types)
                print(f"  Got {len(features)} {label} elements (via {server_url})")
                return features
            except Exception as e:
                print(f"  {label} attempt {attempt}/{max_retries_per_server} on {server_url} failed: {e}")
                if attempt < max_retries_per_server:
                    time.sleep(5)

    print(f"  ERROR: all Overpass mirrors failed for {label}.")
    return None


# landuse polygons for the "is this point inside a residential/commercial
# area" check (see api.py's classify-landcover). Separate from
# fetch_overpass above because these need FULL way geometry (out geom;)
# to do real point-in-polygon testing, not just a centroid (out center;)
# -- a centroid can't tell you whether a point is inside a large,
# irregularly-shaped neighborhood or just somewhere in its general
# vicinity, which is exactly the failure mode a plain proximity check
# already had before (see the original OSM-heuristic post-mortem this
# replaced).
URBAN_LANDUSE_TYPES = [("landuse", "residential"), ("landuse", "commercial"), ("landuse", "retail")]


def build_urban_polygon_query(bbox):
    west, south, east, north = bbox.split(",")
    bbox_str = f"{south},{west},{north},{east}"
    tag_queries = [f'  way["{key}"="{value}"]({bbox_str});' for key, value in URBAN_LANDUSE_TYPES]
    return f"""
[out:json][timeout:60];
(
{chr(10).join(tag_queries)}
);
out geom;
"""


def parse_urban_polygons(data):
    """Each OSM way becomes one polygon ring: a list of [lat, lon] points,
    plus its own bounding box (stored alongside so the DB can filter
    candidates fast before doing the more expensive point-in-polygon
    test -- see store.py's query_polygons_near)."""
    polygons = []
    for el in data.get("elements", []):
        if el.get("type") != "way":
            continue
        geom = el.get("geometry")
        if not geom or len(geom) < 3:
            continue
        ring = [[pt["lat"], pt["lon"]] for pt in geom]
        lats = [p[0] for p in ring]
        lons = [p[1] for p in ring]
        polygons.append({
            "osm_id": el.get("id"),
            "ring": ring,
            "bbox": (min(lats), min(lons), max(lats), max(lons)),
        })
    return polygons


def fetch_urban_polygons(bbox, max_retries_per_server=2):
    """Same multi-mirror retry pattern as fetch_overpass, but for landuse
    polygons instead of point features -- kept separate since the query
    shape (out geom; vs out center;) and the parsed result shape (rings
    vs points) are different enough that sharing one function would need
    a branch at every step anyway."""
    query = build_urban_polygon_query(bbox)
    headers = {"User-Agent": "FireWatchSAR/1.0 (IEEE Response Quest 2026; contact: dorisgc92@github.com)"}

    for server_url in OVERPASS_URLS:
        for attempt in range(1, max_retries_per_server + 1):
            try:
                r = requests.post(server_url, data={"data": query}, timeout=90, headers=headers)
                r.raise_for_status()
                polygons = parse_urban_polygons(r.json())
                print(f"  Got {len(polygons)} urban landuse polygons (via {server_url})")
                return polygons
            except Exception as e:
                print(f"  urban polygons attempt {attempt}/{max_retries_per_server} on {server_url} failed: {e}")
                if attempt < max_retries_per_server:
                    time.sleep(5)

    print("  ERROR: all Overpass mirrors failed for urban polygons.")
    return None


def parse_overpass_response(data, types):
    """Convert Overpass API response to GeoJSON features."""
    features = []
    elements = data.get("elements", [])

    for el in elements:
        # Get coordinates (nodes have lat/lon directly; ways have a center)
        if el["type"] == "node":
            lat = el.get("lat")
            lon = el.get("lon")
        elif el["type"] == "way":
            center = el.get("center", {})
            lat = center.get("lat")
            lon = center.get("lon")
        else:
            continue

        if lat is None or lon is None:
            continue

        tags = el.get("tags", {})
        label, _color, _icon = classify_element(tags, types)

        name = (tags.get("name") or tags.get("name:en") or
                tags.get("name:es") or label)

        # Only name/type/osm_id/osm_type/coordinates are ever read by the
        # frontend (confirmed by grepping frontend/src -- color/icon/
        # source/osm_url are unused, and address/phone/operator/capacity/
        # emergency are almost always empty strings from OSM). At world
        # scale (hundreds of thousands of features, one lap = every
        # hospital/fire station/police/power/airport on the planet) that
        # dead weight was the direct cause of infrastructure.geojson
        # crossing GitHub's 100MB push limit -- every push since has been
        # silently rejected, freezing the crawl on whatever tile it was on
        # when that first happened. Optional OSM tag fields are only
        # included when actually present, instead of always writing an
        # empty string.
        props = {
            "name": name,
            "type": label,
            "osm_id": el.get("id"),
            "osm_type": el["type"],
        }
        for tag_key, prop_key in (("addr:street", "address"), ("phone", "phone"),
                                   ("operator", "operator"), ("capacity", "capacity"),
                                   ("emergency", "emergency")):
            val = tags.get(tag_key)
            if val:
                props[prop_key] = val

        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [lon, lat]
            },
            "properties": props
        })

    return features


def load_progress():
    if os.path.exists(PROGRESS_PATH):
        try:
            with open(PROGRESS_PATH, "r") as f:
                return json.load(f)
        except json.JSONDecodeError:
            pass
    return {"next_index": 0, "laps_completed": 0, "last_tile_bbox": None, "last_lap_completed_year": None}


def save_progress(progress):
    with open(PROGRESS_PATH, "w") as f:
        json.dump(progress, f, indent=2)


def merge_features(existing_features, new_features, tile_bbox_str):
    """
    Merges one tile's freshly-fetched features into the accumulated global
    dataset: replaces anything previously stored for THIS tile (so a
    re-crawl refreshes stale entries) while leaving every other tile's
    features untouched, and de-duplicates by (osm_type, osm_id) in case an
    element straddles a tile boundary and gets returned by two tiles.
    """
    kept = [f for f in existing_features if f["properties"].get("_tile") != tile_bbox_str]
    for f in new_features:
        f["properties"]["_tile"] = tile_bbox_str

    seen = set()
    merged = []
    for f in kept + new_features:
        key = (f["properties"].get("osm_type"), f["properties"].get("osm_id"))
        if key in seen and key != (None, None):
            continue
        seen.add(key)
        merged.append(f)
    return merged


def main():
    parser = argparse.ArgumentParser(description="Fetch infrastructure from OpenStreetMap")
    parser.add_argument(
        "--bbox",
        default=None,
        help="One-off bounding box: west,south,east,north. If omitted, fetches "
             "the next tile in the world crawl (data/infra_progress.json)."
    )
    args = parser.parse_args()

    os.makedirs("data", exist_ok=True)

    manual_run = args.bbox is not None
    if manual_run:
        bbox_str = args.bbox
        progress = None
    else:
        progress = load_progress()
        tile = WORLD_TILES[progress["next_index"] % len(WORLD_TILES)]
        bbox_str = ",".join(str(v) for v in tile)

        current_year = datetime.now(timezone.utc).year
        force = os.environ.get("FORCE_CRAWL") == "true"
        if (progress["next_index"] == 0
                and progress.get("last_lap_completed_year") == current_year
                and not force):
            print(f"World crawl already completed for {current_year} -- skipping "
                  f"(runs once a year). Trigger manually with FORCE_CRAWL=true to override.")
            return

        print(f"World crawl: tile {progress['next_index'] % len(WORLD_TILES)}/{len(WORLD_TILES)} "
              f"(lap {progress['laps_completed']}) -- bbox {bbox_str}")

    # How many features a previous successful run already had committed —
    # used below to tell "genuinely nothing out there" apart from "Overpass
    # silently failed", so a bad run can never wipe out good data.
    existing_features = []
    previous_total = 0
    if os.path.exists(OUTPUT_PATH):
        try:
            with open(OUTPUT_PATH, "r") as f:
                existing = json.load(f)
            existing_features = existing.get("features", [])
            previous_total = existing.get("metadata", {}).get("total", 0) or 0
        except (json.JSONDecodeError, FileNotFoundError):
            pass

    print(f"Fetching infrastructure for bbox: {bbox_str}")
    # The world crawl only fetches the compact, high-value category set
    # (CORE_WORLD_TYPES) to keep the accumulated file well under GitHub's
    # size limit. A manual one-off --bbox run (a deliberately small,
    # specific region) still gets every category, matching the old
    # behavior, since size isn't a concern at that scale.
    core_types = INFRASTRUCTURE_TYPES if manual_run else CORE_WORLD_TYPES
    features = fetch_overpass(bbox_str, core_types, "core infrastructure")

    if features is None:
        print("Core infrastructure fetch failed outright -- keeping last committed data, not overwriting.")
        sys.exit(1)

    if len(features) == 0 and manual_run and previous_total > 0:
        # This guard only makes sense for a one-off full-region refresh,
        # where "0 results" for a big populated bbox is almost certainly a
        # silent Overpass failure. In the tile crawl, an individual 10°
        # tile legitimately CAN be all ocean/desert with zero features, so
        # this check is skipped there — a bad tile just contributes
        # nothing this lap and gets re-tried next time the crawl reaches it.
        print(f"WARNING: got 0 features but the last commit had {previous_total} -- "
              f"this looks like a silent Overpass failure, not a real result. Keeping last committed data.")
        sys.exit(1)

    # Industrial zones are fetched as a separate, best-effort query -- if
    # THIS one times out (it's a much heavier tag over the same bbox), we
    # still keep everything else. Missing industrial data for one run just
    # means the wildfire/false-positive flagging is slightly less complete
    # until the next successful fetch, never a data-loss event.
    industrial_features = fetch_overpass(bbox_str, INDUSTRIAL_TYPES, "industrial zone")
    if industrial_features is None:
        print("Industrial zone fetch failed -- continuing without it for this run.")
        industrial_features = []

    new_features = features + industrial_features

    if manual_run:
        all_features = new_features
    else:
        all_features = merge_features(existing_features, new_features, bbox_str)

    print(f"This run: {len(new_features)} new/updated elements. Total accumulated: {len(all_features)}")

    # Count by type
    type_counts = {}
    for feat in all_features:
        t = feat["properties"]["type"]
        type_counts[t] = type_counts.get(t, 0) + 1

    geojson = {
        "type": "FeatureCollection",
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "OpenStreetMap via Overpass API",
            "license": "ODbL — © OpenStreetMap contributors",
            "bbox": bbox_str if manual_run else "world (crawled tile by tile)",
            "description": (
                "Critical infrastructure relevant to wildfire emergency response. "
                "Includes hospitals, fire stations, police, power infrastructure, "
                "water resources, and industrial zones (used to flag likely "
                "non-wildfire thermal detections). Used for vulnerability assessment."
            ),
            "total": len(all_features),
            "by_type": type_counts,
        },
        "features": all_features
    }

    geojson = stabilize_generated_at(geojson, OUTPUT_PATH)

    # Compact (no indent) rather than pretty-printed -- this file is only
    # ever machine-read (frontend fetch, this same script's next run), so
    # the indentation whitespace was pure overhead, adding up fast at
    # hundreds of thousands of features. Combined with dropping the unused
    # per-feature fields above, this is what keeps the world crawl under
    # GitHub's 100MB push limit -- see the note above parse_overpass_response
    # for the incident this fixes.
    with open(OUTPUT_PATH, "w") as f:
        json.dump(geojson, f, separators=(",", ":"))
    update_manifest("infrastructure", OUTPUT_PATH)

    # Loud early warning rather than a silent rejected push next time this
    # creeps back up -- 90MB gives a few runs' worth of margin (a tile
    # typically adds well under 1MB) to notice and act before hitting
    # GitHub's hard 100MB limit again.
    written_size_mb = os.path.getsize(OUTPUT_PATH) / (1024 * 1024)
    if written_size_mb > 90:
        print(f"WARNING: {OUTPUT_PATH} is {written_size_mb:.1f} MB -- approaching "
              f"GitHub's 100MB push limit. Consider sharding this file (e.g. one "
              f"file per continent) before it blocks the crawl again.")

    if not manual_run:
        progress["next_index"] = (progress["next_index"] + 1) % len(WORLD_TILES)
        progress["last_tile_bbox"] = bbox_str
        if progress["next_index"] == 0:
            progress["laps_completed"] += 1
            progress["last_lap_completed_year"] = datetime.now(timezone.utc).year
            print(f"World crawl completed lap {progress['laps_completed']} -- starting over from tile 0.")
        save_progress(progress)

    print(f"Saved {OUTPUT_PATH}")
    for t, count in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"  {t}: {count}")


if __name__ == "__main__":
    main()