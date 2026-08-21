export const config = { maxDuration: 15 }

// Upstash's REST API (what Vercel KV is backed by) — plain fetch calls,
// no @vercel/kv package needed. GET_URL/TOKEN come from the KV integration
// connected in the Vercel dashboard (Storage tab), with the "KV" prefix,
// so these env var names should already exist in the project.
const KV_URL = process.env.KV_REST_API_URL
const KV_TOKEN = process.env.KV_REST_API_TOKEN

// Single key holding the whole incidents map as one JSON blob:
// { [fireKey]: { status, updatedAt, requests } }.
// requests is keyed by responder group ("bombero", "proteccion_civil",
// "ems", "utilities", "ong" — see responderGroups.js on the frontend) and
// each value is: { targetId, targetName, targetLat, targetLon, distanceKm,
// status: pending|accepted|attending|resolved|exhausted, rejectedIds,
// requestedAt, respondedAt }. One record per group per fire, all living
// under the same fireKey, is what lets the EOC dispatch (say) a fire
// station AND a hospital to the same incident independently.
// Expected volume here is small (responders manually claiming specific
// fires, not one record per FIRMS detection), so one blob is simpler and
// cheap enough — no need for per-incident keys or a scan/index.
const INCIDENTS_KEY = "incidents"

const VALID_STATUSES = new Set(["unassigned", "assigned", "attending", "resolved"])
const VALID_REQUEST_STATUSES = new Set(["pending", "accepted", "rejected", "attending", "resolved", "exhausted"])
const VALID_GROUPS = new Set(["bombero", "proteccion_civil", "ems", "utilities", "ong"])

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
      const { fireKey, status, requests } = req.body || {}
      if (!fireKey) return res.status(400).json({ error: "fireKey is required" })
      if (status && !VALID_STATUSES.has(status)) {
        return res.status(400).json({ error: `status must be one of: ${[...VALID_STATUSES].join(", ")}` })
      }
      if (requests) {
        for (const [group, reqRecord] of Object.entries(requests)) {
          if (!VALID_GROUPS.has(group)) {
            return res.status(400).json({ error: `requests key must be one of: ${[...VALID_GROUPS].join(", ")}` })
          }
          if (reqRecord && reqRecord.status && !VALID_REQUEST_STATUSES.has(reqRecord.status)) {
            return res.status(400).json({ error: `requests.${group}.status must be one of: ${[...VALID_REQUEST_STATUSES].join(", ")}` })
          }
        }
      }

      // Read-modify-write. Last-write-wins on the whole blob — fine for
      // this scale/use case (a handful of responders occasionally
      // claiming fires, not high-frequency concurrent writes to the same
      // key), same trade-off the rest of this app already accepts
      // elsewhere (e.g. the bot commits to data/*.geojson).
      const raw = await kvGet(INCIDENTS_KEY)
      const map = raw ? JSON.parse(raw) : {}

      if (status === "unassigned" && !requests) {
        // Releasing a fire drops the whole record — no active response is
        // coordinating it anymore, for any group.
        delete map[fireKey]
      } else {
        // Merge into the existing record instead of replacing it. `status`
        // (the aggregate unassigned/assigned/attending/resolved bucket) is
        // simply overwritten — the client always sends the freshly-derived
        // value (see deriveOverallStatus on the frontend). `requests` is
        // merged one GROUP at a time: a payload only ever contains the
        // group(s) that actually changed (e.g. just { bombero: {...} }
        // when the fire station accepts), so the other groups' requests on
        // this fire must survive untouched.
        const existing = map[fireKey] || {}
        const next = { ...existing }
        if (status) next.status = status
        if (requests) next.requests = { ...(existing.requests || {}), ...requests }
        if (!next.status) next.status = "assigned" // first write with no explicit status
        next.updatedAt = new Date().toISOString()
        map[fireKey] = next
      }

      await kvSet(INCIDENTS_KEY, JSON.stringify(map))
      return res.status(200).json(map)
    }

    return res.status(405).json({ error: "Method not allowed" })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
