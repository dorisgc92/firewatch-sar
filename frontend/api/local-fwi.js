export const config = { maxDuration: 60 }

// Same server as landcover.js/infrastructure.js -- calls /local-fwi for a
// fine-grained (~11km) FWI grid scoped to whatever zone the user is
// currently viewing, as filled cells rather than points. Contrast with
// the global fwi_grid.geojson (10-degree spacing, ~1000km) served as a
// static file for the world-at-a-glance view -- this is the "zoomed into
// Guadalajara and want neighborhood-level detail" counterpart.
const INFRA_API_URL = process.env.INFRA_API_URL

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const { west, south, east, north } = req.body || {}
  if ([west, south, east, north].some((v) => typeof v !== "number")) {
    return res.status(400).json({ error: "west, south, east, north must all be numbers" })
  }

  if (!INFRA_API_URL) {
    // No remote server configured -- fail open with an empty grid rather
    // than erroring, same philosophy as landcover.js: an unavailable
    // local-FWI layer should never break the map, just show nothing extra.
    return res.status(200).json({ type: "FeatureCollection", features: [] })
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 45000)
    const r = await fetch(`${INFRA_API_URL}/local-fwi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ west, south, east, north }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    return res.status(200).json(data)
  } catch {
    return res.status(200).json({ type: "FeatureCollection", features: [] })
  }
}