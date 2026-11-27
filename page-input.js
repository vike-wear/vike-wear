import Phaser from 'phaser'
import { isFieldElement, isFieldKeyEvent } from '../_field-keys'

// The page around a 2D game keeps its own input (games review 12, step 3, 2D input, first part). Both rules are what the 3D
// input already does (lib/game3d/input.js), and both only take away input the player gave to something else on the page.
//
// 1. A press belongs to the element it starts on. Phaser also listens on the window and hands a touch or a click that landed
//    on another page element (a React button, a menu, a HUD label) to the game objects under that point; the scene hears it
//    as 'pointerdownoutside'. A press that starts on another element now reaches no game object and no scene: not its press,
//    its moves or its release. A press that starts on the canvas is Phaser's as before, wherever it moves or ends. Only when
//    Phaser listens on the canvas (its default): a game that pointed input.mouse / input.touch elsewhere keeps Phaser's ways.
// 2. A focused form field owns the keyboard. Phaser's keyboard listens on the window, so a space typed into a name field made
//    the game jump, and a key the game captured never reached the field. A key pressed in an input, a textarea, a select or an
//    editable element (lib/_field-keys.js) is now not the game's and not swallowed; a key whose press the game took still
//    has its release delivered, wherever it lands. A click on the canvas takes the keyboard back from a field, as a click on
//    any other part of a page does (Phaser cancels the canvas's mousedown, which kept the field focused).
// Installed by createGame and the scene helpers, once; nothing else in Phaser changes.

export function installPageInput() {
  const I = Phaser.Input
  const IM = I && I.InputManager && I.InputManager.prototype
  const KM = I && I.Keyboard && I.Keyboard.KeyboardManager && I.Keyboard.KeyboardManager.prototype
  if (!IM || !KM || IM.__wkPageInput) return
  IM.__wkPageInput = true
  const onCanvas = (manager, which) => !!manager.canvas && (!manager[which] || manager[which].target === manager.canvas)

  // ── 1. presses ──────────────────────────────────────────────────────────────
  const touchStart = IM.onTouchStart
  IM.onTouchStart = function (event) {
    const list = event && event.changedTouches
    if (!list || !onCanvas(this, 'touch')) return touchStart.call(this, event)
    const canvas = this.canvas
    let off = 0
    for (let c = 0; c < list.length; c++) if (list[c].target !== canvas) off++
    if (off === 0) return touchStart.call(this, event) // every new touch is on the canvas: Phaser as it is
    if (off === list.length) return // none is: the page's, and its moves and release find no pointer either
    // Touches on the canvas and elsewhere in one event (browsers group touches by target, so this is rare): Phaser's own
    // loop, over the canvas touches only.
    const pointers = this.pointers
    const changed = []
    for (let c = 0; c < list.length; c++) {
      const touch = list[c]
      if (touch.target !== canvas) continue
      for (let i = 1; i < pointers.length; i++) {
        const pointer = pointers[i]
        if (!pointer.active) { pointer.touchstart(touch, event); this.activePointer = pointer; changed.push(pointer); break }
      }
    }
    this.updateInputPlugins(I.TOUCH_START, changed)
  }

  // The mouse is one pointer with several buttons. The game keeps a record of the buttons it took down on the canvas: a
  // release reaches it only for one of those, and a move that carries a held button only while one of those is held (Phaser
  // reads the held buttons off a move: pointer.buttons, leftButtonDown()). A move with no button held ends every press,
  // including one whose release the page never heard.
  // When the page holds a button of its own during the game's press, Phaser reads that button off the game's events too
  // (and keeps the pointer down until every button is up): after each event the game takes, the pointer keeps only the
  // game's buttons.
  const taken = (m) => m.__wkButtons || (m.__wkButtons = new Set())
  const BIT = [1, 4, 2, 8, 16] // MouseEvent.button → its bit in MouseEvent.buttons
  const own = (held) => { let b = 0; for (const x of held) b |= BIT[x] || 0; return b }
  const settle = (m, event) => {
    const p = m.mousePointer
    const held = taken(m)
    if (!p || !(event.buttons & ~own(held))) return
    p.buttons &= own(held)
    if (!held.size) p.isDown = false
  }
  const mouseDown = IM.onMouseDown
  const mouseMove = IM.onMouseMove
  const mouseUp = IM.onMouseUp
  IM.onMouseDown = function (event) {
    if (!event || !onCanvas(this, 'mouse')) return mouseDown.call(this, event)
    if (event.target !== this.canvas) return // a press on another page element: not the game's
    taken(this).add(event.button)
    const a = document.activeElement
    if (a && isFieldElement(a) && typeof a.blur === 'function') a.blur()
    const out = mouseDown.call(this, event)
    settle(this, event)
    return out
  }
  IM.onMouseMove = function (event) {
    if (!event || !onCanvas(this, 'mouse')) return mouseMove.call(this, event)
    const held = taken(this)
    if (!event.buttons) held.clear()
    else if (!held.size) return
    const out = mouseMove.call(this, event)
    settle(this, event)
    return out
  }
  IM.onMouseUp = function (event) {
    if (!event || !onCanvas(this, 'mouse')) return mouseUp.call(this, event)
    if (!taken(this).delete(event.button)) return
    const out = mouseUp.call(this, event)
    settle(this, event)
    return out
  }

  // ── 2. keys ─────────────────────────────────────────────────────────────────
  const start = KM.startListeners
  const stop = KM.stopListeners
  KM.startListeners = function () {
    start.call(this)
    const target = this.target
    if (!target || !this.onKeyDown || !this.onKeyUp) return
    const self = this
    const down = this.onKeyDown
    const up = this.onKeyUp
    // keys whose press this manager took and whose release it has not: kept across stop/start, as Phaser's Key state is
    const owed = this.__wkOwed || (this.__wkOwed = new Set())
    target.removeEventListener('keydown', down, false)
    target.removeEventListener('keyup', up, false)
    this.onKeyDown = function (event) {
      if (isFieldKeyEvent(event)) return
      if (!event.defaultPrevented && self.enabled && self.manager) owed.add(event.keyCode) // Phaser's own test for taking it
      return down(event)
    }
    this.onKeyUp = function (event) {
      if (!owed.delete(event.keyCode)) return isFieldKeyEvent(event) ? undefined : up(event)
      if (event.defaultPrevented && self.enabled && self.manager) {
        // a release the game is owed, which the page cancelled on its way: still the game's (Phaser would drop it)
        self.queue.push(event)
        self.manager.events.emit(I.Events.MANAGER_PROCESS)
        return
      }
      return up(event)
    }
    target.addEventListener('keydown', this.onKeyDown, false)
    target.addEventListener('keyup', this.onKeyUp, false)
    this.__wkForget = () => owed.clear() // Phaser lets every key go on blur (KeyboardPlugin resetKeys); so does this record
    const events = this.manager && this.manager.game && this.manager.game.events
    if (events) events.on(Phaser.Core.Events.BLUR, this.__wkForget)
  }
  KM.stopListeners = function () {
    const events = this.manager && this.manager.game && this.manager.game.events
    if (events && this.__wkForget) events.off(Phaser.Core.Events.BLUR, this.__wkForget)
    return stop.call(this)
  }
}
