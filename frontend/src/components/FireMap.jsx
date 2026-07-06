import { useState, useEffect, useMemo } from "react"
import { MapContainer, TileLayer, CircleMarker, GeoJSON, Popup, Tooltip, useMap, Marker } from "react-leaflet"
import L from "leaflet"
import { filterFeaturesByBbox } from "../utils/spatial"
import { reverseGeocodePlace } from "../utils/geocode"
import { loadZoneInfrastructure } from "../utils/liveInfra"
import { theme } from "../utils/theme"
import { useLanguage } from "../context/LanguageContext"

const FWI_COLORS = { low: "#38A800", moderate: "#FFFF00", high: "#FFAA00", very_high: "#FF0000", extreme: "#7A0000", unknown: "#888888" }

// Fill + stroke colors tuned for visibility against the light Voyager basemap —
// the previous pale yellow/orange for low/moderate barely showed up on light tiles.
const INTENSITY_COLORS = { low: "#FFD400", moderate: "#FF8C00", high: "#FF3300", extreme: "#B00020", unknown: "#FF6600" }
const INTENSITY_STROKE = { low: "#7A5C00", moderate: "#8A4500", high: "#7A0000", extreme: "#4D000A", unknown: "#663300" }

// Only render permanent on-map labels when there aren't too many points in
// view — reverse-geocoding every single fire point would hammer the public
// Photon API and slow the map down. Click popups always work regardless.
const MAX_LABELED_POINTS = 40

function hotspotRadius(frp) {
  if (!frp) return 5
  if (frp < 10) return 5
  if (frp < 50) return 7
  if (frp < 200) return 10
  return 14
}

function MapController({ mapRef, onZoom }) {
  const map = useMap()
  useEffect(() => {
    if (!map) return
    mapRef.current = map
  }, [map, mapRef])

  useEffect(() => {
    if (!map) return
    const handler = () => onZoom(map.getZoom())
    map.on("zoomend", handler)
    return () => map.off("zoomend", handler)
  }, [map, onZoom])

  return null
}

// Small permanent label (site name once resolved, coordinates immediately)
// shown above each fire point so responders see "which forest is on fire"
// without needing to click — matches the original ask.
function FireLabel({ lat, lon }) {
  const { t } = useLanguage()
  const [place, setPlace] = useState(null)
  useEffect(() => {
    let cancelled = false
    reverseGeocodePlace(lat, lon).then((p) => { if (!cancelled) setPlace(p) })
    return () => { cancelled = true }
  }, [lat, lon])
  return (
    <span style={{ fontSize: "11px", fontWeight: 600 }}>
      {place || `${lat.toFixed(3)}, ${lon.toFixed(3)}`}
    </span>
  )
}

function FirePopupContent({ lat, lon, frp, intensity, source, acq_datetime }) {
  const { t } = useLanguage()
  const [place, setPlace] = useState(null)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    let cancelled = false
    reverseGeocodePlace(lat, lon).then((p) => {
      if (!cancelled) { setPlace(p); setResolved(true) }
    })
    return () => { cancelled = true }
  }, [lat, lon])

  return (
    <div style={{ fontSize: "12.5px" }}>
      <strong>{place || (resolved ? t("unnamedSite") : t("locatingSite"))}</strong><br />
      {t("coordinates")}: {lat.toFixed(4)}, {lon.toFixed(4)}<br />
      FRP: {frp ? frp + " MW" : "N/A"} · {t("intensity")}: {intensity}<br />
      {t("sensor")}: {source}<br />
      {t("detected")}: {acq_datetime}
    </div>
  )
}

function LayerToggle({ layers, onChange, activeModule, intensities, infraFilter, onInfraFilter, mapZoom, infraLoading }) {
  const { t } = useLanguage()
  const m2 = [
    { key: "hotspots",       label: t("layer.hotspots"), color: "#FF4400" },
    { key: "perimeters",     label: t("layer.perimeters"), color: "#FF8800" },
    { key: "infrastructure", label: t("layer.infrastructure"), color: "#4488FF" },
  ]
  const m1 = [
    { key: "fwi",     label: t("layer.fwi"), color: "#FF4400" },
    { key: "weather", label: t("layer.weather"),  color: "#44AAFF" },
  ]
  const active = activeModule === 1 ? m1 : m2
  return (
    <div style={{ position: "absolute", top: "10px", left: "10px", zIndex: 1000,
      background: theme.panelBgSoft, borderRadius: "8px", padding: "10px",
      minWidth: "195px", maxHeight: "calc(100% - 20px)", overflowY: "auto",
      border: `1px solid ${theme.border}`, boxShadow: "0 4px 16px rgba(0,0,0,0.08)" }}>
      <div style={{ color: theme.textMuted, fontSize: "11px", fontWeight: "bold", marginBottom: "8px", letterSpacing: "0.04em" }}>{t("layersTitle")}</div>
      {active.map(({ key, label, color }) => (
        <label key={key} style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", marginBottom: "6px" }}>
          <input type="checkbox" checked={layers[key] !== false}
            onChange={e => onChange(key, e.target.checked)}
            style={{ accentColor: color, width: "14px", height: "14px" }} />
          <span style={{ color: theme.textPrimary, fontSize: "13px" }}>{label}</span>
        </label>
      ))}

      {activeModule === 2 && (
        <>
          <div style={{ color: theme.textMuted, fontSize: "11px", fontWeight: "bold",
            marginTop: "12px", marginBottom: "6px", borderTop: `1px solid ${theme.border}`, paddingTop: "8px", letterSpacing: "0.04em" }}>
            {t("intensityFilterTitle")}
          </div>
          {[
            { key: "extreme",  label: t("intensity.extreme"), color: INTENSITY_COLORS.extreme },
            { key: "high",     label: t("intensity.high"),  color: INTENSITY_COLORS.high },
            { key: "moderate", label: t("intensity.moderate"), color: INTENSITY_COLORS.moderate },
            { key: "low",      label: t("intensity.low"),      color: INTENSITY_COLORS.low },
          ].map(({ key, label, color }) => (
            <label key={key} style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", marginBottom: "5px" }}>
              <input type="checkbox" checked={intensities?.[key] !== false}
                onChange={e => onChange("intensity_" + key, e.target.checked)}
                style={{ accentColor: color, width: "14px", height: "14px" }} />
              <span style={{ color: theme.textPrimary, fontSize: "12px", display: "flex", alignItems: "center", gap: "4px" }}>
                <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: color, border: `1px solid ${INTENSITY_STROKE[key]}`, display: "inline-block" }} />
                {label}
              </span>
            </label>
          ))}

          <div style={{ color: theme.textMuted, fontSize: "11px", fontWeight: "bold",
            marginTop: "12px", marginBottom: "6px", borderTop: `1px solid ${theme.border}`, paddingTop: "8px", letterSpacing: "0.04em" }}>
            {t("infrastructureFilterTitle")}
          </div>
          {mapZoom < 10 && (
            <div style={{ color: theme.orange, fontSize: "10.5px", marginBottom: "8px", fontStyle: "italic" }}>
              {t("zoomInMessage")}
            </div>
          )}
          {infraLoading && (
            <div style={{ color: theme.textSecondary, fontSize: "10.5px", marginBottom: "8px" }}>
              {t("loadingInfraFor", { zone: "..." })}
            </div>
          )}
          {[
            { key: "hospital",     icon: "🏥", label: t("infra.hospital") },
            { key: "fire_station", icon: "🚒", label: t("infra.fire_station") },
            { key: "police",       icon: "👮", label: t("infra.police") },
            { key: "power",        icon: "⚡", label: t("infra.power") },
            { key: "school",       icon: "🏫", label: t("infra.school") },
            { key: "fuel",         icon: "⛽", label: t("infra.fuel") },
            { key: "tower",        icon: "📡", label: t("infra.tower") },
            { key: "water",        icon: "💧", label: t("infra.water") },
            { key: "airport",      icon: "✈️", label: t("infra.airport") },
          ].map(({ key, icon, label }) => (
            <label key={key} style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "5px", cursor: "pointer" }}>
              <input type="checkbox" checked={infraFilter?.[key] !== false}
                onChange={e => onInfraFilter(key, e.target.checked)}
                style={{ width: "13px", height: "13px" }} />
              <span style={{ fontSize: "13px" }}>{icon}</span>
              <span style={{ color: theme.textSecondary, fontSize: "11px" }}>{label}</span>
            </label>
          ))}
        </>
      )}
    </div>
  )
}

export default function FireMap({ activeModule, layers, mapRef, infraFilter, onInfraFilter, mapZoom, setMapZoom, zoneInfo }) {
  const { t } = useLanguage()
  const [visibleLayers, setVisibleLayers] = useState({ hotspots: true, perimeters: true, infrastructure: false, fwi: true, weather: false })
  const [visibleIntensities, setVisibleIntensities] = useState({ extreme: true, high: true, moderate: true, low: true })
  const [liveInfra, setLiveInfra] = useState({ features: [], loading: false, error: null, zoneKey: null })

  const toggleLayer = (key, value) => {
    if (key.startsWith("intensity_")) {
      const k = key.replace("intensity_", "")
      setVisibleIntensities(prev => ({ ...prev, [k]: value }))
    } else {
      setVisibleLayers(prev => ({ ...prev, [key]: value }))
    }
  }

  const zoneHotspots = useMemo(() => {
    const feats = layers.hotspots?.data?.features
    if (!feats || !zoneInfo?.zoneBbox) return []
    return filterFeaturesByBbox(feats, zoneInfo.zoneBbox)
  }, [layers.hotspots?.data, zoneInfo])

  const zonePerimeters = useMemo(() => {
    const feats = layers.perimeters?.data?.features
    if (!feats || !zoneInfo?.zoneBbox) return []
    return filterFeaturesByBbox(feats, zoneInfo.zoneBbox)
  }, [layers.perimeters?.data, zoneInfo])

  // Bundled infrastructure.geojson currently only covers Jalisco (manually
  // refreshed). If the selected zone falls inside that coverage, use it —
  // instant, no network call. Otherwise fetch live from Overpass for this
  // zone specifically (see utils/liveInfra.js), cached per browser session.
  const bundledZoneInfrastructure = useMemo(() => {
    const feats = layers.infrastructure?.data?.features
    if (!feats || !zoneInfo?.zoneBbox) return []
    return filterFeaturesByBbox(feats, zoneInfo.zoneBbox)
  }, [layers.infrastructure?.data, zoneInfo])

  useEffect(() => {
    if (!zoneInfo?.zoneBbox) return
    if (bundledZoneInfrastructure.length > 0) {
      // Already covered by the bundled dataset — no live fetch needed.
      setLiveInfra({ features: [], loading: false, error: null, zoneKey: zoneInfo.name })
      return
    }
    let cancelled = false
    setLiveInfra({ features: [], loading: true, error: null, zoneKey: zoneInfo.name })
    loadZoneInfrastructure(zoneInfo.zoneBbox)
      .then(({ features }) => {
        if (!cancelled) setLiveInfra({ features, loading: false, error: null, zoneKey: zoneInfo.name })
      })
      .catch((e) => {
        if (!cancelled) setLiveInfra({ features: [], loading: false, error: e.message, zoneKey: zoneInfo.name })
      })
    return () => { cancelled = true }
  }, [zoneInfo?.name, zoneInfo?.zoneBbox, bundledZoneInfrastructure.length])

  const zoneInfrastructure = bundledZoneInfrastructure.length > 0 ? bundledZoneInfrastructure : liveInfra.features

  const visibleZoneHotspots = useMemo(
    () => zoneHotspots.filter(f => visibleIntensities[f.properties.intensity] !== false),
    [zoneHotspots, visibleIntensities]
  )
  const showLabels = visibleZoneHotspots.length <= MAX_LABELED_POINTS

  const center = zoneInfo?.center || [23, -102]

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <MapContainer center={center} zoom={9}
        style={{ width: "100%", height: "100%", background: "#e8ebee" }}
        zoomControl={true}>

        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
          attribution='&copy; OpenStreetMap contributors &copy; CARTO'
          maxZoom={19} />

        <MapController mapRef={mapRef} onZoom={setMapZoom} />

        {activeModule === 1 && visibleLayers.fwi && layers.fwi?.data?.features?.map((feat, i) => {
          const { fwi, risk_class, risk_label, temp_c, rh_pct, wind_kmh, trend } = feat.properties
          const [lon, lat] = feat.geometry.coordinates
          const color = FWI_COLORS[risk_class] || FWI_COLORS.unknown
          return (
            <CircleMarker key={i} center={[lat, lon]} radius={12}
              pathOptions={{ color, fillColor: color, fillOpacity: 0.5, weight: 1 }}>
              <Popup>
                <strong>FWI: {fwi}</strong> - {risk_label}<br />
                Temp: {temp_c}C | Humidity: {rh_pct}% | Wind: {wind_kmh} km/h<br />
                Trend: {trend}
              </Popup>
            </CircleMarker>
          )
        })}

        {activeModule === 2 && visibleLayers.hotspots &&
          visibleZoneHotspots.map((feat, i) => {
              const { frp, intensity, source, acq_datetime } = feat.properties
              const [lon, lat] = feat.geometry.coordinates
              const color = INTENSITY_COLORS[intensity] || INTENSITY_COLORS.unknown
              const stroke = INTENSITY_STROKE[intensity] || INTENSITY_STROKE.unknown
              return (
                <CircleMarker key={i} center={[lat, lon]} radius={hotspotRadius(frp)}
                  pathOptions={{ color: stroke, fillColor: color, fillOpacity: 0.92, weight: 2 }}>
                  {showLabels && (
                    <Tooltip permanent direction="top" offset={[0, -hotspotRadius(frp)]} opacity={0.92}>
                      <FireLabel lat={lat} lon={lon} />
                    </Tooltip>
                  )}
                  <Popup>
                    <FirePopupContent lat={lat} lon={lon} frp={frp} intensity={intensity} source={source} acq_datetime={acq_datetime} />
                  </Popup>
                </CircleMarker>
              )
            })}

        {activeModule === 2 && visibleLayers.perimeters && zonePerimeters.length > 0 && (
          <GeoJSON key={layers.perimeters.generatedAt + "-" + zonePerimeters.length}
            data={{ type: "FeatureCollection", features: zonePerimeters }}
            style={() => ({ color: "#FF6600", fillColor: "#FF4400", fillOpacity: 0.25, weight: 2 })}
            onEachFeature={(feature, layer) => {
              const { name, hectares, country, source, date_updated } = feature.properties
              layer.bindPopup(`<strong>${name}</strong><br/>Area: ${hectares ? hectares.toLocaleString() + " ha" : "N/A"}<br/>Country: ${country}<br/>Updated: ${date_updated || "N/A"}<br/>Source: ${source}`)
            }} />
        )}

        {activeModule === 2 && visibleLayers.infrastructure && mapZoom >= 10 &&
          zoneInfrastructure
          .filter(f => {
            const t = f.properties.type
            if ((t === "Hospital" || t === "Clinic") && !infraFilter.hospital) return false
            if (t === "Fire Station" && !infraFilter.fire_station) return false
            if (t === "Police Station" && !infraFilter.police) return false
            if ((t === "Power Substation" || t === "Power Plant") && !infraFilter.power) return false
            if (t === "School (shelter)" && !infraFilter.school) return false
            if (t === "Fuel Station" && !infraFilter.fuel) return false
            if (t === "Tower" && !infraFilter.tower) return false
            if ((t === "Water Reservoir" || t === "Water Body") && !infraFilter.water) return false
            if (t === "Airport/Airfield" && !infraFilter.airport) return false
            return true
          })
          .map((feat, i) => {
          const { name, type } = feat.properties
          const [lon, lat] = feat.geometry.coordinates
          const ICONS = {
            "Hospital": "🏥", "Clinic": "🏥", "Fire Station": "🚒",
            "Police Station": "👮", "Power Substation": "⚡", "Power Plant": "⚡",
            "Airport/Airfield": "✈️", "Fuel Station": "⛽", "Tower": "📡",
            "School (shelter)": "🏫", "Water Reservoir": "💧", "Water Body": "💧",
          }
          const emoji = ICONS[type] || "📍"
          const divIcon = L.divIcon({
            html: `<div style="font-size:16px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.35))">${emoji}</div>`,
            className: "",
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          })
          return (
            <Marker key={i} position={[lat, lon]} icon={divIcon}>
              <Popup>
                <strong>{emoji} {name}</strong><br />
                Type: {type}
              </Popup>
            </Marker>
          )
        })}

      </MapContainer>

      <LayerToggle layers={visibleLayers} onChange={toggleLayer}
        activeModule={activeModule} intensities={visibleIntensities}
        infraFilter={infraFilter} onInfraFilter={onInfraFilter} mapZoom={mapZoom}
        infraLoading={liveInfra.loading} />

      {liveInfra.loading && (
        <div style={{ position: "absolute", bottom: "16px", left: "50%", transform: "translateX(-50%)",
          zIndex: 1000, background: theme.panelBgSoft, color: theme.textPrimary,
          padding: "6px 14px", borderRadius: "20px", fontSize: "12px", border: `1px solid ${theme.border}`,
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
          {t("loadingInfraFor", { zone: zoneInfo?.name })}
        </div>
      )}

      {Object.values(layers).every(l => l.loading) && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(245,243,239,0.9)",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 2000, color: theme.textPrimary, fontSize: "16px" }}>
          {t("loadingFireDataOverlay")}
        </div>
      )}
    </div>
  )
}
