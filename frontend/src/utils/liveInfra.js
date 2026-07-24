/**
 * liveInfra.js
 * Fetches critical infrastructure for a zone on demand, via the existing
 * /api/overpass Vercel function (same one used previously for the
 * moveend-driven fetch). Used as a FALLBACK: if the bundled
 * infrastructure.geojson (built incrementally by fetch_infrastructure.py's
 * world-tile crawl, ~1 tile/run) already covers the selected zone, that
 * data is used directly and this is never called — it's only for zones
 * outside that bundled coverage (which, until the crawl completes its
 * first full pass, is most of the world).
 *
 * Caching: results are cached in sessionStorage, keyed by a rounded bbox, so
 * re-opening the same zone in the same browser tab/session is instant and
 * doesn't re-hit Overpass. This is a CLIENT-side cache only (per browser),
 * not shared across responders/devices — see the note in the chat response
 * for what a true server-side shared cache would need.
 */

const OVERPASS_URL = "/api/overpass"
const CACHE_PREFIX = "fw_infra_cache_"
const INDEX_KEY = CACHE_PREFIX + "index"
const MAX_CACHED_ZONES = 8 // oldest evicted first, keeps sessionStorage small

const INFRA_TYPES = [
  ["amenity", "hospital", "Hospital", "#FF4444"],
  ["amenity", "clinic", "Clinic", "#FF6666"],
  ["amenity", "fire_station", "Fire Station", "#FF6600"],
  ["amenity", "police", "Police Station", "#0044FF"],
  ["power", "substation", "Power Substation", "#FFAA00"],
  ["power", "plant", "Power Plant", "#FFAA00"],
  ["aeroway", "aerodrome", "Airport/Airfield", "#44AAFF"],
  ["amenity", "fuel", "Fuel Station", "#AA66FF"],
  ["man_made", "tower", "Tower", "#666666"],
  ["amenity", "school", "School (shelter)", "#22AA88"],
  ["landuse", "industrial", "Industrial Zone", "#996633"],
  ["man_made", "works", "Industrial Zone", "#996633"],
  ["landuse", "quarry", "Quarry/Landfill", "#996633"],
  ["landuse", "landfill", "Quarry/Landfill", "#996633"],
  ["place", "city", "Urban Area", "#888888"],
  ["place", "town", "Urban Area", "#888888"],
]

function bboxKey(bbox) {
  return [bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon].map((n) => n.toFixed(2)).join(",")
}

function readIndex() {
  try { return JSON.parse(sessionStorage.getItem(INDEX_KEY) || "[]") } catch { return [] }
}
function writeIndex(idx) {
  try { sessionStorage.setItem(INDEX_KEY, JSON.stringify(idx)) } catch { /* storage unavailable */ }
}
function getCached(key) {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + key)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function setCached(key, features) {
  try {
    sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify(features))
    let idx = readIndex().filter((k) => k !== key)
    idx.push(key)
    while (idx.length > MAX_CACHED_ZONES) {
      const evicted = idx.shift()
      sessionStorage.removeItem(CACHE_PREFIX + evicted)
    }
    writeIndex(idx)
  } catch { /* storage full/unavailable — skip caching silently */ }
}

async function queryOverpass(bbox) {
  const bb = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`
  const tags = INFRA_TYPES.map(([k, v]) => `  node["${k}"="${v}"](${bb});\n  way["${k}"="${v}"](${bb});`).join("\n")
  const query = `[out:json][timeout:20];\n(\n${tags}\n);\nout center;`
  const r = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: query }),
  })
  if (!r.ok) throw new Error("HTTP " + r.status)
  const data = await r.json()
  if (!data.elements) throw new Error(data.error || "Overpass returned no data")
  return data.elements
    .map((el) => {
      const lat = el.type === "node" ? el.lat : el.center?.lat
      const lon = el.type === "node" ? el.lon : el.center?.lon
      if (!lat) return null
      const t = el.tags || {}
      const match = INFRA_TYPES.find(([k, v]) => t[k] === v)
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          name: t.name || t["name:es"] || match?.[2] || "Unknown",
          type: match?.[2] || "Other",
        },
      }
    })
    .filter(Boolean)
}

/**
 * @returns {Promise<{features: Array, fromCache: boolean}>}
 */
export async function loadZoneInfrastructure(bbox) {
  const key = bboxKey(bbox)
  const cached = getCached(key)
  if (cached) return { features: cached, fromCache: true }
  const features = await queryOverpass(bbox)
  setCached(key, features)
  return { features, fromCache: false }
}