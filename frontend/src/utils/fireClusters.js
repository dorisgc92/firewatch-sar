/**
 * fireClusters.js
 * ================
 * Draws an ESTIMATED fire perimeter by grouping nearby FIRMS detections
 * into a polygon, entirely client-side, with zero dependency on any
 * agency (CONAFOR/NIFC/CWFIS) publishing an official perimeter. Those
 * official perimeters are real, free, and valuable when they exist --
 * this doesn't replace them, it fills the gap while they're not
 * published yet (which, per today's testing, is most of the time for a
 * freshly-detected fire).
 *
 * Deliberately NOT "the extent of the forest/park containing the fire"
 * (a static boundary that doesn't shrink or grow with the actual fire)
 * -- it's the convex hull of the detections themselves, padded by a
 * small buffer to account for the fact that a hotspot pixel is a
 * coarse sample of a fire, not its exact edge.
 */

import { distanceKm } from "./spatial"

// VIIRS pixels are ~375m, MODIS ~1km -- detections from the same real
// fire event commonly land a few hundred meters to a couple of km apart
// depending on sensor, viewing angle, and how the fire front is moving.
// 2km groups "the same fire" without also swallowing a genuinely
// separate, nearby-but-distinct ignition into one shape.
const CLUSTER_THRESHOLD_KM = 2
// A hull straight through pixel centers understates the real extent --
// buffering outward by roughly half a VIIRS pixel acknowledges "the
// fire likely extends a bit past the exact points we detected," without
// inventing area we have no evidence for.
const BUFFER_KM = 0.3
// A hull needs 3+ non-collinear points to enclose any area at all; 1-2
// detections are already visible as their own marker(s) on the map, so
// there's nothing an estimated polygon would add for them.
const MIN_CLUSTER_SIZE = 3

/**
 * Connected-components clustering: two points are in the same cluster
 * if there's a chain of detections each within CLUSTER_THRESHOLD_KM of
 * the next (not necessarily directly close to every other point in the
 * cluster) -- this is what lets a cluster trace the actual shape of a
 * spreading fire front instead of only catching tight little knots of
 * points. Plain BFS over an implicit distance graph; fine at the scale
 * a single zone/viewport ever has (hundreds of points, not tens of
 * thousands -- see FireMap's own MAX_RENDERED_MARKERS cap upstream of
 * this).
 */
export function clusterPoints(points, thresholdKm = CLUSTER_THRESHOLD_KM) {
  const n = points.length
  const visited = new Array(n).fill(false)
  const clusters = []

  for (let i = 0; i < n; i++) {
    if (visited[i]) continue
    const queue = [i]
    visited[i] = true
    const cluster = []
    while (queue.length > 0) {
      const idx = queue.pop()
      cluster.push(idx)
      for (let j = 0; j < n; j++) {
        if (visited[j]) continue
        const d = distanceKm(points[idx].lat, points[idx].lon, points[j].lat, points[j].lon)
        if (d <= thresholdKm) {
          visited[j] = true
          queue.push(j)
        }
      }
    }
    clusters.push(cluster.map((idx) => points[idx]))
  }
  return clusters
}

/**
 * Andrew's monotone chain convex hull. Works in plain (lat, lon) treated
 * as (y, x) Cartesian -- close enough at the scale of a single fire
 * cluster (a few km across at most) that real-world projection
 * distortion is negligible; not appropriate at continental scale, but
 * this never runs on anything that large.
 */
export function convexHull(points) {
  if (points.length < 3) return points.slice()
  const pts = [...points].sort((a, b) => a.lon - b.lon || a.lat - b.lat)

  const cross = (o, a, b) => (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon)

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
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

/**
 * Pushes each hull vertex outward, away from the cluster's centroid, by
 * roughly bufferKm. Not a true geometric buffer (which would need to
 * offset each EDGE and re-clip, not just move vertices) -- this
 * approximation is visually indistinguishable from a real buffer for
 * the small, roughly-convex shapes a fire-detection cluster produces,
 * and is a fraction of the code.
 */
function bufferHull(hull, bufferKm) {
  if (hull.length < 3) return hull
  const centroid = hull.reduce(
    (acc, p) => ({ lat: acc.lat + p.lat / hull.length, lon: acc.lon + p.lon / hull.length }),
    { lat: 0, lon: 0 }
  )
  return hull.map((p) => {
    const d = distanceKm(centroid.lat, centroid.lon, p.lat, p.lon)
    if (d === 0) return p
    // ~111km per degree of latitude; longitude degrees shrink with
    // cos(latitude) -- close enough at this scale, same approximation
    // already used elsewhere in this codebase for small-area math.
    const scale = (d + bufferKm) / d
    return {
      lat: centroid.lat + (p.lat - centroid.lat) * scale,
      lon: centroid.lon + (p.lon - centroid.lon) * scale,
    }
  })
}

/**
 * Main entry point: hotspot GeoJSON features in, estimated-perimeter
 * GeoJSON Polygon features out. Each output feature carries
 * properties.estimated = true and properties.pointCount so the map/
 * popup can label it clearly as "estimado, no oficial" and show how
 * many detections it's based on.
 */
export function computeEstimatedPerimeters(hotspotFeatures, opts = {}) {
  const thresholdKm = opts.thresholdKm ?? CLUSTER_THRESHOLD_KM
  const bufferKm = opts.bufferKm ?? BUFFER_KM
  const minClusterSize = opts.minClusterSize ?? MIN_CLUSTER_SIZE

  const points = hotspotFeatures.map((f) => {
    const [lon, lat] = f.geometry.coordinates
    return { lat, lon, feature: f }
  })

  const clusters = clusterPoints(points, thresholdKm)
  const polygons = []

  for (const cluster of clusters) {
    if (cluster.length < minClusterSize) continue
    const hull = convexHull(cluster)
    if (hull.length < 3) continue
    const buffered = bufferHull(hull, bufferKm)
    const ring = buffered.map((p) => [p.lon, p.lat])
    ring.push(ring[0]) // GeoJSON polygons must close (first point === last point)

    const maxFrp = Math.max(...cluster.map((p) => p.feature.properties?.frp || 0))
    polygons.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: { estimated: true, pointCount: cluster.length, maxFrp },
    })
  }

  return polygons
}
