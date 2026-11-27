/**
 * The read cache a live list's re-read must skip (delivery ledger P38,
 * 2026-10-20).
 *
 * A live list (useLive / useLiveShared) re-reads 300 ms after a change notice.
 * db.js answers the same read from its cache for 1.5 s, so a notice that came
 * within 1.5 s of the list's previous read got the list from before the change
 * back, and that change stayed off the screen until the next one. db.js
 * registers how to drop one collection's cached reads; useLive.js does it before
 * every re-read a notice or a recovery asked for. An app's own db.subscribe
 * callbacks keep the cache as they always had.
 *
 * Only the reads that started by the newest notice go (2026-10-21): two lists
 * of the same query on one screen re-read together, and dropping every cached
 * read threw away the read the first had just sent — each read on its own,
 * where before they shared one. A read sent after the notice has the change.
 *
 * Pure: no imports, so the node tests load it as it is.
 */

let dropper = null

/** db.js, once: how to drop one collection's cached reads (those started by a moment, when given). */
export function setCachedReadsDropper(fn) {
  dropper = typeof fn === 'function' ? fn : null
}

/** useLive.js, before a re-read a notice or a recovery asked for: the reads that started by `noticeAt`. */
export function dropCachedReads(collection, noticeAt) {
  if (dropper && typeof collection === 'string' && collection) {
    try { dropper(collection, noticeAt) } catch { /* a cache that cannot drop still reads */ }
  }
}
