import { useState, useEffect } from "react"

/**
 * Population-density grid for the currently-viewed Module 2 zone.
 * Debounced the same way useLocalFWI is -- panning the map re-triggers
 * this fetch.
 */
export default function useLocalPopulation(bbox, enabled = true) {
  const [cells, setCells] = useState([])

  useEffect(() => {
    if (!enabled || !bbox) {
      setCells([])
      return
    }
    const timer = setTimeout(() => {
      fetch("/api/local-population", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          west: bbox.minLon, south: bbox.minLat, east: bbox.maxLon, north: bbox.maxLat,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          // Keep last good cells on a transient failure/empty response --
          // same fail-open philosophy as useLocalFWI, learned the hard
          // way yesterday when a single tunnel hiccup wiped the whole
          // FWI layer while panning.
          if (data.features && data.features.length > 0) setCells(data.features)
        })
        .catch(() => {})
    }, 1200)
    return () => clearTimeout(timer)
  }, [enabled, bbox?.minLon, bbox?.minLat, bbox?.maxLon, bbox?.maxLat])

  return cells
}