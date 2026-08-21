/**
 * responderGroups.js
 * Central definition of the five responder groups the EOC can dispatch to
 * a fire (bombero, proteccion_civil, ems, utilities, ong — matches the
 * responderType keys from StartScreen.jsx, minus "eoc" itself and
 * "analista" which don't get dispatched to). Each group is backed by an
 * OSM infrastructure type served by /api/infrastructure (Doris's remote
 * server, see remote_server/), used as a stand-in for "where that kind of
 * unit is based" — there's no real responder-roster data source, so
 * nearest facility of the matching type is the best available proxy.
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
    // Overpass-fallback features (from the /api/infrastructure proxy's
    // direct-Overpass path) don't carry an
    // osm_id — fall back to a coordinate-based id so "is this the same
    // facility" still works, same trick fireKeyFromLatLon uses for fires.
    id: osmId != null ? String(osmId) : `${lat.toFixed(4)},${lon.toFixed(4)}`,
    name: feature.properties?.name || fallbackName,
    lat, lon, distanceKm,
  }
}

/**
 * Top N nearest facilities for a group, ordered nearest-first. Capped at
 * MAX_CANDIDATE_DISTANCE_KM — a facility beyond that is never considered
 * "the nearest bombero" no matter what, even if it's technically the
 * closest thing present in whatever infraFeatures happens to be loaded.
 * That distinction matters because infraFeatures may be an incompletely
 * covered dataset (world-crawl still in progress) with data for some
 * far-away region but none for the zone actually being viewed — without
 * this cap, "nearest fire station to a fire in Guadalajara" could resolve
 * to a station on the other side of the planet just because it was the
 * only one loaded. When nothing is within range, this returns an empty
 * list — candidatesForGroup's callers already render "no unit nearby" for
 * that case, which is the honest answer here.
 *
 * infraFeatures: whatever's currently loaded for the zone (bundled
 * world-crawl data + any live per-zone Overpass fetch), same source
 * every other nearest-infra lookup in this app already uses.
 */
const MAX_CANDIDATE_DISTANCE_KM = 120

export function candidatesForGroup(lat, lon, infraFeatures, group, n = 3, fallbackName = "Unit", excludeIds = []) {
  const meta = GROUP_META[group]
  if (!meta) return []
  const types = new Set(meta.infraTypes)
  const excluded = new Set(excludeIds.map(String))
  const pool = (infraFeatures || []).filter((f) => types.has(f.properties?.type))
  if (pool.length === 0) return []
  // Ask for more than n so that, after filtering out anyone already in
  // excludeIds (past rejections for this same request), there's still
  // enough left to fill n genuinely-new suggestions instead of quietly
  // returning fewer than expected.
  return nearestFeatures(lat, lon, pool, n + excluded.size + 3)
    .filter(({ distanceKm }) => distanceKm <= MAX_CANDIDATE_DISTANCE_KM)
    .map(({ feature, distanceKm }) => candidateFromFeature(feature, distanceKm, fallbackName))
    .filter((c) => !excluded.has(c.id))
    .slice(0, n)
}

// Derives the aggregate incident.status (unassigned/assigned/attending/
// resolved — the one-line "Estado: X" summary shown near the top of the
// fire panel) from the per-group request states. The 6-bucket breakdown
// in IncidentStatusBar (Asignado/Aceptado/Rechazado/Atendiendo/Resuelto)
// reads incident.requests directly instead of this — this function only
// feeds that single summary line, so it deliberately stays coarse.
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
