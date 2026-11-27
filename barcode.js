/**
 * Barcode / QR scanner — native BarcodeDetector where available (Android /
 * Chrome, which is where POS and inventory apps overwhelmingly run), with a
 * ZXing WASM fallback loaded from CDN everywhere else (iOS Safari has no
 * BarcodeDetector). Same lifecycle as the other detection libs: start returns
 * a detector with { video, onResult, stop }.
 *
 * onResult fires ONCE per newly seen code (with a re-scan cooldown), not per
 * frame — "scan item → beep → add line" is the dominant flow and per-frame
 * repeats of the same EAN would double-add.
 */

import { openCamera, isSupported as cameraSupported, withTimeout } from './_vision-loader'

const ZXING_CDN = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm'
const ZXING_LOAD_TIMEOUT_MS = 60000
const RESCAN_COOLDOWN_MS = 1500

const DEFAULT_FORMATS = [
  'qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39',
  'upc_a', 'upc_e', 'itf', 'codabar', 'data_matrix',
]

const hasNativeDetector = () =>
  typeof window !== 'undefined' && typeof window.BarcodeDetector === 'function'

// ─────────────────────────────────────────────
// ZXing module loader (singleton, CDN)
// ─────────────────────────────────────────────

let _zxing = null
let _zxingLoading = null

function loadZxing() {
  if (_zxing) return Promise.resolve(_zxing)
  if (_zxingLoading) return _zxingLoading

  console.log('[barcode] no native BarcodeDetector — loading ZXing from CDN...')

  async function attemptLoad() {
    try {
      return await import(/* @vite-ignore */ ZXING_CDN)
    } catch (e) {
      console.warn('[barcode] dynamic import failed: ' + e.message + ' — trying script tag fallback')
    }
    // Inline <script type="module"> fallback (better compat on older mobile Safari)
    return new Promise((resolve, reject) => {
      const cbId = '__zx_' + Math.random().toString(36).slice(2)
      window[cbId] = (mod) => { delete window[cbId]; resolve(mod) }
      const script = document.createElement('script')
      script.type = 'module'
      script.textContent = 'import*as m from"' + ZXING_CDN + '";window["' + cbId + '"](m);'
      script.onerror = () => { delete window[cbId]; reject(new Error('Script tag loading also failed')) }
      document.head.appendChild(script)
    })
  }

  _zxingLoading = withTimeout(ZXING_LOAD_TIMEOUT_MS, attemptLoad())
    .then((mod) => { _zxing = mod; _zxingLoading = null; return mod })
    .catch((err) => { _zxingLoading = null; throw new Error('Failed to load barcode reader: ' + err.message) })

  return _zxingLoading
}

// ─────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────

function makeVideo(stream) {
  const video = document.createElement('video')
  video.srcObject = stream
  video.setAttribute('playsinline', '')
  video.setAttribute('autoplay', '')
  video.muted = true
  return video
}

function makeEmitter() {
  let callback = null
  const lastFired = new Map() // value -> ts
  return {
    onResult(fn) { callback = fn },
    fire(value, format) {
      if (!value) return
      const now = Date.now()
      const last = lastFired.get(value) || 0
      if (now - last < RESCAN_COOLDOWN_MS) return
      lastFired.set(value, now)
      if (callback) callback({ value, format: format || 'unknown' })
    },
  }
}

export const barcode = {
  /** Camera + (native detector or WASM fallback) availability. */
  isSupported: cameraSupported,

  /**
   * Start scanning. Returns a detector: { video, onResult(fn), stop() }.
   * onResult fires once per newly seen code: ({ value, format }).
   *
   * @param {object} [options]
   * @param {'front'|'back'} [options.camera='back'] - barcode scanning wants the back camera
   * @param {string[]} [options.formats] - native-detector format names (best effort on the fallback)
   * @param {function} [options.onProgress] - loading-step callback for UI status text
   */
  async scan({ camera = 'back', formats = DEFAULT_FORMATS, onProgress } = {}) {
    const progress = (t) => { if (onProgress) onProgress(t) }

    if (hasNativeDetector()) {
      progress('Opening camera…')
      const stream = await openCamera(camera)
      const video = makeVideo(stream)
      await video.play()
      console.log('[barcode] native BarcodeDetector, camera ' + video.videoWidth + 'x' + video.videoHeight)

      let detector
      try {
        detector = new window.BarcodeDetector({ formats })
      } catch {
        detector = new window.BarcodeDetector()
      }

      const emitter = makeEmitter()
      let stopped = false
      let busy = false
      let rafId = null

      // BarcodeDetector.detect is async — own loop with an in-flight guard
      // (the shared createDetectionLoop expects a synchronous detectFn).
      function tick() {
        if (stopped) return
        if (!busy && video.readyState >= 2) {
          busy = true
          detector.detect(video)
            .then((results) => {
              for (const r of results) emitter.fire(r.rawValue, r.format)
            })
            .catch(() => {})
            .finally(() => { busy = false })
        }
        rafId = requestAnimationFrame(tick)
      }
      rafId = requestAnimationFrame(tick)

      return {
        video,
        onResult: emitter.onResult,
        stop() {
          if (stopped) return
          stopped = true
          if (rafId) cancelAnimationFrame(rafId)
          stream.getTracks().forEach((t) => t.stop())
          video.srcObject = null
          console.log('[barcode] stopped')
        },
      }
    }

    // Fallback: ZXing drives its own decode loop via decodeFromStream.
    progress('Loading barcode reader…')
    const zxing = await loadZxing()
    progress('Opening camera…')
    const stream = await openCamera(camera)
    const video = makeVideo(stream)

    const reader = new zxing.BrowserMultiFormatReader()
    const emitter = makeEmitter()
    let stopped = false

    const controls = await reader.decodeFromStream(stream, video, (result) => {
      if (stopped || !result) return
      let format = 'unknown'
      try { format = String(result.getBarcodeFormat()) } catch { /* best effort */ }
      emitter.fire(result.getText(), format)
    })
    console.log('[barcode] ZXing fallback, camera ' + video.videoWidth + 'x' + video.videoHeight)

    return {
      video,
      onResult: emitter.onResult,
      stop() {
        if (stopped) return
        stopped = true
        try { controls.stop() } catch { /* already stopped */ }
        stream.getTracks().forEach((t) => t.stop())
        video.srcObject = null
        console.log('[barcode] stopped')
      },
    }
  },
}
