import { useState, useEffect, useMemo } from "react"
import { loadCountryBoundaries, findCountryFeature, filterFeaturesByCountry } from "../utils/countryBoundaries"
import { filterFeaturesByBbox } from "../utils/spatial"
import { fireKeyFromLatLon } from "../hooks/useIncidents"
import { theme } from "../utils/theme"
import { useLanguage } from "../context/LanguageContext"

const STATUS_ORDER = ["unassigned", "assigned", "attending", "resolved"]
const STATUS_COLOR = {
  unassigned: theme.textMuted,
  assigned: theme.orange,
  attending: theme.danger,
  resolved: theme.navy,
}
const MY_UNIT_STORAGE_KEY = "firewatch_my_unit"

// One row in an expanded status group. Local state (assignInput) needs to
// live per-row, so this can't just be inlined in a .map() callback.
// Gives the EOC (or anyone) both visibility — unit assigned, evacuation
// target hospital + its status — and direct control: typing a unit and
// pressing Asignar/Reasignar works whether or not anyone has claimed this
// fire yet, instead of only being able to release what a firefighter
// already self-assigned.
function IncidentRow({ feature, fireKey, incident, lat, lon, onSelectFire, setIncidentStatus, t }) {
  const [assignInput, setAssignInput] = useState(incident?.unit || "")
  const [busy, setBusy] = useState(false)

  const assign = async () => {
    setBusy(true)
    await setIncidentStatus(fireKey, { status: incident?.status || "assigned", unit: assignInput.trim() || null })
    setBusy(false)
  }

  const release = async () => {
    setBusy(true)
    await setIncidentStatus(fireKey, { status: "unassigned" })
    setBusy(false)
  }

  return (
    <div style={{ padding: "7px 10px", borderBottom: `1px solid ${theme.border}`, fontSize: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button onClick={() => onSelectFire?.(feature)}
          style={{ background: "none", border: "none", cursor: "pointer", color: theme.textPrimary, textAlign: "left", flex: 1, padding: 0 }}>
          📍 {lat.toFixed(3)}, {lon.toFixed(3)}
          {incident?.unit && <span style={{ color: theme.textMuted }}> — {incident.unit}</span>}
        </button>
        {incident && (
          <button disabled={busy} onClick={release}
            style={{ fontSize: "10.5px", padding: "2px 7px", borderRadius: "4px", cursor: "pointer",
              border: `1px solid ${theme.border}`, background: "#fff", color: theme.textSecondary, marginLeft: "8px" }}>
            {t("incidentRelease")}
          </button>
        )}
      </div>
      {incident?.evacuation && (
        <div style={{ fontSize: "10.5px", color: theme.textSecondary, marginTop: "3px" }}>
          🏥 {incident.evacuation.targetHospitalName} — {t("evacStatus_" + incident.evacuation.status)}
        </div>
      )}
      <div style={{ display: "flex", gap: "4px", marginTop: "4px", alignItems: "center" }}>
        <input value={assignInput} onChange={(e) => setAssignInput(e.target.value)}
          placeholder={t("incidentUnitPlaceholder")}
          style={{ fontSize: "11px", flex: 1, minWidth: 0, padding: "3px 6px", borderRadius: "4px", border: `1px solid ${theme.border}` }} />
        <button disabled={busy} onClick={assign}
          style={{ fontSize: "10px", padding: "3px 8px", borderRadius: "4px", cursor: "pointer",
            border: `1px solid ${theme.navy}`, background: "#fff", color: theme.navy, fontWeight: "bold", flexShrink: 0 }}>
          {incident ? t("incidentReassign") : t("incidentAssign")}
        </button>
      </div>
    </div>
  )
}

export default function IncidentStatusBar({ activeModule, layers, zoneInfo, incidents, setIncidentStatus, onSelectFire }) {
  const { t } = useLanguage()
  const [countryFeature, setCountryFeature] = useState(null)
  const [openGroup, setOpenGroup] = useState(null)
  const [myUnit, setMyUnit] = useState(() => localStorage.getItem(MY_UNIT_STORAGE_KEY) || "")
  const [onlyMyUnit, setOnlyMyUnit] = useState(false)

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
  // responders' actions arriving via the 30s poll, not just your own
  // clicks — which is what was making "Asignar" feel like it froze the tab.
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

  const saveMyUnit = (value) => {
    setMyUnit(value)
    localStorage.setItem(MY_UNIT_STORAGE_KEY, value)
  }

  if (activeModule !== 2) return null

  const displayedGroup = openGroup
    ? (onlyMyUnit && myUnit.trim()
        ? grouped[openGroup].filter((item) => (item.incident?.unit || "").trim().toLowerCase() === myUnit.trim().toLowerCase())
        : grouped[openGroup])
    : []

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

        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto" }}>
          <input value={myUnit} onChange={(e) => saveMyUnit(e.target.value)}
            placeholder={t("incidentMyUnitPlaceholder")}
            style={{ fontSize: "11px", padding: "5px 8px", borderRadius: "6px", border: `1px solid ${theme.border}`, width: "120px" }} />
          <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "11px", color: theme.textSecondary, cursor: "pointer" }}>
            <input type="checkbox" checked={onlyMyUnit} onChange={(e) => setOnlyMyUnit(e.target.checked)}
              disabled={!myUnit.trim()} />
            {t("incidentOnlyMyUnit")}
          </label>
        </div>
      </div>

      {openGroup && (
        <div style={{ marginTop: "8px", maxHeight: "160px", overflowY: "auto", border: `1px solid ${theme.border}`, borderRadius: "6px", background: "#fff" }}>
          {displayedGroup.length === 0 && (
            <div style={{ padding: "10px", fontSize: "12px", color: theme.textMuted }}>{t("incidentGroupEmpty")}</div>
          )}
          {displayedGroup.map(({ feature, fireKey, incident, lat, lon }) => (
            <IncidentRow key={fireKey} feature={feature} fireKey={fireKey} incident={incident} lat={lat} lon={lon}
              onSelectFire={onSelectFire} setIncidentStatus={setIncidentStatus} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}
