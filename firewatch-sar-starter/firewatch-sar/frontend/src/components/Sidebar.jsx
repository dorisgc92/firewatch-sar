/**
 * Sidebar.jsx
 * Situation summary panel shown on the right side of the map.
 * Auto-generates a plain-language summary from structured data.
 */

function SectionTitle({ children }) {
  return (
    <div style={{
      color: '#7aafd4', fontSize: '11px', fontWeight: 'bold',
      letterSpacing: '0.08em', marginTop: '16px', marginBottom: '6px',
      borderBottom: '1px solid #2a3a4a', paddingBottom: '4px',
    }}>
      {children}
    </div>
  )
}

function StatRow({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
      <span style={{ color: '#888', fontSize: '12px' }}>{label}</span>
      <span style={{ color: color || '#ffffff', fontSize: '12px', fontWeight: 'bold' }}>
        {value}
      </span>
    </div>
  )
}

const FWI_LABELS = {
  low: { label: 'LOW', color: '#38A800' },
  moderate: { label: 'MODERATE', color: '#CCCC00' },
  high: { label: 'HIGH', color: '#FFAA00' },
  very_high: { label: 'VERY HIGH', color: '#FF4400' },
  extreme: { label: 'EXTREME', color: '#AA0000' },
}

export default function Sidebar({ activeModule, layers }) {
  const hotspots = layers.hotspots?.data?.features || []
  const perimeters = layers.perimeters?.data?.features || []
  const fwiPoints = layers.fwi?.data?.features || []

  // Compute summary statistics
  const totalHotspots = hotspots.length
  const extremeHotspots = hotspots.filter(f => f.properties.intensity === 'extreme').length
  const highHotspots = hotspots.filter(f => f.properties.intensity === 'high').length

  const totalPerimeters = perimeters.length
  const totalHectares = perimeters.reduce((sum, f) => sum + (f.properties.hectares || 0), 0)

  // Largest active fire
  const largestFire = perimeters.reduce((max, f) =>
    (f.properties.hectares || 0) > (max?.properties?.hectares || 0) ? f : max, null)

  // Highest FWI point
  const maxFWI = fwiPoints.reduce((max, f) =>
    (f.properties.fwi || 0) > (max?.properties?.fwi || 0) ? f : max, null)

  // Module 1 — pre-fire forecast summary
  const escalatingZones = fwiPoints.filter(f => f.properties.trend === 'escalating').length
  const extremeZones = fwiPoints.filter(f => f.properties.risk_class === 'extreme').length
  const veryHighZones = fwiPoints.filter(f => f.properties.risk_class === 'very_high').length

  return (
    <div style={{
      width: '240px',
      flexShrink: 0,
      background: '#111820',
      borderLeft: '1px solid #2a3a4a',
      padding: '12px',
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Module indicator */}
      <div style={{
        background: activeModule === 1 ? '#0d2a4a' : '#2a0d00',
        border: `1px solid ${activeModule === 1 ? '#2e5b8a' : '#8a3000'}`,
        borderRadius: '6px',
        padding: '8px',
        marginBottom: '4px',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#ffffff' }}>
          {activeModule === 1 ? '📊 Pre-Fire Risk View' : '🛰️ Active Fire View'}
        </div>
        <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>
          {activeModule === 1
            ? 'Module 1 — FWI Forecast'
            : 'Module 2 — Situational Awareness'}
        </div>
      </div>

      {/* ── MODULE 2: Active Fire Summary ── */}
      {activeModule === 2 && (
        <>
          <SectionTitle>ACTIVE FIRES</SectionTitle>
          <StatRow label="Total hotspots" value={totalHotspots.toLocaleString()} />
          <StatRow label="Extreme intensity" value={extremeHotspots} color="#FF4400" />
          <StatRow label="High intensity" value={highHotspots} color="#FF8800" />
          <StatRow label="Active perimeters" value={totalPerimeters} />
          <StatRow
            label="Total area"
            value={totalHectares > 0 ? `${Math.round(totalHectares).toLocaleString()} ha` : 'N/A'}
            color="#FF8800"
          />

          {largestFire && (
            <>
              <SectionTitle>LARGEST ACTIVE FIRE</SectionTitle>
              <div style={{ color: '#ffcc88', fontSize: '13px', fontWeight: 'bold', marginBottom: '4px' }}>
                {largestFire.properties.name}
              </div>
              <StatRow
                label="Area"
                value={`${Math.round(largestFire.properties.hectares || 0).toLocaleString()} ha`}
                color="#FF8800"
              />
              <StatRow label="Country" value={largestFire.properties.country || 'N/A'} />
              <StatRow label="Source" value={largestFire.properties.source || 'N/A'} />
            </>
          )}

          <SectionTitle>SITUATION SUMMARY</SectionTitle>
          <div style={{
            background: '#1a0d00',
            border: '1px solid #8a3000',
            borderRadius: '6px',
            padding: '8px',
            fontSize: '12px',
            lineHeight: '1.6',
            color: '#ffccaa',
          }}>
            {totalHotspots === 0 && !layers.hotspots?.loading
              ? '✅ No active hotspots detected in current view.'
              : layers.hotspots?.loading
              ? '⏳ Loading hotspot data…'
              : `🔴 ${totalHotspots.toLocaleString()} active hotspots detected globally. ${extremeHotspots > 0 ? `${extremeHotspots} extreme-intensity detections require immediate attention.` : ''} ${totalPerimeters > 0 ? `${totalPerimeters} active fire perimeters covering ${Math.round(totalHectares).toLocaleString()} ha.` : ''}`}
          </div>
        </>
      )}

      {/* ── MODULE 1: FWI Summary ── */}
      {activeModule === 1 && (
        <>
          <SectionTitle>FIRE WEATHER INDEX</SectionTitle>
          {maxFWI && (
            <>
              <div style={{ marginBottom: '8px' }}>
                <div style={{ color: '#888', fontSize: '11px', marginBottom: '3px' }}>
                  Highest FWI detected:
                </div>
                <div style={{
                  fontSize: '28px', fontWeight: 'bold',
                  color: FWI_LABELS[maxFWI.properties.risk_class]?.color || '#ffffff',
                }}>
                  {maxFWI.properties.fwi}
                </div>
                <div style={{
                  fontSize: '13px', fontWeight: 'bold',
                  color: FWI_LABELS[maxFWI.properties.risk_class]?.color || '#ffffff',
                }}>
                  {FWI_LABELS[maxFWI.properties.risk_class]?.label || 'UNKNOWN'}
                </div>
                <div style={{ color: '#666', fontSize: '11px', marginTop: '2px' }}>
                  at {maxFWI.properties.lat}°, {maxFWI.properties.lon}°
                </div>
              </div>
            </>
          )}

          <StatRow
            label="Extreme risk zones"
            value={extremeZones}
            color={extremeZones > 0 ? '#AA0000' : '#38A800'}
          />
          <StatRow
            label="Very high risk zones"
            value={veryHighZones}
            color={veryHighZones > 0 ? '#FF4400' : '#38A800'}
          />
          <StatRow
            label="Escalating zones"
            value={escalatingZones}
            color={escalatingZones > 0 ? '#FF8800' : '#38A800'}
          />

          <SectionTitle>FORECAST ALERT</SectionTitle>
          <div style={{
            background: extremeZones > 0 ? '#2a0000' : '#0a2a0a',
            border: `1px solid ${extremeZones > 0 ? '#cc0000' : '#006600'}`,
            borderRadius: '6px',
            padding: '8px',
            fontSize: '12px',
            lineHeight: '1.6',
            color: extremeZones > 0 ? '#ffaaaa' : '#aaffaa',
          }}>
            {layers.fwi?.loading
              ? '⏳ Computing FWI…'
              : extremeZones > 0
              ? `⚠️ ${extremeZones} zone(s) at EXTREME fire danger. ${escalatingZones > 0 ? `${escalatingZones} zone(s) escalating.` : ''} Consider pre-positioning resources.`
              : veryHighZones > 0
              ? `🔶 ${veryHighZones} zone(s) at VERY HIGH fire danger. Monitor conditions closely.`
              : '✅ Current fire weather conditions are within manageable range.'}
          </div>
        </>
      )}

      {/* ── Errors ── */}
      {Object.entries(layers).some(([, v]) => v.error) && (
        <>
          <SectionTitle>DATA ERRORS</SectionTitle>
          {Object.entries(layers).filter(([, v]) => v.error).map(([key, v]) => (
            <div key={key} style={{ color: '#ff8888', fontSize: '11px', marginBottom: '4px' }}>
              ⚠️ {key}: {v.error}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
