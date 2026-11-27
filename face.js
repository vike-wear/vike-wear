/**
 * Face Detection & Landmarks — MediaPipe wrapper.
 * Two modes:
 *   face.detect()    — lightweight, bounding boxes + 6 keypoints
 *   face.landmarks() — full 478 landmarks + expression blendshapes
 *
 * Runs entirely in the browser (WASM) — no server calls needed.
 */

import { isSupported, loadVisionModule, openCamera, WASM_CDN, createDetectionLoop, withTimeout } from './_vision-loader'
import { mapToScreen } from './_detection-math'

// ─────────────────────────────────────────────
// Expression helpers (read blendshapes from face.landmarks() results).
// These need landmarks mode (face.detect() has no blendshapes). Thresholds are
// sensible defaults — tune per app. Returns booleans so apps stop hand-coding them.
// ─────────────────────────────────────────────

function bs(face, name) { return (face && face.blendshapes && face.blendshapes[name]) || 0 }

/** Both mouth corners up. */
function isSmiling(face, t = 0.5) { return (bs(face, 'mouthSmileLeft') + bs(face, 'mouthSmileRight')) / 2 > t }
/** Both eyes closed (use for "blink to act" / drowsiness — pair with a time threshold). */
function isBlinking(face, t = 0.5) { return bs(face, 'eyeBlinkLeft') > t && bs(face, 'eyeBlinkRight') > t }
/** Jaw open (mouth open / yawning / "say ah"). */
function mouthOpen(face, t = 0.4) { return bs(face, 'jawOpen') > t }
/** Approx eye-gaze direction, each axis ~-1..1 (NOT head pose). x>0 looks right, y>0 looks down. */
function gaze(face) {
  const x = (bs(face, 'eyeLookOutRight') + bs(face, 'eyeLookInLeft')) - (bs(face, 'eyeLookOutLeft') + bs(face, 'eyeLookInRight'))
  const y = (bs(face, 'eyeLookDownLeft') + bs(face, 'eyeLookDownRight')) - (bs(face, 'eyeLookUpLeft') + bs(face, 'eyeLookUpRight'))
  return { x: x / 2, y: y / 2 }
}
/** Eyes pointed away from center past `t` (approx — eye gaze, not full head turn). */
function isLookingAway(face, t = 0.5) { const g = gaze(face); return Math.hypot(g.x, g.y) > t }
/** One-call summary of common expressions. */
function expressions(face) {
  return {
    smiling: isSmiling(face), mouthOpen: mouthOpen(face), blinking: isBlinking(face),
    leftEyeClosed: bs(face, 'eyeBlinkLeft') > 0.5, rightEyeClosed: bs(face, 'eyeBlinkRight') > 0.5,
    browRaised: bs(face, 'browInnerUp') > 0.5, gaze: gaze(face), lookingAway: isLookingAway(face),
  }
}

const DETECTOR_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite'
const LANDMARKER_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task'

// ─────────────────────────────────────────────
// Keypoint name mapping (Face Detector output)
// ─────────────────────────────────────────────

const KEYPOINT_NAMES = ['leftEye', 'rightEye', 'nose', 'mouth', 'leftEar', 'rightEar']

function mapDetectorResult(raw) {
  const faces = []
  if (raw.detections) {
    for (const det of raw.detections) {
      const box = det.boundingBox || {}
      const kps = {}
      if (det.keypoints) {
        det.keypoints.forEach((kp, i) => {
          kps[KEYPOINT_NAMES[i] || ('point' + i)] = { x: kp.x, y: kp.y }
        })
      }
      faces.push({
        x: box.originX || 0,
        y: box.originY || 0,
        width: box.width || 0,
        height: box.height || 0,
        confidence: det.categories?.[0]?.score ?? 0,
        keypoints: kps,
      })
    }
  }
  return { faces }
}

// ─────────────────────────────────────────────
// Blendshape simplifier (Face Landmarker output)
// ─────────────────────────────────────────────

function mapLandmarkerResult(raw) {
  const faces = []

  if (raw.faceLandmarks) {
    for (let i = 0; i < raw.faceLandmarks.length; i++) {
      const landmarks = raw.faceLandmarks[i].map((p) => ({ x: p.x, y: p.y, z: p.z }))

      const blendshapes = {}
      const bs = raw.faceBlendshapes?.[i]
      if (bs && bs.categories) {
        for (const cat of bs.categories) {
          blendshapes[cat.categoryName] = Math.round(cat.score * 100) / 100
        }
      }

      faces.push({ landmarks, blendshapes })
    }
  }

  return { faces }
}

// ─────────────────────────────────────────────
// Shared start logic
// ─────────────────────────────────────────────

async function startFace(mode, options) {
  const { camera = 'front', maxFaces = 1, minConfidence = 0.5, onProgress } = options

  if (!isSupported) {
    throw new Error('Face detection is not supported in this browser')
  }

  const label = mode === 'landmarks' ? 'face-landmarks' : 'face-detect'
  console.log('[' + label + '] starting: camera=' + camera)

  // Step 1: Load vision module
  if (onProgress) onProgress('Loading AI library…')
  console.log('[' + label + '] step 1/5: loading vision module...')

  let vision
  try {
    vision = await loadVisionModule()
  } catch (err) {
    throw new Error('[Step 1/5 Load library] ' + err.message)
  }

  // Step 2: Open camera
  if (onProgress) onProgress('Requesting camera access…')
  console.log('[' + label + '] step 2/5: requesting camera...')

  let stream
  try {
    stream = await openCamera(camera)
  } catch (err) {
    throw new Error('[Step 2/5 Camera] ' + err.message)
  }

  // Step 3: Initialize WASM fileset
  if (onProgress) onProgress('Initializing AI engine…')
  console.log('[' + label + '] step 3/5: initializing WASM fileset...')

  let fileset
  try {
    const { FilesetResolver } = vision
    fileset = await withTimeout(60000, FilesetResolver.forVisionTasks(WASM_CDN))
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('[Step 3/5 WASM init] ' + err.message)
  }

  // Step 4: Create detector or landmarker
  if (onProgress) onProgress('Downloading face model…')
  console.log('[' + label + '] step 4/5: creating recognizer...')

  let recognizer
  let detectFn
  let mapFn

  try {
    if (mode === 'landmarks') {
      const { FaceLandmarker } = vision
      recognizer = await withTimeout(60000, FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: LANDMARKER_MODEL },
        runningMode: 'VIDEO',
        numFaces: maxFaces,
        minFaceDetectionConfidence: minConfidence,
        minFacePresenceConfidence: minConfidence,
        minTrackingConfidence: minConfidence,
        outputFaceBlendshapes: true,
      }))
      detectFn = (video, ts) => mapLandmarkerResult(recognizer.detectForVideo(video, ts))
    } else {
      const { FaceDetector } = vision
      recognizer = await withTimeout(60000, FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: DETECTOR_MODEL },
        runningMode: 'VIDEO',
        minDetectionConfidence: minConfidence,
      }))
      detectFn = (video, ts) => mapDetectorResult(recognizer.detectForVideo(video, ts))
    }
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('[Step 4/5 Model download] ' + err.message)
  }

  // Step 5: Start detection loop
  console.log('[' + label + '] step 5/5: starting detection loop...')

  return createDetectionLoop(stream, detectFn, label, () => recognizer.close())
}

// ─────────────────────────────────────────────
// Face helper
// ─────────────────────────────────────────────

export const face = {
  /** Whether the browser supports face detection */
  isSupported,

  // ── Derived-signal helpers (expression helpers need landmarks mode) ──
  /** Both mouth corners up (blendshapes). */
  isSmiling,
  /** Both eyes closed — pair with a timer for drowsiness / blink-to-act. */
  isBlinking,
  /** Jaw open. */
  mouthOpen,
  /** Approx eye-gaze {x,y} ~-1..1 (not head pose). */
  gaze,
  /** Eyes pointed away from center (approx) — useful for attention/proctoring UX. */
  isLookingAway,
  /** One-call expression summary {smiling, mouthOpen, blinking, gaze, lookingAway, ...}. */
  expressions,
  /** Map a normalized landmark/keypoint to a pixel position on the displayed (mirrored, cover) video. */
  toScreen: mapToScreen,

  /**
   * Lightweight face detection — bounding boxes + 6 keypoints.
   * Use this when you just need to know where faces are.
   *
   * @param {object} [options]
   * @param {'front'|'back'} [options.camera='front']
   * @param {number} [options.maxFaces=1]
   * @param {number} [options.minConfidence=0.5]
   * @param {function} [options.onProgress]
   * @returns {Promise<{ video, onResult, stop }>}
   *
   * @example
   * const detector = await face.detect()
   * detector.onResult(({ faces }) => {
   *   // faces = [{ x, y, width, height, confidence, keypoints: { leftEye, rightEye, nose, mouth, leftEar, rightEar } }]
   * })
   */
  detect(options = {}) {
    return startFace('detect', options)
  },

  /**
   * Full face landmarks — 478 points + expression blendshapes.
   * Use this for expression detection, AR filters, or face mesh effects.
   *
   * @param {object} [options]
   * @param {'front'|'back'} [options.camera='front']
   * @param {number} [options.maxFaces=1]
   * @param {number} [options.minConfidence=0.5]
   * @param {function} [options.onProgress]
   * @returns {Promise<{ video, onResult, stop }>}
   *
   * @example
   * const detector = await face.landmarks()
   * detector.onResult(({ faces }) => {
   *   // faces = [{ landmarks: [{x,y,z}, ...], blendshapes: { browDownLeft: 0.8, smile: 0.9, ... } }]
   * })
   */
  landmarks(options = {}) {
    return startFace('landmarks', options)
  },
}
