import { useEffect, useMemo, useState } from "react"
import { filterFeaturesByBbox } from "../utils/spatial"
import { buildCommandBrief } from "../utils/commandAnalysis"
import { reverseGeocodePlace } from "../utils/geocode"
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

function PriorityFireCard({ fire, index, t }) {
  const [place, setPlace] = useState(null)

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
    </div>
  )
}

export default function Sidebar({ activeModule, layers, mapZoom, mapRef, zoneInfo, responderType, onSelectFire }) {
  const { t } = useLanguage()
  const allDetections = layers.hotspots?.data?.features || []
  const fwiPoints = layers.fwi?.data?.features || []

  const zoneHotspots = useMemo(
    () => filterFeaturesByBbox(allDetections, zoneInfo?.zoneBbox),
    [allDetections, zoneInfo]
  )
  const countryHotspots = useMemo(
    () => filterFeaturesByBbox(allDetections, zoneInfo?.countryBbox),
    [allDetections, zoneInfo]
  )
  const stateHotspots = useMemo(
    () => filterFeaturesByBbox(allDetections, zoneInfo?.stateBbox),
    [allDetections, zoneInfo]
  )
  const zoneInfrastructure = useMemo(
    () => filterFeaturesByBbox(layers.infrastructure?.data?.features || [], zoneInfo?.zoneBbox),
    [layers.infrastructure?.data, zoneInfo]
  )
  const zonePerimeters = useMemo(
    () => filterFeaturesByBbox(layers.perimeters?.data?.features || [], zoneInfo?.zoneBbox),
    [layers.perimeters?.data, zoneInfo]
  )

  const zoneExtremeFires = useMemo(() => zoneHotspots.filter(f => f.properties.intensity === "extreme"), [zoneHotspots])
  const zoneHighFires = useMemo(() => zoneHotspots.filter(f => f.properties.intensity === "high"), [zoneHotspots])

  const totalDetectionsGlobal = allDetections.length
  const zoneHectares = zonePerimeters.reduce((sum, f) => sum + (f.properties.hectares || 0), 0)

  const flyTo = (feature) => {
    const [lon, lat] = feature.geometry.coordinates
    if (mapRef?.current) mapRef.current.setView([lat, lon], 13)
    onSelectFire?.(feature)
  }

  const brief = useMemo(() => buildCommandBrief({
    zoneHotspots, infraInZone: zoneInfrastructure, fwiPoints, responderType,
  }), [zoneHotspots, zoneInfrastructure, fwiPoints, responderType])

  const maxFWI = fwiPoints.reduce((max, f) =>
    (f.properties.fwi || 0) > (max?.properties?.fwi || 0) ? f : max, null)
  const escalatingZones = fwiPoints.filter(f => f.properties.trend === "escalating").length
  const extremeZones = fwiPoints.filter(f => f.properties.risk_class === "extreme").length
  const veryHighZones = fwiPoints.filter(f => f.properties.risk_class === "very_high").length

  return (
    <div style={{
      width: "270px", flexShrink: 0, background: theme.panelBg,
      borderLeft: `1px solid ${theme.border}`, padding: "12px",
      overflowY: "auto", display: "flex", flexDirection: "column",
    }}>
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
                <div style={{ color: theme.textSecondary, marginBottom: "8px", lineHeight: "1.5" }}>
                  {t("fociRequireAttention", { count: brief.priorityFires.length, zone: zoneInfo?.name })}
                  {!brief.hasInfraData && (
                    <span style={{ color: theme.orange }}> {t("noInfraDataYet")}</span>
                  )}
                </div>
                {brief.priorityFires.map((fire, i) => (
                  <PriorityFireCard key={i} fire={fire} index={i} t={t} />
                ))}
                {brief.actionLine && (
                  <div style={{
                    marginTop: "4px", background: theme.orangeSoft, border: `1px solid ${theme.orange}`,
                    borderRadius: "6px", padding: "8px", fontSize: "11.5px", color: "#8a4200", lineHeight: "1.5",
                  }}>
                    <strong>{t("recommendedAction")}</strong> {brief.actionLine}
                  </div>
                )}
              </>
            )}
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
