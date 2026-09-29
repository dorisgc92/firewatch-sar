import { useState, useEffect } from "react"
import { buildVegetationFwiRegions } from "../utils/fwiVegetationRegions"
import { classifyPointsBatch } from "../utils/landCoverApi"

/**
 * Forest-shaped, risk-colored regions -- see fwiVegetationRegions.js for
 * the two-resolution logic (fine vegetation shape, coarse weather color).
 * Debounced since panning the map re-triggers both the coarse FWI fetch
 * and this fine classification pass.
 */
export default function useVegetationFwiRegions(bbox, coarseFwiCells, enabled = true) {
  const [regions, setRegions] = useState([])

  useEffect(() => {
    if (!enabled || !bbox || !coarseFwiCells.length) {
      setRegions([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      buildVegetationFwiRegions(bbox, coarseFwiCells, classifyPointsBatch)
        .then((r) => { if (!cancelled && r.length > 0) setRegions(r) })
        .catch(() => {}) // keep last good regions on a transient failure
    }, 600)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [bbox?.minLon, bbox?.minLat, bbox?.maxLon, bbox?.maxLat, coarseFwiCells])

  return regions
}