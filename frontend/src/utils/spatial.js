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

// True if a hotspot sits within `maxDistanceKm` of a mapped industrial site
// (cement plants, factories, refineries...). These run hot around the
// clock and are a well-known source of satellite thermal-anomaly false
// positives — NASA's own `type` classification field (which would flag
// this directly) isn't available on the NRT CSV endpoint FireWatch SAR
// uses, so this cross-reference against OSM industrial landuse is the
// practical stand-in.
export function isNearIndustrialSite(fireFeature, infrastructureFeatures, maxDistanceKm = 0.3) {
  if (!infrastructureFeatures?.length) return false
  const [lon, lat] = fireFeature.geometry.coordinates
  return infrastructureFeatures.some((f) => {
    if (f.properties?.type !== "Industrial Zone") return false
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
export function perimeterHasActiveHotspot(perimeterFeature, hotspotFeatures, maxDistanceKm = 5) {
  if (!hotspotFeatures?.length) return false
  const centroid = featureCentroid(perimeterFeature)

  return hotspotFeatures.some((h) => {
    const [hlon, hlat] = h.geometry.coordinates
    if (pointInPolygonGeometry(hlat, hlon, perimeterFeature.geometry)) return true
    if (!centroid) return false
    return distanceKm(hlat, hlon, centroid[0], centroid[1]) <= maxDistanceKm
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

// ─────────────────────────────────────────────────────────────────────────
// Hotspot clustering + estimated-area hulls
// ─────────────────────────────────────────────────────────────────────────
// When no official/estimated perimeter exists for a fire (most of the
// world — we only have real polygon data for USA, Mexico, and Canada),
// we build one ourselves from the FIRMS hotspot cloud we already fetch
// every 5 minutes: group nearby detections into clusters, then draw the
// shape (convex hull, buffered outward a bit) that wraps around each
// cluster. This is the same basic idea CWFIS uses officially for Canada
// (cluster + buffer hotspots), just computed client-side so it works
// anywhere in the world with zero extra API dependency.

const INTENSITY_RANK = { low: 0, moderate: 1, high: 2, extreme: 3, unknown: -1 }

/**
 * Groups hotspot features into clusters where every point is within
 * `maxDistanceKm` of at least one other point in the same cluster
 * (single-linkage clustering via union-find). Returns an array of
 * clusters, each an array of features.
 */
export function clusterHotspots(features, maxDistanceKm = 2) {
  const n = features.length
  if (n === 0) return []

  const parent = Array.from({ length: n }, (_, i) => i)
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] }
    return i
  }
  function union(a, b) {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  // Grid-bucket points so we only compare pairs that could plausibly be
  // within range, instead of a full O(n^2) scan — keeps this fast even
  // with a few hundred hotspots in view.
  const cellDeg = maxDistanceKm / 111 // ~km per degree latitude
  const cellOf = (lat, lon) => `${Math.floor(lat / cellDeg)}:${Math.floor(lon / cellDeg)}`
  const buckets = new Map()
  const coords = features.map((f) => {
    const [lon, lat] = f.geometry.coordinates
    return [lat, lon]
  })
  coords.forEach(([lat, lon], i) => {
    const key = cellOf(lat, lon)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(i)
  })

  for (let i = 0; i < n; i++) {
    const [lat, lon] = coords[i]
    const cLat = Math.floor(lat / cellDeg)
    const cLon = Math.floor(lon / cellDeg)
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const neighbors = buckets.get(`${cLat + dLat}:${cLon + dLon}`)
        if (!neighbors) continue
        for (const j of neighbors) {
          if (j <= i) continue
          const [lat2, lon2] = coords[j]
          if (distanceKm(lat, lon, lat2, lon2) <= maxDistanceKm) union(i, j)
        }
      }
    }
  }

  const groups = new Map()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(features[i])
  }
  return Array.from(groups.values())
}

/** Andrew's monotone chain convex hull. Points: [[lat, lon], ...]. */
function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (pts.length < 3) return pts

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

  const lower = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop(); lower.pop()
  return lower.concat(upper)
}

/**
 * Builds a shaded "estimated burned area" polygon for a hotspot cluster:
 * the convex hull of the points, pushed outward a little so the shape
 * reads as a zone around the detections rather than a shape drawn exactly
 * through them (real fire extent is always a bit larger than the pixels
 * that triggered detection).
 */
export function estimatedAreaForCluster(clusterFeatures, bufferKm = 0.8) {
  const points = clusterFeatures.map((f) => {
    const [lon, lat] = f.geometry.coordinates
    return [lat, lon]
  })
  if (points.length < 3) return null

  const hull = convexHull(points)
  const centroid = hull.reduce((acc, p) => [acc[0] + p[0] / hull.length, acc[1] + p[1] / hull.length], [0, 0])
  const bufferDeg = bufferKm / 111

  const buffered = hull.map(([lat, lon]) => {
    const dLat = lat - centroid[0]
    const dLon = lon - centroid[1]
    const dist = Math.sqrt(dLat * dLat + dLon * dLon) || 1
    return [lon + (dLon / dist) * bufferDeg, lat + (dLat / dist) * bufferDeg] // GeoJSON = [lon, lat]
  })
  buffered.push(buffered[0]) // close the ring

  // Dominant intensity in the cluster drives the fill color, so the shaded
  // zone itself hints at severity even before looking at the individual
  // dots on top of it.
  let dominant = "unknown"
  for (const f of clusterFeatures) {
    const cls = f.properties?.intensity
    if (INTENSITY_RANK[cls] > INTENSITY_RANK[dominant]) dominant = cls
  }

  const totalFrp = clusterFeatures.reduce((sum, f) => sum + (f.properties?.frp || 0), 0)

  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [buffered] },
    properties: {
      estimated: true,
      hotspot_count: clusterFeatures.length,
      dominant_intensity: dominant,
      total_frp: Math.round(totalFrp * 10) / 10,
      name: `Estimated area (${clusterFeatures.length} detections)`,
    },
  }
}