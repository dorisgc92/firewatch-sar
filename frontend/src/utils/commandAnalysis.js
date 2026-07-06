/**
 * commandAnalysis.js
 * Builds the "situation brief" shown in the right panel: which fires need
 * attention first, what response infrastructure is nearest to each, and a
 * spread-risk read based on the nearest FWI grid point (wind + trend).
 *
 * This is intentionally built only from data the app actually has
 * (FIRMS FRP/intensity, OSM infrastructure, FWI wind/trend) — no invented
 * numbers. Where data is missing (e.g. infrastructure not yet mapped for a
 * region), the brief says so instead of guessing.
 */

import { nearestFeatures } from "./spatial"

const HOSPITAL_TYPES = ["Hospital", "Clinic"]
const FIRE_STATION_TYPES = ["Fire Station"]
const POLICE_TYPES = ["Police Station"]

const RESPONDER_ACTION = {
  bombero: "Priorizar despliegue de brigada hacia los focos de intensidad extrema listados abajo.",
  eoc: "Asignar recursos entre focos según prioridad y confirmar frescura de datos antes de comprometer unidades.",
  proteccion_civil: "Evaluar activación de refugios y rutas de evacuación para la infraestructura en riesgo listada abajo.",
  ems: "Confirmar capacidad de los hospitales listados para recibir posibles evacuados o personal con lesiones por humo.",
  utilities: "Evaluar corte preventivo en subestaciones dentro del radio de los focos de intensidad extrema.",
  analista: "Marcar estos focos para evaluación de daño post-evento con Sentinel-1 una vez contenido el incendio.",
  ong: "Confirmar accesibilidad de rutas de suministro evitando las zonas de perímetro activo.",
}

function windDirLabel(deg) {
  if (deg == null) return null
  const dirs = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"]
  return dirs[Math.round(deg / 45) % 8]
}

/**
 * @param {object} params
 * @param {Array} params.zoneHotspots - fire detections already filtered to the monitored zone
 * @param {Array} params.infraInZone - infrastructure features already filtered to the monitored zone
 * @param {Array} params.fwiPoints - global FWI grid points (sparse; used as nearest-neighbor proxy)
 * @param {string} params.responderType - key from the start screen (bombero, eoc, ems, ...)
 * @returns {{ priorityFires: Array, hasInfraData: boolean, actionLine: string }}
 */
export function buildCommandBrief({ zoneHotspots, infraInZone, fwiPoints, responderType }) {
  const hasInfraData = (infraInZone?.length || 0) > 0

  if (!zoneHotspots || zoneHotspots.length === 0) {
    return { priorityFires: [], hasInfraData, actionLine: null, empty: true }
  }

  const sorted = [...zoneHotspots].sort((a, b) => (b.properties.frp || 0) - (a.properties.frp || 0))
  const priority = sorted.filter((f) => ["extreme", "high"].includes(f.properties.intensity)).slice(0, 5)
  const chosen = priority.length > 0 ? priority : sorted.slice(0, 3)

  const hospitals = (infraInZone || []).filter((i) => HOSPITAL_TYPES.includes(i.properties.type))
  const fireStations = (infraInZone || []).filter((i) => FIRE_STATION_TYPES.includes(i.properties.type))
  const policeStations = (infraInZone || []).filter((i) => POLICE_TYPES.includes(i.properties.type))

  const priorityFires = chosen.map((f) => {
    const [lon, lat] = f.geometry.coordinates

    const nh = hospitals.length ? nearestFeatures(lat, lon, hospitals, 1)[0] : null
    const nf = fireStations.length ? nearestFeatures(lat, lon, fireStations, 1)[0] : null
    const np = policeStations.length ? nearestFeatures(lat, lon, policeStations, 1)[0] : null
    const nfwi = fwiPoints?.length ? nearestFeatures(lat, lon, fwiPoints, 1)[0] : null

    return {
      lat,
      lon,
      frp: f.properties.frp,
      intensity: f.properties.intensity,
      source: f.properties.source,
      acq_datetime: f.properties.acq_datetime,
      nearestHospital: nh ? { name: nh.feature.properties.name, km: nh.distanceKm } : null,
      nearestFireStation: nf ? { name: nf.feature.properties.name, km: nf.distanceKm } : null,
      nearestPolice: np ? { name: np.feature.properties.name, km: np.distanceKm } : null,
      windKmh: nfwi?.feature?.properties?.wind_kmh ?? null,
      windDir: windDirLabel(nfwi?.feature?.properties?.wind_dir_deg),
      fwiTrend: nfwi?.feature?.properties?.trend ?? null,
      fwiRiskLabel: nfwi?.feature?.properties?.risk_label ?? null,
    }
  })

  return {
    priorityFires,
    hasInfraData,
    actionLine: RESPONDER_ACTION[responderType] || RESPONDER_ACTION.eoc,
    empty: false,
  }
}
