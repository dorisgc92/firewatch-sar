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
import hashlib

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


def _content_hash(features):
    """
    Stable hash of just the feature data (ignoring metadata like
    generated_at, which changes every run regardless of real content).
    """
    canonical = json.dumps(features, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def stabilize_generated_at(geojson, output_path):
    """
    "Only load what's new" — part 2.

    A fetch script runs on a timer and always stamps generated_at with the
    current time, even when the underlying data (fires, weather, etc.)
    didn't actually change between runs. Left alone, that fake "change"
    would still flow into manifest.json, and the frontend's delta-sync
    would re-download the full layer for nothing.

    This compares the new features against whatever is already committed
    at `output_path`. If the content is identical, we keep the OLD
    generated_at instead of the new one — so the file we write out is
    byte-for-byte the same as what's already committed, the workflow's
    `git diff --staged --quiet` check skips the commit, manifest.json
    never changes, and the frontend never re-downloads anything for this
    layer. Only a genuine change gets a new timestamp and a new commit.
    """
    new_features = geojson.get("features", [])
    new_hash = _content_hash(new_features)

    if os.path.exists(output_path):
        try:
            with open(output_path, "r") as f:
                old_geojson = json.load(f)
            old_hash = _content_hash(old_geojson.get("features", []))
            if old_hash == new_hash:
                old_generated_at = old_geojson.get("metadata", {}).get("generated_at")
                if old_generated_at:
                    geojson.setdefault("metadata", {})["generated_at"] = old_generated_at
        except (json.JSONDecodeError, FileNotFoundError):
            pass  # no valid previous file — treat this as a genuine first change

    return geojson
