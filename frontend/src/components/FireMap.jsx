/**
 * FireMap.jsx
 * Main interactive map using React-Leaflet.
 * Renders all data layers with toggle controls.
 *
 * Layers:
 *   Module 1: FWI risk heatmap, weather/wind vectors
 *   Module 2: FIRMS hotspots, fire perimeters, infrastructure
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { MapContainer, TileLayer, CircleMarker, GeoJSON, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

const INFRA_TYPES = [
  ['amenity', 'hospital',     'Hospital',        '#FF4444'],
  ['amenity', 'fire_station', 'Fire Station',    '#FF6600'],
  ['amenity', 'police',       'Police Station',  '#0044FF'],
  ['power',   'substation',   'Power Substation','#FFAA00'],
  ['aeroway', 'aerodrome',    'Airport',         '#44AAFF'],
]

async function fetchInfrastructureForBounds(bounds) {
  const s = bounds.getSouth().toFixed(4)
  const w = bounds.getWest().toFixed(4)
  const n = bounds.getNorth().toFixed(4)
  const e = bounds.getEast().toFixed(4)
  const bb = `${s},${w},${n},${e}`

  const tags = INFRA_TYPES.map(([k, v]) =>
    `  node["${k}"="${v}"](${bb});\n  way["${k}"="${v}"](${bb});`
  ).join('\n')

  const query = `[out:json][timeout:30];\n(\n${tags}\n);\nout center;`

  const r = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: new URLSearchParams({ data: query })
  })
  const data = await r.json()

  return data.elements.map(el => {
    const lat = el.type === 'node' ? el.lat : el.center?.lat
    const lon = el.type === 'node' ? el.lon : el.center?.lon
    if (!lat) return null
    const tags = el.tags || {}
    const match = INFRA_TYPES.find(([k, v]) => tags[k] === v)
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        name: tags.name || tags['name:es'] || match?.[2] || 'Unknown',
        type: match?.[2] || 'Other',
        color: match?.[3] || '#888888',
      }
    }
  }).filter(Boolean)
}

// ── Color helpers ──────────────────────────────────────────────────────────────

const FWI_COLORS = {
  low:       '#38A800',
  moderate:  '#FFFF00',
  high:      '#FFAA00',
  very_high: '#FF0000',
  extreme:   '#7A0000',
  unknown:   '#888888',
}

const INTENSITY_COLORS = {
  low:      '#FFEE88',
  moderate: '#FF9900',
  high:     '#FF4400',
  extreme:  '#AA0000',
  unknown:  '#FF6600',
}

function hotspotRadius(frp) {
  if (!frp) return 4
  if (frp < 10)  return 4
  if (frp < 50)  return 6
  if (frp < 200) return 9
  return 13
}

// ── Layer toggle controls ──────────────────────────────────────────────────────
function SearchBar({ mapRef }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)

  const search = async (q) => {
    if (q.length < 3) { setResults([]); return }
    setLoading(true)
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`
      )
      const data = await r.json()
      setResults(data)
    } catch (e) {
      setResults([])
    }
    setLoading(false)
  }

  const goTo = (place) => {
    if (!mapRef.current) return
    const map = mapRef.current
    map.setView([parseFloat(place.lat), parseFloat(place.lon)], 8)
    setResults([])
    setQuery(place.display_name.split(',')[0])
  }

  return (
    <div style={{
      position: 'absolute', top: '10px', left: '50%',
      transform: 'translateX(-50%)', zIndex: 1000,
      width: '320px',
    }}>
      <div style={{ position: 'relative' }}>
        <input
          type="text"
          placeholder="🔍 Search any region, city, country..."
          value={query}
          onChange={e => { setQuery(e.target.value); search(e.target.value) }}
          style={{
            width: '100%', padding: '10px 14px',
            borderRadius: '8px', border: '1px solid #2e5b8a',
            background: 'rgba(20,30,40,0.95)', color: '#ffffff',
            fontSize: '14px', outline: 'none', boxSizing: 'border-box',
          }}
        />
        {loading && (
          <span style={{ position:'absolute', right:'10px', top:'10px', color:'#888' }}>⏳</span>
        )}
      </div>
      {results.length > 0 && (
        <div style={{
          background: 'rgba(20,30,40,0.98)', border: '1px solid #2e5b8a',
          borderRadius: '8px', marginTop: '4px', overflow: 'hidden',
        }}>
          {results.map((r, i) => (
            <div key={i} onClick={() => goTo(r)}
              style={{
                padding: '8px 14px', cursor: 'pointer', color: '#ddd',
                fontSize: '13px', borderBottom: '1px solid #1a2a3a',
              }}
              onMouseEnter={e => e.target.style.background = '#1a2a3a'}
              onMouseLeave={e => e.target.style.background = 'transparent'}
            >
              {r.display_name.split(',').slice(0, 3).join(',')}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function LayerToggle({ layers: toggleState, onChange, activeModule, intensities }) {
  const module2Layers = [
    { key: 'hotspots',       label: 'Active Fire Detections',      color: '#FF4400' },
    { key: 'perimeters',     label: 'Perimeters',     color: '#FF8800' },
    { key: 'infrastructure', label: 'Infrastructure', color: '#4488FF' },
  ]
  const module1Layers = [
    { key: 'fwi',     label: '🔥 FWI Risk',  color: '#FF4400' },
    { key: 'weather', label: '🌡️ Weather',   color: '#44AAFF' },
  ]
  const activeLayers = activeModule === 1 ? module1Layers : module2Layers

  return (
    <div style={{
      position: 'absolute',
      top: '10px',
      left: '10px',
      zIndex: 1000,
      background: 'rgba(20,30,40,0.92)',
      borderRadius: '8px',
      padding: '10px',
      minWidth: '160px',
      border: '1px solid #2e5b8a',
    }}>
      <div style={{ color: '#7aafd4', fontSize: '11px', fontWeight: 'bold', marginBottom: '8px' }}>
        LAYERS
      </div>
      {activeLayers.map(({ key, label, color }) => (
        <label key={key} style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          cursor: 'pointer', marginBottom: '6px',
        }}>
          <input
            type="checkbox"
            checked={toggleState[key] !== false}
            onChange={e => onChange(key, e.target.checked)}
            style={{ accentColor: color, width: '14px', height: '14px' }}
          />
          <span style={{ color: '#ddd', fontSize: '13px' }}>{label}</span>
        </label>
      ))}

{/* Intensity filter — Module 2 only */}
      {activeModule === 2 && (
        <>
          <div style={{ color: '#7aafd4', fontSize: '11px', fontWeight: 'bold',
            letterSpacing: '0.08em', marginTop: '12px', marginBottom: '6px',
            borderTop: '1px solid #2a3a4a', paddingTop: '8px' }}>
            INTENSITY FILTER
          </div>
          {[
            { key: 'extreme', label: 'Extreme (>200 MW)', color: '#AA0000' },
            { key: 'high',    label: 'High (50-200 MW)',  color: '#FF4400' },
            { key: 'moderate',label: 'Moderate (10-50 MW)', color: '#FF9900' },
            { key: 'low',     label: 'Low (<10 MW)',      color: '#FFEE88' },
          ].map(({ key, label, color }) => (
            <label key={key} style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              cursor: 'pointer', marginBottom: '5px',
            }}>
              <input
                type="checkbox"
                checked={intensities?.[key] !== false}
                onChange={e => onChange('intensity_' + key, e.target.checked)}
                style={{ accentColor: color, width: '14px', height: '14px' }}
              />
              <span style={{ color: '#ddd', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '50%',
                  background: color, display: 'inline-block', flexShrink: 0 }} />
                {label}
              </span>
            </label>
          ))}
        </>
      )}
    </div>
  )
}

// ── Wind arrows ───────────────────────────────────────────────────────────────
function InfrastructureLoader({ onMove, visibleInfra }) {
  const map = useMap()

  useEffect(() => {
    if (!map) return

    const handleMoveEnd = () => {
      if (visibleInfra) onMove(map)
    }

    map.on('moveend', handleMoveEnd)
    if (visibleInfra) onMove(map)

    return () => map.off('moveend', handleMoveEnd)
  }, [map, onMove, visibleInfra])

  return null
}

function WindArrows({ weatherData }) {
  const map = useMap()
  // Only render arrows at reasonable zoom levels
  // In a full implementation, use Leaflet canvas renderer for performance
  if (!weatherData?.features) return null

  return weatherData.features
    .filter((_, i) => i % 3 === 0) // thin out for performance
    .map((feat, i) => {
      const { lon, lat, wind_kmh, wind_dir_deg } = feat.properties
      if (!wind_kmh) return null
      const intensity = Math.min(wind_kmh / 80, 1)
      const color = `rgb(${Math.round(255 * intensity)}, ${Math.round(255 * (1 - intensity * 0.5))}, 100)`

      return (
        <CircleMarker
          key={i}
          center={[lat, lon]}
          radius={2}
          pathOptions={{ color, fillColor: color, fillOpacity: 0.7, weight: 1 }}
        >
          <Popup>
            <strong>Wind</strong><br />
            Speed: {wind_kmh} km/h<br />
            Direction: {wind_dir_deg}°
          </Popup>
        </CircleMarker>
      )
    })
}

// ── Main Map Component ─────────────────────────────────────────────────────────

export default function FireMap({ activeModule, layers, mapRef }) {
  const [visibleLayers, setVisibleLayers] = useState({
    hotspots: true,
    perimeters: true,
    infrastructure: false,
    fwi: true,
    weather: false,
  })

  const [visibleIntensities, setVisibleIntensities] = useState({
    extreme: true,
    high: true,
    moderate: true,
    low: true,
  })

  const [infraFeatures, setInfraFeatures] = useState([])
  const [infraLoading, setInfraLoading] = useState(false)
  const infraTimeoutRef = useRef(null)

  const loadInfrastructure = useCallback(async (map) => {
    if (!visibleLayers.infrastructure) return
    const bounds = map.getBounds()
    const zoom = map.getZoom()
    if (zoom < 7) {
      setInfraFeatures([])
      return
    }
    setInfraLoading(true)
    try {
      const features = await fetchInfrastructureForBounds(bounds)
      setInfraFeatures(features)
    } catch (e) {
      console.error('Infrastructure fetch error:', e)
    }
    setInfraLoading(false)
  }, [visibleLayers.infrastructure])

  const toggleLayer = (key, value) => {
    if (key.startsWith('intensity_')) {
      const intensity = key.replace('intensity_', '')
      setVisibleIntensities(prev => ({ ...prev, [intensity]: value }))
    } else {
      setVisibleLayers(prev => ({ ...prev, [key]: value }))
    }
  }
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <MapContainer
        center={[23, -102]}
        zoom={5}
        style={{ width: '100%', height: '100%', background: '#1a2a1a' }}
        zoomControl={true}
        ref={mapRef}
      >
        {/* Base tile layer — dark theme */}
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>'
          maxZoom={19}
        />

        {/* ── MODULE 1: FWI Risk Grid ── */}
        {activeModule === 1 && visibleLayers.fwi && layers.fwi?.data?.features?.map((feat, i) => {
          const { fwi, risk_class, risk_label, temp_c, rh_pct, wind_kmh, trend } = feat.properties
          const [lon, lat] = feat.geometry.coordinates
          const color = FWI_COLORS[risk_class] || FWI_COLORS.unknown
          return (
            <CircleMarker
              key={i}
              center={[lat, lon]}
              radius={12}
              pathOptions={{
                color: color,
                fillColor: color,
                fillOpacity: 0.5,
                weight: 1,
                opacity: 0.8,
              }}
            >
              <Popup>
                <div style={{ minWidth: '160px' }}>
                  <strong>🔥 FWI: {fwi}</strong> — {risk_label}<br />
                  <hr style={{ margin: '4px 0' }} />
                  🌡️ Temp: {temp_c}°C<br />
                  💧 Humidity: {rh_pct}%<br />
                  💨 Wind: {wind_kmh} km/h<br />
                  📈 Trend: {trend}
                </div>
              </Popup>
            </CircleMarker>
          )
        })}

        {/* ── MODULE 1: Weather / Wind ── */}
        {activeModule === 1 && visibleLayers.weather && (
          <WindArrows weatherData={layers.weather?.data} />
        )}

       {/* ── MODULE 2: Fire Hotspots (FIRMS) ── */}
        {activeModule === 2 && visibleLayers.hotspots && 
          layers.hotspots?.data?.features
            ?.filter(f => visibleIntensities[f.properties.intensity] !== false)
            ?.filter((f, i) => {
              const intensity = f.properties.intensity
              if (intensity === 'extreme' || intensity === 'high') return true
              if (intensity === 'moderate') return i % 3 === 0
              return i % 8 === 0
            })
            .map((feat, i) => {
              const { frp, intensity, source, acq_datetime, confidence, daynight } = feat.properties
              const [lon, lat] = feat.geometry.coordinates
              const color = INTENSITY_COLORS[intensity] || INTENSITY_COLORS.unknown
              return (
                <CircleMarker
                  key={i}
                  center={[lat, lon]}
                  radius={hotspotRadius(frp)}
                  pathOptions={{
                    color: color,
                    fillColor: color,
                    fillOpacity: 0.8,
                    weight: 1,
                  }}
                >
                  <Popup>
                    <div style={{ minWidth: '160px' }}>
                      <strong>Active Fire Hotspot</strong><br />
                      <hr style={{ margin: '4px 0' }} />
                      FRP: {frp ? `${frp} MW` : 'N/A'}<br />
                      Intensity: {intensity}<br />
                      Sensor: {source}<br />
                      Detected: {acq_datetime}<br />
                      Confidence: {confidence}
                    </div>
                  </Popup>
                </CircleMarker>
              )
            })}

        {/* ── MODULE 2: Fire Perimeters ── */}
        {activeModule === 2 && visibleLayers.perimeters && layers.perimeters?.data && (
          <GeoJSON
            key={layers.perimeters.generatedAt}
            data={layers.perimeters.data}
            style={() => ({
              color: '#FF6600',
              fillColor: '#FF4400',
              fillOpacity: 0.25,
              weight: 2,
              opacity: 0.9,
            })}
            onEachFeature={(feature, layer) => {
              const { name, hectares, country, source, date_updated } = feature.properties
              layer.bindPopup(`
                <strong>🟠 ${name}</strong><br />
                Area: ${hectares ? hectares.toLocaleString() + ' ha' : 'N/A'}<br />
                Country: ${country}<br />
                Updated: ${date_updated || 'N/A'}<br />
                Source: ${source}
              `)
            }}
          />
        )}

       {/* ── MODULE 2: Infrastructure (loaded on demand by region) ── */}
        {activeModule === 2 && visibleLayers.infrastructure && infraFeatures.map((feat, i) => {
          const { name, type, color } = feat.properties
          const [lon, lat] = feat.geometry.coordinates
          return (
            <CircleMarker
              key={i}
              center={[lat, lon]}
              radius={6}
              pathOptions={{
                color: color || '#4488FF',
                fillColor: color || '#4488FF',
                fillOpacity: 0.9,
                weight: 2,
              }}
            >
              <Popup>
                <strong>{name}</strong><br />
                Type: {type}
              </Popup>
            </CircleMarker>
          )
        })}

        {/* Infrastructure loading indicator */}
        {infraLoading && (
          <div style={{
            position: 'absolute', bottom: '40px', left: '50%',
            transform: 'translateX(-50%)', zIndex: 1000,
            background: 'rgba(20,30,40,0.9)', color: '#7aafd4',
            padding: '6px 14px', borderRadius: '20px', fontSize: '12px',
          }}>
            Loading infrastructure...
          </div>
        )}

      </MapContainer>
      
      {/* Infrastructure loader — fires on map move */}
        <InfrastructureLoader
          onMove={loadInfrastructure}
          visibleInfra={visibleLayers.infrastructure}
        />

      {/* Layer toggle UI */}
      <LayerToggle
        layers={visibleLayers}
        onChange={toggleLayer}
        activeModule={activeModule}
	intensities={visibleIntensities}
      />

      {/* Loading overlay */}
      {Object.values(layers).every(l => l.loading) && (
        <div style={{
          position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 2000, color: '#fff', fontSize: '18px',
        }}>
          🔥 Loading fire data…
        </div>
      )}
    </div>
  )
}
