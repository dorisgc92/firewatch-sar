import { useState, useEffect, useRef, useCallback } from "react"
import { deriveOverallStatus } from "../utils/responderGroups"

// Was 30s. The EOC assignment/accept-reject flow needs the OTHER side
// (the responder who just got a request, or the EOC waiting on an
// answer) to see a change within a couple of seconds, not up to half a
// minute — a 30s gap reads as "did it even send?" during a live demo.
// 3s keeps it feeling close to real-time without turning this into a
// websocket/SSE project; at this app's traffic (a handful of responders
// per session) the extra KV reads are negligible.
const POLL_MS = 3_000

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
  // setIncidentStatus/requestResponder/respondToRequest all need to read
  // the latest incidents to compute their next payload — a ref avoids
  // stale-closure bugs from calling them right after another update
  // without waiting for a re-render.
  const incidentsRef = useRef(incidents)
  incidentsRef.current = incidents

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

  // Low-level write: merges `status` and/or one-or-more groups' worth of
  // `requests` into whatever's already stored for fireKey. Kept generic
  // (rather than one setter per field) so the API and this hook agree on
  // exactly one merge strategy — see api/incidents.js for the server side
  // of the same merge.
  const setIncidentStatus = useCallback(async (fireKey, { status, requests } = {}) => {
    setIncidents((prev) => {
      const next = { ...prev }
      if (status === "unassigned" && !requests) {
        delete next[fireKey]
      } else {
        const existing = next[fireKey] || {}
        const merged = { ...existing }
        if (status) merged.status = status
        if (requests) merged.requests = { ...(existing.requests || {}), ...requests }
        if (!merged.status) merged.status = "assigned"
        merged.updatedAt = new Date().toISOString()
        next[fireKey] = merged
      }
      return next
    })
    try {
      const r = await fetch("/api/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fireKey, status, requests }),
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

  // EOC action: dispatch a specific facility for one group to one fire.
  // Overwrites any previous request for that same group on that fire
  // (a fresh Asignar always starts a new pending request), leaving every
  // other group's request untouched.
  const requestResponder = useCallback(async (fireKey, group, candidate) => {
    const req = {
      targetId: candidate.id, targetName: candidate.name,
      targetLat: candidate.lat, targetLon: candidate.lon, distanceKm: candidate.distanceKm,
      status: "pending", rejectedIds: [], requestedAt: new Date().toISOString(),
    }
    const existing = incidentsRef.current[fireKey]?.requests || {}
    const nextRequests = { ...existing, [group]: req }
    return setIncidentStatus(fireKey, { status: deriveOverallStatus(nextRequests), requests: { [group]: req } })
  }, [setIncidentStatus])

  // Responder-side action: accept / reject / mark-attending / mark-resolved
  // on the request currently targeting them. Reject no longer auto-picks
  // the next-nearest facility and silently re-sends — it just marks this
  // group's request "rejected" and stops there. The EOC sees it land in
  // the "Rechazado" bucket and picks the next unit themselves from a
  // refreshed candidate list (FireCommandPanel excludes anyone already in
  // rejectedIds), instead of a rejection disappearing into an automatic
  // retry the EOC never gets to see.
  const respondToRequest = useCallback(async (fireKey, group, action) => {
    const incident = incidentsRef.current[fireKey]
    const req = incident?.requests?.[group]
    if (!req) return false

    let updated
    if (action === "accept") {
      updated = { ...req, status: "accepted", respondedAt: new Date().toISOString() }
    } else if (action === "attending") {
      updated = { ...req, status: "attending" }
    } else if (action === "resolved") {
      updated = { ...req, status: "resolved" }
    } else if (action === "reject") {
      const rejectedIds = [...(req.rejectedIds || []), req.targetId]
      updated = { ...req, status: "rejected", rejectedIds, respondedAt: new Date().toISOString() }
    } else {
      return false
    }

    const existing = incident.requests || {}
    const nextRequests = { ...existing, [group]: updated }
    return setIncidentStatus(fireKey, { status: deriveOverallStatus(nextRequests), requests: { [group]: updated } })
  }, [setIncidentStatus])

  // EOC action: fully reset a fire back to unclaimed, clearing every
  // group's request — used by the "Liberar" control.
  const releaseIncident = useCallback(async (fireKey) => {
    return setIncidentStatus(fireKey, { status: "unassigned" })
  }, [setIncidentStatus])

  return { incidents, loading, error, setIncidentStatus, requestResponder, respondToRequest, releaseIncident, refresh }
}
