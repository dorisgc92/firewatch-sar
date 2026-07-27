import { useState, useEffect, useRef, useCallback } from "react"

const POLL_MS = 30_000

// Builds the stable-enough key used to identify "the same fire" across
// polls/refreshes. FIRMS doesn't give detections a persistent ID — each
// fetch is a fresh read — so this rounds the coordinates instead. At this
// precision (~11m), the same actual hotspot pixel keeps the same key
// across the hourly refresh while it's still burning, which is what
// matters for "someone already claimed this one" to keep working.
export function fireKeyFromLatLon(lat, lon) {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`
}

// Convenience wrapper for a raw GeoJSON hotspot feature (FireMap.jsx).
// Sidebar.jsx already works with flattened { lat, lon, ... } objects, so
// it calls fireKeyFromLatLon directly — both paths produce the same key
// for the same physical fire.
export function fireKeyFor(feature) {
  const [lon, lat] = feature.geometry.coordinates
  return fireKeyFromLatLon(lat, lon)
}

export default function useIncidents() {
  const [incidents, setIncidents] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/incidents")
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setIncidents(data)
      setError(null)
    } catch (e) {
      // Keep whatever we last had rather than clearing the UI on a single
      // failed poll — a transient network hiccup shouldn't make claimed
      // fires appear to un-claim themselves.
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    pollRef.current = setInterval(refresh, POLL_MS)
    return () => clearInterval(pollRef.current)
  }, [refresh])

  const setIncidentStatus = useCallback(async (fireKey, { status, unit, responderName, note }) => {
    // Optimistic update — reflect the change immediately instead of
    // waiting up to POLL_MS for it to come back around, then reconcile
    // with whatever the server actually stored (in case someone else's
    // change landed in between).
    setIncidents((prev) => {
      const next = { ...prev }
      if (status === "unassigned" || status == null) delete next[fireKey]
      else next[fireKey] = { status, unit, responderName, note, updatedAt: new Date().toISOString() }
      return next
    })
    try {
      const r = await fetch("/api/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fireKey, status, unit, responderName, note }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setIncidents(data)
      setError(null)
      return true
    } catch (e) {
      setError(e.message)
      // Reconcile with the server's real state rather than leaving the
      // optimistic guess in place if the write actually failed.
      refresh()
      return false
    }
  }, [refresh])

  return { incidents, loading, error, setIncidentStatus, refresh }
}
