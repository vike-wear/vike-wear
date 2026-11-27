import Phaser from 'phaser'
import { getAudioContext, masterNode, onRunning, sound } from './sound'
import { installOriginHitAreas } from './game/hit-area'
import { installPageInput } from './game/page-input'
import { installPressRules } from './game/press-rules'

// Phaser plays through the page's one audio engine (games item 10). Its sound manager is built on the shared context by a
// platform subclass, chosen in the factory Game.boot calls, so the overrides are in place before Phaser registers any event:
// the context's unlock, visibility and iOS resume belong to src/lib/sound.js; destroying one game never suspends the shared
// context; Phaser's mute is the one mute (GLOBAL_MUTE still fires). Games built on another context or with
// noAudio / disableWebAudio keep Phaser's own manager.
const adoptedManagers = new Set()
let PlatformSoundManager = null
function installPlatformSound() {
  if (PlatformSoundManager) return
  const Base = Phaser.Sound.WebAudioSoundManager
  const BaseManager = Phaser.Sound.BaseSoundManager
  const SoundEvents = Phaser.Sound.Events
  const GameEvents = Phaser.Core.Events
  PlatformSoundManager = class extends Base {
    constructor(game) {
      super(game)
      try { this.masterVolumeNode.disconnect(); this.masterVolumeNode.connect(masterNode()) } catch { /* ignore */ }
      adoptedManagers.add(this)
    }
    createAudioContext() { return getAudioContext() }
    unlock() { onRunning(() => { if (this.game) this.unlocked = true }) } // BaseSoundManager.update turns this into UNLOCKED
    onBlur() {}
    onFocus() {}
    onGameVisible() {}
    get mute() { return sound.muted }
    set mute(v) { sound.muted = !!v }
    destroy() {
      adoptedManagers.delete(this)
      this.destination = null
      try { this.masterVolumeNode.disconnect() } catch { /* ignore */ }
      try { this.masterMuteNode.disconnect() } catch { /* ignore */ }
      this.masterVolumeNode = null
      this.masterMuteNode = null
      this.game.events.off(GameEvents.VISIBLE, this.onGameVisible, this)
      BaseManager.prototype.destroy.call(this)
    }
  }
  sound.onMute((m) => { for (const sm of adoptedManagers) { try { sm.emit(SoundEvents.GLOBAL_MUTE, sm, m) } catch { /* ignore */ } } })
  const factory = Phaser.Sound.SoundManagerCreator
  const create = factory.create
  factory.create = function (game) {
    const a = game.config.audio || {}
    const ctx = getAudioContext()
    if (ctx && a.context === ctx && !a.noAudio && !a.disableWebAudio && game.device.audio.webAudio) return new PlatformSoundManager(game)
    return create.call(this, game)
  }
}

// ─────────────────────────────────────────────
// Event bus for React ↔ Phaser communication
// ─────────────────────────────────────────────

export const EventBus = new Phaser.Events.EventEmitter()

// ─────────────────────────────────────────────
// Game factory — creates a Phaser.Game with
// mobile-optimized defaults for whacka PWAs
// ─────────────────────────────────────────────

/**
 * Create a Phaser game instance with sensible mobile defaults.
 *
 * @param {HTMLElement} parent - DOM element to mount the canvas into
 * @param {object} [config={}] - Phaser GameConfig overrides
 * @returns {Phaser.Game}
 *
 * @example
 * const game = createGame(containerEl, {
 *   scene: [MyScene],
 *   physics: { arcade: { gravity: { y: 600 } } },
 *   backgroundColor: '#1a1a2e',  // canvas auto-fills container
 * })
 */
export function createGame(parent, config = {}) {
  const {
    scene,
    physics,
    backgroundColor = '#000000',
    scale,
    ...rest
  } = config

  // The page's one audio engine (see installPlatformSound) unless the game opted out of Web Audio or brought its own context.
  installOriginHitAreas() // a custom hit area written around the object's origin surrounds it (games review 12)
  installPageInput() // a press or a key the player gave to another page element is not the game's (games review 12)
  installPressRules() // a press and its release belong together (games review 12)
  const userAudio = rest.audio || {}
  const sharedAudio = userAudio.noAudio || userAudio.disableWebAudio || userAudio.context ? null : getAudioContext()
  if (sharedAudio) installPlatformSound()
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor,
    scene: scene || [],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      ...scale,
    },
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { x: 0, y: 0 },
        debug: false,
        ...(physics?.arcade || {}),
      },
      ...(physics ? { default: physics.default || 'arcade' } : {}),
    },
    input: {
      activePointers: 3,
      touch: { capture: true },
    },
    render: { antialias: true },
    banner: false,
    ...rest,
    audio: sharedAudio ? { ...userAudio, context: sharedAudio } : userAudio,
  })
  return game
}
