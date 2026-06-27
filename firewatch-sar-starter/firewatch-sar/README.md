# 🔥 FireWatch SAR

**A Dual-Module Near-Real-Time Wildfire Intelligence Platform**

IEEE Response Quest Challenge 2026 — Phase 3

## Overview

FireWatch SAR is a browser-based wildfire intelligence platform for emergency responders worldwide. It integrates open-access satellite data, meteorological forecasts, and SAR imagery into a unified near-real-time interface — at zero operational cost.

### Two Modules

| Module | Purpose | Key Data |
|--------|---------|----------|
| **Module 1** — Pre-Fire Risk | 5-day FWI forecast map + alerts | Open-Meteo forecasts |
| **Module 2** — Active Fire | Real-time hotspots, perimeters, spread | NASA FIRMS, WFIGS, CONAFOR |

## Tech Stack

- **Frontend:** React + Leaflet.js → Vercel (free)
- **Data pipeline:** Python scripts → GitHub Actions (free, runs hourly)
- **Data storage:** GeoJSON files in this repo + Supabase (alerts history)
- **SAR processing:** Google Earth Engine (free academic)

## Data Sources (all open-access)

| Source | Data | Latency |
|--------|------|---------|
| NASA FIRMS VIIRS/MODIS | Active hotspots | < 3 hrs global |
| Open-Meteo API | Weather + forecast | Hourly |
| NIFC WFIGS | Fire perimeters (USA) | Multiple/day |
| CONAFOR | Fire perimeters (Mexico) | Daily |
| OpenStreetMap | Infrastructure | Near real-time |
| WorldPop | Population density | Annual |
| Copernicus Sentinel-1 | SAR burned area | 6–12 day revisit |

## Setup

### 1. Clone the repository
```bash
git clone https://github.com/YOUR_USERNAME/firewatch-sar.git
cd firewatch-sar
```

### 2. Get a NASA FIRMS API key (free)
Go to: https://firms.modaps.eosdis.nasa.gov/api/
Add it as a GitHub Secret named `FIRMS_MAP_KEY`

### 3. Install Python dependencies
```bash
pip install -r scripts/requirements.txt
```

### 4. Run a script manually to test
```bash
python scripts/fetch_firms.py
```

### 5. Deploy frontend
```bash
cd frontend
npm install
npm run dev
```

## Repository Structure

```
firewatch-sar/
├── .github/workflows/     # Automated hourly data fetching
├── scripts/               # Python data ingestion + FWI computation
├── data/                  # Auto-generated GeoJSON files (read by frontend)
└── frontend/              # React + Leaflet web application
```

## License

All data sources used are open-access. Code: MIT License.
