import { useState, useEffect, useMemo } from "react"
import { loadCountryBoundaries, findCountryFeature, filterFeaturesByCountry } from "../utils/countryBoundaries"
import { filterFeaturesByBbox } from "../utils/spatial"
import { fireKeyFromLatLon } from "../hooks/useIncidents"
import { GROUP_KEYS, GROUP_META } from "../utils/responderGroups"
import { theme } from "../utils/theme"
import { useLanguage } from "../context/LanguageContext"

const STATUS_ORDER = ["unassigned", "assigned", "attending", "resolved"]
const STATUS_COLOR = {
  unassigned: theme.textMuted,
  assigned: theme.orange,
  attending: theme.danger,
  resolved: theme.navy,
}
const REQ_STATUS_COLOR = {
  pending: theme.orange, accepted: theme.navy, attending: theme.danger,
  resolved: theme.textMuted, exhausted: theme.danger,
}

// One row in an expanded status group. Gives the EOC (or anyone) full
// visibility at a glance — a compact chip per responder group showing who's
// been requested/accepted/attending on this fire, sourced straight from
// incident.requests (same live, KV-synced data FireCommandPanel uses to
// actually make the assignment) — this row is read-only; "Ver / Asignar"
// jumps to the map and opens the real assignment panel there instead of
// duplicating those controls in a second place.
function IncidentRow({ feature, fireKey, incident, lat, lon, onSelectFire, releaseIncident, t }) {
  const [busy, setBusy] = useState(false)
  const requests = incident?.requests || {}
  const activeGroups = GROUP_KEYS.filter((g) => requests[g])

  const release = async () => {
    setBusy(true)
    await releaseIncident(fireKey)
    setBusy(false)
  }

  return (
    <div style={{ padding: "7px 10px", borderBottom: `1px solid ${theme.border}`, fontSize: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button onClick={() => onSelectFire?.(feature)}
          style={{ background: "none", border: "none", cursor: "pointer", color: theme.textPrimary, textAlign: "left", flex: 1, padding: 0 }}>
          📍 {lat.toFixed(3)}, {lon.toFixed(3)}
        </button>
        <span style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
          <button onClick={() => onSelectFire?.(feature)}
            style={{ fontSize: "10.5px", padding: "2px 7px", borderRadius: "4px", cursor: "pointer",
              border: `1px solid ${theme.orange}`, background: "#fff", color: theme.orange, fontWeight: "bold" }}>
            {t("incidentAttend")}
          </button>
          {incident && (
            <button disabled={busy} onClick={release}
              style={{ fontSize: "10.5px", padding: "2px 7px", borderRadius: "4px", cursor: "pointer",
                border: `1px solid ${theme.border}`, background: "#fff", color: theme.textSecondary }}>
              {t("incidentRelease")}
            </button>
          )}
        </span>
      </div>
      {activeGroups.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginTop: "5px" }}>
          {activeGroups.map((g) => {
            const req = requests[g]
            return (
              <span key={g} style={{
                fontSize: "10px", padding: "2px 6px", borderRadius: "10px",
                border: `1px solid ${REQ_STATUS_COLOR[req.status] || theme.border}`,
                color: REQ_STATUS_COLOR[req.status] || theme.textSecondary,
              }}>
                {GROUP_META[g].icon} {req.targetName} — {t("reqStatus_" + req.status)}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function IncidentStatusBar({ activeModule, layers, zoneInfo, incidents, releaseIncident, onSelectFire }) {
  const { t } = useLanguage()
  const [countryFeature, setCountryFeature] = useState(null)
  const [openGroup, setOpenGroup] = useState(null)

  useEffect(() => {
    if (!zoneInfo?.country) { setCountryFeature(null); return }
    let cancelled = false
    loadCountryBoundaries()
      .then((boundaries) => { if (!cancelled) setCountryFeature(findCountryFeature(boundaries, zoneInfo.country)) })
      .catch(() => { if (!cancelled) setCountryFeature(null) })
    return () => { cancelled = true }
  }, [zoneInfo?.country])

  const allDetections = layers.hotspots?.data?.features || []
  // Same country-scoping as Sidebar's own "En [country]" stat (real
  // polygon when we have one, bbox fallback otherwise) — kept in a
  // separate component so Sidebar.jsx itself didn't need to change, but
  // deliberately reusing the exact same helpers/logic rather than
  // approximating it differently here.
  const countryHotspots = useMemo(() => {
    const byPolygon = filterFeaturesByCountry(allDetections, countryFeature)
    if (byPolygon !== null) return byPolygon
    return filterFeaturesByBbox(allDetections, zoneInfo?.countryBbox)
  }, [allDetections, countryFeature, zoneInfo])

  // The expensive part (building a fireKey string for every fire in the
  // country — up to 20k+ for somewhere like Canada in an active season) is
  // deliberately NOT in the same memo as the incidents-dependent grouping
  // below. Without this split, that full per-fire key computation was
  // re-running on every single incidents change — including from OTHER
  // responders' actions arriving via the poll, not just your own clicks —
  // which is what was making "Asignar" feel like it froze the tab.
  const keyedHotspots = useMemo(() => {
    return countryHotspots.map((feature) => {
      const [lon, lat] = feature.geometry.coordinates
      return { feature, fireKey: fireKeyFromLatLon(lat, lon), lat, lon }
    })
  }, [countryHotspots])

  const grouped = useMemo(() => {
    const groups = { unassigned: [], assigned: [], attending: [], resolved: [] }
    for (const item of keyedHotspots) {
      const incident = incidents?.[item.fireKey] || null
      const status = incident?.status || "unassigned"
      groups[status]?.push({ ...item, incident })
    }
    return groups
  }, [keyedHotspots, incidents])

  if (activeModule !== 2) return null

  const displayedGroup = openGroup ? grouped[openGroup] : []

  return (
    <div style={{ borderBottom: `1px solid ${theme.border}`, background: theme.panelBgSoft, padding: "8px 16px" }}>
      <div style={{ display: "flex", gap: "8px", alignItems: "stretch", flexWrap: "wrap" }}>
        {STATUS_ORDER.map((status) => {
          const count = grouped[status].length
          const isOpen = openGroup === status
          return (
            <button key={status}
              onClick={() => setOpenGroup(isOpen ? null : status)}
              style={{
                minWidth: "92px", padding: "6px 12px", borderRadius: "8px", cursor: "pointer",
                border: `2px solid ${isOpen ? STATUS_COLOR[status] : theme.border}`,
                background: isOpen ? STATUS_COLOR[status] + "22" : "#fff",
                textAlign: "left",
              }}>
              <div style={{ fontSize: "18px", fontWeight: "bold", color: STATUS_COLOR[status] }}>{count}</div>
              <div style={{ fontSize: "11px", color: theme.textSecondary }}>{t("incidentStatus_" + status)}</div>
            </button>
          )
        })}
      </div>

      {openGroup && (
        <div style={{ marginTop: "8px", maxHeight: "220px", overflowY: "auto", border: `1px solid ${theme.border}`, borderRadius: "6px", background: "#fff" }}>
          {displayedGroup.length === 0 && (
            <div style={{ padding: "10px", fontSize: "12px", color: theme.textMuted }}>{t("incidentGroupEmpty")}</div>
          )}
          {displayedGroup.map(({ feature, fireKey, incident, lat, lon }) => (
            <IncidentRow key={fireKey} feature={feature} fireKey={fireKey} incident={incident} lat={lat} lon={lon}
              onSelectFire={onSelectFire} releaseIncident={releaseIncident} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}
