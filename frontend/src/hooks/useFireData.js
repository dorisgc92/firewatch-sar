/**
 * useFireData.js
 * Custom React hook that fetches all FireWatch SAR data layers
 * from the GeoJSON files in the /data folder (served via GitHub raw URLs).
 *
 * Each layer tracks:
 *   - data: the GeoJSON FeatureCollection
 *   - loading: boolean (true only while we have NO data at all for this layer yet)
 *   - error: string or null
 *   - fetchedAt: Date object (when WE fetched it)
 *   - generatedAt: Date object (when the script generated it — data freshness)
 *
 * PERFORMANCE MODEL — "only redraw the pixels that changed"
 * ------------------------------------------------------------------
 * The naive approach (re-fetch all 5 full GeoJSON files, including the
 * ~10MB infrastructure file, every 5 minutes, for every visitor) was the
 * main cause of slow refreshes. Instead:
 *
 *   1. We poll a tiny `manifest.json` (a few hundred bytes) on a short
 *      interval. It just lists each layer's `generated_at` timestamp.
 *   2. A layer's full GeoJSON is only downloaded when the manifest's
 *      generated_at for it is NEWER than what we already have — most
 *      polls download nothing at all beyond the manifest itself.
 *   3. The URL for a layer is versioned by its generated_at
 *      (`hotspots.geojson?v=2026-07-20T03:17:45Z`) instead of the current
 *      timestamp. Same version = same URL = the browser/CDN is actually
 *      allowed to cache it, instead of us defeating caching on every call.
 *   4. Whatever we last loaded is cached in localStorage, so on a fresh
 *      page load the map paints instantly with the last-known data while
 *      the manifest check happens quietly in the background.
 */

import { useState, useEffect, useCallback, useRef } from 'react'

// Base URL for data files.
// In development: served from /data/ locally.
// In production: served from GitHub raw content or Vercel.
const DATA_BASE_URL = import.meta.env.VITE_DATA_BASE_URL || '/data'

// infrastructure used to be here too, fetched the same manifest-driven
// way as the others -- retired now that infrastructure lives on Doris's
// own remote server (see remote_server/) instead of a bundled GeoJSON in
// this repo. Zone-scoped infrastructure now comes from
// hooks/useZoneInfrastructure.js -> /api/infrastructure, not from here.
const DATA_LAYERS = {
  hotspots:       `${DATA_BASE_URL}/hotspots.geojson`,
  weather:        `${DATA_BASE_URL}/weather.geojson`,
  fwi:            `${DATA_BASE_URL}/fwi_grid.geojson`,
  perimeters:     `${DATA_BASE_URL}/perimeters.geojson`,
}

const MANIFEST_URL = `${DATA_BASE_URL}/manifest.json`
const LOCAL_STORAGE_PREFIX = 'firewatch:layer:'

// How often we check the (tiny) manifest for changes. Cheap, so this can be
// short — it does NOT mean we re-download full layers this often, only that
// we ask "did anything change".
const MANIFEST_POLL_MS = 2 * 60 * 1000 // 2 minutes

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

function readCache(key) {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_PREFIX + key)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeCache(key, generatedAtStr, data) {
  try {
    localStorage.setItem(
      LOCAL_STORAGE_PREFIX + key,
      JSON.stringify({ generatedAt: generatedAtStr, data })
    )
  } catch {
    // localStorage full or unavailable (private browsing, etc.) — fine,
    // we just lose the instant-reload benefit, nothing else breaks.
  }
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function initialLayerState() {
  const state = {}
  for (const key of Object.keys(DATA_LAYERS)) {
    const cached = readCache(key)
    state[key] = cached
      ? {
          data: cached.data,
          loading: false,
          error: null,
          generatedAt: parseDate(cached.generatedAt),
          freshness: freshnessStatus(parseDate(cached.generatedAt)),
          stale: true, // shown instantly from cache, not yet confirmed current
        }
      : { data: null, loading: true, error: null, generatedAt: null, freshness: 'unknown', stale: false }
  }
  return state
}

export function useFireData() {
  const [layers, setLayers] = useState(initialLayerState)
  // Tracks the generatedAt string we currently have loaded per layer, so we
  // can compare against the manifest without depending on React state
  // timing inside the polling loop.
  const loadedVersions = useRef({})
  useEffect(() => {
    for (const key of Object.keys(DATA_LAYERS)) {
      const cached = readCache(key)
      if (cached?.generatedAt) loadedVersions.current[key] = cached.generatedAt
    }
  }, [])

  const fetchLayer = useCallback(async (key, generatedAtStr) => {
    const url = DATA_LAYERS[key]
    // Version the URL by the manifest's generated_at instead of Date.now().
    // Same version => same URL => browser/CDN caching actually works;
    // a real change always gets a new URL and is never served stale.
    const versionedUrl = generatedAtStr ? `${url}?v=${encodeURIComponent(generatedAtStr)}` : url
    const data = await fetchJson(versionedUrl)
    const generatedAt = parseDate(data?.metadata?.generated_at || generatedAtStr)
    loadedVersions.current[key] = generatedAtStr || data?.metadata?.generated_at || null
    writeCache(key, loadedVersions.current[key], data)
    return { key, data, generatedAt }
  }, [])

  // Full fetch of everything — used once on mount as a fallback in case the
  // manifest itself is missing (e.g. an older deployment), so the app never
  // fully breaks even without it.
  const fetchAllDirect = useCallback(async () => {
    const results = await Promise.allSettled(
      Object.keys(DATA_LAYERS).map((key) => fetchLayer(key))
    )
    setLayers(prev => {
      const next = { ...prev }
      results.forEach((result, i) => {
        const key = Object.keys(DATA_LAYERS)[i]
        if (result.status === 'fulfilled') {
          const { data, generatedAt } = result.value
          next[key] = { data, loading: false, error: null, generatedAt, freshness: freshnessStatus(generatedAt), stale: false }
        } else {
          next[key] = { ...prev[key], loading: false, error: result.reason?.message || 'Failed to load', stale: false }
        }
      })
      return next
    })
  }, [fetchLayer])

  // The normal path: check the manifest, only fetch layers whose
  // generated_at moved forward (or that we've never loaded at all).
  const checkManifestAndSync = useCallback(async () => {
    let manifest
    try {
      manifest = await fetchJson(`${MANIFEST_URL}?t=${Date.now()}`) // manifest itself is tiny — fine to always bust cache on this one
    } catch {
      // No manifest available — fall back to fetching everything directly
      // (covers first run before this feature existed, or a manifest hiccup).
      await fetchAllDirect()
      return
    }

    const toFetch = Object.keys(DATA_LAYERS).filter((key) => {
      const manifestEntry = manifest[key]
      const manifestVersion = manifestEntry?.generated_at
      const haveVersion = loadedVersions.current[key]
      return manifestVersion && manifestVersion !== haveVersion
    })

    // Nothing changed — mark any cache-loaded layers as confirmed-current
    // and stop loading spinners, without touching the network again.
    if (toFetch.length === 0) {
      setLayers(prev => {
        const next = { ...prev }
        for (const key of Object.keys(DATA_LAYERS)) {
          if (next[key].loading || next[key].stale) {
            next[key] = { ...next[key], loading: false, stale: false }
          }
        }
        return next
      })
      return
    }

    const results = await Promise.allSettled(
      toFetch.map((key) => fetchLayer(key, manifest[key].generated_at))
    )

    setLayers(prev => {
      const next = { ...prev }
      results.forEach((result, i) => {
        const key = toFetch[i]
        if (result.status === 'fulfilled') {
          const { data, generatedAt } = result.value
          next[key] = { data, loading: false, error: null, generatedAt, freshness: freshnessStatus(generatedAt), stale: false }
        } else {
          next[key] = { ...prev[key], loading: false, stale: false, error: result.reason?.message || 'Failed to load' }
        }
      })
      // Layers that weren't in toFetch but were still marked "stale" (from
      // cache, confirmed current by the manifest) are now confirmed fresh.
      for (const key of Object.keys(DATA_LAYERS)) {
        if (!toFetch.includes(key) && next[key].stale) {
          next[key] = { ...next[key], stale: false, loading: false }
        }
      }
      return next
    })
  }, [fetchLayer, fetchAllDirect])

  useEffect(() => {
    checkManifestAndSync()
    const interval = setInterval(checkManifestAndSync, MANIFEST_POLL_MS)
    return () => clearInterval(interval)
  }, [checkManifestAndSync])

  return layers
}
