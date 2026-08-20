export const config = { maxDuration: 20 }

// Primary source: Doris's own machine, running remote_server/ behind a
// Cloudflare Tunnel (see remote_server/README.md). Set in Vercel ->
// Settings -> Environment Variables. If this is unset (or the machine is
// unreachable), this proxy falls back to a direct Overpass query below
// instead of failing outright — the app should degrade gracefully if
// that PC is ever off, not break.
const INFRA_API_URL = process.env.INFRA_API_URL

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
]

// Same category list liveInfra.js used to query client-side — kept here
// now that the fallback query happens server-side instead.
const INFRA_TYPES = [
  ["amenity", "hospital"], ["amenity", "clinic"], ["amenity", "fire_station"],
  ["amenity", "police"], ["power", "substation"], ["power", "plant"],
  ["aeroway", "aerodrome"], ["amenity", "fuel"], ["man_made", "tower"],
  ["amenity", "school"], ["landuse", "industrial"], ["man_made", "works"],
]

const TYPE_LABELS = {
  "hospital": "Hospital", "clinic": "Clinic", "fire_station": "Fire Station",
  "police": "Police Station", "substation": "Power Substation", "plant": "Power Plant",
  "aerodrome": "Airport/Airfield", "fuel": "Fuel Station", "tower": "Tower",
  "school": "School (shelter)", "industrial": "Industrial Zone", "works": "Industrial Zone",
}

async function fetchFromRemoteServer(bbox) {
  if (!INFRA_API_URL) return null
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    const r = await fetch(`${INFRA_API_URL}/infrastructure?bbox=${encodeURIComponent(bbox)}`, { signal: controller.signal })
    clearTimeout(timeout)
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null // network error, timeout, DNS failure, PC off -- fall through
  }
}

async function fetchFromOverpass(bbox) {
  const [west, south, east, north] = bbox.split(",")
  const tagQueries = INFRA_TYPES.map(([k, v]) =>
    `  node["${k}"="${v}"](${south},${west},${north},${east});\n  way["${k}"="${v}"](${south},${west},${north},${east});`
  ).join("\n")
  const query = `[out:json][timeout:20];\n(\n${tagQueries}\n);\nout center;`

  for (const url of OVERPASS_URLS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
      })
      if (!r.ok) continue
      const data = await r.json()
      if (!data.elements) continue
      const features = data.elements
        .map((el) => {
          const lat = el.type === "node" ? el.lat : el.center?.lat
          const lon = el.type === "node" ? el.lon : el.center?.lon
          if (lat == null) return null
          const tags = el.tags || {}
          const match = INFRA_TYPES.find(([k, v]) => tags[k] === v)
          const type = match ? TYPE_LABELS[match[1]] : "Other"
          return {
            type: "Feature",
            geometry: { type: "Point", coordinates: [lon, lat] },
            properties: {
              name: tags.name || tags["name:es"] || type,
              type,
              osm_id: el.id,
              osm_type: el.type,
            },
          }
        })
        .filter(Boolean)
      return { type: "FeatureCollection", features }
    } catch {
      continue
    }
  }
  return null
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" })

  const bbox = req.query.bbox
  if (!bbox || bbox.split(",").length !== 4) {
    return res.status(400).json({ error: "bbox query param required: west,south,east,north" })
  }

  const fromRemote = await fetchFromRemoteServer(bbox)
  if (fromRemote) return res.status(200).json({ ...fromRemote, source: "remote_server" })

  const fromOverpass = await fetchFromOverpass(bbox)
  if (fromOverpass) return res.status(200).json({ ...fromOverpass, source: "overpass_fallback" })

  return res.status(502).json({ error: "Both the remote infrastructure server and Overpass fallback failed", type: "FeatureCollection", features: [] })
}
