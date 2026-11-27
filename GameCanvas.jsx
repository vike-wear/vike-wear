/**
 * GameCanvas — React bridge for Phaser games.
 * Manages Phaser.Game lifecycle (create on mount, destroy on unmount),
 * handles loading/error states, and bridges events via EventBus.
 *
 * Play-check contract (games track): like GameCanvas3D, the bridge publishes
 * window.__whackaPlayCheck = { ready, start(), state(), input(action), stats(), kind: '2d' }
 * so the platform's delivery check can PLAY a 2D game after done(). It is the
 * check's, not a way into the game: game code never calls it (React and the
 * scenes talk through EventBus or a scene kept from onSceneReady). The game declares its run
 * through the same conventions the game skill teaches — the play scene's
 * startRun() (idempotent: begin/restart a run) and EventBus 'score-update' /
 * 'game-over' — and the bridge derives the rest: state().running turns true
 * once startRun() ran, a score arrived, the scene set changed, or the scene
 * set a registry 'running' flag; state().declared tells the play-check whether
 * the game exposed a run at all (undeclared 2D games are never judged as
 * "not started", only for crashes and a stuck frame loop).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createGame, EventBus } from '../lib/game'
import { installSceneHelpers } from '../lib/game/helpers'
import { sound } from '../lib/sound'

// ── Play-check contract ──────────────────────────────────────────────────────
// The platform's play-check (src/lib/preview/play-check.ts) drives start() +
// input() and reads state() + stats() — the same shape GameCanvas3D publishes.
// Keys are dispatched on window (Phaser's KeyboardManager listens there);
// taps are real mouse events on the canvas (Phaser's MouseManager listens on
// the canvas, and a tap is what most 2D title screens start on).
const KEYS = {
  jump: [{ key: ' ', code: 'Space', keyCode: 32 }, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }],
  fire: [{ key: ' ', code: 'Space', keyCode: 32 }, { key: 'Enter', code: 'Enter', keyCode: 13 }],
  left: [{ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, { key: 'a', code: 'KeyA', keyCode: 65 }],
  right: [{ key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 }, { key: 'd', code: 'KeyD', keyCode: 68 }],
  up: [{ key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, { key: 'w', code: 'KeyW', keyCode: 87 }],
  down: [{ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }, { key: 's', code: 'KeyS', keyCode: 83 }],
  dash: [{ key: 'Shift', code: 'ShiftLeft', keyCode: 16 }],
}
const START_BUTTON_RE = /\b(start|play|go|begin|restart|retry|again|tap)\b|ابدأ|إبدأ|ابدا|بدء|العب|إلعب|العَب|انطلق|جرب|jouer|jugar|começar|iniciar/i

// The bus's listeners at one moment, per event.
function busSnapshot() {
  const snap = new Map()
  for (const name of EventBus.eventNames()) snap.set(name, new Set(EventBus.listeners(name)))
  return snap
}
// A canvas takes away the listeners added while it lived (its scenes', its own) and leaves the
// app's. React StrictMode (the editor preview) mounts a canvas twice; a full wipe there removed
// the 'game-start' / 'score-update' listeners the app registered before its canvas mounted, and
// the start screen never left in the preview.
function removeListenersSince(snap) {
  for (const name of EventBus.eventNames()) {
    const kept = snap.get(name)
    for (const fn of EventBus.listeners(name)) if (!kept || !kept.has(fn)) EventBus.off(name, fn)
  }
}

function installPlayContract(game, container) {
  let frames = 0
  let t = 0
  let started = false
  let score = 0
  let gameOver = false
  let initialScenes = null
  const canvas = () => game.canvas || container.querySelector('canvas')

  const activeScenes = () => { try { return game.scene.getScenes(true) } catch { return [] } }
  const sceneKeys = () => activeScenes().map((s) => s.scene.key).sort().join(',')
  const declared = () => activeScenes().some((s) => typeof s.startRun === 'function' || (s.registry && s.registry.has && s.registry.has('running')))

  const onStep = (_time, delta) => {
    frames++
    t += Math.min(0.05, Math.max(0, (delta || 0) / 1000))
    if (initialScenes === null && frames > 2) initialScenes = sceneKeys()
  }
  game.events.on('step', onStep)
  const onScore = (v) => { const n = typeof v === 'number' ? v : Number(v && v.score) || 0; if (n > score) started = true; score = n; if (n > 0) started = true }
  const onOver = () => { gameOver = true; started = true }
  const onStart = () => { started = true; gameOver = false }
  EventBus.on('score-update', onScore)
  EventBus.on('game-over', onOver)
  EventBus.on('game-start', onStart)

  const fireKey = (spec, type) => {
    const ev = new KeyboardEvent(type, { key: spec.key, code: spec.code, keyCode: spec.keyCode, which: spec.keyCode, bubbles: true, cancelable: true })
    window.dispatchEvent(ev)
    const c = canvas(); if (c) c.dispatchEvent(new KeyboardEvent(type, { key: spec.key, code: spec.code, keyCode: spec.keyCode, which: spec.keyCode, bubbles: true, cancelable: true }))
  }
  const press = (action) => {
    const specs = KEYS[action]; if (!specs) return
    for (const s of specs) fireKey(s, 'keydown')
    setTimeout(() => { for (const s of specs) fireKey(s, 'keyup') }, 90)
  }
  const tapCanvas = (fx = 0.5, fy = 0.5) => {
    const c = canvas(); if (!c) return
    const r = c.getBoundingClientRect()
    const x = r.left + r.width * fx; const y = r.top + r.height * fy
    const init = { clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 1, bubbles: true, cancelable: true, view: window }
    c.dispatchEvent(new MouseEvent('mousedown', init))
    c.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }))
    c.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }))
  }
  const clickStartButton = () => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'))
    const hit = btns.find((b) => b.offsetParent !== null && START_BUTTON_RE.test((b.textContent || '').trim()))
    if (hit) { try { hit.click() } catch { /* ignore */ } return true }
    return false
  }

  const api = {
    ready: false,
    kind: '2d',
    start() {
      try { if (game.sound && typeof game.sound.unlock === 'function') game.sound.unlock() } catch { /* no audio */ }
      let ran = false
      for (const s of activeScenes()) {
        if (typeof s.startRun === 'function') { try { s.startRun(); ran = true; started = true } catch (err) { setTimeout(() => { throw err }, 0) } }
      }
      EventBus.emit('game-start')
      if (!ran) clickStartButton()
      tapCanvas()
      press('jump')
    },
    state() {
      const keys = sceneKeys()
      const sceneChanged = initialScenes !== null && keys !== initialScenes
      const reg = game.registry
      const regRunning = reg && reg.has && reg.has('running') ? !!reg.get('running') : undefined
      const regScore = reg && reg.has && reg.has('score') ? Number(reg.get('score')) || 0 : undefined
      const regOver = reg && reg.has && reg.has('gameOver') ? !!reg.get('gameOver') : undefined
      const running = regRunning !== undefined ? regRunning : (started || sceneChanged) && !gameOver
      return { running, score: regScore !== undefined ? Math.max(regScore, score) : score, gameOver: regOver !== undefined ? regOver : gameOver, timeSec: t, frames, kind: '2d', declared: declared(), scenes: keys }
    },
    input(action) {
      if (action === 'tap') { tapCanvas(); return }
      const m = /^(hold|release):(\w+)$/.exec(action)
      if (m) { const specs = KEYS[m[2]] || []; for (const s of specs) fireKey(s, m[1] === 'hold' ? 'keydown' : 'keyup'); return }
      press(action)
    },
    // Read-only geometry of the pictures on screen, for the delivery check (games review 12, step 3a): for each ordinary
    // one-frame image in an active scene, where its whole picture lands on the page in CSS pixels, how its on-screen
    // proportions compare with the picture's own, and what it does there. Facts only: nothing is changed or judged here.
    displayFacts() {
      const c = canvas()
      if (!c) return null
      const box = c.getBoundingClientRect()
      const cssX = box.width / (c.width || 1), cssY = box.height / (c.height || 1)
      const out = { viewport: { w: window.innerWidth, h: window.innerHeight }, canvas: { left: box.left, top: box.top, w: box.width, h: box.height }, images: [], unsupported: [] }
      const opaque = {}
      const isOpaque = (tex) => {
        const key = tex.key
        if (key in opaque) return opaque[key]
        let v = null
        try {
          const src = tex.getSourceImage()
          const k = document.createElement('canvas'); k.width = 24; k.height = 24
          const x = k.getContext('2d'); x.drawImage(src, 0, 0, 24, 24)
          const d = x.getImageData(0, 0, 24, 24).data
          v = true
          for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { v = false; break }
        } catch { v = null }
        opaque[key] = v
        return v
      }
      for (const s of activeScenes()) {
        const key = s.scene.key
        const cams = (s.cameras && s.cameras.cameras) || []
        const cam = s.cameras && s.cameras.main
        if (!cam) continue
        if (cams.length > 1 || cam.rotation) { out.unsupported.push({ scene: key, why: cams.length > 1 ? 'several cameras' : 'rotated camera' }); continue }
        const zx = cam.zoomX || cam.zoom || 1, zy = cam.zoomY || cam.zoom || 1
        const ox = cam.width * cam.originX, oy = cam.height * cam.originY
        // render order: the display list sorted by depth, as Phaser draws it
        const list = ((s.sys.displayList && s.sys.displayList.list) || []).slice()
        const order = list.map((o, i) => [o, i]).sort((a, b) => (a[0].depth || 0) - (b[0].depth || 0) || a[1] - b[1]).map((p) => p[0])
        const shown = order.filter((o) => o.visible && (o.alpha === undefined || o.alpha > 0.05))
        shown.forEach((o, rank) => {
          if (o.type !== 'Image' && o.type !== 'Sprite') return
          const tex = o.texture
          if (!tex || !o.frame || (tex.frameTotal || 0) > 2) return
          let m
          try { m = o.getWorldTransformMatrix() } catch { return }
          if (Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6) { out.unsupported.push({ scene: key, key: tex.key, why: 'rotated or skewed' }); return }
          const sx = Math.abs(m.a), sy = Math.abs(m.d)
          const w = o.width, h = o.height
          if (!w || !h || !sx || !sy) return
          let top = o
          while (top.parentContainer) top = top.parentContainer
          const sfx = top.scrollFactorX === undefined ? 1 : top.scrollFactorX, sfy = top.scrollFactorY === undefined ? 1 : top.scrollFactorY
          // the whole picture's corners in world space, then through the camera and the canvas's CSS size
          const x0 = m.tx + m.a * (-o.displayOriginX), y0 = m.ty + m.d * (-o.displayOriginY)
          const x1 = x0 + m.a * w, y1 = y0 + m.d * h
          const sxPage = (wx) => box.left + (cam.x + ox + zx * (wx - cam.scrollX * sfx - ox)) * cssX
          const syPage = (wy) => box.top + (cam.y + oy + zy * (wy - cam.scrollY * sfy - oy)) * cssY
          const L = Math.min(sxPage(x0), sxPage(x1)), R = Math.max(sxPage(x0), sxPage(x1))
          const T = Math.min(syPage(y0), syPage(y1)), B = Math.max(syPage(y0), syPage(y1))
          let alpha = o.alpha === undefined ? 1 : o.alpha
          for (let p = o.parentContainer; p; p = p.parentContainer) alpha *= p.alpha === undefined ? 1 : p.alpha
          out.images.push({
            scene: key, key: tex.key, rank, behindAll: rank === 0,
            ratio: (sx * zx * cssX) / (sy * zy * cssY),
            page: { left: L, top: T, right: R, bottom: B },
            interactive: !!(o.input && o.input.enabled), body: !!o.body, blend: o.blendMode || 0, alpha,
            scroll: [sfx, sfy], opaque: isOpaque(tex), source: [o.frame.realWidth || w, o.frame.realHeight || h],
          })
        })
      }
      return out
    },
    stats() {
      const c = canvas()
      let objects = 0
      for (const s of activeScenes()) { try { objects += (s.sys.displayList && s.sys.displayList.length) || 0 } catch { /* ignore */ } }
      const fps = game.loop ? Math.round(game.loop.actualFps || 0) : 0
      return { fps, frames, objects, width: c ? c.width : 0, height: c ? c.height : 0, kind: '2d' }
    },
    destroy() {
      try { game.events.off('step', onStep) } catch { /* ignore */ }
      EventBus.off('score-update', onScore); EventBus.off('game-over', onOver); EventBus.off('game-start', onStart)
      if (window.__whackaPlayCheck === api) delete window.__whackaPlayCheck
    },
  }
  const markReady = () => { api.ready = true }
  if (game.isBooted) markReady(); else game.events.once('ready', markReady)
  EventBus.once('scene-ready', markReady)
  window.__whackaPlayCheck = api
  return api
}

/**
 * @param {object} props
 * @param {object} [props.config={}] - Phaser GameConfig (scene, physics, backgroundColor, etc.)
 * @param {function} [props.onSceneReady] - Called with the active Phaser.Scene when it emits 'scene-ready'
 * @param {string} [props.className] - CSS class for the outer container
 * @param {object} [props.style] - Inline styles for the outer container
 * @param {'inline'|'fullscreen'} [props.mode='inline'] - 'fullscreen' makes the canvas cover the whole viewport (position: fixed). React HUD components should use position: fixed with z-index >= 10 to sit above.
 */
export default function GameCanvas({
  config = {},
  onSceneReady,
  className = '',
  style = {},
  mode = 'inline',
}) {
  const containerRef = useRef(null)
  const gameRef = useRef(null)
  const callbackRef = useRef(onSceneReady)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => { callbackRef.current = onSceneReady }, [onSceneReady])

  useLayoutEffect(() => {
    let cancelled = false
    const el = containerRef.current
    if (!el) return
    const appListeners = busSnapshot()
    const releaseSound = sound.claim() // this canvas's music and pending sounds end with it (games item 10)

    let api = null
    try {
      installSceneHelpers()
      const game = createGame(el, config)
      gameRef.current = game

      const handleSceneReady = (scene) => {
        if (cancelled) return
        setLoading(false)
        if (callbackRef.current) callbackRef.current(scene)
      }

      EventBus.on('scene-ready', handleSceneReady)

      game.events.once('ready', () => {
        if (!cancelled) setLoading(false)
      })

      api = installPlayContract(game, el)
    } catch (err) {
      if (!cancelled) {
        console.error('[GameCanvas] init error:', err)
        setError(err.message || 'Failed to start game')
        setLoading(false)
      }
    }

    return () => {
      cancelled = true
      if (api) api.destroy()
      removeListenersSince(appListeners)
      if (gameRef.current) {
        gameRef.current.destroy(true)
        gameRef.current = null
      }
      releaseSound()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const containerStyle = mode === 'fullscreen'
    ? {
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        backgroundColor: '#000',
        touchAction: 'none',
        zIndex: 0,
        ...style,
      }
    : {
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        backgroundColor: '#000',
        touchAction: 'none',
        ...style,
      }

  return (
    <div ref={containerRef} className={className} style={containerStyle}>
      {loading && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.8)', color: '#fff', zIndex: 10,
        }}>
          <div style={{
            width: 32, height: 32, border: '3px solid rgba(255,255,255,0.3)',
            borderTopColor: '#fff', borderRadius: '50%',
            animation: 'gc-spin 0.8s linear infinite',
          }} />
          <style>{`@keyframes gc-spin { to { transform: rotate(360deg) } }`}</style>
        </div>
      )}
      {error && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.8)', color: '#fff',
          padding: 20, textAlign: 'center', zIndex: 10,
        }}>
          <span style={{ fontSize: 24, marginBottom: 8 }}>&#127918;</span>
          <span style={{ fontSize: 14, opacity: 0.9 }}>{error}</span>
        </div>
      )}
    </div>
  )
}
