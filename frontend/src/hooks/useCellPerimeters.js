import { useState, useEffect } from "react"
import { computeEstimatedPerimetersFromCells } from "../utils/cellPerimeter"
import { classifyPointsBatch } from "../utils/landCoverApi"

/**
 * Async counterpart to fireClusters.js's synchronous computeEstimatedPerimeters.
 * FireMap.jsx keeps computing the hull-based perimeters as a fail-open
 * fallback (via useMemo, unchanged) and prefers these once they're
 * ready -- see the "fail open" comment in landCoverApi.js.
 */
export default function useCellPerimeters(hotspotFeatures, enabled = true) {
  const [perimeters, setPerimeters] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || hotspotFeatures.length === 0) {
      setPerimeters([])
      return
    }
    const timer = setTimeout(() => {
      setLoading(true)
      computeEstimatedPerimetersFromCells(hotspotFeatures, classifyPointsBatch)
        .then(setPerimeters)
        .catch(() => setPerimeters([])) // fail open -- caller falls back to hull version
        .finally(() => setLoading(false))
    }, 400) // same debounce window as useZoneLandCover, for the same reason
    return () => clearTimeout(timer)
  }, [enabled, hotspotFeatures])

  return { perimeters, loading }
}