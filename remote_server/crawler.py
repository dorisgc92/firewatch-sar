"""
crawler.py
==========
Long-running replacement for the GitHub Actions "one tile every 20
minutes" world crawl. Runs continuously on Doris's own machine, fetching
several tiles IN PARALLEL (default 5 at once) instead of one per
scheduled run -- a full lap over all ~650 tiles that used to take about a
week now takes on the order of hours, while still being a reasonable,
polite load on the shared public Overpass API (a handful of concurrent
requests with a short pause between batches, not hundreds at once).

Reuses the actual fetch/parse/classify logic from
scripts/fetch_infrastructure.py rather than re-implementing it, so the
two never drift apart on what counts as "infrastructure" or how an OSM
element gets turned into a GeoJSON feature.

Unlike the GitHub-committed version, this fetches BOTH CORE_WORLD_TYPES
and ZONE_ONLY_TYPES for the whole planet -- the split between those two
existed only because of GitHub's 100MB file-size limit, which doesn't
apply to a SQLite file on a dedicated machine. That means schools
(ONG/logistics candidates), clinics, and everything else that used to
only get fetched on-demand for whatever zone a responder happened to be
looking at now gets full, consistent world coverage too.

Run with:
    python crawler.py
Environment variables (all optional):
    CRAWLER_WORKERS          concurrent tile fetches per batch (default 5)
    CRAWLER_BATCH_PAUSE      seconds to wait between batches (default 2)
    CRAWLER_LAP_PAUSE_HOURS  hours to wait after a full lap before
                             starting the next one (default 6; set to 0
                             to refresh continuously with no pause)
"""

import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from fetch_infrastructure import (  # noqa: E402
    fetch_overpass, CORE_WORLD_TYPES, ZONE_ONLY_TYPES, INDUSTRIAL_TYPES, WORLD_TILES,
)

import store  # noqa: E402

ALL_TYPES = CORE_WORLD_TYPES + ZONE_ONLY_TYPES
MAX_WORKERS = int(os.environ.get("CRAWLER_WORKERS", "5"))
PAUSE_BETWEEN_BATCHES_SEC = float(os.environ.get("CRAWLER_BATCH_PAUSE", "2"))
PAUSE_BETWEEN_LAPS_HOURS = float(os.environ.get("CRAWLER_LAP_PAUSE_HOURS", "6"))


def fetch_one_tile(tile):
    west, south, east, north = tile
    bbox_str = f"{west},{south},{east},{north}"
    features = fetch_overpass(bbox_str, ALL_TYPES, f"infrastructure {bbox_str}")
    if features is None:
        return bbox_str, None
    industrial = fetch_overpass(bbox_str, INDUSTRIAL_TYPES, f"industrial {bbox_str}")
    if industrial:
        features = features + industrial
    return bbox_str, features


def run_forever():
    conn = store.init_db()
    state = store.get_crawl_state(conn)
    print(f"Crawler starting -- resuming at tile {state['next_index']}/{len(WORLD_TILES)} "
          f"(lap {state['laps_completed']} completed so far), {MAX_WORKERS} tiles in parallel.")

    while True:
        start_index = state["next_index"]
        batch = [(  (start_index + offset) % len(WORLD_TILES), WORLD_TILES[(start_index + offset) % len(WORLD_TILES)]  )
                 for offset in range(MAX_WORKERS)]

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {pool.submit(fetch_one_tile, tile): idx for idx, tile in batch}
            for future in as_completed(futures):
                idx = futures[future]
                try:
                    bbox_str, features = future.result()
                except Exception as e:
                    print(f"  tile {idx}: raised {e!r} -- skipping this pass, will retry next lap")
                    continue
                if features is None:
                    print(f"  tile {idx} ({bbox_str}): fetch failed on every mirror -- keeping existing data for this tile")
                    continue
                count = store.upsert_tile_features(conn, bbox_str, features)
                print(f"  tile {idx} ({bbox_str}): {count} features stored")

        next_index = (start_index + MAX_WORKERS) % len(WORLD_TILES)
        wrapped = next_index <= start_index
        state["next_index"] = next_index
        state["last_tile_bbox"] = batch[-1][1]

        if wrapped:
            state["laps_completed"] += 1
            store.save_crawl_state(conn, state)
            stats = store.get_stats(conn)
            print(f"Lap {state['laps_completed']} complete -- {stats['total_features']} features "
                  f"across {stats['tiles_covered']} tiles.")
            if PAUSE_BETWEEN_LAPS_HOURS > 0:
                print(f"Pausing {PAUSE_BETWEEN_LAPS_HOURS}h before the next lap "
                      f"(set CRAWLER_LAP_PAUSE_HOURS=0 to refresh continuously with no pause).")
                time.sleep(PAUSE_BETWEEN_LAPS_HOURS * 3600)
        else:
            store.save_crawl_state(conn, state)
            time.sleep(PAUSE_BETWEEN_BATCHES_SEC)


if __name__ == "__main__":
    run_forever()
