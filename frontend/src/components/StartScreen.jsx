import { useState } from "react"
import { geocodeZone } from "../utils/geocode"
import { theme } from "../utils/theme"

const RESPONDER_TYPES = [
  { key: "bombero", label: "Bombero forestal / Brigada", icon: "🚒" },
  { key: "eoc", label: "Centro de comando (EOC)", icon: "🧭" },
  { key: "proteccion_civil", label: "Protección Civil / Autoridad", icon: "🛡️" },
  { key: "ems", label: "EMS / Hospital", icon: "🏥" },
  { key: "utilities", label: "Utilities / Infraestructura crítica", icon: "⚡" },
  { key: "analista", label: "Analista post-evento / Seguros", icon: "🛰️" },
  { key: "ong", label: "ONG / Logística humanitaria", icon: "📦" },
]

export default function StartScreen({ onReady }) {
  const [responderType, setResponderType] = useState(null)
  const [zoneQuery, setZoneQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const canSubmit = responderType && zoneQuery.trim().length >= 3 && !loading

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    setLoading(true)
    setError(null)
    try {
      const zoneInfo = await geocodeZone(zoneQuery.trim())
      onReady({ responderType, zoneInfo })
    } catch (err) {
      setError(err.message || "No se pudo ubicar la zona. Intenta de nuevo.")
      setLoading(false)
    }
  }

  return (
    <div style={{
      height: "100vh", width: "100vw", background: theme.bg,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "system-ui, -apple-system, sans-serif", padding: "24px", boxSizing: "border-box",
    }}>
      <form onSubmit={handleSubmit} style={{
        background: theme.panelBg, borderRadius: "14px", border: `1px solid ${theme.border}`,
        boxShadow: "0 8px 30px rgba(30,58,92,0.08)", padding: "36px 40px",
        maxWidth: "520px", width: "100%", boxSizing: "border-box",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
          <span style={{ fontSize: "26px" }}>🔥</span>
          <span style={{ fontSize: "22px", color: theme.textPrimary }}>Fire</span>
          <span style={{ fontWeight: "bold", fontSize: "22px", color: theme.orange }}>Watch SAR</span>
        </div>
        <p style={{ color: theme.textSecondary, fontSize: "13.5px", lineHeight: "1.6", margin: "10px 0 26px" }}>
          Plataforma de inteligencia de incendios forestales en tiempo casi real. Combina detecciones
          satelitales (NASA FIRMS), perímetros activos, infraestructura crítica y Fire Weather Index
          para dar a los equipos de respuesta una vista de comando de su zona.
        </p>

        <label style={{ display: "block", fontSize: "12px", fontWeight: "bold", color: theme.textPrimary, marginBottom: "8px", letterSpacing: "0.03em" }}>
          ¿QUÉ TIPO DE RESPONDER ERES?
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "22px" }}>
          {RESPONDER_TYPES.map(({ key, label, icon }) => (
            <button type="button" key={key} onClick={() => setResponderType(key)}
              style={{
                display: "flex", alignItems: "center", gap: "8px", textAlign: "left",
                padding: "9px 10px", borderRadius: "8px", cursor: "pointer",
                border: `1.5px solid ${responderType === key ? theme.orange : theme.border}`,
                background: responderType === key ? theme.orangeSoft : "#fff",
                color: theme.textPrimary, fontSize: "12.5px", fontWeight: responderType === key ? "600" : "400",
              }}>
              <span style={{ fontSize: "16px" }}>{icon}</span>
              {label}
            </button>
          ))}
        </div>

        <label style={{ display: "block", fontSize: "12px", fontWeight: "bold", color: theme.textPrimary, marginBottom: "8px", letterSpacing: "0.03em" }}>
          ¿QUÉ ZONA DESEAS MONITOREAR?
        </label>
        <input
          type="text" value={zoneQuery} onChange={(e) => setZoneQuery(e.target.value)}
          placeholder="Ej. Zapopan, Jalisco, México"
          style={{
            width: "100%", padding: "10px 12px", borderRadius: "8px", boxSizing: "border-box",
            border: `1.5px solid ${theme.border}`, fontSize: "13.5px", outline: "none",
            marginBottom: "6px", color: theme.textPrimary,
          }} />
        <div style={{ color: theme.textMuted, fontSize: "11px", marginBottom: "20px" }}>
          Municipio, estado o país. La app ubica la zona automáticamente.
        </div>

        {error && (
          <div style={{ background: theme.dangerSoft, color: theme.danger, borderRadius: "8px", padding: "8px 10px", fontSize: "12px", marginBottom: "16px" }}>
            {error}
          </div>
        )}

        <button type="submit" disabled={!canSubmit} style={{
          width: "100%", padding: "12px", borderRadius: "8px", border: "none",
          background: canSubmit ? theme.orange : theme.border,
          color: canSubmit ? "#fff" : theme.textMuted,
          fontWeight: "bold", fontSize: "14px", cursor: canSubmit ? "pointer" : "not-allowed",
        }}>
          {loading ? "Ubicando zona..." : "Entrar al centro de comando"}
        </button>
      </form>
    </div>
  )
}
