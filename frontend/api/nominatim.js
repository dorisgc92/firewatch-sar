export const config = { maxDuration: 15 }

// Nominatim's usage policy requires a descriptive User-Agent identifying
// the calling application — requests without one are liable to be
// throttled or blocked outright. Routing through this Vercel function
// (instead of calling Nominatim directly from the browser, which also
// can't set a custom User-Agent header anyway) lets us set that header
// server-side, and doubles as the CORS bypass /api/overpass already does
// for Overpass.
const USER_AGENT = "FireWatchSAR/1.0 (wildfire emergency response tool; contact: dorisgc92@github.com)"
const BASE_URL = "https://nominatim.openstreetmap.org"

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()

  try {
    const { mode, q, lat, lon, limit } = req.query
    let url
    if (mode === "reverse") {
      if (lat == null || lon == null) {
        return res.status(400).json({ error: "lat and lon are required for mode=reverse" })
      }
      url = `${BASE_URL}/reverse?format=jsonv2&addressdetails=1&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`
    } else {
      if (!q) return res.status(400).json({ error: "q is required for search" })
      url = `${BASE_URL}/search?format=jsonv2&addressdetails=1&limit=${encodeURIComponent(limit || "5")}&q=${encodeURIComponent(q)}`
    }

    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
    })

    if (!response.ok) {
      const text = await response.text()
      return res.status(response.status).json({ error: `Nominatim HTTP ${response.status}: ${text.slice(0, 300)}` })
    }

    const data = await response.json()
    res.status(200).json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
