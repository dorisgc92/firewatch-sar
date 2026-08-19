import { useEffect, useMemo, useState } from "react"
import { filterFeaturesByBbox } from "../utils/spatial"
import { loadZoneInfrastructure } from "../utils/liveInfra"

/**
 * Bundled infrastructure.geojson grows incrementally from
 * fetch_infrastructure.py's world-tile crawl (~1 tile/run) — most of the
 * world isn't covered yet. If the selected zone already falls inside
 * crawled coverage, use it (instant, no network call). Otherwise fetch
 * live from Overpass for this zone specifically (see utils/liveInfra.js,
 * cached per browser session).
 *
 * This used to live entirely inside FireMap.jsx (only feeding the map's
 * own infrastructure layer). Lifted out here so the EOC assignment panel
 * and the responder request inbox see the exact same zone-scoped,
 * distance-sane candidate pool the map does, instead of the raw,
 * unfiltered GLOBAL bundled dataset — which is what was letting
 * "nearest fire station" resolve to whatever tile happened to be crawled
 * anywhere on Earth (e.g. Easter Island) when the actual zone (e.g.
 * Guadalajara) hadn't been crawled yet.
 */
export default function useZoneInfrastructure(layers, zoneInfo) {
  const [liveInfra, setLiveInfra] = useState({ features: [], loading: false, error: null, zoneKey: null })

  const bundledZoneInfrastructure = useMemo(() => {
    const feats = layers.infrastructure?.data?.features
    if (!feats || !zoneInfo?.zoneBbox) return []
    return filterFeaturesByBbox(feats, zoneInfo.zoneBbox)
  }, [layers.infrastructure?.data, zoneInfo])

  useEffect(() => {
    if (!zoneInfo?.zoneBbox) return
    if (bundledZoneInfrastructure.length > 0) {
      // Already covered by the bundled dataset — no live fetch needed.
      setLiveInfra({ features: [], loading: false, error: null, zoneKey: zoneInfo.name })
      return
    }
    let cancelled = false
    setLiveInfra({ features: [], loading: true, error: null, zoneKey: zoneInfo.name })
    loadZoneInfrastructure(zoneInfo.zoneBbox)
      .then(({ features }) => {
        if (!cancelled) setLiveInfra({ features, loading: false, error: null, zoneKey: zoneInfo.name })
      })
      .catch((e) => {
        if (!cancelled) setLiveInfra({ features: [], loading: false, error: e.message, zoneKey: zoneInfo.name })
      })
    return () => { cancelled = true }
  }, [zoneInfo?.name, zoneInfo?.zoneBbox, bundledZoneInfrastructure.length])

  const features = bundledZoneInfrastructure.length > 0 ? bundledZoneInfrastructure : liveInfra.features

  return { features, loading: liveInfra.loading, error: liveInfra.error }
}
