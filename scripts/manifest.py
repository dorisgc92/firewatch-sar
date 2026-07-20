"""
manifest.py
===========
Shared helper used by every fetch_*.py script. After a script writes its
GeoJSON output, it calls update_manifest(layer_key, path) to record that
layer's generated_at timestamp (and a couple of light stats) into a single
small data/manifest.json file.

Why: the frontend used to re-download every full GeoJSON file (including the
~10MB infrastructure file) on every 5-minute poll, even when nothing had
changed. Instead, the frontend now polls this tiny manifest file frequently
(cheap) and only fetches a full layer when its generated_at timestamp here
is newer than what it already has in memory/localStorage — the same idea as
a video codec only redrawing the pixels that changed between frames.

This file must stay small and dependency-free (stdlib only) since every
fetch script imports it independently.
"""

import json
import os

MANIFEST_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "manifest.json")


def update_manifest(layer_key, geojson_path):
    """
    Reads the metadata block out of the GeoJSON file we just wrote and
    records it in data/manifest.json under `layer_key`. Safe to call from
    any script, in any order — only touches its own key.
    """
    try:
        with open(geojson_path, "r") as f:
            geojson = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return

    meta = geojson.get("metadata", {})
    entry = {
        "generated_at": meta.get("generated_at"),
        "feature_count": len(geojson.get("features", [])),
    }

    manifest = {}
    if os.path.exists(MANIFEST_PATH):
        try:
            with open(MANIFEST_PATH, "r") as f:
                manifest = json.load(f)
        except json.JSONDecodeError:
            manifest = {}

    manifest[layer_key] = entry
    manifest["updated_at"] = meta.get("generated_at")

    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=2)
