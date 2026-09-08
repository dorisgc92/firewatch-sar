/**
 * cellPerimeter.js
 * ================
 * Alternative to fireClusters.js's convex-hull perimeter: instead of a
 * smooth hull around detection points, snaps each detection to a fixed
 * 500m grid, expands to neighboring cells (2-ring, 5x5 block) filtered
 * to vegetation-only via the existing WorldCover classification, and
 * unions the resulting squares. Produces a stepped-edge polygon that
 * follows real land cover instead of an abstract geometric hull.
 *
 * Reuses fireClusters.js's clusterPoints() for grouping -- this file
 * only replaces the hull-drawing step, not the clustering step.
 */

import * as turf from "@turf/turf"
import { clusterPoints } from "./fireClusters"

const CELL_SIZE_METERS = 500
const RING_COUNT = 2
const METERS_PER_DEGREE_LAT = 111320

function metersToDegreesLon(meters, atLatitude) {
  return meters / (METERS_PER_DEGREE_LAT * Math.cos((atLatitude * Math.PI) / 180))
}
function metersToDegreesLat(meters) {
  return meters / METERS_PER_DEGREE_LAT
}

function snapToCell(lat, lon, origin) {
  const dLat = metersToDegreesLat(CELL_SIZE_METERS)
  const dLon = metersToDegreesLon(CELL_SIZE_METERS, origin.lat)
  return { row: Math.floor((lat - origin.lat) / dLat), col: Math.floor((lon - origin.lon) / dLon) }
}

function cellCenter(row, col, origin) {
  const dLat = metersToDegreesLat(CELL_SIZE_METERS)
  const dLon = metersToDegreesLon(CELL_SIZE_METERS, origin.lat)
  return { lat: origin.lat + (row + 0.5) * dLat, lon: origin.lon + (col + 0.5) * dLon }
}

function cellToPolygon(row, col, origin) {
  const dLat = metersToDegreesLat(CELL_SIZE_METERS)
  const dLon = metersToDegreesLon(CELL_SIZE_METERS, origin.lat)
  const lat0 = origin.lat + row * dLat, lon0 = origin.lon + col * dLon
  const lat1 = lat0 + dLat, lon1 = lon0 + dLon
  return turf.polygon([[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]])
}

function candidateCellsForPoint(lat, lon, origin) {
  const { row: cRow, col: cCol } = snapToCell(lat, lon, origin)
  const cells = []
  for (let dr = -RING_COUNT; dr <= RING_COUNT; dr++) {
    for (let dc = -RING_COUNT; dc <= RING_COUNT; dc++) {
      cells.push({ key: `${cRow + dr}_${cCol + dc}`, row: cRow + dr, col: cCol + dc })
    }
  }
  return cells
}

function unionCells(cells, origin) {
  if (!cells.length) return null
  let merged = cellToPolygon(cells[0].row, cells[0].col, origin)
  for (let i = 1; i < cells.length; i++) {
    merged = turf.union(turf.featureCollection([merged, cellToPolygon(cells[i].row, cells[i].col, origin)]))
  }
  return merged
}

export async function computeEstimatedPerimetersFromCells(hotspotFeatures, classifyPoints, opts = {}) {
  const thresholdKm = opts.thresholdKm ?? 2

  const points = hotspotFeatures.map((f) => {
    const [lon, lat] = f.geometry.coordinates
    return { lat, lon, feature: f }
  })
  const clusters = clusterPoints(points, thresholdKm)

  const lats = points.map((p) => p.lat)
  const lons = points.map((p) => p.lon)
  const marginDeg = metersToDegreesLat(RING_COUNT * CELL_SIZE_METERS * 2)
  const origin = { lat: Math.min(...lats) - marginDeg, lon: Math.min(...lons) - marginDeg }

  const candidateMap = new Map()
  const clusterCandidateKeys = clusters.map((cluster) => {
    const keys = new Set()
    for (const p of cluster) {
      for (const cell of candidateCellsForPoint(p.lat, p.lon, origin)) {
        candidateMap.set(cell.key, cell)
        keys.add(cell.key)
      }
    }
    return keys
  })
  const candidates = Array.from(candidateMap.values())
  const candidatePoints = candidates.map((c) => cellCenter(c.row, c.col, origin))
  const classified = await classifyPoints(candidatePoints)

  const vegetationKeys = new Set()
  candidates.forEach((c, i) => {
    const category = classified[i]?.category
    if (category === "forestal" || category === "agricola" || category === "vegetacion") {
      vegetationKeys.add(c.key)
    }
  })

  const results = []
  clusters.forEach((cluster, i) => {
    const cellsForCluster = candidates.filter(
      (c) => clusterCandidateKeys[i].has(c.key) && vegetationKeys.has(c.key)
    )
    const polygon = unionCells(cellsForCluster, origin)
    if (!polygon) return
    results.push({
      type: "Feature",
      geometry: polygon.geometry,
      properties: { estimated: true, cellBased: true, pointCount: cluster.length },
    })
  })
  return results
}