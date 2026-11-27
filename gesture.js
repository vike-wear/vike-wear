/**
 * Gesture Recognition — MediaPipe GestureRecognizer wrapper.
 * Detects hand gestures in real-time from the device camera.
 * MediaPipe runs entirely in the browser (WASM) — no server calls needed.
 *
 * Built-in gestures: None, Closed_Fist, Open_Palm, Pointing_Up,
 *   Thumb_Down, Thumb_Up, Victory, ILoveYou
 */

import { isSupported, loadVisionModule, openCamera, WASM_CDN, createDetectionLoop, withTimeout } from './_vision-loader'
import { distance, mapToScreen } from './_detection-math'

// ─────────────────────────────────────────────
// Hand-landmark helpers (pinch, finger states) — so apps don't re-derive them
// MediaPipe hand: tips 4/8/12/16/20, pips 6/10/14/18. Coords normalized 0-1.
// ─────────────────────────────────────────────

function handLandmarks(hand) { return (hand && hand.landmarks) || hand }

/**
 * Pinch state from thumb-tip↔index-tip distance (pinch is NOT one of the 7 built-in
 * gestures, so it must be derived). Returns the pinch midpoint for "pinch to place" UIs.
 * @returns {{pinching:boolean, distance:number, point:{x:number,y:number}|null}}
 */
function pinch(hand, opts = {}) {
  const { threshold = 0.06 } = opts
  const lm = handLandmarks(hand)
  if (!lm || !lm[4] || !lm[8]) return { pinching: false, distance: NaN, point: null }
  const d = distance(lm[4], lm[8])
  return { pinching: d < threshold, distance: d, point: { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 } }
}

/**
 * Which fingers are extended (works best for an upright hand). Thumb is approximate
 * (uses handedness + x); pass the hand object so handedness is read automatically.
 * @returns {{thumb:boolean,index:boolean,middle:boolean,ring:boolean,pinky:boolean}}
 */
function fingersUp(hand) {
  const lm = handLandmarks(hand)
  if (!lm) return { thumb: false, index: false, middle: false, ring: false, pinky: false }
  const ext = (tip, pip) => lm[tip] && lm[pip] && lm[tip].y < lm[pip].y // tip above pip
  const thumb = lm[4] && lm[3] ? (hand && hand.handedness === 'Left' ? lm[4].x > lm[3].x : lm[4].x < lm[3].x) : false
  return { thumb, index: ext(8, 6), middle: ext(12, 10), ring: ext(16, 14), pinky: ext(20, 18) }
}

/** Number of extended fingers (0-5). */
function fingerCount(hand) {
  const f = fingersUp(hand)
  return (f.thumb ? 1 : 0) + (f.index ? 1 : 0) + (f.middle ? 1 : 0) + (f.ring ? 1 : 0) + (f.pinky ? 1 : 0)
}

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task'

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Map raw MediaPipe result to a simplified format.
 * @param {object} raw - GestureRecognizerResult from MediaPipe
 */
function mapResult(raw) {
  const gestures = []
  const hands = []

  if (raw.gestures) {
    for (let i = 0; i < raw.gestures.length; i++) {
      const g = raw.gestures[i]
      const h = raw.handedness?.[i]
      const l = raw.landmarks?.[i]

      if (g && g.length > 0) {
        gestures.push({
          name: g[0].categoryName,
          confidence: Math.round(g[0].score * 100) / 100,
          handedness: h?.[0]?.categoryName || 'Unknown',
        })
      }

      if (l) {
        hands.push({
          landmarks: l.map((p) => ({ x: p.x, y: p.y, z: p.z })),
          handedness: h?.[0]?.categoryName || 'Unknown',
        })
      }
    }
  }

  return { gestures, hands }
}

// ─────────────────────────────────────────────
// Gesture helper
// ─────────────────────────────────────────────

export const gesture = {
  /** Whether the browser supports gesture recognition */
  isSupported,

  // ── Derived-signal helpers ──
  /** Pinch state {pinching, distance, point} from thumb↔index (pinch isn't a built-in gesture). */
  pinch,
  /** Which fingers are extended: {thumb,index,middle,ring,pinky}. */
  fingersUp,
  /** Number of extended fingers (0-5). */
  fingerCount,
  /** Map a normalized hand landmark to a pixel position on the displayed (mirrored) video. */
  toScreen: mapToScreen,

  /**
   * Start gesture recognition from the device camera.
   *
   * @param {object} [options]
   * @param {'front'|'back'} [options.camera='front'] - Which camera to use
   * @param {number} [options.maxHands=2] - Max number of hands to detect
   * @param {number} [options.minConfidence=0.5] - Minimum detection confidence (0-1)
   * @param {function} [options.onProgress] - Called with status text as loading progresses
   * @returns {Promise<{ video: HTMLVideoElement, onResult: Function, stop: Function }>}
   */
  async start(options = {}) {
    const { camera = 'front', maxHands = 2, minConfidence = 0.5, onProgress } = options

    if (!isSupported) {
      throw new Error('Gesture recognition is not supported in this browser')
    }

    console.log('[gesture] starting: camera=' + camera + ', maxHands=' + maxHands)

    // Step 1: Load vision JS module
    if (onProgress) onProgress('Loading AI library…')
    console.log('[gesture] step 1/5: loading vision module...')

    let vision
    try {
      vision = await loadVisionModule()
    } catch (err) {
      throw new Error('[Step 1/5 Load library] ' + err.message)
    }

    // Step 2: Open camera
    if (onProgress) onProgress('Requesting camera access…')
    console.log('[gesture] step 2/5: requesting camera...')

    let stream
    try {
      stream = await openCamera(camera)
    } catch (err) {
      throw new Error('[Step 2/5 Camera] ' + err.message)
    }

    // Step 3: Initialize WASM fileset
    if (onProgress) onProgress('Initializing AI engine…')
    console.log('[gesture] step 3/5: initializing WASM fileset...')

    let fileset
    try {
      const { FilesetResolver } = vision
      fileset = await withTimeout(60000, FilesetResolver.forVisionTasks(WASM_CDN))
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      throw new Error('[Step 3/5 WASM init] ' + err.message)
    }

    // Step 4: Create the gesture recognizer (downloads model)
    if (onProgress) onProgress('Downloading gesture model…')
    console.log('[gesture] step 4/5: creating recognizer (downloading model)...')

    let recognizer
    try {
      const { GestureRecognizer } = vision
      recognizer = await withTimeout(60000, GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: 'VIDEO',
        numHands: maxHands,
        minHandDetectionConfidence: minConfidence,
        minHandPresenceConfidence: minConfidence,
        minTrackingConfidence: minConfidence,
      }))
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      throw new Error('[Step 4/5 Model download] ' + err.message)
    }

    // Step 5: Start detection loop
    console.log('[gesture] step 5/5: starting detection loop...')

    return createDetectionLoop(
      stream,
      (video, ts) => mapResult(recognizer.recognizeForVideo(video, ts)),
      'gesture',
      () => recognizer.close(),
    )
  },
}
