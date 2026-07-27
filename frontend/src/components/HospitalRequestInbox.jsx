import { useState, useMemo } from "react"
import { findNextHospital } from "../utils/evacuation"
import { theme } from "../utils/theme"
import { useLanguage } from "../context/LanguageContext"

const MY_HOSPITAL_STORAGE_KEY = "firewatch_my_hospital"

function loadMyHospital() {
  try {
    const raw = localStorage.getItem(MY_HOSPITAL_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// Shown only for responderType === "ems", Module 2. There's no real login
// system in this app, so "which hospital am I" is a manual one-time pick
// (persisted to this browser via localStorage) rather than an account —
// same limitation as the "my unit" filter in IncidentStatusBar.jsx.
export default function HospitalRequestInbox({ activeModule, responderType, layers, incidents, setIncidentStatus }) {
  const { t } = useLanguage()
  const [myHospital, setMyHospital] = useState(loadMyHospital)
  const [search, setSearch] = useState("")
  const [busyKey, setBusyKey] = useState(null)

  const infraFeatures = layers.infrastructure?.data?.features || []

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (q.length < 2) return []
    return infraFeatures
      .filter((f) => (f.properties?.type === "Hospital" || f.properties?.type === "Clinic")
        && f.properties?.name?.toLowerCase().includes(q))
      .slice(0, 8)
  }, [infraFeatures, search])

  const pickHospital = (feature) => {
    const [lon, lat] = feature.geometry.coordinates
    const chosen = { osmId: String(feature.properties.osm_id), name: feature.properties.name || "Unnamed hospital", lat, lon }
    setMyHospital(chosen)
    localStorage.setItem(MY_HOSPITAL_STORAGE_KEY, JSON.stringify(chosen))
    setSearch("")
  }

  const pendingRequests = useMemo(() => {
    if (!myHospital) return []
    return Object.entries(incidents || {})
      .filter(([, incident]) => incident.evacuation?.status === "pending" && incident.evacuation?.targetHospitalOsmId === myHospital.osmId)
      .map(([fireKey, incident]) => {
        const [lat, lon] = fireKey.split(",").map(Number)
        return { fireKey, incident, lat, lon }
      })
  }, [incidents, myHospital])

  if (activeModule !== 2 || responderType !== "ems") return null

  const accept = async (fireKey, incident) => {
    setBusyKey(fireKey)
    await setIncidentStatus(fireKey, { evacuation: { ...incident.evacuation, status: "accepted" } })
    setBusyKey(null)
  }

  const reject = async (fireKey, incident, lat, lon) => {
    setBusyKey(fireKey)
    const excluded = [...(incident.evacuation.rejectedHospitalIds || []), myHospital.osmId]
    const next = findNextHospital(lat, lon, infraFeatures, excluded)
    if (!next) {
      await setIncidentStatus(fireKey, { evacuation: { status: "rejected_exhausted", rejectedHospitalIds: excluded, requestedAt: incident.evacuation.requestedAt } })
    } else {
      await setIncidentStatus(fireKey, {
        evacuation: {
          targetHospitalOsmId: next.osmId, targetHospitalName: next.name,
          targetHospitalLat: next.lat, targetHospitalLon: next.lon, distanceKm: next.distanceKm,
          status: "pending", rejectedHospitalIds: excluded, requestedAt: incident.evacuation.requestedAt,
        },
      })
    }
    setBusyKey(null)
  }

  return (
    <div style={{ borderBottom: `1px solid ${theme.border}`, background: theme.panelBgSoft, padding: "8px 16px" }}>
      {!myHospital ? (
        <div style={{ position: "relative", maxWidth: "320px" }}>
          <div style={{ fontSize: "11px", color: theme.textSecondary, marginBottom: "4px" }}>{t("evacPickHospitalPrompt")}</div>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={t("evacHospitalSearchPlaceholder")}
            style={{ fontSize: "12px", padding: "6px 10px", borderRadius: "6px", border: `1px solid ${theme.border}`, width: "100%", boxSizing: "border-box" }} />
          {searchResults.length > 0 && (
            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#fff",
              border: `1px solid ${theme.border}`, borderRadius: "6px", marginTop: "4px", zIndex: 10, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}>
              {searchResults.map((f) => (
                <div key={f.properties.osm_id} onClick={() => pickHospital(f)}
                  style={{ padding: "7px 10px", cursor: "pointer", fontSize: "12px", borderBottom: `1px solid ${theme.border}` }}>
                  {f.properties.name}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: "bold", color: theme.navy }}>🏥 {myHospital.name}</span>
            <button onClick={() => { setMyHospital(null); localStorage.removeItem(MY_HOSPITAL_STORAGE_KEY) }}
              style={{ fontSize: "10.5px", padding: "2px 7px", borderRadius: "4px", cursor: "pointer",
                border: `1px solid ${theme.border}`, background: "#fff", color: theme.textSecondary }}>
              {t("evacChangeHospital")}
            </button>
          </div>
          {pendingRequests.length === 0 ? (
            <div style={{ fontSize: "11.5px", color: theme.textMuted }}>{t("evacNoRequests")}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {pendingRequests.map(({ fireKey, incident, lat, lon }) => (
                <div key={fireKey} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "6px 10px", border: `1px solid ${theme.border}`, borderRadius: "6px", background: "#fff", fontSize: "12px" }}>
                  <span>
                    🔥 {lat.toFixed(3)}, {lon.toFixed(3)}
                    {incident.evacuation.distanceKm != null && ` · ${incident.evacuation.distanceKm.toFixed(1)} km`}
                    {incident.unit && <span style={{ color: theme.textMuted }}> — {incident.unit}</span>}
                  </span>
                  <span style={{ display: "flex", gap: "4px" }}>
                    <button disabled={busyKey === fireKey} onClick={() => accept(fireKey, incident)}
                      style={{ fontSize: "10.5px", padding: "3px 8px", borderRadius: "4px", cursor: "pointer",
                        border: `1px solid ${theme.navy}`, background: theme.navy, color: "#fff", fontWeight: "bold" }}>
                      {t("evacAccept")}
                    </button>
                    <button disabled={busyKey === fireKey} onClick={() => reject(fireKey, incident, lat, lon)}
                      style={{ fontSize: "10.5px", padding: "3px 8px", borderRadius: "4px", cursor: "pointer",
                        border: `1px solid ${theme.border}`, background: "#fff", color: theme.textSecondary }}>
                      {t("evacReject")}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
