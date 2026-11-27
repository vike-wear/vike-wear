/**
 * Pose Detection — MediaPipe PoseLandmarker wrapper.
 * Detects 33 body landmarks in real-time from the device camera.
 * Returns both named landmarks (e.g. leftShoulder) and raw array.
 *
 * Runs entirely in the browser (WASM) — no server calls needed.
 */

import { isSupported, loadVisionModule, openCamera, WASM_CDN, createDetectionLoop, withTimeout } from './_vision-loader'
import { angle, distance, mapToScreen, createRepCounter } from './_detection-math'

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task'

// ─────────────────────────────────────────────
// Named landmark mapping (MediaPipe Pose 33 points)
// ─────────────────────────────────────────────

const LANDMARK_NAMES = [
  'nose',                                                    // 0
  'leftEyeInner', 'leftEye', 'leftEyeOuter',                // 1-3
  'rightEyeInner', 'rightEye', 'rightEyeOuter',             // 4-6
  'leftEar', 'rightEar',                                     // 7-8
  'mouthLeft', 'mouthRight',                                 // 9-10
  'leftShoulder', 'rightShoulder',                           // 11-12
  'leftElbow', 'rightElbow',                                 // 13-14
  'leftWrist', 'rightWrist',                                 // 15-16
  'leftPinky', 'rightPinky',                                 // 17-18
  'leftIndex', 'rightIndex',                                 // 19-20
  'leftThumb', 'rightThumb',                                 // 21-22
  'leftHip', 'rightHip',                                     // 23-24
  'leftKnee', 'rightKnee',                                   // 25-26
  'leftAnkle', 'rightAnkle',                                 // 27-28
  'leftHeel', 'rightHeel',                                   // 29-30
  'leftFootIndex', 'rightFootIndex',                         // 31-32
]

// Skeleton connections for overlay drawing
const POSE_CONNECTIONS = [
  // Torso
  [11,12], [11,23], [12,24], [23,24],
  // Left arm
  [11,13], [13,15],
  // Right arm
  [12,14], [14,16],
  // Left leg
  [23,25], [25,27], [27,29], [27,31],
  // Right leg
  [24,26], [26,28], [28,30], [28,32],
  // Face
  [0,1], [0,4], [1,2], [2,3], [3,7], [4,5], [5,6], [6,8], [9,10],
]

// ─────────────────────────────────────────────
// Result mapper
// ─────────────────────────────────────────────

function mapResult(raw) {
  const poses = []

  if (raw.landmarks) {
    for (let i = 0; i < raw.landmarks.length; i++) {
      const pts = raw.landmarks[i]

      // Named landmarks object
      const landmarks = {}
      pts.forEach((p, idx) => {
        const name = LANDMARK_NAMES[idx] || ('point' + idx)
        landmarks[name] = {
          x: p.x,
          y: p.y,
          z: p.z,
          visibility: Math.round((p.visibility ?? 0) * 100) / 100,
        }
      })

      // Raw array
      const rawPts = pts.map((p) => ({
        x: p.x,
        y: p.y,
        z: p.z,
        visibility: Math.round((p.visibility ?? 0) * 100) / 100,
      }))

      poses.push({ landmarks, raw: rawPts })
    }
  }

  return { poses }
}

// ─────────────────────────────────────────────
// Pose helper
// ─────────────────────────────────────────────

export const pose = {
  /** Whether the browser supports pose detection */
  isSupported,

  /** Skeleton connections for custom overlay drawing: [[fromIdx, toIdx], ...] */
  connections: POSE_CONNECTIONS,

  /** Landmark name for each index: ['nose', 'leftEyeInner', ...] */
  landmarkNames: LANDMARK_NAMES,

  // ── Derived-signal helpers (so apps don't re-implement pose math) ──

  /** Interior angle (degrees, 0-180) at vertex b for points a-b-c. e.g. pose.angle(shoulder, elbow, wrist). */
  angle,
  /** 2D distance between two landmarks (normalized units). */
  distance,
  /** Map a normalized landmark to a pixel position on the displayed (mirrored, object-fit:cover) video. */
  toScreen: mapToScreen,
  /**
   * Create a rep counter. A rep = value drops below `downBelow` then rises above `upAbove`
   * (hysteresis kills false reps). Call counter.update(pose) each frame.
   * e.g. pose.repCounter({ measure: p => pose.angle(p.landmarks.leftShoulder, p.landmarks.leftElbow, p.landmarks.leftWrist), downBelow: 90, upAbove: 160, onRep: n => setReps(n) })
   */
  repCounter: createRepCounter,

  /**
   * Start pose detection from the device camera.
   *
   * @param {object} [options]
   * @param {'front'|'back'} [options.camera='front'] - Which camera to use
   * @param {number} [options.maxPoses=1] - Max poses to detect
   * @param {number} [options.minConfidence=0.5] - Minimum detection confidence (0-1)
   * @param {function} [options.onProgress] - Called with status text as loading progresses
   * @returns {Promise<{ video: HTMLVideoElement, onResult: Function, stop: Function }>}
   *
   * @example
   * const detector = await pose.start()
   * detector.onResult(({ poses }) => {
   *   const p = poses[0]
   *   console.log(p.landmarks.nose)           // { x, y, z, visibility }
   *   console.log(p.landmarks.leftShoulder)   // { x, y, z, visibility }
   *   console.log(p.raw)                      // [{x,y,z,visibility}, ...] (33 points)
   * })
   */
  async start(options = {}) {
    const { camera = 'front', maxPoses = 1, minConfidence = 0.5, onProgress } = options

    if (!isSupported) {
      throw new Error('Pose detection is not supported in this browser')
    }

    console.log('[pose] starting: camera=' + camera)

    // Step 1: Load vision module
    if (onProgress) onProgress('Loading AI library…')
    console.log('[pose] step 1/5: loading vision module...')

    let vision
    try {
      vision = await loadVisionModule()
    } catch (err) {
      throw new Error('[Step 1/5 Load library] ' + err.message)
    }

    // Step 2: Open camera
    if (onProgress) onProgress('Requesting camera access…')
    console.log('[pose] step 2/5: requesting camera...')

    let stream
    try {
      stream = await openCamera(camera)
    } catch (err) {
      throw new Error('[Step 2/5 Camera] ' + err.message)
    }

    // Step 3: Initialize WASM fileset
    if (onProgress) onProgress('Initializing AI engine…')
    console.log('[pose] step 3/5: initializing WASM fileset...')

    let fileset
    try {
      const { FilesetResolver } = vision
      fileset = await withTimeout(60000, FilesetResolver.forVisionTasks(WASM_CDN))
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      throw new Error('[Step 3/5 WASM init] ' + err.message)
    }

    // Step 4: Create pose landmarker (downloads model)
    if (onProgress) onProgress('Downloading pose model…')
    console.log('[pose] step 4/5: creating landmarker (downloading model)...')

    let landmarker
    try {
      const { PoseLandmarker } = vision
      landmarker = await withTimeout(60000, PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: 'VIDEO',
        numPoses: maxPoses,
        minPoseDetectionConfidence: minConfidence,
        minPosePresenceConfidence: minConfidence,
        minTrackingConfidence: minConfidence,
      }))
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      throw new Error('[Step 4/5 Model download] ' + err.message)
    }

    // Step 5: Start detection loop
    console.log('[pose] step 5/5: starting detection loop...')

    return createDetectionLoop(
      stream,
      (video, ts) => mapResult(landmarker.detectForVideo(video, ts)),
      'pose',
      () => landmarker.close(),
    )
  },
}
