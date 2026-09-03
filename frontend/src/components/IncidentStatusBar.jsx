import { useState, useEffect, useMemo, useRef } from "react"
import { loadCountryBoundaries, findCountryFeature, filterFeaturesByCountry } from "../utils/countryBoundaries"
import { filterFeaturesByBbox } from "../utils/spatial"
import { fireKeyFromLatLon } from "../hooks/useIncidents"
import { GROUP_META, isDispatchableGroup } from "../utils/responderGroups"
import { playAlarmChime } from "../utils/alarm"
import { theme } from "../utils/theme"
import { useLanguage } from "../context/LanguageContext"

// Six buckets now instead of four: a single fire can have several
// responder groups in flight at once (a bombero already attending while
// EMS is still just accepted, say), so the bar tracks each GROUP'S own
// request status independently rather than collapsing a whole fire into
// one status. "Sin asignar" is the one exception — it's about fires with
// no requests at all, so it's still counted per-fire.
const STATUS_ORDER = ["unassigned", "assigned", "accepted", "rejected", "attending", "resolved"]
const STATUS_COLOR = {
  unassigned: theme.textMuted,
  assigned: theme.orange,
  accepted: theme.navy,
  rejected: "#c2410c",
  attending: theme.danger,
  resolved: theme.navy,
}
// Maps a single request's own status to which bucket/column it belongs
// in. "exhausted" (candidates ran out after repeated rejection, from
// before rejections required EOC re-assignment) folds into the same
// "Rechazado" bucket — both mean "needs the EOC's attention to pick a
// new unit", just via a different history.
const REQUEST_STATUS_TO_BUCKET = {
  pending: "assigned", accepted: "accepted", rejected: "rejected",
  exhausted: "rejected", attending: "attending", resolved: "resolved",
}
const REQ_STATUS_COLOR = {
  pending: theme.orange, accepted: theme.navy, rejected: "#c2410c",
  attending: theme.danger, resolved: theme.textMuted, exhausted: "#c2410c",
}

// One row in an expanded status bucket. Unlike a fire-level summary, this
// only renders chips for the responder groups that actually belong in the
// bucket currently open — a fire with bombero=atendiendo and EMS=aceptado
// shows up in BOTH the "Atendiendo" and "Aceptado" tabs, but each time
// only with the one chip relevant to that tab, matching how asynchronous
// each group's own progress really is (the EOC opens "Atendiendo" to see
// who's actually on scene right now, not everything ever requested for
// that fire).
function IncidentRow({ feature, fireKey, matchingGroups, onSelectFire, releaseIncident, t }) {
  const [busy, setBusy] = useState(false)
  const [lat, lon] = [feature.geometry.coordinates[1], feature.geometry.coordinates[0]]

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
          {matchingGroups.length > 0 && (
            <button disabled={busy} onClick={release}
              style={{ fontSize: "10.5px", padding: "2px 7px", borderRadius: "4px", cursor: "pointer",
                border: `1px solid ${theme.border}`, background: "#fff", color: theme.textSecondary }}>
              {t("incidentRelease")}
            </button>
          )}
        </span>
      </div>
      {matchingGroups.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginTop: "5px" }}>
          {matchingGroups.map(([g, req]) => (
            <span key={g} style={{
              fontSize: "10px", padding: "2px 6px", borderRadius: "10px",
              border: `1px solid ${REQ_STATUS_COLOR[req.status] || theme.border}`,
              color: REQ_STATUS_COLOR[req.status] || theme.textSecondary,
            }}>
              {GROUP_META[g].icon} {req.targetName} — {t("reqStatus_" + req.status)}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default function IncidentStatusBar({ activeModule, layers, zoneInfo, incidents, releaseIncident, onSelectFire, responderType, myFacility, hideNonVegetation, landCoverByFireKey = {} }) {
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
  const countryHotspotsRaw = useMemo(() => {
    const byPolygon = filterFeaturesByCountry(allDetections, countryFeature)
    if (byPolygon !== null) return byPolygon
    return filterFeaturesByBbox(allDetections, zoneInfo?.countryBbox)
  }, [allDetections, countryFeature, zoneInfo])

  // landCoverByFireKey arrives as a prop (computed once in App.jsx,
  // shared with FireMap and Sidebar too) — this bar used to build its
  // "Sin asignar/Asignado/..." buckets from the unfiltered country list
  // with no connection to "Solo focos forestales" at all, which is why
  // toggling that filter changed the map and Sidebar's counts but left
  // this bar's numbers exactly the same.
  const countryHotspots = useMemo(() => {
    if (!hideNonVegetation) return countryHotspotsRaw
    return countryHotspotsRaw.filter((f) => {
      const [lon, lat] = f.geometry.coordinates
      const category = landCoverByFireKey[fireKeyFromLatLon(lat, lon)]
      return category !== "urbano" && category !== "otro"
    })
  }, [countryHotspotsRaw, hideNonVegetation, landCoverByFireKey])

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
      return { feature, fireKey: fireKeyFromLatLon(lat, lon) }
    })
  }, [countryHotspots])

  // EOC alarm: a brief chime + an 8s highlight on the "Sin asignar" pill
  // the moment a fire that WASN'T in the previous country-scoped snapshot
  // shows up (a fresh FIRMS detection, not just "there are unassigned
  // fires" in general — that's always true on a busy day and would make
  // this fire constantly). Deliberately scoped to the currently-viewed
  // country (same reason the whole bar already is) — alarming on "a new
  // fire somewhere on Earth" would fire on nearly every poll, since
  // that's true globally almost all the time.
  const isEOC = responderType === "eoc"
  const seenFireKeysRef = useRef(null)
  const [newFireAlarm, setNewFireAlarm] = useState(false)
  const newFireTimeoutRef = useRef(null)

  // Switching country resets the baseline instead of comparing against
  // the PREVIOUS country's fires — otherwise every fire in a newly-viewed
  // country would look "new" and trigger a false mass alarm.
  useEffect(() => {
    seenFireKeysRef.current = null
    setNewFireAlarm(false)
  }, [zoneInfo?.country])

  useEffect(() => {
    if (!isEOC) return
    const currentKeys = new Set(keyedHotspots.map((item) => item.fireKey))
    if (seenFireKeysRef.current === null) {
      seenFireKeysRef.current = currentKeys // first snapshot for this country — nothing to compare yet
      return
    }
    let hasNew = false
    for (const key of currentKeys) {
      if (!seenFireKeysRef.current.has(key)) { hasNew = true; break }
    }
    seenFireKeysRef.current = currentKeys
    if (hasNew) {
      playAlarmChime()
      setNewFireAlarm(true)
      clearTimeout(newFireTimeoutRef.current)
      newFireTimeoutRef.current = setTimeout(() => setNewFireAlarm(false), 8000)
    }
  }, [keyedHotspots, isEOC])

  useEffect(() => () => clearTimeout(newFireTimeoutRef.current), [])

  // A fire with, say, bombero=attending and ems=accepted lands in BOTH the
  // "Atendiendo" and "Aceptado" buckets — once each, carrying only the
  // group(s) that actually belong in that specific bucket. Counts on the
  // pill buttons follow the same unit: "Sin asignar" counts FIRES (there's
  // no per-group request to count yet), every other bucket counts
  // individual group-requests, since that's what the EOC is really asking
  // "how many of these do I have right now".
  const grouped = useMemo(() => {
    const buckets = { unassigned: [], assigned: [], accepted: [], rejected: [], attending: [], resolved: [] }
    for (const item of keyedHotspots) {
      const incident = incidents?.[item.fireKey]
      const requests = incident?.requests || {}
      const entries = Object.entries(requests)
      if (entries.length === 0) {
        buckets.unassigned.push({ ...item, matchingGroups: [] })
        continue
      }
      const byBucket = {}
      for (const [group, req] of entries) {
        const bucket = REQUEST_STATUS_TO_BUCKET[req.status]
        if (!bucket) continue
        ;(byBucket[bucket] ||= []).push([group, req])
      }
      for (const [bucket, matchingGroups] of Object.entries(byBucket)) {
        buckets[bucket].push({ ...item, matchingGroups })
      }
    }
    return buckets
  }, [keyedHotspots, incidents])

  // Counting unit differs by bucket, on purpose: "Asignado"/"Aceptado"/
  // "Atendiendo"/"Resuelto" count FIRES (a fire with both bombero and EMS
  // attending is still just ONE fire being attended — counting it twice
  // made "2" look like two different fires when expanding the tab showed
  // only one). "Rechazado" is the deliberate exception: it counts
  // individual REJECTIONS, because the same fire being turned down by two
  // different groups really is two separate problems the EOC needs to
  // notice and act on separately, not one. grouped[status] already holds
  // exactly one entry per fire (with matchingGroups listing everyone
  // relevant within that bucket), so fire-based counting is just the
  // entry count — no separate computation needed.
  const countFor = (status) => status === "unassigned"
    ? grouped.unassigned.length
    : status === "rejected"
      ? grouped.rejected.reduce((sum, item) => sum + item.matchingGroups.length, 0)
      : grouped[status].length

  // Responder alarm: when the viewer is a dispatchable group with a
  // facility picked, the "Asignado" pill stops being a country-wide count
  // (not actionable for one bombero or hospital) and instead becomes
  // "Request" — how many of MY OWN group's requests are still pending —
  // blinking continuously while that's above zero, matching "no se pierda
  // de vista mientras tenga algo pendiente".
  const myPendingItems = useMemo(() => {
    if (!isDispatchableGroup(responderType) || !myFacility) return null
    return grouped.assigned
      .map((item) => {
        const mine = item.matchingGroups.filter(([g, req]) => g === responderType && req.targetId === myFacility.id)
        return mine.length > 0 ? { ...item, matchingGroups: mine } : null
      })
      .filter(Boolean)
  }, [grouped.assigned, responderType, myFacility])

  const isMyRequestsView = myPendingItems !== null

  if (activeModule !== 2) return null

  const displayedGroup = openGroup === "assigned" && isMyRequestsView
    ? myPendingItems
    : (openGroup ? grouped[openGroup] : [])

  return (
    <div style={{ borderBottom: `1px solid ${theme.border}`, background: theme.panelBgSoft, padding: "8px 16px" }}>
      <style>{`
        @keyframes fw-status-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
      `}</style>
      <div style={{ display: "flex", gap: "8px", alignItems: "stretch", flexWrap: "wrap" }}>
        {STATUS_ORDER.map((status) => {
          // "assigned" gets swapped out entirely for a responder-scoped
          // "Request" view when the viewer has a facility picked — same
          // slot in the bar, different meaning, since "how many fires in
          // the country are pending" isn't actionable for one bombero.
          const isAssignedSlot = status === "assigned"
          const count = isAssignedSlot && isMyRequestsView ? myPendingItems.length : countFor(status)
          const label = isAssignedSlot && isMyRequestsView ? t("reqPendingLabel") : t("incidentStatus_" + status)
          const blinking = (isAssignedSlot && isMyRequestsView && count > 0) || (status === "unassigned" && newFireAlarm)
          const isOpen = openGroup === status
          return (
            <button key={status}
              onClick={() => setOpenGroup(isOpen ? null : status)}
              style={{
                minWidth: "92px", padding: "6px 12px", borderRadius: "8px", cursor: "pointer",
                border: `2px solid ${isOpen ? STATUS_COLOR[status] : theme.border}`,
                background: isOpen ? STATUS_COLOR[status] + "22" : "#fff",
                textAlign: "left",
                animation: blinking ? "fw-status-blink 1s ease-in-out infinite" : "none",
              }}>
              <div style={{ fontSize: "18px", fontWeight: "bold", color: STATUS_COLOR[status] }}>{count}</div>
              <div style={{ fontSize: "11px", color: theme.textSecondary }}>{label}</div>
            </button>
          )
        })}
      </div>

      {openGroup && (
        <div style={{ marginTop: "8px", maxHeight: "220px", overflowY: "auto", border: `1px solid ${theme.border}`, borderRadius: "6px", background: "#fff" }}>
          {displayedGroup.length === 0 && (
            <div style={{ padding: "10px", fontSize: "12px", color: theme.textMuted }}>{t("incidentGroupEmpty")}</div>
          )}
          {displayedGroup.map(({ feature, fireKey, matchingGroups }, i) => (
            <IncidentRow key={fireKey + "-" + i} feature={feature} fireKey={fireKey} matchingGroups={matchingGroups}
              onSelectFire={onSelectFire} releaseIncident={releaseIncident} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}
