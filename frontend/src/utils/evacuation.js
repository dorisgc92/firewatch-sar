import { nearestFeatures } from "./spatial"

const HOSPITAL_TYPES = new Set(["Hospital", "Clinic"])

/**
 * Finds the nearest hospital/clinic to (lat, lon) that isn't in
 * excludeOsmIds — used both for the initial evacuation request and for
 * the reject-and-try-next-nearest cascade. Returns null if every hospital
 * within `infraFeatures` has already been excluded (i.e. everyone nearby
 * has rejected the request).
 *
 * infraFeatures is whatever infrastructure the caller currently has
 * loaded (FireMap's zoneInfrastructure: bundled world-crawl data + any
 * live per-zone Overpass fetch) — this is a real limitation worth being
 * upfront about: it only knows about hospitals within the area that's
 * actually been loaded/crawled, not a true global search.
 */
export function findNextHospital(lat, lon, infraFeatures, excludeOsmIds = []) {
  const hospitals = (infraFeatures || []).filter((f) => HOSPITAL_TYPES.has(f.properties?.type))
  if (hospitals.length === 0) return null
  const excluded = new Set(excludeOsmIds.map(String))
  const ranked = nearestFeatures(lat, lon, hospitals, hospitals.length)
  const next = ranked.find(({ feature }) => !excluded.has(String(feature.properties.osm_id)))
  if (!next) return null
  const [lon2, lat2] = next.feature.geometry.coordinates
  return {
    osmId: String(next.feature.properties.osm_id),
    name: next.feature.properties.name || "Unnamed hospital",
    lat: lat2,
    lon: lon2,
    distanceKm: next.distanceKm,
  }
}
