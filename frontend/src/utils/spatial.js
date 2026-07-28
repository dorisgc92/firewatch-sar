/**
 * spatial.js
 * Small dependency-free spatial helpers used to scope global GeoJSON
 * layers (world hotspots, infrastructure, perimeters) down to whatever
 * zone/state/country the responder selected on the start screen.
 */

export function pointInBbox(lon, lat, bbox) {
  if (!bbox) return false
  return lon >= bbox.minLon && lon <= bbox.maxLon && lat >= bbox.minLat && lat <= bbox.maxLat
}

// Works for Point, LineString, Polygon, MultiPolygon, etc. — flattens all
// coordinate pairs and averages them. Good enough for "is this roughly here".
export function featureCentroid(feature) {
  const geom = feature?.geometry
  if (!geom) return null
  if (geom.type === "Point") {
    const [lon, lat] = geom.coordinates
    return [lat, lon]
  }
  const coords = []
  const flatten = (arr) => {
    if (!Array.isArray(arr)) return
    if (typeof arr[0] === "number") { coords.push(arr); return }
    arr.forEach(flatten)
  }
  flatten(geom.coordinates)
  if (coords.length === 0) return null
  const lon = coords.reduce((s, c) => s + c[0], 0) / coords.length
  const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length
  return [lat, lon]
}

export function filterFeaturesByBbox(features, bbox) {
  if (!bbox || !features) return []
  return features.filter((f) => {
    const c = featureCentroid(f)
    if (!c) return false
    return pointInBbox(c[1], c[0], bbox)
  })
}

// Haversine distance in kilometers.
export function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/**
 * Compass bearing (0-360, 0=N, 90=E) from point 1 to point 2 — used to
 * check whether a piece of infrastructure sits downwind of a fire (i.e.
 * in the direction the fire's smoke/embers are actually being pushed),
 * not just "nearby" regardless of wind direction.
 */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180
  const toDeg = (r) => (r * 180) / Math.PI
  const dLon = toRad(lon2 - lon1)
  const y = Math.sin(dLon) * Math.cos(toRad(lat2))
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

/**
 * Smallest angle (0-180) between two compass bearings.
 */
export function angleDiffDeg(a, b) {
  const diff = Math.abs(a - b) % 360
  return diff > 180 ? 360 - diff : diff
}

/**
 * Returns the n closest features to (fromLat, fromLon), each wrapped as
 * { feature, distanceKm }, sorted nearest-first.
 */
export function nearestFeatures(fromLat, fromLon, features, n = 1) {
  return features
    .map((f) => {
      const c = featureCentroid(f)
      if (!c) return null
      return { feature: f, distanceKm: distanceKm(fromLat, fromLon, c[0], c[1]) }
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, n)
}

// Standard ray-casting point-in-polygon test over a single [lon,lat] ring.
function pointInRing(lon, lat, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

// True if (lat, lon) falls inside a Polygon or MultiPolygon geometry
// (checking the outer ring only — holes are rare for wildfire perimeters
// and not worth the extra complexity here).
export function pointInPolygonGeometry(lat, lon, geom) {
  if (!geom) return false
  if (geom.type === "Polygon") {
    return pointInRing(lon, lat, geom.coordinates[0])
  }
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.some((poly) => pointInRing(lon, lat, poly[0]))
  }
  return false
}

// True if a hotspot sits within `maxDistanceKm` of a mapped industrial site
// (cement plants, factories, refineries...) or a quarry/landfill. These all
// run hot around the clock or generate their own heat (blasting, gas
// flares, decomposition) and are well-known sources of satellite
// thermal-anomaly false positives — NASA's own `type` classification field
// (which would flag this directly) isn't available on the NRT CSV endpoint
// FireWatch SAR uses, so this cross-reference against OSM land-use tags is
// the practical stand-in.
const EXCLUDED_SITE_TYPES = ["Industrial Zone", "Quarry/Landfill"]

export function isNearIndustrialSite(fireFeature, infrastructureFeatures, maxDistanceKm = 0.3) {
  if (!infrastructureFeatures?.length) return false
  const [lon, lat] = fireFeature.geometry.coordinates
  return infrastructureFeatures.some((f) => {
    if (!EXCLUDED_SITE_TYPES.includes(f.properties?.type)) return false
    const c = featureCentroid(f)
    if (!c) return false
    return distanceKm(lat, lon, c[0], c[1]) <= maxDistanceKm
  })
}

// True if a hotspot sits within `maxDistanceKm` of an OSM city/town center
// node ("Urban Area" in our infrastructure data). A thermal detection right
// on top of a populated place is far more likely to be a rooftop, vehicle,
// urban heat source, or industrial fire than a wildfire — same
// false-positive logic as isNearIndustrialSite, applied to cities/towns.
// The threshold is deliberately generous (2km) since a place node marks
// only an approximate city-center point, not the true urban footprint edge.
export function isNearUrbanArea(fireFeature, infrastructureFeatures, maxDistanceKm = 2) {
  if (!infrastructureFeatures?.length) return false
  const [lon, lat] = fireFeature.geometry.coordinates
  return infrastructureFeatures.some((f) => {
    if (f.properties?.type !== "Urban Area") return false
    const c = featureCentroid(f)
    if (!c) return false
    return distanceKm(lat, lon, c[0], c[1]) <= maxDistanceKm
  })
}

// True if at least one CURRENT hotspot detection falls inside (or very near)
// a perimeter polygon. Perimeter data (especially CWFIS's season-to-date
// burned-area estimate for Canada) can represent a fire that was active at
// some point THIS SEASON but has since gone quiet — no hot pixels in the
// last 24h. Showing that shaded zone with zero current hotspots inside it
// reads as a bug ("why is this shaded with nothing burning there?"), so
// perimeters are only drawn when there's still live detection activity to
// back them up.
// Bounding box of one or more rings — used to cheaply reject hotspots that
// can't possibly be near a given perimeter before doing any expensive
// point-in-polygon or per-vertex work.
function ringsBbox(rings) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lon < minLon) minLon = lon
      if (lon > maxLon) maxLon = lon
    }
  }
  return { minLat, maxLat, minLon, maxLon }
}

// Some CWFIS-derived perimeters (a hotspot cluster's buffered outline) have
// 10,000+ vertices — checking every one against every candidate hotspot was
// measured taking 10-20+ seconds for a single call on a province-wide view
// (Canada, active season). The vertex-distance check below is already an
// approximation (see comment below), so sampling a ring down to this many
// evenly-spaced points keeps that approximation just as good in practice
// while bounding the cost regardless of how detailed the source polygon is.
const MAX_VERTICES_FOR_DISTANCE_CHECK = 150

function sampledRing(ring) {
  if (ring.length <= MAX_VERTICES_FOR_DISTANCE_CHECK) return ring
  const step = ring.length / MAX_VERTICES_FOR_DISTANCE_CHECK
  const sampled = []
  for (let i = 0; i < MAX_VERTICES_FOR_DISTANCE_CHECK; i++) sampled.push(ring[Math.floor(i * step)])
  return sampled
}

export function perimeterHasActiveHotspot(perimeterFeature, hotspotFeatures, maxDistanceKm = 5) {
  if (!hotspotFeatures?.length) return false
  const geom = perimeterFeature.geometry
  // CWFIS-style perimeters are often elongated or multi-lobed (a hotspot
  // cluster's buffered outline) — checking distance to the geometric
  // centroid can be wildly wrong for that shape (the centroid can sit far
  // from every part of the actual outline). Checking distance to the
  // nearest VERTEX instead approximates "distance to the boundary" well
  // enough at typical perimeter vertex density, and correctly handles
  // shapes where the centroid is misleading.
  const rings = geom?.type === "Polygon"
    ? [geom.coordinates[0]]
    : geom?.type === "MultiPolygon"
    ? geom.coordinates.map((poly) => poly[0])
    : []
  if (rings.length === 0) return false

  // Cheap reject computed ONCE per perimeter (not per hotspot): a hotspot
  // outside this perimeter's bounding box (padded by maxDistanceKm) can't
  // be "active" for it, so skip the expensive checks below entirely for it.
  const bbox = ringsBbox(rings)
  const padDeg = maxDistanceKm / 111
  const minLat = bbox.minLat - padDeg, maxLat = bbox.maxLat + padDeg
  const minLon = bbox.minLon - padDeg, maxLon = bbox.maxLon + padDeg
  const sampledRings = rings.map(sampledRing)

  return hotspotFeatures.some((h) => {
    const [hlon, hlat] = h.geometry.coordinates
    if (hlat < minLat || hlat > maxLat || hlon < minLon || hlon > maxLon) return false
    if (pointInPolygonGeometry(hlat, hlon, geom)) return true
    return sampledRings.some((ring) =>
      ring.some(([vlon, vlat]) => distanceKm(hlat, hlon, vlat, vlon) <= maxDistanceKm)
    )
  })
}

// Links a hotspot detection (a single point) to the burned-area polygon it
// belongs to, when the app has one — this is where SAR-derived / official
// perimeter data upgrades a fire from "a dot" to "the actual shape of the
// fire", the same way NASA FIRMS shows perimeters. Strategy:
//   1. Prefer a perimeter that actually CONTAINS the point.
//   2. Otherwise fall back to the nearest perimeter within maxDistanceKm —
//      detections often sit a little outside the last-published perimeter
//      since hotspots update faster than perimeter mapping does.
// Returns the matching perimeter feature, or null if none qualifies.
export function linkedPerimeterForFire(fireFeature, perimeterFeatures, maxDistanceKm = 15) {
  if (!perimeterFeatures?.length) return null
  const [lon, lat] = fireFeature.geometry.coordinates

  const containing = perimeterFeatures.find((p) => pointInPolygonGeometry(lat, lon, p.geometry))
  if (containing) return containing

  const [closest] = nearestFeatures(lat, lon, perimeterFeatures, 1)
  if (closest && closest.distanceKm <= maxDistanceKm) return closest.feature
  return null
}