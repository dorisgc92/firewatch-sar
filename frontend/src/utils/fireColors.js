/**
 * fireColors.js
 * Single source of truth for fire-intensity colors, used by both the map
 * (FireMap.jsx) and the sidebar's expandable fire lists (Sidebar.jsx) so a
 * "high" intensity dot always looks the same everywhere in the app.
 */
export const INTENSITY_COLORS = {
  low: "#FFD400",
  moderate: "#FF8C00",
  high: "#FF3300",
  extreme: "#B00020",
  unknown: "#FF6600",
}

export const INTENSITY_STROKE = {
  low: "#7A5C00",
  moderate: "#8A4500",
  high: "#7A0000",
  extreme: "#4D000A",
  unknown: "#663300",
}
