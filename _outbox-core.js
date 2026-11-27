/**
 * Platform-layer offline write outbox — core engine for outbox.js.
 *
 * No dependencies but the pure _call-shape.js and _hold-codes.js, with injectable clock/storage/writes
 * so it is unit-testable in plain node (preview-template is "type":"module"; node
 * and Vite both load ESM).
 *
 * Semantics (v1, deliberately narrow):
 *   - INSERT-ONLY. Every op gets a client-generated UUID at enqueue time and is
 *     replayed through upsert / insertMany{idField} — both server-idempotent, so
 *     a crash mid-flush or a double-flush from a second tab re-writes the SAME
 *     row instead of duplicating it. update/delete (conflict semantics),
 *     increment (commutative but NOT idempotent) and files are excluded.
 *   - Queue is partitioned by the app-user id captured AT ENQUEUE TIME; flush
 *     only replays the current identity's ops, so signing out or switching
 *     accounts can never attribute another person's offline entries to you.
 *   - Caps are LOUD. A full outbox rejects NEW entries with a catchable
 *     `outbox_full` error and NEVER evicts older pending ops to make room
 *     (silently deleting a user's unsynced field data is the one failure mode
 *     this primitive exists to prevent).
 *   - Flush failures are classified, never swallowed:
 *       network / 5xx / 408  -> keep queued, exponential cooldown, retry later
 *       429                  -> keep queued, exponential cooldown (rate budget)
 *       401                  -> keep queued, surface needsAuth
 *       other 4xx            -> move to the FAILED list with the server reason
 *                               and `say`, the sentence a person reads (_say.js)
 *                               (visible via status()/failed(), user-retryable)
 *     A rejected BATCH falls back to single-op replay so one poison row can't
 *     fail out its neighbours.
 */

import { outboxOptions } from './_call-shape.js'
import { notSavedYet } from './_hold-codes.js'
import { sayFor } from './_say.js'

const MAX_OPS = 500
const MAX_QUEUE_BYTES = 1_000_000 // ~1MB serialized — localStorage is a shared ~5MB pool
const MAX_OP_BYTES = 100 * 1024   // mirrors the server's per-record limit
const MAX_FAILED = 200
const BATCH_MIN = 20              // below this, replay one op per loop turn
const BATCH_MAX = 500             // server cap for insertMany rows
const RL_BASE_MS = 4000
const RL_MAX_MS = 60000
const RL_JITTER_MS = 1000
const LOCK_TTL_MS = 15000
// A replay that never settles (a hung request under a client without its own
// deadline) used to pin `syncing` at true for the rest of the page — the badge
// said "syncing…" forever and no later flush could start. Every run now races
// this deadline; past it the run counts as a transient failure (no status →
// keep queued, cooldown) and `syncing` is released. db.js's own 30s request
// timeout normally fires first; this is the backstop (L2 pass, 2026-09-27).
const FLUSH_RUN_TIMEOUT_MS = 60_000

const OPT_KEYS = ['groupId', 'visibleTo', 'writableBy', 'writableFields', 'expiresAt']

/** Queued after all: the write's "couldn't save" line (db.js) would be false. */
function heldBack(e) {
  try { if (e && typeof e.queued === 'function') e.queued() } catch { /* the line shows; nothing is lost */ }
}

function cleanOpts(opts) {
  if (!opts || typeof opts !== 'object') return {}
  const out = {}
  for (const k of OPT_KEYS) if (opts[k] !== undefined) out[k] = opts[k]
  return out
}

/** Bound a server read result for the persisted offline read-cache. */
export function trimForCache(rows, { maxRows = 200, maxBytes = 200 * 1024 } = {}) {
  if (!Array.isArray(rows)) return []
  let out = rows.slice(0, maxRows)
  while (out.length > 1 && JSON.stringify(out).length > maxBytes) {
    out = out.slice(0, Math.ceil(out.length / 2))
  }
  if (out.length === 1 && JSON.stringify(out).length > maxBytes) return []
  return out
}

/**
 * Merge pending (unsynced) rows into a server read result, deduping by id —
 * after a sync the server copy wins. Default server order is '-createdAt'
 * (newest first), so pending rows go in FRONT unless an ascending order was
 * requested.
 */
export function mergePending(serverRows, pendingRows, order) {
  const base = Array.isArray(serverRows) ? serverRows : []
  if (!Array.isArray(pendingRows) || pendingRows.length === 0) return base
  const seen = new Set(base.map((r) => r && r.id))
  const fresh = pendingRows.filter((p) => p && !seen.has(p.id))
  if (!fresh.length) return base
  const ascending = typeof order === 'string' && order !== '' && !order.startsWith('-')
  return ascending ? [...base, ...fresh] : [...fresh, ...base]
}

export function createOutbox({
  writes,
  getUserId,
  storage,
  isOnline = () => true,
  now = () => Date.now(),
  random = Math.random,
  uuid = () => (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : `ob-${now()}-${Math.floor(random() * 1e9)}`),
  requestPersist = () => {},
  maxOps = MAX_OPS,
  maxQueueBytes = MAX_QUEUE_BYTES,
  maxOpBytes = MAX_OP_BYTES,
  maxFailed = MAX_FAILED,
  batchMin = BATCH_MIN,
  batchMax = BATCH_MAX,
  baseMs = RL_BASE_MS,
  maxMs = RL_MAX_MS,
  jitterMs = RL_JITTER_MS,
  lockTtlMs = LOCK_TTL_MS,
  flushRunTimeoutMs = FLUSH_RUN_TIMEOUT_MS,
  storageKey = '__whacka_outbox_v1',
  lockKey = '__whacka_outbox_lock',
} = {}) {
  if (!writes || typeof writes.upsert !== 'function') throw new Error('createOutbox requires { writes }')
  if (typeof getUserId !== 'function') throw new Error('createOutbox requires { getUserId }')
  if (!storage) throw new Error('createOutbox requires { storage }')

  // Not uuid(): op ids must be the uuid sequence alone (stable, observable).
  const tabId = `tab:${now()}:${Math.floor(random() * 1e9)}`
  const listeners = new Set()
  let syncing = false
  let needsAuth = false
  let lastSyncAt = 0
  let cooldownUntil = 0
  let backoffMs = 0
  let singleMode = false // set when a batch got a permanent reject → isolate the poison row
  let persistAsked = false

  // ── storage ────────────────────────────────────────────────────────────────
  function load() {
    try {
      const raw = storage.getItem(storageKey)
      if (!raw) return { ops: [], failed: [] }
      const q = JSON.parse(raw)
      return {
        ops: Array.isArray(q.ops) ? q.ops : [],
        failed: Array.isArray(q.failed) ? q.failed : [],
      }
    } catch {
      return { ops: [], failed: [] }
    }
  }

  function save(q) {
    storage.setItem(storageKey, JSON.stringify(q))
  }

  function notify() {
    const s = status()
    for (const cb of listeners) {
      try { cb(s) } catch (e) { console.error('[outbox] listener error:', e) }
    }
  }

  // ── enqueue ────────────────────────────────────────────────────────────────
  function fullError(count) {
    const e = new Error(
      `Outbox is full (${count} unsynced changes). Reconnect to sync before adding more — nothing already queued has been dropped.`,
    )
    e.code = 'outbox_full'
    return e
  }

  function enqueueOp(op) {
    const opStr = JSON.stringify(op)
    if (opStr.length > maxOpBytes) {
      const e = new Error(`This record is too large to queue offline (${Math.round(opStr.length / 1024)}KB > ${Math.round(maxOpBytes / 1024)}KB).`)
      e.code = 'outbox_record_too_large'
      throw e
    }
    const q = load()
    if (q.ops.length >= maxOps || JSON.stringify(q.ops).length + opStr.length > maxQueueBytes) {
      throw fullError(q.ops.length)
    }
    q.ops.push(op)
    try {
      save(q)
    } catch {
      // localStorage quota — same contract as a full outbox: reject THIS entry
      // loudly, never clear other keys or older pending ops to make room.
      throw fullError(q.ops.length - 1)
    }
    if (!persistAsked) {
      persistAsked = true
      try { requestPersist() } catch { /* best-effort */ }
    }
    notify()
  }

  async function write(shared, collection, data, opts) {
    if (!collection || typeof collection !== 'string') throw new Error('outbox: collection name required')
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('outbox: data must be an object')
    const id = uuid()
    const cleaned = cleanOpts(opts)
    if (isOnline()) {
      try {
        return shared
          ? await writes.upsertShared(collection, data, id, cleaned)
          : await writes.upsert(collection, data, id, cleaned)
      } catch (e) {
        // The server answered → a real rejection (validation / quota / auth).
        // Surface it; queueing would only mask a bug as "pending sync". A move's
        // 503 rejects nothing: the app's cell did not take it yet, and this op's id
        // is made here, so a replay writes the same row (_hold-codes.js).
        if (e && e.status && !notSavedYet(e.code)) throw e
        // No status → the request never reached the server. Queue below.
        heldBack(e)
      }
    }
    enqueueOp({ id, coll: collection, data, shared: !!shared, opts: cleaned, uid: getUserId(), qt: now() })
    // The failure may have been a blip — try a sync now (respects the cooldown).
    if (isOnline()) Promise.resolve().then(() => flush()).catch(() => {})
    return { id, ...data, _pending: true }
  }

  // ── flush ──────────────────────────────────────────────────────────────────
  function classify(e) {
    const s = e && e.status
    if (!s) return 'transient'
    if (s === 401) return 'auth'
    // A capacity ceiling (dbRows quota) rides a 429 but does NOT reset on its
    // own — surface it in the failed list (retryable after upgrade/cleanup)
    // instead of silently backing off forever like a per-minute rate limit.
    if (s === 429) return e.code === 'QUOTA_EXCEEDED' ? 'permanent' : 'rate'
    if (s === 408 || s >= 500) return 'transient'
    return 'permanent'
  }

  function applyCooldown() {
    backoffMs = backoffMs ? Math.min(backoffMs * 2, maxMs) : baseMs
    cooldownUntil = now() + backoffMs + Math.floor(random() * jitterMs)
  }

  function opSig(op) {
    return JSON.stringify([op.coll, !!op.shared, op.opts || {}])
  }

  function takeRun(mine) {
    if (singleMode) return [mine[0]]
    const sig = opSig(mine[0])
    const run = []
    for (const op of mine) {
      if (opSig(op) !== sig) break
      run.push(op)
      if (run.length >= batchMax) break
    }
    return run.length >= batchMin ? run : [mine[0]]
  }

  function replayRunOnce(run) {
    const head = run[0]
    if (run.length === 1) {
      return head.shared
        ? writes.upsertShared(head.coll, head.data, head.id, head.opts || {})
        : writes.upsert(head.coll, head.data, head.id, head.opts || {})
    }
    // Batch replay: insertMany{idField:'id'} REPLACES rows with the same id
    // server-side, so a re-run after a crash is as idempotent as the single path.
    const rows = run.map((op) => ({ ...op.data, id: op.id }))
    const o = { ...(head.opts || {}), idField: 'id' }
    return head.shared ? writes.insertManyShared(head.coll, rows, o) : writes.insertMany(head.coll, rows, o)
  }

  // The replay under a deadline. A timeout rejects with NO status (the server
  // never answered) → classify() reads it as transient. The timer is always
  // cleared so a test process (or an idle tab) never waits on it.
  function replayRun(run) {
    if (!(flushRunTimeoutMs > 0)) return Promise.resolve(replayRunOnce(run))
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const e = new Error(`outbox: sync request did not finish within ${Math.round(flushRunTimeoutMs / 1000)}s`)
        e.code = 'TIMEOUT'
        reject(e)
      }, flushRunTimeoutMs)
      Promise.resolve()
        .then(() => replayRunOnce(run))
        .then(
          (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } },
          (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } },
        )
    })
  }

  function removeOps(ids) {
    const gone = new Set(ids)
    const q = load()
    q.ops = q.ops.filter((op) => !gone.has(op.id))
    save(q)
  }

  function moveToFailed(op, e) {
    const q = load()
    q.ops = q.ops.filter((o) => o.id !== op.id)
    // reason = the server's sentence (for the builder); say = the person's (err.say, 2026-11-09).
    q.failed.push({ ...op, reason: (e && e.message) || 'rejected', say: (e && e.say) || sayFor({ status: e && e.status }), status: e && e.status, failedAt: now() })
    while (q.failed.length > maxFailed) {
      const dropped = q.failed.shift()
      console.error('[outbox] failed list overflow — dropping oldest rejected entry:', dropped && dropped.id)
    }
    save(q)
  }

  // Cross-tab flush lock. Advisory only: replay is idempotent, so a stale or
  // raced lock can waste requests but never duplicate rows.
  function acquireLock() {
    try {
      const raw = storage.getItem(lockKey)
      if (raw) {
        const [owner, exp] = raw.split('|')
        if (owner !== tabId && Number(exp) > now()) return false
      }
      storage.setItem(lockKey, `${tabId}|${now() + lockTtlMs}`)
      return true
    } catch {
      return true
    }
  }
  function refreshLock() {
    try { storage.setItem(lockKey, `${tabId}|${now() + lockTtlMs}`) } catch { /* advisory */ }
  }
  function releaseLock() {
    try {
      const raw = storage.getItem(lockKey)
      if (raw && raw.split('|')[0] === tabId) storage.removeItem(lockKey)
    } catch { /* advisory */ }
  }

  async function flush() {
    if (syncing) return status()
    if (now() < cooldownUntil) return status()
    if (!acquireLock()) return status()
    syncing = true
    notify()
    try {
      for (;;) {
        if (now() < cooldownUntil) break
        refreshLock()
        const uid = getUserId()
        const mine = load().ops.filter((op) => op.uid === uid)
        if (!mine.length) break
        const run = takeRun(mine)
        let error = null
        try {
          await replayRun(run)
        } catch (e) {
          error = e || new Error('replay failed')
          heldBack(error)
        }
        if (!error) {
          removeOps(run.map((op) => op.id))
          backoffMs = 0
          needsAuth = false
          singleMode = false
          lastSyncAt = now()
          notify()
          continue
        }
        const kind = classify(error)
        if (kind === 'permanent') {
          if (run.length > 1) {
            // One bad row must not fail out the whole batch — replay singly so
            // each op gets its own verdict.
            singleMode = true
            continue
          }
          moveToFailed(run[0], error)
          notify()
          continue
        }
        if (kind === 'auth') needsAuth = true
        applyCooldown()
        break
      }
    } finally {
      syncing = false
      releaseLock()
      notify()
    }
    return status()
  }

  // ── public surface ─────────────────────────────────────────────────────────
  function status() {
    const q = load()
    const uid = getUserId()
    return {
      pending: q.ops.filter((op) => op.uid === uid).length,
      failed: q.failed.filter((f) => f.uid === uid).length,
      syncing,
      needsAuth,
      lastSyncAt,
    }
  }

  function pending(collection, { shared } = {}) {
    const uid = getUserId()
    return load().ops
      .filter((op) => op.uid === uid
        && (collection === undefined || op.coll === collection)
        && (shared === undefined || !!op.shared === !!shared))
      .map((op) => ({ id: op.id, ...op.data, _pending: true }))
  }

  function failed() {
    const uid = getUserId()
    return load().failed
      .filter((f) => f.uid === uid)
      // An entry stored before `say` existed gets its status's sentence.
      .map((f) => ({ id: f.id, collection: f.coll, data: f.data, reason: f.reason, say: f.say || sayFor({ status: f.status }), status: f.status, failedAt: f.failedAt }))
  }

  function retryFailed() {
    const uid = getUserId()
    const q = load()
    const mine = q.failed.filter((f) => f.uid === uid)
    if (!mine.length) return 0
    q.failed = q.failed.filter((f) => f.uid !== uid)
    // Requeue at the FRONT: failed ops predate everything currently queued.
    const requeued = mine.map((f) => {
      const op = { ...f }
      delete op.reason
      delete op.say
      delete op.status
      delete op.failedAt
      return op
    })
    q.ops = [...requeued, ...q.ops]
    save(q)
    notify()
    if (isOnline()) Promise.resolve().then(() => flush()).catch(() => {})
    return mine.length
  }

  function discardFailed(id) {
    const uid = getUserId()
    const q = load()
    const before = q.failed.length
    q.failed = q.failed.filter((f) => f.uid !== uid || (id !== undefined && f.id !== id))
    if (q.failed.length === before) return 0
    save(q)
    notify()
    return before - q.failed.length
  }

  function subscribe(cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }

  return {
    // (collection, data, options), or db's (collection, data, id, options): the
    // outbox picks the row's id itself, so a caller's id is not used (P95).
    insert: (collection, data, opts, dbOpts) => write(false, collection, data, outboxOptions(opts, dbOpts)),
    insertShared: (collection, data, opts, dbOpts) => write(true, collection, data, outboxOptions(opts, dbOpts)),
    flush,
    status,
    pending,
    failed,
    retryFailed,
    discardFailed,
    subscribe,
    /** Re-read storage and notify listeners (cross-tab 'storage' event hook). */
    refresh: notify,
  }
}
