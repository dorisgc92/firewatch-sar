import * as turf from "@turf/turf"

// Fine grid for tracing the real forest boundary shape -- same spirit as
// cellPerimeter.js's 500m cells, but here it needs to cover the WHOLE
// visible viewport (not just a ring around detection points), so the
// step is a bit coarser (~1.1km) to keep the point count from exploding
// over a city-wide view.
const FINE_STEP_DEG = 0.01
const FINE_MAX_POINTS = 500 // safety cap on a huge/zoomed-out viewport

function buildFineGrid(bbox) {
  const { minLon, minLat, maxLon, maxLat } = bbox
  const rows = Math.min(Math.ceil((maxLat - minLat) / FINE_STEP_DEG), 30)
  const cols = Math.min(Math.ceil((maxLon - minLon) / FINE_STEP_DEG), 30)
  const points = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (points.length >= FINE_MAX_POINTS) return points
      points.push({
        row: r, col: c,
        lat: minLat + (r + 0.5) * FINE_STEP_DEG,
        lon: minLon + (c + 0.5) * FINE_STEP_DEG,
      })
    }
  }
  return points
}

function fineCellPolygon(row, col, bbox) {
  const { minLon, minLat } = bbox
  // Computed directly from origin + index*step (never by repeatedly
  // adding step in a loop) -- two adjacent cells' shared edge is the
  // exact same expression evaluated the same way, so floating-point
  // rounding can never make them disagree. Same technique already
  // proven in cellPerimeter.js; the earlier accumulation-based version
  // let adjacent cells drift apart by fractions of a degree, which was
  // enough for Turf to treat them as non-touching and never actually
  // dissolve the grid lines between them.
  const lat0 = minLat + row * FINE_STEP_DEG
  const lon0 = minLon + col * FINE_STEP_DEG
  const lat1 = lat0 + FINE_STEP_DEG
  const lon1 = lon0 + FINE_STEP_DEG
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

  const finePoints = buildFineGrid(bbox)
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
    byRisk[match.risk].push(fineCellPolygon(p.row, p.col, bbox))
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