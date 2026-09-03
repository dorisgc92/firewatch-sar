import { useState, useEffect, useMemo, useCallback } from "react"
import { MapContainer, TileLayer, CircleMarker, GeoJSON, Popup, useMap, Marker } from "react-leaflet"
import L from "leaflet"
import { filterFeaturesByBbox, linkedPerimeterForFire, perimeterHasActiveHotspot, pointInPolygonGeometry, nearestFeatures } from "../utils/spatial"
import { reverseGeocodePlace } from "../utils/geocode"
import { fireKeyFromLatLon } from "../hooks/useIncidents"
import useIsNarrow from "../hooks/useIsNarrow"
import { INTENSITY_COLORS, INTENSITY_STROKE } from "../utils/fireColors"
import { theme } from "../utils/theme"
import { useLanguage } from "../context/LanguageContext"

const FWI_COLORS = { low: "#38A800", moderate: "#FFFF00", high: "#FFAA00", very_high: "#FF0000", extreme: "#7A0000", unknown: "#888888" }



// Hard cap on individually-rendered hotspot markers. At world zoom, the
// viewport can contain the entire global dataset (100k+ points once FIRMS
// is fetching successfully) — rendering that many Leaflet CircleMarkers
// (each with its own DOM/SVG element, event handlers, tooltip) freezes the
// browser tab. Past this cap, only the highest-FRP (most severe) fires are
// drawn — a responder zoomed out that far needs "where's it worst", not
// every single low-confidence pixel.
const MAX_RENDERED_MARKERS = 1500

// perimeterHasActiveHotspot cross-checks every in-view perimeter against
// every in-view hotspot (point-in-polygon + per-vertex distance checks).
// "In-view" was assumed to mean "small" when this was written, but at
// country/continent zoom the viewport can itself hold tens of thousands of
// hotspots (e.g. 20k+ for all of Canada during an active season) — at that
// size the cross-check alone freezes the tab, even though marker rendering
// downstream is already capped by MAX_RENDERED_MARKERS. Capping the
// hotspot side of this specific check to the most severe detections keeps
// the cost bounded regardless of how zoomed out the map is, the same way
// MAX_RENDERED_MARKERS already bounds rendering.
const MAX_HOTSPOTS_FOR_PERIMETER_CHECK = 2000

// Leaflet CircleMarker radius is a fixed pixel size regardless of zoom, which
// makes a dot calibrated for a city-level view look enormous once you zoom
// out to see the whole world. Scale it against zoom level (anchored at 9,
// the default zone view) so it shrinks when zoomed out and grows slightly
// when zoomed in close.
function hotspotRadius(frp, zoom) {
  let base
  if (!frp) base = 5
  else if (frp < 10) base = 5
  else if (frp < 50) base = 7
  else if (frp < 200) base = 10
  else base = 14
  const z = zoom ?? 9
  const factor = Math.max(0.35, Math.min(1.4, z / 9))
  return Math.max(2, Math.round(base * factor))
}

function boundsToBbox(bounds) {
  return {
    minLon: bounds.getWest(),
    maxLon: bounds.getEast(),
    minLat: bounds.getSouth(),
    maxLat: bounds.getNorth(),
  }
}

function MapController({ mapRef, onZoom, onMove }) {
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

  useEffect(() => {
    if (!map) return
    const handler = () => onMove(boundsToBbox(map.getBounds()))
    map.on("moveend", handler)
    handler() // populate the initial viewport immediately, don't wait for the first pan
    return () => map.off("moveend", handler)
  }, [map, onMove])

  return null
}


// Kept intentionally minimal — this popup used to also host the claim/
// advance/release controls and the hospital-evacuation request inline.
// Both now live in the right-panel FireCommandPanel (opened via "Ver
// zona" below), where there's room to show all five responder groups'
// live status instead of squeezing one group into a Leaflet popup. This
// popup's only job now is a quick glance + a way in.
function FirePopupContent({ lat, lon, frp, intensity, source, acq_datetime, linkedPerimeter, fireTypeLabel, onZoomToLocation, incidents }) {
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

  const perimeterProps = linkedPerimeter?.properties
  const hectares = perimeterProps?.hectares

  const fireTypeDisplay = {
    volcano: t("fireTypeVolcano") || "active volcano",
    static_land_source: t("fireTypeStatic") || "industrial/static heat source",
    urban_area: t("fireTypeUrban") || "urban/populated area",
    offshore: t("fireTypeOffshore") || "offshore detection",
    unknown: t("fireTypeUnknown") || "unclassified source",
  }[fireTypeLabel]

  return (
    <div
      // Leaflet closes any open popup on a map click — and without this,
      // a click on a button INSIDE the popup (Atender, Confirmar, etc.)
      // bubbles through to the map's own click handler, which reads it as
      // "clicked the map" and closes the popup almost instantly, right as
      // the action fires. Stopping propagation here keeps every click
      // inside this popup from ever reaching that handler.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ fontSize: "12.5px", minWidth: "200px" }}>
      <strong style={{ fontSize: "13.5px" }}>{place || (resolved ? t("unnamedSite") : t("locatingSite"))}</strong><br />
      {t("coordinates")}: {lat.toFixed(4)}, {lon.toFixed(4)}<br />
      FRP: {frp ? frp + " MW" : "N/A"} · {t("intensity")}: {intensity}<br />
      {t("sensor")}: {source}<br />
      {t("detected")}: {acq_datetime}
      {fireTypeLabel && (
        <div style={{
          marginTop: "6px", padding: "5px 6px", borderRadius: "5px",
          background: "#F0F0F0", border: "1px solid #ccc", fontSize: "11px", color: "#555",
        }}>
          ⚠️ {t("nonVegetationSource") || "Not confirmed as a vegetation fire"} ({fireTypeDisplay})
        </div>
      )}
      {perimeterProps && (
        <div style={{ marginTop: "6px", paddingTop: "6px", borderTop: `1px solid ${theme.border}` }}>
          {hectares != null && (
            <div>
              <strong>{t("burnedArea") || "Area"}:</strong> {hectares.toLocaleString()} ha
              {perimeterProps.estimated && (
                <span style={{
                  marginLeft: "6px", fontSize: "10px", fontWeight: "bold", color: theme.orange,
                  border: `1px solid ${theme.orange}`, borderRadius: "4px", padding: "0 4px",
                }}>{t("estimatedArea") || "ESTIMATED"}</span>
              )}
            </div>
          )}
          {perimeterProps.name && <div>{perimeterProps.name}</div>}
          {perimeterProps.estimated && (
            <div style={{ fontSize: "10.5px", color: theme.textSecondary || "#777", marginTop: "2px" }}>
              {t("estimatedAreaNote") || "Derived from clustered hotspots, not a surveyed perimeter."}
            </div>
          )}
        </div>
      )}
      {incidents && (() => {
        const status = incidents[fireKeyFromLatLon(lat, lon)]?.status || "unassigned"
        return (
          <div style={{ marginTop: "6px", fontSize: "11px", color: theme.textSecondary }}>
            {t("cmdPanelOverallStatus")}: <strong style={{ color: theme.textPrimary }}>{t("incidentStatus_" + status)}</strong>
          </div>
        )
      })()}
      <button
        onClick={onZoomToLocation}
        style={{
          marginTop: "8px", width: "100%", padding: "6px 10px", borderRadius: "6px",
          border: "none", background: theme.orange, color: "#fff", fontWeight: "bold",
          fontSize: "12px", cursor: "pointer",
        }}>
        {t("zoomToLocation") || "Ver zona"}
      </button>
    </div>
  )
}

function LayerToggle({ layers, onChange, activeModule, intensities, infraFilter, onInfraFilter, mapZoom, infraLoading }) {
  const { t } = useLanguage()
  const isNarrow = useIsNarrow(900)
  // Starts collapsed on narrow screens (this panel is an overlay ON TOP of
  // the map, not a layout sibling — on a narrow viewport its ~215px width
  // can eat most of what little map area is visible). Defaults open on
  // wider screens, same as before this existed.
  const [collapsed, setCollapsed] = useState(isNarrow)
  const m2 = [
    { key: "hotspots",       label: t("layer.hotspots"), color: "#FF4400" },
    { key: "infrastructure", label: t("layer.infrastructure"), color: "#4488FF" },
  ]
  const m1 = [
    { key: "fwi",     label: t("layer.fwi"), color: "#FF4400" },
    { key: "weather", label: t("layer.weather"),  color: "#44AAFF" },
  ]
  const active = activeModule === 1 ? m1 : m2

  if (collapsed) {
    return (
      <button onClick={() => setCollapsed(false)} style={{
        position: "absolute", top: "10px", left: "10px", zIndex: 1000,
        background: theme.panelBgSoft, border: `1px solid ${theme.border}`, borderRadius: "8px",
        padding: "8px 12px", fontSize: "13px", color: theme.textPrimary, cursor: "pointer",
        boxShadow: "0 4px 16px rgba(0,0,0,0.08)" }}>
        ☰ {t("layersTitle")}
      </button>
    )
  }

  return (
    <div style={{ position: "absolute", top: "10px", left: "10px", zIndex: 1000,
      background: theme.panelBgSoft, borderRadius: "8px", padding: "10px",
      minWidth: "195px", maxWidth: "215px", maxHeight: "calc(100% - 20px)", overflowY: "auto",
      border: `1px solid ${theme.border}`, boxShadow: "0 4px 16px rgba(0,0,0,0.08)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <div style={{ color: theme.textMuted, fontSize: "11px", fontWeight: "bold", letterSpacing: "0.04em" }}>{t("layersTitle")}</div>
        <button onClick={() => setCollapsed(true)} style={{
          border: "none", background: "none", cursor: "pointer", fontSize: "14px", color: theme.textMuted, lineHeight: 1, padding: 0 }}>
          ✕
        </button>
      </div>
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

          {/* "Solo focos forestales" is no longer an optional toggle —
              it's the app's normal, always-on behavior now (see App.jsx's
              hideNonVegetation, defaulted to true with no checkbox left
              to turn it off). Non-vegetation detections are filtered out
              everywhere by default; nothing here needs to ask the user
              to opt in. */}

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

export default function FireMap({ activeModule, layers, mapRef, infraFilter, onInfraFilter, mapZoom, setMapZoom, zoneInfo, selectedFire, onFireClick, zoneLoading, onHideNonVegetationChange, incidents, zoneInfrastructure = [], zoneInfrastructureLoading, landCoverByFireKey = {} }) {
  const { t } = useLanguage()
  const [visibleLayers, setVisibleLayers] = useState({ hotspots: true, infrastructure: false, fwi: true, weather: false, hideNonVegetation: true })
  const [visibleIntensities, setVisibleIntensities] = useState({ extreme: true, high: true, moderate: true, low: true })

  const toggleLayer = (key, value) => {
    if (key.startsWith("intensity_")) {
      const k = key.replace("intensity_", "")
      setVisibleIntensities(prev => ({ ...prev, [k]: value }))
    } else {
      setVisibleLayers(prev => ({ ...prev, [key]: value }))
      if (key === "hideNonVegetation") onHideNonVegetationChange?.(value)
    }
  }

  const [viewportBbox, setViewportBbox] = useState(null)
  const handleMove = useCallback((bbox) => setViewportBbox(bbox), [])

  // The map now shows whatever fires/perimeters fall within the CURRENT
  // VIEWPORT (updates as you pan/zoom), not a fixed box around the searched
  // zone — so zooming out reveals fires from other countries too. This is
  // separate from the sidebar's country/state/zone stats, which still use
  // the fixed zoneInfo bboxes (that's the "command center" scoping).
  const viewportHotspots = useMemo(() => {
    const feats = layers.hotspots?.data?.features
    const bbox = viewportBbox || zoneInfo?.zoneBbox
    if (!feats || !bbox) return []
    return filterFeaturesByBbox(feats, bbox)
  }, [layers.hotspots?.data, viewportBbox, zoneInfo])

  // Bbox-scoping viewportHotspots isn't enough on its own to keep this
  // check cheap: zoomed out to a country/continent, the viewport itself can
  // hold tens of thousands of points (20k+ for all of Canada in an active
  // season). Cross-referencing every in-view perimeter against every one of
  // those points is what actually freezes the tab — so, same as marker
  // rendering below, cap it to the most severe detections. A perimeter is
  // large-area by nature, so checking it against the top N most intense
  // fires (rather than an arbitrary/random N) doesn't meaningfully change
  // which perimeters end up flagged as active.
  const hotspotsForPerimeterCheck = useMemo(() => {
    if (viewportHotspots.length <= MAX_HOTSPOTS_FOR_PERIMETER_CHECK) return viewportHotspots
    return [...viewportHotspots]
      .sort((a, b) => (b.properties.frp || 0) - (a.properties.frp || 0))
      .slice(0, MAX_HOTSPOTS_FOR_PERIMETER_CHECK)
  }, [viewportHotspots])

  const viewportPerimeters = useMemo(() => {
    const feats = layers.perimeters?.data?.features
    const bbox = viewportBbox || zoneInfo?.zoneBbox
    if (!feats || !bbox) return []
    const inView = filterFeaturesByBbox(feats, bbox)
    // Perimeter data can outlive the fire's current activity (see
    // perimeterHasActiveHotspot's comment in spatial.js) — only shade
    // zones that still have a hotspot backing them up right now.
    // Uses hotspotsForPerimeterCheck (bbox-scoped AND capped) rather than
    // the full global hotspot dataset or even the full viewport — checking
    // every perimeter against an uncapped viewport was still the main cause
    // of the map freezing when zoomed out far enough to have many
    // perimeters AND many thousands of hotspots in view at once.
    return inView.filter((p) => perimeterHasActiveHotspot(p, hotspotsForPerimeterCheck))
  }, [layers.perimeters?.data, hotspotsForPerimeterCheck, viewportBbox, zoneInfo])

  // Infrastructure now lives on Doris's own remote server (see
  // remote_server/), queried per-zone through /api/infrastructure — see
  // hooks/useZoneInfrastructure.js, called once in App.jsx and passed
  // down here (and to the EOC assignment panel) as zoneInfrastructure/
  // zoneInfrastructureLoading props, so every consumer sees the same data.

  // Land cover ("Solo focos forestales") classification arrives as a
  // prop (landCoverByFireKey), computed ONCE in App.jsx and shared with
  // Sidebar too — used to be computed independently here via its own
  // useZoneLandCover call, but that hook's cache is a per-call-site
  // useRef, not a truly shared one; with FireMap and Sidebar each
  // calling it separately, a zoomed-out view (their candidate lists
  // heavily overlapping) meant both fired their own classification
  // requests for essentially the same points at the same time —
  // needlessly doubling load on an already-fragile free tunnel right
  // when it mattered least to duplicate work.

  const visibleViewportHotspots = useMemo(() => {
    const filtered = viewportHotspots.filter(f => {
      if (visibleIntensities[f.properties.intensity] === false) return false
      // Classified on demand (see landCoverByFireKey above), not read
      // from a precomputed property anymore. A fire that hasn't been
      // classified yet (still in flight, or beyond the capped candidate
      // list above) comes back undefined here — treated as "keep it",
      // same fail-open safety principle as everywhere else this
      // heuristic is used, so a slow/unavailable classifier never hides
      // a real fire.
      if (visibleLayers.hideNonVegetation) {
        const [lon, lat] = f.geometry.coordinates
        const category = landCoverByFireKey[fireKeyFromLatLon(lat, lon)]
        if (category === "urbano" || category === "otro") return false
      }
      return true
    })
    if (filtered.length <= MAX_RENDERED_MARKERS) return filtered
    // Too many to render safely — keep the most severe fires (by FRP),
    // dropping the long tail of low-intensity detections rather than
    // freezing the tab trying to draw all of them.
    return [...filtered]
      .sort((a, b) => (b.properties.frp || 0) - (a.properties.frp || 0))
      .slice(0, MAX_RENDERED_MARKERS)
  }, [viewportHotspots, visibleIntensities, visibleLayers.hideNonVegetation, landCoverByFireKey])
  const isMarkerCapped = viewportHotspots.length > MAX_RENDERED_MARKERS

  const center = zoneInfo?.center || [23, -102]

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <div style={{
        width: "100%", height: "100%",
        filter: zoneLoading ? "blur(4px)" : "none",
        transition: "filter 0.25s ease",
        // Blocks map interaction while resolving a new zone so clicks
        // don't land on stale content mid-transition.
        pointerEvents: zoneLoading ? "none" : "auto",
      }}>
      {/* preferCanvas: at world/country zoom this map can have 1000s of
          CircleMarkers + footprint Circles + perimeter polygons on screen
          at once. Leaflet's default SVG renderer gives each one its own DOM
          node, which is what actually freezes the tab on pan/zoom — not the
          JS-side filtering (already capped/memoized above). Canvas draws
          everything to a single <canvas> element instead, which is far
          cheaper to update at this scale. Trade-off: canvas shapes can't be
          styled/selected via CSS, but nothing here relies on that. */}
      <MapContainer center={center} zoom={9} preferCanvas={true}
        style={{ width: "100%", height: "100%", background: "#e8ebee" }}
        zoomControl={true}>

        <TileLayer
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"
          attribution='Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, TomTom, Intermap, iPC, USGS, FAO, NPS, NRCAN, GeoBase, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), swisstopo, and the GIS User Community'
          maxZoom={19} maxNativeZoom={16} />

        <MapController mapRef={mapRef} onZoom={setMapZoom} onMove={handleMove} />

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
          visibleViewportHotspots.map((feat, i) => {
              const { frp, intensity, source, acq_datetime, fire_type, fire_type_label } = feat.properties
              const [lon, lat] = feat.geometry.coordinates
              // FIRMS classifies each thermal anomaly itself: 0 = presumed
              // vegetation fire (a real wildfire), 1 = volcano, 2 = other
              // static/industrial source (gas flares, plants — this is the
              // "not actually a wildfire" case), 3 = offshore. That field
              // isn't available on the NRT endpoint we use though, so this
              // also checks the on-demand land cover classification (see
              // useZoneLandCover above) — populated only while "Solo focos
              // forestales" is on, since that's the only time this
              // distinction is worth an API call. Either signal is enough
              // to style this as a muted, dashed grey marker instead of a
              // normal intensity color, so it doesn't read as a confirmed
              // wildfire on the map.
              const landCoverCategory = landCoverByFireKey[fireKeyFromLatLon(lat, lon)]
              const isNonVegetation = (fire_type != null && fire_type !== 0)
                || landCoverCategory === "urbano" || landCoverCategory === "otro"
              const nonVegetationReason = fire_type_label
                || (landCoverCategory === "urbano" ? "urban_area" : landCoverCategory === "otro" ? "static_land_source" : null)
              const color = isNonVegetation ? "#888888" : (INTENSITY_COLORS[intensity] || INTENSITY_COLORS.unknown)
              const stroke = isNonVegetation ? "#555555" : (INTENSITY_STROKE[intensity] || INTENSITY_STROKE.unknown)
              const r = hotspotRadius(frp, mapZoom)
              // Clicking a fire on the general map only opens this summary
              // popup (cheap, local) — it no longer eagerly re-scopes the
              // whole command center sidebar. That only happens if the
              // responder explicitly presses "Zoom to location" below,
              // matching the two-step flow: browse -> confirm -> drill in.
              // Uses viewportPerimeters (already bbox-scoped, typically a
              // handful of features) instead of the full global perimeters
              // list — checking every one of up to MAX_RENDERED_MARKERS
              // fires against the entire world's perimeter polygons was
              // the main cause of the map freezing when zoomed out.
              const linkedPerimeter = linkedPerimeterForFire(feat, viewportPerimeters)
              return (
                <CircleMarker key={i} center={[lat, lon]} radius={r}
                  pathOptions={isNonVegetation
                    ? { color: stroke, fillColor: color, fillOpacity: 0.75, weight: 2, dashArray: "3 2" }
                    : { color: stroke, fillColor: color, fillOpacity: 0.92, weight: 2 }}>
                  <Popup autoClose={false}>
                    <FirePopupContent lat={lat} lon={lon} frp={frp} intensity={intensity} source={source}
                      acq_datetime={acq_datetime} linkedPerimeter={linkedPerimeter}
                      fireTypeLabel={isNonVegetation ? (nonVegetationReason || "unknown") : null}
                      onZoomToLocation={() => onFireClick?.(feat)}
                      incidents={incidents} />
                  </Popup>
                </CircleMarker>
              )
            })}

        {activeModule === 2 && selectedFire && (() => {
          const [lon, lat] = selectedFire.geometry.coordinates
          const { frp, intensity, source, acq_datetime, fire_type, fire_type_label } = selectedFire.properties
          const color = INTENSITY_COLORS[intensity] || INTENSITY_COLORS.unknown
          const r = hotspotRadius(frp, mapZoom) + 6
          const linkedPerimeter = linkedPerimeterForFire(selectedFire, viewportPerimeters)
          const selectedLandCoverCategory = landCoverByFireKey[fireKeyFromLatLon(lat, lon)]
          const isNonVegetation = (fire_type != null && fire_type !== 0)
            || selectedLandCoverCategory === "urbano" || selectedLandCoverCategory === "otro"
          const selectedNonVegetationReason = fire_type_label
            || (selectedLandCoverCategory === "urbano" ? "urban_area" : selectedLandCoverCategory === "otro" ? "static_land_source" : null)

          return (
            <>
              {/* When we have a real burned-area polygon for this fire, show
                  the actual shape — not just a dot — same as NASA FIRMS.
                  Surveyed/official perimeters (WFIGS, CONAFOR) get a solid
                  outline; hotspot-derived estimates (CWFIS Canada, or any
                  future SAR-derived extent) get a dashed, more translucent
                  style so responders don't mistake an estimate for a
                  confirmed boundary. */}
              {linkedPerimeter && (
                <GeoJSON
                  key={"selected-perimeter-" + (linkedPerimeter.properties?.name || `${lat.toFixed(3)},${lon.toFixed(3)}`)}
                  data={linkedPerimeter}
                  style={() => linkedPerimeter.properties?.estimated
                    ? { color: theme.orange, fillColor: "#FF8800", fillOpacity: 0.22, weight: 2, dashArray: "6 4" }
                    : { color: theme.navy, fillColor: "#FF4400", fillOpacity: 0.3, weight: 3 }} />
              )}
              <CircleMarker center={[lat, lon]} radius={r}
                pathOptions={{ color: theme.navy, fillColor: color, fillOpacity: 0.9, weight: 3, dashArray: "3 3" }}>
                <Popup autoClose={false}>
                  <FirePopupContent lat={lat} lon={lon} frp={frp} intensity={intensity} source={source}
                    acq_datetime={acq_datetime} linkedPerimeter={linkedPerimeter}
                    fireTypeLabel={isNonVegetation ? (selectedNonVegetationReason || "unknown") : null}
                    onZoomToLocation={() => onFireClick?.(selectedFire)}
                    incidents={incidents} />
                </Popup>
              </CircleMarker>
            </>
          )
        })()}


        {/* Perimeters always render (no toggle) — official fire boundaries
            are core situational awareness for an EOC, not an optional
            layer someone might reasonably want to hide. */}
        {activeModule === 2 && viewportPerimeters.length > 0 && (
          <GeoJSON key={layers.perimeters.generatedAt + "-" + viewportPerimeters.length}
            data={{ type: "FeatureCollection", features: viewportPerimeters }}
            style={(feature) => feature?.properties?.estimated
              ? { color: "#FFAA33", fillColor: "#FF8800", fillOpacity: 0.18, weight: 1.5, dashArray: "6 4" }
              : { color: "#FF6600", fillColor: "#FF4400", fillOpacity: 0.25, weight: 2 }}
            onEachFeature={(feature, layer) => {
              // Used to just bindPopup() a read-only HTML blurb here (area,
              // country, source) — no way to assign resources from a click
              // on the shaded area itself, only from the small individual
              // fire dots underneath it. Now: pick the most severe fire
              // inside (or, failing that, nearest to) this perimeter and
              // route through the same selection flow a marker click uses
              // — that popup already knows how to show a linked perimeter's
              // area info (linkedPerimeterForFire finds this same shape),
              // so nothing about that context is lost, and Atender/
              // evacuation controls come along with it.
              layer.on("click", () => {
                const candidates = viewportHotspots.length > 0 ? viewportHotspots : (layers.hotspots?.data?.features || [])
                const inside = candidates.filter((h) => {
                  const [hlon, hlat] = h.geometry.coordinates
                  return pointInPolygonGeometry(hlat, hlon, feature.geometry)
                })
                let repFire = inside.length > 0
                  ? inside.reduce((best, h) => (h.properties.frp || 0) > (best.properties.frp || 0) ? h : best)
                  : null
                if (!repFire && candidates.length > 0) {
                  const ring = feature.geometry.type === "Polygon" ? feature.geometry.coordinates[0]
                    : feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates[0][0] : null
                  if (ring?.length) {
                    const cLat = ring.reduce((s, [, lt]) => s + lt, 0) / ring.length
                    const cLon = ring.reduce((s, [ln]) => s + ln, 0) / ring.length
                    const [nearest] = nearestFeatures(cLat, cLon, candidates, 1)
                    repFire = nearest?.feature || null
                  }
                }
                if (repFire) onFireClick?.(repFire)
              })
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
      </div>

      {zoneLoading && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center",
          justifyContent: "center", zIndex: 2500, pointerEvents: "none" }}>
          <div style={{ background: theme.panelBg, color: theme.textPrimary,
            padding: "14px 28px", borderRadius: "10px", fontSize: "14px", fontWeight: "bold",
            boxShadow: "0 8px 28px rgba(0,0,0,0.25)", border: `1px solid ${theme.border}`,
            display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{
              width: "14px", height: "14px", borderRadius: "50%",
              border: `2px solid ${theme.border}`, borderTopColor: theme.orange,
              animation: "firewatch-spin 0.8s linear infinite",
            }} />
            {t("loadingZone") || "Loading..."}
          </div>
          <style>{`@keyframes firewatch-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      <LayerToggle layers={visibleLayers} onChange={toggleLayer}
        activeModule={activeModule} intensities={visibleIntensities}
        infraFilter={infraFilter} onInfraFilter={onInfraFilter} mapZoom={mapZoom}
        infraLoading={zoneInfrastructureLoading} />

      {isMarkerCapped && (
        <div style={{ position: "absolute", top: "12px", left: "50%", transform: "translateX(-50%)",
          zIndex: 1000, background: theme.panelBgSoft, color: theme.textSecondary,
          padding: "6px 14px", borderRadius: "20px", fontSize: "11.5px", border: `1px solid ${theme.border}`,
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
          {t("markersCapped", { shown: MAX_RENDERED_MARKERS.toLocaleString(), total: viewportHotspots.length.toLocaleString() })
            || `Showing the ${MAX_RENDERED_MARKERS.toLocaleString()} most severe fires of ${viewportHotspots.length.toLocaleString()} — zoom in to see all.`}
        </div>
      )}

      {zoneInfrastructureLoading && (
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
