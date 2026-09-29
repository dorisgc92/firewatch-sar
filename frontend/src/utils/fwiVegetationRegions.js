import * as turf from "@turf/turf"

/**
 * Takes local FWI grid cells (each a square Feature with
 * properties.risk_class/lat/lon) and:
 *  1. Classifies each cell's center via WorldCover (reusing the same
 *     on-demand classification already used for Module 2's vegetation
 *     filter and cell-based perimeter).
 *  2. Keeps only forest cells -- explicitly not agricultural/urban/other,
 *     since fire-weather risk over cropland or a city isn't the same
 *     concern as over standing forest fuel.
 *  3. Unions same-risk-class forest cells into merged regions (stepped
 *     edges, same technique as cellPerimeter.js) instead of a flat grid
 *     of individual squares.
 */
export async function buildVegetationFwiRegions(fwiCells, classifyPoints) {
  if (!fwiCells.length) return []

  const points = fwiCells.map((f) => ({ lat: f.properties.lat, lon: f.properties.lon }))
  const classified = await classifyPoints(points)

  const forestCells = fwiCells.filter((f, i) => classified[i]?.category === "forestal")
  if (!forestCells.length) return []

  const byRisk = {}
  for (const cell of forestCells) {
    const rc = cell.properties.risk_class
    if (!byRisk[rc]) byRisk[rc] = []
    byRisk[rc].push(cell)
  }

  const regions = []
  for (const [riskClass, cells] of Object.entries(byRisk)) {
    let merged = cells[0]
    for (let i = 1; i < cells.length; i++) {
      try {
        merged = turf.union(turf.featureCollection([merged, cells[i]])) || merged
      } catch {
        // Two cells that don't share an edge (shouldn't normally happen on
        // a regular grid, but a stray classification gap could produce
        // this) -- keep the accumulated shape as-is and move on rather
        // than losing the whole region to one bad union.
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