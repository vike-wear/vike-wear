// Text color for content sitting ON the app's primary color (bg-primary buttons
// etc.). Apps theme --color-primary freely (index.css, space-separated RGB triple);
// hardcoded white text becomes unreadable on bright primaries (yellow/neon) — a
// real prod complaint class. Computes YIQ luminance once and picks ink/white.
// 150 (not the classic 128) biases toward dark text earlier — white text gets
// hard to read well before mid-luminance.

let cached = null

export function onPrimaryColor() {
  if (cached) return cached
  let result = '#ffffff'
  try {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-primary').trim()
    const parts = raw.split(/[\s,/]+/).map(Number)
    if (parts.length >= 3 && parts.slice(0, 3).every(n => Number.isFinite(n))) {
      const [r, g, b] = parts
      const yiq = (r * 299 + g * 587 + b * 114) / 1000
      result = yiq >= 150 ? '#1c1917' : '#ffffff' // stone-900 on light primaries
    }
  } catch { /* SSR/parse failure → white, the common case */ }
  cached = result
  return result
}
