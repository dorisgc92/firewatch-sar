import { useEffect, useRef, useState } from "react"

const CACHE_PREFIX = "fw_infra_v2_"
const MAX_CACHED_ZONES = 8

function bboxKey(bbox) {
  return [bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon].map((n) => n.toFixed(2)).join(",")
}
function getCached(key) {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + key)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function setCached(key, features) {
  try {
    sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify(features))
    const idxKey = CACHE_PREFIX + "index"
    let idx = JSON.parse(sessionStorage.getItem(idxKey) || "[]").filter((k) => k !== key)
    idx.push(key)
    while (idx.length > MAX_CACHED_ZONES) sessionStorage.removeItem(CACHE_PREFIX + idx.shift())
    sessionStorage.setItem(idxKey, JSON.stringify(idx))
  } catch { /* storage unavailable — skip caching silently */ }
}

/**
 * Zone-scoped infrastructure, now sourced from a single place: the
 * /api/infrastructure Vercel proxy (frontend/api/infrastructure.js),
 * which itself queries Doris's remote server (see remote_server/) and
 * falls back to a direct Overpass query if that machine is unreachable.
 *
 * This replaces the old "bundled world-crawl GeoJSON if it covers the
 * zone, else live Overpass fallback" dual-path logic that used to live
 * here — infrastructure no longer ships bundled in the repo at all, so
 * there's only one path now: ask the proxy for this bbox. Cached per
 * browser session (sessionStorage) so re-visiting the same zone in the
 * same tab doesn't re-fetch.
 */
export default function useZoneInfrastructure(zoneInfo) {
  const [state, setState] = useState({ features: [], loading: false, error: null })
  const requestId = useRef(0)

  useEffect(() => {
    if (!zoneInfo?.zoneBbox) return
    const key = bboxKey(zoneInfo.zoneBbox)
    const cached = getCached(key)
    if (cached) {
      setState({ features: cached, loading: false, error: null })
      return
    }

    const id = ++requestId.current
    setState((prev) => ({ ...prev, loading: true, error: null }))
    const { minLon, minLat, maxLon, maxLat } = zoneInfo.zoneBbox
    const bbox = `${minLon},${minLat},${maxLon},${maxLat}`

    fetch(`/api/infrastructure?bbox=${encodeURIComponent(bbox)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => {
        if (id !== requestId.current) return // a newer zone request superseded this one
        const features = data.features || []
        // Deliberately NOT caching empty results. A zone can legitimately
        // come back empty for a moment (the remote crawler mid-tile, a
        // transient proxy hiccup already retried server-side and still
        // empty) — caching that would trap the tab with "no units here"
        // for the rest of the session even once the real data exists,
        // since sessionStorage survives page reloads and only clears when
        // the tab/window closes. Only a genuinely non-empty result is
        // worth remembering.
        if (features.length > 0) setCached(key, features)
        setState({ features, loading: false, error: null })
      })
      .catch((e) => {
        if (id !== requestId.current) return
        setState({ features: [], loading: false, error: e.message })
      })
  }, [zoneInfo?.zoneBbox, zoneInfo?.name])

  return state
}
