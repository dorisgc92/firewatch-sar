import { useState, useEffect, useRef, useCallback } from "react"
import { MapContainer, TileLayer, CircleMarker, GeoJSON, Popup, useMap } from "react-leaflet"

const OVERPASS_URL = "/api/overpass"
const INFRA_TYPES = [
  ["amenity", "hospital",     "Hospital",         "#FF4444"],
  ["amenity", "fire_station", "Fire Station",     "#FF6600"],
  ["amenity", "police",       "Police Station",   "#0044FF"],
  ["power",   "substation",   "Power Substation", "#FFAA00"],
  ["aeroway", "aerodrome",    "Airport",          "#44AAFF"],
]

async function fetchInfraForBounds(bounds) {
  const s = bounds.getSouth().toFixed(4)
  const w = bounds.getWest().toFixed(4)
  const n = bounds.getNorth().toFixed(4)
  const e = bounds.getEast().toFixed(4)
  const bb = `${s},${w},${n},${e}`
  const tags = INFRA_TYPES.map(([k, v]) =>
    `  node["${k}"="${v}"](${bb});\n  way["${k}"="${v}"](${bb});`
  ).join("\n")
  const query = `[out:json][timeout:30];\n(\n${tags}\n);\nout center;`
  const r = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: query })
  })
  const data = await r.json()
  return data.elements.map(el => {
    const lat = el.type === "node" ? el.lat : el.center?.lat
    const lon = el.type === "node" ? el.lon : el.center?.lon
    if (!lat) return null
    const t = el.tags || {}
    const match = INFRA_TYPES.find(([k, v]) => t[k] === v)
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: { name: t.name || t["name:es"] || match?.[2] || "Unknown", type: match?.[2] || "Other", color: match?.[3] || "#888888" }
    }
  }).filter(Boolean)
}

const FWI_COLORS = { low: "#38A800", moderate: "#FFFF00", high: "#FFAA00", very_high: "#FF0000", extreme: "#7A0000", unknown: "#888888" }
const INTENSITY_COLORS = { low: "#FFEE88", moderate: "#FF9900", high: "#FF4400", extreme: "#AA0000", unknown: "#FF6600" }

function hotspotRadius(frp) {
  if (!frp) return 4
  if (frp < 10) return 4
  if (frp < 50) return 6
  if (frp < 200) return 9
  return 13
}

function MapController({ mapRef, onMove, active }) {
  const map = useMap()

  useEffect(() => {
    if (!map) return
    mapRef.current = map
  }, [map, mapRef])

  useEffect(() => {
    if (!map || !active) return
    const handler = () => onMove(map)
    map.on("moveend", handler)
    onMove(map)
    return () => map.off("moveend", handler)
  }, [map, onMove, active])

  return null
}
function LayerToggle({ layers, onChange, activeModule, intensities }) {
  const m2 = [
    { key: "hotspots",       label: "Active Fire Detections", color: "#FF4400" },
    { key: "perimeters",     label: "Perimeters",             color: "#FF8800" },
    { key: "infrastructure", label: "Infrastructure",         color: "#4488FF" },
  ]
  const m1 = [
    { key: "fwi",     label: "FWI Risk", color: "#FF4400" },
    { key: "weather", label: "Weather",  color: "#44AAFF" },
  ]
  const active = activeModule === 1 ? m1 : m2
  return (
    <div style={{ position: "absolute", top: "10px", left: "10px", zIndex: 1000,
      background: "rgba(20,30,40,0.92)", borderRadius: "8px", padding: "10px",
      minWidth: "180px", border: "1px solid #2e5b8a" }}>
      <div style={{ color: "#7aafd4", fontSize: "11px", fontWeight: "bold", marginBottom: "8px" }}>LAYERS</div>
      {active.map(({ key, label, color }) => (
        <label key={key} style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", marginBottom: "6px" }}>
          <input type="checkbox" checked={layers[key] !== false}
            onChange={e => onChange(key, e.target.checked)}
            style={{ accentColor: color, width: "14px", height: "14px" }} />
          <span style={{ color: "#ddd", fontSize: "13px" }}>{label}</span>
        </label>
      ))}
      {activeModule === 2 && (
        <>
          <div style={{ color: "#7aafd4", fontSize: "11px", fontWeight: "bold",
            marginTop: "12px", marginBottom: "6px", borderTop: "1px solid #2a3a4a", paddingTop: "8px" }}>
            INTENSITY FILTER
          </div>
          {[
            { key: "extreme",  label: "Extreme (>200 MW)", color: "#AA0000" },
            { key: "high",     label: "High (50-200 MW)",  color: "#FF4400" },
            { key: "moderate", label: "Moderate (10-50 MW)", color: "#FF9900" },
            { key: "low",      label: "Low (<10 MW)",      color: "#FFEE88" },
          ].map(({ key, label, color }) => (
            <label key={key} style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", marginBottom: "5px" }}>
              <input type="checkbox" checked={intensities?.[key] !== false}
                onChange={e => onChange("intensity_" + key, e.target.checked)}
                style={{ accentColor: color, width: "14px", height: "14px" }} />
              <span style={{ color: "#ddd", fontSize: "12px", display: "flex", alignItems: "center", gap: "4px" }}>
                <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: color, display: "inline-block" }} />
                {label}
              </span>
            </label>
          ))}
        </>
      )}
    </div>
  )
}

export default function FireMap({ activeModule, layers, mapRef }) {
  const [visibleLayers, setVisibleLayers] = useState({ hotspots: true, perimeters: true, infrastructure: false, fwi: true, weather: false })
  const [visibleIntensities, setVisibleIntensities] = useState({ extreme: true, high: true, moderate: true, low: true })
  const [infraFeatures, setInfraFeatures] = useState([])
  const [infraLoading, setInfraLoading] = useState(false)

  const loadInfra = useCallback(async (map) => {
    const zoom = map.getZoom()
    if (zoom < 7) { setInfraFeatures([]); return }
    setInfraLoading(true)
    try {
      const features = await fetchInfraForBounds(map.getBounds())
      setInfraFeatures(features)
    } catch (e) { console.error(e) }
    setInfraLoading(false)
  }, [])

  const toggleLayer = (key, value) => {
    if (key.startsWith("intensity_")) {
      const k = key.replace("intensity_", "")
      setVisibleIntensities(prev => ({ ...prev, [k]: value }))
    } else {
      setVisibleLayers(prev => ({ ...prev, [key]: value }))
    }
  }

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <MapContainer center={[23, -102]} zoom={5}
        style={{ width: "100%", height: "100%", background: "#1a2a1a" }}
        zoomControl={true}>

        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; OpenStreetMap contributors &copy; CARTO'
          maxZoom={19} />

       <MapController mapRef={mapRef} onMove={loadInfra} active={visibleLayers.infrastructure} />

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
          layers.hotspots?.data?.features
            ?.filter(f => visibleIntensities[f.properties.intensity] !== false)
            ?.filter((f, i) => {
              const s = f.properties.intensity
              if (s === "extreme" || s === "high") return true
              if (s === "moderate") return i % 3 === 0
              return i % 8 === 0
            })
            .map((feat, i) => {
              const { frp, intensity, source, acq_datetime, confidence } = feat.properties
              const [lon, lat] = feat.geometry.coordinates
              const color = INTENSITY_COLORS[intensity] || INTENSITY_COLORS.unknown
              return (
                <CircleMarker key={i} center={[lat, lon]} radius={hotspotRadius(frp)}
                  pathOptions={{ color, fillColor: color, fillOpacity: 0.8, weight: 1 }}>
                  <Popup>
                    <strong>Active Fire Detection</strong><br />
                    FRP: {frp ? frp + " MW" : "N/A"} | Intensity: {intensity}<br />
                    Sensor: {source}<br />
                    Detected: {acq_datetime}
                  </Popup>
                </CircleMarker>
              )
            })}

        {activeModule === 2 && visibleLayers.perimeters && layers.perimeters?.data && (
          <GeoJSON key={layers.perimeters.generatedAt} data={layers.perimeters.data}
            style={() => ({ color: "#FF6600", fillColor: "#FF4400", fillOpacity: 0.25, weight: 2 })}
            onEachFeature={(feature, layer) => {
              const { name, hectares, country, source, date_updated } = feature.properties
              layer.bindPopup(`<strong>${name}</strong><br/>Area: ${hectares ? hectares.toLocaleString() + " ha" : "N/A"}<br/>Country: ${country}<br/>Updated: ${date_updated || "N/A"}<br/>Source: ${source}`)
            }} />
        )}

        {activeModule === 2 && visibleLayers.infrastructure && infraFeatures.map((feat, i) => {
          const { name, type, color } = feat.properties
          const [lon, lat] = feat.geometry.coordinates
          return (
            <CircleMarker key={i} center={[lat, lon]} radius={6}
              pathOptions={{ color: color || "#4488FF", fillColor: color || "#4488FF", fillOpacity: 0.9, weight: 2 }}>
              <Popup><strong>{name}</strong><br />Type: {type}</Popup>
            </CircleMarker>
          )
        })}

      </MapContainer>

      <LayerToggle layers={visibleLayers} onChange={toggleLayer}
        activeModule={activeModule} intensities={visibleIntensities} />

      {infraLoading && (
        <div style={{ position: "absolute", bottom: "50px", left: "50%", transform: "translateX(-50%)",
          zIndex: 1000, background: "rgba(20,30,40,0.9)", color: "#7aafd4",
          padding: "6px 14px", borderRadius: "20px", fontSize: "12px" }}>
          Loading infrastructure...
        </div>
      )}

      {Object.values(layers).every(l => l.loading) && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.7)",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 2000, color: "#fff", fontSize: "18px" }}>
          Loading fire data...
        </div>
      )}
    </div>
  )
}