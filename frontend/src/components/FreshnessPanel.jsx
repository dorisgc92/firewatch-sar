/**
 * FreshnessPanel.jsx
 * Shows acquisition timestamp and traffic-light freshness status
 * for each data layer. Visible in both Module 1 and Module 2.
 */

const LAYER_LABELS = {
  hotspots:   { label: 'FIRMS Hotspots',  icon: 'FIRMS', expected: '< 3 hrs' },
  weather:    { label: 'Weather / FWI',   icon: 'MET',   expected: 'Hourly' },
  fwi:        { label: 'FWI Grid',        icon: 'FWI',   expected: 'Hourly' },
  perimeters: { label: 'Fire Perimeters', icon: 'PERIM', expected: '< 6 hrs' },
}
const FRESHNESS_COLORS = {
  green:   { bg: '#1a4a1a', dot: '#44ff44', text: '#aaffaa' },
  amber:   { bg: '#4a3a00', dot: '#ffcc00', text: '#ffeeaa' },
  red:     { bg: '#4a0000', dot: '#ff4444', text: '#ffaaaa' },
  unknown: { bg: '#2a2a2a', dot: '#888888', text: '#aaaaaa' },
}

function formatAge(generatedAt) {
  if (!generatedAt) return 'Unknown'
  const ageMs = Date.now() - new Date(generatedAt).getTime()
  const mins = Math.floor(ageMs / 60000)
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  const days = Math.floor(hrs / 24)
  return `${days} day${days > 1 ? 's' : ''} ago`
}

export default function FreshnessPanel({ layers }) {
  return (
    <div style={{
      background: '#111',
      borderTop: '1px solid #333',
      padding: '8px 12px',
      display: 'flex',
      gap: '8px',
      flexWrap: 'wrap',
      alignItems: 'center',
    }}>
      <span style={{ color: '#666', fontSize: '11px', fontWeight: 'bold', marginRight: '4px' }}>
        DATA FRESHNESS
      </span>

      {Object.entries(LAYER_LABELS).map(([key, meta]) => {
        const layer = layers[key]
        const freshness = layer?.freshness || 'unknown'
        const colors = FRESHNESS_COLORS[freshness]
        const age = formatAge(layer?.generatedAt)

        return (
          <div
            key={key}
            title={`${meta.label}: updated ${age} (expected: ${meta.expected})`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              background: colors.bg,
              borderRadius: '12px',
              padding: '3px 8px',
              cursor: 'default',
            }}
          >
            <span style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: colors.dot,
              flexShrink: 0,
              boxShadow: `0 0 4px ${colors.dot}`,
            }} />
            <span style={{ color: colors.text, fontSize: '11px', whiteSpace: 'nowrap' }}>
              {meta.icon} {meta.label}: {layer?.loading ? '…' : age}
            </span>
          </div>
        )
      })}
    </div>
  )
}
