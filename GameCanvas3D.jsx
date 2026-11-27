/**
 * GameCanvas3D — React bridge for Three.js games (platform component, read-only).
 *
 *   import GameCanvas3D from '../components/GameCanvas3D'
 *   import { setup } from '../game/Game'
 *   <GameCanvas3D setup={setup} touchControls={{ joystick: true, buttons: [{ action: 'jump', label: 'JUMP' }] }} onFrame={setHud}>
 *     <Hud ... />            // React HUD on top of the canvas (pointer-events: none; give buttons pointer-events-auto)
 *   </GameCanvas3D>
 *
 * setup(ctx) runs once on mount and returns the game object. ctx:
 *   { THREE, renderer, canvas, input, size: { width, height, aspect, dpr }, isTouch, safeArea }
 * The game object:
 *   scene, camera                      rendered every frame
 *   update(dt, t)                      dt in seconds (clamped to 50 ms), t seconds since mount; read ctx.input here
 *   resize?({ width, height, aspect })  called on resize/rotation — re-frame the camera (frameShortAxis)
 *   start?()                           begin a run; call it from your own tap-to-start, the play-check calls it too
 *   state?() → { running, score, gameOver, ... }   what the HUD shows; the play-check reads it
 *   dispose?()                         extra cleanup (the bridge disposes the renderer + scene tree)
 *
 * The bridge owns: WebGLRenderer (antialias, DPR ≤ 2, fills its container), the rAF loop (paused while the tab is
 * hidden), resize/rotation, input.endFrame() after every update, error surfacing, and the play-check contract
 * window.__whackaPlayCheck = { ready, start(), state(), input(action), stats() } (the delivery check's; game code never calls it).
 */

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { createInput } from '../lib/game3d/input'
import { disposeTree, sfx } from '../lib/game3d'
import { sound } from '../lib/sound'
import { isRtlLang, resolveFaceLang } from '../lib/_lang.js'
import TouchControls from './TouchControls'

const DPR_CAP = 2
const MAX_DT = 0.05
const FRAME_CB_HZ = 12

// What a player reads when the device cannot open 3D at all, in place of the renderer's own error.
const NO_3D_WORDS = {
  en: { title: "This game can't run on this device", detail: 'Try another phone or computer.' },
  ar: { title: 'لا يمكن تشغيل هذه اللعبة على هذا الجهاز', detail: 'جرّب هاتفًا أو كمبيوترًا آخر.' },
  pt: { title: 'Este jogo não roda neste dispositivo', detail: 'Tente outro celular ou computador.' },
  es: { title: 'Este juego no funciona en este dispositivo', detail: 'Prueba con otro celular o computadora.' },
}
// The title over any other error (its detail is the error itself, for the owner).
const GAME_ERROR_TITLE = { en: 'The game hit an error', ar: 'حدث خطأ في اللعبة', pt: 'O jogo encontrou um erro', es: 'El juego tuvo un error' }

function readSafeArea() {
  try {
    const cs = getComputedStyle(document.documentElement)
    const px = (v) => parseFloat(cs.getPropertyValue(v)) || 0
    return { top: px('--sat'), bottom: px('--sab'), left: px('--sal'), right: px('--sar') }
  } catch { return { top: 0, bottom: 0, left: 0, right: 0 } }
}

export default function GameCanvas3D({
  setup,
  mode = 'fullscreen',
  touchControls = null,
  onFrame,
  onReady,
  className = '',
  style = {},
  children,
}) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const inputRef = useRef(null)
  const onFrameRef = useRef(onFrame)
  const onReadyRef = useRef(onReady)
  const [error, setError] = useState(null)
  const [no3dLang, setNo3dLang] = useState(null)
  const [inputReady, setInputReady] = useState(false)

  useEffect(() => { onFrameRef.current = onFrame }, [onFrame])
  useEffect(() => { onReadyRef.current = onReady }, [onReady])

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas || typeof setup !== 'function') return
    const releaseSound = sound.claim() // this canvas's music and pending sounds end with it (games item 10)

    let renderer = null
    let game = null
    let raf = 0
    let last = performance.now()
    let t = 0
    let hidden = document.hidden
    let stopped = false
    let frames = 0
    let fps = 0
    let fpsFrames = 0
    let fpsT = performance.now()
    let lastCb = 0
    const input = createInput(canvas)
    inputRef.current = input
    setInputReady(true)

    const fail = (err, where) => {
      if (stopped) return
      stopped = true
      cancelAnimationFrame(raf)
      console.error(`[GameCanvas3D] ${where} error:`, err)
      setError((err && err.message) || `Game ${where} failed`)
      // Re-throw out of band so the platform's error hook sees a real
      // uncaught error (the boot/play-check judges those), not a swallowed one.
      setTimeout(() => { throw err }, 0)
    }

    const size = () => {
      const r = container.getBoundingClientRect()
      const width = Math.max(1, Math.round(r.width || window.innerWidth))
      const height = Math.max(1, Math.round(r.height || window.innerHeight))
      return { width, height, aspect: width / height, dpr: Math.min(window.devicePixelRatio || 1, DPR_CAP) }
    }

    const applySize = () => {
      if (!renderer) return
      const s = size()
      renderer.setPixelRatio(s.dpr)
      renderer.setSize(s.width, s.height, true)
      if (game) {
        if (typeof game.resize === 'function') {
          try { game.resize(s) } catch (err) { fail(err, 'resize') }
        } else if (game.camera) {
          if (game.camera.isPerspectiveCamera) { game.camera.aspect = s.aspect; game.camera.updateProjectionMatrix() }
        }
      }
    }

    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' })
      renderer.outputColorSpace = THREE.SRGBColorSpace
      const s = size()
      renderer.setPixelRatio(s.dpr)
      renderer.setSize(s.width, s.height, true)
      game = setup({ THREE, renderer, canvas, input, size: s, isTouch: input.isTouch, safeArea: readSafeArea() }) || {}
      if (!game.scene || !game.camera) throw new Error('setup() must return { scene, camera, update }')
      applySize()
    } catch (err) {
      // No renderer = the device could not open 3D: its limit, not the game's bug. It is still reported.
      if (!renderer) setNo3dLang(resolveFaceLang())
      fail(err, 'setup')
      return () => { input.destroy(); if (renderer) renderer.dispose(); releaseSound() }
    }

    // Play-check / automation contract. Keep the shape stable: the platform's
    // play-check drives start() + input() and reads state() + stats().
    const api = {
      ready: true,
      start() {
        try { sfx.unlock() } catch { /* no audio */ }
        if (game && typeof game.start === 'function') game.start()
      },
      state() {
        const s = game && typeof game.state === 'function' ? (game.state() || {}) : {}
        return { running: false, score: 0, gameOver: false, ...s, timeSec: t, frames }
      },
      input(action) {
        if (!input) return
        if (action === 'tap') { input.tapped = true; return }
        const m = /^(hold|release):(\w+)$/.exec(action)
        if (m) { input.press(m[2], m[1] === 'hold'); return }
        input.tap(action)
      },
      stats() {
        const info = renderer ? renderer.info.render : { triangles: 0, calls: 0 }
        return { fps, frames, triangles: info.triangles, calls: info.calls, width: canvas.width, height: canvas.height }
      },
    }
    window.__whackaPlayCheck = api

    const loop = (now) => {
      if (stopped) return
      raf = requestAnimationFrame(loop)
      if (hidden) { last = now; return }
      const dt = Math.min(MAX_DT, Math.max(0, (now - last) / 1000))
      last = now
      t += dt
      try {
        game.update(dt, t)
        input.endFrame()
        renderer.render(game.scene, game.camera)
      } catch (err) {
        fail(err, 'update')
        return
      }
      frames++
      fpsFrames++
      if (now - fpsT >= 1000) { fps = Math.round((fpsFrames * 1000) / (now - fpsT)); fpsFrames = 0; fpsT = now }
      if (onFrameRef.current && now - lastCb >= 1000 / FRAME_CB_HZ) {
        lastCb = now
        try { onFrameRef.current(api.state()) } catch (err) { console.error('[GameCanvas3D] onFrame error:', err) }
      }
    }

    const onVis = () => { hidden = document.hidden; last = performance.now() }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => applySize()) : null
    if (ro) ro.observe(container)
    window.addEventListener('resize', applySize)
    window.addEventListener('orientationchange', applySize)
    document.addEventListener('visibilitychange', onVis)

    if (onReadyRef.current) { try { onReadyRef.current(game, api) } catch (err) { console.error('[GameCanvas3D] onReady error:', err) } }
    raf = requestAnimationFrame(loop)

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      if (ro) ro.disconnect()
      window.removeEventListener('resize', applySize)
      window.removeEventListener('orientationchange', applySize)
      document.removeEventListener('visibilitychange', onVis)
      if (window.__whackaPlayCheck === api) delete window.__whackaPlayCheck
      try { if (game && typeof game.dispose === 'function') game.dispose() } catch { /* ignore */ }
      try { if (game && game.scene) disposeTree(game.scene) } catch { /* ignore */ }
      input.destroy()
      inputRef.current = null
      if (renderer) renderer.dispose()
      releaseSound()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const containerStyle = mode === 'fullscreen'
    ? { position: 'fixed', inset: 0, overflow: 'hidden', backgroundColor: '#000', touchAction: 'none', zIndex: 0, ...style }
    : { position: 'relative', width: '100%', height: '100%', overflow: 'hidden', backgroundColor: '#000', touchAction: 'none', ...style }
  const words = no3dLang ? NO_3D_WORDS[no3dLang] : { title: GAME_ERROR_TITLE[resolveFaceLang()] || GAME_ERROR_TITLE.en, detail: error }

  return (
    <div ref={containerRef} className={className} style={containerStyle}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none' }} />
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 10 }}>
        {children}
      </div>
      {inputReady && touchControls && inputRef.current && (
        <TouchControls input={inputRef.current} {...(typeof touchControls === 'object' ? touchControls : {})} />
      )}
      {error && (
        <div dir={isRtlLang(no3dLang) ? 'rtl' : undefined} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', background: no3dLang ? '#000' : 'rgba(0,0,0,.85)', padding: 24, textAlign: 'center', fontFamily: 'system-ui, sans-serif', zIndex: 20 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{words.title}</div>
            <div style={{ fontSize: 12, opacity: .7, marginTop: 8, wordBreak: 'break-word' }}>{words.detail}</div>
          </div>
        </div>
      )}
    </div>
  )
}
