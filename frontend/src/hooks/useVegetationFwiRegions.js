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
        .then((r) => {
          console.log("[vegetation-fwi] regions built:", r.length)
          if (!cancelled && r.length > 0) setRegions(r)
        })
        .catch((e) => console.error("[vegetation-fwi] failed:", e))
    }, 600)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [bbox?.minLon, bbox?.minLat, bbox?.maxLon, bbox?.maxLat, coarseFwiCells])

  return regions
}