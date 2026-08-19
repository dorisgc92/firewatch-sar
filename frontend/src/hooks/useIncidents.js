import { useState, useEffect, useRef, useCallback } from "react"
import { deriveOverallStatus, nextCandidateForGroup } from "../utils/responderGroups"

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
  // on the request currently targeting them. Reject auto-advances to the
  // next-nearest facility in that group (same cascade the old hospital-only
  // evacuation flow used) rather than just dead-ending the request — the
  // EOC panel keeps showing "pending", now against a new target, instead
  // of silently going quiet.
  const respondToRequest = useCallback(async (fireKey, group, action, { infraFeatures, lat, lon, fallbackName } = {}) => {
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
      const excluded = [...(req.rejectedIds || []), req.targetId]
      const next = nextCandidateForGroup(lat, lon, infraFeatures, group, excluded, fallbackName)
      updated = next
        ? { targetId: next.id, targetName: next.name, targetLat: next.lat, targetLon: next.lon,
            distanceKm: next.distanceKm, status: "pending", rejectedIds: excluded,
            requestedAt: req.requestedAt, respondedAt: new Date().toISOString() }
        : { ...req, status: "exhausted", rejectedIds: excluded, respondedAt: new Date().toISOString() }
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
