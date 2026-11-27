// ─────────────────────────────────────────────
// A series of audio files on ONE element (2026-11-09, delivery ledger T11)
// ─────────────────────────────────────────────
// iPhone and iPad browsers play an <audio> element only when a tap started it. An app that makes a new
// Audio for each item of a series (a surah's ayahs, a word list, a long text read in pieces) is silent from
// the second item on: a whole-surah button stopped after the first ayah until its player became one
// element (09-06), and the audio skill's own example made one element per ayah. Here the element the tap
// made plays every item: its src is swapped inside its own `ended` handler, so the next item starts at once.
// A file that does not load is skipped (onError hears which); a play the browser refuses stops the series
// (onError hears it), since every later item would be refused too — the next tap (playAt / resume) goes on.
// audio.js exposes it as audio.play([url, …], options). No import.meta here, so Node can test it
// (audio-series.test.mjs, run by scripts/_test-sdk-client-contract.ts).

export function playSeries(urls, options = {}, makeElement = () => new Audio()) {
  const list = Array.isArray(urls) ? urls.filter((u) => typeof u === 'string' && u) : []
  const { onItem, onEnd, onError, volume = 1, loop = false, startAt = 0 } = options
  const el = makeElement()
  el.preload = 'auto'
  // No CORS request: playing needs none, and a host that sends no CORS header (the Quran CDN audio.quran
  // points to) never loads into an element that asks for one.
  try { el.setAttribute('playsinline', '') } catch { /* not an element */ }
  el.volume = Math.max(0, Math.min(1, Number(volume) || 0))
  let index = -1
  let stopped = false

  const call = (fn, ...args) => {
    if (typeof fn !== 'function') return
    try { fn(...args) } catch (err) { console.warn('[audio] series callback:', err?.message) }
  }
  // Only a refusal stops the series: a file that does not load comes back as the element's `error` event.
  const refused = (err) => {
    if (stopped || !err || err.name !== 'NotAllowedError') return
    stopped = true
    call(onError, err, index)
  }
  const start = (i) => {
    if (i >= list.length) {
      if (loop && list.length) { start(0); return }
      index = list.length
      stopped = true
      call(onEnd)
      return
    }
    stopped = false
    index = Math.max(0, i)
    el.src = list[index]
    call(onItem, index, list[index])
    let p
    try { p = el.play() } catch (err) { refused(err); return }
    if (p && typeof p.catch === 'function') p.catch(refused)
  }

  el.addEventListener('ended', () => { if (!stopped) start(index + 1) })
  // A looping list whose every item fails to load would go round for ever; one full round of failures ends it.
  let failedInRow = 0
  el.addEventListener('playing', () => { failedInRow = 0 })
  el.addEventListener('error', () => {
    if (stopped || index < 0 || index >= list.length) return
    call(onError, el.error || new Error('Audio playback error'), index)
    if (loop && ++failedInRow >= list.length) { index = list.length; stopped = true; call(onEnd); return }
    start(index + 1)
  })

  if (list.length) start(Math.min(Math.max(0, Number(startAt) || 0), list.length - 1))
  else { stopped = true; call(onEnd) }

  return {
    element: el,
    get index() { return index },
    get length() { return list.length },
    pause: () => el.pause(),
    resume: () => {
      if (index < 0 || index >= list.length) { start(0); return Promise.resolve() }
      stopped = false
      const p = el.play()
      if (p && typeof p.catch === 'function') p.catch(refused)
      return p
    },
    stop: () => { stopped = true; el.pause() },
    next: () => { if (index < list.length) start(index + 1) },
    previous: () => start(Math.max(0, index - 1)),
    playAt: (i) => start(Math.max(0, Number(i) || 0)),
    seek: (seconds) => { el.currentTime = seconds },
    setVolume: (v) => { el.volume = Math.max(0, Math.min(1, v)) },
    get currentTime() { return el.currentTime },
    get duration() { return el.duration },
  }
}
