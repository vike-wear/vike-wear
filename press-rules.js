import Phaser from 'phaser'

// A press and its release belong together (games review 12, step 3, 2D input, second part a; two Astra reviews). Three
// corrections to how Phaser 3.90 hands a press to a scene, each making code the agent already writes do what it says.
//
// S1 When Phaser receives the mouse release of a press that began on the canvas and that release landed elsewhere (a page
//    element, outside the window), a scene that does not listen for 'pointerupoutside' hears it as 'pointerup'. A finger
//    already works this way (its release belongs to where it started). Only the scene's last event changes: objects,
//    drags and the pointer's own fields see the real release, and a scene that listens for 'pointerupoutside' keeps it.
// S2 pointer.event.stopPropagation() inside a game object's pointerdown handler also stops Phaser's own propagation, as the
//    handler's fourth argument does: the same press no longer reaches the scene's full-screen 'pointerdown'. Presses only.
// S3 A scene hears the release only of a press it saw go down — this press, not an earlier one with the same pointer id.
//    A press that started a new scene (a menu button) no longer lands its release in that scene as a tap of its own; the
//    scene still tidies up after it (drag end, pointer out) without telling the game it was released.
// Installed by createGame and the scene helpers, once.

export function installPressRules() {
  const I = Phaser.Input
  const IP = I && I.InputPlugin && I.InputPlugin.prototype
  if (!IP || IP.__wkPressRules) return
  IP.__wkPressRules = true
  const E = I.Events
  const START = Phaser.Scenes.START

  // S1: only the choice between 'pointerupoutside' and 'pointerup' at the end of the release
  const processUp = IP.processUpEvents
  IP.processUpEvents = function (pointer) {
    const canvas = this.manager && this.manager.game && this.manager.game.canvas
    if (!canvas || !pointer || pointer.wasTouch || pointer.upElement === canvas || pointer.downElement !== canvas || this.listenerCount(E.POINTER_UP_OUTSIDE) > 0) return processUp.call(this, pointer)
    const plugin = this
    const own = Object.prototype.hasOwnProperty.call(this, 'emit')
    const prev = this.emit
    this.emit = function (name, p) {
      if (name === E.POINTER_UP_OUTSIDE && p === pointer) return prev.call(plugin, E.POINTER_UP, pointer, plugin._temp || [])
      return prev.apply(plugin, arguments)
    }
    try { return processUp.call(this, pointer) } finally { if (own) this.emit = prev; else delete this.emit }
  }

  // S2 (the press only: a release keeps reaching the scene, which is where many holds end)
  const processDown = IP.processDownEvents
  IP.processDownEvents = function (pointer) {
    const ev = pointer && pointer.event
    const data = this._eventData
    if (!ev || !data || typeof ev.stopPropagation !== 'function') return processDown.call(this, pointer)
    const own = Object.prototype.hasOwnProperty.call(ev, 'stopPropagation')
    const prev = ev.stopPropagation
    ev.stopPropagation = function () { data.cancelled = true; return prev.apply(ev, arguments) }
    try { return processDown.call(this, pointer) } finally { if (own) ev.stopPropagation = prev; else delete ev.stopPropagation }
  }

  // S3: per scene, the press each pointer is in as this scene saw it begin (its down time); a finger by id, the mouse by button
  const key = (p) => (p.id === 0 ? `m${p.event && typeof p.event.button === 'number' ? p.event.button : 0}` : `t${p.id}`)
  const update = IP.update
  IP.update = function (type, pointers) {
    if (!this.isActive()) return update.call(this, type, pointers)
    const seen = this.__wkSeen || (this.__wkSeen = new Map())
    if (type === I.MOUSE_DOWN || type === I.TOUCH_START) {
      // only a started scene sees a press: Phaser also hands input to scenes that are listed but not started yet (INIT)
      const status = this.systems && this.systems.settings ? this.systems.settings.status : START
      for (const p of pointers) { if (status >= START) seen.set(key(p), p.downTime); else seen.delete(key(p)) }
    } else if (type === I.MOUSE_UP || type === I.TOUCH_END || type === I.TOUCH_CANCEL) {
      const mine = []
      for (const p of pointers) {
        const k = key(p)
        // a finger is matched to this very press by its down time (Phaser reuses pointer ids); the mouse has one pointer and
        // a down time shared by its buttons, so a button is matched by having gone down here
        if (seen.has(k) && (p.id === 0 || seen.get(k) === p.downTime)) mine.push(p)
        else if (p.id !== 0) { try { this.processDragUpEvent(p); this.processOutEvents(p) } catch { /* tidy only */ } }
        seen.delete(k)
      }
      if (mine.length !== pointers.length) {
        if (!mine.length) return false
        pointers = mine
      }
    }
    return update.call(this, type, pointers)
  }
  const shutdown = IP.shutdown
  IP.shutdown = function () {
    if (this.__wkSeen) this.__wkSeen.clear()
    return shutdown.apply(this, arguments)
  }
}
