/**
 * game3d input — one input state for every device (READ-ONLY platform lib).
 *
 * The same game must play on a phone (touch), a tablet, and a desktop
 * (keyboard + mouse). Game code never reads raw events; it reads THIS state
 * once per frame and the platform maps devices onto it:
 *
 *   const input = createInput(canvas)
 *   // in update(dt):
 *   input.axis.x / input.axis.y      -1..1 (WASD / arrows / virtual joystick / drag)
 *   input.held('jump')               true while held (Space / on-screen button)
 *   input.pressed('jump')            true on the frame it went down
 *   input.pointer.down / .x / .y     0..1 normalized position on the canvas
 *   input.swipe                      'left'|'right'|'up'|'down'|null (this frame)
 *   input.tapped                     true on the frame a short tap ended
 *   input.isTouch                    coarse pointer (phone/tablet)
 *   input.endFrame()                 call at the END of update(dt) — clears edge flags
 *
 * Actions: 'jump' (Space / ArrowUp / W), 'fire' (Enter / KeyF / KeyJ),
 * 'left' 'right' 'up' 'down' (also drive axis). <TouchControls> maps its
 * joystick to axis and its buttons to actions — same fields, so a game reads
 * nothing device-specific. The play-check drives the same state through
 * the bridge's play-check input(action) (see GameCanvas3D).
 */

const KEY_ACTIONS = {
  Space: 'jump', ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  Enter: 'fire', KeyF: 'fire', KeyJ: 'fire', ShiftLeft: 'dash', ShiftRight: 'dash', KeyK: 'dash',
}
const SWIPE_MIN_PX = 24
const TAP_MAX_MS = 260
const TAP_MAX_PX = 12

export function isTouchDevice() {
  if (typeof window === 'undefined') return false
  try { return window.matchMedia('(pointer: coarse)').matches } catch { return 'ontouchstart' in window }
}

export function createInput(canvas) {
  const held = new Set()
  const pressedNow = new Set()
  const virtual = { x: 0, y: 0 } // joystick / drag axis (TouchControls, drag-to-steer)
  const state = {
    axis: { x: 0, y: 0 },
    pointer: { down: false, x: 0.5, y: 0.5, dx: 0, dy: 0, startX: 0, startY: 0, startT: 0 },
    swipe: null,
    tapped: false,
    isTouch: isTouchDevice(),
    held: (a) => held.has(a),
    pressed: (a) => pressedNow.has(a),
    /** Programmatic press (on-screen buttons, play-check). */
    press(action, down = true) {
      if (down) { if (!held.has(action)) pressedNow.add(action); held.add(action) }
      else held.delete(action)
    },
    /** One-frame press: down now, up on the next endFrame(). */
    tap(action) { state.press(action, true); releaseNext.add(action) },
    /** Joystick / drag axis from TouchControls (−1..1). */
    setVirtualAxis(x, y) { virtual.x = x; virtual.y = y },
    endFrame() {
      pressedNow.clear()
      for (const a of releaseNext) held.delete(a)
      releaseNext.clear()
      state.swipe = null
      state.tapped = false
      state.pointer.dx = 0
      state.pointer.dy = 0
      recomputeAxis()
    },
    destroy() { for (const off of offs) off() },
  }
  const releaseNext = new Set()
  const offs = []

  function recomputeAxis() {
    let x = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0)
    let y = (held.has('up') ? 1 : 0) - (held.has('down') ? 1 : 0)
    if (x === 0 && y === 0) { x = virtual.x; y = virtual.y }
    const len = Math.hypot(x, y)
    if (len > 1) { x /= len; y /= len }
    state.axis.x = x
    state.axis.y = y
  }

  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts)
    offs.push(() => target.removeEventListener(type, fn, opts))
  }

  // A focused text field owns the keyboard (a high-score name entry, a chat
  // box): no game action, no preventDefault — Space and the arrows must type
  // and move the caret. keyup is never skipped so a key held into the field
  // still releases.
  const typing = (e) => {
    const el = e.target
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''))
  }
  on(window, 'keydown', (e) => {
    if (typing(e)) return
    const a = KEY_ACTIONS[e.code]
    if (!a) return
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault()
    if (e.repeat) return
    state.press(a, true)
    recomputeAxis()
  })
  on(window, 'keyup', (e) => {
    const a = KEY_ACTIONS[e.code]
    if (!a) return
    state.press(a, false)
    recomputeAxis()
  })
  on(window, 'blur', () => { held.clear(); virtual.x = 0; virtual.y = 0; recomputeAxis() })

  const rect = () => canvas.getBoundingClientRect()
  const norm = (e) => {
    const r = rect()
    return { x: r.width ? (e.clientX - r.left) / r.width : 0.5, y: r.height ? (e.clientY - r.top) / r.height : 0.5 }
  }
  let lastX = 0, lastY = 0
  on(canvas, 'pointerdown', (e) => {
    if (e.target !== canvas) return
    const p = norm(e)
    Object.assign(state.pointer, { down: true, x: p.x, y: p.y, startX: e.clientX, startY: e.clientY, startT: performance.now() })
    lastX = e.clientX; lastY = e.clientY
    try { canvas.setPointerCapture(e.pointerId) } catch { /* not all browsers */ }
  })
  on(canvas, 'pointermove', (e) => {
    const p = norm(e)
    state.pointer.x = p.x; state.pointer.y = p.y
    if (state.pointer.down) {
      const r = rect()
      state.pointer.dx += r.width ? (e.clientX - lastX) / r.width : 0
      state.pointer.dy += r.height ? (e.clientY - lastY) / r.height : 0
      lastX = e.clientX; lastY = e.clientY
    }
  })
  const end = (e) => {
    if (!state.pointer.down) return
    state.pointer.down = false
    const dx = e.clientX - state.pointer.startX
    const dy = e.clientY - state.pointer.startY
    const dist = Math.hypot(dx, dy)
    const dt = performance.now() - state.pointer.startT
    if (dist >= SWIPE_MIN_PX) {
      state.swipe = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')
    } else if (dt <= TAP_MAX_MS && dist <= TAP_MAX_PX) {
      state.tapped = true
    }
  }
  on(canvas, 'pointerup', end)
  on(canvas, 'pointercancel', end)
  on(canvas, 'contextmenu', (e) => e.preventDefault())

  recomputeAxis()
  return state
}
