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

import { nearestFeatures, bearingDeg, angleDiffDeg, distanceKm } from "./spatial"

const HOSPITAL_TYPES = ["Hospital", "Clinic"]
const FIRE_STATION_TYPES = ["Fire Station"]
const POLICE_TYPES = ["Police Station"]
const CRITICAL_THREAT_TYPES = [
  "Hospital", "Clinic", "Fire Station", "Police Station", "School (shelter)",
  "Power Substation", "Power Plant", "Airport/Airfield", "Water Reservoir",
]

// How far from a fire we still consider infrastructure "at risk" — beyond
// this, even a direct downwind alignment isn't an imminent threat.
const THREAT_RADIUS_KM = 15
// How tightly the infrastructure has to line up with the wind direction to
// count as "in the fire's path" rather than just "nearby but off to the side".
const DOWNWIND_TOLERANCE_DEG = 50

/**
 * Flags critical infrastructure that a nearby fire's spread is actually
 * being pushed toward — not just "closest by distance" (which the priority
 * fire cards already show), but specifically downwind, using the nearest
 * FWI grid point's wind direction as a proxy for local wind. This is what
 * "about to be reached" means in practice: distance alone doesn't tell you
 * which side of a fire is actually in danger.
 *
 * @returns Array of { infra, fire, distanceKm, bearingDeg, windAligned }
 *          sorted by distance, nearest first.
 */
export function findThreatenedInfrastructure({ zoneHotspots, infraInZone, fwiPoints, maxDistanceKm = THREAT_RADIUS_KM }) {
  if (!zoneHotspots?.length || !infraInZone?.length) return []

  const critical = infraInZone.filter((i) => CRITICAL_THREAT_TYPES.includes(i.properties.type))
  if (critical.length === 0) return []

  const threats = []
  const seenInfra = new Set()

  // Look at the most intense fires first — if a facility is within range of
  // several fires, it gets attributed to whichever is most severe. Capped
  // to the top MAX_FIRES_TO_CHECK: a zone like all of Canada can have
  // 20,000+ detections, and checking every single one against every
  // critical facility (with a trig-heavy bearing calc per pair) was
  // freezing the tab. The most severe fires are what actually matter for
  // "what's about to be reached" anyway — the long tail of small/duplicate
  // detections doesn't change the answer.
  const MAX_FIRES_TO_CHECK = 300
  const sortedFires = [...zoneHotspots]
    .sort((a, b) => (b.properties.frp || 0) - (a.properties.frp || 0))
    .slice(0, MAX_FIRES_TO_CHECK)

  for (const fire of sortedFires) {
    const [flon, flat] = fire.geometry.coordinates
    const nearestWind = fwiPoints?.length ? nearestFeatures(flat, flon, fwiPoints, 1)[0] : null
    const windFromDeg = nearestWind?.feature?.properties?.wind_dir_deg
    // Meteorological convention: wind_dir_deg is where the wind comes FROM.
    // It blows TOWARD the opposite bearing.
    const windTowardDeg = windFromDeg != null ? (windFromDeg + 180) % 360 : null

    for (const infra of critical) {
      const key = infra.properties.osm_id ?? `${infra.properties.name}-${infra.geometry.coordinates.join(",")}`
      if (seenInfra.has(key)) continue

      const [ilon, ilat] = infra.geometry.coordinates
      const dist = distanceKm(flat, flon, ilat, ilon)
      if (dist > maxDistanceKm) continue

      const bearing = bearingDeg(flat, flon, ilat, ilon)
      const windAligned = windTowardDeg != null && angleDiffDeg(bearing, windTowardDeg) <= DOWNWIND_TOLERANCE_DEG

      // Only flag as a threat if it's either downwind, or close enough
      // (< 3km) that direction barely matters — a fire that close is a
      // risk to everything around it regardless of which way the wind blows.
      if (!windAligned && dist > 3) continue

      seenInfra.add(key)
      threats.push({
        infra,
        fire,
        distanceKm: dist,
        bearingDeg: bearing,
        windAligned,
        windKmh: nearestWind?.feature?.properties?.wind_kmh ?? null,
      })
    }
  }

  threats.sort((a, b) => a.distanceKm - b.distanceKm)
  return threats
}

const RESPONDER_ACTION = {
  bombero: "Priorizar despliegue de brigada hacia los focos de intensidad extrema listados abajo.",
  eoc: "Asignar recursos entre focos según prioridad y confirmar frescura de datos antes de comprometer unidades.",
  proteccion_civil: "Evaluar activación de refugios y rutas de evacuación para la infraestructura en riesgo listada abajo.",
  ems: "Confirmar capacidad de los hospitales listados para recibir posibles evacuados o personal con lesiones por humo.",
  utilities: "Evaluar corte preventivo en subestaciones dentro del radio de los focos de intensidad extrema.",
  analista: "Marcar estos focos para evaluación de daño post-evento con Sentinel-1 una vez contenido el incendio.",
  ong: "Confirmar accesibilidad de rutas de suministro evitando las zonas de perímetro activo.",
}

export function windDirLabel(deg) {
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