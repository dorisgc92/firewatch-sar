"""
fetch_zone_now.py
==================
Fetches infrastructure for a specific bbox RIGHT NOW, out-of-band from
crawler.py's sequential world-tile progression -- useful for prioritizing
a zone you actively want to test/demo instead of waiting for the crawl to
reach it on its own schedule.

Doesn't touch the crawler's progress cursor (crawl_state in store.py) at
all -- crawler.py keeps advancing exactly as if this never ran.

Two modes:
  1. Default (no --exact): snaps your bbox to the standard world-tile
     grid (same WORLD_TILES from fetch_infrastructure.py) and fetches
     the WHOLE enclosing tile(s), tagged with the tile's own bbox as the
     storage key -- so a future crawler lap over that same tile refreshes
     it cleanly instead of leaving a differently-keyed orphan row behind.
     Best for genuinely priming a region ahead of the crawler.
  2. --exact: fetches precisely the bbox you gave, no snapping/expanding.
     Useful when the enclosing world-tile is too large/heavy for public
     Overpass instances to answer in time (dense metro areas can time
     out a 10x10 degree query) -- a tight bbox around just the city is a
     much lighter, more likely-to-succeed request. Stored tagged with
     that exact bbox as its own key; the crawler's eventual full-tile
     fetch will store separately under the tile's own key rather than
     overwriting this, so both can coexist (a little redundant, but
     harmless -- query results merge by osm_id at read time regardless).

Usage:
    python fetch_zone_now.py                          # defaults to Jalisco, Mexico (full tiles)
    python fetch_zone_now.py --bbox -105.7,18.9,-101.5,22.75
    python fetch_zone_now.py --bbox -103.6,20.5,-103.2,20.8 --exact --name "Guadalajara metro"
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


def fetch_and_store(conn, bbox_str, label):
    print(f"\nFetching {label} ({bbox_str})...")
    features = fetch_overpass(bbox_str, ALL_TYPES, f"infrastructure {bbox_str}")
    if features is None:
        print(f"  FAILED on every mirror -- leaving whatever was already stored for this key untouched.")
        return
    industrial = fetch_overpass(bbox_str, INDUSTRIAL_TYPES, f"industrial {bbox_str}")
    if industrial:
        features = features + industrial
    count = store.upsert_tile_features(conn, bbox_str, features)
    print(f"  Stored {count} features for {bbox_str}.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bbox", type=str, default=None, help="west,south,east,north")
    parser.add_argument("--name", type=str, default="Jalisco", help="label for log output only")
    parser.add_argument("--exact", action="store_true",
                         help="fetch precisely --bbox instead of snapping to the enclosing world tile(s)")
    args = parser.parse_args()

    if args.bbox:
        bbox = tuple(float(v) for v in args.bbox.split(","))
    else:
        bbox = DEFAULT_BBOX

    conn = store.init_db()

    if args.exact:
        w, s, e, n = bbox
        bbox_str = f"{w},{s},{e},{n}"
        print(f"Fetching {args.name} now -- EXACT bbox {bbox_str} (no snapping to world tile grid).")
        fetch_and_store(conn, bbox_str, args.name)
    else:
        tiles = overlapping_tiles(bbox)
        if not tiles:
            print(f"No world tiles overlap bbox {bbox} -- check the coordinates.")
            return
        print(f"Fetching {args.name} now ({bbox}) -- {len(tiles)} world tile(s): {tiles}")
        for i, tile in enumerate(tiles, 1):
            west, south, east, north = tile
            bbox_str = f"{west},{south},{east},{north}"
            print(f"[{i}/{len(tiles)}]", end=" ")
            fetch_and_store(conn, bbox_str, f"tile {bbox_str}")

    stats = store.get_stats(conn)
    print(f"\nDone. Store now has {stats['total_features']} features across {stats['tiles_covered']} tiles total.")


if __name__ == "__main__":
    main()
