import { useEffect, useMemo, useState } from "react"
import { filterFeaturesByBbox } from "../utils/spatial"
import { buildCommandBrief } from "../utils/commandAnalysis"
import { reverseGeocodePlace } from "../utils/geocode"
import { theme } from "../utils/theme"

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

const FWI_LABELS = {
  low: { label: "LOW", color: "#38A800" },
  moderate: { label: "MODERATE", color: "#a8a800" },
  high: { label: "HIGH", color: "#FFAA00" },
  very_high: { label: "VERY HIGH", color: "#FF4400" },
  extreme: { label: "EXTREME", color: "#AA0000" },
}

function PriorityFireCard({ fire, index }) {
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
        <div>🏥 Evacuar hacia: {fire.nearestHospital
          ? `${fire.nearestHospital.name} (${fire.nearestHospital.km.toFixed(1)} km)`
          : "sin dato de hospital en la zona"}</div>
        <div>🚒 Unidad más cercana: {fire.nearestFireStation
          ? `${fire.nearestFireStation.name} (${fire.nearestFireStation.km.toFixed(1)} km)`
          : "sin dato de estación en la zona"}</div>
        <div>👮 Apoyo policial: {fire.nearestPolice
          ? `${fire.nearestPolice.name} (${fire.nearestPolice.km.toFixed(1)} km)`
          : "sin dato de estación en la zona"}</div>
        <div>💨 Propagación: {fire.windKmh != null
          ? `viento ${fire.windKmh.toFixed(0)} km/h ${fire.windDir || ""}, tendencia FWI ${fire.fwiTrend || "N/A"}`
          : "sin dato de viento cercano"}</div>
      </div>
    </div>
  )
}

export default function Sidebar({ activeModule, layers, mapZoom, zoneInfo, responderType }) {
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

  const totalDetectionsGlobal = allDetections.length
  const zoneExtreme = zoneHotspots.filter(f => f.properties.intensity === "extreme").length
  const zoneHigh = zoneHotspots.filter(f => f.properties.intensity === "high").length
  const zoneHectares = zonePerimeters.reduce((sum, f) => sum + (f.properties.hectares || 0), 0)

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
          {activeModule === 1 ? "Pre-Fire Risk View" : "Active Fire View"}
        </div>
        <div style={{ fontSize: "11px", color: theme.textSecondary, marginTop: "2px" }}>
          {activeModule === 1 ? "Module 1 - FWI Forecast" : "Module 2 - Command Center"}
        </div>
      </div>

      {activeModule === 2 && (
        <>
          <SectionTitle>ACTIVE FIRES</SectionTitle>
          <StatRow label="Total detections (worldwide)" value={totalDetectionsGlobal.toLocaleString()} />
          <StatRow label={`In ${zoneInfo?.country || "country"}`} value={countryHotspots.length.toLocaleString()} />
          <StatRow label={`In ${zoneInfo?.state || "state"}`} value={stateHotspots.length.toLocaleString()} />
          <StatRow label={`In ${zoneInfo?.name || "monitored zone"}`} value={zoneHotspots.length.toLocaleString()} color={theme.orange} />
          <StatRow label="Extreme intensity (zone)" value={zoneExtreme} color={theme.danger} />
          <StatRow label="High intensity (zone)" value={zoneHigh} color="#cc5500" />
          <StatRow
            label="Total burned area (zone)"
            value={zoneHectares > 0 ? Math.round(zoneHectares).toLocaleString() + " ha" : "N/A"}
            color="#cc5500"
          />

          <SectionTitle>SITUATION SUMMARY</SectionTitle>
          <div style={{
            background: "#fff", border: `1px solid ${theme.border}`,
            borderRadius: "6px", padding: "10px", fontSize: "12px",
          }}>
            {layers.hotspots?.loading ? (
              <span style={{ color: theme.textSecondary }}>Cargando datos de incendios...</span>
            ) : brief.empty ? (
              <span style={{ color: theme.textSecondary }}>
                No hay focos activos en {zoneInfo?.name}. Vigilancia continua sobre FIRMS (actualización horaria).
              </span>
            ) : (
              <>
                <div style={{ color: theme.textSecondary, marginBottom: "8px", lineHeight: "1.5" }}>
                  {brief.priorityFires.length} foco(s) requieren atención prioritaria en {zoneInfo?.name}.
                  {!brief.hasInfraData && (
                    <span style={{ color: theme.orange }}> Aún no hay datos de infraestructura mapeados para esta zona.</span>
                  )}
                </div>
                {brief.priorityFires.map((fire, i) => (
                  <PriorityFireCard key={i} fire={fire} index={i} />
                ))}
                {brief.actionLine && (
                  <div style={{
                    marginTop: "4px", background: theme.orangeSoft, border: `1px solid ${theme.orange}`,
                    borderRadius: "6px", padding: "8px", fontSize: "11.5px", color: "#8a4200", lineHeight: "1.5",
                  }}>
                    <strong>Acción recomendada:</strong> {brief.actionLine}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {activeModule === 1 && (
        <>
          <SectionTitle>FIRE WEATHER INDEX</SectionTitle>
          {maxFWI && (
            <div style={{ marginBottom: "8px" }}>
              <div style={{ color: theme.textSecondary, fontSize: "11px", marginBottom: "3px" }}>
                Highest FWI detected:
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
            label="Extreme risk zones"
            value={extremeZones}
            color={extremeZones > 0 ? theme.danger : "#38A800"}
          />
          <StatRow
            label="Very high risk zones"
            value={veryHighZones}
            color={veryHighZones > 0 ? "#FF4400" : "#38A800"}
          />
          <StatRow
            label="Escalating zones"
            value={escalatingZones}
            color={escalatingZones > 0 ? theme.orange : "#38A800"}
          />

          <SectionTitle>FORECAST ALERT</SectionTitle>
          <div style={{
            background: extremeZones > 0 ? theme.dangerSoft : theme.greenSoft,
            border: "1px solid " + (extremeZones > 0 ? theme.danger : "#2e7d32"),
            borderRadius: "6px", padding: "8px", fontSize: "12px",
            lineHeight: "1.6", color: extremeZones > 0 ? "#7a1a15" : "#1b5e20",
          }}>
            {layers.fwi?.loading
              ? "Computing FWI..."
              : extremeZones > 0
              ? extremeZones + " zone(s) at EXTREME fire danger. " + (escalatingZones > 0 ? escalatingZones + " zone(s) escalating. " : "") + "Consider pre-positioning resources."
              : veryHighZones > 0
              ? veryHighZones + " zone(s) at VERY HIGH fire danger. Monitor conditions closely."
              : "Current fire weather conditions are within manageable range."}
          </div>
        </>
      )}

      {Object.entries(layers).some(([, v]) => v.error) && (
        <>
          <SectionTitle>DATA ERRORS</SectionTitle>
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
