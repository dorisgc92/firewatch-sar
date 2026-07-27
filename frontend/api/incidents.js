export const config = { maxDuration: 15 }

// Upstash's REST API (what Vercel KV is backed by) — plain fetch calls,
// no @vercel/kv package needed. GET_URL/TOKEN come from the KV integration
// connected in the Vercel dashboard (Storage tab), with the "KV" prefix,
// so these env var names should already exist in the project.
const KV_URL = process.env.KV_REST_API_URL
const KV_TOKEN = process.env.KV_REST_API_TOKEN

// Single key holding the whole incidents map as one JSON blob:
// { [fireKey]: { status, unit, responderName, note, updatedAt } }.
// Expected volume here is small (responders manually claiming specific
// fires, not one record per FIRMS detection), so one blob is simpler and
// cheap enough — no need for per-incident keys or a scan/index.
const INCIDENTS_KEY = "incidents"

const VALID_STATUSES = new Set(["unassigned", "assigned", "attending", "resolved"])

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  })
  if (!r.ok) throw new Error(`KV GET failed: HTTP ${r.status}`)
  const data = await r.json()
  return data.result ?? null
}

async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body: value,
  })
  if (!r.ok) throw new Error(`KV SET failed: HTTP ${r.status}`)
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()

  if (!KV_URL || !KV_TOKEN) {
    return res.status(500).json({ error: "KV_REST_API_URL / KV_REST_API_TOKEN not configured on this deployment" })
  }

  try {
    if (req.method === "GET") {
      const raw = await kvGet(INCIDENTS_KEY)
      const map = raw ? JSON.parse(raw) : {}
      return res.status(200).json(map)
    }

    if (req.method === "POST") {
      const { fireKey, status, unit, responderName, note } = req.body || {}
      if (!fireKey) return res.status(400).json({ error: "fireKey is required" })
      if (status && !VALID_STATUSES.has(status)) {
        return res.status(400).json({ error: `status must be one of: ${[...VALID_STATUSES].join(", ")}` })
      }

      // Read-modify-write. Last-write-wins on the whole blob — fine for
      // this scale/use case (a handful of responders occasionally
      // claiming fires, not high-frequency concurrent writes to the same
      // key), same trade-off the rest of this app already accepts
      // elsewhere (e.g. the bot commits to data/*.geojson).
      const raw = await kvGet(INCIDENTS_KEY)
      const map = raw ? JSON.parse(raw) : {}

      if (status === "unassigned" || status === null) {
        delete map[fireKey]
      } else {
        map[fireKey] = {
          status: status || "assigned",
          unit: unit || null,
          responderName: responderName || null,
          note: note || null,
          updatedAt: new Date().toISOString(),
        }
      }

      await kvSet(INCIDENTS_KEY, JSON.stringify(map))
      return res.status(200).json(map)
    }

    return res.status(405).json({ error: "Method not allowed" })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
