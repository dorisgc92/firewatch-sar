"""
fetch_weather.py
================
Fetches meteorological data from Open-Meteo API and computes
the Fire Weather Index (FWI) for a global grid.

Outputs:
    data/weather.geojson   — current weather conditions per grid cell
    data/fwi_grid.geojson  — FWI risk map (current + 5-day forecast)

Open-Meteo API: https://open-meteo.com/ (free, no key required)
FWI documentation: https://natural-resources.canada.ca/forests/wildland-fires/fire-weather-index-system

Environment variables: none required (Open-Meteo is free without auth)

How to run manually:
    python scripts/fetch_weather.py
"""

import json
import math
import time
import requests
from datetime import datetime, timezone
from manifest import update_manifest, stabilize_generated_at

OUTPUT_WEATHER = "data/weather.geojson"
OUTPUT_FWI = "data/fwi_grid.geojson"

# Reuses the same simplified world-countries polygon file the frontend
# already bundles for reverseCountryLookup (frontend/src/utils/
# countryBoundaries.js) as a lightweight land mask — no new dependency,
# no separate dataset to keep in sync. Grid points that don't fall inside
# any country polygon (open ocean) are skipped: wildfires don't happen at
# sea, and skipping them keeps fwi_grid.geojson from being ~70% empty-ocean
# points once the grid covers the whole world instead of just Mexico/US.
LAND_MASK_PATH = "frontend/public/geo/countries.geo.json"

# ── Grid configuration ─────────────────────────────────────────────────────────
# Previously hardcoded to (14,33)/(-118,-86) — Mexico/US border only — even
# though the output metadata claimed "global grid points". Now actually
# global: -60 to 75 latitude covers all inhabited land (skips Antarctica
# and the high Arctic, where wildfire risk isn't meaningful), full
# longitude range. Land-mask filtering below is what keeps this from
# turning into ~650 Open-Meteo calls; batching (fetch_weather_batch) is
# what keeps even the land points from becoming ~200 separate HTTP requests.
GRID_STEP_DEG = 10.0   # degrees between grid points
LAT_RANGE = (-60, 75)
LON_RANGE = (-180, 180)

# ── FWI Classification ─────────────────────────────────────────────────────────
FWI_CLASSES = [
    (0, 5,   "low",       "#38A800", "Low"),
    (5, 12,  "moderate",  "#FFFF00", "Moderate"),
    (12, 20, "high",      "#FFAA00", "High"),
    (20, 30, "very_high", "#FF0000", "Very High"),
    (30, 999,"extreme",   "#7A0000", "Extreme"),
]

def classify_fwi(fwi_value):
    """Return risk class, color, and label for a given FWI value."""
    for low, high, cls, color, label in FWI_CLASSES:
        if low <= fwi_value < high:
            return cls, color, label
    return "extreme", "#7A0000", "Extreme"


# ── FWI Computation ────────────────────────────────────────────────────────────
# Simplified FWI using the Fine Fuel Moisture Code (FFMC) component
# Based on: Canadian Forest Service Fire Weather Index System
# Reference: Van Wagner (1987), Development and Structure of the Canadian
#            Forest Fire Weather Index System. Forestry Technical Report 35.

def compute_ffmc(temp_c, rh_pct, wind_kmh, rain_mm, prev_ffmc=85.0):
    """
    Compute Fine Fuel Moisture Code (FFMC).
    FFMC indicates moisture content of fine fuels (litter, grass).
    Higher FFMC = drier fuel = easier ignition.
    Range: 0–101
    """
    # Previous moisture content
    mo = 147.2 * (101.0 - prev_ffmc) / (59.5 + prev_ffmc)

    # Rain effect
    if rain_mm > 0.5:
        rf = rain_mm - 0.5
        if mo <= 150:
            mo = mo + 42.5 * rf * math.exp(-100.0 / (251.0 - mo)) * (1.0 - math.exp(-6.93 / rf))
        else:
            mo = mo + 42.5 * rf * math.exp(-100.0 / (251.0 - mo)) * (1.0 - math.exp(-6.93 / rf))
            if mo > 250:
                mo = 250.0

    # Equilibrium moisture content
    ed = 0.942 * (rh_pct ** 0.679) + (11.0 * math.exp((rh_pct - 100.0) / 10.0)) + \
         0.18 * (21.1 - temp_c) * (1.0 - math.exp(-0.115 * rh_pct))
    ew = 0.618 * (rh_pct ** 0.753) + (10.0 * math.exp((rh_pct - 100.0) / 10.0)) + \
         0.18 * (21.1 - temp_c) * (1.0 - math.exp(-0.115 * rh_pct))

    # Drying or wetting
    if mo > ed:
        ko = 0.424 * (1.0 - ((100.0 - rh_pct) / 100.0) ** 1.7) + \
             0.0694 * math.sqrt(wind_kmh) * (1.0 - ((100.0 - rh_pct) / 100.0) ** 8)
        kd = ko * 0.581 * math.exp(0.0365 * temp_c)
        m = ed + (mo - ed) * math.exp(-2.303 * kd)
    elif mo < ew:
        kl = 0.424 * (1.0 - (rh_pct / 100.0) ** 1.7) + \
             0.0694 * math.sqrt(wind_kmh) * (1.0 - (rh_pct / 100.0) ** 8)
        kw = kl * 0.581 * math.exp(0.0365 * temp_c)
        m = ew - (ew - mo) * math.exp(-2.303 * kw)
    else:
        m = mo

    m = max(0.0, min(250.0, m))
    ffmc = 59.5 * (250.0 - m) / (147.2 + m)
    return max(0.0, min(101.0, ffmc))


def compute_isi(wind_kmh, ffmc):
    """
    Compute Initial Spread Index (ISI).
    ISI combines wind and FFMC to estimate rate of fire spread.
    Higher ISI = faster spread.
    """
    fm = 147.2 * (101.0 - ffmc) / (59.5 + ffmc)
    fw = math.exp(0.05039 * wind_kmh)
    ff = 91.9 * math.exp(-0.1386 * fm) * (1.0 + fm ** 5.31 / 49300000.0)
    return 0.208 * fw * ff


def compute_bui(dmc=20.0, dc=200.0):
    """
    Compute Buildup Index (BUI) — simplified with typical default values.
    BUI represents total fuel available for combustion.
    For a full implementation, DMC and DC require multi-day history.
    """
    if dmc <= 0.4 * dc:
        bui = 0.8 * dmc * dc / (dmc + 0.4 * dc)
    else:
        bui = dmc - (1.0 - 0.8 * dc / (dmc + 0.4 * dc)) * \
              (0.92 + (0.0114 * dmc) ** 1.7)
    return max(0.0, bui)


def compute_fwi(isi, bui):
    """
    Compute Fire Weather Index (FWI) from ISI and BUI.
    FWI is the primary fire danger rating used globally.
    Range: 0 (no danger) to 100+ (extreme danger)
    """
    if bui <= 80:
        fd = 0.626 * (bui ** 0.809) + 2.0
    else:
        fd = 1000.0 / (25.0 + 108.64 * math.exp(-0.023 * bui))
    b = 0.1 * isi * fd
    if b > 1.0:
        fwi = math.exp(2.72 * (0.434 * math.log(b)) ** 0.647)
    else:
        fwi = b
    return round(max(0.0, fwi), 1)


def fwi_from_weather(temp_c, rh_pct, wind_kmh, rain_mm):
    """Compute FWI from raw weather variables."""
    ffmc = compute_ffmc(temp_c, rh_pct, wind_kmh, rain_mm)
    isi = compute_isi(wind_kmh, ffmc)
    bui = compute_bui()  # simplified — full implementation needs daily history
    return compute_fwi(isi, bui)


# ── Open-Meteo API ─────────────────────────────────────────────────────────────

_land_polygons_cache = None

def _load_land_polygons():
    """Loads and caches the bundled countries GeoJSON as a flat list of
    (rings) per feature, ready for point-in-polygon testing. Missing file
    or bad JSON degrades to "no land mask" (keep every grid point) rather
    than crashing the whole fetch — a coarser-than-intended grid is a much
    smaller problem than the workflow failing outright."""
    global _land_polygons_cache
    if _land_polygons_cache is not None:
        return _land_polygons_cache
    try:
        with open(LAND_MASK_PATH) as f:
            data = json.load(f)
        polygons = []
        for feat in data.get("features", []):
            geom = feat.get("geometry") or {}
            if geom.get("type") == "Polygon":
                polygons.append(geom["coordinates"])
            elif geom.get("type") == "MultiPolygon":
                polygons.extend(geom["coordinates"])
        _land_polygons_cache = polygons
    except Exception as e:
        print(f"  WARNING: couldn't load land mask ({LAND_MASK_PATH}): {e}")
        print("  Proceeding without land filtering — grid will include ocean points.")
        _land_polygons_cache = None
    return _land_polygons_cache


def _point_in_ring(lon, lat, ring):
    """Standard ray-casting point-in-polygon test over a single [lon,lat] ring."""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def is_on_land(lat, lon):
    """True if (lat, lon) falls inside any country polygon (outer ring
    only — holes/enclaves aren't worth the extra complexity for a coarse
    weather grid). Returns True (keep the point) if the land mask failed
    to load, so a missing file degrades gracefully instead of silently
    dropping the entire grid."""
    polygons = _load_land_polygons()
    if polygons is None:
        return True
    for rings in polygons:
        if rings and _point_in_ring(lon, lat, rings[0]):
            return True
    return False


def fetch_weather_batch(points, batch_size=50):
    """
    Fetches current weather + 5-day forecast for many points in as few
    HTTP requests as possible, instead of one request per grid point.
    Open-Meteo's /forecast endpoint accepts comma-separated latitude/
    longitude lists and returns a JSON array in the same order (or a plain
    object if the batch has exactly one point — normalized to a list
    below either way). batch_size keeps each request's URL length and
    response size reasonable; it's not a hard API limit, just a sane chunk
    size for a few hundred global grid points.

    Returns {(lat, lon): data_or_None} for every point requested — None
    for any point whose batch failed, so the caller's existing per-point
    error counting keeps working unchanged.
    """
    url = "https://api.open-meteo.com/v1/forecast"
    results = {}
    for i in range(0, len(points), batch_size):
        chunk = points[i:i + batch_size]
        params = {
            "latitude": ",".join(str(lat) for lat, lon in chunk),
            "longitude": ",".join(str(lon) for lat, lon in chunk),
            "current": [
                "temperature_2m", "relative_humidity_2m", "wind_speed_10m",
                "wind_direction_10m", "precipitation", "weather_code",
            ],
            "daily": [
                "temperature_2m_max", "relative_humidity_2m_min",
                "wind_speed_10m_max", "precipitation_sum", "weather_code",
            ],
            "forecast_days": 5,
            "timezone": "auto",
            "wind_speed_unit": "kmh",
        }
        try:
            r = requests.get(url, params=params, timeout=60)
            r.raise_for_status()
            data = r.json()
            # A single-point request gets back one object, not a list of
            # one — normalize so the zip below always lines up correctly.
            if isinstance(data, dict):
                data = [data]
            for (lat, lon), point_data in zip(chunk, data):
                results[(lat, lon)] = point_data
        except Exception as e:
            print(f"  Batch {i}-{i + len(chunk)} of {len(points)} failed: {e}")
            for lat, lon in chunk:
                results[(lat, lon)] = None
        # Brief pause between batches — polite to Open-Meteo's free tier,
        # and irrelevant to total runtime at this scale (a handful of
        # batches, not hundreds of individual requests).
        time.sleep(0.5)
    return results


def build_grid_points():
    """Generate lat/lon grid points, skipping open-ocean cells (see
    is_on_land) — a global grid without this filter is roughly 70% empty
    ocean at this resolution, wasted work and wasted rows in the output."""
    points = []
    lat = LAT_RANGE[0]
    while lat <= LAT_RANGE[1]:
        lon = LON_RANGE[0]
        while lon <= LON_RANGE[1]:
            if is_on_land(lat, lon):
                points.append((round(lat, 1), round(lon, 1)))
            lon += GRID_STEP_DEG
        lat += GRID_STEP_DEG
    return points


def main():
    import os
    os.makedirs("data", exist_ok=True)

    grid_points = build_grid_points()
    print(f"Computing FWI for {len(grid_points)} grid points (land-filtered, batched fetch)...")

    weather_features = []
    fwi_features = []
    errors = 0

    weather_by_point = fetch_weather_batch(grid_points)

    for i, (lat, lon) in enumerate(grid_points):
        if i % 50 == 0:
            print(f"  Progress: {i}/{len(grid_points)}")

        data = weather_by_point.get((lat, lon))
        if not data or "current" not in data:
            errors += 1
            continue

        current = data["current"]
        daily = data.get("daily", {})

        temp = current.get("temperature_2m", 20)
        rh = current.get("relative_humidity_2m", 50)
        wind = current.get("wind_speed_10m", 10)
        wind_dir = current.get("wind_direction_10m", 0)
        rain = current.get("precipitation", 0)

        # Current FWI
        fwi_now = fwi_from_weather(temp, rh, wind, rain)
        risk_class, color, risk_label = classify_fwi(fwi_now)

        # 5-day FWI forecast
        forecast = []
        if daily.get("temperature_2m_max"):
            for day_i in range(len(daily["temperature_2m_max"])):
                t = daily["temperature_2m_max"][day_i] or temp
                h = daily["relative_humidity_2m_min"][day_i] or rh
                w = daily["wind_speed_10m_max"][day_i] or wind
                p = daily["precipitation_sum"][day_i] or 0
                day_fwi = fwi_from_weather(t, h, w, p)
                day_class, day_color, day_label = classify_fwi(day_fwi)
                forecast.append({
                    "date": daily.get("time", [""] * 5)[day_i],
                    "fwi": day_fwi,
                    "risk_class": day_class,
                    "risk_label": day_label,
                    "color": day_color,
                    "temp_max": t,
                    "rh_min": h,
                    "wind_max": w,
                    "rain": p,
                })

        # Determine trend (compare day 0 vs day 3)
        trend = "steady"
        if len(forecast) >= 4:
            if forecast[3]["fwi"] > fwi_now * 1.2:
                trend = "escalating"
            elif forecast[3]["fwi"] < fwi_now * 0.8:
                trend = "de-escalating"

        props = {
            "lat": lat,
            "lon": lon,
            "temp_c": temp,
            "rh_pct": rh,
            "wind_kmh": wind,
            "wind_dir_deg": wind_dir,
            "rain_mm": rain,
            "fwi": fwi_now,
            "risk_class": risk_class,
            "risk_label": risk_label,
            "risk_color": color,
            "trend": trend,
            "forecast": forecast,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }

        # Weather feature
        weather_features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "temp_c": temp,
                "rh_pct": rh,
                "wind_kmh": wind,
                "wind_dir_deg": wind_dir,
                "rain_mm": rain,
                "fetched_at": props["fetched_at"],
            }
        })

        # FWI feature
        fwi_features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": props
        })

    now_str = datetime.now(timezone.utc).isoformat()

    # Unlike fetch_perimeters.py (three independent sources, so "all zero"
    # is a strong failure signal), a handful of Open-Meteo errors here and
    # there is normal — errors is already tracked and reported per-run.
    # What's NOT normal is EVERY point failing at once (all-or-nothing
    # outage on Open-Meteo's side, or a bad API change) — that's the case
    # this guards against, same principle as fetch_firms.py/fetch_perimeters.py:
    # refuse to replace good existing data with nothing.
    if errors == len(grid_points) and len(grid_points) > 0:
        print("\n" + "=" * 70)
        print(f"ERROR: all {len(grid_points)} grid points failed. Treating this as")
        print("an Open-Meteo outage/API-change rather than 'no weather anywhere'.")
        print("=" * 70)
        if os.path.exists(OUTPUT_WEATHER) or os.path.exists(OUTPUT_FWI):
            raise SystemExit(1)  # fail the workflow loudly; keep old files untouched
        # No pre-existing files (first-ever run) — fall through and write
        # empty-but-valid files so the frontend doesn't crash on a missing file.

    # Save weather.geojson
    weather_geojson = {
        "type": "FeatureCollection",
        "metadata": {
            "generated_at": now_str,
            "source": "Open-Meteo API (https://open-meteo.com/)",
            "description": "Current meteorological conditions at global grid points.",
            "grid_step_deg": GRID_STEP_DEG,
            "total_points": len(weather_features),
            "errors": errors,
        },
        "features": weather_features
    }
    weather_geojson = stabilize_generated_at(weather_geojson, OUTPUT_WEATHER)
    with open(OUTPUT_WEATHER, "w") as f:
        json.dump(weather_geojson, f, indent=2)
    update_manifest("weather", OUTPUT_WEATHER)
    print(f"Saved {OUTPUT_WEATHER} ({len(weather_features)} points)")

    # Save fwi_grid.geojson
    fwi_geojson = {
        "type": "FeatureCollection",
        "metadata": {
            "generated_at": now_str,
            "source": "Computed from Open-Meteo data using Canadian Forest Service FWI System",
            "description": (
                "Fire Weather Index (FWI) grid. FWI integrates temperature, "
                "relative humidity, wind speed, and precipitation into a single "
                "fire danger rating. Higher values indicate greater fire danger."
            ),
            "fwi_classes": {c[2]: {"range": f"{c[0]}–{c[1]}", "color": c[3], "label": c[4]}
                           for c in FWI_CLASSES},
            "grid_step_deg": GRID_STEP_DEG,
            "total_points": len(fwi_features),
        },
        "features": fwi_features
    }
    fwi_geojson = stabilize_generated_at(fwi_geojson, OUTPUT_FWI)
    with open(OUTPUT_FWI, "w") as f:
        json.dump(fwi_geojson, f, indent=2)
    update_manifest("fwi", OUTPUT_FWI)
    print(f"Saved {OUTPUT_FWI} ({len(fwi_features)} points)")
    print(f"Errors: {errors}")


if __name__ == "__main__":
    main()