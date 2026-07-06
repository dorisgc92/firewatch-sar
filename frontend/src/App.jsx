import { useState, useRef } from "react"
import { useFireData } from "./hooks/useFireData"
import FireMap from "./components/FireMap"
import FreshnessPanel from "./components/FreshnessPanel"
import Sidebar from "./components/Sidebar"
import StartScreen from "./components/StartScreen"
import { theme } from "./utils/theme"

const RESPONDER_LABELS = {
  bombero: "Bombero forestal / Brigada",
  eoc: "Centro de comando (EOC)",
  proteccion_civil: "Protección Civil / Autoridad",
  ems: "EMS / Hospital",
  utilities: "Utilities / Infraestructura crítica",
  analista: "Analista post-evento / Seguros",
  ong: "ONG / Logística humanitaria",
}

export default function App() {
  const [session, setSession] = useState(null) // { responderType, zoneInfo }
  const [activeModule, setActiveModule] = useState(2)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState([])
  const mapRef = useRef(null)
  const layers = useFireData()
  const [infraFilter, setInfraFilter] = useState({ hospital: true, fire_station: true, police: true, power: true, school: true, fuel: true, tower: true, water: true, airport: true })
  const [mapZoom, setMapZoom] = useState(9)

  const handleSearch = async (q) => {
    setSearchQuery(q)
    if (q.length < 3) { setSearchResults([]); return }
    try {
      const r = await fetch("https://photon.komoot.io/api/?q=" + encodeURIComponent(q) + "&limit=5")
      const data = await r.json()
      setSearchResults(data.features || [])
    } catch { setSearchResults([]) }
  }

  const goTo = (place) => {
    if (mapRef.current) {
      mapRef.current.setView([place.geometry.coordinates[1], place.geometry.coordinates[0]], 11)
    }
    setSearchResults([])
    setSearchQuery(place.properties.name || place.properties.city || "")
  }

  if (!session) {
    return <StartScreen onReady={setSession} />
  }

  const { responderType, zoneInfo } = session

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100vw",
      background: theme.bg, color: theme.textPrimary, fontFamily: "system-ui, -apple-system, sans-serif", overflow: "hidden" }}>

      <header style={{ background: theme.panelBg, borderBottom: `1px solid ${theme.border}`,
        padding: "8px 16px", display: "flex", alignItems: "center",
        gap: "12px", flexShrink: 0, zIndex: 1000, flexWrap: "wrap" }}>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          <span style={{ fontSize: "22px" }}>Fire</span>
          <span style={{ fontWeight: "bold", fontSize: "16px", color: theme.orange }}>Watch SAR</span>
        </div>

        <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
          <button onClick={() => setActiveModule(1)} style={{
            padding: "5px 10px", borderRadius: "6px", border: "none", cursor: "pointer",
            fontWeight: "bold", fontSize: "12px",
            background: activeModule === 1 ? theme.navySoft : "transparent",
            color: activeModule === 1 ? theme.navy : theme.textSecondary,
            borderBottom: activeModule === 1 ? `2px solid ${theme.navy}` : "2px solid transparent" }}>
            Module 1: Pre-Fire Risk
          </button>
          <button onClick={() => setActiveModule(2)} style={{
            padding: "5px 10px", borderRadius: "6px", border: "none", cursor: "pointer",
            fontWeight: "bold", fontSize: "12px",
            background: activeModule === 2 ? theme.orangeSoft : "transparent",
            color: activeModule === 2 ? theme.orange : theme.textSecondary,
            borderBottom: activeModule === 2 ? `2px solid ${theme.orange}` : "2px solid transparent" }}>
            Module 2: Active Fire
          </button>
        </div>

        <div style={{ flex: 1, minWidth: "200px", maxWidth: "380px", position: "relative" }}>
          <input type="text" placeholder="Search any region, city or country..."
            value={searchQuery} onChange={e => handleSearch(e.target.value)}
            style={{ width: "100%", padding: "6px 12px", borderRadius: "6px",
              border: `1px solid ${theme.border}`, background: "#fff",
              color: theme.textPrimary, fontSize: "13px", outline: "none", boxSizing: "border-box" }} />
          {searchResults.length > 0 && (
            <div style={{ position: "absolute", top: "100%", left: 0, right: 0,
              background: theme.panelBg, border: `1px solid ${theme.border}`,
              borderRadius: "6px", marginTop: "4px", zIndex: 2000, overflow: "hidden", boxShadow: "0 6px 18px rgba(0,0,0,0.08)" }}>
              {searchResults.map((r, i) => (
                <div key={i} onClick={() => goTo(r)}
                  style={{ padding: "8px 12px", cursor: "pointer", color: theme.textPrimary, fontSize: "13px", borderBottom: `1px solid ${theme.border}` }}
                  onMouseEnter={e => e.currentTarget.style.background = theme.orangeSoft}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  {[r.properties.name, r.properties.city, r.properties.country].filter(Boolean).join(", ")}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginLeft: "auto", flexShrink: 0 }}>
          <div style={{ fontSize: "11px", color: theme.textMuted, textAlign: "right", lineHeight: 1.3 }}>
            <div>{RESPONDER_LABELS[responderType]}</div>
            <div>Zona: {zoneInfo.name}</div>
          </div>
          <button onClick={() => setSession(null)} title="Cambiar responder o zona" style={{
            border: `1px solid ${theme.border}`, background: "#fff", color: theme.textSecondary,
            borderRadius: "6px", padding: "5px 8px", fontSize: "11px", cursor: "pointer" }}>
            Cambiar
          </button>
          {layers.hotspots?.data && (
            <div style={{ background: theme.dangerSoft, border: `1px solid ${theme.danger}`,
              borderRadius: "12px", padding: "4px 10px", fontSize: "12px", color: theme.danger, textAlign: "right" }}>
              <div style={{ fontWeight: "bold" }}>{layers.hotspots.data.features?.length?.toLocaleString()}</div>
              <div style={{ fontSize: "9px" }}>active fire detections — WORLDWIDE</div>
            </div>
          )}
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          <FireMap activeModule={activeModule} layers={layers} mapRef={mapRef}
            infraFilter={infraFilter} onInfraFilter={(key, val) => setInfraFilter(prev => ({...prev, [key]: val}))}
            mapZoom={mapZoom} setMapZoom={setMapZoom} zoneInfo={zoneInfo} />
        </div>
        <Sidebar activeModule={activeModule} layers={layers} mapZoom={mapZoom}
          zoneInfo={zoneInfo} responderType={responderType} />
      </div>

      <FreshnessPanel layers={layers} />
    </div>
  )
}
