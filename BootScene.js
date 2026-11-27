/**
 * createBootScene(manifest, options?) — factory for a Phaser BootScene that
 * auto-loads every sprite declared in the manifest (still images and 2×2
 * animation sheets), registers the animations, then starts the main gameplay scene.
 *
 * The manifest comes from the app's own src/game/assets.manifest.js, where
 * each key is an asset id:
 *
 *   {
 *     hero:       { description: 'chibi samurai cat', size: 64, frames: 1 },
 *     hero_run:   { description: 'chibi samurai cat', size: 64, frames: 4, fps: 10, loop: true, motion: 'running stride' },
 *     coin_burst: { description: 'gold coin', size: 32, frames: 4, fps: 12, loop: false, motion: 'bursts into sparks, gone in the last frame' },
 *   }
 *
 * `frames: 1` is a still image: loaded as an image, no animation. `frames: 4` is
 * a 2×2 sheet: loaded as four frames, its animation registered under the same
 * key, repeating unless `loop: false` (an entry without `loop` repeats, as before).
 * An entry whose file turns out to be a single still (one cell, not a 2×2 sheet)
 * is shown as a still whatever its `frames` says, or when `frames` is missing.
 *
 * Sprites are loaded from the deterministic URL via gameAsset(key). The
 * backend's generate_sprite_sheet tool draws stills and frames at 2× (ASSET_SCALE)
 * the declared size; once loaded, each still or sheet becomes a texture at the
 * declared size. So a sprite is its declared size in every Phaser sense: setScale(1), a tween
 * on scale, setDisplaySize, displayWidth, sprite.width and a physics body all
 * mean the same pixels. (Until 2026-11 a patch divided setScale by 2 instead,
 * and a tween on scale, which writes the property directly, doubled a sprite.)
 *
 * Usage:
 *   import createBootScene from '../lib/game/BootScene'
 *   import manifest from './assets.manifest'
 *   import PlayScene from './scenes/Play'
 *
 *   const Boot = createBootScene(manifest, { startKey: 'play' })
 *
 *   <GameCanvas
 *     mode="fullscreen"
 *     config={{ scene: [Boot, PlayScene] }}
 *   />
 */

import Phaser from 'phaser'
import { gameAsset } from './asset-path'

// Generated sprites are rendered at 2× the declared size for HiDPI clarity.
// Keep in sync with src/lib/ai/asset-gen/sprite-gen.ts ASSET_SCALE.
export const ASSET_SCALE = 2

// A still is an entry whose manifest says frames: 1, or whose file is one cell: an image of size × 2 on
// each side (what the generator draws for a still) is shown as a still even if its `frames` is missing or
// says 4, so a manifest that leaves `frames` out cannot draw a still at twice its size. A loaded 2×2 sheet
// is never one cell. A texture already made a still at its declared size (only its base frame) stays one.
function isStill(scene, key, size, frames) {
  if (frames === 1) return true
  const tex = scene.textures.get(key)
  if (tex.frameTotal === 1) return true
  const src = tex.getSourceImage()
  return tex.frameTotal === 2 && src.width === size * ASSET_SCALE && src.height === size * ASSET_SCALE
}

// A loaded 2× still or sheet becomes a texture of the declared size, once, so every Phaser size means
// declared pixels. With WebGL the texture keeps all of its generated pixels and is only
// registered at the declared size: the GPU samples the 2× image, so a sprite drawn larger
// than declared stays sharp. The canvas renderer draws image pixels one for one, so there
// the image is redrawn at the declared size. A texture already at its declared size (a scene
// restarted, a second game on the page) is left as it is.
function textureAtDeclaredSize(scene, key, size, still) {
  const tex = scene.textures.get(key)
  const src = tex && tex.getSourceImage()
  const side = still ? size : size * 2 // a still of `size`, or a 2×2 sheet of `size` frames
  if (!src || !src.width || src.width !== side * ASSET_SCALE || tex.source[0].width !== src.width) return
  scene.textures.remove(key)
  if (scene.sys.game.renderer && scene.sys.game.renderer.type === Phaser.WEBGL) {
    const t = scene.textures.create(key, src, side, side)
    if (still) Phaser.Textures.Parsers.Image(t, 0)
    else Phaser.Textures.Parsers.SpriteSheet(t, 0, 0, 0, side, side, { frameWidth: size, frameHeight: size })
    return
  }
  const canvas = document.createElement('canvas')
  canvas.width = side
  canvas.height = side
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, side, side)
  if (still) scene.textures.addImage(key, canvas)
  else scene.textures.addSpriteSheet(key, canvas, { frameWidth: size, frameHeight: size })
}

function normalizeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return {}
  return manifest.default && typeof manifest.default === 'object' ? manifest.default : manifest
}

// The file decides its size (games item 6, 2026-11): the generator draws a still at size × 2 and a 2×2 sheet at
// size × 4, and a subject's sprites all take their subject's size, which a manifest written earlier may not say.
// A file that fits the manifest's size keeps it; a still or a sheet that does not is read at the size its pixels
// give. A sheet whose file is one cell of the manifest's size is a still, as before.
function resolveShape(scene, key, asset) {
  const frames = Number(asset.frames) || 4
  const size = Number(asset.size) || 64
  const src = scene.textures.get(key).getSourceImage()
  const w = (src && src.width) || 0
  if (frames === 1) return { still: true, size: w && w !== size * ASSET_SCALE && w % ASSET_SCALE === 0 ? w / ASSET_SCALE : size }
  if (isStill(scene, key, size, frames)) return { still: true, size }
  if (w && w !== size * 2 * ASSET_SCALE && w % (2 * ASSET_SCALE) === 0) return { still: false, size: w / (2 * ASSET_SCALE) }
  return { still: false, size }
}

// What each frame visibly shows (alpha > 10), in declared pixels from the frame's top-left: read from the texture
// the game actually loaded, so it can never describe another version of the picture. Null when a frame is empty
// or the pixels cannot be read.
function measureArt(scene, key, still, size) {
  try {
    const src = scene.textures.get(key).getSourceImage()
    const side = still ? size : size * 2
    const canvas = document.createElement('canvas')
    canvas.width = side
    canvas.height = side
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(src, 0, 0, side, side)
    const data = ctx.getImageData(0, 0, side, side).data
    const cells = still ? 1 : 2
    const boxes = []
    for (let i = 0; i < cells * cells; i++) {
      const x0 = (i % cells) * size
      const y0 = Math.floor(i / cells) * size
      let minX = size, minY = size, maxX = -1, maxY = -1
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (data[((y0 + y) * side + x0 + x) * 4 + 3] <= 10) continue
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
      boxes.push(maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 })
    }
    return boxes
  } catch {
    return null
  }
}

/**
 * @param {Record<string, { frames?: number, fps?: number, size?: number, loop?: boolean, motion?: string }>} manifest
 * @param {{ startKey?: string, showProgressBar?: boolean }} [options]
 * @returns {typeof Phaser.Scene}
 */
export default function createBootScene(manifest, options = {}) {
  const entries = normalizeManifest(manifest)
  const startKey = options.startKey || 'main'
  const showProgressBar = options.showProgressBar !== false

  return class BootScene extends Phaser.Scene {
    constructor() {
      super('boot')
    }

    preload() {
      const W = this.scale.width
      const H = this.scale.height

      // Progress bar
      let bar, barBg
      if (showProgressBar) {
        barBg = this.add.rectangle(W / 2, H / 2, 240, 4, 0x222222).setAlpha(0.6)
        bar = this.add.rectangle(W / 2 - 120, H / 2, 0, 4, 0xffffff).setOrigin(0, 0.5)
        this.load.on('progress', (v) => { bar.width = 240 * v })
      }

      // Load each sprite in the manifest: a still as an image, a 2×2 sheet as four frames
      for (const [key, asset] of Object.entries(entries)) {
        if (!asset || typeof asset !== 'object') continue
        const frames = Number(asset.frames) || 4
        const size = Number(asset.size) || 64
        if (frames === 1) {
          this.load.image(key, gameAsset(key))
          continue
        }
        if (frames !== 4) {
          console.warn(`[BootScene] "${key}" frames=${frames} — only a still (frames=1) or a 2×2 sheet (frames=4) is supported; skipping`)
          continue
        }
        const frameWidth = size * ASSET_SCALE
        const frameHeight = size * ASSET_SCALE
        this.load.spritesheet(key, gameAsset(key), { frameWidth, frameHeight })
      }

      // Silently swallow load errors so a missing sprite doesn't break the scene.
      // Scene code can check this.textures.exists(key) before using a sprite.
      this.load.on('loaderror', (file) => {
        console.warn(`[BootScene] failed to load ${file.key} from ${file.src}`)
      })

      // Default particle texture, used by scene helpers' particleBurst
      this.load.on('complete', () => {
        if (!this.textures.exists('particle')) {
          const g = this.make.graphics({ add: false })
          g.fillStyle(0xffffff, 1)
          g.fillCircle(4, 4, 4)
          g.generateTexture('particle', 8, 8)
          g.destroy()
        }
        if (bar) bar.destroy()
        if (barBg) barBg.destroy()
      })
    }

    create() {
      // Each still and sheet at its declared size, then each sheet's animation (a still has none). What each frame
      // visibly shows is recorded for the art helpers (this.fitArt, this.alignArt), and every manifest key is
      // registered so a scene's add.image of it gives an object that can play its subject's actions (helpers.js).
      const art = {}
      const before = this.registry.get('__wkArt') || {} // a restarted boot keeps what the first one read off the files
      for (const [key, asset] of Object.entries(entries)) {
        if (!asset || typeof asset !== 'object') continue
        if (!this.textures.exists(key)) continue // 404 on this sprite — skip anim registration
        const frames = Number(asset.frames) || 4
        const { still, size } = before[key] ? { still: before[key].frames === 1, size: before[key].size } : resolveShape(this, key, asset)
        textureAtDeclaredSize(this, key, size, still)
        art[key] = { size, frames: still ? 1 : 4, subject: typeof asset.subject === 'string' ? asset.subject : null, boxes: measureArt(this, key, still, size) }
        if (still || this.anims.exists(key)) continue
        const fps = Number(asset.fps) || 6
        const loop = asset.loop !== false
        this.anims.create({
          key,
          frames: this.anims.generateFrameNumbers(key, { start: 0, end: frames - 1 }),
          frameRate: fps,
          repeat: loop ? -1 : 0,
        })
      }
      this.registry.set('__wkArt', art)
      this.registry.set('__wkArtKeys', new Set(Object.keys(art)))

      // Transition to the real start scene
      this.scene.start(startKey)
    }
  }
}
