/**
 * Shared MediaPipe Vision loader — used by gesture.js, face.js, pose.js.
 * Handles CDN loading with fallback, camera access, timeout, and support checks.
 * The vision module is loaded once and cached as a singleton.
 */

export const VISION_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs'
export const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'

const LOAD_TIMEOUT_MS = 60000

// ─────────────────────────────────────────────
// Timeout helper
// ─────────────────────────────────────────────

export function withTimeout(ms, promise) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out after ' + (ms / 1000) + 's')), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

// ─────────────────────────────────────────────
// Browser support check
// ─────────────────────────────────────────────

export const isSupported =
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices &&
  typeof navigator.mediaDevices.getUserMedia === 'function' &&
  typeof WebAssembly !== 'undefined'

// ─────────────────────────────────────────────
// Camera helper
// ─────────────────────────────────────────────

/**
 * Open the device camera.
 * @param {'front'|'back'} camera - Which camera to use
 * @returns {Promise<MediaStream>}
 */
export function openCamera(camera = 'front') {
  const facingMode = camera === 'back' ? 'environment' : 'user'
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  })
}

// ─────────────────────────────────────────────
// MediaPipe vision module loader (singleton)
// ─────────────────────────────────────────────

let _visionModule = null
let _loadingPromise = null

/**
 * Load the MediaPipe vision bundle from CDN.
 * Tries dynamic import() first; if that fails (common on mobile Safari),
 * falls back to injecting an inline <script type="module">.
 * Wraps everything in a timeout to prevent infinite loading.
 */
export function loadVisionModule() {
  if (_visionModule) return Promise.resolve(_visionModule)
  if (_loadingPromise) return _loadingPromise

  console.log('[vision] loading MediaPipe vision module from CDN...')

  async function attemptLoad() {
    // Method 1: dynamic import (fastest, works on desktop + modern mobile)
    try {
      console.log('[vision] trying dynamic import...')
      const mod = await import(/* @vite-ignore */ VISION_CDN)
      console.log('[vision] dynamic import succeeded')
      return mod
    } catch (e) {
      console.warn('[vision] dynamic import failed: ' + e.message + ' — trying script tag fallback')
    }

    // Method 2: inline <script type="module"> (better compat on mobile browsers)
    return new Promise((resolve, reject) => {
      const cbId = '__mp_' + Math.random().toString(36).slice(2)

      window[cbId] = (mod) => {
        delete window[cbId]
        console.log('[vision] script tag fallback succeeded')
        resolve(mod)
      }

      const script = document.createElement('script')
      script.type = 'module'
      script.textContent =
        'import*as m from"' + VISION_CDN + '";window["' + cbId + '"](m);'
      script.onerror = () => {
        delete window[cbId]
        reject(new Error('Script tag loading also failed'))
      }
      document.head.appendChild(script)
    })
  }

  _loadingPromise = withTimeout(LOAD_TIMEOUT_MS, attemptLoad())
    .then((mod) => {
      _visionModule = mod
      _loadingPromise = null
      return mod
    })
    .catch((err) => {
      _loadingPromise = null
      throw new Error('Failed to load MediaPipe: ' + err.message)
    })

  return _loadingPromise
}

// ─────────────────────────────────────────────
// Shared detection loop helper
// ─────────────────────────────────────────────

/**
 * Set up a video element from a MediaStream and start a detection loop.
 * Returns a detector object with video, onResult, and stop.
 *
 * @param {MediaStream} stream - Camera stream
 * @param {function} detectFn - Called each frame with (video, timestamp), should return mapped result
 * @param {string} tag - Log tag (e.g. 'gesture', 'face', 'pose')
 * @param {function} cleanup - Called on stop to release the recognizer
 */
export async function createDetectionLoop(stream, detectFn, tag, cleanup) {
  const video = document.createElement('video')
  video.srcObject = stream
  video.setAttribute('playsinline', '')
  video.setAttribute('autoplay', '')
  video.muted = true
  await video.play()

  console.log('[' + tag + '] camera started: ' + video.videoWidth + 'x' + video.videoHeight)

  let callback = null
  let rafId = null
  let lastTime = -1
  let stopped = false

  function loop() {
    if (stopped) return

    if (video.readyState >= 2 && video.currentTime !== lastTime) {
      lastTime = video.currentTime
      try {
        const result = detectFn(video, performance.now())
        if (callback && result) {
          callback(result)
        }
      } catch (err) {
        console.warn('[' + tag + '] detection error:', err.message)
      }
    }

    rafId = requestAnimationFrame(loop)
  }

  rafId = requestAnimationFrame(loop)

  return {
    video,
    onResult(fn) { callback = fn },
    stop() {
      if (stopped) return
      stopped = true
      console.log('[' + tag + '] stopping')
      if (rafId) cancelAnimationFrame(rafId)
      stream.getTracks().forEach((t) => t.stop())
      video.srcObject = null
      if (cleanup) cleanup()
      console.log('[' + tag + '] stopped')
    },
  }
}
