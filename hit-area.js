import Phaser from 'phaser'

// ── Hit areas written around the object's origin (games review 12, step 3, 2026-11) ──
// Phaser reads a custom hit area from the top-left of the object's frame or size: before the shape's Contains is asked,
// the pointer's local point gets the object's displayOrigin added (InputManager.pointWithinHitArea). A shape written
// around the object's origin instead — Rectangle(-w/2, -h/2, w, h) on a centred image, sized container, zone or text,
// Circle(0, 0, r) on a round button — then sits up and to the left of what is drawn, and taps on the object miss.
// (Review 12: 19 of 569 experiment games wrote one; two were blocked in the first minute — monsters that a tap on the
// face never scored, parts that never picked up.)
//
// The rule, one place: when Phaser's own Contains tests a Rectangle that spans zero on both axes and is centred on it
// (each axis within 5% of its span), or a Circle / Ellipse centred exactly on zero, the point is tested from the
// object's origin, so the shape surrounds the origin as written. Everything else is Phaser's: shapes from the top-left
// (small corner spots and padding included), default frame areas, custom callbacks, pixel-perfect tests, polygons,
// triangles and Graphics (whose display origin is 0). Only the position changes, never the units: sizes stay the
// object's own unscaled local units and follow its transforms. input.localX/localY, drag coordinates and event
// arguments keep Phaser's meaning, and the shape object is never changed.
//
// A game can choose explicitly: setInteractive({ hitArea, hitAreaCallback, hitAreaSpace: 'phaser' }) always reads the
// shape from the top-left, hitAreaSpace: 'origin' always from the origin (any callback then gets the origin point).

const EPS = 1e-6
const BAND = 0.05

/** True when the shape and callback are Phaser's own and the shape is written around the object's origin. */
export function originStyleHitArea(shape, contains) {
  const G = Phaser.Geom
  if (!shape || typeof contains !== 'function') return false
  if (shape.type === G.RECTANGLE && contains === G.Rectangle.Contains) {
    const { x, y, width: w, height: h } = shape
    if (!(w > 0 && h > 0)) return false
    return x < 0 && y < 0 && x + w > 0 && y + h > 0 && Math.abs(x + w / 2) <= BAND * w && Math.abs(y + h / 2) <= BAND * h
  }
  if (shape.type === G.CIRCLE && contains === G.Circle.Contains) return Math.abs(shape.x) < EPS && Math.abs(shape.y) < EPS && shape.radius > 0
  if (shape.type === G.ELLIPSE && contains === G.Ellipse.Contains) return Math.abs(shape.x) < EPS && Math.abs(shape.y) < EPS && shape.width > 0 && shape.height > 0
  return false
}

/** Whether this interactive object's shape is read from the object's origin right now. */
export function readsFromOrigin(io) {
  if (!io) return false
  if (io.hitAreaSpace === 'phaser') return false
  if (io.hitAreaSpace === 'origin') return true
  return originStyleHitArea(io.hitArea, io.hitAreaCallback)
}

export function installOriginHitAreas() {
  const IM = Phaser.Input && Phaser.Input.InputManager && Phaser.Input.InputManager.prototype
  const IP = Phaser.Input && Phaser.Input.InputPlugin && Phaser.Input.InputPlugin.prototype
  if (!IM || !IP || IM.__wkOriginHitAreas) return
  IM.__wkOriginHitAreas = true

  // Same as Phaser's, except a shape read from the origin gets the origin point; localX/localY stay Phaser's.
  IM.pointWithinHitArea = function (gameObject, x, y) {
    const qx = x + gameObject.displayOriginX
    const qy = y + gameObject.displayOriginY
    const input = gameObject.input
    if (!input) return false
    const shift = readsFromOrigin(input)
    if (input.hitAreaCallback(input.hitArea, shift ? x : qx, shift ? y : qy, gameObject)) {
      input.localX = qx
      input.localY = qy
      return true
    }
    return false
  }
  IM.pointWithinInteractiveObject = function (object, x, y) {
    if (!object.hitArea) return false
    const qx = x + object.gameObject.displayOriginX
    const qy = y + object.gameObject.displayOriginY
    object.localX = qx
    object.localY = qy
    const shift = readsFromOrigin(object)
    return object.hitAreaCallback(object.hitArea, shift ? x : qx, shift ? y : qy, object)
  }

  // The explicit choice rides on the config object Phaser already takes; Phaser ignores keys it does not know.
  const setHitArea = IP.setHitArea
  IP.setHitArea = function (gameObjects, hitArea, hitAreaCallback) {
    const out = setHitArea.call(this, gameObjects, hitArea, hitAreaCallback)
    const space = hitArea && typeof hitArea === 'object' && !Array.isArray(hitArea) && (hitArea.hitAreaSpace === 'phaser' || hitArea.hitAreaSpace === 'origin') ? hitArea.hitAreaSpace : null
    if (space) for (const go of Array.isArray(gameObjects) ? gameObjects : [gameObjects]) if (go && go.input) go.input.hitAreaSpace = space
    return out
  }
}
