/**
 * Shared detection math — pure helpers used by face.js, pose.js, gesture.js.
 *
 * These turn raw MediaPipe output (normalized 0-1 landmarks) into the things apps
 * actually need: angles, rep counts, pinch/finger states, and correct on-screen
 * positions. Keeping them here (instead of re-deriving in every generated app)
 * means rep counting, mirroring, and overlay placement are done once and correctly.
 *
 * Coordinate convention: landmarks are { x, y } normalized 0-1 relative to the
 * camera frame. x grows right, y grows DOWN (image convention). All angle/distance
 * helpers work directly on these.
 */

// ─────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────

/** 2D Euclidean distance between two {x,y} points (normalized units). */
export function distance(a, b) {
  if (!a || !b) return NaN
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Interior angle (degrees, 0-180) at vertex `b` formed by points a-b-c.
 * Example: pose.angle(shoulder, elbow, wrist) → elbow bend angle.
 */
export function angle(a, b, c) {
  if (!a || !b || !c) return NaN
  const abx = a.x - b.x, aby = a.y - b.y
  const cbx = c.x - b.x, cby = c.y - b.y
  const dot = abx * cbx + aby * cby
  const magAB = Math.sqrt(abx * abx + aby * aby)
  const magCB = Math.sqrt(cbx * cbx + cby * cby)
  if (magAB === 0 || magCB === 0) return NaN
  let cos = dot / (magAB * magCB)
  cos = Math.max(-1, Math.min(1, cos))
  return (Math.acos(cos) * 180) / Math.PI
}

// ─────────────────────────────────────────────
// Landmark → screen position
// ─────────────────────────────────────────────

/**
 * Map a normalized {x,y} landmark to a pixel position inside the displayed video
 * element, accounting for object-fit:cover cropping AND mirroring. This is the
 * single hardest thing to get right when placing DOM overlays / stickers on a face
 * or hand — it bakes in the math so apps don't have to.
 *
 * @param {{x:number,y:number}} landmark - normalized 0-1 point
 * @param {HTMLVideoElement} video - the detector.video element (must be in the DOM)
 * @param {object} [opts]
 * @param {boolean} [opts.mirrored=true] - true if the video is CSS-mirrored (scaleX(-1));
 *   pass the SAME value you used for the camera display. Front camera is usually mirrored.
 * @returns {{x:number,y:number}} pixel position relative to the video element's top-left
 *
 * @example
 * const { x, y } = mapToScreen(face.keypoints.nose, detector.video, { mirrored: true })
 * sticker.style.transform = `translate(${x}px, ${y}px)`
 */
export function mapToScreen(landmark, video, opts = {}) {
  const { mirrored = true } = opts
  if (!landmark || !video) return { x: 0, y: 0 }
  const cw = video.clientWidth || video.offsetWidth || 0
  const ch = video.clientHeight || video.offsetHeight || 0
  const vw = video.videoWidth || cw
  const vh = video.videoHeight || ch
  if (!vw || !vh) return { x: landmark.x * cw, y: landmark.y * ch }
  // object-fit: cover → scale to the larger ratio, center the overflow
  const scale = Math.max(cw / vw, ch / vh)
  const dispW = vw * scale, dispH = vh * scale
  const offX = (cw - dispW) / 2, offY = (ch - dispH) / 2
  let x = landmark.x * vw * scale + offX
  const y = landmark.y * vh * scale + offY
  if (mirrored) x = cw - x
  return { x, y }
}

// ─────────────────────────────────────────────
// Rep counter (state machine with hysteresis)
// ─────────────────────────────────────────────

/**
 * Generic repetition counter. A rep = the measured value crosses DOWN past
 * `downBelow`, then back UP past `upAbove`. The two-threshold gap is hysteresis —
 * it prevents jitter near a single threshold from double-counting (the #1 cause of
 * false reps in hand-rolled counters).
 *
 * Works for any exercise: pick a `measure` that returns a number whose extremes mark
 * the two ends of the movement (an elbow angle for push-ups, a hip-shoulder distance
 * for sit-ups, a knee angle for squats).
 *
 * @param {object} cfg
 * @param {(input:any)=>number} cfg.measure - returns the tracked value each frame
 * @param {number} cfg.downBelow - entering the "down" phase when value < this
 * @param {number} cfg.upAbove - completing a rep when value > this (after a down)
 * @param {(count:number)=>void} [cfg.onRep] - called once per completed rep
 * @returns {{ update:(input:any)=>{count:number,phase:string,value:number}, reset:()=>void, get count():number }}
 *
 * @example  // push-ups via elbow angle
 * const counter = pose.repCounter({
 *   measure: (p) => pose.angle(p.landmarks.leftShoulder, p.landmarks.leftElbow, p.landmarks.leftWrist),
 *   downBelow: 90, upAbove: 160,
 *   onRep: (n) => setReps(n),
 * })
 * detector.onResult(({ poses }) => { if (poses[0]) counter.update(poses[0]) })
 */
export function createRepCounter(cfg) {
  const { measure, downBelow, upAbove, onRep } = cfg
  let phase = 'up' // 'up' (ready) | 'down' (mid-rep)
  let count = 0
  return {
    update(input) {
      const value = measure(input)
      if (!Number.isNaN(value)) {
        if (phase === 'up' && value < downBelow) {
          phase = 'down'
        } else if (phase === 'down' && value > upAbove) {
          phase = 'up'
          count += 1
          if (onRep) onRep(count)
        }
      }
      return { count, phase, value }
    },
    reset() { phase = 'up'; count = 0 },
    get count() { return count },
  }
}
