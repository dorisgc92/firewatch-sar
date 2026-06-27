"""
fetch_infrastructure.py
=======================
Fetches critical infrastructure from OpenStreetMap via Overpass API.
Focuses on facilities relevant to wildfire emergency response.

Outputs: data/infrastructure.geojson

OpenStreetMap data: © OpenStreetMap contributors, ODbL license
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

OUTPUT_PATH = "data/infrastructure.geojson"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Default bbox — covers Mexico + US border region
DEFAULT_BBOX = "-118,14,-86,33"

# Infrastructure categories to fetch
# Each entry: (OSM tag key, OSM tag value, display label, color, icon)
INFRASTRUCTURE_TYPES = [
    ("amenity",  "hospital",          "Hospital",           "#FF4444", "🏥"),
    ("amenity",  "clinic",            "Clinic",             "#FF8888", "🏥"),
    ("amenity",  "fire_station",      "Fire Station",       "#FF6600", "🚒"),
    ("amenity",  "police",            "Police Station",     "#0044FF", "👮"),
    ("amenity",  "school",            "School (shelter)",   "#AA44FF", "🏫"),
    ("power",    "substation",        "Power Substation",   "#FFAA00", "⚡"),
    ("power",    "plant",             "Power Plant",        "#FF8800", "⚡"),
    ("man_made", "tower",             "Tower",              "#666666", "📡"),
    ("aeroway",  "aerodrome",         "Airport/Airfield",   "#44AAFF", "✈️"),
    ("amenity",  "fuel",              "Fuel Station",       "#FFDD00", "⛽"),
    ("landuse",  "reservoir",         "Water Reservoir",    "#0088FF", "💧"),
    ("natural",  "water",             "Water Body",         "#4488FF", "💧"),
]


def build_overpass_query(bbox):
    """Build Overpass QL query for all infrastructure types within bbox."""
    west, south, east, north = bbox.split(",")
    bbox_str = f"{south},{west},{north},{east}"  # Overpass uses S,W,N,E

    tag_queries = []
    for key, value, *_ in INFRASTRUCTURE_TYPES:
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


def classify_element(tags):
    """Determine infrastructure type and display properties from OSM tags."""
    for key, value, label, color, icon in INFRASTRUCTURE_TYPES:
        if tags.get(key) == value:
            return label, color, icon
    return "Other", "#888888", "📍"


def parse_overpass_response(data):
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
        label, color, icon = classify_element(tags)

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

    print(f"Fetching infrastructure for bbox: {args.bbox}")
    query = build_overpass_query(args.bbox)

    try:
        r = requests.post(
            OVERPASS_URL,
            data={"data": query},
            timeout=90
        )
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        print(f"ERROR fetching from Overpass API: {e}")
        # Write empty GeoJSON so the frontend doesn't break
        empty = {
            "type": "FeatureCollection",
            "metadata": {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "error": str(e),
                "total": 0
            },
            "features": []
        }
        with open(OUTPUT_PATH, "w") as f:
            json.dump(empty, f, indent=2)
        return

    features = parse_overpass_response(data)
    print(f"Got {len(features)} infrastructure elements")

    # Count by type
    type_counts = {}
    for feat in features:
        t = feat["properties"]["type"]
        type_counts[t] = type_counts.get(t, 0) + 1

    geojson = {
        "type": "FeatureCollection",
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "OpenStreetMap via Overpass API",
            "license": "ODbL — © OpenStreetMap contributors",
            "bbox": args.bbox,
            "description": (
                "Critical infrastructure relevant to wildfire emergency response. "
                "Includes hospitals, fire stations, police, power infrastructure, "
                "and water resources. Used for vulnerability assessment."
            ),
            "total": len(features),
            "by_type": type_counts,
        },
        "features": features
    }

    with open(OUTPUT_PATH, "w") as f:
        json.dump(geojson, f, indent=2)

    print(f"Saved {OUTPUT_PATH}")
    for t, count in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"  {t}: {count}")


if __name__ == "__main__":
    main()
