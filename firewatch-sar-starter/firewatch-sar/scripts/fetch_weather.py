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
import requests
from datetime import datetime, timezone

OUTPUT_WEATHER = "data/weather.geojson"
OUTPUT_FWI = "data/fwi_grid.geojson"

# ── Grid configuration ─────────────────────────────────────────────────────────
# We sample weather at a coarse global grid (every 5 degrees)
# For a specific region of interest, reduce the step for higher resolution
GRID_STEP_DEG = 5.0   # degrees between grid points
LAT_RANGE = (-60, 75)  # exclude polar regions (low fire risk)
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

def fetch_weather_for_point(lat, lon):
    """
    Fetch current weather + 5-day hourly forecast for a single lat/lon point.
    Returns dict with weather variables, or None on error.
    Open-Meteo docs: https://open-meteo.com/en/docs
    """
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": [
            "temperature_2m",
            "relative_humidity_2m",
            "wind_speed_10m",
            "wind_direction_10m",
            "precipitation",
            "weather_code",
        ],
        "daily": [
            "temperature_2m_max",
            "relative_humidity_2m_min",
            "wind_speed_10m_max",
            "precipitation_sum",
            "weather_code",
        ],
        "forecast_days": 5,
        "timezone": "auto",
        "wind_speed_unit": "kmh",
    }

    try:
        r = requests.get(url, params=params, timeout=30)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return None


def build_grid_points():
    """Generate lat/lon grid points."""
    points = []
    lat = LAT_RANGE[0]
    while lat <= LAT_RANGE[1]:
        lon = LON_RANGE[0]
        while lon <= LON_RANGE[1]:
            points.append((round(lat, 1), round(lon, 1)))
            lon += GRID_STEP_DEG
        lat += GRID_STEP_DEG
    return points


def main():
    import os
    os.makedirs("data", exist_ok=True)

    grid_points = build_grid_points()
    print(f"Computing FWI for {len(grid_points)} grid points...")

    weather_features = []
    fwi_features = []
    errors = 0

    # For the global grid we batch requests carefully
    # In production, consider caching and rate limiting
    for i, (lat, lon) in enumerate(grid_points):
        if i % 50 == 0:
            print(f"  Progress: {i}/{len(grid_points)}")

        data = fetch_weather_for_point(lat, lon)
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
    with open(OUTPUT_WEATHER, "w") as f:
        json.dump(weather_geojson, f, indent=2)
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
    with open(OUTPUT_FWI, "w") as f:
        json.dump(fwi_geojson, f, indent=2)
    print(f"Saved {OUTPUT_FWI} ({len(fwi_features)} points)")
    print(f"Errors: {errors}")


if __name__ == "__main__":
    main()
