/**
 * TouchControls — on-screen joystick + action buttons for touch devices
 * (platform component, read-only). Rendered by <GameCanvas3D touchControls={…}>;
 * shows only on coarse pointers (phones/tablets) unless `force` is set, so a
 * desktop player never sees thumb controls. Feeds the shared game3d input
 * state: joystick → input.axis, buttons → input.held/pressed(action).
 *
 *   touchControls={{ joystick: true, buttons: [{ action: 'jump', label: 'JUMP' }, { action: 'fire', label: 'FIRE' }] }}
 *   touchControls={{ joystick: false, buttons: [{ action: 'jump', label: '▲' }] }}   // one-button games
 *   touchControls={{ joystick: 'horizontal' }}                                        // left/right only (runners, racers)
 */

import { useEffect, useRef, useState } from 'react'
import { isTouchDevice } from '../lib/game3d/input'

const BASE = 116
const RADIUS = 42

export default function TouchControls({ input, joystick = true, buttons = [], force = false, opacity = 0.55 }) {
  const [show, setShow] = useState(false)
  useEffect(() => { setShow(force || isTouchDevice()) }, [force])
  if (!show || !input) return null
  return (
    <>
      {joystick && <Joystick input={input} horizontal={joystick === 'horizontal'} opacity={opacity} />}
      {buttons.length > 0 && (
        <div data-touch-controls="buttons" style={{ position: 'absolute', right: 'calc(18px + var(--sar, 0px))', bottom: 'calc(22px + var(--sab, 0px))', display: 'flex', gap: 14, alignItems: 'flex-end', zIndex: 15, touchAction: 'none' }}>
          {buttons.slice(0, 3).map((b, i) => <ActionButton key={b.action || i} input={input} action={b.action} label={b.label || b.action} size={i === 0 ? 76 : 62} opacity={opacity} />)}
        </div>
      )}
    </>
  )
}

function ActionButton({ input, action, label, size, opacity }) {
  const [down, setDown] = useState(false)
  const press = (v) => { setDown(v); input.press(action, v) }
  return (
    <button
      type="button"
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); press(true) }}
      onPointerUp={(e) => { e.preventDefault(); press(false) }}
      onPointerCancel={() => press(false)}
      onPointerLeave={() => { if (down) press(false) }}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={label}
      style={{
        width: size, height: size, borderRadius: 999, border: '2px solid rgba(255,255,255,.7)',
        background: down ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.18)', color: '#fff',
        font: '600 12px/1 system-ui, sans-serif', letterSpacing: '.08em', textTransform: 'uppercase',
        opacity, touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', pointerEvents: 'auto',
        backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
      }}
    >
      {label}
    </button>
  )
}

function Joystick({ input, horizontal, opacity }) {
  const baseRef = useRef(null)
  const [thumb, setThumb] = useState({ x: 0, y: 0 })
  const active = useRef(null)

  const move = (e) => {
    const base = baseRef.current
    if (!base || active.current !== e.pointerId) return
    const r = base.getBoundingClientRect()
    let dx = e.clientX - (r.left + r.width / 2)
    let dy = horizontal ? 0 : e.clientY - (r.top + r.height / 2)
    const len = Math.hypot(dx, dy)
    if (len > RADIUS) { dx = (dx / len) * RADIUS; dy = (dy / len) * RADIUS }
    setThumb({ x: dx, y: dy })
    // screen y grows downward; game axis y grows upward
    input.setVirtualAxis(dx / RADIUS, -dy / RADIUS)
  }
  const end = (e) => {
    if (active.current !== e.pointerId) return
    active.current = null
    setThumb({ x: 0, y: 0 })
    input.setVirtualAxis(0, 0)
  }
  return (
    <div
      ref={baseRef}
      data-touch-controls="joystick"
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); active.current = e.pointerId; try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ } move(e) }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'absolute', left: 'calc(18px + var(--sal, 0px))', bottom: 'calc(18px + var(--sab, 0px))',
        width: BASE, height: horizontal ? 64 : BASE, borderRadius: 999,
        border: '2px solid rgba(255,255,255,.45)', background: 'rgba(255,255,255,.12)',
        opacity, touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', pointerEvents: 'auto', zIndex: 15,
      }}
    >
      <div style={{
        position: 'absolute', left: '50%', top: '50%', width: 52, height: 52, borderRadius: 999,
        background: 'rgba(255,255,255,.75)', transform: `translate(calc(-50% + ${thumb.x}px), calc(-50% + ${thumb.y}px))`,
        transition: active.current ? 'none' : 'transform .12s ease-out', pointerEvents: 'none',
      }} />
    </div>
  )
}
