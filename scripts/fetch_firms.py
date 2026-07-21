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
import requests
import csv
import io
from datetime import datetime, timezone
from manifest import update_manifest, stabilize_generated_at

# ── Configuration ──────────────────────────────────────────────────────────────

FIRMS_API_KEY = os.environ.get("FIRMS_MAP_KEY", "")

# Global bounding box — covers the entire world
# Format: west,south,east,north
WORLD_BBOX = "-180,-90,180,90"

# Days to look back (1 = last 24 hours, max 10)
DAYS = 1

# Data sources: VIIRS is higher resolution (375m) and now comes from three
# satellites (Suomi NPP + NOAA-20 + NOAA-21); MODIS is older (1km, Aqua+Terra
# combined by NASA's API under one endpoint). We fetch all of them and merge.
SOURCES = [
    {
        "name": "VIIRS_SNPP_NRT",
        "label": "VIIRS (Suomi NPP)",
        "resolution_m": 375,
    },
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


def fetch_firms_csv(source_name):
    """
    Fetch FIRMS data as CSV for a given source.
    Returns list of dicts, one per hotspot.
    """
    url = (
        f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
        f"{FIRMS_API_KEY}/{source_name}/{WORLD_BBOX}/{DAYS}"
    )

    print(f"  Fetching {source_name} from NASA FIRMS...")

    try:
        response = requests.get(url, timeout=60)
        response.raise_for_status()
    except requests.exceptions.RequestException as e:
        print(f"  ERROR fetching {source_name}: {e}")
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

    # Build acquisition datetime string
    acq_datetime = f"{acq_date} {acq_time[:2]}:{acq_time[2:]}Z" if acq_time else acq_date

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
        }
    }


def build_geojson(all_features):
    """Wrap features in a GeoJSON FeatureCollection with metadata."""
    return {
        "type": "FeatureCollection",
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "NASA FIRMS (VIIRS SNPP/NOAA-20/NOAA-21 + MODIS NRT)",
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

    for source in SOURCES:
        rows = fetch_firms_csv(source["name"])
        for row in rows:
            feature = row_to_feature(row, source["label"], source["resolution_m"])
            if feature:
                all_features.append(feature)

    print(f"\nTotal hotspots collected: {len(all_features)}")

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
        print("ERROR: 0 hotspots for a GLOBAL query. This is almost never correct —")
        print("there are essentially always active fires detected somewhere on Earth.")
        print("Most likely cause: FIRMS_MAP_KEY is invalid/expired, or its usage quota")
        print("was exceeded. Check: https://firms.modaps.eosdis.nasa.gov/usage/")
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
