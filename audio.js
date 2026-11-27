// fetchWithCreditRetry wraps every metered call below: shared 429 handling
// (modal + throw) plus one retry after an anonymous visitor signs in from the
// credits prompt. Header builders run per attempt inside each closure, so the
// retry carries the fresh signed-in identity.
import { fetchWithCreditRetry } from './_rate-limit'
import { getAuthHeaders, getHeaders } from './_headers'
import { showWriteLimitNotice } from './_write-notice'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { absorbSessionRenewal } from './_session-expiry'
import { KEEPALIVE_HEADERS, readKeepaliveJson, throwFromEnvelope } from './_keepalive'
import { fileSizeMb, overUploadCap, tooLargeError } from './_too-large'
import { playSeries } from './_audio-series'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID

// ── Request path (L2 pass, 2026-09-27) ─────────────────────────────────────
// Every audio call carries a deadline (sdkFetch), the long ones (transcribe,
// music, voice clone, voice design) also the keep-alive header so Cloudflare's
// 100s origin timeout cannot cut the answer. Failures throw the SDK's standard
// Error: .message = the server's sentence, .status, .code — CREDITS_EXHAUSTED
// (after the credits modal), DAILY_LIMIT, RATE_LIMITED, QUOTA_EXCEEDED (storage /
// voice slots), PAYLOAD_TOO_LARGE, BAD_REQUEST, PROVIDER_ERROR,
// PROVIDER_UNAVAILABLE …; TIMEOUT / NETWORK / KEEPALIVE_CUT WITHOUT a status
// when the server never finished answering.
// The account's per-file upload cap in MB, stamped at publish (default 25).
function uploadMaxMb() {
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}
  const n = Number(env.VITE_WHACKA_UPLOAD_MAX_MB)
  return Number.isFinite(n) && n > 0 ? n : 25
}
const AUDIO_TIMEOUTS = {
  transcribe: 180_000,
  upload: 120_000,
  tts: 90_000,          // long passages take the provider tens of seconds
  music: 180_000,
  voice: 90_000,        // speech-to-speech on a long clip
  'sound-effect': 90_000,
  'voice-design': 120_000,
  'voice-save': 30_000,
  'voice-clone': 240_000,
  voices: 30_000,
}
const AUDIO_KEEPALIVE = new Set(['transcribe', 'music', 'voice-design', 'voice-clone'])

// Issue one audio request. `credits` (default true) routes it through the
// shared 429 handling (credits modal + one retry after an anonymous visitor
// signs in from the prompt). Returns the Response after the ok/throw check.
async function audioRequest(path, init, { fallback, credits = true } = {}) {
  const route = `audio/${path}`
  const keepalive = AUDIO_KEEPALIVE.has(path)
  const headers = keepalive ? { ...(init.headers || {}), ...KEEPALIVE_HEADERS } : init.headers
  const issue = () => sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/audio/${path}`, { ...init, headers }, {
    // An account with a raised per-file cap gets the same time per megabyte.
    timeoutMs: path === 'upload' ? Math.round(AUDIO_TIMEOUTS.upload * Math.max(1, uploadMaxMb() / 25)) : AUDIO_TIMEOUTS[path],
    route,
  })
  const res = credits ? await fetchWithCreditRetry(issue) : await issue()
  absorbSessionRenewal(res)
  if (!res.ok) await throwFromResponse(res, fallback, route)
  return res
}

// The JSON body of an audio response; unwraps the keep-alive envelope on the
// long ops (a plain answer unwraps to itself).
async function audioJson(res, path, fallback) {
  const route = `audio/${path}`
  const out = await readKeepaliveJson(res, route, { timeoutMs: AUDIO_TIMEOUTS[path] })
  if (!out.ok) throwFromEnvelope(out, res, fallback, route)
  return out.body
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Check if browser supports audio recording */
const isSupported =
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices &&
  typeof navigator.mediaDevices.getUserMedia === 'function' &&
  typeof MediaRecorder !== 'undefined'

/** Pick the best supported audio MIME type */
function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return undefined
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus'
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm'
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4'
  return undefined
}

function extForMime(mime) {
  if (!mime) return 'webm'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('wav')) return 'wav'
  return 'webm'
}

// ─────────────────────────────────────────────
// MediaSession helper — attach lock-screen / control-center metadata
// and action handlers to an HTMLAudioElement.
// ─────────────────────────────────────────────

function applyMediaSession(el, meta) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return () => {}
  const ms = navigator.mediaSession
  try {
    ms.metadata = new window.MediaMetadata({
      title: meta.title || '',
      artist: meta.artist || '',
      album: meta.album || '',
      artwork: meta.artwork
        ? (Array.isArray(meta.artwork) ? meta.artwork : [{ src: meta.artwork, sizes: '512x512', type: 'image/png' }])
        : [],
    })
  } catch (err) {
    console.warn('[audio] MediaSession metadata failed:', err)
  }

  const setHandler = (action, handler) => {
    try { ms.setActionHandler(action, handler) } catch {}
  }

  setHandler('play', () => { el.play().catch(() => {}) })
  setHandler('pause', () => { el.pause() })
  setHandler('stop', () => { el.pause(); el.currentTime = 0 })
  setHandler('seekto', (details) => {
    if (details.seekTime != null) el.currentTime = details.seekTime
  })
  setHandler('seekbackward', (details) => {
    el.currentTime = Math.max(0, el.currentTime - (details.seekOffset || 10))
  })
  setHandler('seekforward', (details) => {
    el.currentTime = Math.min(el.duration || Infinity, el.currentTime + (details.seekOffset || 10))
  })

  const updatePlaybackState = () => {
    ms.playbackState = el.paused ? 'paused' : 'playing'
  }
  const updatePositionState = () => {
    if (!isFinite(el.duration) || el.duration <= 0) return
    try {
      ms.setPositionState({
        duration: el.duration,
        playbackRate: el.playbackRate,
        position: el.currentTime,
      })
    } catch {}
  }

  el.addEventListener('play', updatePlaybackState)
  el.addEventListener('pause', updatePlaybackState)
  el.addEventListener('timeupdate', updatePositionState)
  el.addEventListener('loadedmetadata', updatePositionState)

  // Cleanup — clear handlers and metadata so a later play() doesn't re-trigger
  // old actions on a stale element.
  return () => {
    el.removeEventListener('play', updatePlaybackState)
    el.removeEventListener('pause', updatePlaybackState)
    el.removeEventListener('timeupdate', updatePositionState)
    el.removeEventListener('loadedmetadata', updatePositionState)
    for (const action of ['play', 'pause', 'stop', 'seekto', 'seekbackward', 'seekforward']) {
      try { ms.setActionHandler(action, null) } catch {}
    }
    ms.metadata = null
    ms.playbackState = 'none'
  }
}

// A list of URLs plays in order on ONE element (_audio-series.js): iPhones play only an element a tap
// started, so a series made of one element per item goes silent from the second item (delivery ledger T11).
// Lock-screen metadata as for one clip, plus next / previous track.
function playList(urls, options) {
  const { title, artist, album, artwork, onEnd } = options
  let cleanup = () => {}
  const series = playSeries(urls, { ...options, onEnd: () => { cleanup(); if (typeof onEnd === 'function') onEnd() } })
  console.log('[audio] play list: ' + series.length + ' items')
  if (series.index < 0 || series.index >= series.length) return series
  const dispose = applyMediaSession(series.element, { title, artist, album, artwork })
  const ms = typeof navigator !== 'undefined' && navigator.mediaSession
  const setHandler = (action, handler) => { try { ms && ms.setActionHandler(action, handler) } catch {} }
  setHandler('nexttrack', () => series.next())
  setHandler('previoustrack', () => series.previous())
  cleanup = () => { dispose(); setHandler('nexttrack', null); setHandler('previoustrack', null); cleanup = () => {} }
  const stop = series.stop
  series.stop = () => { stop(); cleanup() }
  return series
}

// ─────────────────────────────────────────────
// Smooth volume ramp via requestAnimationFrame.
// Replaces Web Audio GainNode ramping so mixed playback uses plain
// HTMLAudioElements — which DO survive iOS PWA lock-screen, unlike Web Audio
// contexts (iOS suspends AudioContext on lock and won't resume from the
// lock-screen play button).
// ─────────────────────────────────────────────

function rampVolume(el, target, ms) {
  if (!el) return () => {}
  const clamped = Math.max(0, Math.min(1, target))
  if (ms <= 0) {
    el.volume = clamped
    return () => {}
  }
  const startVol = el.volume
  const delta = clamped - startVol
  const startTime = performance.now()
  let cancelled = false
  const tick = () => {
    if (cancelled) return
    const elapsed = performance.now() - startTime
    const t = Math.min(1, elapsed / ms)
    el.volume = Math.max(0, Math.min(1, startVol + delta * t))
    if (t < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return () => { cancelled = true }
}

// ─────────────────────────────────────────────
// Ambient library — curated CC0 loops served from the Supabase `app-ambient`
// bucket. Manifest loaded once on first access, then cached in memory.
// ─────────────────────────────────────────────

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || ''
const AMBIENT_BUCKET = 'app-ambient'
const AMBIENT_PREFIX = 'ambient-library/'
const AMBIENT_MANIFEST_URL = SUPABASE_URL
  ? `${SUPABASE_URL}/storage/v1/object/public/${AMBIENT_BUCKET}/${AMBIENT_PREFIX}manifest.json`
  : null

let ambientManifestCache = null
let ambientManifestPromise = null

async function loadAmbientManifest() {
  if (ambientManifestCache) return ambientManifestCache
  if (ambientManifestPromise) return ambientManifestPromise
  if (!AMBIENT_MANIFEST_URL) {
    throw new Error('Ambient library unavailable (VITE_SUPABASE_URL not set)')
  }
  ambientManifestPromise = (async () => {
    const res = await sdkFetch(AMBIENT_MANIFEST_URL, {}, { timeoutMs: 30_000, route: 'ambient-manifest' })
    if (!res.ok) throw new Error(`Ambient manifest fetch failed (${res.status})`)
    const manifest = await res.json()
    for (const t of manifest.tracks || []) {
      t.url = `${SUPABASE_URL}/storage/v1/object/public/${AMBIENT_BUCKET}/${AMBIENT_PREFIX}${t.filename}`
    }
    ambientManifestCache = manifest
    return manifest
  })()
  try {
    return await ambientManifestPromise
  } catch (err) {
    ambientManifestPromise = null
    throw err
  }
}

// ─────────────────────────────────────────────
// Quran recitation — streamed from the Islamic Network public CDN
// (cdn.islamic.network). We embed/stream as a client; we do NOT re-host the
// recordings (each reciter's recitation is their copyrighted performance).
// Pure URL building — no fetch, no manifest.
// ─────────────────────────────────────────────

const QURAN_CDN = 'https://cdn.islamic.network/quran/audio'

// Curated reciters. `bitrate` is the one verified available on the CDN for that
// edition (some editions 403 at 128 but serve at 64, and vice-versa).
const QURAN_RECITERS = [
  { id: 'alafasy', name: 'Mishary Alafasy', arabic: 'مشاري العفاسي', edition: 'ar.alafasy', bitrate: 128 },
  { id: 'sudais', name: 'Abdurrahman As-Sudais', arabic: 'عبدالرحمن السديس', edition: 'ar.abdurrahmaansudais', bitrate: 64 },
  { id: 'shuraim', name: 'Saud Ash-Shuraim', arabic: 'سعود الشريم', edition: 'ar.saoodshuraym', bitrate: 64 },
  { id: 'husary', name: 'Mahmoud Khalil Al-Husary', arabic: 'محمود خليل الحصري', edition: 'ar.husary', bitrate: 128 },
  { id: 'minshawi', name: 'Mohamed Siddiq El-Minshawi', arabic: 'محمد صديق المنشاوي', edition: 'ar.minshawi', bitrate: 128 },
  { id: 'maher', name: 'Maher Al-Muaiqly', arabic: 'ماهر المعيقلي', edition: 'ar.mahermuaiqly', bitrate: 128 },
  { id: 'hudhaify', name: 'Ali Al-Hudhaify', arabic: 'علي الحذيفي', edition: 'ar.hudhaify', bitrate: 128 },
  { id: 'shaatree', name: 'Abu Bakr Ash-Shaatree', arabic: 'أبو بكر الشاطري', edition: 'ar.shaatree', bitrate: 128 },
  { id: 'ajamy', name: 'Ahmed Al-Ajamy', arabic: 'أحمد العجمي', edition: 'ar.ahmedajamy', bitrate: 128 },
  { id: 'husary_mujawwad', name: 'Al-Husary (Mujawwad)', arabic: 'الحصري (مجوّد)', edition: 'ar.husarymujawwad', bitrate: 128 },
]

// Ayahs per surah (standard Hafs numbering; sums to 6236). The CDN indexes
// audio by GLOBAL ayah number 1..6236, so we map (surah, ayah) → global.
const QURAN_AYAH_COUNTS = [
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
  112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
  54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13,
  14, 11, 11, 18, 12, 12, 30, 52, 52, 44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42,
  29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11,
  11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
]
const QURAN_GLOBAL_OFFSET = (() => {
  const out = [0]
  for (let i = 0; i < QURAN_AYAH_COUNTS.length; i++) out.push(out[i] + QURAN_AYAH_COUNTS[i])
  return out // out[s-1] = ayahs before surah s; total = out[114] = 6236
})()

function quranReciter(id) {
  return QURAN_RECITERS.find((r) => r.id === id) || QURAN_RECITERS[0]
}
function quranAyahUrl(surah, ayah, reciterId) {
  const s = Number(surah), a = Number(ayah)
  if (!Number.isInteger(s) || s < 1 || s > 114) throw new Error(`Quran: surah must be 1–114 (got ${surah})`)
  const max = QURAN_AYAH_COUNTS[s - 1]
  if (!Number.isInteger(a) || a < 1 || a > max) throw new Error(`Quran: surah ${s} has ${max} ayahs (got ayah ${ayah})`)
  const r = quranReciter(reciterId)
  const global = QURAN_GLOBAL_OFFSET[s - 1] + a
  return `${QURAN_CDN}/${r.bitrate}/${r.edition}/${global}.mp3`
}

// ─────────────────────────────────────────────
// Adhan (call to prayer) — a small set of openly-licensed recordings we self-host
// in the Supabase `app-ambient` bucket (these have CC0 / CC-BY-SA / public-domain
// licenses that permit redistribution, unlike the copyrighted Quran recitations).
// ─────────────────────────────────────────────

const ADHAN_PREFIX = 'adhan-library/'
const ADHAN_MANIFEST_URL = SUPABASE_URL
  ? `${SUPABASE_URL}/storage/v1/object/public/${AMBIENT_BUCKET}/${ADHAN_PREFIX}manifest.json`
  : null

let adhanManifestCache = null
let adhanManifestPromise = null

async function loadAdhanManifest() {
  if (adhanManifestCache) return adhanManifestCache
  if (adhanManifestPromise) return adhanManifestPromise
  if (!ADHAN_MANIFEST_URL) throw new Error('Adhan library unavailable (VITE_SUPABASE_URL not set)')
  adhanManifestPromise = (async () => {
    const res = await sdkFetch(ADHAN_MANIFEST_URL, {}, { timeoutMs: 30_000, route: 'adhan-manifest' })
    if (!res.ok) throw new Error(`Adhan manifest fetch failed (${res.status})`)
    const manifest = await res.json()
    for (const t of manifest.adhans || []) {
      t.url = `${SUPABASE_URL}/storage/v1/object/public/${AMBIENT_BUCKET}/${ADHAN_PREFIX}${t.filename}`
    }
    adhanManifestCache = manifest
    return manifest
  })()
  try {
    return await adhanManifestPromise
  } catch (err) {
    adhanManifestPromise = null
    throw err
  }
}

// ─────────────────────────────────────────────
// Audio helper
// ─────────────────────────────────────────────

export const audio = {
  /** Whether the browser supports audio recording */
  isSupported,

  /**
   * Transcribe an audio blob to text using AI speech recognition.
   * Optionally save the audio file and get back a URL.
   *
   * @param {Blob} blob - Audio blob (from MediaRecorder, file input, etc.)
   * @param {object} [options]
   * @param {boolean} [options.save=false] - Also save the audio and return its URL
   * @param {string} [options.sessionId] - Session ID for per-minute billing (chunks in same session share cost)
   * @returns {Promise<{ text: string, url?: string }>}
   *
   * @example
   * const { text } = await audio.transcribe(blob)
   * const { text, url } = await audio.transcribe(blob, { save: true })
   */
  async transcribe(blob, options = {}) {
    const { save = false, sessionId } = options
    console.log('[audio] transcribe called: size=' + blob.size + ', save=' + save)

    // Whisper and the platform edge both cap uploads at 25MB. Fail fast with a
    // clear message instead of an opaque 413 after a long upload — the same
    // PAYLOAD_TOO_LARGE / 413 the server answers (_too-large.js).
    if (blob.size > 25 * 1024 * 1024) {
      throw tooLargeError(`Audio file is too large (${fileSizeMb(blob.size, 25)}MB, max 25MB). Record compressed audio (MediaRecorder webm/opus) instead of WAV, or split the recording into parts.`, 'audio/transcribe')
    }

    const formData = new FormData()
    formData.append('file', blob, `recording.${extForMime(blob.type)}`)
    if (save) formData.append('save', 'true')
    if (sessionId) formData.append('sessionId', sessionId)

    const res = await audioRequest('transcribe', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: formData,
    }, { fallback: 'Transcription failed' })

    const data = await audioJson(res, 'transcribe', 'Transcription failed')
    console.log('[audio] transcribe result: text=' + (data.text?.length || 0) + ' chars' + (data.url ? ', url=' + data.url : ''))
    return data
  },

  /**
   * Upload an audio blob for storage without transcription.
   * Returns a public URL for the stored audio, or with { private: true } one
   * that opens only for people who can read the row it is saved in.
   *
   * @param {Blob} blob - Audio blob
   * @param {object} [options] - { private?: boolean }
   * @returns {Promise<{ url: string }>}
   *
   * @example
   * const { url } = await audio.upload(blob)
   */
  async upload(blob, options = {}) {
    console.log('[audio] upload called: size=' + blob.size)

    // The account's per-file cap, stamped at publish (VITE_WHACKA_UPLOAD_MAX_MB,
    // default 25) — refused here as PAYLOAD_TOO_LARGE / 413, reported as the
    // size limit and told to the visitor (_too-large.js). transcribe() above
    // keeps 25MB: that one is Whisper's own cap.
    const maxMb = uploadMaxMb()
    if (blob.size > maxMb * 1024 * 1024) {
      throw overUploadCap('audio/upload', blob.size, maxMb, `Audio file is too large (${fileSizeMb(blob.size, maxMb)}MB, max ${maxMb}MB). Record compressed audio (MediaRecorder webm/opus) instead of WAV.`)
    }

    const formData = new FormData()
    formData.append('file', blob, `recording.${extForMime(blob.type)}`)
    // A private recording opens only for people who can read the row it is saved in.
    if (options && options.private) formData.append('private', 'true')

    let res
    try {
      res = await audioRequest('upload', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: formData,
      }, { fallback: 'Upload failed', credits: false })
    } catch (err) {
      // Usage-limit refusal: surface it in the shell's own voice — apps rarely
      // render upload errors (a store app, 2026-07-28). Capacity ceiling
      // (QUOTA_EXCEEDED) gets the honest permanent-wall wording.
      if (err.status === 429) showWriteLimitNotice({ kind: err.code === 'QUOTA_EXCEEDED' ? 'uploadFull' : 'upload' })
      throw err
    }

    const data = await res.json()
    console.log('[audio] upload result: url=' + data.url)
    return data
  },

  /**
   * Convert text to speech. Returns a URL to the generated audio file.
   * Priced by length: a longer text costs more credits (a short line costs the least).
   *
   * @param {string} text - Text to convert to speech
   * @param {object} [options]
   * @param {string} [options.voice='rachel'] - Voice name or voice_id
   *   Built-in voices: rachel, adam, antoni, bella, domi, elli, josh, arnold, sam
   * @returns {Promise<{ url: string }>}
   *
   * @example
   * const { url } = await audio.speak("Hello world")
   * const { url } = await audio.speak("Welcome back!", { voice: 'adam' })
   * new Audio(url).play()
   */
  async speak(text, options = {}) {
    const { voice } = options
    console.log('[audio] speak called: text=' + text.length + ' chars, voice=' + (voice || 'default'))

    const res = await audioRequest('tts', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ text, voice, stream: false }),
    }, { fallback: 'Text-to-speech failed' })

    const data = await res.json()
    console.log('[audio] speak result: url=' + data.url)
    return data
  },

  /**
   * Stream text-to-speech audio for immediate playback.
   * Returns an Audio element that starts playing as data arrives.
   * Priced by length, like speak().
   *
   * @param {string} text - Text to convert to speech
   * @param {object} [options]
   * @param {string} [options.voice='rachel'] - Voice name or voice_id
   * @returns {Promise<HTMLAudioElement>}
   *
   * @example
   * const player = await audio.speakStream("Hello world")
   * // audio starts playing immediately
   * player.pause()  // pause playback
   */
  async speakStream(text, options = {}) {
    const { voice } = options
    console.log('[audio] speakStream called: text=' + text.length + ' chars, voice=' + (voice || 'default'))

    const res = await audioRequest('tts', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ text, voice, stream: true }),
    }, { fallback: 'Text-to-speech stream failed' })

    // Create a blob URL from the streaming response and play it
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const player = new Audio(url)

    // Clean up the object URL when audio finishes
    player.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true })

    console.log('[audio] speakStream playing')
    player.play().catch(() => {})
    return player
  },

  /**
   * Curated ambient audio library (CC0, free commercial use, no attribution).
   * Served from the Supabase `app-ambient` bucket. Use these loops as the
   * "ambient bed" for meditation, bedtime story, or daily-reading apps.
   *
   * Categories: `nature`, `noise`, `piano`, `bells`, `kids`, `breath`.
   *
   * @example
   * // Fetch a specific loop by id:
   * const url = await audio.ambient.get('rain-roof')
   * audio.play(url, { loop: true, volume: 0.5 })
   *
   * @example
   * // Pick one at random from a category:
   * const forest = await audio.ambient.random('nature')
   *
   * @example
   * // List what's available for a category picker UI:
   * const options = await audio.ambient.list('piano')
   * // [{ id, category, title, durationSec, url }, ...]
   */
  /**
   * Quran recitation audio, streamed from the Islamic Network CDN. These are
   * REAL recitations by well-known reciters (not text-to-speech). Pick a reciter
   * by id from audio.quran.reciters(); default is Mishary Alafasy.
   *
   * @example
   * // Play Ayat al-Kursi (surah 2, ayah 255) by Sudais:
   * const url = audio.quran.ayah(2, 255, { reciter: 'sudais' })
   * await audio.play(url)
   * @example
   * // Play a whole surah ayah-by-ayah (e.g. Al-Fatiha) — one list, one element (see audio.play):
   * const { urls } = audio.quran.surah(1, { reciter: 'alafasy' })
   * const recitation = audio.play(urls, { onItem: (i) => setAyah(i + 1) })
   */
  quran: {
    /** @returns {Array<{id, name, arabic}>} the available reciters */
    reciters() {
      return QURAN_RECITERS.map((r) => ({ id: r.id, name: r.name, arabic: r.arabic }))
    },
    /** Number of ayahs in a surah (1–114). */
    ayahCount(surah) {
      const s = Number(surah)
      if (!Number.isInteger(s) || s < 1 || s > 114) throw new Error(`Quran: surah must be 1–114 (got ${surah})`)
      return QURAN_AYAH_COUNTS[s - 1]
    },
    /**
     * URL for one ayah's recitation.
     * @param {number} surah 1–114
     * @param {number} ayah 1..ayahCount(surah)
     * @param {{reciter?: string}} [opts]
     * @returns {string} mp3 URL (synchronous — just a CDN URL)
     */
    ayah(surah, ayah, opts = {}) {
      return quranAyahUrl(surah, ayah, opts.reciter)
    },
    /**
     * All ayah URLs for a surah, in order — pass them to audio.play(urls) for full-surah
     * recitation (onItem highlights the current ayah).
     * @param {number} surah 1–114
     * @param {{reciter?: string}} [opts]
     * @returns {{surah:number, reciter:string, ayahCount:number, urls:string[]}}
     */
    surah(surah, opts = {}) {
      const s = Number(surah)
      if (!Number.isInteger(s) || s < 1 || s > 114) throw new Error(`Quran: surah must be 1–114 (got ${surah})`)
      const r = quranReciter(opts.reciter)
      const count = QURAN_AYAH_COUNTS[s - 1]
      const urls = []
      for (let a = 1; a <= count; a++) urls.push(quranAyahUrl(s, a, r.id))
      return { surah: s, reciter: r.id, ayahCount: count, urls }
    },
  },

  /**
   * Adhan (call to prayer) recordings — a small curated set of openly-licensed
   * real recordings (NOT text-to-speech). Use for a prayer-time alert / "play
   * the adhan" button. For a specific local muezzin the user wants, let them
   * upload their own file instead.
   *
   * @example
   * const url = await audio.adhan.default()  // the standard bundled adhan
   * await audio.play(url)
   */
  adhan: {
    /** @returns {Promise<Array<{id, title, reciter, url}>>} available adhan recordings */
    async list() {
      const m = await loadAdhanManifest()
      return (m.adhans || []).map((t) => ({ id: t.id, title: t.title, reciter: t.reciter, url: t.url }))
    },
    /** Public URL for an adhan by id. @returns {Promise<string>} */
    async get(id) {
      const m = await loadAdhanManifest()
      const t = (m.adhans || []).find((x) => x.id === id)
      if (!t) throw new Error(`Adhan not found: ${id}. Try audio.adhan.list() to see options.`)
      return t.url
    },
    /** Public URL for the default adhan. @returns {Promise<string>} */
    async default() {
      const m = await loadAdhanManifest()
      const list = m.adhans || []
      if (!list.length) throw new Error('No adhan recordings available')
      const def = list.find((x) => x.id === m.default) || list[0]
      return def.url
    },
  },

  ambient: {
    /**
     * Get the public URL for an ambient track by id.
     * Available ids: rain-roof, rain-window, ocean-waves, forest-birds, creek,
     *   white-noise, pink-noise, brown-noise,
     *   piano-calm, piano-nocturne, ambient-pad, drone-warm,
     *   singing-bowl, meditation-bell, gong-fade,
     *   lullaby, music-box, fireplace,
     *   heartbeat, breath-guide.
     * @param {string} id
     * @returns {Promise<string>} public mp3 URL
     */
    async get(id) {
      const m = await loadAmbientManifest()
      const t = m.tracks.find((x) => x.id === id)
      if (!t) throw new Error(`Ambient track not found: ${id}. Try audio.ambient.list() to see options.`)
      return t.url
    },

    /**
     * Pick one ambient track at random.
     * @param {string} [category] - Optional category filter
     * @returns {Promise<string>} public mp3 URL
     */
    async random(category) {
      const m = await loadAmbientManifest()
      const pool = category ? m.tracks.filter((x) => x.category === category) : m.tracks
      if (pool.length === 0) throw new Error(`No ambient tracks${category ? ` in category: ${category}` : ''}`)
      return pool[Math.floor(Math.random() * pool.length)].url
    },

    /**
     * List all ambient tracks, optionally filtered by category.
     * @param {string} [category]
     * @returns {Promise<Array<{id:string, category:string, title:string, durationSec:number, url:string}>>}
     */
    async list(category) {
      const m = await loadAmbientManifest()
      const list = category ? m.tracks.filter((x) => x.category === category) : m.tracks
      return list.map((t) => ({
        id: t.id,
        category: t.category,
        title: t.title,
        durationSec: t.durationSec,
        url: t.url,
      }))
    },

    /** @returns {Promise<string[]>} distinct category names present in the library */
    async categories() {
      const m = await loadAmbientManifest()
      return [...new Set(m.tracks.map((t) => t.category))]
    },
  },

  /**
   * Play an audio URL with lock-screen / control-center integration.
   * On iOS PWA (installed to Home Screen), Android PWA, and Desktop, the
   * notification shade or lock-screen shows now-playing metadata and
   * play/pause controls. Bluetooth headset buttons also control playback.
   *
   * Must be called from a user gesture the first time (browser autoplay rules).
   *
   * A LIST of URLs plays in order on one element — a surah's ayahs, a word list, a long text read in
   * pieces. Start it from the tap: iPhones play only an element a tap started, so a new Audio per item
   * goes silent from the second item. The list's player adds index / length / next() / previous() /
   * playAt(i); onItem(i, url) comes as each item starts, onEnd after the last, onError(err, i) for an item
   * that did not load (skipped) or a play the browser refused (the series stops; playAt / resume go on).
   *
   * @param {string|string[]} url - Audio URL to play, or a list of URLs to play in order
   * @param {object} [options]
   * @param {string} [options.title] - Lock-screen title
   * @param {string} [options.artist] - Lock-screen subtitle
   * @param {string} [options.album] - Lock-screen album / collection name
   * @param {string|Array} [options.artwork] - Artwork image URL (or MediaImage[] with sizes)
   * @param {number} [options.volume=1] - 0.0 – 1.0
   * @param {boolean} [options.loop=false] - Loop playback
   * @param {() => void} [options.onEnd] - Called when audio finishes (non-looping)
   * @param {(err: Error) => void} [options.onError] - Called on playback error
   * @param {(index: number, url: string) => void} [options.onItem] - A list: called as each item starts
   * @param {number} [options.startAt=0] - A list: the item to start from
   * @returns {{
   *   element: HTMLAudioElement,
   *   pause: () => void,
   *   resume: () => Promise<void>,
   *   stop: () => void,
   *   seek: (seconds: number) => void,
   *   setVolume: (v: number) => void,
   *   get currentTime(): number,
   *   get duration(): number,
   * }}
   *
   * @example
   * const player = audio.play(storyUrl, {
   *   title: "The Dragon Who Lost His Roar",
   *   artist: "Bedtime Stories",
   *   artwork: storyCoverUrl,
   *   onEnd: () => markChapterComplete(),
   * })
   * // later: player.pause() / player.stop() / player.seek(30)
   *
   * @example
   * // A whole surah from one tap, highlighting the ayah being recited:
   * const { urls } = audio.quran.surah(1)
   * const recitation = audio.play(urls, { onItem: (i) => setAyah(i + 1), onEnd: () => setAyah(null) })
   * // later: recitation.pause() / recitation.next() / recitation.playAt(3) / recitation.stop()
   */
  play(url, options = {}) {
    if (Array.isArray(url)) return playList(url, options)
    const { title, artist, album, artwork, volume = 1, loop = false, onEnd, onError } = options
    console.log('[audio] play:', url?.substring(0, 80), title ? `"${title}"` : '')

    const el = new Audio(url)
    el.preload = 'auto'
    el.volume = Math.max(0, Math.min(1, volume))
    el.loop = loop
    // No crossOrigin: playing needs no CORS, and cdn.islamic.network (audio.quran's URLs) sends no CORS header,
    // so an element that asked for it never loaded a recitation ("no supported source"; delivery ledger T11).
    // iOS Safari in-page playback (avoids fullscreen takeover on iPhone)
    el.setAttribute('playsinline', '')

    const cleanupMediaSession = applyMediaSession(el, { title, artist, album, artwork })
    let disposed = false

    const dispose = () => {
      if (disposed) return
      disposed = true
      cleanupMediaSession()
    }

    if (onEnd) {
      el.addEventListener('ended', () => { onEnd(); if (!loop) dispose() }, { once: !loop })
    } else if (!loop) {
      el.addEventListener('ended', dispose, { once: true })
    }
    if (onError) {
      el.addEventListener('error', () => onError(el.error || new Error('Audio playback error')))
    }

    // Start playback — must be a user-gesture-triggered call
    el.play().catch((err) => {
      console.warn('[audio] play() rejected:', err?.message)
      if (onError) onError(err)
    })

    return {
      element: el,
      pause: () => el.pause(),
      resume: () => el.play(),
      stop: () => { el.pause(); el.currentTime = 0; dispose() },
      seek: (seconds) => { el.currentTime = seconds },
      setVolume: (v) => { el.volume = Math.max(0, Math.min(1, v)) },
      get currentTime() { return el.currentTime },
      get duration() { return el.duration },
    }
  },

  /**
   * Mix a foreground voice track with a looping ambient bed (meditation,
   * bedtime story, guided breathing). Uses plain HTMLAudioElements with
   * voice-over-ambient ducking; the ambient element loops while voice clips
   * play on top and the ambient auto-ducks.
   *
   * Must be started from a user gesture (browser autoplay rules).
   *
   * iOS PWA note: this helper deliberately does NOT wire MediaSession metadata.
   * iOS shows default lock-screen controls for any playing audio element —
   * tapping pause there will truly pause our element and iOS then transfers
   * "Now Playing" focus to another recently-used music app (e.g. NetEase,
   * Apple Music). Our play/pause action handlers cannot prevent this. Users
   * therefore control the mixer from inside the app; if they hit lock-screen
   * pause, the audio stops cleanly and they can restart from the app.
   *
   * @param {object} options
   * @param {string} [options.ambient] - URL of the ambient track (looped)
   * @param {number} [options.ambientVolume=0.3]
   * @param {number} [options.duckVolume=0.1] - Ambient volume while voice plays
   * @param {number} [options.voiceVolume=1.0]
   * @param {boolean} [options.duck=true] - Auto-lower ambient during voice
   * @param {number} [options.fadeInMs=400]
   * @param {number} [options.fadeOutMs=600]
   * @returns {{
   *   start: () => Promise<void>,
   *   playVoice: (url: string) => Promise<void>,
   *   pauseVoice: () => void,
   *   setAmbient: (url: string) => Promise<void>,
   *   setAmbientVolume: (v: number) => void,
   *   setVoiceVolume: (v: number) => void,
   *   stop: () => void,
   *   destroy: () => void,
   *   onVoiceEnd: (cb: () => void) => () => void,
   * }}
   *
   * @example
   * const mixer = audio.mix({
   *   ambient: await audio.ambient.get('rain-roof'),
   *   ambientVolume: 0.4,
   * })
   * await mixer.start()
   * const { url } = await audio.speak("Take a slow breath in...")
   * await mixer.playVoice(url)
   * // ... later: mixer.stop()
   */
  mix(options = {}) {
    const {
      ambient: initialAmbient = null,
      ambientVolume = 0.3,
      duckVolume = 0.1,
      voiceVolume = 1.0,
      duck = true,
      fadeInMs = 400,
      fadeOutMs = 600,
    } = options

    let ambientEl = null
    let voiceEl = null
    let destroyed = false
    const voiceEndListeners = new Set()

    const attachAmbient = (url) => {
      if (!url) return
      if (ambientEl) {
        try { ambientEl.pause() } catch {}
      }
      ambientEl = new Audio(url)
      ambientEl.loop = true
      ambientEl.setAttribute('playsinline', '')
      ambientEl.preload = 'auto'
      ambientEl.volume = 0
    }

    if (initialAmbient) attachAmbient(initialAmbient)

    return {
      async start() {
        if (ambientEl) {
          try { await ambientEl.play() } catch (err) {
            console.warn('[audio.mix] ambient play:', err?.message)
          }
          rampVolume(ambientEl, ambientVolume, fadeInMs)
        }
      },

      async playVoice(url) {
        if (voiceEl) {
          try { voiceEl.pause() } catch {}
          voiceEl = null
        }
        voiceEl = new Audio(url)
        voiceEl.setAttribute('playsinline', '')
        voiceEl.preload = 'auto'
        voiceEl.volume = voiceVolume

        voiceEl.addEventListener('ended', () => {
          if (duck && ambientEl) rampVolume(ambientEl, ambientVolume, fadeOutMs)
          voiceEndListeners.forEach((cb) => { try { cb() } catch {} })
        }, { once: true })

        if (duck && ambientEl) rampVolume(ambientEl, duckVolume, Math.max(100, fadeInMs / 2))
        try { await voiceEl.play() } catch (err) {
          console.warn('[audio.mix] voice play:', err?.message)
        }
      },

      pauseVoice() { if (voiceEl) voiceEl.pause() },

      async setAmbient(url) {
        attachAmbient(url)
        if (ambientEl) {
          try { await ambientEl.play() } catch {}
          rampVolume(ambientEl, ambientVolume, fadeInMs)
        }
      },

      setAmbientVolume(v) {
        const clamped = Math.max(0, Math.min(1, v))
        if (ambientEl) rampVolume(ambientEl, clamped, 150)
      },

      setVoiceVolume(v) {
        const clamped = Math.max(0, Math.min(1, v))
        if (voiceEl) voiceEl.volume = clamped
      },

      stop() {
        if (voiceEl) { try { voiceEl.pause() } catch {} }
        if (ambientEl) {
          rampVolume(ambientEl, 0, fadeOutMs)
          setTimeout(() => { try { ambientEl?.pause() } catch {} }, fadeOutMs + 50)
        }
      },

      destroy() {
        if (destroyed) return
        destroyed = true
        try { voiceEl?.pause() } catch {}
        try { ambientEl?.pause() } catch {}
        voiceEndListeners.clear()
      },

      onVoiceEnd(cb) {
        voiceEndListeners.add(cb)
        return () => voiceEndListeners.delete(cb)
      },
    }
  },

  /**
   * Generate music from a text prompt. Returns a URL to the audio file.
   * Music generation may take 10-60 seconds depending on duration.
   * Priced by the track's length: a longer track costs more credits.
   *
   * @param {string|{plan: object}} prompt - Description of the music, OR { plan }
   *        for structured sections (intro/verse/hook with styles, duration_ms, lyric lines).
   * @param {object} [options]
   * @param {number} [options.duration] - Length in ms, 10–60s (outside is clamped); 30s when left out.
   * @param {boolean} [options.instrumental=false] - Force instrumental (no vocals)
   * @returns {Promise<{ url: string }>}
   *
   * @example
   * const { url } = await audio.music("upbeat jazz lo-fi beats")
   * const { url } = await audio.music("happy birthday song", { duration: 30000 })
   * const { url } = await audio.music("calm piano", { instrumental: true })
   * const { url } = await audio.music({ plan: { positive_global_styles: [...], negative_global_styles: [], sections: [...] } })
   * new Audio(url).play()
   */
  async music(prompt, options = {}) {
    // Structured mode: audio.music({ plan }) — plan replaces the prompt and
    // carries sections (name, styles, duration_ms, lyric lines). Section
    // duration_ms must total ≤ 60000 or the server rejects the request.
    if (prompt && typeof prompt === 'object' && prompt.plan) {
      console.log('[audio] music called: plan, sections=' + (prompt.plan.sections?.length || 0))
      const planRes = await audioRequest('music', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ plan: prompt.plan }),
      }, { fallback: 'Music generation failed' })
      const planData = await audioJson(planRes, 'music', 'Music generation failed')
      console.log('[audio] music result: url=' + planData.url)
      return planData
    }

    const { duration, instrumental } = options
    console.log('[audio] music called: prompt=' + prompt.length + ' chars' +
      (duration ? ', duration=' + duration + 'ms' : '') +
      (instrumental ? ', instrumental' : ''))

    const body = { prompt }
    if (duration) body.duration = duration
    if (instrumental) body.instrumental = true

    const res = await audioRequest('music', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    }, { fallback: 'Music generation failed' })

    const data = await audioJson(res, 'music', 'Music generation failed')
    console.log('[audio] music result: url=' + data.url)
    return data
  },

  /**
   * Transform audio from one voice to another. Preserves emotion, timing and delivery.
   * Priced by the recording's length: a longer recording costs more credits. Up to 5 minutes a recording.
   *
   * @param {Blob} blob - Source audio blob
   * @param {object} [options]
   * @param {string} [options.voice='adam'] - Target voice name or voice_id
   *   Built-in voices: rachel, adam, antoni, bella, domi, elli, josh, arnold, sam
   * @param {boolean} [options.denoise=false] - Remove background noise from input
   * @returns {Promise<{ url: string }>}
   *
   * @example
   * const { url } = await audio.changeVoice(blob, { voice: 'bella' })
   * const { url } = await audio.changeVoice(blob, { voice: 'josh', denoise: true })
   * new Audio(url).play()
   */
  async changeVoice(blob, options = {}) {
    const { voice, denoise } = options
    console.log('[audio] changeVoice called: size=' + blob.size + ', voice=' + (voice || 'default') + ', denoise=' + !!denoise)

    const formData = new FormData()
    formData.append('file', blob, `audio.${extForMime(blob.type)}`)
    if (voice) formData.append('voice', voice)
    if (denoise) formData.append('denoise', 'true')

    const res = await audioRequest('voice', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: formData,
    }, { fallback: 'Voice conversion failed' })

    const data = await res.json()
    console.log('[audio] changeVoice result: url=' + data.url)
    return data
  },

  /**
   * Stream voice-changed audio for immediate playback (lower latency).
   * Priced like changeVoice, by the recording's length. Up to 5 minutes a recording.
   *
   * @param {Blob} blob - Source audio blob
   * @param {object} [options]
   * @param {string} [options.voice='adam'] - Target voice name or voice_id
   * @param {boolean} [options.denoise=false] - Remove background noise from input
   * @returns {Promise<HTMLAudioElement>}
   *
   * @example
   * const player = await audio.changeVoiceStream(blob, { voice: 'bella' })
   * // audio starts playing immediately
   */
  async changeVoiceStream(blob, options = {}) {
    const { voice, denoise } = options
    console.log('[audio] changeVoiceStream called: size=' + blob.size + ', voice=' + (voice || 'default'))

    const formData = new FormData()
    formData.append('file', blob, `audio.${extForMime(blob.type)}`)
    if (voice) formData.append('voice', voice)
    if (denoise) formData.append('denoise', 'true')
    formData.append('stream', 'true')

    const res = await audioRequest('voice', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: formData,
    }, { fallback: 'Voice conversion stream failed' })

    const audioBlob = await res.blob()
    const url = URL.createObjectURL(audioBlob)
    const player = new Audio(url)
    player.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true })

    console.log('[audio] changeVoiceStream playing')
    player.play().catch(() => {})
    return player
  },

  /**
   * Start recording from the microphone.
   * Returns a recorder object with stop(), save(), changeVoice() and cancel() methods.
   *
   * @param {object} [options]
   * @param {string} [options.sessionId] - Session ID for per-minute billing (pass to all chunks in a session)
   * @returns {Promise<{ stop: Function, save: Function, changeVoice: Function, cancel: Function, stream: MediaStream }>}
   *
   * @example
   * const recorder = await audio.record()
   * // ... user presses stop button ...
   * const { text } = await recorder.stop()                    // transcribe only
   * const { text, url } = await recorder.stop({ save: true }) // transcribe + save
   * const { url } = await recorder.save()                     // save only, no transcribe
   * const { url } = await recorder.changeVoice({ voice: 'bella' }) // voice conversion
   * recorder.cancel()                                         // discard recording
   */
  async record(options = {}) {
    const recordSessionId = options.sessionId
    if (!isSupported) {
      throw new Error('Audio recording is not supported in this browser')
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mimeType = pickMimeType()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks = []

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    recorder.start(250) // collect chunks every 250ms
    console.log('[audio] recording started')

    /** Collect all chunks into a single blob and clean up */
    function finalize() {
      return new Promise((resolve) => {
        if (recorder.state === 'inactive') {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
          stream.getTracks().forEach((t) => t.stop())
          resolve(blob)
          return
        }

        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
          stream.getTracks().forEach((t) => t.stop())
          resolve(blob)
        }
        recorder.stop()
      })
    }

    return {
      /** The underlying MediaStream (for visualizations, etc.) */
      stream,

      /**
       * Stop recording and transcribe the audio.
       * @param {object} [options]
       * @param {boolean} [options.save=false] - Also save the audio
       * @returns {Promise<{ text: string, url?: string }>}
       */
      async stop(options = {}) {
        console.log('[audio] recording stopped, transcribing...')
        const blob = await finalize()
        if (blob.size === 0) throw new Error('No audio recorded')
        if (recordSessionId) options.sessionId = recordSessionId
        return audio.transcribe(blob, options)
      },

      /**
       * Stop recording and save the audio without transcription.
       * @returns {Promise<{ url: string }>}
       */
      async save() {
        console.log('[audio] recording stopped, saving...')
        const blob = await finalize()
        if (blob.size === 0) throw new Error('No audio recorded')
        return audio.upload(blob)
      },

      /**
       * Stop recording and convert to a different voice.
       * @param {object} [options]
       * @param {string} [options.voice='adam'] - Target voice name or voice_id
       * @param {boolean} [options.denoise=false] - Remove background noise
       * @returns {Promise<{ url: string }>}
       */
      async changeVoice(options = {}) {
        console.log('[audio] recording stopped, changing voice...')
        const blob = await finalize()
        if (blob.size === 0) throw new Error('No audio recorded')
        return audio.changeVoice(blob, options)
      },

      /**
       * Cancel recording and discard all data.
       */
      cancel() {
        console.log('[audio] recording cancelled')
        if (recorder.state !== 'inactive') recorder.stop()
        stream.getTracks().forEach((t) => t.stop())
        chunks.length = 0
      },
    }
  },

  /**
   * Generate a sound effect from a text description.
   *
   * @param {string} text - Description of the sound effect
   * @param {object} [options]
   * @param {number} [options.duration] - Length in seconds (0.5–30)
   * @param {boolean} [options.loop=false] - Generate a seamless loop
   * @returns {Promise<{ url: string }>}
   *
   * @example
   * const { url } = await audio.soundEffect("sword clash metallic ring")
   * const { url } = await audio.soundEffect("rain on window", { duration: 5 })
   * new Audio(url).play()
   */
  async soundEffect(text, options = {}) {
    const { duration, loop } = options
    console.log('[audio] soundEffect called: text=' + text.length + ' chars' +
      (duration ? ', duration=' + duration + 's' : '') +
      (loop ? ', loop' : ''))

    const body = { text }
    if (duration) body.duration = duration
    if (loop) body.loop = true

    const res = await audioRequest('sound-effect', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    }, { fallback: 'Sound effect generation failed' })

    const data = await res.json()
    console.log('[audio] soundEffect result: url=' + data.url)
    return data
  },

  /**
   * Design a custom voice from a text description. Returns preview samples to audition.
   * Does NOT consume a voice slot — call saveVoice() to keep a voice.
   *
   * @param {string} description - Description of the desired voice
   * @param {object} [options]
   * @param {string} [options.text] - Sample text for the voice to speak (min 100 chars)
   * @returns {Promise<{ previews: Array<{ generatedVoiceId: string, audioUrl: string }>, text: string }>}
   *
   * @example
   * const { previews } = await audio.designVoice("a cheerful anime girl, energetic")
   * new Audio(previews[0].audioUrl).play()
   */
  async designVoice(description, options = {}) {
    const { text } = options
    console.log('[audio] designVoice called: description=' + description.length + ' chars')

    const body = { description }
    if (text) body.text = text

    const res = await audioRequest('voice-design', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    }, { fallback: 'Voice design failed' })

    const data = await audioJson(res, 'voice-design', 'Voice design failed')
    console.log('[audio] designVoice result: ' + (data.previews?.length || 0) + ' previews')
    return data
  },

  /**
   * Save a designed voice preview as a permanent custom voice.
   * The saved voiceId can be used with speak() and changeVoice().
   *
   * @param {string} generatedVoiceId - ID from designVoice() preview
   * @param {object} options
   * @param {string} options.name - Name for the saved voice
   * @param {string} [options.description] - Description of the voice
   * @returns {Promise<{ voiceId: string, name: string, expiresAt: string }>}
   *
   * @example
   * const { previews } = await audio.designVoice("a cheerful anime girl")
   * const { voiceId } = await audio.saveVoice(previews[0].generatedVoiceId, { name: "Cheerful Girl" })
   * const { url } = await audio.speak("Hello!", { voice: voiceId })
   */
  async saveVoice(generatedVoiceId, options = {}) {
    const { name, description } = options
    console.log('[audio] saveVoice called: id=' + generatedVoiceId.substring(0, 12) + ', name=' + name)

    const res = await audioRequest('voice-save', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ generatedVoiceId, name, description }),
    }, { fallback: 'Voice save failed' })

    const data = await res.json()
    console.log('[audio] saveVoice result: voiceId=' + data.voiceId)
    return data
  },

  /**
   * Clone a voice from audio samples. The cloned voiceId can be used with speak() and changeVoice().
   *
   * @param {Blob[]} blobs - Audio sample blobs (1–25 files, max 25MB total)
   * @param {object} options
   * @param {string} options.name - Name for the cloned voice
   * @returns {Promise<{ voiceId: string, name: string, expiresAt: string }>}
   *
   * @example
   * const { voiceId } = await audio.cloneVoice([blob1, blob2], { name: "My Voice" })
   * const { url } = await audio.speak("Hello!", { voice: voiceId })
   */
  async cloneVoice(blobs, options = {}) {
    const { name } = options
    console.log('[audio] cloneVoice called: files=' + blobs.length + ', name=' + name)

    const formData = new FormData()
    formData.append('name', name || 'Cloned Voice')
    for (const blob of blobs) {
      formData.append('files', blob, `sample.${extForMime(blob.type)}`)
    }

    const res = await audioRequest('voice-clone', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: formData,
    }, { fallback: 'Voice cloning failed' })

    const data = await audioJson(res, 'voice-clone', 'Voice cloning failed')
    console.log('[audio] cloneVoice result: voiceId=' + data.voiceId)
    return data
  },

  /**
   * List custom voices for the current project.
   *
   * @returns {Promise<{ voices: Array<{ voiceId: string, name: string, type: string, status: string, expiresAt: string }> }>}
   *
   * @example
   * const { voices } = await audio.listVoices()
   */
  async listVoices() {
    console.log('[audio] listVoices called')

    const res = await audioRequest('voices', {
      method: 'GET',
      headers: getAuthHeaders(),
    }, { fallback: 'Failed to list voices', credits: false })

    const data = await res.json()
    console.log('[audio] listVoices result: ' + (data.voices?.length || 0) + ' voices')
    return data
  },

  /**
   * Delete a custom voice.
   *
   * @param {string} voiceId - The voice ID to delete
   * @returns {Promise<{ ok: boolean }>}
   *
   * @example
   * await audio.deleteVoice(voiceId)
   */
  async deleteVoice(voiceId) {
    console.log('[audio] deleteVoice called: voiceId=' + voiceId.substring(0, 12))

    const res = await audioRequest('voices', {
      method: 'DELETE',
      headers: getHeaders(),
      body: JSON.stringify({ voiceId }),
    }, { fallback: 'Failed to delete voice', credits: false })

    const data = await res.json()
    console.log('[audio] deleteVoice result: ok=' + data.ok)
    return data
  },
}
