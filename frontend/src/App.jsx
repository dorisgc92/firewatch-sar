import { useState, useRef } from "react"
import { useFireData } from "./hooks/useFireData"
import useIncidents from "./hooks/useIncidents"
import FireMap from "./components/FireMap"
import FreshnessPanel from "./components/FreshnessPanel"
import Sidebar from "./components/Sidebar"
import IncidentStatusBar from "./components/IncidentStatusBar"
import StartScreen from "./components/StartScreen"
import { theme } from "./utils/theme"
import { LanguageProvider, useLanguage } from "./context/LanguageContext"
import { LANG_LABELS } from "./utils/i18n"
import { zoneInfoFromPhotonFeature, reverseGeocodeFeature, zoneInfoFromCoordinates, searchPlaces, SEARCH_DEBOUNCE_MS } from "./utils/geocode"

function LanguageToggle() {
  const { lang, setLang, detected } = useLanguage()
  const showToggle = detected !== "en"
  return (
    <div style={{ display: "flex", gap: "3px", flexShrink: 0 }}>
      <button onClick={() => setLang("en")} style={{
        border: `1px solid ${theme.border}`, borderRadius: "5px", padding: "3px 7px",
        fontSize: "11px", fontWeight: "bold", cursor: "pointer",
        background: lang === "en" ? theme.navy : "#fff",
        color: lang === "en" ? "#fff" : theme.textSecondary,
      }}>EN</button>
      {showToggle && (
        <button onClick={() => setLang(detected)} style={{
          border: `1px solid ${theme.border}`, borderRadius: "5px", padding: "3px 7px",
          fontSize: "11px", fontWeight: "bold", cursor: "pointer",
          background: lang === detected ? theme.navy : "#fff",
          color: lang === detected ? "#fff" : theme.textSecondary,
        }}>{LANG_LABELS[detected]}</button>
      )}
    </div>
  )
}

function AppInner() {
  const { t } = useLanguage()
  const [session, setSession] = useState(null) // { responderType, zoneInfo }
  const [activeModule, setActiveModule] = useState(2)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState([])
  const mapRef = useRef(null)
  const layers = useFireData()
  const { incidents, setIncidentStatus } = useIncidents()
  const [infraFilter, setInfraFilter] = useState({ hospital: true, fire_station: true, police: true, power: true, school: true, fuel: true, tower: true, water: true, airport: true })
  // Mirrors FireMap's internal "Wildfires only" toggle (FireMap owns the
  // actual UI checkbox and its own visibleLayers state) — lifted here only
  // so Sidebar's world/country/state/zone counts can react to it too.
  const [hideNonVegetation, setHideNonVegetation] = useState(false)
  const [mapZoom, setMapZoom] = useState(9)
  const [selectedFire, setSelectedFire] = useState(null)

  const [zoneLoading, setZoneLoading] = useState(false)
  // Bumped on every new zone-resolution request; a request only gets to
  // apply its result if it's still the most recent one by the time it
  // finishes. Without this, clicking fire A then quickly fire B could let
  // A's slower response overwrite B's already-applied zoneInfo — which is
  // exactly the "wrong municipio/estado stuck on screen" symptom reported.
  const zoneRequestId = useRef(0)

  // Debounced + race-guarded so typing a full place name doesn't fire one
  // Photon request per keystroke (was ~8 requests for "Guadalajara" with no
  // wait at all — enough rapid-fire traffic to trip Photon's own throttling
  // and leave the search bar silently returning nothing). searchDebounceTimer
  // holds the pending fire; searchRequestId discards a stale response;
  // searchAbortController cancels the PREVIOUS search's still-in-flight
  // network requests outright when a newer keystroke supersedes it — without
  // this, an outage-triggered Photon-then-Nominatim chain from an earlier
  // keystroke keeps running in the background and can make the whole thing
  // feel like it's hung for a minute-plus if you typed more than once while
  // waiting. isSearching drives a "Buscando…" indicator so it's visibly
  // doing something instead of looking frozen during that window.
  const searchDebounceTimer = useRef(null)
  const searchRequestId = useRef(0)
  const searchAbortController = useRef(null)
  const [isSearching, setIsSearching] = useState(false)

  const handleSearch = (q) => {
    setSearchQuery(q)
    if (searchDebounceTimer.current) clearTimeout(searchDebounceTimer.current)
    searchAbortController.current?.abort()
    if (q.length < 3) { setSearchResults([]); setIsSearching(false); return }
    searchDebounceTimer.current = setTimeout(async () => {
      const requestId = ++searchRequestId.current
      const controller = new AbortController()
      searchAbortController.current = controller
      setIsSearching(true)
      const features = await searchPlaces(q, 5, controller.signal)
      if (requestId === searchRequestId.current) {
        setSearchResults(features)
        setIsSearching(false)
      }
    }, SEARCH_DEBOUNCE_MS)
  }

  const goTo = async (place) => {
    setSearchResults([])
    setSearchQuery(place.properties.name || place.properties.city || "")
    setSelectedFire(null)
    setZoneLoading(true)
    const requestId = ++zoneRequestId.current
    try {
      const zoneInfo = await zoneInfoFromPhotonFeature(place)
      if (requestId !== zoneRequestId.current) return // a newer selection already superseded this one
      setSession(prev => ({ ...prev, zoneInfo }))
      if (mapRef.current) mapRef.current.setView(zoneInfo.center, 11)
    } catch {
      // Fallback: at least move the map even if the fuller zone resolution failed
      if (requestId === zoneRequestId.current && mapRef.current) {
        mapRef.current.setView([place.geometry.coordinates[1], place.geometry.coordinates[0]], 11)
      }
    } finally {
      if (requestId === zoneRequestId.current) setZoneLoading(false)
    }
  }

  // Selecting a fire — whether clicked directly on the map or from a sidebar
  // list — re-scopes the whole command center to that location, exactly like
  // a navbar search: reverse-geocode the point, rebuild zoneInfo, and let
  // every stat/summary that depends on zoneInfo update on its own.
  const handleSelectFire = async (feature) => {
    setSelectedFire(feature)
    const [lon, lat] = feature.geometry.coordinates
    if (mapRef.current) mapRef.current.setView([lat, lon], 13)
    setZoneLoading(true)
    const requestId = ++zoneRequestId.current
    try {
      const photonFeature = await reverseGeocodeFeature(lat, lon)
      const zoneInfo = photonFeature
        ? await zoneInfoFromPhotonFeature(photonFeature)
        : await zoneInfoFromCoordinates(lat, lon)
      if (requestId !== zoneRequestId.current) return
      setSession(prev => ({ ...prev, zoneInfo }))
    } catch {
      // Photon itself failed (network/rate-limit) — still rescope using our
      // own country polygons so remote fires (rainforest, open range) never
      // leave the sidebar stuck on the previous zone.
      try {
        const zoneInfo = await zoneInfoFromCoordinates(lat, lon)
        if (requestId === zoneRequestId.current) setSession(prev => ({ ...prev, zoneInfo }))
      } catch { /* both paths failed — fire stays highlighted on the map at least */ }
    } finally {
      if (requestId === zoneRequestId.current) setZoneLoading(false)
    }
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
            {t("module1")}
          </button>
          <button onClick={() => setActiveModule(2)} style={{
            padding: "5px 10px", borderRadius: "6px", border: "none", cursor: "pointer",
            fontWeight: "bold", fontSize: "12px",
            background: activeModule === 2 ? theme.orangeSoft : "transparent",
            color: activeModule === 2 ? theme.orange : theme.textSecondary,
            borderBottom: activeModule === 2 ? `2px solid ${theme.orange}` : "2px solid transparent" }}>
            {t("module2")}
          </button>
        </div>

        <div style={{ flex: 1, minWidth: "200px", maxWidth: "380px", position: "relative" }}>
          <input type="text" placeholder={t("searchPlaceholder")}
            value={searchQuery} onChange={e => handleSearch(e.target.value)}
            style={{ width: "100%", padding: "6px 12px", borderRadius: "6px",
              border: `1px solid ${theme.border}`, background: "#fff",
              color: theme.textPrimary, fontSize: "13px", outline: "none", boxSizing: "border-box" }} />
          {isSearching && searchResults.length === 0 && (
            <div style={{ position: "absolute", top: "100%", left: 0, marginTop: "4px", fontSize: "11px", color: theme.textMuted }}>
              {t("searching") || "Buscando..."}
            </div>
          )}
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
          {zoneLoading && (
            <div style={{ position: "absolute", top: "100%", left: 0, marginTop: "4px", fontSize: "11px", color: theme.textMuted }}>
              {t("submitLoading")}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginLeft: "auto", flexShrink: 0 }}>
          <LanguageToggle />
          <div style={{ fontSize: "11px", color: theme.textMuted, textAlign: "right", lineHeight: 1.3 }}>
            <div>{t("responder." + responderType)}</div>
            <div>{zoneInfo.name}</div>
          </div>
          <button onClick={() => setSession(null)} title={t("changeButton")} style={{
            border: `1px solid ${theme.border}`, background: "#fff", color: theme.textSecondary,
            borderRadius: "6px", padding: "5px 8px", fontSize: "11px", cursor: "pointer" }}>
            {t("changeButton")}
          </button>
          {layers.hotspots?.data && (
            <div style={{ background: theme.dangerSoft, border: `1px solid ${theme.danger}`,
              borderRadius: "12px", padding: "4px 10px", fontSize: "12px", color: theme.danger, textAlign: "right" }}>
              <div style={{ fontWeight: "bold" }}>{layers.hotspots.data.features?.length?.toLocaleString()}</div>
              <div style={{ fontSize: "9px" }}>{t("worldwideDetections")}</div>
            </div>
          )}
        </div>
      </header>

      <IncidentStatusBar activeModule={activeModule} layers={layers} zoneInfo={zoneInfo}
        incidents={incidents} setIncidentStatus={setIncidentStatus} onSelectFire={handleSelectFire} />

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          <FireMap activeModule={activeModule} layers={layers} mapRef={mapRef}
            infraFilter={infraFilter} onInfraFilter={(key, val) => setInfraFilter(prev => ({...prev, [key]: val}))}
            mapZoom={mapZoom} setMapZoom={setMapZoom} zoneInfo={zoneInfo} selectedFire={selectedFire}
            onFireClick={handleSelectFire} zoneLoading={zoneLoading}
            onHideNonVegetationChange={setHideNonVegetation}
            incidents={incidents} setIncidentStatus={setIncidentStatus} />
        </div>
        <Sidebar activeModule={activeModule} layers={layers} mapZoom={mapZoom} mapRef={mapRef}
          zoneInfo={zoneInfo} responderType={responderType} onSelectFire={handleSelectFire}
          hideNonVegetation={hideNonVegetation}
          incidents={incidents} setIncidentStatus={setIncidentStatus} />
      </div>

      <FreshnessPanel layers={layers} />
    </div>
  )
}

export default function App() {
  return (
    <LanguageProvider>
      <AppInner />
    </LanguageProvider>
  )
}
