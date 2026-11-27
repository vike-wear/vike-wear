// Is this key event typing into a form field? A key typed into an input, a textarea, a select or an editable element
// reaches window listeners with event.target = that field, or with the field first on composedPath() when it sits in an
// open shadow root. In a closed shadow root (the platform's sign-in window) the event reaches the window retargeted to
// the shadow host and the field cannot be seen from outside, so the platform's own closed panels mark the event on the
// way out (markFieldKeys). One test for the game input layers (lib/game/page-input.js; games review 12).

const MARK = '__wkFieldKey'

export function isFieldElement(el) {
  return !!el && el.nodeType === 1 && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''))
}

export function isFieldKeyEvent(e) {
  if (!e) return false
  if (e[MARK] || isFieldElement(e.target)) return true
  const path = typeof e.composedPath === 'function' ? e.composedPath() : null
  return !!(path && path.length && isFieldElement(path[0]))
}

/** Mark the key events of the fields inside a closed shadow root, before they leave it. */
export function markFieldKeys(root) {
  const mark = (e) => { if (isFieldElement(e.target)) e[MARK] = true }
  root.addEventListener('keydown', mark, true)
  root.addEventListener('keyup', mark, true)
}
