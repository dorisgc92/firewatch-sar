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
  const points = []
  let lat = minLat
  while (lat < maxLat && points.length < FINE_MAX_POINTS) {
    let lon = minLon
    while (lon < maxLon && points.length < FINE_MAX_POINTS) {
      points.push({ lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 })
      lon += FINE_STEP_DEG
    }
    lat += FINE_STEP_DEG
  }
  return points
}

function fineCellPolygon(lat, lon) {
  const half = FINE_STEP_DEG / 2
  return turf.polygon([[
    [lon - half, lat - half], [lon + half, lat - half],
    [lon + half, lat + half], [lon - half, lat + half],
    [lon - half, lat - half],
  ]])
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

  const classified = await classifyPoints(finePoints)

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
    byRisk[match.risk].push(fineCellPolygon(p.lat, p.lon))
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