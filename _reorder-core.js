/**
 * Pure order math for useReorder — no React, no DOM, unit-testable.
 *
 * An "order" is an array of string keys. The stored order and the live item
 * list drift apart constantly (items added/removed between sessions), so every
 * read goes through mergeOrder() to reconcile them.
 */

/**
 * Reconcile a stored key order with the keys that exist right now.
 * - Keeps the stored relative order for keys that still exist.
 * - Drops stored keys that no longer exist.
 * - Appends new keys (not in stored) in their current list order.
 */
export function mergeOrder(stored, currentKeys) {
  const current = new Set(currentKeys)
  const seen = new Set()
  const kept = []
  for (const k of Array.isArray(stored) ? stored : []) {
    if (current.has(k) && !seen.has(k)) { kept.push(k); seen.add(k) }
  }
  for (const k of currentKeys) if (!seen.has(k)) { kept.push(k); seen.add(k) }
  return kept
}

/**
 * Move `fromKey` to the slot currently occupied by `toKey` (splice move — the
 * list repacks around the new position; this is NOT a two-item swap).
 * Unknown keys / no-op moves return the input array unchanged (same reference,
 * so React state updates can bail out).
 */
export function moveKey(order, fromKey, toKey) {
  const from = order.indexOf(fromKey)
  const to = order.indexOf(toKey)
  if (from === -1 || to === -1 || from === to) return order
  const next = order.slice()
  next.splice(from, 1)
  next.splice(to, 0, fromKey)
  return next
}

/**
 * Shift `key` by `delta` positions (negative = earlier). Clamped to the ends.
 * The arrow-button fallback for users who can't (or don't want to) drag.
 */
export function shiftKey(order, key, delta) {
  const from = order.indexOf(key)
  if (from === -1 || !delta) return order
  const to = Math.max(0, Math.min(order.length - 1, from + delta))
  if (to === from) return order
  const next = order.slice()
  next.splice(from, 1)
  next.splice(to, 0, key)
  return next
}
