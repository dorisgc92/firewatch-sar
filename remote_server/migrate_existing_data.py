"""
migrate_existing_data.py
=========================
One-time import of whatever's currently in data/infrastructure.geojson
(the GitHub-committed dataset built up over the last few weeks of the
world crawl) into the new SQLite store, so the crawler on this machine
picks up from what's already been fetched instead of starting over.

Every feature the old crawl produced already carries a `_tile` property
(set by the old merge_features() in fetch_infrastructure.py) identifying
which 10x10 degree tile it came from -- this script groups by that
property and calls the exact same upsert_tile_features() the live
crawler uses, so migrated data is indistinguishable from freshly-crawled
data afterward. For any feature missing `_tile` (shouldn't happen for
real crawl output, but just in case of hand-edited or older data), it's
computed from the feature's own coordinates instead.

Usage:
    python migrate_existing_data.py path/to/infrastructure.geojson
    python migrate_existing_data.py                 # defaults to ../data/infrastructure.geojson
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from fetch_infrastructure import WORLD_TILES  # noqa: E402

import store  # noqa: E402

DEFAULT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "infrastructure.geojson")


def tile_for(lat, lon):
    for west, south, east, north in WORLD_TILES:
        if west <= lon < east and south <= lat < north:
            return f"{west},{south},{east},{north}"
    return "unknown"


def main(path):
    if not os.path.exists(path):
        print(f"No file found at {path} -- nothing to migrate. "
              f"The crawler will just start fresh, which is fine, only slower to reach full coverage.")
        return

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    features = data.get("features", [])
    print(f"Loaded {len(features)} features from {path}.")

    by_tile = {}
    for f in features:
        props = f.get("properties", {})
        tile = props.get("_tile")
        if not tile:
            lon, lat = f["geometry"]["coordinates"]
            tile = tile_for(lat, lon)
        by_tile.setdefault(tile, []).append(f)

    conn = store.init_db()
    for tile, feats in by_tile.items():
        store.upsert_tile_features(conn, tile, feats)

    stats = store.get_stats(conn)
    print(f"Migration complete: {stats['total_features']} features now in the store, "
          f"covering {stats['tiles_covered']} tiles.")
    print("The crawler will still re-fetch every tile over time to pick up ZONE_ONLY_TYPES "
          "(schools, clinics, etc.) which the old GitHub-committed crawl never included.")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PATH)
