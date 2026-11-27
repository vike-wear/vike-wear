// ─────────────────────────────────────────────
// The three 503s a move can leave behind (cells M4; review R, 2026-11-04)
// ─────────────────────────────────────────────
// While an app's account moves between cells a request can be answered, for a few
// seconds, with one of these. None is a rejection of what was sent:
//   MOVING            a write waited out the freeze: nothing of it ran
//   CELL_MISROUTE     the cell it was handed to does not hold the app either: nothing ran
//   CELL_UNREACHABLE  the hop to the app's cell failed: as far as this device can tell nothing ran,
//                     though the far cell may have had it, so it is sent again only under an id
//                     made here (the outbox), where a second send writes the same row
// Pure, no imports: the outbox core and the node tests load it as it is.

const NEVER_RAN = new Set(['MOVING', 'CELL_MISROUTE'])
const NOT_SAVED_YET = new Set(['MOVING', 'CELL_MISROUTE', 'CELL_UNREACHABLE'])

/** How many times one request is sent again after the server said none of it ran. */
export const HOLD_RETRIES = 2
const HOLD_DEFAULT_WAIT_S = 5
const HOLD_MAX_WAIT_S = 15

/** The server says nothing of this request ran: the same request may go again. */
export function neverRan(code) {
  return NEVER_RAN.has(code)
}

/** Not a rejection: the write has not landed as far as this device can tell. */
export function notSavedYet(code) {
  return NOT_SAVED_YET.has(code)
}

/** How long to wait before sending it again, from the answer's Retry-After. */
export function holdRetryMs(retryAfter) {
  const s = Number.parseInt(retryAfter, 10)
  return (Number.isFinite(s) && s >= 0 ? Math.min(s, HOLD_MAX_WAIT_S) : HOLD_DEFAULT_WAIT_S) * 1000
}
