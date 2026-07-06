/**
 * countryBoundaries.js
 * Replaces the bbox-approximation for "is this fire in country X" with an
 * actual point-in-polygon test against real country borders. A padded box
 * around a search point (e.g. Boston) always bleeds into whatever's nearby
 * (Quebec, in Boston's case) — a polygon doesn't.
 *
 * Dataset: Natural Earth 110m admin-0 boundaries (public domain), ~250KB,
 * fetched once and cached. It's a simplified/low-res boundary set, so a
 * handful of very small countries are missing — for those we fall back to
 * the old bbox approximation rather than showing nothing.
 */

const BOUNDARIES_URL = "/geo/countries.geo.json"

let cache = null
let loadingPromise = null

export async function loadCountryBoundaries() {
  if (cache) return cache
  if (!loadingPromise) {
    loadingPromise = fetch(BOUNDARIES_URL)
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status)
        return r.json()
      })
      .then((data) => { cache = data; return data })
      .catch((e) => { loadingPromise = null; throw e })
  }
  return loadingPromise
}

// Common mismatches between Photon's country names and this dataset's names.
const ALIASES = {
  "united states": "united states of america",
  "usa": "united states of america",
  "ivory coast": "ivory coast",
  "côte d'ivoire": "ivory coast",
  "cote d'ivoire": "ivory coast",
  "czechia": "czech republic",
  "bahamas": "the bahamas",
  "tanzania": "united republic of tanzania",
  "north macedonia": "macedonia",
  "republic of congo": "republic of the congo",
  "congo-brazzaville": "republic of the congo",
  "dr congo": "democratic republic of the congo",
  "congo-kinshasa": "democratic republic of the congo",
  "eswatini": "swaziland",
  "timor-leste": "east timor",
  "russian federation": "russia",
  "republic of korea": "south korea",
  "korea, south": "south korea",
  "myanmar (burma)": "myanmar",
  "burma": "myanmar",
  "uk": "united kingdom",
}

function normalize(name) {
  const n = (name || "").trim().toLowerCase()
  return ALIASES[n] || n
}

export function findCountryFeature(boundaries, countryName) {
  if (!boundaries || !countryName) return null
  const target = normalize(countryName)
  return boundaries.features.find((f) => normalize(f.properties?.name) === target) || null
}

function pointInRing(point, ring) {
  const [x, y] = point
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function pointInPolygonRings(point, rings) {
  // rings[0] is the exterior ring, any further rings are holes.
  if (!pointInRing(point, rings[0])) return false
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(point, rings[i])) return false
  }
  return true
}

/** point = [lon, lat] */
export function pointInGeometry(point, geometry) {
  if (!geometry) return false
  if (geometry.type === "Polygon") {
    return pointInPolygonRings(point, geometry.coordinates)
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((rings) => pointInPolygonRings(point, rings))
  }
  return false
}

/**
 * Filters GeoJSON point features to those actually inside the given country
 * feature's polygon. Falls back to null (caller should use bbox instead) if
 * countryFeature is null (country not found in this simplified dataset).
 */
export function filterFeaturesByCountry(features, countryFeature) {
  if (!countryFeature) return null
  return features.filter((f) => {
    if (f.geometry?.type !== "Point") return false
    return pointInGeometry(f.geometry.coordinates, countryFeature.geometry)
  })
}
