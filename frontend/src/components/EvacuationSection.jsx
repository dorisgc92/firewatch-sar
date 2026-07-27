import { useState } from "react"
import { findNextHospital } from "../utils/evacuation"
import { theme } from "../utils/theme"

// Shown once a fire is claimed (assigned/attending) — lets the responder
// request evacuation to the nearest hospital, and shows the live status
// of that request (pending/accepted/exhausted) as the hospital side
// (HospitalRequestInbox.jsx) accepts or rejects it.
export default function EvacuationSection({ fireKey, lat, lon, incident, infraFeatures, setIncidentStatus, t }) {
  const [busy, setBusy] = useState(false)

  if (!incident || (incident.status !== "assigned" && incident.status !== "attending")) return null

  const evac = incident.evacuation

  const requestEvacuation = async () => {
    setBusy(true)
    const hospital = findNextHospital(lat, lon, infraFeatures, [])
    if (!hospital) {
      await setIncidentStatus(fireKey, {
        evacuation: { status: "rejected_exhausted", rejectedHospitalIds: [], requestedAt: new Date().toISOString() },
      })
    } else {
      await setIncidentStatus(fireKey, {
        evacuation: {
          targetHospitalOsmId: hospital.osmId, targetHospitalName: hospital.name,
          targetHospitalLat: hospital.lat, targetHospitalLon: hospital.lon, distanceKm: hospital.distanceKm,
          status: "pending", rejectedHospitalIds: [], requestedAt: new Date().toISOString(),
        },
      })
    }
    setBusy(false)
  }

  const boxStyle = { marginTop: "6px", paddingTop: "6px", borderTop: `1px dashed ${theme.border}`, fontSize: "11px" }

  if (!evac) {
    return (
      <div style={boxStyle}>
        <button disabled={busy} onClick={requestEvacuation}
          style={{
            fontSize: "10.5px", padding: "3px 8px", borderRadius: "4px", cursor: "pointer",
            border: `1px solid ${theme.navy}`, background: "#fff", color: theme.navy, fontWeight: "bold",
          }}>
          🏥 {t("evacRequest")}
        </button>
      </div>
    )
  }

  if (evac.status === "rejected_exhausted") {
    return (
      <div style={{ ...boxStyle, color: theme.danger }}>
        ⚠️ {t("evacNoHospitalAvailable")}
      </div>
    )
  }

  const STATUS_COLOR = { pending: theme.orange, accepted: theme.navy, attending: theme.danger, resolved: theme.textMuted }
  const statusLabel = t("evacStatus_" + evac.status)
  const statusColor = STATUS_COLOR[evac.status] || theme.textMuted
  return (
    <div style={boxStyle}>
      🏥 {evac.targetHospitalName}
      {evac.distanceKm != null && ` (${evac.distanceKm.toFixed(1)} km)`}
      <span style={{ color: statusColor, fontWeight: "bold", marginLeft: "4px" }}>— {statusLabel}</span>
      {evac.rejectedHospitalIds?.length > 0 && (
        <div style={{ color: theme.textMuted, fontSize: "10px", marginTop: "2px" }}>
          {t("evacRejectedCount", { count: evac.rejectedHospitalIds.length })}
        </div>
      )}
    </div>
  )
}
