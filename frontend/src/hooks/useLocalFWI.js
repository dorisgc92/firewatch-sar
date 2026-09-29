import { useState, useEffect } from "react"

/**
 * Fine-grained (~11km) FWI grid for the currently-viewed zone, fetched
 * on-demand -- the local counterpart to the static, coarse (10-degree,
 * ~1000km) global fwi_grid.geojson layer. Debounced the same way
 * useZoneLandCover is, since panning/zooming while exploring Module 1
 * can fire several zone changes in quick succession.
 */
export default function useLocalFWI(bbox, zoom, enabled = true) {
  const [cells, setCells] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !bbox) {
      setCells([])
      return
    }
    const timer = setTimeout(() => {
      setLoading(true)
      fetch("/api/local-fwi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          west: bbox.minLon, south: bbox.minLat, east: bbox.maxLon, north: bbox.maxLat, zoom,
        }),
      })
        .then((r) => r.json())
        .then((data) => setCells(data.features || []))
        .catch(() => setCells([])) // fail open -- caller falls back to the global point layer
        .finally(() => setLoading(false))
    }, 400)
    return () => clearTimeout(timer)
  }, [enabled, bbox?.minLon, bbox?.minLat, bbox?.maxLon, bbox?.maxLat, zoom])

  return { cells, loading }
}