"""
fetch_firms.py
==============
Fetches active fire hotspots from NASA FIRMS API (VIIRS + MODIS).
Outputs: data/hotspots.geojson

NASA FIRMS API docs: https://firms.modaps.eosdis.nasa.gov/api/
Free API key: https://firms.modaps.eosdis.nasa.gov/api/

Environment variables required:
    FIRMS_MAP_KEY  — your NASA FIRMS API key (set as GitHub Secret)

How to run manually:
    export FIRMS_MAP_KEY="your_key_here"
    python scripts/fetch_firms.py
"""

import os
import json
import math
import requests
import csv
import io
import time
from collections import defaultdict
from datetime import datetime, timezone
from manifest import update_manifest, stabilize_generated_at

# ── Configuration ──────────────────────────────────────────────────────────────

FIRMS_API_KEY = os.environ.get("FIRMS_MAP_KEY", "")

# Global bounding box — kept for reference, but NOT used for requests
# anymore: NASA's area/csv endpoint silently returns a header with zero
# data rows for the full-world extent (-180,-90,180,90) AND for the
# literal 'world' keyword, confirmed by testing directly in a browser with
# a known-good MAP_KEY (their own South America example URL worked fine,
# ruling out the key/account). Splitting into continental regions below
# works around this undocumented quirk/limit on their end.
WORLD_BBOX = "-180,-90,180,90"

# Continental regions covering the whole world, used instead of one
# world-spanning request. Slight overlap at the edges is fine — dedup
# happens later by rounded coordinates regardless of which region a
# detection came from.
REGIONS = [
    ("North America",      "-170,5,-50,75"),
    ("South America",      "-85,-57,-32,14"),
    ("Europe",             "-25,34,45,72"),
    ("Africa",             "-20,-38,55,38"),
    ("Asia",               "45,-12,180,78"),
    ("Oceania",            "110,-50,180,0"),
]

# Days to look back (1 = last 24 hours, max 10)
DAYS = 1

# Data sources: VIIRS is higher resolution (375m). NASA discontinues Suomi
# NPP data delivery on 2026-11-01 (see FIRMS notifications banner) — VIIRS_
# SNPP_NRT removed proactively rather than waiting for it to start failing
# in production. NOAA-20 and NOAA-21 (VIIRS's replacement satellites) plus
# MODIS (Aqua+Terra combined by NASA's API under one endpoint) still cover
# the same detection capability.
SOURCES = [
    {
        "name": "VIIRS_NOAA20_NRT",
        "label": "VIIRS (NOAA-20)",
        "resolution_m": 375,
    },
    {
        "name": "VIIRS_NOAA21_NRT",
        "label": "VIIRS (NOAA-21)",
        "resolution_m": 375,
    },
    {
        "name": "MODIS_NRT",
        "label": "MODIS (Terra/Aqua)",
        "resolution_m": 1000,
    },
]

OUTPUT_PATH = "data/hotspots.geojson"

# Sanity floor for the "did this run actually get global coverage" check
# below (not the hard 0-hotspots guard, which was already here). Global,
# 24h, 6-continent, 3-satellite-pair days have consistently landed in the
# thousands-to-tens-of-thousands range in practice -- 500 is comfortably
# below any real day's count while still well above what a partial-NRT-
# pipeline run (data published for maybe one region) tends to produce.
MIN_EXPECTED_HOTSPOTS = 500

# FRP thresholds for intensity classification
# FRP = Fire Radiative Power (MW)
def classify_intensity(frp):
    """Classify fire intensity based on Fire Radiative Power (MW)."""
    try:
        frp = float(frp)
    except (ValueError, TypeError):
        return "unknown"
    if frp < 10:
        return "low"
    elif frp < 50:
        return "moderate"
    elif frp < 200:
        return "high"
    else:
        return "extreme"


def fetch_firms_csv(source_name, bbox, max_retries=3):
    """
    Fetch FIRMS data as CSV for a given source and region bbox.
    Returns list of dicts, one per hotspot.

    Retries a few times with backoff before giving up on this
    source+region -- transient network blips (DNS hiccups, GitHub Actions
    runner routing issues, a momentary NASA-side outage) are common enough
    at a 10-minute cadence that treating the very first failure as final
    wastes a whole cycle's data for no reason. A run only reports this
    source+region as failed after every attempt has failed.
    """
    url = (
        f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
        f"{FIRMS_API_KEY}/{source_name}/{bbox}/{DAYS}"
    )

    print(f"  Fetching {source_name} ({bbox}) from NASA FIRMS...")

    # requests' default User-Agent ("python-requests/x.y") is a well-known
    # automated-traffic signature that CDNs/WAFs in front of an API commonly
    # filter or silently degrade, especially from cloud/CI IP ranges like
    # GitHub Actions runners. This matches the exact pattern we're seeing:
    # the identical query works from a home browser and returns nothing
    # (but no error) from GitHub Actions. A normal browser User-Agent is
    # the standard, low-risk fix to try first.
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
    }

    response = None
    for attempt in range(1, max_retries + 1):
        try:
            response = requests.get(url, timeout=60, headers=headers)
            response.raise_for_status()
            break
        except requests.exceptions.RequestException as e:
            if attempt < max_retries:
                wait_s = 5 * attempt
                print(f"  Attempt {attempt}/{max_retries} for {source_name} failed ({e}); retrying in {wait_s}s...")
                time.sleep(wait_s)
            else:
                print(f"  ERROR fetching {source_name} after {max_retries} attempts: {e}")
                return []

    # Parse CSV
    content = response.text
    stripped = content.strip()

    if not stripped:
        print(f"  EMPTY RESPONSE for {source_name} (no error message, no data).")
        return []

    # NASA FIRMS returns plain-text error messages for bad/expired keys or
    # quota issues (e.g. "Invalid MAP_KEY", "You have exceeded your
    # transaction limit"). These don't always start with the word "Error",
    # so we also treat "no comma in the first line" as a signal this isn't
    # a CSV header — that silently produced 0 rows before, which looked
    # identical to "no fires today" in the app.
    first_line = stripped.splitlines()[0]
    looks_like_csv_header = "," in first_line and "latitude" in first_line.lower()

    if not looks_like_csv_header:
        print(f"  ERROR-LIKE RESPONSE for {source_name} (not a CSV header): {stripped[:300]!r}")
        return []

    reader = csv.DictReader(io.StringIO(content))
    rows = list(reader)
    print(f"  Got {len(rows)} hotspots from {source_name}")
    if len(rows) == 0:
        # A well-formed CSV header with zero data rows is a different (and
        # more specific) signal than an "Invalid MAP_KEY"-style plain-text
        # error -- it usually means the key is valid but throttled/rate
        # limited for this request, or (rarely) a genuine momentary gap in
        # NASA's NRT feed. Printing the raw response lets a human tell
        # those apart at a glance instead of guessing from "0 hotspots"
        # alone -- check for anything past just the header line.
        print(f"  (Header-only response, no data rows. Raw response: {stripped[:300]!r})")
    return rows


def row_to_feature(row, source_label, resolution_m):
    """
    Convert a FIRMS CSV row to a GeoJSON Feature.

    VIIRS columns: latitude, longitude, bright_ti4, scan, track,
                   acq_date, acq_time, satellite, confidence, version,
                   bright_ti5, frp, daynight
    MODIS columns: latitude, longitude, brightness, scan, track,
                   acq_date, acq_time, satellite, instrument,
                   confidence, version, bright_t31, frp, daynight

    Some FIRMS distributions also include a `type` column classifying the
    thermal anomaly itself (0=presumed vegetation fire, 1=active volcano,
    2=other static/industrial land source, 3=offshore). It isn't present
    on every endpoint/sensor combination, so this is read defensively —
    when present, it lets us flag likely non-wildfire detections (gas
    flares, industrial plants, volcanoes) instead of showing every thermal
    anomaly as an undifferentiated "fire". When absent, `fire_type` is
    just null and every detection displays exactly as before.
    """
    try:
        lat = float(row.get("latitude", 0))
        lon = float(row.get("longitude", 0))
    except ValueError:
        return None

    frp = row.get("frp", "0")
    confidence = row.get("confidence", "n")
    acq_date = row.get("acq_date", "")
    acq_time = row.get("acq_time", "")
    daynight = row.get("daynight", "D")

    fire_type_raw = row.get("type", "")
    fire_type = None
    fire_type_label = None
    if fire_type_raw not in (None, ""):
        try:
            fire_type = int(fire_type_raw)
            fire_type_label = {
                0: "vegetation_fire",
                1: "volcano",
                2: "static_land_source",
                3: "offshore",
            }.get(fire_type, "unknown")
        except ValueError:
            fire_type = None

    # Build acquisition datetime string. acq_time from FIRMS isn't always
    # zero-padded to 4 digits (e.g. "550" for 05:50, not "0550") — slicing
    # an unpadded value produced garbage like "55:0Z" instead of "05:50Z".
    # zfill(4) normalizes it before splitting into HH:MM.
    acq_time_padded = acq_time.zfill(4) if acq_time else acq_time
    acq_datetime = f"{acq_date} {acq_time_padded[:2]}:{acq_time_padded[2:]}Z" if acq_time_padded else acq_date

    return {
        "type": "Feature",
        "geometry": {
            "type": "Point",
            "coordinates": [lon, lat]
        },
        "properties": {
            "source": source_label,
            "resolution_m": resolution_m,
            "frp": float(frp) if frp else None,
            "intensity": classify_intensity(frp),
            "confidence": confidence,
            "acq_datetime": acq_datetime,
            "daynight": "Day" if daynight == "D" else "Night",
            "fire_type": fire_type,
            "fire_type_label": fire_type_label,
        }
    }


INFRASTRUCTURE_PATH = "data/infrastructure.geojson"

# Set as a GitHub Actions secret pointing at the same Cloudflare Tunnel URL
# used for INFRA_API_URL on Vercel (see remote_server/README.md). Optional
# on purpose -- this workflow must keep working even if that machine is
# off or the secret was never configured, just with staler classification
# data (whatever's still checked into INFRASTRUCTURE_PATH, if anything).
LANDCOVER_INDEX_URL = os.environ.get("INFRA_LANDCOVER_URL")

# Same thresholds as the frontend's isNearIndustrialSite/isNearUrbanArea
# (frontend/src/utils/spatial.js) — kept identical so moving this
# computation server-side doesn't change what counts as "likely not a
# wildfire". 0.3km for industrial sites (tight — these are usually
# small, precisely-mapped point features); 2km for urban areas (generous,
# since an OSM place node marks only an approximate city-center point, not
# the true built-up footprint edge).
INDUSTRIAL_RADIUS_KM = 0.3
URBAN_RADIUS_KM = 2.0
# "Quarry/Landfill" never actually existed anywhere in fetch_infrastructure.py
# — this checked for a type string nothing ever produced. Fixed to just the
# one industrial category that's real.
INDUSTRIAL_TYPES = ("Industrial Zone",)

# Grid cell size for the spatial index below. 0.05° is ~5.5km at the
# equator; searching the 3x3 neighborhood around a point's own cell (below)
# comfortably covers both the 0.3km and 2km thresholds even for a point
# sitting right at a cell edge, without falling back to an O(hotspots x
# infrastructure) brute-force comparison — the difference between this
# running in seconds vs. the many minutes it took client-side over 200k+
# hotspots against thousands of infrastructure points.
GRID_CELL_DEG = 0.05


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (math.sin(d_lat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(a))


def _grid_key(lat, lon, cell_deg=GRID_CELL_DEG):
    return (math.floor(lat / cell_deg), math.floor(lon / cell_deg))


def load_infrastructure_index():
    """Builds a coarse lat/lon grid of industrial and urban-area points for
    fast proximity lookups, used to flag hotspots that are probably not
    wildfires (factory heat signatures, city thermal anomalies).

    Tries Doris's remote infrastructure server first (see remote_server/,
    INFRA_LANDCOVER_URL secret) — that's the live, continuously-crawled
    data source now that infrastructure moved off GitHub. Falls back to
    whatever's checked into INFRASTRUCTURE_PATH (a static snapshot, no
    longer updated by any workflow, but better than nothing) if the remote
    server is unreachable or the secret isn't configured — and falls back
    to empty indexes (everything classifies as likely-vegetation) if
    neither source is available, same as before. This workflow must never
    hard-fail just because one laptop happens to be off.
    """
    industrial_grid = defaultdict(list)
    urban_grid = defaultdict(list)
    features = None

    if LANDCOVER_INDEX_URL:
        try:
            r = requests.get(f"{LANDCOVER_INDEX_URL}/landcover-index", timeout=15)
            r.raise_for_status()
            features = r.json().get("features", [])
            print(f"  Loaded {len(features)} industrial/urban points from remote server.")
        except Exception as e:
            print(f"  WARNING: remote landcover index unreachable ({e}) — falling back to local snapshot.")

    if features is None:
        try:
            with open(INFRASTRUCTURE_PATH) as f:
                features = json.load(f).get("features", [])
        except Exception as e:
            print(f"  WARNING: couldn't load {INFRASTRUCTURE_PATH} either: {e}")
            print("  Proceeding without it — every hotspot will classify as likely-vegetation.")
            return industrial_grid, urban_grid

    for feat in features:
        props = feat.get("properties", {}) or {}
        geom = feat.get("geometry", {}) or {}
        if geom.get("type") != "Point":
            continue
        coords = geom.get("coordinates")
        if not coords or len(coords) < 2:
            continue
        lon, lat = coords[0], coords[1]
        ftype = props.get("type")
        key = _grid_key(lat, lon)
        if ftype in INDUSTRIAL_TYPES:
            industrial_grid[key].append((lat, lon))
        elif ftype == "Urban Area":
            urban_grid[key].append((lat, lon))
    return industrial_grid, urban_grid


def _near_any_in_grid(lat, lon, grid, max_km):
    if not grid:
        return False
    base_lat, base_lon = _grid_key(lat, lon)
    for d_lat in (-1, 0, 1):
        for d_lon in (-1, 0, 1):
            for (plat, plon) in grid.get((base_lat + d_lat, base_lon + d_lon), ()):
                if haversine_km(lat, lon, plat, plon) <= max_km:
                    return True
    return False


def classify_vegetation_likelihood(features):
    """Adds a `likely_vegetation` boolean to every feature's properties —
    False when the detection sits within INDUSTRIAL_RADIUS_KM of a mapped
    industrial/quarry site or within URBAN_RADIUS_KM of an OSM urban-area
    node, True otherwise. This is the same heuristic the frontend used to
    compute live in the browser (isNearIndustrialSite/isNearUrbanArea);
    moving it here means the browser only ever reads a precomputed
    property — no per-view/per-toggle distance math on the client at all.
    NASA's own `type` field (fire_type/fire_type_label, when present) is
    left untouched and still takes priority downstream — this only fills
    in a signal for the far more common case where NASA doesn't provide one.
    """
    industrial_grid, urban_grid = load_infrastructure_index()
    if not industrial_grid and not urban_grid:
        for f in features:
            f["properties"]["likely_vegetation"] = True
            f["properties"]["non_vegetation_reason"] = None
        return features

    flagged = 0
    for f in features:
        lon, lat = f["geometry"]["coordinates"]
        near_industrial = _near_any_in_grid(lat, lon, industrial_grid, INDUSTRIAL_RADIUS_KM)
        near_urban = False if near_industrial else _near_any_in_grid(lat, lon, urban_grid, URBAN_RADIUS_KM)
        likely_vegetation = not (near_industrial or near_urban)
        f["properties"]["likely_vegetation"] = likely_vegetation
        f["properties"]["non_vegetation_reason"] = (
            "static_land_source" if near_industrial else "urban_area" if near_urban else None
        )
        if not likely_vegetation:
            flagged += 1
    print(f"  Vegetation classification: {flagged}/{len(features)} flagged as likely non-wildfire (industrial/urban proximity)")
    return features


def build_geojson(all_features):
    """Wrap features in a GeoJSON FeatureCollection with metadata."""
    return {
        "type": "FeatureCollection",
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "NASA FIRMS (VIIRS NOAA-20/NOAA-21 + MODIS NRT)",
            "api_url": "https://firms.modaps.eosdis.nasa.gov/api/",
            "coverage": "Global",
            "lookback_days": DAYS,
            "total_hotspots": len(all_features),
            "description": (
                "Active fire hotspots detected by NASA satellite sensors. "
                "FRP = Fire Radiative Power in megawatts (MW). "
                "Higher FRP = more intense fire. "
                "Data latency: < 3 hours globally."
            ),
            "intensity_scale": {
                "low": "FRP < 10 MW",
                "moderate": "FRP 10–50 MW",
                "high": "FRP 50–200 MW",
                "extreme": "FRP > 200 MW"
            }
        },
        "features": all_features
    }


def main():
    if not FIRMS_API_KEY:
        print("ERROR: FIRMS_MAP_KEY environment variable not set.")
        print("Get a free key at: https://firms.modaps.eosdis.nasa.gov/api/")
        # For testing without a key, write an empty valid GeoJSON
        empty = build_geojson([])
        empty["metadata"]["error"] = "No API key provided"
        with open(OUTPUT_PATH, "w") as f:
            json.dump(empty, f, indent=2)
        update_manifest("hotspots", OUTPUT_PATH)
        return

    all_features = []

    for region_name, bbox in REGIONS:
        print(f"\n--- {region_name} ---")
        for source in SOURCES:
            rows = fetch_firms_csv(source["name"], bbox)
            for row in rows:
                feature = row_to_feature(row, source["label"], source["resolution_m"])
                if feature:
                    all_features.append(feature)

    print(f"\nTotal hotspots collected (incl. regional overlap): {len(all_features)}")

    # Regions overlap slightly at their edges on purpose (Asia/Oceania,
    # North America/Asia near the antimeridian) so no fire falls in a gap
    # between them -- but that means the same detection can come back from
    # two regional queries. Drop exact repeats (same source + coordinates
    # + acquisition time) before the VIIRS/MODIS dedup pass below.
    seen_exact = set()
    region_deduped = []
    for f in all_features:
        p = f["properties"]
        key = (p["source"], f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1], p["acq_datetime"])
        if key in seen_exact:
            continue
        seen_exact.add(key)
        region_deduped.append(f)
    all_features = region_deduped
    print(f"After removing regional-overlap repeats: {len(all_features)}")

    # Remove duplicates: VIIRS and MODIS may detect the same fire
    # Simple deduplication: keep VIIRS when coordinates are within ~0.01 degrees
    # (VIIRS is higher resolution, so we prefer it)
    print("Deduplicating overlapping detections...")
    viirs_coords = set()
    for f in all_features:
        if "VIIRS" in f["properties"]["source"]:
            lon, lat = f["geometry"]["coordinates"]
            viirs_coords.add((round(lon, 2), round(lat, 2)))

    deduped = []
    for f in all_features:
        if "MODIS" in f["properties"]["source"]:
            lon, lat = f["geometry"]["coordinates"]
            if (round(lon, 2), round(lat, 2)) in viirs_coords:
                continue  # Skip MODIS if VIIRS already covers this location
        deduped.append(f)

    print(f"After deduplication: {len(deduped)} hotspots")

    if len(deduped) == 0:
        print("\n" + "=" * 70)
        print("ERROR: 0 hotspots across ALL 6 regions and 4 sources. This is almost")
        print("never correct — there are essentially always active fires detected")
        print("somewhere on Earth. Possible causes: FIRMS_MAP_KEY invalid/expired or")
        print("over quota (check https://firms.modaps.eosdis.nasa.gov/usage/), or a")
        print("NASA-side outage affecting the area/csv endpoint entirely.")
        print("Refusing to overwrite the existing data/hotspots.geojson with an empty")
        print("result — leaving last-known-good data in place instead.")
        print("=" * 70)
        if os.path.exists(OUTPUT_PATH):
            raise SystemExit(1)  # fail the workflow loudly; keep old file untouched
        # No pre-existing file (first-ever run) — write an empty-but-valid file
        # so the frontend doesn't crash, clearly flagged as a warning.
        empty = build_geojson([])
        empty["metadata"]["warning"] = "0 hotspots returned — check FIRMS_MAP_KEY validity/quota"
        os.makedirs("data", exist_ok=True)
        with open(OUTPUT_PATH, "w") as f:
            json.dump(empty, f, indent=2)
        update_manifest("hotspots", OUTPUT_PATH)
        raise SystemExit(1)

    if len(deduped) < MIN_EXPECTED_HOTSPOTS:
        # Not zero, so the hard guard above doesn't fire — but a genuinely
        # global day (all 6 continents, 24h window, 3 satellite pairs) has
        # never come in this low in practice. The one confirmed cause so
        # far: NASA's NRT pipeline hasn't finished publishing every
        # region's latest pass yet at the moment this ran, so most regions
        # come back empty while whichever region got processed first (often
        # Asia, since that's furthest along UTC-wise) looks "normal" on its
        # own — the same data shows up completely if you re-query a few
        # hours later. This is loud specifically so that pattern is
        # recognizable at a glance in the workflow log instead of someone
        # having to notice "huh, that count looks low" days later. Still
        # writes the file — an unusually quiet day is possible in principle,
        # and this isn't confident enough to justify discarding real data.
        print("\n" + "=" * 70)
        print(f"WARNING: only {len(deduped)} hotspots found (expected at least "
              f"{MIN_EXPECTED_HOTSPOTS} on a normal day). Writing this data anyway, "
              f"but it's worth a manual look — this has previously meant NASA's NRT "
              f"pipeline was still catching up on some regions when this ran, not a "
              f"real drop in fire activity. Re-running this workflow in a few hours "
              f"should self-correct if that's what's happening.")
        print("=" * 70)

    deduped = classify_vegetation_likelihood(deduped)

    geojson = build_geojson(deduped)
    geojson = stabilize_generated_at(geojson, OUTPUT_PATH)

    os.makedirs("data", exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(geojson, f, indent=2)

    update_manifest("hotspots", OUTPUT_PATH)

    print(f"Saved to {OUTPUT_PATH}")

    # Print summary by intensity
    intensities = {}
    for feat in deduped:
        level = feat["properties"]["intensity"]
        intensities[level] = intensities.get(level, 0) + 1
    print("\nIntensity summary:")
    for level, count in sorted(intensities.items()):
        print(f"  {level}: {count}")


if __name__ == "__main__":
    main()