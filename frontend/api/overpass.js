export const config = { maxDuration: 30 }

// The main public instance times out under load fairly often — same issue
// documented in scripts/fetch_infrastructure.py, which already has this
// exact fallback. This proxy (used for on-demand per-zone infra lookups,
// see liveInfra.js) hadn't gotten the same fix, so live zone searches were
// more failure-prone than the batch crawl for no good reason.
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
]

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  try {
    const body = req.method === "POST" ? req.body : null
    const query = typeof body === "string" ? body : JSON.stringify(body)
    const payload = "data=" + encodeURIComponent(req.body?.data || query)

    let lastError = null
    for (const url of OVERPASS_URLS) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: payload,
        })
        if (!response.ok) {
          const text = await response.text()
          lastError = { status: response.status, message: `Overpass HTTP ${response.status}: ${text.slice(0, 300)}` }
          continue // try the next mirror instead of failing outright
        }
        const data = await response.json()
        return res.status(200).json(data)
      } catch (e) {
        lastError = { status: 502, message: e.message }
      }
    }

    return res.status(lastError?.status || 502).json({ error: lastError?.message || "All Overpass mirrors failed" })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}