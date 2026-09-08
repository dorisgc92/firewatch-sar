/**
 * Helper independiente de clasificación WorldCover -- llama al mismo
 * endpoint /api/landcover que usa useZoneLandCover.js, pero como una
 * función async simple, sin estado de React, sin debounce ni caché de
 * sesión. Usado por cellPerimeter.js para clasificar centros de celdas
 * de cuadrícula bajo demanda.
 *
 * Nota: la lógica de fetch está intencionalmente duplicada en vez de
 * refactorizada como import compartido con useZoneLandCover.js, para no
 * tocar ese hook (que ya funciona) mientras esta función nueva se
 * construye y prueba de forma independiente.
 */
export async function classifyPointsBatch(points) {
  if (!points.length) return []
  try {
    const r = await fetch("/api/landcover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: points.map((p) => ({ lat: p.lat, lon: p.lon })),
        window_size: 3,
      }),
    })
    const data = await r.json()
    const results = data.results || []
    return points.map((p, i) => ({
      lat: p.lat,
      lon: p.lon,
      category: results[i]?.category ?? null,
    }))
  } catch {
    // Fail open, misma filosofía que useZoneLandCover.js: ante cualquier
    // error de red, cada punto vuelve como "sin clasificar" en vez de
    // lanzar excepción -- buildPerimeterFromCells trata las celdas sin
    // clasificar como excluidas, así que un fallo de red solo encoge el
    // perímetro en vez de romperlo.
    return points.map((p) => ({ lat: p.lat, lon: p.lon, category: null }))
  }
}