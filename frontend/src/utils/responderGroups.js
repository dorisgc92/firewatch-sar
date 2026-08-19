/**
 * responderGroups.js
 * Central definition of the five responder groups the EOC can dispatch to
 * a fire (bombero, proteccion_civil, ems, utilities, ong — matches the
 * responderType keys from StartScreen.jsx, minus "eoc" itself and
 * "analista" which don't get dispatched to). Each group is backed by an
 * OSM infrastructure type already present in liveInfra.js/the bundled
 * infrastructure.geojson, used as a stand-in for "where that kind of unit
 * is based" — there's no real responder-roster data source, so nearest
 * facility of the matching type is the best available proxy.
 *
 * This is the single source of truth both the EOC's assignment panel
 * (FireCommandPanel) and each responder's own request inbox
 * (ResponderRequestOverlay) build on, so "nearest 3" and "what counts as
 * my group" never drift apart between the two sides of the same request.
 */
import { nearestFeatures } from "./spatial"

export const GROUP_KEYS = ["bombero", "proteccion_civil", "ems", "utilities", "ong"]

export const GROUP_META = {
  bombero: { icon: "🚒", infraTypes: ["Fire Station"], fallbackNameKey: "groupFallback_bombero" },
  proteccion_civil: { icon: "🛡️", infraTypes: ["Police Station"], fallbackNameKey: "groupFallback_proteccion_civil" },
  ems: { icon: "🏥", infraTypes: ["Hospital", "Clinic"], fallbackNameKey: "groupFallback_ems" },
  utilities: { icon: "⚡", infraTypes: ["Power Substation", "Power Plant"], fallbackNameKey: "groupFallback_utilities" },
  ong: { icon: "📦", infraTypes: ["School (shelter)"], fallbackNameKey: "groupFallback_ong" },
}

// A "request-eligible" responderType — eoc dispatches, analista is a
// read-only post-event role, neither has a facility/inbox of its own.
export function isDispatchableGroup(responderType) {
  return GROUP_KEYS.includes(responderType)
}

function candidateFromFeature(feature, distanceKm, fallbackName) {
  const [lon, lat] = feature.geometry.coordinates
  const osmId = feature.properties?.osm_id
  return {
    // Live Overpass fallback features (liveInfra.js) don't carry an
    // osm_id — fall back to a coordinate-based id so "is this the same
    // facility" still works, same trick fireKeyFromLatLon uses for fires.
    id: osmId != null ? String(osmId) : `${lat.toFixed(4)},${lon.toFixed(4)}`,
    name: feature.properties?.name || fallbackName,
    lat, lon, distanceKm,
  }
}

/**
 * Top N nearest facilities for a group, ordered nearest-first.
 * infraFeatures: whatever's currently loaded for the zone (bundled
 * world-crawl data + any live per-zone Overpass fetch), same source
 * every other nearest-infra lookup in this app already uses.
 */
export function candidatesForGroup(lat, lon, infraFeatures, group, n = 3, fallbackName = "Unit") {
  const meta = GROUP_META[group]
  if (!meta) return []
  const types = new Set(meta.infraTypes)
  const pool = (infraFeatures || []).filter((f) => types.has(f.properties?.type))
  if (pool.length === 0) return []
  return nearestFeatures(lat, lon, pool, n).map(({ feature, distanceKm }) => candidateFromFeature(feature, distanceKm, fallbackName))
}

// Reject-and-cascade: the next nearest facility not already in
// excludeIds. Pulls a larger pool (50) than the 3 shown to the EOC so a
// fire with several fire stations nearby doesn't run out of options
// after two rejections just because only the top 3 were ever computed.
export function nextCandidateForGroup(lat, lon, infraFeatures, group, excludeIds = [], fallbackName = "Unit") {
  const excluded = new Set(excludeIds.map(String))
  const pool = candidatesForGroup(lat, lon, infraFeatures, group, 50, fallbackName)
  return pool.find((c) => !excluded.has(c.id)) || null
}

// Derives the aggregate incident.status (unassigned/assigned/attending/
// resolved — what IncidentStatusBar's four buckets already group by) from
// the per-group request states, so that bar stays accurate automatically
// as requests get accepted/rejected/advanced, without every call site
// that touches a single group's request having to also reason about the
// other four groups.
export function deriveOverallStatus(requestsMap) {
  const values = Object.values(requestsMap || {}).filter(Boolean)
  if (values.length === 0) return "unassigned"
  if (values.some((r) => r.status === "attending")) return "attending"
  if (values.some((r) => r.status === "pending" || r.status === "accepted")) return "assigned"
  if (values.some((r) => r.status === "resolved")) return "resolved"
  // Everything left is rejected/exhausted — no live response coordinating
  // this fire right now, so it goes back to needing attention.
  return "unassigned"
}

export function myFacilityStorageKey(group) {
  return `firewatch_my_facility_${group}`
}

export function loadMyFacility(group) {
  try {
    const raw = localStorage.getItem(myFacilityStorageKey(group))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function saveMyFacility(group, facility) {
  try {
    if (facility) localStorage.setItem(myFacilityStorageKey(group), JSON.stringify(facility))
    else localStorage.removeItem(myFacilityStorageKey(group))
  } catch { /* storage unavailable — session-only, not fatal */ }
}
