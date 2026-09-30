import * as turf from "@turf/turf"

/**
 * Sums estimated population inside a given perimeter polygon, using the
 * population-density grid cells already fetched for the viewport (see
 * useLocalPopulation.js). Each cell's own real area (via turf.area, not
 * an assumed uniform size) times its density gives that cell's people
 * count; only cells whose center falls inside the perimeter are counted
 * -- the same "sample the center" approximation already used elsewhere
 * in this app (e.g. WorldCover point classification).
 */
export function estimatePopulationInPolygon(perimeterFeature, populationCells) {
  if (!perimeterFeature || !populationCells?.length) return 0
  let total = 0
  for (const cell of populationCells) {
    const center = turf.centroid(cell)
    if (!turf.booleanPointInPolygon(center, perimeterFeature)) continue
    const areaKm2 = turf.area(cell) / 1e6
    total += areaKm2 * (cell.properties.density || 0)
  }
  return Math.round(total)
}