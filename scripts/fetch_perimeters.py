"""
fetch_perimeters.py
===================
Fetches active fire perimeter polygons from:
  - NIFC WFIGS API (USA) — https://data-nifc.opendata.arcgis.com/
  - CONAFOR (Mexico) — https://snigf.cnf.gob.mx/
  - CWFIS (Canada) — https://cwfis.cfs.nrcan.gc.ca/
    Canada has no single official real-time perimeter survey like NIFC's,
    so NRCan instead publishes "m3_polygons_current": a polygon layer built
    by clustering and buffering the day's satellite hotspots into an
    estimated burned-area shape. It's explicitly labeled by NRCan as a
    rough estimate (not a surveyed perimeter), so we carry that through as
    an `estimated: true` property the frontend can style/label distinctly.

Outputs: data/perimeters.geojson

How to run:
    python scripts/fetch_perimeters.py
"""

import json
import requests
from datetime import datetime, timezone
from manifest import update_manifest, stabilize_generated_at

OUTPUT_PATH = "data/perimeters.geojson"

# ── WFIGS (USA) ────────────────────────────────────────────────────────────────
# NIFC Wildland Fire Interagency Geospatial Services
# Current year perimeters — public domain, no auth required

WFIGS_URL = (
    "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/"
    "WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query"
)

WFIGS_PARAMS = {
    "where": "1=1",
    "outFields": (
        "poly_IncidentName,poly_GISAcres,poly_CreateDate,"
        "poly_DateCurrent,poly_PerimeterCategory,irwin_FireBehaviorGeneral"
    ),
    "outSR": "4326",          # WGS84 coordinates
    "f": "geojson",
    "resultRecordCount": 200, # max active fires to fetch
    "orderByFields": "poly_GISAcres DESC",  # largest first
}


def fetch_wfigs():
    """Fetch current fire perimeters from NIFC WFIGS."""
    print("Fetching USA fire perimeters from NIFC WFIGS...")
    try:
        r = requests.get(WFIGS_URL, params=WFIGS_PARAMS, timeout=60)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        print(f"  ERROR fetching WFIGS: {e}")
        return []

    features = data.get("features", [])
    print(f"  Got {len(features)} USA fire perimeters")

    # Normalize properties
    normalized = []
    for feat in features:
        props = feat.get("properties", {})
        normalized.append({
            "type": "Feature",
            "geometry": feat.get("geometry"),
            "properties": {
                "name": props.get("poly_IncidentName", "Unknown Fire"),
                "acres": props.get("poly_GISAcres"),
                "hectares": round(props.get("poly_GISAcres", 0) * 0.404686, 1),
                "date_created": props.get("poly_CreateDate"),
                "date_updated": props.get("poly_DateCurrent"),
                "category": props.get("poly_PerimeterCategory", ""),
                "behavior": props.get("irwin_FireBehaviorGeneral", ""),
                "country": "USA",
                "source": "NIFC WFIGS",
                "source_url": "https://data-nifc.opendata.arcgis.com/",
            }
        })
    return normalized


# ── CONAFOR (Mexico) ───────────────────────────────────────────────────────────
# Mexico's National Forestry Commission
# Public WMS/WFS service

CONAFOR_URL = (
    "https://snigf.cnf.gob.mx/arcgis/rest/services/"
    "Incendios/MapServer/0/query"
)

CONAFOR_PARAMS = {
    "where": "1=1",
    "outFields": "*",
    "outSR": "4326",
    "f": "geojson",
    "resultRecordCount": 200,
}


def fetch_conafor():
    """Fetch current fire perimeters from CONAFOR Mexico."""
    print("Fetching Mexico fire perimeters from CONAFOR...")
    try:
        r = requests.get(CONAFOR_URL, params=CONAFOR_PARAMS, timeout=60)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        print(f"  CONAFOR unavailable (service may be intermittent): {e}")
        print("  Returning empty Mexico perimeters — will retry next run.")
        return []

    features = data.get("features", [])
    print(f"  Got {len(features)} Mexico fire perimeters")

    normalized = []
    for feat in features:
        props = feat.get("properties", {}) or {}
        # CONAFOR field names vary — try common variants
        name = (props.get("NOMBRE") or props.get("nombre") or
                props.get("INCENDIO") or "Incendio Activo")
        hectares = (props.get("SUPERFICIE") or props.get("superficie") or
                    props.get("HA") or 0)
        try:
            hectares = float(hectares)
        except (TypeError, ValueError):
            hectares = 0.0

        normalized.append({
            "type": "Feature",
            "geometry": feat.get("geometry"),
            "properties": {
                "name": name,
                "hectares": round(hectares, 1),
                "acres": round(hectares * 2.47105, 1),
                "date_updated": props.get("FECHA") or props.get("fecha", ""),
                "state": props.get("ESTADO") or props.get("estado", ""),
                "municipality": props.get("MUNICIPIO") or props.get("municipio", ""),
                "country": "Mexico",
                "source": "CONAFOR",
                "source_url": "https://snigf.cnf.gob.mx/",
            }
        })
    return normalized


# ── CWFIS (Canada) ─────────────────────────────────────────────────────────────
# Natural Resources Canada's Canadian Wildland Fire Information System.
# "m3_polygons_current" = current-day burned-area ESTIMATE, built by NRCan
# from clustering + buffering the season-to-date satellite hotspots — not a
# ground-surveyed perimeter. Served in Canada Atlas Lambert (EPSG:3978) by
# default; we ask for EPSG:4326 so it lines up with everything else on the map.

CWFIS_URL = "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/ows"

CWFIS_PARAMS = {
    "service": "WFS",
    "version": "2.0.0",
    "request": "GetFeature",
    "typeName": "public:m3_polygons_current",
    "outputFormat": "application/json",
    "srsName": "EPSG:4326",
}


def fetch_cwfis():
    """Fetch current-day estimated burned-area polygons for Canada from CWFIS."""
    print("Fetching Canada fire perimeter estimates from CWFIS...")
    try:
        r = requests.get(CWFIS_URL, params=CWFIS_PARAMS, timeout=60)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        print(f"  CWFIS unavailable (service may be intermittent): {e}")
        print("  Returning empty Canada perimeters — will retry next run.")
        return []

    features = data.get("features", [])
    print(f"  Got {len(features)} Canada burned-area estimate polygons")

    normalized = []
    for feat in features:
        props = feat.get("properties", {}) or {}
        hectares = props.get("area") or 0
        try:
            hectares = float(hectares)
        except (TypeError, ValueError):
            hectares = 0.0

        normalized.append({
            "type": "Feature",
            "geometry": feat.get("geometry"),
            "properties": {
                "name": f"Estimated burned area (cluster {props.get('uid', '?')})",
                "hectares": round(hectares, 1),
                "acres": round(hectares * 2.47105, 1),
                "hotspot_count": props.get("hcount"),
                "date_created": props.get("firstdate"),
                "date_updated": props.get("lastdate"),
                "country": "Canada",
                "source": "CWFIS (Natural Resources Canada)",
                "source_url": "https://cwfis.cfs.nrcan.gc.ca/",
                # Distinguishes this from a surveyed/official perimeter
                # (WFIGS, CONAFOR) so the frontend can label it honestly as
                # an estimate rather than a confirmed burned-area boundary.
                "estimated": True,
            }
        })
    return normalized


def main():
    import os
    os.makedirs("data", exist_ok=True)

    usa_features = fetch_wfigs()
    mex_features = fetch_conafor()
    can_features = fetch_cwfis()

    all_features = usa_features + mex_features + can_features
    total_hectares = sum(
        f["properties"].get("hectares", 0) or 0
        for f in all_features
    )

    geojson = {
        "type": "FeatureCollection",
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "sources": {
                "USA": "NIFC WFIGS — https://data-nifc.opendata.arcgis.com/",
                "Mexico": "CONAFOR SNIGF — https://snigf.cnf.gob.mx/",
                "Canada": "CWFIS (NRCan) — https://cwfis.cfs.nrcan.gc.ca/ (hotspot-derived estimate)",
            },
            "description": (
                "Active wildfire perimeter polygons. USA and Mexico polygons are "
                "surveyed/confirmed burned-area boundaries. Canada polygons are "
                "estimates derived by NRCan from clustering same-day satellite "
                "hotspots (see each feature's `estimated` property). Area in "
                "hectares and acres provided."
            ),
            "total_fires": len(all_features),
            "total_hectares": round(total_hectares, 1),
            "usa_fires": len(usa_features),
            "mexico_fires": len(mex_features),
            "canada_fires": len(can_features),
        },
        "features": all_features
    }

    geojson = stabilize_generated_at(geojson, OUTPUT_PATH)

    with open(OUTPUT_PATH, "w") as f:
        json.dump(geojson, f, indent=2)
    update_manifest("perimeters", OUTPUT_PATH)

    print(f"\nSaved {OUTPUT_PATH}")
    print(f"Total: {len(all_features)} perimeters, {round(total_hectares):,} hectares")


if __name__ == "__main__":
    main()
