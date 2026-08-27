"""
download_firms_sample.py
=========================
Downloads a real sample of NASA FIRMS detections to use for testing and
validating the forest-vs-urban classifiers in this folder. Runs on your
own machine (needs network access to firms.modaps.eosdis.nasa.gov, which
this sandbox doesn't have).

Uses MODIS_SP (Standard Processing), not MODIS_NRT. This matters:
confirmed against real data (0/26998 labeled on a first attempt with
MODIS_NRT) and against NASA's own documentation -- the `type` field
(0=vegetation fire, 1=volcano, 2=other static/industrial land source,
3=offshore) is simply never populated in the NRT product for either
MODIS or VIIRS. It only exists in Standard Processing, the fully
reprocessed, quality-controlled product that comes out with a lag of
days to weeks -- which is exactly fine for a validation SAMPLE (we don't
need today's fires to test a classifier), just wrong for the live app
(which correctly stays on NRT for actual near-real-time operation).

SP data is queried against a historical date, not "the last N days from
now" -- FIRMS keeps roughly the past two months of SP data available.
Defaults to 30 days ago, comfortably inside that window.

Ground truth caveat, still worth keeping in mind: `type` is a real,
NASA-provided label, but "type=2 other static/industrial land source" is
NASA's own catch-all bucket for "not a vegetation fire" -- not a
hand-verified ground truth in the way a labeled imagery benchmark would
be. Treat resulting metrics as informative, not definitive.

Usage:
    python download_firms_sample.py YOUR_FIRMS_MAP_KEY
    python download_firms_sample.py YOUR_FIRMS_MAP_KEY --days 5 --date 2026-07-01
"""

import argparse
import csv
import io
import sys
from datetime import datetime, timedelta

import requests

# Deliberately mixed regions -- some with heavy industrial/urban activity
# (to get real type=2 labels), some with well-known wildfire seasons (to
# get real type=0 labels). A sample skewed toward only one or the other
# would make every metric downstream meaningless (a classifier that just
# always guesses "forest" looks perfect on an all-forest sample).
REGIONS = {
    "North America":  "-125,25,-65,50",
    "South America":  "-85,-57,-32,14",     # Amazon basin, heavy fire season coverage
    "Europe":         "-11,35,40,71",       # includes dense industrial belts
    "Middle East/Gulf": "25,12,60,42",      # gas flaring, oil infrastructure -> real type=2 cases
    "South/East Asia": "60,-10,150,55",
}

FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
SOURCE = "MODIS_SP"


def download_region(map_key, region_name, bbox, days, date_str):
    url = f"{FIRMS_BASE}/{map_key}/{SOURCE}/{bbox}/{days}/{date_str}"
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    reader = csv.DictReader(io.StringIO(r.text))
    rows = list(reader)
    print(f"  {region_name}: {len(rows)} raw detections")
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("map_key", help="Your FIRMS_MAP_KEY")
    parser.add_argument("--days", type=int, default=3, help="Window size in days (1-10)")
    parser.add_argument("--date", default=None,
                         help="Historical start date YYYY-MM-DD (default: 30 days ago, inside SP's ~2-month availability window)")
    parser.add_argument("--out", default="firms_sample.csv")
    args = parser.parse_args()

    date_str = args.date or (datetime.utcnow() - timedelta(days=30)).strftime("%Y-%m-%d")
    print(f"Querying MODIS_SP (Standard Processing) starting {date_str}, {args.days}-day window.\n")

    all_rows = []
    for name, bbox in REGIONS.items():
        try:
            rows = download_region(args.map_key, name, bbox, args.days, date_str)
            for row in rows:
                row["_region"] = name
            all_rows.extend(rows)
        except Exception as e:
            print(f"  WARNING: {name} failed: {e}")

    labeled = [r for r in all_rows if r.get("type", "").strip() != ""]
    print(f"\nTotal detections: {len(all_rows)}")
    print(f"With a NASA `type` label (usable ground truth): {len(labeled)}")
    if labeled:
        from collections import Counter
        counts = Counter(r["type"] for r in labeled)
        label_names = {"0": "vegetation_fire", "1": "volcano", "2": "static_land_source", "3": "offshore"}
        for k, v in sorted(counts.items()):
            print(f"  type={k} ({label_names.get(k, 'unknown')}): {v}")
    elif all_rows:
        print("  Still 0 labeled rows with real data present -- check the CSV header "
              "(Get-Content firms_sample.csv -TotalCount 1) to confirm a `type` column exists at all.")

    if not all_rows:
        print("No data downloaded -- check your MAP_KEY and network connection.")
        sys.exit(1)

    fieldnames = sorted({k for row in all_rows for k in row.keys()})
    with open(args.out, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_rows)
    print(f"\nSaved {len(all_rows)} rows to {args.out}")


if __name__ == "__main__":
    main()
