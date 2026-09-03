import { useEffect, useMemo, useState } from "react"
import { filterFeaturesByBbox } from "../utils/spatial"
import { loadCountryBoundaries, findCountryFeature, filterFeaturesByCountry } from "../utils/countryBoundaries"
import { buildCommandBrief, findThreatenedInfrastructure, windDirLabel } from "../utils/commandAnalysis"
import { reverseGeocodePlace } from "../utils/geocode"
import { fireKeyFromLatLon } from "../hooks/useIncidents"
import useZoneLandCover from "../hooks/useZoneLandCover"
import FireCommandPanel from "./FireCommandPanel"
import { theme } from "../utils/theme"
import { INTENSITY_COLORS } from "../utils/fireColors"
import { useLanguage } from "../context/LanguageContext"

function SectionTitle({ children }) {
  return (
    <div style={{
      color: theme.textMuted, fontSize: "11px", fontWeight: "bold",
      letterSpacing: "0.08em", marginTop: "16px", marginBottom: "6px",
      borderBottom: `1px solid ${theme.border}`, paddingBottom: "4px",
    }}>
      {children}
    </div>
  )
}

function StatRow({ label, value, color }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
      <span style={{ color: theme.textSecondary, fontSize: "12px" }}>{label}</span>
      <span style={{ color: color || theme.textPrimary, fontSize: "12px", fontWeight: "bold" }}>
        {value}
      </span>
    </div>
  )
}

// One fire in an expanded list: shows a name (lazily reverse-geocoded, only
// for smaller lists) or coordinates, and flies the map there when clicked.
function FireListItem({ feature, showName, onSelect }) {
  const [lon, lat] = feature.geometry.coordinates
  const { frp, intensity } = feature.properties
  const [place, setPlace] = useState(null)

  useEffect(() => {
    if (!showName) return
    let cancelled = false
    reverseGeocodePlace(lat, lon).then(p => { if (!cancelled) setPlace(p) })
    return () => { cancelled = true }
  }, [showName, lat, lon])

  const dotColor = INTENSITY_COLORS[intensity] || INTENSITY_COLORS.unknown

  return (
    <div onClick={() => onSelect(feature)}
      style={{ padding: "6px 8px", fontSize: "11px", cursor: "pointer", borderBottom: `1px solid ${theme.border}`,
        display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px" }}
      onMouseEnter={e => e.currentTarget.style.background = theme.orangeSoft}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      <span style={{ display: "flex", alignItems: "center", gap: "5px", color: theme.textPrimary, minWidth: 0 }}>
        <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {showName ? (place || `${lat.toFixed(3)}, ${lon.toFixed(3)}`) : `${lat.toFixed(3)}, ${lon.toFixed(3)}`}
        </span>
      </span>
      <span style={{ color: theme.textMuted, flexShrink: 0 }}>{frp ? frp + " MW" : ""}</span>
    </div>
  )
}

// A StatRow with a caret that expands into the list of fires behind that
// number. Clicking a fire in the list flies the map to it.
function ExpandableStatRow({ label, value, color, features, showNames, onSelect, t }) {
  const [open, setOpen] = useState(false)
  const CAP = 30
  const sorted = useMemo(
    () => [...features].sort((a, b) => (b.properties.frp || 0) - (a.properties.frp || 0)),
    [features]
  )
  const shown = sorted.slice(0, CAP)
  const hasItems = features.length > 0

  return (
    <div style={{ marginBottom: "5px" }}>
      <div
        onClick={() => hasItems && setOpen(o => !o)}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: hasItems ? "pointer" : "default" }}>
        <span style={{ color: theme.textSecondary, fontSize: "12px", display: "flex", alignItems: "center", gap: "5px" }}>
          {hasItems && (
            <span style={{ fontSize: "9px", color: theme.textMuted, display: "inline-block",
              transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>▸</span>
          )}
          {label}
        </span>
        <span style={{ color: color || theme.textPrimary, fontSize: "12px", fontWeight: "bold" }}>{value}</span>
      </div>
      {open && hasItems && (
        <div style={{ marginTop: "4px", marginBottom: "4px", maxHeight: "170px", overflowY: "auto",
          background: "#faf9f6", border: `1px solid ${theme.border}`, borderRadius: "6px" }}>
          {shown.map((f, i) => <FireListItem key={i} feature={f} showName={showNames} onSelect={onSelect} />)}
          {sorted.length > CAP && (
            <div style={{ padding: "5px 8px", fontSize: "10px", color: theme.textMuted }}>
              {t("showingTop", { n: CAP, total: sorted.length })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const FWI_LABELS = {
  low: { label: "LOW", color: "#38A800" },
  moderate: { label: "MODERATE", color: "#a8a800" },
  high: { label: "HIGH", color: "#FFAA00" },
  very_high: { label: "VERY HIGH", color: "#FF4400" },
  extreme: { label: "EXTREME", color: "#AA0000" },
}

function PriorityFireCard({ fire, index, t, incidents, onSelectFire }) {
  const [place, setPlace] = useState(null)
  const fireKey = fireKeyFromLatLon(fire.lat, fire.lon)
  const incident = incidents?.[fireKey] || null

  useEffect(() => {
    let cancelled = false
    reverseGeocodePlace(fire.lat, fire.lon).then(p => { if (!cancelled) setPlace(p) })
    return () => { cancelled = true }
  }, [fire.lat, fire.lon])

  const intensityColor = fire.intensity === "extreme" ? theme.danger : "#cc5500"

  return (
    <div style={{
      background: "#fff", border: `1px solid ${theme.border}`, borderLeft: `3px solid ${intensityColor}`,
      borderRadius: "6px", padding: "8px 10px", marginBottom: "8px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: "12.5px", fontWeight: "bold", color: theme.textPrimary }}>
          #{index + 1} {place || `${fire.lat.toFixed(3)}, ${fire.lon.toFixed(3)}`}
        </span>
        <span style={{ fontSize: "11px", fontWeight: "bold", color: intensityColor, textTransform: "uppercase" }}>
          {fire.intensity}
        </span>
      </div>
      <div style={{ fontSize: "11px", color: theme.textMuted, marginBottom: "5px" }}>
        {fire.lat.toFixed(4)}, {fire.lon.toFixed(4)} · FRP {fire.frp ? fire.frp + " MW" : "N/A"}
      </div>

      <div style={{ fontSize: "11.5px", color: theme.textSecondary, lineHeight: "1.7" }}>
        <div>🏥 {t("evacuateTo")}: {fire.nearestHospital
          ? `${fire.nearestHospital.name} (${fire.nearestHospital.km.toFixed(1)} km)`
          : t("noHospitalData")}</div>
        <div>🚒 {t("nearestUnit")}: {fire.nearestFireStation
          ? `${fire.nearestFireStation.name} (${fire.nearestFireStation.km.toFixed(1)} km)`
          : t("noStationData")}</div>
        <div>👮 {t("policeSupport")}: {fire.nearestPolice
          ? `${fire.nearestPolice.name} (${fire.nearestPolice.km.toFixed(1)} km)`
          : t("noStationData")}</div>
        <div>💨 {t("spreadRisk")}: {fire.windKmh != null
          ? t("windTrend", { wind: fire.windKmh.toFixed(0), dir: fire.windDir || "", trend: fire.fwiTrend || "N/A" })
          : t("noWindData")}</div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "6px" }}>
        <span style={{ fontSize: "11px", color: theme.textSecondary }}>
          {t("cmdPanelOverallStatus")}: <strong style={{ color: theme.textPrimary }}>{t("incidentStatus_" + (incident?.status || "unassigned"))}</strong>
        </span>
        <button onClick={() => onSelectFire?.({
            type: "Feature",
            geometry: { type: "Point", coordinates: [fire.lon, fire.lat] },
            properties: { frp: fire.frp, intensity: fire.intensity, source: fire.source, acq_datetime: fire.acq_datetime },
          })}
          style={{ fontSize: "10.5px", padding: "3px 8px", borderRadius: "4px", cursor: "pointer",
            border: `1px solid ${theme.orange}`, background: "#fff", color: theme.orange, fontWeight: "bold" }}>
          {t("incidentAttend")}
        </button>
      </div>
    </div>
  )
}

const INFRA_ICON = {
  "Hospital": "🏥", "Clinic": "🏥", "Fire Station": "🚒", "Police Station": "👮",
  "School (shelter)": "🏫", "Power Substation": "⚡", "Power Plant": "⚡",
  "Airport/Airfield": "✈️", "Water Reservoir": "💧",
}

function ThreatenedInfraCard({ threat, t, onSelectFire }) {
  const { infra, fire, distanceKm, windAligned, windKmh } = threat
  const dir = windDirLabel((threat.bearingDeg + 180) % 360) // direction FROM infra back toward the fire, for "wind coming from X" phrasing

  return (
    <div onClick={() => onSelectFire(fire)} style={{
      background: "#fff", border: `1px solid ${theme.border}`,
      borderLeft: `3px solid ${windAligned ? theme.danger : theme.orange}`,
      borderRadius: "6px", padding: "8px 10px", marginBottom: "8px", cursor: "pointer",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: "12.5px", fontWeight: "bold", color: theme.textPrimary }}>
          {INFRA_ICON[infra.properties.type] || "📍"} {infra.properties.name || infra.properties.type}
        </span>
        <span style={{ fontSize: "11px", fontWeight: "bold", color: windAligned ? theme.danger : theme.orange }}>
          {distanceKm.toFixed(1)} km
        </span>
      </div>
      <div style={{ fontSize: "11px", color: theme.textMuted, marginTop: "2px", lineHeight: "1.5" }}>
        {windAligned
          ? t("windPushingToward", { dir, wind: windKmh != null ? windKmh.toFixed(0) : "?" })
          : t("closeToFire")}
      </div>
    </div>
  )
}

export default function Sidebar({ activeModule, layers, mapZoom, mapRef, zoneInfo, responderType, onSelectFire, hideNonVegetation, incidents, requestResponder, selectedFire, onClearSelection, zoneInfrastructure = [], onClose }) {
  const { t } = useLanguage()
  const rawDetections = layers.hotspots?.data?.features || []
  const allDetections = rawDetections
  const fwiPoints = layers.fwi?.data?.features || []

  const zoneHotspotsRaw = useMemo(
    () => filterFeaturesByBbox(allDetections, zoneInfo?.zoneBbox),
    [allDetections, zoneInfo]
  )
  const [countryFeature, setCountryFeature] = useState(null)
  useEffect(() => {
    if (!zoneInfo?.country) { setCountryFeature(null); return }
    let cancelled = false
    loadCountryBoundaries()
      .then((boundaries) => {
        if (!cancelled) setCountryFeature(findCountryFeature(boundaries, zoneInfo.country))
      })
      .catch(() => { if (!cancelled) setCountryFeature(null) })
    return () => { cancelled = true }
  }, [zoneInfo?.country])

  const countryHotspotsRaw = useMemo(() => {
    // Prefer the real country polygon (accurate at borders) — a padded box
    // around the searched point will happily include the neighboring
    // country if the search point is near a border (e.g. Boston -> Quebec).
    // Only fall back to the bbox approximation if this country isn't in our
    // simplified boundary dataset.
    const byPolygon = filterFeaturesByCountry(allDetections, countryFeature)
    if (byPolygon !== null) return byPolygon
    return filterFeaturesByBbox(allDetections, zoneInfo?.countryBbox)
  }, [allDetections, countryFeature, zoneInfo])
  const stateHotspotsRaw = useMemo(
    () => filterFeaturesByBbox(allDetections, zoneInfo?.stateBbox),
    [allDetections, zoneInfo]
  )

  // Classifies the country-scoped list (the widest of the three — state
  // and zone are subsets of it almost always) and reuses one classification
  // pass for all three displayed counts instead of firing it three times
  // over overlapping point sets. Capped at 1500 candidates (prioritized by
  // FRP, matching the same ceiling FireMap's own on-demand classification
  // uses) — a country's active-fire count is usually well under that, but
  // a very active country on a bad day could exceed it; anything past the
  // cap just doesn't get classified this pass and stays fail-open (shown,
  // not hidden) rather than the request itself failing outright.
  const landCoverCandidates = useMemo(() => {
    const capped = countryHotspotsRaw.length <= 1500
      ? countryHotspotsRaw
      : [...countryHotspotsRaw].sort((a, b) => (b.properties.frp || 0) - (a.properties.frp || 0)).slice(0, 1500)
    return capped.map((f) => {
      const [lon, lat] = f.geometry.coordinates
      return { fireKey: fireKeyFromLatLon(lat, lon), lat, lon }
    })
  }, [countryHotspotsRaw])
  const { classifications: landCoverByFireKey } = useZoneLandCover(landCoverCandidates, hideNonVegetation)

  const applyVegetationFilter = (features) => {
    if (!hideNonVegetation) return features
    return features.filter((f) => {
      const [lon, lat] = f.geometry.coordinates
      const category = landCoverByFireKey[fireKeyFromLatLon(lat, lon)]
      // Not yet classified (still fetching, or beyond the 1500 cap above)
      // -> undefined -> falls through to "keep it", same fail-open
      // principle used everywhere else this heuristic appears.
      return category !== "urbano" && category !== "otro"
    })
  }

  const zoneHotspots = useMemo(() => applyVegetationFilter(zoneHotspotsRaw), [zoneHotspotsRaw, hideNonVegetation, landCoverByFireKey])
  const countryHotspots = useMemo(() => applyVegetationFilter(countryHotspotsRaw), [countryHotspotsRaw, hideNonVegetation, landCoverByFireKey])
  const stateHotspots = useMemo(() => applyVegetationFilter(stateHotspotsRaw), [stateHotspotsRaw, hideNonVegetation, landCoverByFireKey])
  // zoneInfrastructure now arrives as a prop from App.jsx's
  // useZoneInfrastructure — bundled world-crawl data if it covers this
  // zone, live Overpass fallback otherwise. Used to just be bbox-filtered
  // straight off the raw global bundled layer here, which meant zones
  // outside crawled coverage silently got an empty infrastructure list
  // (no nearest hospital/fire station suggestions at all) instead of the
  // live-fetched real answer FireCommandPanel now also relies on.
  const zonePerimeters = useMemo(
    () => filterFeaturesByBbox(layers.perimeters?.data?.features || [], zoneInfo?.zoneBbox),
    [layers.perimeters?.data, zoneInfo]
  )

  const zoneExtremeFires = useMemo(() => zoneHotspots.filter(f => f.properties.intensity === "extreme"), [zoneHotspots])
  const zoneHighFires = useMemo(() => zoneHotspots.filter(f => f.properties.intensity === "high"), [zoneHotspots])

  const totalDetectionsGlobal = allDetections.length
  const zoneHectares = zonePerimeters.reduce((sum, f) => sum + (f.properties.hectares || 0), 0)

  const flyTo = (feature) => onSelectFire?.(feature)

  const brief = useMemo(() => buildCommandBrief({
    zoneHotspots, infraInZone: zoneInfrastructure, fwiPoints, responderType,
  }), [zoneHotspots, zoneInfrastructure, fwiPoints, responderType])

  // Avoid showing the same fire's description twice: once as a card in
  // this AI-generated priority list, and again in the FireCommandPanel
  // below (which is what the EOC actually uses to assign responders).
  // When a fire is selected, its card is dropped from this list — the
  // priority list still covers every OTHER fire needing attention, just
  // not the one already fully shown lower down.
  const priorityFires = useMemo(() => {
    if (!selectedFire) return brief.priorityFires
    const [selLon, selLat] = selectedFire.geometry.coordinates
    const selectedKey = fireKeyFromLatLon(selLat, selLon)
    return brief.priorityFires.filter((fire) => fireKeyFromLatLon(fire.lat, fire.lon) !== selectedKey)
  }, [brief.priorityFires, selectedFire])

  // Scoped to just the SELECTED fire once one is picked (updates every
  // time a different fire is selected) — this section now lives after
  // the assignment panel specifically so the EOC sees "what's at risk
  // from THIS fire" right where they're deciding what to send. Falls
  // back to the old zone-wide view when nothing's selected yet, so the
  // section isn't simply empty before the EOC has picked a focus.
  const threatenedInfra = useMemo(() => findThreatenedInfrastructure({
    zoneHotspots: selectedFire ? [selectedFire] : zoneHotspots, infraInZone: zoneInfrastructure, fwiPoints,
  }), [zoneHotspots, zoneInfrastructure, fwiPoints, selectedFire])

  const maxFWI = fwiPoints.reduce((max, f) =>
    (f.properties.fwi || 0) > (max?.properties?.fwi || 0) ? f : max, null)
  const escalatingZones = fwiPoints.filter(f => f.properties.trend === "escalating").length
  const extremeZones = fwiPoints.filter(f => f.properties.risk_class === "extreme").length
  const veryHighZones = fwiPoints.filter(f => f.properties.risk_class === "very_high").length

  return (
    <div style={{
      width: "270px", maxWidth: "90vw", height: "100%", flexShrink: 0, background: theme.panelBg,
      borderLeft: `1px solid ${theme.border}`, padding: "12px",
      overflowY: "auto", display: "flex", flexDirection: "column",
    }}>
      {onClose && (
        <button onClick={onClose} style={{
          alignSelf: "flex-end", border: "none", background: "none", cursor: "pointer",
          fontSize: "18px", color: theme.textMuted, padding: "0 0 8px 0", lineHeight: 1,
        }}>
          ✕
        </button>
      )}
      <div style={{
        background: activeModule === 1 ? theme.navySoft : theme.orangeSoft,
        border: `1px solid ${activeModule === 1 ? theme.navy : theme.orange}`,
        borderRadius: "6px", padding: "8px", marginBottom: "4px", textAlign: "center",
      }}>
        <div style={{ fontSize: "13px", fontWeight: "bold", color: theme.textPrimary }}>
          {activeModule === 1 ? t("preFireView") : t("activeFireView")}
        </div>
        <div style={{ fontSize: "11px", color: theme.textSecondary, marginTop: "2px" }}>
          {activeModule === 1 ? t("module1Sub") : t("module2Sub")}
        </div>
      </div>

      {activeModule === 2 && (
        <>
          <SectionTitle>{t("activeFiresTitle")}</SectionTitle>
          <StatRow label={t("totalWorldwide")} value={totalDetectionsGlobal.toLocaleString()} />
          <ExpandableStatRow
            label={t("inLabel", { name: zoneInfo?.country || "—" })}
            value={countryHotspots.length.toLocaleString()}
            features={countryHotspots} showNames={false} onSelect={flyTo} t={t} />
          <ExpandableStatRow
            label={t("inLabel", { name: zoneInfo?.state || "—" })}
            value={stateHotspots.length.toLocaleString()}
            features={stateHotspots} showNames={false} onSelect={flyTo} t={t} />
          <ExpandableStatRow
            label={t("inLabel", { name: zoneInfo?.name || "—" })}
            value={zoneHotspots.length.toLocaleString()} color={theme.orange}
            features={zoneHotspots} showNames={true} onSelect={flyTo} t={t} />
          <ExpandableStatRow
            label={t("extremeIntensityZone")} value={zoneExtremeFires.length} color={theme.danger}
            features={zoneExtremeFires} showNames={true} onSelect={flyTo} t={t} />
          <ExpandableStatRow
            label={t("highIntensityZone")} value={zoneHighFires.length} color="#cc5500"
            features={zoneHighFires} showNames={true} onSelect={flyTo} t={t} />
          <StatRow
            label={t("totalBurnedArea")}
            value={zoneHectares > 0 ? Math.round(zoneHectares).toLocaleString() + " ha" : "N/A"}
            color="#cc5500"
          />

          <SectionTitle>{t("situationSummaryTitle")}</SectionTitle>
          <div style={{
            background: "#fff", border: `1px solid ${theme.border}`,
            borderRadius: "6px", padding: "10px", fontSize: "12px",
          }}>
            {layers.hotspots?.loading ? (
              <span style={{ color: theme.textSecondary }}>{t("loadingFireData")}</span>
            ) : brief.empty ? (
              <span style={{ color: theme.textSecondary }}>
                {t("noActiveFires", { zone: zoneInfo?.name })}
              </span>
            ) : (
              <>
                {priorityFires.length > 0 && (
                  <div style={{ color: theme.textSecondary, marginBottom: "8px", lineHeight: "1.5" }}>
                    {t("fociRequireAttention", { count: priorityFires.length, zone: zoneInfo?.name })}
                    {!brief.hasInfraData && (
                      <span style={{ color: theme.orange }}> {t("noInfraDataYet")}</span>
                    )}
                  </div>
                )}
                {priorityFires.map((fire, i) => (
                  <PriorityFireCard key={i} fire={fire} index={i} t={t} incidents={incidents}
                    onSelectFire={flyTo} />
                ))}
              </>
            )}
          </div>
        </>
      )}

      {activeModule === 2 && selectedFire && (
        <>
          <SectionTitle>{t("situationSummaryTitle")}</SectionTitle>
          <FireCommandPanel selectedFire={selectedFire} incidents={incidents}
            requestResponder={requestResponder} infraFeatures={zoneInfrastructure}
            responderType={responderType} onClose={() => onClearSelection?.()} />
        </>
      )}

      {activeModule === 2 && threatenedInfra.length > 0 && (
        <>
          <SectionTitle>{t("threatenedInfraTitle")}</SectionTitle>
          <div style={{
            background: "#fff", border: `1px solid ${theme.border}`,
            borderRadius: "6px", padding: "10px", fontSize: "12px",
          }}>
            <div style={{ color: theme.textSecondary, marginBottom: "8px", lineHeight: "1.5" }}>
              {t("threatenedInfraCount", { count: threatenedInfra.length })}
            </div>
            {threatenedInfra.slice(0, 10).map((threat, i) => (
              <ThreatenedInfraCard key={i} threat={threat} t={t} onSelectFire={flyTo} />
            ))}
          </div>
        </>
      )}

      {activeModule === 1 && (
        <>
          <SectionTitle>{t("fwiTitle")}</SectionTitle>
          {maxFWI && (
            <div style={{ marginBottom: "8px" }}>
              <div style={{ color: theme.textSecondary, fontSize: "11px", marginBottom: "3px" }}>
                {t("highestFWI")}
              </div>
              <div style={{
                fontSize: "28px", fontWeight: "bold",
                color: FWI_LABELS[maxFWI.properties.risk_class]?.color || theme.textPrimary,
              }}>
                {maxFWI.properties.fwi}
              </div>
              <div style={{
                fontSize: "13px", fontWeight: "bold",
                color: FWI_LABELS[maxFWI.properties.risk_class]?.color || theme.textPrimary,
              }}>
                {FWI_LABELS[maxFWI.properties.risk_class]?.label || "UNKNOWN"}
              </div>
              <div style={{ color: theme.textMuted, fontSize: "11px", marginTop: "2px" }}>
                at {maxFWI.properties.lat}, {maxFWI.properties.lon}
              </div>
            </div>
          )}

          <StatRow
            label={t("extremeRiskZones")}
            value={extremeZones}
            color={extremeZones > 0 ? theme.danger : "#38A800"}
          />
          <StatRow
            label={t("veryHighRiskZones")}
            value={veryHighZones}
            color={veryHighZones > 0 ? "#FF4400" : "#38A800"}
          />
          <StatRow
            label={t("escalatingZones")}
            value={escalatingZones}
            color={escalatingZones > 0 ? theme.orange : "#38A800"}
          />

          <SectionTitle>{t("forecastAlertTitle")}</SectionTitle>
          <div style={{
            background: extremeZones > 0 ? theme.dangerSoft : theme.greenSoft,
            border: "1px solid " + (extremeZones > 0 ? theme.danger : "#2e7d32"),
            borderRadius: "6px", padding: "8px", fontSize: "12px",
            lineHeight: "1.6", color: extremeZones > 0 ? "#7a1a15" : "#1b5e20",
          }}>
            {layers.fwi?.loading
              ? t("computingFWI")
              : extremeZones > 0
              ? extremeZones + " " + t("extremeRiskZones").toLowerCase() + ". " + (escalatingZones > 0 ? escalatingZones + " " + t("escalatingZones").toLowerCase() + ". " : "") + t("preposition")
              : veryHighZones > 0
              ? veryHighZones + " " + t("veryHighRiskZones").toLowerCase() + ". " + t("monitorClosely")
              : t("manageable")}
          </div>
        </>
      )}

      {Object.entries(layers).some(([, v]) => v.error) && (
        <>
          <SectionTitle>{t("dataErrorsTitle")}</SectionTitle>
          {Object.entries(layers).filter(([, v]) => v.error).map(([key, v]) => (
            <div key={key} style={{ color: theme.danger, fontSize: "11px", marginBottom: "4px" }}>
              {key}: {v.error}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
