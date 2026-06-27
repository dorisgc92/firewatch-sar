/**
 * useFireData.js
 * Custom React hook that fetches all FireWatch SAR data layers
 * from the GeoJSON files in the /data folder (served via GitHub raw URLs).
 *
 * Each layer tracks:
 *   - data: the GeoJSON FeatureCollection
 *   - loading: boolean
 *   - error: string or null
 *   - fetchedAt: Date object (when WE fetched it)
 *   - generatedAt: Date object (when the script generated it — data freshness)
 */

import { useState, useEffect, useCallback } from 'react'

// Base URL for data files.
// In development: served from /data/ locally.
// In production: served from GitHub raw content or Vercel.
const DATA_BASE_URL = import.meta.env.VITE_DATA_BASE_URL || '/data'

const DATA_LAYERS = {
  hotspots:       `${DATA_BASE_URL}/hotspots.geojson`,
  weather:        `${DATA_BASE_URL}/weather.geojson`,
  fwi:            `${DATA_BASE_URL}/fwi_grid.geojson`,
  perimeters:     `${DATA_BASE_URL}/perimeters.geojson`,
  infrastructure: `${DATA_BASE_URL}/infrastructure.geojson`,
}

// Refresh interval in milliseconds (5 minutes)
// Data files update hourly via GitHub Actions, but we poll more often
// to catch updates quickly after they're committed.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000

async function fetchLayer(url) {
  const response = await fetch(url + `?t=${Date.now()}`) // cache-bust
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function parseDate(str) {
  if (!str) return null
  try { return new Date(str) } catch { return null }
}

function freshnessStatus(generatedAt) {
  if (!generatedAt) return 'unknown'
  const ageMs = Date.now() - generatedAt.getTime()
  const ageHrs = ageMs / (1000 * 60 * 60)
  if (ageHrs < 1)  return 'green'   // < 1 hour
  if (ageHrs < 6)  return 'amber'   // 1–6 hours
  return 'red'                       // > 6 hours
}

export function useFireData() {
  const [layers, setLayers] = useState({
    hotspots:       { data: null, loading: true, error: null, generatedAt: null, freshness: 'unknown' },
    weather:        { data: null, loading: true, error: null, generatedAt: null, freshness: 'unknown' },
    fwi:            { data: null, loading: true, error: null, generatedAt: null, freshness: 'unknown' },
    perimeters:     { data: null, loading: true, error: null, generatedAt: null, freshness: 'unknown' },
    infrastructure: { data: null, loading: true, error: null, generatedAt: null, freshness: 'unknown' },
  })

  const fetchAll = useCallback(async () => {
    const results = await Promise.allSettled(
      Object.entries(DATA_LAYERS).map(async ([key, url]) => {
        const data = await fetchLayer(url)
        const generatedAt = parseDate(data?.metadata?.generated_at)
        return { key, data, generatedAt }
      })
    )

    setLayers(prev => {
      const next = { ...prev }
      results.forEach((result, i) => {
        const key = Object.keys(DATA_LAYERS)[i]
        if (result.status === 'fulfilled') {
          const { data, generatedAt } = result.value
          next[key] = {
            data,
            loading: false,
            error: null,
            generatedAt,
            freshness: freshnessStatus(generatedAt),
          }
        } else {
          next[key] = {
            ...prev[key],
            loading: false,
            error: result.reason?.message || 'Failed to load',
            freshness: 'unknown',
          }
        }
      })
      return next
    })
  }, [])

  useEffect(() => {
    fetchAll()
    const interval = setInterval(fetchAll, REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [fetchAll])

  return layers
}
