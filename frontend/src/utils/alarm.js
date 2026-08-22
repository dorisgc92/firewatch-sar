/**
 * alarm.js
 * A short, synthesized two-note chime (~350ms total) for "something just
 * changed, look at the screen" moments — a new request arriving for a
 * responder, a genuinely new fire showing up for the EOC. Built with the
 * Web Audio API instead of an audio file: no asset to host, no license to
 * track, and it's trivial to keep deliberately brief and non-grating
 * (two quick tones, not a siren) — exactly what was asked for: an alert
 * that gets noticed once, not one that loops or wears on the ear.
 *
 * Browsers block audio from starting before the user has interacted with
 * the page at all — by the time an alarm could fire here (after picking
 * a role/zone, clicking buttons), that's already happened, so this
 * should just work. Wrapped in try/catch regardless so a blocked or
 * unsupported AudioContext never breaks the UI — worst case, no sound,
 * the visual blinking (handled separately by each caller) still carries
 * the alert on its own.
 */
let sharedContext = null

function getContext() {
  if (sharedContext) return sharedContext
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return null
  sharedContext = new Ctx()
  return sharedContext
}

function tone(ctx, freq, startAt, duration, gainPeak = 0.15) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = "sine"
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0, startAt)
  gain.gain.linearRampToValueAtTime(gainPeak, startAt + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(startAt)
  osc.stop(startAt + duration + 0.02)
}

// One-shot chime, safe to call as often as needed — each call is
// independent and self-contained (no state carried between calls, no
// looping), matching "breve, no molesto, no interminable".
export function playAlarmChime() {
  try {
    const ctx = getContext()
    if (!ctx) return
    if (ctx.state === "suspended") ctx.resume().catch(() => {})
    const now = ctx.currentTime
    tone(ctx, 880, now, 0.14)        // A5
    tone(ctx, 1174.66, now + 0.12, 0.18) // D6 — quick two-note "ding-ding", not a siren
  } catch {
    /* audio unsupported/blocked — the visual blink still carries the alert */
  }
}
