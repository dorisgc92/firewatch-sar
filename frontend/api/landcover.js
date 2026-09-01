export const config = { maxDuration: 30 }

// Same server, same env var as frontend/api/infrastructure.js — this
// just calls a different endpoint on it (/classify-landcover).
//
// This replaced a batch step that used to run inside fetch_firms.py,
// classifying every one of ~150k global detections every hour. That hit
// a hard wall: the free/quick Cloudflare Tunnel this app uses has a
// non-configurable ~100s edge timeout per request, and no combination of
// batch size or concurrency could reliably push that many points through
// it hourly without a meaningful chunk failing. Classifying only what's
// actually on someone's screen right now — dozens to a few hundred
// points, and only when "Solo focos forestales" is switched on at all —
// stays comfortably inside that ceiling and stops paying for
// classification nobody's looking at.
const INFRA_API_URL = process.env.INFRA_API_URL

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const { points, window_size } = req.body || {}
  if (!Array.isArray(points) || points.length === 0) {
    return res.status(400).json({ error: "points must be a non-empty array of {lat, lon}" })
  }
  // A generous cap, well under what the map ever actually renders at
  // once (FireMap.jsx already caps visible markers at 1500) — mainly a
  // safety net against an unexpectedly huge request, not a real limit in
  // practice.
  if (points.length > 2000) {
    return res.status(400).json({ error: "Too many points in one request (max 2000)" })
  }

  if (!INFRA_API_URL) {
    // No remote server configured at all — fail open with "unclassified"
    // for every point rather than erroring, same philosophy as
    // fetch_firms.py's old fallback: an unavailable classifier should
    // never hide a real fire from view.
    return res.status(200).json({ results: points.map(() => ({ category: null, class_code: null })) })
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 25000)
    const r = await fetch(`${INFRA_API_URL}/classify-landcover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points, window_size: window_size || 3 }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    return res.status(200).json(data)
  } catch {
    // Remote server unreachable/slow/off — same fail-open behavior as
    // above, not a 502 to the frontend. The map should just show
    // everything rather than break when this one machine is offline.
    return res.status(200).json({ results: points.map(() => ({ category: null, class_code: null })) })
  }
}
