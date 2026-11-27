/**
 * sound — one audio engine for a game page (games item 10, 2026-11). 2D (Phaser's this.sound and the synth), 3D and React
 * screens share one AudioContext, one unlock, one mute and one music channel, so a game never handles browser audio rules.
 *
 *   sfx.beep({ freq, dur, type, gain, slide })      synth blip (jump, coin, hit)
 *   sfx.noise({ dur, gain })                        noise burst (explosion, damage)
 *   sfx.load(key, url)                              fetch + decode a short sound file before it is needed
 *   sfx.play(key, { volume, rate })                 play a loaded file
 *   music.prepare(url)                              fetch + decode a music loop before it is needed
 *   music.play(url, { volume, loop })               one track at a time; the same url again keeps it playing
 *   music.stop()
 *   sound.muted = true | false                      one mute for synth, files, Phaser, music and speech; kept on this device
 *   sound.onMute(fn) -> unsubscribe                 for a sound toggle's icon
 *   sound.claim() -> release                        a game screen's lifetime (the canvas bridges call it)
 *   sound.inspect()                                 state, counts and the last events, for diagnosis
 *   sfx.unlock()                                    kept for old code; the platform unlocks by itself
 *
 * Browsers start audio only inside a real tap or key, and a finger's tap counts when it lifts. The platform listens for those
 * on the window (capture phase, nothing stopped) and resumes the context there; a short sound asked for a moment earlier
 * (the press that started the tap) plays then, one older than FRESH_MS is dropped instead of played late. Music is a short
 * loop decoded to memory (a track too large to decode is refused and reported), so it starts without a media element and
 * needs no gesture of its own once the context runs.
 */

const FRESH_MS = 300
const MUTE_KEY = 'whacka:sound:muted'
const MUSIC_MAX_BYTES = 1_500_000 // ~90 s of 128 kbps; decoded to ~30 MB of PCM, the most a phone game should hold
const SFX_MAX_BYTES = 1_000_000
const FETCH_TIMEOUT_MS = 20_000
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const finite = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d }

let ctx = null
let master = null
let sfxBus = null
let musicBus = null
let muted = false
try { muted = typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1' } catch { /* storage off */ }
let epoch = 0               // a release of a game screen ends everything asked for under the older epoch
let claims = 0
let everRunning = false
let pausedByPage = false
let seq = 0
const pending = []          // short requests made while the context was not running: { id, at, epoch, run }
const active = new Set()    // one-shot sources still sounding
const files = new Map()     // url -> { buffer, promise, error }
const keys = new Map()      // sfx key -> url
const muteListeners = new Set()
const runningWaiters = new Set()
const events = []
const counts = { requested: 0, scheduled: 0, dropped: 0 }
const note = (ev, extra) => { events.push({ t: Math.round(now()), ev, ...extra }); if (events.length > 80) events.shift() }
const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

export function getAudioContext() {
  if (ctx) return ctx
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)
  if (!AC) return null
  try { ctx = new AC() } catch { return null }
  master = ctx.createGain(); master.gain.value = muted ? 0 : 1; master.connect(ctx.destination)
  sfxBus = ctx.createGain(); sfxBus.connect(master)
  musicBus = ctx.createGain(); musicBus.connect(master)
  ctx.addEventListener('statechange', onState)
  note('context', { state: ctx.state })
  if (ctx.state === 'running') everRunning = true
  return ctx
}
/** The node every game sound ends in (the mute sits after it). Phaser's output is routed here. */
export function masterNode() { getAudioContext(); return master }
/** Runs fn once the context runs (now if it already does). For Phaser's locked/unlocked bookkeeping. */
export function onRunning(fn) {
  if (ctx && ctx.state === 'running') { fn(); return () => {} }
  runningWaiters.add(fn)
  return () => runningWaiters.delete(fn)
}

function onState() {
  note('state', { state: ctx.state })
  if (ctx.state === 'running') {
    everRunning = true
    for (const fn of [...runningWaiters]) { runningWaiters.delete(fn); try { fn() } catch { /* ignore */ } }
    const due = pending.splice(0)
    for (const p of due) {
      const why = p.epoch !== epoch ? 'released' : !pageVisible() ? 'hidden' : muted ? 'muted' : now() - p.at > FRESH_MS ? 'expired' : null
      if (why) drop(p.id, why); else run(p)
    }
    reconcileMusic()
    disarmUnlock()
  } else armUnlock()
}

// ---------------------------------------------------------------- unlock on the player's own tap or key
// Activation comes from keydown, a mouse press, and a finger or pen lifting (pointerup / touchend). touchstart is tried too
// (some Safari versions take it); whether audio really started is read from the context's state, never assumed.
const UNLOCK_EVENTS = ['pointerup', 'touchend', 'touchstart', 'mousedown', 'pointerdown', 'keydown', 'click']
let armed = false
function onGesture(e) {
  if (!e.isTrusted || !pageVisible()) return
  if (e.type === 'pointerdown' && e.pointerType !== 'mouse') return
  const c = getAudioContext()
  if (!c || c.state === 'running') return
  note('resume-attempt', { type: e.type, state: c.state })
  try { c.resume().catch((err) => note('resume-refused', { error: err && err.name })) } catch { /* ignore */ }
  try { // one silent frame started inside the gesture completes the unlock on older iOS
    const s = c.createBufferSource(); s.buffer = c.createBuffer(1, 1, 22050); s.connect(c.destination); s.start(0)
  } catch { /* ignore */ }
}
function armUnlock() {
  if (armed || typeof window === 'undefined') return
  armed = true
  for (const t of UNLOCK_EVENTS) window.addEventListener(t, onGesture, { capture: true, passive: true })
}
function disarmUnlock() {
  if (!armed) return
  armed = false
  for (const t of UNLOCK_EVENTS) window.removeEventListener(t, onGesture, { capture: true })
}
armUnlock()

// ---------------------------------------------------------------- the page in the background is silent
const appleTouch = typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))
let kickTimer = null
function pageHidden(reason) {
  clearTimeout(kickTimer)
  stopActive('hidden')
  for (const p of pending.splice(0)) drop(p.id, 'hidden')
  if (ctx && (ctx.state === 'running' || ctx.state === 'interrupted')) { pausedByPage = true; ctx.suspend().catch(() => {}) }
  note('page-hidden', { reason })
}
function pageShown(reason) {
  note('page-shown', { reason })
  if (!ctx || !(pausedByPage || everRunning)) return
  pausedByPage = false
  if (ctx.state !== 'running') ctx.resume().catch(() => {})
  armUnlock() // if the resume is refused outside a gesture, the next tap does it
  // iOS 17/18 can come back running but silent; a short suspend/resume restarts the output (moved here from Phaser).
  if (appleTouch) {
    clearTimeout(kickTimer)
    kickTimer = setTimeout(() => {
      if (!pageVisible() || !ctx || ctx.state !== 'running') return
      ctx.suspend().then(() => ctx.resume()).catch(() => {})
    }, 100)
  }
  reconcileMusic()
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => (document.hidden ? pageHidden('hidden') : pageShown('visible')))
  window.addEventListener('pagehide', () => pageHidden('pagehide'))
  window.addEventListener('pageshow', (e) => { if (e.persisted) pageShown('pageshow') })
}

// ---------------------------------------------------------------- short sounds
function drop(id, reason) { counts.dropped++; note('dropped', { id, reason }) }
function run(p) {
  try { p.run(); counts.scheduled++; note('scheduled', { id: p.id, late: Math.round(now() - p.at) }) } catch (err) { drop(p.id, `failed: ${err && err.message}`) }
}
// Runs now when the context runs and the page is shown, else once it starts within FRESH_MS (dropped after).
function request(kind, start) {
  const id = ++seq
  counts.requested++
  note('request', { id, kind })
  const c = getAudioContext()
  if (!c) return drop(id, 'no-audio')
  if (muted) return drop(id, 'muted')
  if (!pageVisible()) return drop(id, 'hidden')
  const p = { id, at: now(), epoch, run: start }
  if (c.state === 'running') return run(p)
  pending.push(p)
  if (pending.length > 16) drop(pending.shift().id, 'overflow')
  armUnlock()
}
function track(src) {
  active.add(src)
  src.onended = () => { active.delete(src); try { src.disconnect() } catch { /* ignore */ } }
}
function stopActive(reason) {
  if (!active.size) return
  for (const s of active) { try { s.stop() } catch { /* already stopped */ } }
  note('stopped-active', { n: active.size, reason })
  active.clear()
}

// fetch with a deadline and a size cap (a body over the cap is cancelled while it streams)
async function fetchCapped(url, cap) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => ctl && ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(url, ctl ? { signal: ctl.signal } : {})
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const declared = Number(r.headers.get('content-length')) || 0
    if (declared > cap) { ctl && ctl.abort(); throw new Error(`too-large ${declared}`) }
    if (!r.body || !r.body.getReader) return await r.arrayBuffer()
    const reader = r.body.getReader(); const parts = []; let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > cap) { ctl && ctl.abort(); throw new Error(`too-large >${cap}`) }
      parts.push(value)
    }
    const out = new Uint8Array(size); let o = 0
    for (const part of parts) { out.set(part, o); o += part.byteLength }
    return out.buffer
  } finally { clearTimeout(timer) }
}
// Where a file really sounds (games item 11): a generated effect often opens with silence, and an encoded loop carries
// encoder padding at both ends. Effects start at their onset (5 ms kept); loops cycle between their first and last
// non-silent samples, so a loop cut on whole bars stays seamless after MP3 encoding. Measured once per buffer.
const spans = new WeakMap()
function spanOf(buffer) {
  let sp = spans.get(buffer)
  if (sp) return sp
  const n = buffer.length, rate = buffer.sampleRate, chans = []
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c))
  let peak = 0
  for (const d of chans) for (let i = 0; i < n; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v }
  const loud = Math.max(peak * 0.02, 0.0018), quiet = 0.0001
  const hit = (i, thr) => chans.some((d) => d[i] > thr || d[i] < -thr)
  const firstAbove = (thr) => { for (let i = 0; i < n; i++) if (hit(i, thr)) return i; return 0 }
  const lastAbove = (thr) => { for (let i = n - 1; i >= 0; i--) if (hit(i, thr)) return i; return n - 1 }
  const on = Math.max(0, firstAbove(loud) - Math.round(0.005 * rate))
  const ls = firstAbove(quiet), le = lastAbove(quiet) + 1
  sp = { onset: on / rate, loopStart: ls / rate, loopEnd: le > ls + rate * 0.05 ? le / rate : n / rate }
  spans.set(buffer, sp)
  return sp
}
function loadFile(url, cap) {
  const have = files.get(url)
  if (have && !have.error) return have.promise
  const c = getAudioContext()
  if (!c) return Promise.resolve(null)
  const entry = {}
  entry.promise = fetchCapped(url, cap)
    .then((data) => new Promise((ok, no) => c.decodeAudioData(data, ok, no)))
    .then((buffer) => { entry.buffer = buffer; note('loaded', { url: shortUrl(url), seconds: +buffer.duration.toFixed(1) }); return buffer })
    .catch((err) => { entry.error = String((err && err.message) || err || 'decode failed'); note('load-failed', { url: shortUrl(url), error: entry.error }); return null })
  files.set(url, entry) // a failed entry is replaced by the next load or play, so one bad network moment is not permanent
  return entry.promise
}
const shortUrl = (u) => String(u).split('?')[0].split('/').slice(-2).join('/')
const isUrl = (k) => /^(https?:|\/|\.|data:|blob:)/.test(String(k))

export const sfx = {
  unlock() { const c = getAudioContext(); if (c && c.state !== 'running' && pageVisible()) c.resume().catch(() => {}) },
  beep({ freq = 440, dur = 0.08, type = 'square', gain = 0.08, slide = 0 } = {}) {
    const f = finite(freq, 440, 20, 20000), d = finite(dur, 0.08, 0.005, 5), g = finite(gain, 0.08, 0, 1), sl = finite(slide, 0, -20000, 20000)
    const wave = ['sine', 'square', 'sawtooth', 'triangle'].includes(type) ? type : 'square'
    request('beep', () => {
      const o = ctx.createOscillator(); const gn = ctx.createGain(); const t = ctx.currentTime
      o.type = wave; o.frequency.setValueAtTime(f, t)
      if (sl) o.frequency.exponentialRampToValueAtTime(Math.max(20, f + sl), t + d)
      gn.gain.setValueAtTime(g, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + d)
      o.connect(gn).connect(sfxBus); track(o); o.start(t); o.stop(t + d + 0.02)
    })
  },
  noise({ dur = 0.2, gain = 0.1 } = {}) {
    const d = finite(dur, 0.2, 0.005, 5), g = finite(gain, 0.1, 0, 1)
    request('noise', () => {
      const n = Math.max(1, Math.floor(ctx.sampleRate * d)); const buf = ctx.createBuffer(1, n, ctx.sampleRate); const data = buf.getChannelData(0)
      for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n)
      const s = ctx.createBufferSource(); s.buffer = buf; const gn = ctx.createGain(); gn.gain.value = g
      s.connect(gn).connect(sfxBus); track(s); s.start()
    })
  },
  /** Prepares a short sound file under a key (a new url for the same key replaces it). Resolves true when ready. */
  load(key, url) {
    const u = url || key
    if (!u) return Promise.resolve(false)
    keys.set(String(key), u)
    return loadFile(u, SFX_MAX_BYTES).then((b) => !!b)
  },
  play(key, { volume = 1, rate = 1 } = {}) {
    const u = keys.get(String(key)) || (isUrl(key) ? key : null)
    if (!u) { note('unknown-sound', { key: String(key) }); return }
    const v = finite(volume, 1, 0, 2), r = finite(rate, 1, 0.25, 4)
    const asked = now()
    const start = (buffer) => () => {
      const s = ctx.createBufferSource(); s.buffer = buffer; s.playbackRate.value = r
      const gn = ctx.createGain(); gn.gain.value = v
      s.connect(gn).connect(sfxBus); track(s); s.start(0, spanOf(buffer).onset)
    }
    const entry = files.get(u)
    if (entry && entry.buffer) return request('file', start(entry.buffer))
    // Not decoded yet: it plays only if it becomes ready while still fresh; a late file never plays an old tap's sound.
    loadFile(u, SFX_MAX_BYTES).then((buffer) => {
      if (!buffer) return
      if (now() - asked > FRESH_MS) { note('dropped', { reason: 'file-late', key: String(key) }); return }
      request('file', start(buffer))
    })
  },
}

// ---------------------------------------------------------------- music: one short loop, kept as an intent
let want = null // { url, volume, loop, gen, epoch, state: 'loading' | 'ready' | 'playing' | 'ended' | 'failed' | 'too-large', node, gain }
let gen = 0
function stopMusicNodes(m) {
  if (!m || !m.node) return
  const node = m.node; m.node = null
  node.onended = null
  try { node.stop() } catch { /* stopped */ }
  try { m.gain && m.gain.disconnect() } catch { /* ignore */ }
}
function reconcileMusic() {
  const m = want
  if (!m || m.node || m.state === 'ended' || !m.buffer) return
  if (!ctx || ctx.state !== 'running' || !pageVisible() || m.epoch !== epoch) return
  const s = ctx.createBufferSource(); s.buffer = m.buffer; s.loop = m.loop
  const sp = spanOf(m.buffer)
  if (m.loop) { s.loopStart = sp.loopStart; s.loopEnd = sp.loopEnd }
  m.gain = ctx.createGain(); m.gain.gain.value = m.volume
  s.connect(m.gain).connect(musicBus)
  s.onended = () => { if (want === m && m.node === s) { m.node = null; m.state = 'ended'; note('music-ended', { gen: m.gen }) } }
  s.start(0, m.loop ? sp.loopStart : 0)
  m.node = s; m.state = 'playing'
  note('music-start', { gen: m.gen, url: shortUrl(m.url) })
}
function loadMusic(m) {
  m.state = 'loading'
  loadFile(m.url, MUSIC_MAX_BYTES).then((buffer) => {
    if (want !== m) return
    if (!buffer) {
      const err = (files.get(m.url) || {}).error || ''
      m.state = /too-large/.test(err) ? 'too-large' : 'failed'
      if (m.state === 'too-large' && typeof console !== 'undefined') console.warn(`[sound] music.play: ${shortUrl(m.url)} is too large to loop; use a short loop`)
      return
    }
    m.buffer = buffer; m.state = 'ready'
    reconcileMusic()
  })
}
export const music = {
  /** Prepares a music loop. Resolves true when ready, like sfx.load (a game wrote `music.prepare(url).then(…)` and crashed while it returned nothing). */
  prepare(url) { return url ? loadFile(url, MUSIC_MAX_BYTES).then((b) => !!b) : Promise.resolve(false) },
  play(url, { volume = 0.5, loop = true } = {}) {
    if (!url) return
    const v = finite(volume, 0.5, 0, 1.5), lp = loop !== false
    const m = want
    if (m && m.url === url && m.epoch === epoch) {
      m.volume = v; m.loop = lp
      if (m.gain) m.gain.gain.value = v
      if (m.node) m.node.loop = lp
      if (m.state === 'ended') { m.state = 'ready'; reconcileMusic() }
      else if (m.state === 'failed') loadMusic(m)
      return
    }
    stopMusicNodes(m)
    want = { url, volume: v, loop: lp, gen: ++gen, epoch, state: 'loading', node: null, gain: null }
    note('music-want', { gen: want.gen, url: shortUrl(url) })
    getAudioContext()
    loadMusic(want)
    armUnlock()
  },
  stop() { if (want) note('music-stop', { gen: want.gen }); stopMusicNodes(want); want = null },
  get playing() { return !!(want && want.node) },
  get state() { return want ? want.state : 'none' },
}

// ---------------------------------------------------------------- one mute
function setMuted(v) {
  const next = !!v
  if (next === muted) return
  muted = next
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0') } catch { /* storage off */ }
  if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.01)
  if (muted) { stopActive('muted'); for (const p of pending.splice(0)) drop(p.id, 'muted') }
  note('mute', { muted })
  for (const fn of [...muteListeners]) { try { fn(muted) } catch { /* ignore */ } }
}
export const sound = {
  get muted() { return muted },
  set muted(v) { setMuted(v) },
  setMuted,
  toggleMuted() { setMuted(!muted); return muted },
  onMute(fn) { muteListeners.add(fn); return () => muteListeners.delete(fn) },
  /** A game screen's lifetime: the last release stops its music and anything it asked for that has not played. */
  claim() {
    claims++
    let released = false
    return () => {
      if (released) return
      released = true
      claims = Math.max(0, claims - 1)
      if (claims === 0) {
        epoch++
        for (const p of pending.splice(0)) drop(p.id, 'released')
        stopActive('released')
        if (want) music.stop()
        note('released', { epoch })
      }
    }
  },
  inspect() {
    return {
      context: ctx ? ctx.state : 'none', armed, muted, visible: pageVisible(), everRunning, claims, epoch,
      pending: pending.length, active: active.size, counts: { ...counts },
      music: want ? { url: shortUrl(want.url), state: want.state, playing: !!want.node, gen: want.gen } : null,
      files: [...files].map(([u, e]) => ({ url: shortUrl(u), ready: !!e.buffer, error: e.error || null })),
      events: events.slice(-30),
    }
  },
}

// A handle for diagnosis (devtools, the platform's own checks): window.__wkSound.inspect(). Read-only use; never game code.
if (typeof window !== 'undefined') { try { Object.defineProperty(window, '__wkSound', { value: sound, configurable: true }) } catch { /* ignore */ } }
