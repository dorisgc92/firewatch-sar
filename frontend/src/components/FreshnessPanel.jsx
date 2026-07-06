/**
 * FreshnessPanel.jsx
 * Shows acquisition timestamp and traffic-light freshness status
 * for each data layer. Visible in both Module 1 and Module 2.
 */
import { useLanguage } from "../context/LanguageContext"

const LAYER_KEYS = {
  hotspots:   { i18nKey: 'freshness.hotspots', expected: '< 3 hrs' },
  weather:    { i18nKey: 'freshness.weather',  expected: 'Hourly' },
  fwi:        { i18nKey: 'freshness.fwi',      expected: 'Hourly' },
  perimeters: { i18nKey: 'freshness.perimeters', expected: '< 6 hrs' },
}
const FRESHNESS_COLORS = {
  green:   { bg: '#eaf7ea', dot: '#2e7d32', text: '#1b5e20' },
  amber:   { bg: '#fff6e0', dot: '#e08e00', text: '#8a5a00' },
  red:     { bg: '#fdecea', dot: '#c62828', text: '#7a1a15' },
  unknown: { bg: '#f0eee9', dot: '#9aa2a8', text: '#6b7280' },
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
  const { t } = useLanguage()
  return (
    <div style={{
      background: '#ffffff',
      borderTop: '1px solid #e2ddd3',
      padding: '8px 12px',
      display: 'flex',
      gap: '8px',
      flexWrap: 'wrap',
      alignItems: 'center',
    }}>
      <span style={{ color: '#6b7280', fontSize: '11px', fontWeight: 'bold', marginRight: '4px' }}>
        {t('dataFreshness')}
      </span>

      {Object.entries(LAYER_KEYS).map(([key, meta]) => {
        const layer = layers[key]
        const freshness = layer?.freshness || 'unknown'
        const colors = FRESHNESS_COLORS[freshness]
        const age = formatAge(layer?.generatedAt)
        const label = t(meta.i18nKey)

        return (
          <div
            key={key}
            title={`${label}: updated ${age} (expected: ${meta.expected})`}
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
              {label}: {layer?.loading ? '…' : age}
            </span>
          </div>
        )
      })}
    </div>
  )
}
