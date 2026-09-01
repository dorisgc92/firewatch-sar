import { useEffect, useRef, useState } from "react"

const CACHE_PREFIX = "fw_landcover_v1_"
const GRID = 0.01 // matches the server-side cache grid closely enough for a client-side dedup key

function pointKey(lat, lon) {
  return `${(Math.round(lat / GRID) * GRID).toFixed(3)},${(Math.round(lon / GRID) * GRID).toFixed(3)}`
}

function loadSessionCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + "map")
    return raw ? new Map(JSON.parse(raw)) : new Map()
  } catch { return new Map() }
}
function saveSessionCache(map) {
  try {
    // Keep this from growing without bound across a long session —
    // a few thousand entries is already every fire anyone plausibly
    // looked at with the filter on in one sitting.
    const entries = [...map.entries()].slice(-5000)
    sessionStorage.setItem(CACHE_PREFIX + "map", JSON.stringify(entries))
  } catch { /* storage unavailable — in-memory Map still works for this session */ }
}

/**
 * On-demand land cover classification for "Solo focos forestales" — the
 * successor to the batch classification that used to run inside
 * fetch_firms.py for every detection worldwide, every hour (see that
 * script's comment on why: a hard ~100s edge timeout on the free
 * Cloudflare Tunnel this app depends on, which a global batch this size
 * kept colliding with no matter how it was tuned). Classifying only
 * what's actually rendered on screen, and only while the filter toggle
 * is on, stays far inside that ceiling and doesn't pay for classifying
 * fires nobody's filtering by right now.
 *
 * points: array of { fireKey, lat, lon } — typically FireMap's own
 * viewport-scoped, marker-capped hotspot list.
 * enabled: only fetches while true (the filter toggle) — flipping it off
 * doesn't clear anything already learned, just stops asking for more.
 *
 * Returns a plain object { [fireKey]: category | null } that only grows
 * across the session (previously-classified fires stay classified even
 * after panning away and back), plus `loading` for a lightweight
 * "still checking a few..." indicator if the caller wants one.
 */
export default function useZoneLandCover(points, enabled) {
  const [classifications, setClassifications] = useState({})
  const [loading, setLoading] = useState(false)
  const cacheRef = useRef(null)
  if (cacheRef.current === null) cacheRef.current = loadSessionCache()

  useEffect(() => {
    if (!enabled || !points || points.length === 0) return

    const cache = cacheRef.current
    const toFetch = []
    const fromCache = {}
    for (const p of points) {
      const key = pointKey(p.lat, p.lon)
      if (cache.has(key)) {
        fromCache[p.fireKey] = cache.get(key)
      } else if (!(p.fireKey in classifications)) {
        toFetch.push(p)
      }
    }
    if (Object.keys(fromCache).length > 0) {
      setClassifications((prev) => ({ ...prev, ...fromCache }))
    }
    if (toFetch.length === 0) return

    // Light debounce — a pan/zoom can fire this several times in quick
    // succession as the viewport settles; no need to kick off a request
    // for every intermediate frame.
    const timer = setTimeout(() => {
      setLoading(true)
      fetch("/api/landcover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          points: toFetch.map((p) => ({ lat: p.lat, lon: p.lon })),
          window_size: 3,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          const results = data.results || []
          const updates = {}
          toFetch.forEach((p, i) => {
            const category = results[i]?.category ?? null
            updates[p.fireKey] = category
            if (category !== null) cache.set(pointKey(p.lat, p.lon), category)
          })
          saveSessionCache(cache)
          setClassifications((prev) => ({ ...prev, ...updates }))
        })
        .catch(() => {
          // Fail open — an unclassified fire is treated as "keep it" by
          // the caller, never as "hide it". No retry: if the filter's
          // still on next time the viewport changes, this runs again
          // naturally.
        })
        .finally(() => setLoading(false))
    }, 400)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, points])

  return { classifications, loading }
}
