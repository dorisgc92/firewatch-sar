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

const PHOTON_URL = "https://photon.komoot.io/api/"
const REVERSE_URL = "https://photon.komoot.io/reverse"

function extentToBbox(extent) {
  if (!extent || extent.length < 4) return null
  const [a, b, c, d] = extent
  return {
    minLon: Math.min(a, c),
    maxLon: Math.max(a, c),
    minLat: Math.min(b, d),
    maxLat: Math.max(b, d),
  }
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
 * Resolves a zone query into center + nested bboxes (zone/state/country).
 * Never throws for missing state/country bbox — falls back to a padded
 * box around the zone's own center so the UI always has something to filter with.
 */
export async function geocodeZone(query) {
  const feature = await photonSearch(query)
  if (!feature) {
    throw new Error(
      "No se encontró esa zona. Intenta con un nombre más específico, por ejemplo: 'Zapopan, Jalisco, México'."
    )
  }

  const [lon, lat] = feature.geometry.coordinates
  const props = feature.properties || {}
  const name = props.name || query
  const city = props.city || props.name || query
  const state = props.state || null
  const country = props.country || null

  const zoneBbox = extentToBbox(props.extent) || paddedBbox(lat, lon, 0.35)

  let stateBbox = null
  if (state) {
    try {
      const stateFeature = await photonSearch(state + (country ? ", " + country : ""))
      stateBbox = extentToBbox(stateFeature?.properties?.extent)
    } catch { /* fall through to padded box below */ }
  }
  if (!stateBbox) stateBbox = paddedBbox(lat, lon, 1.5)

  let countryBbox = null
  if (country) {
    try {
      const countryFeature = await photonSearch(country)
      countryBbox = extentToBbox(countryFeature?.properties?.extent)
    } catch { /* fall through to padded box below */ }
  }
  if (!countryBbox) countryBbox = paddedBbox(lat, lon, 8)

  return {
    query,
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

// Small in-memory cache so we don't hammer the reverse-geocoding API
// when the same fire point gets re-rendered (e.g. re-opening a popup).
const reverseCache = new Map()

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
