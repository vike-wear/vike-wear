/**
 * Scene helpers — ergonomic wrappers around common Phaser patterns.
 *
 * installSceneHelpers() patches Phaser.Scene.prototype so scene code can call
 * this.switchScene(), this.floatingText(), etc. GameCanvas calls this on mount.
 *
 * Also exports getSafeArea() for scenes that need to respect notch/Home Indicator insets, and isTouchDevice()
 * (the same answer the 3D runtime gives) for words that name the controls of the device in hand.
 */

import Phaser from 'phaser'
import { sound } from '../sound'
import { installOriginHitAreas } from './hit-area'
import { installPageInput } from './page-input'
import { installPressRules } from './press-rules'
export { isTouchDevice } from '../game3d/input'

let installed = false

// Browser speech voices load asynchronously. Warm a module-level cache once and
// keep it fresh via voiceschanged — so this.speak() never has to hand-roll the
// onvoiceschanged + timeout dance that causes double-speak.
let _voices = []
function warmVoices() {
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  const load = () => { try { _voices = window.speechSynthesis.getVoices() || [] } catch { _voices = [] } }
  load()
  try { window.speechSynthesis.onvoiceschanged = load } catch { /* not supported */ }
}
function pickVoice(want) {
  if (!want || !_voices.length) return null
  const w = String(want).toLowerCase()
  return _voices.find((v) => v.name.toLowerCase().includes(w) || (v.lang || '').toLowerCase().includes(w)) || null
}

export function installSceneHelpers() {
  if (installed) return
  installed = true

  warmVoices()
  // Muting mid-sentence stops the speech (its utterance ends, so the game's onEnd still arrives).
  sound.onMute((m) => { if (m && typeof window !== 'undefined' && window.speechSynthesis) { try { window.speechSynthesis.cancel() } catch { /* ignore */ } } })

  const proto = Phaser.Scene.prototype

  /**
   * Start another scene by key: at once by default; with a duration, fade the camera to black first.
   * Usage: this.switchScene('gameOver') starts it now; this.switchScene('play', 300) fades for 300 ms, then starts it.
   * No fade unless asked (games item 9, 2026-11-07: the old 400 ms default put a black dip in front of every start).
   * One switch at a time (games item 9, 2026-11): while one is under way, another request is ignored — the first
   * wins — so a tap and a key arriving together start the next scene once. Leaving the scene clears it, and a fade
   * that finishes after the scene was left starts nothing.
   */
  proto.switchScene = function (sceneName, fadeMs) {
    if (fadeMs === undefined) fadeMs = 0
    // A request that cannot work leaves nothing pending: an unknown scene or a duration that is not a number.
    if (!this.scene.manager.getScene(sceneName)) { console.warn(`[switchScene] no scene "${sceneName}"`); return }
    if (typeof fadeMs !== 'number' || !Number.isFinite(fadeMs)) { console.warn(`[switchScene] bad duration ${fadeMs}`); return }
    // The first request of this visit wins: claimed before either branch, held until the scene is left.
    if (this._wkSwitching) return
    const scene = this
    const cam = this.cameras.main
    const token = {}
    this._wkSwitching = token
    const FADED = Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE
    const onFaded = function () {
      if (scene._wkSwitching !== token) return
      scene.scene.start(sceneName)
    }
    const clear = function () {
      if (scene._wkSwitching === token) scene._wkSwitching = null
      cam.off(FADED, onFaded)
      scene.events.off(Phaser.Scenes.Events.SHUTDOWN, clear)
      scene.events.off(Phaser.Scenes.Events.DESTROY, clear)
    }
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, clear)
    this.events.once(Phaser.Scenes.Events.DESTROY, clear)
    if (fadeMs <= 0) {
      this.scene.start(sceneName)
      return
    }
    // Phaser's fadeOut takes over a fade already running on this camera, so the completion heard is this one.
    cam.once(FADED, onFaded)
    cam.fadeOut(fadeMs, 0, 0, 0)
  }

  /**
   * Build a tile grid from a 2D number array.
   * tiles maps IDs to { key, collides }. 0 = empty (skipped).
   * Returns { walls, floors } — both Phaser.Physics.Arcade.StaticGroup.
   */
  proto.createTilemap = function (cfg) {
    const tileSize = cfg.tileSize
    const data = cfg.data
    const tiles = cfg.tiles
    const walls = this.physics.add.staticGroup()
    const floors = this.physics.add.staticGroup()
    const half = tileSize / 2

    for (let row = 0; row < data.length; row++) {
      for (let col = 0; col < data[row].length; col++) {
        const id = data[row][col]
        if (id === 0) continue
        const tileCfg = tiles[id]
        if (!tileCfg) continue
        const x = col * tileSize + half
        const y = row * tileSize + half
        const group = tileCfg.collides ? walls : floors
        group.create(x, y, tileCfg.key).setDisplaySize(tileSize, tileSize).refreshBody()
      }
    }

    return { walls, floors }
  }

  /**
   * Create an arcade physics sprite with common setup.
   * cfg: { x, y, sprite (texture key), displaySize?: [w,h], bodySize?: [w,h], collideWorldBounds?: boolean }
   */
  proto.spawn = function (cfg) {
    const s = this.physics.add.sprite(cfg.x, cfg.y, cfg.sprite)
    if (cfg.displaySize) s.setDisplaySize(cfg.displaySize[0], cfg.displaySize[1])
    if (cfg.collideWorldBounds !== false) s.setCollideWorldBounds(true)
    if (cfg.bodySize) s.body.setSize(cfg.bodySize[0], cfg.bodySize[1])
    return s
  }

  /**
   * Centered announcement text. Auto-hides after duration ms. Replaces any active message.
   * Usage: this.showMessage('Level Up!', 1500)
   */
  proto.showMessage = function (text, duration) {
    if (duration === undefined) duration = 2000
    if (this._msgText) { this._msgText.destroy(); this._msgText = null }
    if (this._msgTimer) { this._msgTimer.remove(false); this._msgTimer = null }

    this._msgText = this.add.text(
      this.cameras.main.centerX,
      this.cameras.main.centerY,
      text,
      {
        fontSize: '28px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 4,
        align: 'center',
        // A long message wraps inside the screen instead of running off a phone (games review 12).
        wordWrap: { width: Math.max(120, this.cameras.main.width * 0.9), useAdvancedWrap: true },
      },
    ).setOrigin(0.5).setScrollFactor(0).setDepth(9999)

    const self = this
    this._msgTimer = this.time.delayedCall(duration, function () {
      if (self._msgText) { self._msgText.destroy(); self._msgText = null }
    })
  }

  /**
   * Floating text that drifts up and fades out. Use for +10 / -5 / pickup feedback.
   * Usage: this.floatingText(x, y, '+10', '#FFD700')
   */
  proto.floatingText = function (x, y, text, color) {
    if (color === undefined) color = '#ffffff'
    const t = this.add.text(x, y, text, {
      fontSize: '18px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      color,
      stroke: '#000000',
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(9998)

    this.tweens.add({
      targets: t,
      y: y - 40,
      alpha: 0,
      duration: 800,
      ease: 'Power2',
      onComplete: function () { t.destroy() },
    })
  }

  /**
   * One-shot particle burst at (x, y). Uses an auto-generated white dot texture.
   * opts: { count?, speed?, lifespan?, scale?, tint?, gravityY? }
   * Usage: this.particleBurst(pointer.x, pointer.y)
   */
  proto.particleBurst = function (x, y, opts) {
    opts = opts || {}
    const key = 'particle'
    if (!this.textures.exists(key)) {
      const g = this.make.graphics({ add: false })
      g.fillStyle(0xffffff, 1)
      g.fillCircle(4, 4, 4)
      g.generateTexture(key, 8, 8)
      g.destroy()
    }

    const burst = this.add.particles(0, 0, key, {
      speed: opts.speed || { min: 120, max: 320 },
      angle: { min: 0, max: 360 },
      scale: opts.scale || { start: 1.2, end: 0 },
      lifespan: opts.lifespan || 700,
      gravityY: opts.gravityY || 200,
      tint: opts.tint || [0xff0000, 0xff9500, 0xffd700, 0x00d26a, 0x3b82f6],
      emitting: false,
    })
    burst.explode(opts.count || 16, x, y)
    this.time.delayedCall((opts.lifespan || 700) + 100, () => burst.destroy())
  }

  /**
   * Speak text aloud with the browser's free, instant text-to-speech — for games
   * that voice many phrases in real time (language learning, read-alouds, callouts).
   * (For a one-off, high-quality, fixed line, prefer the platform audio.speak() URL.)
   *
   * Lifecycle-safe by construction — handles the three things that crash hand-rolled
   * speechSynthesis in a scene:
   *   - overlap: cancels any in-flight phrase before speaking, so they never double up;
   *   - stale callbacks: onEnd fires only for the latest phrase (a newer speak supersedes it);
   *   - teardown: on scene shutdown/destroy it cancels speech and never fires onEnd into a dead scene.
   * If the browser has no speech support, onEnd is still called so game flow never stalls.
   *
   * Usage: this.speak('the cat sat on the mat', { onEnd: () => this.startRound(), rate: 0.9 })
   * opts: { onEnd?, voice? (name/lang substring), lang?, rate?, pitch?, volume? }
   */
  proto.speak = function (text, opts) {
    opts = opts || {}
    const synth = (typeof window !== 'undefined') ? window.speechSynthesis : null
    if (!text || !synth) { if (typeof opts.onEnd === 'function') opts.onEnd(); return null }
    // The one mute covers speech: nothing is said, and onEnd still comes (next tick, on this scene's clock, never a dead scene).
    if (sound.muted) { if (typeof opts.onEnd === 'function') this.time.delayedCall(1, () => opts.onEnd()); return null }

    // Once per scene: cancel speech and block late callbacks when the scene ends.
    // Arrow closures capture this scene lexically (no this-aliasing needed).
    if (!this._speakBound) {
      this._speakBound = true
      this._speakAlive = true
      // Phaser reuses the scene object: the next visit binds again (else its onEnd callbacks would stay blocked for good).
      const stop = () => { this._speakAlive = false; this._speakBound = false; this._speakCurrent = null; try { synth.cancel() } catch { /* ignore */ } }
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, stop)
      this.events.once(Phaser.Scenes.Events.DESTROY, stop)
    }

    try { synth.cancel() } catch { /* ignore */ }   // stop any in-flight phrase so they don't overlap
    const u = new SpeechSynthesisUtterance(String(text))
    const v = pickVoice(opts.voice)
    if (v) u.voice = v
    if (opts.lang) u.lang = opts.lang
    if (opts.rate != null) u.rate = opts.rate
    if (opts.pitch != null) u.pitch = opts.pitch
    if (opts.volume != null) u.volume = opts.volume

    this._speakCurrent = u
    let done = false
    const finish = () => {
      if (done) return
      done = true
      if (this._speakAlive && this._speakCurrent === u && typeof opts.onEnd === 'function') opts.onEnd()
    }
    u.onend = finish
    u.onerror = finish
    try { synth.speak(u) } catch { finish() }
    return u
  }

  /** Stop any in-flight speech immediately (e.g. on pause). */
  proto.stopSpeaking = function () {
    this._speakCurrent = null
    if (typeof window !== 'undefined' && window.speechSynthesis) { try { window.speechSynthesis.cancel() } catch { /* ignore */ } }
  }

  // ── Art by what is drawn (games item 6, 2026-11) ──
  // BootScene records what each sprite's frames visibly show (registry '__wkArt'). A subject's sprites are drawn on
  // one canvas at one scale, so its still's drawn box is the yardstick for all of them: a size or a place set from
  // it holds while the subject plays any of its actions.

  /** The drawn box (declared pixels, from the frame's top-left) a sprite is sized and placed by: its subject's still,
   *  else its own still, else the union of its frames. Null when unknown. */
  proto.artBox = function (target) {
    const key = typeof target === 'string' ? target : target && target.texture && target.texture.key
    const art = this.registry.get('__wkArt') || {}
    const own = art[key]
    if (!own) return null
    let ref = own
    if (own.subject) {
      const still = Object.values(art).find((a) => a.subject === own.subject && a.frames === 1 && a.boxes && a.boxes[0])
      if (still) ref = still
    }
    const boxes = (ref.boxes || []).filter(Boolean)
    if (!boxes.length) return null
    const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y))
    const r = Math.max(...boxes.map((b) => b.x + b.w)), btm = Math.max(...boxes.map((b) => b.y + b.h))
    return { x, y, w: r - x, h: btm - y, size: ref.size }
  }

  /**
   * Size a sprite by what is drawn: fitArt(sprite, { height: 72 }) makes the drawn subject 72 px tall (or { width },
   * or both: it fits inside). Every action of the subject keeps that size. Returns the sprite.
   */
  proto.fitArt = function (sprite, opts) {
    const box = this.artBox(sprite)
    const o = opts || {}
    const w = box ? box.w : sprite.width
    const h = box ? box.h : sprite.height
    const k = Math.min(o.width ? o.width / w : Infinity, o.height ? o.height / h : Infinity)
    if (Number.isFinite(k) && k > 0) sprite.setScale(k)
    return sprite
  }

  /**
   * Place a sprite by what is drawn: alignArt(sprite, x, y, 'bottom') puts the bottom middle of the drawn subject at
   * (x, y) — 'center' its middle, 'top' its top middle. Holds through its subject's actions. Returns the sprite.
   */
  proto.alignArt = function (sprite, x, y, edge) {
    const box = this.artBox(sprite)
    if (box) {
      const oy = edge === 'top' ? box.y : edge === 'center' ? box.y + box.h / 2 : box.y + box.h
      sprite.setOrigin((box.x + box.w / 2) / box.size, oy / box.size)
    }
    sprite.setPosition(x, y)
    return sprite
  }

  /**
   * The backdrop: a preloaded picture fixed to the screen, behind the scene's other objects. addBackground('bg_play')
   * keeps the picture's proportions and covers the main camera's view (what does not fit is cut evenly off the sides
   * that overflow). The camera's scrolling and zoom leave it in place, and it fits itself again when the view changes
   * size, until the scene ends or the image is destroyed. Scenery that scrolls with the world is world-space images or
   * tiles, not this; a rotated camera or a second camera is not covered. Returns the image.
   * (Games review 12, step 3: 30 of 45 recent backgrounds were stretched to the screen with setDisplaySize.)
   */
  proto.addBackground = function (key) {
    const scene = this
    if (!scene.textures.exists(key)) console.warn(`[addBackground] "${key}" is not loaded: load it in preload() first`)
    const img = this.add.image(0, 0, key).setDepth(-1000000).setScrollFactor(0)
    let seen = ''
    const fit = () => {
      const cam = scene.cameras && scene.cameras.main
      if (!img.scene || !cam) return
      const vw = cam.width, vh = cam.height
      const zx = cam.zoomX || cam.zoom || 1, zy = cam.zoomY || cam.zoom || 1
      const ox = vw * cam.originX, oy = vh * cam.originY
      const now = `${vw}|${vh}|${zx}|${zy}|${ox}|${oy}|${img.width}|${img.height}`
      if (now === seen) return
      seen = now
      // scrollFactor 0 cancels the camera's scroll, not its zoom: Phaser zooms every object about the camera's origin.
      // So the picture is placed where that zoom puts it at the middle of the view, and its cover scale is divided by it.
      const w = img.width || 1, h = img.height || 1
      const k = Math.max(vw / w, vh / h)
      img.setPosition(ox + (vw / 2 - ox) / zx, oy + (vh / 2 - oy) / zy).setScale(k / zx, k / zy)
    }
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      scene.events.off(Phaser.Scenes.Events.POST_UPDATE, fit)
      scene.scale.off('resize', fit)
      scene.events.off(Phaser.Scenes.Events.SHUTDOWN, cleanup)
      scene.events.off(Phaser.Scenes.Events.DESTROY, cleanup)
      img.off(Phaser.GameObjects.Events.DESTROY, cleanup)
    }
    fit()
    scene.events.on(Phaser.Scenes.Events.POST_UPDATE, fit) // every frame: a zoom or a resize is caught before it is drawn
    scene.scale.on('resize', fit) // and while the scene is paused (no update runs then)
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, cleanup)
    scene.events.once(Phaser.Scenes.Events.DESTROY, cleanup)
    img.once(Phaser.GameObjects.Events.DESTROY, cleanup)
    return img
  }

  // ── A manifest sprite made with add.image can still play its actions (games item 6) ──
  // Phaser's Image has no animation component, so image.play() throws ("play is not a function") and the game
  // stops. For the keys BootScene loaded from the manifest (registry '__wkArtKeys'), the image factories make a
  // Sprite from the start — the same object everywhere it is referenced, with nothing played until asked. Any other
  // picture (a background, a URL loaded in a scene) is made as before.
  const managed = (scene, key) => {
    const keys = scene && scene.sys && scene.sys.game && scene.sys.game.registry.get('__wkArtKeys')
    return !!keys && typeof key === 'string' && keys.has(key)
  }
  const factory = Phaser.GameObjects.GameObjectFactory.prototype
  const addImage = factory.image
  factory.image = function (x, y, texture, frame) {
    return managed(this.scene, texture) ? this.sprite(x, y, texture, frame) : addImage.call(this, x, y, texture, frame)
  }
  const creator = Phaser.GameObjects.GameObjectCreator.prototype
  const makeImage = creator.image
  creator.image = function (config, addToScene) {
    return managed(this.scene, config && config.key) ? this.sprite(config, addToScene) : makeImage.call(this, config, addToScene)
  }
  const arcade = Phaser.Physics && Phaser.Physics.Arcade && Phaser.Physics.Arcade.Factory && Phaser.Physics.Arcade.Factory.prototype
  if (arcade) {
    const physicsImage = arcade.image
    const staticImage = arcade.staticImage
    arcade.image = function (x, y, key, frame) {
      return managed(this.scene, key) ? this.sprite(x, y, key, frame) : physicsImage.call(this, x, y, key, frame)
    }
    arcade.staticImage = function (x, y, key, frame) {
      return managed(this.scene, key) ? this.staticSprite(x, y, key, frame) : staticImage.call(this, x, y, key, frame)
    }
  }

  installColorStrings()
  installOriginHitAreas()
  installPageInput()
  installPressRules()
}

// ── A CSS colour where Phaser wants a number (games review 12) ──
// Phaser's shape, graphics and tint colour slots take numbers; a CSS string such as '#4d8d70' draws black and throws
// nothing (11-07: a word game's tiles and keys were all black, so the clues never showed). In these slots a CSS colour
// string now means the colour it names; numbers pass through unchanged, and Text keeps its CSS colours as always.
let colorCtx = null
function cssColor(c) {
  if (typeof c !== 'string') return c
  try {
    if (!colorCtx) colorCtx = document.createElement('canvas').getContext('2d')
    colorCtx.fillStyle = '#000000'
    colorCtx.fillStyle = c
    const v = String(colorCtx.fillStyle)
    if (v[0] === '#') return parseInt(v.slice(1, 7), 16)
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v)
    return m ? (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]) : c
  } catch { return c }
}
function wrapColors(proto, name, slots) {
  const orig = proto && proto[name]
  if (typeof orig !== 'function' || orig.__wkColors) return
  const wrapped = function (...args) { for (const i of slots) if (typeof args[i] === 'string') args[i] = cssColor(args[i]); return orig.apply(this, args) }
  wrapped.__wkColors = true
  proto[name] = wrapped
}
function installColorStrings() {
  const G = Phaser.GameObjects
  if (G.Shape) { wrapColors(G.Shape.prototype, 'setFillStyle', [0]); wrapColors(G.Shape.prototype, 'setStrokeStyle', [1]) }
  if (G.Grid) { wrapColors(G.Grid.prototype, 'setFillStyle', [0]); wrapColors(G.Grid.prototype, 'setAltFillStyle', [0]); wrapColors(G.Grid.prototype, 'setOutlineStyle', [0]) }
  for (const k of ['IsoBox', 'IsoTriangle']) if (G[k]) wrapColors(G[k].prototype, 'setFillStyle', [0, 1, 2])
  if (G.Graphics) {
    wrapColors(G.Graphics.prototype, 'fillStyle', [0]); wrapColors(G.Graphics.prototype, 'lineStyle', [1])
    wrapColors(G.Graphics.prototype, 'fillGradientStyle', [0, 1, 2, 3]); wrapColors(G.Graphics.prototype, 'lineGradientStyle', [1, 2, 3, 4])
  }
  for (const k of ['Image', 'Sprite', 'TileSprite', 'Text', 'BitmapText', 'NineSlice', 'Rope']) {
    if (!G[k]) continue
    wrapColors(G[k].prototype, 'setTint', [0, 1, 2, 3]); wrapColors(G[k].prototype, 'setTintFill', [0, 1, 2, 3])
  }
}

/**
 * Read CSS safe-area insets (provided by the whacka template via --sat / --sab / --sal / --sar).
 * Returns { top, bottom, left, right } in CSS pixels.
 * Use inside a scene to keep UI above the Home Indicator and below the notch.
 */
export function getSafeArea() {
  try {
    const cs = getComputedStyle(document.documentElement)
    return {
      top: parseFloat(cs.getPropertyValue('--sat')) || 0,
      bottom: parseFloat(cs.getPropertyValue('--sab')) || 0,
      left: parseFloat(cs.getPropertyValue('--sal')) || 0,
      right: parseFloat(cs.getPropertyValue('--sar')) || 0,
    }
  } catch {
    return { top: 0, bottom: 0, left: 0, right: 0 }
  }
}

/**
 * sfx, music, sound — the page's one audio engine (src/lib/sound.js, games item 10): the same objects as the 3D runtime's.
 * The platform unlocks audio on the player's first tap or key; sfx.unlock() is kept for old code.
 */
export { sfx, music, sound } from '../sound'
