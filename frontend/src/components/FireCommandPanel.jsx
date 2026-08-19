import { useState, useEffect } from "react"
import { reverseGeocodePlace } from "../utils/geocode"
import { fireKeyFromLatLon } from "../hooks/useIncidents"
import { GROUP_KEYS, GROUP_META, candidatesForGroup } from "../utils/responderGroups"
import { theme } from "../utils/theme"
import { useLanguage } from "../context/LanguageContext"

const REQ_STATUS_COLOR = {
  pending: theme.orange, accepted: theme.navy, attending: theme.danger,
  resolved: theme.textMuted, exhausted: theme.danger,
}

// One responder group's card inside the assignment section: shows the
// live request state for this fire (if any) and, for the EOC only, the
// 3 nearest candidates with an Asignar button each. Local `sendingId`
// gives instant "Enviando solicitud..." feedback on the exact button
// clicked, without waiting for the 3s poll to confirm — the confirmed
// "Pendiente" chip (read from `incidents`, shared via KV) takes over as
// soon as the POST resolves, typically well under a second.
function GroupCard({ group, lat, lon, infraFeatures, req, canAssign, requestResponder, t }) {
  const [sendingId, setSendingId] = useState(null)
  const meta = GROUP_META[group]
  const fallbackName = t(meta.fallbackNameKey)
  const candidates = candidatesForGroup(lat, lon, infraFeatures, group, 3, fallbackName)
  const fireKey = fireKeyFromLatLon(lat, lon)

  const assign = async (candidate) => {
    setSendingId(candidate.id)
    await requestResponder(fireKey, group, candidate)
    setSendingId(null)
  }

  return (
    <div style={{ border: `1px solid ${theme.border}`, borderRadius: "6px", padding: "8px 10px", marginBottom: "6px", background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "12px", fontWeight: "bold", color: theme.textPrimary }}>
          {meta.icon} {t("responder." + group)}
        </span>
        {req && (
          <span style={{ fontSize: "11px", fontWeight: "bold", color: REQ_STATUS_COLOR[req.status] || theme.textMuted }}>
            {req.status === "accepted" || req.status === "attending"
              ? t("reqAcceptedBy", { name: req.targetName })
              : t("reqStatus_" + req.status)}
          </span>
        )}
      </div>

      {req && (
        <div style={{ fontSize: "10.5px", color: theme.textSecondary, marginTop: "2px" }}>
          {req.targetName}{req.distanceKm != null && ` · ${req.distanceKm.toFixed(1)} km`}
        </div>
      )}

      {canAssign && (
        candidates.length === 0 ? (
          <div style={{ fontSize: "11px", color: theme.textMuted, marginTop: "4px" }}>{t("reqNoCandidates")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "6px" }}>
            {candidates.map((c) => {
              const isCurrent = req?.targetId === c.id && (req.status === "pending" || req.status === "accepted" || req.status === "attending")
              const sending = sendingId === c.id
              return (
                <button key={c.id} disabled={sending || isCurrent} onClick={() => assign(c)}
                  style={{
                    fontSize: "11px", textAlign: "left", padding: "5px 8px", borderRadius: "5px",
                    cursor: isCurrent ? "default" : "pointer",
                    border: `1px solid ${isCurrent ? theme.navy : theme.border}`,
                    background: isCurrent ? theme.navySoft : "#fff",
                    color: isCurrent ? theme.navy : theme.textPrimary,
                  }}>
                  {sending
                    ? t("reqSending")
                    : isCurrent
                      ? `✓ ${c.name} (${c.distanceKm.toFixed(1)} km)`
                      : t("reqAssignTo", { name: c.name, km: c.distanceKm.toFixed(1) })}
                </button>
              )
            })}
          </div>
        )
      )}
    </div>
  )
}

export default function FireCommandPanel({ selectedFire, incidents, requestResponder, infraFeatures, responderType, onClose }) {
  const { t } = useLanguage()
  const [place, setPlace] = useState(null)
  const [showAssign, setShowAssign] = useState(false)

  const [lon, lat] = selectedFire.geometry.coordinates
  const { frp, intensity, source, acq_datetime, fire_type, fire_type_label, likely_vegetation, non_vegetation_reason } = selectedFire.properties || {}
  const isNonVegetation = (fire_type != null && fire_type !== 0) || likely_vegetation === false
  const fireKey = fireKeyFromLatLon(lat, lon)
  const incident = incidents?.[fireKey]

  useEffect(() => {
    let cancelled = false
    setPlace(null)
    reverseGeocodePlace(lat, lon).then((p) => { if (!cancelled) setPlace(p) })
    return () => { cancelled = true }
  }, [lat, lon])

  const isEOC = responderType === "eoc"

  const fireTypeDisplay = {
    volcano: t("fireTypeVolcano"), static_land_source: t("fireTypeStatic"),
    urban_area: t("fireTypeUrban"), offshore: t("fireTypeOffshore"), unknown: t("fireTypeUnknown"),
  }[fire_type_label]

  return (
    <div style={{
      border: `1px solid ${theme.orange}`, borderRadius: "8px", background: theme.orangeSoft,
      padding: "10px", marginBottom: "10px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ fontSize: "13px", fontWeight: "bold", color: theme.textPrimary }}>
          🔥 {place || `${lat.toFixed(3)}, ${lon.toFixed(3)}`}
        </div>
        <button onClick={onClose} style={{
          border: "none", background: "none", cursor: "pointer", fontSize: "16px", color: theme.textMuted, lineHeight: 1, padding: 0,
        }}>✕</button>
      </div>

      <div style={{ fontSize: "11px", color: theme.textSecondary, marginTop: "4px", lineHeight: 1.6 }}>
        {t("coordinates")}: {lat.toFixed(4)}, {lon.toFixed(4)}<br />
        FRP: {frp ? frp + " MW" : "N/A"} · {t("intensity")}: {intensity || "—"}<br />
        {t("sensor")}: {source || "—"} · {t("detected")}: {acq_datetime || "—"}
      </div>

      {isNonVegetation && (
        <div style={{ marginTop: "6px", padding: "5px 6px", borderRadius: "5px", background: "#F0F0F0", border: "1px solid #ccc", fontSize: "10.5px", color: "#555" }}>
          ⚠️ {t("nonVegetationSource")} ({fireTypeDisplay})
        </div>
      )}

      <div style={{ fontSize: "11px", marginTop: "6px", color: theme.textSecondary }}>
        {t("cmdPanelOverallStatus")}: <strong style={{ color: theme.textPrimary }}>{t("incidentStatus_" + (incident?.status || "unassigned"))}</strong>
      </div>

      {isEOC ? (
        <button onClick={() => setShowAssign((v) => !v)}
          style={{
            marginTop: "8px", width: "100%", padding: "7px 10px", borderRadius: "6px",
            border: "none", background: theme.orange, color: "#fff", fontWeight: "bold",
            fontSize: "12px", cursor: "pointer",
          }}>
          {showAssign ? t("cmdPanelHideAssign") : t("incidentAttend")}
        </button>
      ) : (
        <div style={{ fontSize: "10.5px", color: theme.textMuted, marginTop: "6px", fontStyle: "italic" }}>
          {t("cmdPanelOnlyEOC")}
        </div>
      )}

      {(showAssign || !isEOC) && (
        <div style={{ marginTop: "8px" }}>
          {GROUP_KEYS.map((group) => (
            <GroupCard key={group} group={group} lat={lat} lon={lon} infraFeatures={infraFeatures}
              req={incident?.requests?.[group]} canAssign={isEOC && showAssign}
              requestResponder={requestResponder} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}
