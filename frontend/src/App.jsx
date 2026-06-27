import { useState, useRef } from "react"
import { useFireData } from "./hooks/useFireData"
import FireMap from "./components/FireMap"
import FreshnessPanel from "./components/FreshnessPanel"
import Sidebar from "./components/Sidebar"

export default function App() {
  const [activeModule, setActiveModule] = useState(2)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState([])
  const mapRef = useRef(null)
  const layers = useFireData()

  const handleSearch = async (q) => {
    setSearchQuery(q)
    if (q.length < 3) { setSearchResults([]); return }
    try {
      const r = await fetch(
        "https://nominatim.openstreetmap.org/search?q=" + encodeURIComponent(q) + "&format=json&limit=5"
      )
      const data = await r.json()
      setSearchResults(data)
    } catch { setSearchResults([]) }
  }

  const goTo = (place) => {
    if (mapRef.current) {
      mapRef.current.setView([parseFloat(place.lat), parseFloat(place.lon)], 7)
    }
    setSearchResults([])
    setSearchQuery(place.display_name.split(",")[0])
  }

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100vh", width: "100vw",
      background: "#0a0a0a", color: "#ffffff",
      fontFamily: "system-ui, -apple-system, sans-serif",
      overflow: "hidden",
    }}>
      <header style={{
        background: "#1a2a3a", borderBottom: "2px solid #2e5b8a",
        padding: "8px 16px", display: "flex", alignItems: "center",
        gap: "12px", flexShrink: 0, zIndex: 1000, flexWrap: "wrap",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          <span style={{ fontSize: "22px" }}>Fire</span>
          <span style={{ fontWeight: "bold", fontSize: "16px", color: "#ff6600" }}>Watch SAR</span>
        </div>

        <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
          <button onClick={() => setActiveModule(1)} style={{
            padding: "5px 10px", borderRadius: "6px", border: "none",
            cursor: "pointer", fontWeight: "bold", fontSize: "12px",
            background: activeModule === 1 ? "#2e5b8a" : "transparent",
            color: activeModule === 1 ? "#ffffff" : "#7aafd4",
            borderBottom: activeModule === 1 ? "2px solid #44aaff" : "2px solid transparent",
          }}>Module 1: Pre-Fire Risk</button>
          <button onClick={() => setActiveModule(2)} style={{
            padding: "5px 10px", borderRadius: "6px", border: "none",
            cursor: "pointer", fontWeight: "bold", fontSize: "12px",
            background: activeModule === 2 ? "#5a1a00" : "transparent",
            color: activeModule === 2 ? "#ffffff" : "#cc6644",
            borderBottom: activeModule === 2 ? "2px solid #ff6600" : "2px solid transparent",
          }}>Module 2: Active Fire</button>
        </div>

        <div style={{ flex: 1, minWidth: "200px", maxWidth: "380px", position: "relative" }}>
          <input
            type="text"
            placeholder="Search any region, city or country..."
            value={searchQuery}
            onChange={e => handleSearch(e.target.value)}
            style={{
              width: "100%", padding: "6px 12px", borderRadius: "6px",
              border: "1px solid #2e5b8a", background: "rgba(255,255,255,0.08)",
              color: "#ffffff", fontSize: "13px", outline: "none",
              boxSizing: "border-box",
            }}
          />
          {searchResults.length > 0 && (
            <div style={{
              position: "absolute", top: "100%", left: 0, right: 0,
              background: "#1a2a3a", border: "1px solid #2e5b8a",
              borderRadius: "6px", marginTop: "4px", zIndex: 2000,
              overflow: "hidden",
            }}>
              {searchResults.map((r, i) => (
                <div key={i} onClick={() => goTo(r)} style={{
                  padding: "8px 12px", cursor: "pointer", color: "#ddd",
                  fontSize: "13px", borderBottom: "1px solid #1a2a3a",
                }}
                  onMouseEnter={e => e.currentTarget.style.background = "#2e5b8a"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  {r.display_name.split(",").slice(0, 3).join(",")}
                </div>
              ))}
            </div>
          )}
        </div>

        {layers.hotspots?.data && (
          <div style={{
            marginLeft: "auto", background: "#5a0000",
            border: "1px solid #cc3300", borderRadius: "12px",
            padding: "4px 10px", fontSize: "12px", color: "#ffaaaa",
            flexShrink: 0,
          }}>
            {layers.hotspots.data.features?.length?.toLocaleString()} active hotspots
          </div>
        )}
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          <FireMap activeModule={activeModule} layers={layers} mapRef={mapRef} />
        </div>
        <Sidebar activeModule={activeModule} layers={layers} />
      </div>

      <FreshnessPanel layers={layers} />
    </div>
  )
}