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
