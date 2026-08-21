"""
fetch_zone_now.py
==================
Fetches infrastructure for a specific bbox RIGHT NOW, out-of-band from
crawler.py's sequential world-tile progression -- useful for prioritizing
a zone you actively want to test/demo instead of waiting for the crawl to
reach it on its own schedule.

Doesn't touch the crawler's progress cursor (crawl_state in store.py) at
all -- crawler.py keeps advancing exactly as if this never ran. Results
are tagged with the STANDARD world-tile bbox they fall in (same
WORLD_TILES grid from fetch_infrastructure.py, not the ad-hoc bbox you
pass in), so a future lap that reaches that same tile refreshes it
normally instead of leaving an orphaned, differently-keyed row behind.

Usage:
    python fetch_zone_now.py                          # defaults to Jalisco, Mexico
    python fetch_zone_now.py --bbox -105.7,18.9,-101.5,22.75
    python fetch_zone_now.py --name "Jalisco"          # just a label for the log output
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from fetch_infrastructure import (  # noqa: E402
    fetch_overpass, CORE_WORLD_TYPES, ZONE_ONLY_TYPES, INDUSTRIAL_TYPES, WORLD_TILES,
)

import store  # noqa: E402

ALL_TYPES = CORE_WORLD_TYPES + ZONE_ONLY_TYPES

# Jalisco, Mexico -- covers Guadalajara, Tlaquepaque, Zapopan and the rest
# of the state. (west, south, east, north)
DEFAULT_BBOX = (-105.7, 18.9, -101.5, 22.75)


def overlapping_tiles(bbox):
    w, s, e, n = bbox
    return [t for t in WORLD_TILES if not (t[2] <= w or t[0] >= e or t[3] <= s or t[1] >= n)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bbox", type=str, default=None, help="west,south,east,north")
    parser.add_argument("--name", type=str, default="Jalisco", help="label for log output only")
    args = parser.parse_args()

    if args.bbox:
        bbox = tuple(float(v) for v in args.bbox.split(","))
    else:
        bbox = DEFAULT_BBOX

    tiles = overlapping_tiles(bbox)
    if not tiles:
        print(f"No world tiles overlap bbox {bbox} -- check the coordinates.")
        return

    print(f"Fetching {args.name} now ({bbox}) -- {len(tiles)} world tile(s): {tiles}")
    conn = store.init_db()

    for i, tile in enumerate(tiles, 1):
        west, south, east, north = tile
        bbox_str = f"{west},{south},{east},{north}"
        print(f"\n[{i}/{len(tiles)}] Fetching tile {bbox_str}...")
        features = fetch_overpass(bbox_str, ALL_TYPES, f"infrastructure {bbox_str}")
        if features is None:
            print(f"  FAILED on every mirror -- leaving whatever was already stored for this tile untouched.")
            continue
        industrial = fetch_overpass(bbox_str, INDUSTRIAL_TYPES, f"industrial {bbox_str}")
        if industrial:
            features = features + industrial
        count = store.upsert_tile_features(conn, bbox_str, features)
        print(f"  Stored {count} features for tile {bbox_str}.")

    stats = store.get_stats(conn)
    print(f"\nDone. Store now has {stats['total_features']} features across {stats['tiles_covered']} tiles total.")


if __name__ == "__main__":
    main()
