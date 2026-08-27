"""
download_firms_sample.py
=========================
Downloads a real sample of NASA FIRMS detections to use for testing and
validating the forest-vs-urban classifiers in this folder. Runs on your
own machine (needs network access to firms.modaps.eosdis.nasa.gov, which
this sandbox doesn't have).

Ground truth caveat, important to understand before trusting any metric
that comes out of evaluate.py: NASA's own `type` column (0=presumed
vegetation fire, 1=volcano, 2=other static/industrial land source,
3=offshore) is the only independent, NASA-provided label available here.
It is a real signal, but:
  - It's populated mainly for MODIS, not VIIRS (a known FIRMS API quirk)
    -- so this script pulls MODIS_NRT specifically to get it.
  - It's still sparse even within MODIS -- most rows will have no type
    at all, and those get dropped from the labeled sample.
  - "type=2 other static/industrial land source" is NASA's own catch-all
    for "not a vegetation fire", which is the label we actually want, but
    it isn't a hand-verified ground truth in the way a labeled imagery
    benchmark would be -- treat resulting metrics as informative, not
    definitive.

Usage:
    python download_firms_sample.py YOUR_FIRMS_MAP_KEY
    python download_firms_sample.py YOUR_FIRMS_MAP_KEY --days 5
"""

import argparse
import csv
import io
import sys

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


def download_region(map_key, region_name, bbox, days):
    url = f"{FIRMS_BASE}/{map_key}/MODIS_NRT/{bbox}/{days}"
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    reader = csv.DictReader(io.StringIO(r.text))
    rows = list(reader)
    print(f"  {region_name}: {len(rows)} raw detections")
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("map_key", help="Your FIRMS_MAP_KEY")
    parser.add_argument("--days", type=int, default=3, help="Lookback window (1-10)")
    parser.add_argument("--out", default="firms_sample.csv")
    args = parser.parse_args()

    all_rows = []
    for name, bbox in REGIONS.items():
        try:
            rows = download_region(args.map_key, name, bbox, args.days)
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
