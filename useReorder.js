import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { mergeOrder, moveKey, shiftKey } from './_reorder-core'

// ─────────────────────────────────────────────
// useReorder — drag-to-reorder for lists and grids (widgets, cards, rows).
// ─────────────────────────────────────────────
//
// const { items, itemProps, handleProps, dragging, over, move, reset } =
//   useReorder(list, { getKey: (x) => x.id, storageKey: 'widget-order' })
//
// Render: items.map((it) => (
//   <div key={key(it)} {...itemProps(it)}>
//     <span {...handleProps(it)}><GripIcon /></span>
//     ...card content...
//   </div>
// ))
//
// Design notes (why this shape and not HTML5 drag-and-drop):
// - Pointer events + a dedicated grip handle. Native HTML5 drag (`draggable` /
//   onDragStart / dataTransfer) has ZERO touch support, and card-body-as-drag-
//   surface fights every button, chart and scroll gesture inside the card.
//   Pointer events also stay coordinate-correct inside the editor preview's
//   scaled iframe, where native drag hit-testing misfires.
// - Drop = splice move (item slots into the target position and the list
//   repacks), not a two-item swap.
// - Order persists per device via localStorage when `storageKey` is set; item
//   sets may change freely between sessions (mergeOrder reconciles).
// - `move(key, ±1)` is the arrow-button fallback so reordering never depends
//   on the drag gesture alone.

export function useReorder(list, opts = {}) {
  const { getKey, storageKey, onChange } = opts
  const keyOf = useCallback(
    (item) => {
      if (getKey) return String(getKey(item))
      const k = item && typeof item === 'object' ? (item.id ?? item.key) : item
      return String(k)
    },
    [getKey],
  )

  const currentKeys = useMemo(() => (Array.isArray(list) ? list.map(keyOf) : []), [list, keyOf])

  const [stored, setStored] = useState(() => {
    if (!storageKey || typeof localStorage === 'undefined') return []
    try { return JSON.parse(localStorage.getItem(`whacka:reorder:${storageKey}`) || '[]') } catch { return [] }
  })
  const [dragging, setDragging] = useState(null)
  const [over, setOver] = useState(null)

  const order = useMemo(() => mergeOrder(stored, currentKeys), [stored, currentKeys])

  const commit = useCallback(
    (next) => {
      setStored(next)
      if (storageKey && typeof localStorage !== 'undefined') {
        try { localStorage.setItem(`whacka:reorder:${storageKey}`, JSON.stringify(next)) } catch { /* private mode */ }
      }
      if (onChange) onChange(next)
    },
    [storageKey, onChange],
  )

  // Drag listeners are attached SYNCHRONOUSLY inside pointerdown, not via an
  // effect keyed on `dragging`: the effect pass lands only after a re-render,
  // leaving a window where the earliest pointermove/pointerup of a very fast
  // flick could be missed. Sync attach closes that window (hardening — the
  // effect version also passed E2E, but this shape has no timing dependency).
  // elementFromPoint sees the element under the finger/cursor regardless of
  // pointer capture (capture retargets events, not hit-testing).
  const orderRef = useRef(order)
  orderRef.current = order
  const activeCleanup = useRef(null)
  useEffect(() => () => { activeCleanup.current?.() }, [])

  const items = useMemo(() => {
    if (!Array.isArray(list)) return []
    const byKey = new Map(list.map((it) => [keyOf(it), it]))
    return order.map((k) => byKey.get(k)).filter((it) => it !== undefined)
  }, [list, order, keyOf])

  const itemProps = useCallback(
    (item) => ({ 'data-reorder-key': keyOf(item) }),
    [keyOf],
  )

  const handleProps = useCallback(
    (item) => ({
      onPointerDown: (e) => {
        e.preventDefault()
        const key = keyOf(item)
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* detached node */ }
        activeCleanup.current?.()
        setDragging(key)
        let overKey = null
        const onMove = (ev) => {
          const el = document.elementFromPoint(ev.clientX, ev.clientY)
          const wrap = el && el.closest('[data-reorder-key]')
          const k = wrap ? wrap.getAttribute('data-reorder-key') : null
          overKey = k && k !== key ? k : null
          setOver(overKey)
        }
        const cleanup = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          activeCleanup.current = null
        }
        const onUp = () => {
          cleanup()
          if (overKey) commit(moveKey(orderRef.current, key, overKey))
          setOver(null)
          setDragging(null)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        activeCleanup.current = cleanup
      },
      style: { touchAction: 'none', cursor: 'grab' },
    }),
    [keyOf, commit],
  )

  const move = useCallback(
    (itemOrKey, delta) => {
      const k = typeof itemOrKey === 'string' ? itemOrKey : keyOf(itemOrKey)
      const next = shiftKey(orderRef.current, k, delta)
      if (next !== orderRef.current) commit(next)
    },
    [keyOf, commit],
  )

  const reset = useCallback(() => {
    commit([])
    if (storageKey && typeof localStorage !== 'undefined') {
      try { localStorage.removeItem(`whacka:reorder:${storageKey}`) } catch { /* private mode */ }
    }
  }, [commit, storageKey])

  return { items, order, dragging, over, itemProps, handleProps, move, reset }
}
