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
function pointInPolygonGeometry(lat, lon, geom) {
  if (!geom) return false
  if (geom.type === "Polygon") {
    return pointInRing(lon, lat, geom.coordinates[0])
  }
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.some((poly) => pointInRing(lon, lat, poly[0]))
  }
  return false
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
