/**
 * gameAsset(key) — resolve a sprite sheet URL by its asset key.
 *
 * The backend's generate_sprite_sheet tool uploads to a deterministic path:
 *   app-images/{projectId}/sprites/{key}.png
 *
 * This helper builds that URL at runtime using the template's Supabase env
 * vars. Scene code calls it like:
 *
 *   this.load.spritesheet('hero_idle', gameAsset('hero_idle'), {
 *     frameWidth: 128, frameHeight: 128,
 *   })
 *
 * Because the URL is deterministic, code can reference keys before the
 * corresponding generate_sprite_sheet tool call finishes — the sprite will
 * load as soon as it exists (or 404 if the key was never generated).
 *
 * The URL carries a version (P69): regenerating a key writes the new sheet to the
 * same path, and a browser keeps a picture for an hour (Supabase's CDN ~40 min), so
 * an unchanged URL keeps showing the old sheet. VITE_SPRITE_VERSIONS is 'load' in
 * the editor preview (a fresh version on every page load) and, in a published app,
 * { key: when that sheet last changed } stamped at publish. Unset, or a key it does
 * not list → the bare URL.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID
const SPRITE_VERSIONS = import.meta.env.VITE_SPRITE_VERSIONS || ''
const PAGE_LOAD = Date.now().toString(36)

let versionMap = null
function spriteVersion(key) {
  if (SPRITE_VERSIONS === 'load') return PAGE_LOAD
  if (versionMap === null) {
    try { versionMap = SPRITE_VERSIONS ? JSON.parse(SPRITE_VERSIONS) : {} } catch { versionMap = {} }
    if (!versionMap || typeof versionMap !== 'object') versionMap = {}
  }
  const v = versionMap[key]
  return typeof v === 'string' ? v : ''
}

export function gameAsset(key) {
  if (!key || typeof key !== 'string') {
    console.warn('[gameAsset] empty or non-string key')
    return ''
  }
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  const url = `${SUPABASE_URL}/storage/v1/object/public/app-images/${PROJECT_ID}/sprites/${safe}.png`
  const v = spriteVersion(safe)
  return v ? `${url}?v=${encodeURIComponent(v)}` : url
}
