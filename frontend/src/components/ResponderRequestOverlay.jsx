import { useState, useMemo } from "react"
import { GROUP_META, isDispatchableGroup, loadMyFacility, saveMyFacility } from "../utils/responderGroups"
import { theme } from "../utils/theme"
import { useLanguage } from "../context/LanguageContext"

// Generalizes what used to be HospitalRequestInbox.jsx (ems-only, hospital
// evacuation requests) to all five dispatchable responder groups. Two
// jobs, same as before:
//   1. Pick "which facility am I" once (no real login system in this app —
//      same manual, localStorage-persisted pick "my unit" already uses).
//   2. Show this facility's requests: brand-new ones as an attention-
//      grabbing floating card over the map (Doris asked for this to be
//      near-impossible to miss — semi-transparent, sits on top of the map),
//      and already-accepted ones as a compact status bar to advance.
export default function ResponderRequestOverlay({ activeModule, responderType, incidents, respondToRequest, onSelectFire, zoneInfrastructure }) {
  const { t } = useLanguage()
  const [myFacility, setMyFacility] = useState(() => isDispatchableGroup(responderType) ? loadMyFacility(responderType) : null)
  const [search, setSearch] = useState("")
  const [busyKey, setBusyKey] = useState(null)

  // Zone-scoped (bundled-if-covered, live-Overpass-fallback otherwise) —
  // NOT the raw global bundled layer. A responder's own station may sit
  // in a world-crawl tile that hasn't run yet; searching only the global
  // bundle would make their own facility invisible in the "which unit are
  // you" picker. This is the same dataset the EOC's assignment panel and
  // the map itself use, so "my facility" and "nearest facility" always
  // agree on what exists nearby.
  const infraFeatures = zoneInfrastructure || []
  const meta = GROUP_META[responderType]

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!meta || q.length < 2) return []
    const types = new Set(meta.infraTypes)
    return infraFeatures
      .filter((f) => types.has(f.properties?.type) && f.properties?.name?.toLowerCase().includes(q))
      .slice(0, 8)
  }, [infraFeatures, search, meta])

  const pickFacility = (feature) => {
    const [lon, lat] = feature.geometry.coordinates
    const osmId = feature.properties.osm_id
    const chosen = {
      id: osmId != null ? String(osmId) : `${lat.toFixed(4)},${lon.toFixed(4)}`,
      name: feature.properties.name || t(meta.fallbackNameKey) || "Unnamed unit",
      lat, lon,
    }
    setMyFacility(chosen)
    saveMyFacility(responderType, chosen)
    setSearch("")
  }

  const changeFacility = () => { setMyFacility(null); saveMyFacility(responderType, null) }

  const myRequests = useMemo(() => {
    if (!myFacility) return []
    return Object.entries(incidents || {})
      .map(([fireKey, incident]) => {
        const req = incident.requests?.[responderType]
        if (!req || req.targetId !== myFacility.id) return null
        const [lat, lon] = fireKey.split(",").map(Number)
        return { fireKey, incident, req, lat, lon }
      })
      .filter(Boolean)
  }, [incidents, myFacility, responderType])

  const pending = myRequests.filter((r) => r.req.status === "pending")
  const active = myRequests.filter((r) => r.req.status === "accepted" || r.req.status === "attending")

  if (activeModule !== 2 || !isDispatchableGroup(responderType)) return null

  const accept = async (item) => {
    setBusyKey(item.fireKey)
    await respondToRequest(item.fireKey, responderType, "accept", {})
    setBusyKey(null)
  }
  const reject = async (item) => {
    setBusyKey(item.fireKey)
    await respondToRequest(item.fireKey, responderType, "reject", {
      infraFeatures, lat: item.lat, lon: item.lon, fallbackName: t(meta.fallbackNameKey),
    })
    setBusyKey(null)
  }
  const markAttending = async (item) => {
    setBusyKey(item.fireKey)
    await respondToRequest(item.fireKey, responderType, "attending", {})
    setBusyKey(null)
  }
  const markResolved = async (item) => {
    setBusyKey(item.fireKey)
    await respondToRequest(item.fireKey, responderType, "resolved", {})
    setBusyKey(null)
  }

  return (
    <>
      {/* Status/setup bar — same slot in the layout HospitalRequestInbox used to occupy */}
      <div style={{ borderBottom: `1px solid ${theme.border}`, background: theme.panelBgSoft, padding: "8px 16px" }}>
        {!myFacility ? (
          <div style={{ position: "relative", maxWidth: "320px" }}>
            <div style={{ fontSize: "11px", color: theme.textSecondary, marginBottom: "4px" }}>
              {t("reqMyFacilityPrompt")}
            </div>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder={t("reqMyFacilitySearchPlaceholder")}
              style={{ fontSize: "12px", padding: "6px 10px", borderRadius: "6px", border: `1px solid ${theme.border}`, width: "100%", boxSizing: "border-box" }} />
            {searchResults.length > 0 && (
              <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#fff",
                border: `1px solid ${theme.border}`, borderRadius: "6px", marginTop: "4px", zIndex: 10, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}>
                {searchResults.map((f, i) => (
                  <div key={i} onClick={() => pickFacility(f)}
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
              <span style={{ fontSize: "12px", fontWeight: "bold", color: theme.navy }}>{meta.icon} {myFacility.name}</span>
              <button onClick={changeFacility}
                style={{ fontSize: "10.5px", padding: "2px 7px", borderRadius: "4px", cursor: "pointer",
                  border: `1px solid ${theme.border}`, background: "#fff", color: theme.textSecondary }}>
                {t("reqChangeFacility")}
              </button>
            </div>
            {active.length === 0 ? (
              <div style={{ fontSize: "11.5px", color: theme.textMuted }}>{t("reqNoActive")}</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {active.map((item) => (
                  <div key={item.fireKey} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "6px 10px", border: `1px solid ${theme.border}`, borderRadius: "6px", background: "#fff", fontSize: "12px" }}>
                    <span onClick={() => onSelectFire?.(fireFeatureFromKey(item.fireKey))} style={{ cursor: "pointer" }}>
                      🔥 {item.lat.toFixed(3)}, {item.lon.toFixed(3)}
                      {item.req.distanceKm != null && ` · ${item.req.distanceKm.toFixed(1)} km`}
                      <span style={{ marginLeft: "6px", fontWeight: "bold",
                        color: item.req.status === "attending" ? theme.danger : theme.navy }}>
                        ({t("reqStatus_" + item.req.status)})
                      </span>
                    </span>
                    <span style={{ display: "flex", gap: "4px" }}>
                      {item.req.status === "accepted" && (
                        <button disabled={busyKey === item.fireKey} onClick={() => markAttending(item)}
                          style={{ fontSize: "10.5px", padding: "3px 8px", borderRadius: "4px", cursor: "pointer",
                            border: `1px solid ${theme.danger}`, background: theme.danger, color: "#fff", fontWeight: "bold" }}>
                          {t("reqMarkAttending")}
                        </button>
                      )}
                      {item.req.status === "attending" && (
                        <button disabled={busyKey === item.fireKey} onClick={() => markResolved(item)}
                          style={{ fontSize: "10.5px", padding: "3px 8px", borderRadius: "4px", cursor: "pointer",
                            border: `1px solid ${theme.border}`, background: "#fff", color: theme.textSecondary, fontWeight: "bold" }}>
                          {t("reqMarkResolved")}
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Floating, semi-transparent incoming-request cards — sit on top of
          the map so a brand-new dispatch is impossible to miss, near-real-
          time via the 3s poll in useIncidents.js. Stacks if more than one
          arrives at once instead of only ever showing the first. */}
      {myFacility && pending.length > 0 && (
        <div style={{
          position: "fixed", top: "84px", left: "16px", zIndex: 2500,
          display: "flex", flexDirection: "column", gap: "8px", maxWidth: "300px",
        }}>
          {pending.map((item) => (
            <div key={item.fireKey} style={{
              background: "rgba(28,42,51,0.94)", color: "#fff", borderRadius: "10px",
              padding: "12px 14px", boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
              border: `1.5px solid ${theme.orange}`, animation: "fw-pulse 1.6s ease-in-out infinite",
            }}>
              <div style={{ fontSize: "12px", fontWeight: "bold", color: theme.orange, marginBottom: "4px" }}>
                🔥 {t("reqIncomingTitle")}
              </div>
              <div style={{ fontSize: "12px", lineHeight: 1.5, marginBottom: "8px" }}>
                {t("reqIncomingBody", {
                  km: item.req.distanceKm != null ? item.req.distanceKm.toFixed(1) : "?",
                  coords: `${item.lat.toFixed(3)}, ${item.lon.toFixed(3)}`,
                })}
              </div>
              <div style={{ display: "flex", gap: "6px" }}>
                <button disabled={busyKey === item.fireKey} onClick={() => accept(item)}
                  style={{ flex: 1, fontSize: "12px", fontWeight: "bold", padding: "6px 8px", borderRadius: "6px",
                    cursor: "pointer", border: "none", background: theme.orange, color: "#fff" }}>
                  {t("reqAccept")}
                </button>
                <button disabled={busyKey === item.fireKey} onClick={() => reject(item)}
                  style={{ flex: 1, fontSize: "12px", padding: "6px 8px", borderRadius: "6px",
                    cursor: "pointer", border: "1px solid rgba(255,255,255,0.4)", background: "transparent", color: "#fff" }}>
                  {t("reqReject")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <style>{`
        @keyframes fw-pulse {
          0%, 100% { box-shadow: 0 8px 24px rgba(0,0,0,0.35); }
          50% { box-shadow: 0 8px 30px rgba(255,102,0,0.55); }
        }
      `}</style>
    </>
  )
}

// The status bar's "jump to fire" click only has a fireKey (lat/lon), not
// the original GeoJSON feature — reconstruct a minimal one, same shape
// FireMap/App.jsx's onSelectFire already expects (geometry.coordinates +
// empty properties is enough to re-center the map and reverse-geocode).
function fireFeatureFromKey(fireKey) {
  const [lat, lon] = fireKey.split(",").map(Number)
  return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: {} }
}
