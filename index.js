/**
 * game3d helpers — READ-ONLY platform lib for Three.js games.
 *
 *   import { frameShortAxis, lowPoly, sfx, rng, clamp, lerp, disposeTree } from '../lib/game3d'
 *
 * frameShortAxis(camera, opts)  camera framing that survives every viewport:
 *   the SHORT axis of the screen always shows the given world extent, the
 *   long axis gets more. Portrait phone → the lanes stay fully visible;
 *   landscape desktop → the same lanes, more world at the sides.
 *     frameShortAxis(camera, { width, height, worldShort: 9 })  // perspective: fov solved so 9 world units span the short axis at `distance` (default camera.position.length())
 *     for an OrthographicCamera: sets left/right/top/bottom so `worldShort` spans the short axis
 *
 * lowPoly.material(color, opts?)  MeshStandardMaterial with flatShading (the look)
 * lowPoly.box(w,h,d,color) / .cyl(rTop,rBot,h,color,segments?) / .sphere(r,color,detail?) / .cone(r,h,color,segments?)
 *   meshes with flat shading; positions default to origin
 * lowPoly.palette(name?) → { bg, fog, ground, accent, ... } curated palettes ('neon' | 'sunset' | 'forest' | 'candy' | 'mono')
 * lowPoly.lights(scene, { hemi, dir }) → adds a hemisphere + directional light (no shadows by default)
 *
 * sfx.beep({ freq, dur, type, gain, slide })  WebAudio synth blip (jump/coin/hit)
 * sfx.noise({ dur, gain })                     noise burst (explosion/hit)
 * sfx.unlock()                                 kept for old code; the platform unlocks on the first tap or key
 *
 * rng(seed) → () => 0..1 deterministic; clamp/lerp/smoothstep; disposeTree(obj) frees geometries+materials.
 */
import * as THREE from 'three'

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
export function lerp(a, b, t) { return a + (b - a) * t }
export function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t) }

export function rng(seed = 1) {
  let s = (seed >>> 0) || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return (s >>> 0) / 4294967296
  }
}

export function frameShortAxis(camera, { width, height, worldShort, distance, near, far } = {}) {
  const aspect = Math.max(1e-6, width / Math.max(1, height))
  if (camera.isPerspectiveCamera) {
    const d = distance || camera.position.length() || 20
    // vertical fov so the SHORT axis spans worldShort at distance d
    const halfShort = worldShort / 2
    if (aspect >= 1) {
      // landscape: height is the short axis
      camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfShort / d))
    } else {
      // portrait: width is the short axis → vertical extent = short / aspect
      camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan((halfShort / aspect) / d))
    }
    camera.aspect = aspect
  } else if (camera.isOrthographicCamera) {
    const half = worldShort / 2
    if (aspect >= 1) { camera.top = half; camera.bottom = -half; camera.left = -half * aspect; camera.right = half * aspect }
    else { camera.left = -half; camera.right = half; camera.top = half / aspect; camera.bottom = -half / aspect }
  }
  if (near) camera.near = near
  if (far) camera.far = far
  camera.updateProjectionMatrix()
  return camera
}

const PALETTES = {
  neon:   { bg: 0x0b0f1e, fog: 0x0b0f1e, ground: 0x1a2140, accent: 0xff2fb9, accent2: 0x2ff0ff, light: 0xfff2c0, danger: 0xff4b4b, good: 0x7bff8f },
  sunset: { bg: 0x2b1a3a, fog: 0x3d2450, ground: 0x6b3a5a, accent: 0xff8c42, accent2: 0xffd166, light: 0xffe9d6, danger: 0xe63946, good: 0x8ac926 },
  forest: { bg: 0x0f2a1e, fog: 0x14382a, ground: 0x2f6b3a, accent: 0xf4d35e, accent2: 0x8ecae6, light: 0xf1faee, danger: 0xd62828, good: 0xa7c957 },
  candy:  { bg: 0xffe5f1, fog: 0xffe5f1, ground: 0xffc2d1, accent: 0xff4d8d, accent2: 0x4dd0ff, light: 0xffffff, danger: 0xff3b30, good: 0x34c759 },
  mono:   { bg: 0x111111, fog: 0x111111, ground: 0x2a2a2a, accent: 0xffffff, accent2: 0xbdbdbd, light: 0xffffff, danger: 0xff5252, good: 0x69f0ae },
}

export const lowPoly = {
  palette(name = 'neon') { return PALETTES[name] || PALETTES.neon },
  material(color = 0xffffff, opts = {}) {
    return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, metalness: 0.05, ...opts })
  },
  box(w = 1, h = 1, d = 1, color = 0xffffff) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lowPoly.material(color)) },
  cyl(rTop = 0.5, rBot = 0.5, h = 1, color = 0xffffff, segments = 8) { return new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, segments), lowPoly.material(color)) },
  cone(r = 0.5, h = 1, color = 0xffffff, segments = 6) { return new THREE.Mesh(new THREE.ConeGeometry(r, h, segments), lowPoly.material(color)) },
  sphere(r = 0.5, color = 0xffffff, detail = 1) { return new THREE.Mesh(new THREE.IcosahedronGeometry(r, detail), lowPoly.material(color)) },
  lights(scene, { hemi = 0.9, dir = 0.8, sky = 0xffffff, groundColor = 0x444466 } = {}) {
    const h = new THREE.HemisphereLight(sky, groundColor, hemi)
    const d = new THREE.DirectionalLight(0xffffff, dir)
    d.position.set(5, 10, 4)
    scene.add(h, d)
    return { hemi: h, dir: d }
  },
}

// sfx, music, sound — the page's one audio engine (src/lib/sound.js, games item 10), shared with 2D.
export { sfx, music, sound } from '../sound'
// Words that name the controls follow the device in hand (games review 12, step 3): the same answer the input uses.
export { isTouchDevice } from './input'

export function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose()
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) { for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture) v.dispose() } m.dispose() }
    }
  })
}

export { THREE }
