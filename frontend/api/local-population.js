export const config = { maxDuration: 30 }

// Population-density grid for Module 2 -- "who is near the active fires
// shown right now". Same server as local-fwi.js/landcover.js; calls
// /local-population.
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
    return res.status(200).json({ type: "FeatureCollection", features: [] })
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 25000)
    const r = await fetch(`${INFRA_API_URL}/local-population`, {
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