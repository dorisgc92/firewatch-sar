/**
 * geocode.js
 * Resolves a free-text place name ("Zapopan, Jalisco, México") into:
 *  - a center point (for map view)
 *  - a bbox for the zone itself
 *  - a bbox for its state/province
 *  - a bbox for its country
 *
 * This lets the app compute "fires in this zone / state / country"
 * without ever asking the user for coordinates. Uses the same
 * Photon (komoot) API already used for the search bar — no new
 * paid service, no API key.
 */

import { reverseCountryLookup } from "./countryBoundaries"

const PHOTON_URL = "https://photon.komoot.io/api/"
const REVERSE_URL = "https://photon.komoot.io/reverse"

// Some countries (USA with Alaska/Hawaii/Guam, Russia, France with overseas
// territories...) have a Photon "extent" so spread out that a naive min/max
// bounding box ends up covering most of the globe's longitude range — which
// then makes fires in, say, Indonesia count as "in the United States". We
// reject any extent wider than maxSpanDeg and fall back to a modest padded
// box around the searched point instead. That box won't cover Guam, but it
// also won't falsely claim Jakarta is Boston — a much safer failure mode.
function extentToBbox(extent, maxSpanDeg = 60) {
  if (!extent || extent.length < 4) return null
  const [a, b, c, d] = extent
  const minLon = Math.min(a, c)
  const maxLon = Math.max(a, c)
  const minLat = Math.min(b, d)
  const maxLat = Math.max(b, d)
  if (maxLon - minLon > maxSpanDeg || maxLat - minLat > maxSpanDeg) return null
  return { minLon, maxLon, minLat, maxLat }
}

function paddedBbox(lat, lon, degrees) {
  return {
    minLon: lon - degrees,
    maxLon: lon + degrees,
    minLat: lat - degrees,
    maxLat: lat + degrees,
  }
}

async function photonSearch(query) {
  const r = await fetch(PHOTON_URL + "?q=" + encodeURIComponent(query) + "&limit=1")
  if (!r.ok) throw new Error("HTTP " + r.status)
  const data = await r.json()
  return data.features?.[0] || null
}

/**
 * Builds a full zoneInfo (center + zone/state/country bboxes) from an
 * already-fetched Photon feature — used by the navbar search so picking a
 * new place re-scopes the whole app (fires, infra, stats), not just the map view.
 */
export async function zoneInfoFromPhotonFeature(feature, fallbackQuery) {
  const [lon, lat] = feature.geometry.coordinates
  const props = feature.properties || {}
  const name = props.name || props.city || fallbackQuery || `${lat.toFixed(2)}, ${lon.toFixed(2)}`
  const city = props.city || props.name || name
  const state = props.state || null
  const country = props.country || null

  const zoneBbox = extentToBbox(props.extent, 8) || paddedBbox(lat, lon, 0.35)

  let stateBbox = null
  if (state) {
    try {
      const stateFeature = await photonSearch(state + (country ? ", " + country : ""))
      stateBbox = extentToBbox(stateFeature?.properties?.extent, 25)
    } catch { /* fall through to padded box below */ }
  }
  if (!stateBbox) stateBbox = paddedBbox(lat, lon, 1.5)

  let countryBbox = null
  if (country) {
    try {
      const countryFeature = await photonSearch(country)
      countryBbox = extentToBbox(countryFeature?.properties?.extent, 60)
    } catch { /* fall through to padded box below */ }
  }
  // Countries with far-flung territories (Alaska/Hawaii/Guam for the US,
  // Siberia for Russia, overseas départements for France...) get rejected by
  // the span cap above and land here — a padded box around the searched
  // point instead. This under-covers those countries' remote territories,
  // but that's a far safer failure mode than silently matching fires on the
  // other side of the planet.
  if (!countryBbox) countryBbox = paddedBbox(lat, lon, 15)

  return {
    query: fallbackQuery || name,
    name,
    city,
    state,
    country,
    center: [lat, lon],
    zoneBbox,
    stateBbox,
    countryBbox,
  }
}

export async function geocodeZone(query) {
  const feature = await photonSearch(query)
  if (!feature) {
    throw new Error(
      "No se encontró esa zona. Intenta con un nombre más específico, por ejemplo: 'Zapopan, Jalisco, México'."
    )
  }
  return zoneInfoFromPhotonFeature(feature, query)
}

/**
 * Last-resort zoneInfo builder for points where Photon's reverse-geocoding
 * finds nothing nearby — which is common for wildfires, since they're
 * mostly in remote/unpopulated areas by definition (deep forest, open
 * range). Uses our own bundled country polygons (no external API, works
 * anywhere) to at least get the country right; state/zone become plain
 * padded boxes around the point since there's no place name to search for.
 */
export async function zoneInfoFromCoordinates(lat, lon) {
  let country = null
  try {
    const countryFeature = await reverseCountryLookup(lat, lon)
    country = countryFeature?.properties?.name || null
  } catch { /* proceed without a country label */ }

  const name = country
    ? `${lat.toFixed(2)}, ${lon.toFixed(2)} — ${country}`
    : `${lat.toFixed(2)}, ${lon.toFixed(2)}`

  return {
    query: name,
    name,
    city: name,
    state: null,
    country,
    center: [lat, lon],
    zoneBbox: paddedBbox(lat, lon, 0.35),
    stateBbox: paddedBbox(lat, lon, 1.5),
    countryBbox: paddedBbox(lat, lon, 15),
  }
}

// Small in-memory cache so we don't hammer the reverse-geocoding API
// when the same fire point gets re-rendered (e.g. re-opening a popup).
const reverseCache = new Map()
const reverseFeatureCache = new Map()

/**
 * Reverse-geocodes a point and returns the raw Photon feature (with
 * properties.name/city/state/country/extent) — used to rebuild a full
 * zoneInfo from a clicked fire point, the same way a navbar search does.
 * Returns null on failure or if nothing is found nearby (e.g. open ocean).
 */
export async function reverseGeocodeFeature(lat, lon) {
  const key = lat.toFixed(3) + "," + lon.toFixed(3)
  if (reverseFeatureCache.has(key)) return reverseFeatureCache.get(key)
  try {
    const r = await fetch(`${REVERSE_URL}?lon=${lon}&lat=${lat}`)
    if (!r.ok) throw new Error("HTTP " + r.status)
    const data = await r.json()
    const feature = data.features?.[0] || null
    reverseFeatureCache.set(key, feature)
    return feature
  } catch {
    reverseFeatureCache.set(key, null)
    return null
  }
}

/**
 * Best-effort reverse geocode of a fire detection point to a human-readable
 * place name ("Bosque La Primavera", "Talpa de Allende"), used to label
 * fire points on the map instead of raw coordinates. Returns null on failure —
 * callers should fall back to showing lat/lon.
 */
export async function reverseGeocodePlace(lat, lon) {
  const key = lat.toFixed(3) + "," + lon.toFixed(3)
  if (reverseCache.has(key)) return reverseCache.get(key)
  try {
    const r = await fetch(`${REVERSE_URL}?lon=${lon}&lat=${lat}`)
    if (!r.ok) throw new Error("HTTP " + r.status)
    const data = await r.json()
    const props = data.features?.[0]?.properties
    const place = props
      ? [props.name, props.city, props.state].filter(Boolean).join(", ")
      : null
    reverseCache.set(key, place)
    return place
  } catch {
    reverseCache.set(key, null)
    return null
  }
}
