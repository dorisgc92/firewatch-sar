import { useState, useEffect } from "react"
import { buildVegetationFwiRegions } from "../utils/fwiVegetationRegions"
import { classifyPointsBatch } from "../utils/landCoverApi"

/**
 * Forest-only, risk-merged FWI regions -- derived from the raw local-fwi
 * grid cells by cross-referencing WorldCover vegetation classification.
 * See fwiVegetationRegions.js for the actual classify+filter+union logic.
 */
export default function useVegetationFwiRegions(fwiCells, enabled = true) {
  const [regions, setRegions] = useState([])

  useEffect(() => {
    if (!enabled || !fwiCells.length) {
      setRegions([])
      return
    }
    let cancelled = false
    buildVegetationFwiRegions(fwiCells, classifyPointsBatch)
      .then((r) => { if (!cancelled && r.length > 0) setRegions(r) })
      .catch(() => {}) // keep last good regions on a transient failure
    return () => { cancelled = true }
  }, [fwiCells])

  return regions
}