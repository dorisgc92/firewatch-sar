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

// Photon is a free public API with no SLA — without a timeout, a slow
// response can hang zone resolution (and the loading overlay) indefinitely.
// 6s is generous for a single lookup but still bounded.
const PHOTON_TIMEOUT_MS = 6000

async function photonSearchOnce(query, limit = 1) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PHOTON_TIMEOUT_MS)
  try {
    const r = await fetch(PHOTON_URL + "?q=" + encodeURIComponent(query) + "&limit=" + limit, { signal: controller.signal })
    if (!r.ok) return []
    const data = await r.json()
    return data.features || []
  } catch {
    // Covers both a network failure and our own timeout abort (which
    // otherwise surfaces as a raw, user-unfriendly "signal is aborted
    // without reason" DOMException) — either way, the caller should just
    // treat this the same as "nothing found", not crash the search flow.
    return []
  } finally {
    clearTimeout(timeout)
  }
}

// Photon (run by Komoot, free, no SLA) has genuine intermittent outages —
// one quick retry means a single transient hiccup doesn't block someone
// from ever entering the app over a place name that would resolve fine a
// few seconds later.
async function photonSearch(query) {
  const first = (await photonSearchOnce(query, 1))[0]
  if (first) return first
  await new Promise((resolve) => setTimeout(resolve, 1500))
  return (await photonSearchOnce(query, 1))[0] || null
}

// How long to wait after the user stops typing before firing a Photon
// request. Without this, a 10-letter place name fires ~8 requests (one per
// keystroke) — Photon's own terms say extensive/rapid usage gets throttled,
// and hammering it that hard is exactly what can make the search bar (and
// any of Photon's other callers, since it's one shared IP-level limit)
// silently stop returning anything for a while.
export const SEARCH_DEBOUNCE_MS = 350

/**
 * Multi-result place search for the navbar autocomplete dropdown — same
 * timeout + one-retry resilience as photonSearch/zoneInfoFromPhotonFeature,
 * just returns the raw candidate list instead of picking the top result.
 */
export async function searchPlaces(query, limit = 5) {
  const first = await photonSearchOnce(query, limit)
  if (first.length > 0) return first
  await new Promise((resolve) => setTimeout(resolve, 1500))
  return photonSearchOnce(query, limit)
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

  // State and country lookups are independent of each other — run them in
  // parallel instead of one-after-the-other. This alone roughly halves the
  // wait time for zone resolution (previously ~2 sequential round-trips).
  const [stateFeature, countryFeature] = await Promise.all([
    state ? photonSearch(state + (country ? ", " + country : "")).catch(() => null) : Promise.resolve(null),
    country ? photonSearch(country).catch(() => null) : Promise.resolve(null),
  ])

  const stateBbox = extentToBbox(stateFeature?.properties?.extent, 25) || paddedBbox(lat, lon, 1.5)
  // Countries with far-flung territories (Alaska/Hawaii/Guam for the US,
  // Siberia for Russia, overseas départements for France...) get rejected by
  // the span cap above and land here — a padded box around the searched
  // point instead. This under-covers those countries' remote territories,
  // but that's a far safer failure mode than silently matching fires on the
  // other side of the planet.
  const countryBbox = extentToBbox(countryFeature?.properties?.extent, 60) || paddedBbox(lat, lon, 15)

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
    // No hardcoded message here on purpose — StartScreen's catch block
    // falls back to the translated t("zoneNotFound") whenever err.message
    // is empty, so this works correctly in all 6 supported languages
    // instead of always showing Spanish regardless of the app's language.
    throw new Error("")
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
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PHOTON_TIMEOUT_MS)
  try {
    const r = await fetch(`${REVERSE_URL}?lon=${lon}&lat=${lat}`, { signal: controller.signal })
    if (!r.ok) throw new Error("HTTP " + r.status)
    const data = await r.json()
    const feature = data.features?.[0] || null
    reverseFeatureCache.set(key, feature)
    return feature
  } catch {
    reverseFeatureCache.set(key, null)
    return null
  } finally {
    clearTimeout(timeout)
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
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PHOTON_TIMEOUT_MS)
  try {
    const r = await fetch(`${REVERSE_URL}?lon=${lon}&lat=${lat}`, { signal: controller.signal })
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
  } finally {
    clearTimeout(timeout)
  }
}