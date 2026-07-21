"""
fetch_infrastructure.py
=======================
Fetches critical infrastructure from OpenStreetMap via Overpass API.
Focuses on facilities relevant to wildfire emergency response.

Outputs: data/infrastructure.geojson

OpenStreetMap data: Â© OpenStreetMap contributors, ODbL license
Overpass API: https://overpass-api.de/

How to run:
    python scripts/fetch_infrastructure.py [--bbox "west,south,east,north"]

Example for Mexico:
    python scripts/fetch_infrastructure.py --bbox "-118,14,-86,33"
"""

import json
import sys
import argparse
import requests
from datetime import datetime, timezone
from manifest import update_manifest, stabilize_generated_at

OUTPUT_PATH = "data/infrastructure.geojson"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Default bbox â€” covers Mexico + US border region
DEFAULT_BBOX = "-118,14,-86,33"

# Infrastructure categories to fetch
# Each entry: (OSM tag key, OSM tag value, display label, color, icon)
INFRASTRUCTURE_TYPES = [
    ("amenity",  "hospital",          "Hospital",           "#FF4444", "ðŸ¥"),
    ("amenity",  "clinic",            "Clinic",             "#FF8888", "ðŸ¥"),
    ("amenity",  "fire_station",      "Fire Station",       "#FF6600", "ðŸš’"),
    ("amenity",  "police",            "Police Station",     "#0044FF", "ðŸ‘®"),
    ("amenity",  "school",            "School (shelter)",   "#AA44FF", "ðŸ«"),
    ("power",    "substation",        "Power Substation",   "#FFAA00", "âš¡"),
    ("power",    "plant",             "Power Plant",        "#FF8800", "âš¡"),
    ("man_made", "tower",             "Tower",              "#666666", "ðŸ“¡"),
    ("aeroway",  "aerodrome",         "Airport/Airfield",   "#44AAFF", "âœˆï¸"),
    ("amenity",  "fuel",              "Fuel Station",       "#FFDD00", "â›½"),
    ("landuse",  "reservoir",         "Water Reservoir",    "#0088FF", "ðŸ’§"),
    ("natural",  "water",             "Water Body",         "#4488FF", "ðŸ’§"),
]

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
# this run, never the rest of the infrastructure dataset.
INDUSTRIAL_TYPES = [
    ("landuse",  "industrial",        "Industrial Zone",    "#996633", "factory"),
    ("man_made", "works",             "Industrial Zone",    "#996633", "factory"),
]


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


def fetch_overpass(bbox, types, label):
    """
    Runs one Overpass query for a given set of tag types. Returns the parsed
    feature list, or None if the request failed outright (network error,
    HTTP error) or the response looked like a silent timeout. None signals
    "don't trust this, don't overwrite good data with it" to the caller.
    """
    query = build_overpass_query(bbox, types)
    try:
        r = requests.post(
            OVERPASS_URL,
            data={"data": query},
            timeout=90,
            headers={"User-Agent": "FireWatchSAR/1.0 (IEEE Response Quest 2026; contact: dorisgc92@github.com)"}
        )
        r.raise_for_status()
        resp_data = r.json()
    except Exception as e:
        print(f"  ERROR fetching {label} from Overpass API: {e}")
        return None

    features = parse_overpass_response(resp_data, types)
    print(f"  Got {len(features)} {label} elements")
    return features


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
        label, color, icon = classify_element(tags, types)

        name = (tags.get("name") or tags.get("name:en") or
                tags.get("name:es") or label)

        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [lon, lat]
            },
            "properties": {
                "name": name,
                "type": label,
                "color": color,
                "icon": icon,
                "osm_id": el.get("id"),
                "osm_type": el["type"],
                "address": tags.get("addr:street", ""),
                "phone": tags.get("phone", tags.get("contact:phone", "")),
                "operator": tags.get("operator", ""),
                "capacity": tags.get("capacity", ""),
                "emergency": tags.get("emergency", ""),
                "source": "OpenStreetMap",
                "osm_url": f"https://www.openstreetmap.org/{el['type']}/{el.get('id')}",
            }
        })

    return features


def main():
    parser = argparse.ArgumentParser(description="Fetch infrastructure from OpenStreetMap")
    parser.add_argument(
        "--bbox",
        default=DEFAULT_BBOX,
        help="Bounding box: west,south,east,north (default: Mexico region)"
    )
    args = parser.parse_args()

    import os
    os.makedirs("data", exist_ok=True)

    # How many features a previous successful run already had committed —
    # used below to tell "genuinely nothing out there" apart from "Overpass
    # silently failed", so a bad run can never wipe out good data.
    previous_total = 0
    if os.path.exists(OUTPUT_PATH):
        try:
            with open(OUTPUT_PATH, "r") as f:
                previous_total = json.load(f).get("metadata", {}).get("total", 0) or 0
        except (json.JSONDecodeError, FileNotFoundError):
            previous_total = 0

    print(f"Fetching infrastructure for bbox: {args.bbox}")
    features = fetch_overpass(args.bbox, INFRASTRUCTURE_TYPES, "core infrastructure")

    if features is None:
        print("Core infrastructure fetch failed outright -- keeping last committed data, not overwriting.")
        sys.exit(1)

    if len(features) == 0 and previous_total > 0:
        # A request that returns 200 OK with zero elements almost always
        # means the shared public Overpass server timed out or truncated
        # the response rather than "there is truly nothing here" -- this
        # bbox has thousands of hospitals/schools/etc. in real life. Refuse
        # to let a bad run silently erase a previously-good dataset.
        print(f"WARNING: got 0 features but the last commit had {previous_total} -- "
              f"this looks like a silent Overpass failure, not a real result. Keeping last committed data.")
        sys.exit(1)

    # Industrial zones are fetched as a separate, best-effort query -- if
    # THIS one times out (it's a much heavier tag over the same bbox), we
    # still keep everything else. Missing industrial data for one run just
    # means the wildfire/false-positive flagging is slightly less complete
    # until the next successful fetch, never a data-loss event.
    industrial_features = fetch_overpass(args.bbox, INDUSTRIAL_TYPES, "industrial zone")
    if industrial_features is None:
        print("Industrial zone fetch failed -- continuing without it for this run.")
        industrial_features = []

    all_features = features + industrial_features
    print(f"Got {len(all_features)} infrastructure elements total")

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
            "license": "ODbL â€” Â© OpenStreetMap contributors",
            "bbox": args.bbox,
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

    with open(OUTPUT_PATH, "w") as f:
        json.dump(geojson, f, indent=2)
    update_manifest("infrastructure", OUTPUT_PATH)

    print(f"Saved {OUTPUT_PATH}")
    for t, count in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"  {t}: {count}")


if __name__ == "__main__":
    main()