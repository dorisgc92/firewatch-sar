import * as turf from "@turf/turf"

// Fine grid for tracing the real forest boundary shape -- same spirit as
// cellPerimeter.js's 500m cells, but here it needs to cover the WHOLE
// visible viewport (not just a ring around detection points), so the
// step is a bit coarser (~1.1km) to keep the point count from exploding
// over a city-wide view.
const FINE_TARGET_CELLS_PER_SIDE = 22 // aim for a ~22x22 grid regardless of viewport size
const FINE_MIN_STEP_DEG = 0.003  // ~330m floor -- finer than this is well past
                                   // WorldCover's own 10m pixels' practical value
                                   // for a live, per-pan classification pass
const FINE_MAX_STEP_DEG = 0.05   // ~5.5km ceiling when zoomed way out
const FINE_MAX_POINTS = 500      // hard safety cap regardless of target

function buildFineGrid(bbox) {
  const { minLon, minLat, maxLon, maxLat } = bbox
  const span = Math.max(maxLat - minLat, maxLon - minLon, 0.001)
  const step = Math.max(FINE_MIN_STEP_DEG, Math.min(FINE_MAX_STEP_DEG, span / FINE_TARGET_CELLS_PER_SIDE))
  const rows = Math.min(Math.ceil((maxLat - minLat) / step), 25)
  const cols = Math.min(Math.ceil((maxLon - minLon) / step), 25)
  const points = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (points.length >= FINE_MAX_POINTS) return { points, step }
      points.push({
        row: r, col: c,
        lat: minLat + (r + 0.5) * step,
        lon: minLon + (c + 0.5) * step,
      })
    }
  }
  return { points, step }
}

function fineCellPolygon(row, col, bbox, step) {
  const { minLon, minLat } = bbox
  const lat0 = minLat + row * step
  const lon0 = minLon + col * step
  const lat1 = lat0 + step
  const lon1 = lon0 + step
  return turf.polygon([[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]])
}

/**
 * Two-resolution design: SHAPE comes from a fine (~1.1km) WorldCover
 * vegetation grid -- traces the real forest boundary, same technique as
 * cellPerimeter.js. COLOR comes from the coarse (~5-15km) local-FWI grid
 * cells already computed server-side -- weather doesn't vary at fine
 * resolution, so borrowing more detail there than the data actually has
 * would be dishonest, not just wasteful. Each fine forest cell is
 * assigned the risk_class of whichever coarse FWI cell it falls inside,
 * then same-risk fine cells are unioned into one region per class.
 */
export async function buildVegetationFwiRegions(bbox, coarseFwiCells, classifyPoints) {
  if (!bbox || !coarseFwiCells.length) return []

  const { points: finePoints, step: fineStep } = buildFineGrid(bbox)
  if (!finePoints.length) return []

  const classified = await classifyPoints(finePoints.map((p) => ({ lat: p.lat, lon: p.lon })))

  const coarsePolys = coarseFwiCells.map((f) => ({
    poly: turf.feature(f.geometry),
    risk: f.properties.risk_class,
  }))

  const byRisk = {}
  finePoints.forEach((p, i) => {
    if (classified[i]?.category !== "forestal") return
    const pt = turf.point([p.lon, p.lat])
    const match = coarsePolys.find((c) => turf.booleanPointInPolygon(pt, c.poly))
    if (!match) return
    if (!byRisk[match.risk]) byRisk[match.risk] = []
    byRisk[match.risk].push(fineCellPolygon(p.row, p.col, bbox, fineStep))
  })

  const regions = []
  for (const [riskClass, cells] of Object.entries(byRisk)) {
    let merged = cells[0]
    for (let i = 1; i < cells.length; i++) {
      try {
        merged = turf.union(turf.featureCollection([merged, cells[i]])) || merged
      } catch {
        // A stray non-adjacent cell shouldn't lose the whole region --
        // keep the accumulated shape and move on.
      }
    }
    if (!merged) continue
    regions.push({
      type: "Feature",
      geometry: merged.geometry,
      properties: { risk_class: riskClass, cellCount: cells.length },
    })
  }
  return regions
}