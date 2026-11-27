/**
 * Database helper — secure data persistence for generated apps.
 * All CRUD operations go through the Whacka API (service-role access).
 * Realtime subscriptions use Supabase client (read-only) as a transitional measure.
 */

import { createClient } from '@supabase/supabase-js'
import { getAppUserId } from './user'
import { getHeaders } from './_headers'
import { getSupabaseToken, getRealtimeTokenFor, replaceRefusedToken } from './_supabase-token'
import { bundleRealtimeHome, homeKey, noteRealtimeAnswer, notePageMoved, pageRealtimeHome } from './_realtime-home'
import { createReadLayer } from './_read-resilience'
import { createChannelShare, appDataTopic, makeAppDataListener, takeRealtimeDropStat } from './_realtime-share'
import { realtimeClientOptions, registerRealtimeClient, onRealtimeReauth, holdFittingToken } from './_realtime-options'
import { readLiveTransport } from './_live-transport'
import { createLiveBroadcast } from './_live-broadcast'
import { showReadLimitNotice, hideReadLimitNotice } from './_read-notice'
import { unsubscribeHandle } from './_unsubscribe'
import { showWriteLimitNotice } from './_write-notice'
import { absorbSessionRenewal } from './_session-expiry'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { onIdentityCacheClear } from './_identity-cache'
import { LIST_DEFAULT_LIMIT } from './_list-limit'
import { insertShape, upsertShape, updateShape, groupIdArg, readShape, groupByAgg, expectArg, batchOpShape } from './_call-shape'
import { setCachedReadsDropper } from './_live-refresh'
import { hasUnsignedPrivateFile, inOrderWithFileLinks } from './_private-files'
import { includeOf, createLinkedMarks } from './_include'
import { notSavedYet } from './_hold-codes'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID
// Every data call — reads, writes, each selectAll page — carries this deadline
// (L2 pass, 2026-09-27). A stalled request used to hang the caller for as long
// as the browser cared to wait; past it the call throws code TIMEOUT with no
// status, which the outbox reads as "the server never answered → queue it".
const DATA_TIMEOUT_MS = 30_000

// reqInit: internal per-call fetch options (share.whatsappOrder passes
// { keepalive: true } so its save survives the WhatsApp navigation).
async function _rawApiCall(action, params, reqInit) {
  // Realtime drop counters ride along on an ordinary request (see
  // _realtime-share.js): empty on virtually every call, so no extra request and
  // nothing charged to the owner. Never let telemetry break a data call.
  let headers = getHeaders()
  try {
    const rtStat = takeRealtimeDropStat()
    if (rtStat) headers = { ...headers, 'X-Whacka-RT': rtStat }
  } catch { /* observation must never break a read or a write */ }
  try {
    const live = takeLiveTransportReport()
    if (live) headers = { ...headers, 'X-Whacka-Live': live }
  } catch { /* same: observation only */ }

  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/data`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, ...params }),
    ...(reqInit && reqInit.keepalive ? { keepalive: true } : {}),
  }, { timeoutMs: DATA_TIMEOUT_MS, route: 'data' })

  // Sliding session: the server answers a near-expiry (or grace) token with a
  // fresh one — store it so an active device never signs out (_session-expiry.js).
  absorbSessionRenewal(res)

  if (!res.ok) {
    // One error contract for the whole SDK (_errors.js): .message = the server's
    // sentence, .status (lets the read-resilience layer detect a 429), .code (the
    // server's — e.g. QUOTA_EXCEEDED rides a 429, so the outbox can tell a
    // capacity ceiling from a per-minute rate limit; derived from the status
    // when the body carries none), .route, .body. It also reloads into the lock
    // screen when the owner enabled the private gate (or rotated the code)
    // mid-session, and reports a 5xx to app health.
    await throwFromResponse(res, 'Data request failed', 'data')
  }

  // The server flags a read that hit PostgREST's silent 1000-row cap. Surfacing it
  // here turns a silent under-count (sum/length over a truncated array) into a loud
  // warning. Aggregate with countShared/sumShared/groupByShared, or fetch the full
  // set with selectAll/selectAllShared — never reduce over a capped result.
  const truncated = res.headers.get('X-Whacka-Data-Truncated')
  if (truncated) {
    console.warn(
      `[Whacka] db.${action}('${params?.collection ?? ''}') returned ${truncated} rows — the server caps a single read at 1000 and there are MORE. ` +
      `Computing totals/counts on this array will UNDER-report. Use db.countShared/sumShared/avgShared/groupByShared for stats, or db.selectAll/db.selectAllShared for the complete set.`,
    )
  }

  return res.json()
}

// ── Read resilience (coalescing + micro-cache + rate-limit breaker) ──────────
// Reads route through a shared layer that (1) coalesces concurrent identical reads,
// (2) serves a 1.5s micro-cache for repeat reads (mount fan-out / realtime bursts),
// and (3) — critically — on a 429 enters a global exponential-backoff cooldown that
// serves the last-known-good value instead of hammering the network. (3) stops a
// hand-rolled app retry loop from amplifying a rate-limit into a request storm, and
// keeps the UI populated instead of blanking on a 429. Full rationale + the
// cutecat1 case live in _read-resilience.js.
const _READ_ACTIONS = new Set([
  'select', 'selectShared', 'get', 'getShared', 'search', 'searchShared',
  'count', 'countShared', 'sum', 'sumShared', 'avg', 'avgShared',
  'groupBy', 'groupByShared', 'history',
])
// The 429 ports render the platform's own "usage limit reached, nothing is lost"
// strip: 99.6% of app call sites drop the hook's `error`, so without this the
// platform's refusal reads as an empty list (a store app, 2026-07-26). Statically
// imported on purpose — a dynamically-loaded chunk would have to be fetched at
// the exact moment the app is already failing. The notice module touches no DOM
// at module scope, so it is inert until armed.
// Keys are scoped by the identity the read was made as (L2 pass): a sign-in on
// a shared device never sees the previous visitor's rows from the micro-cache
// or, on a 429, from last-good; sign-out forgets that identity's entries.
function _cacheIdentity() {
  try { return getAppUserId() } catch { return null }
}
const _readLayer = createReadLayer({
  rawCall: _rawApiCall,
  identity: _cacheIdentity,
  onRateLimited: (info) => showReadLimitNotice(info),
  onRecovered: () => hideReadLimitNotice(),
})
onIdentityCacheClear((uid) => _readLayer.forget(uid))
// The live hooks drop a collection's cached reads before a re-read a change
// notice asked for, those that started by the notice (_live-refresh.js,
// delivery ledger P38).
setCachedReadsDropper((collection, noticeAt) => _readLayer.invalidate(collection, noticeAt))

// A read's include brings the rows its rows point to (_include.js): what it brought is
// marked, so a row written back whole never stores a copy of them.
const _linked = createLinkedMarks()

/** The read's params with its include (sent only when one is asked), and the marks on what comes back. */
async function _readWith(action, params, collection, options) {
  const include = includeOf(options)
  if (include) params.include = include
  const res = await apiCall(action, params)
  return include ? _linked.mark(res, collection, include) : res
}

// A condition (`expect`, W2-C) is for a shared row that exists. Anywhere else it
// would be dropped without a word — so the call says so instead of writing unguarded.
function _noExpect(method, options) {
  if (expectArg(options) === undefined) return
  const e = new Error(`db.${method} takes no "expect": a condition is for a shared row that exists — db.updateShared, db.incrementShared, db.deleteShared, or a write inside db.batch.`)
  e.code = 'BAD_REQUEST'
  throw e
}

async function apiCall(action, params, reqInit) {
  if (_READ_ACTIONS.has(action)) return _readLayer.read(action, params)
  // Writes (and any non-read action) run normally, then invalidate only the
  // affected collection's cached reads (other collections stay cached).
  let result
  try {
    result = await _rawApiCall(action, params, reqInit)
  } catch (e) {
    // Platform refusal (429 rate/day limit): say so in the shell's own voice —
    // apps almost never render write errors, so a refused save otherwise looks
    // like a message that silently vanished (a store app, 2026-07-28).
    // QUOTA_EXCEEDED (capacity ceiling, e.g. dbRows) gets its own wording: the
    // wall is permanent until the owner acts, so no "try again in a moment" —
    // and the owner-alert pipeline has already told the owner (2026-08-05).
    // A secret check and the guess brake (SECRET_ATTEMPTS) are not saves: the
    // app's own sign-in screen says "try again in a minute" (P15 review). Nor is
    // the live transport asking for its topics: it asks again by itself.
    if (e && e.status === 429 && e.code !== 'SECRET_ATTEMPTS' && action !== 'checkSecret' && action !== 'readSecret' && action !== 'liveChannels') {
      showWriteLimitNotice({ kind: e.code === 'QUOTA_EXCEEDED' ? 'saveFull' : 'save' })
    }
    // A move kept this save out and sdkFetch's own tries ran out (_hold-codes.js): the same
    // honest line, unless the caller queues it after all (the outbox calls e.queued, and it
    // does so before this timer can fire: nothing but promises lies between the two).
    if (e && e.status === 503 && notSavedYet(e.code) && action !== 'checkSecret' && action !== 'readSecret' && action !== 'liveChannels') {
      const notice = setTimeout(() => showWriteLimitNotice({ kind: 'saveBusy' }), 0)
      e.queued = () => clearTimeout(notice)
    }
    throw e
  }
  _readLayer.invalidate(params && params.collection)
  return result
}

// selectAll / selectAllShared: fetch the complete matching set by paging on a
// stable (createdAt, id) keyset cursor server-side. Every page — including the
// first, via the epoch sentinel — runs the same fixed order, so concurrent
// inserts can't make pages skip or duplicate rows (the failure mode of OFFSET
// loops over tie-heavy created_at ordering). Bounded: past `max` rows the call
// throws instead of silently degrading — at that size the app should aggregate
// (count/sum/avg/groupBy) or filter, not load everything.
const _SELECT_ALL_PAGE = 1000
const _SELECT_ALL_MAX = 20000
async function _selectAllLoop(action, tableName, filters, options) {
  const max = (options && options.max) || _SELECT_ALL_MAX
  const out = []
  let after = { createdAt: '1970-01-01T00:00:00.000Z', id: '' }
  for (;;) {
    const res = await _readWith(action, {
      collection: tableName,
      filters,
      limit: _SELECT_ALL_PAGE,
      after,
    }, tableName, options)
    // Keyset responses are an envelope { rows, nextCursor }. The cursor MUST
    // come from the server's column values: a row's own data.createdAt /
    // data.id override the columns in the returned objects (by design), so a
    // cursor read off the rows would be app-controlled and could skip or
    // duplicate rows. The bare-array guard is a terminator for any legacy
    // server shape — return what we have rather than loop on a bad cursor.
    const page = Array.isArray(res) ? res : (res && res.rows) || []
    out.push(...page)
    if (out.length > max) {
      throw new Error(
        `db.${action === 'select' ? 'selectAll' : 'selectAllShared'}('${tableName}') exceeded ${max} rows. ` +
        `A collection this large should use server aggregates (count/sum/avg/groupBy) or filters, not a full load.`,
      )
    }
    const next = Array.isArray(res) ? null : res && res.nextCursor
    if (page.length < _SELECT_ALL_PAGE || !next) return out
    after = next
  }
}

// groupBy: the request in its old words, and only what a call adds on top — two terms, a
// date bucket, min / max, a page — so an old call sends the same bytes. Past 1,000 groups a
// call is paged on the server (one answer up to 20,000 groups); a paged answer says where
// the next page starts (.next).
const _GROUPS_MAX = 20000
const _isDateTerm = (t) => !!t && typeof t === 'object' && !Array.isArray(t) && ('day' in t || 'week' in t || 'month' in t)
function _deviceTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}
async function _groupBy(action, tableName, groupField, options) {
  const opts = options || {}
  const params = {
    collection: tableName,
    groupField,
    agg: groupByAgg(opts.agg),
    field: opts.field,
    filters: opts.filters || {},
    order: opts.order,
    limit: opts.limit,
  }
  if (opts.offset !== undefined) params.offset = opts.offset
  else if (typeof opts.limit === 'number' && opts.limit > 1000) params.offset = 0
  const dated = Array.isArray(groupField) ? groupField.some(_isDateTerm) : _isDateTerm(groupField)
  if (dated || opts.tz !== undefined) params.tz = opts.tz || _deviceTimeZone()
  if (opts.weekStart !== undefined) params.weekStart = opts.weekStart
  const res = await apiCall(action, params)
  if (params.offset === undefined || !Array.isArray(res)) return res
  const limit = Math.min(Math.max(Math.floor(typeof opts.limit === 'number' ? opts.limit : 100), 1), _GROUPS_MAX)
  const groups = res.slice()
  groups.next = res.length >= limit ? params.offset + res.length : null
  return groups
}

// ─────────────────────────────────────────────
// Supabase client — lazy-loaded, realtime only
// ─────────────────────────────────────────────
//
// Realtime needs setAuth(jwt) BEFORE any subscribe, otherwise RLS sees the
// anon role and the subscriber misses every visibility=group event. We can't
// make subscribe() itself async (existing AI-generated code depends on the
// sync return shape), so the pattern is:
//   1. subscribe() returns a defer-stub immediately
//   2. internally we await getRealtimeClient() which awaits the token fetch
//   3. once the client is auth'd, we attach the real listener and route
//      unsubscribe() through to the actual channel cleanup

// One client per Realtime this page talks to (cells M2b): the app's cell names it in
// its liveChannels answer (_realtime-home.js); the database-stream path (a 'pg'
// bundle — only ever stamped where public channels exist) keeps the bundle's own.
const _realtimeClients = new Map() // homeKey → Promise<client|null>

function realtimeClientFor(home) {
  const k = homeKey(home)
  if (_realtimeClients.has(k)) return _realtimeClients.get(k)
  if (!home || !home.url || !home.publishableKey) {
    console.warn('[db] Supabase not configured — realtime disabled')
    const none = Promise.resolve(null)
    _realtimeClients.set(k, none)
    return none
  }
  const p = (async () => {
    const client = createClient(home.url, home.publishableKey, realtimeClientOptions(home))
    // Re-authenticated on every sign-in / sign-out / team login for the rest of
    // the page (auth.js → reauthRealtimeClients), so RLS follows the identity.
    registerRealtimeClient(client, home)
    const token = home.kid ? await getRealtimeTokenFor(home) : await getSupabaseToken()
    if (token) {
      try { await client.realtime.setAuth(token) }
      catch (e) { console.warn('[db] setAuth failed, falling back to anon context:', e) }
    }
    return client
  })()
  _realtimeClients.set(k, p)
  return p
}

// The database-stream path's client: the bundle's own Realtime, or the page's home
// once an answer named one (a broadcast-pg page falling back joins where it already is).
function getRealtimeClient() {
  return realtimeClientFor(pageRealtimeHome() || bundleRealtimeHome())
}

// ONE physical realtime channel per project (topic `${PROJECT_ID}:app_data`),
// shared by every subscribe()/subscribeShared() regardless of collection, and
// retained for the page lifetime once created — see _realtime-share.js for
// the why (a channel per collection duplicates the full project change stream
// once per collection; tearing down at zero subscribers races supabase-js's
// same-topic channel reuse and can silently kill realtime until reload).
const _joinSharedChannel = createChannelShare('[db]')

// ── Transport (L5 broadcast, 2026-09-30; no fallback since S2, 2026-10-31) ──
// A bundle built with VITE_WHACKA_LIVE=broadcast listens on private Realtime
// topics the server posts to after every successful write (one join per page,
// _live-broadcast.js) instead of the database change stream above, which made
// the database evaluate the visibility policy once per online subscriber for
// every change. Same callbacks, same event shapes. If the topics cannot be
// joined the page keeps its data and rejoins (re-reading when it is back); it
// never moves to the database stream. Only a bundle stamped 'broadcast-pg' (the
// rollback) still moves. What happened rides the next data call as
// X-Whacka-Live: bc · wait:<reason> · rf:<kind> · rh:<kind> · er:<first word of the
// answer> · cl:<kind> · fb:<reason>, comma-joined. Bundles without the stamp are 'pg'.
const LIVE_TRANSPORT = readLiveTransport(import.meta.env)
let _liveTransport = LIVE_TRANSPORT === 'pg' ? 'pg' : 'broadcast' // a broadcast-pg page whose join failed moves to 'pg'
let _liveBroadcast = null
const _liveReports = [] // codes sent once on the next data call
const _liveSubs = new Set() // active broadcast subscriptions, re-joined on the database stream on a broadcast-pg fallback

function liveCode(prefix, value) {
  return prefix + ':' + String(value || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)
}

function addLiveReport(code) {
  if (!_liveReports.includes(code) && _liveReports.length < 6) _liveReports.push(code)
}

function takeLiveTransportReport() {
  if (_liveReports.length === 0) return null
  const r = _liveReports.join(',')
  _liveReports.length = 0
  return r
}

function _joinPg(client, listener) {
  const name = appDataTopic(PROJECT_ID)
  return _joinSharedChannel(client, name, (fanout) =>
    client.channel(name).on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'app_data', filter: `project_id=eq.${PROJECT_ID}` },
      fanout,
    ),
  listener)
}

function _getLiveBroadcast() {
  if (_liveBroadcast) return _liveBroadcast
  _liveBroadcast = createLiveBroadcast({
    // The first answer names the app's cell's Realtime (cells M2b); in the global
    // project it is the URL and key this bundle already carries.
    getClient: (answer) => realtimeClientFor(noteRealtimeAnswer(answer)),
    pgFallback: LIVE_TRANSPORT === 'broadcast-pg',
    fetchTopics: async () => {
      // '*' satisfies the route's "collection is required" contract; the action reads no collection.
      const r = await apiCall('liveChannels', { collection: '*' })
      return r && typeof r === 'object' ? { topics: Array.isArray(r.topics) ? r.topics : [], realtime: r.realtime } : { topics: [] }
    },
    // A cell page joins only with a token that cell trusts — never the public key —
    // and the client that joins holds it.
    canJoin: async (client) => ((await holdFittingToken(client)) ? null : 'notoken'),
    // A join refused for its token: one fresh token from the app's cell, then again.
    onTokenRefused: async () => {
      const home = pageRealtimeHome() || bundleRealtimeHome()
      const fresh = await replaceRefusedToken(home)
      if (!fresh) return false
      const client = await realtimeClientFor(home)
      if (!client) return false
      try { await client.realtime.setAuth(fresh) } catch { return false }
      return true
    },
  })
  _liveBroadcast.onLive(() => { addLiveReport('bc') })
  // The reason rides along (wait:TIMED_OUT, wait:CHANNEL_ERROR, wait:topics …) so the
  // server can count what kept pages waiting, not only that they did.
  _liveBroadcast.onWait((reason) => { addLiveReport(liveCode('wait', reason)) })
  _liveBroadcast.onRefused((kind) => { addLiveReport(liveCode('rf', kind)) })
  _liveBroadcast.onHealed((kind) => { addLiveReport(liveCode('rh', kind)) })
  _liveBroadcast.onJoinFailed((word) => { addLiveReport(liveCode('er', word)) })
  _liveBroadcast.onClosed((kind) => { addLiveReport(liveCode('cl', kind)) })
  // The app moved to another cell (cells M2b): offer the refresh that lands the page there.
  // The app moved (cells M4): the refresh pill, and the next answer takes this page's list updates to the new cell by itself.
  _liveBroadcast.onMoved(() => { notePageMoved(); void _liveBroadcast.refresh() })
  _liveBroadcast.onFallback((reason) => {
    console.warn(`[db] live broadcast unavailable (${reason}); using the database change stream`)
    _liveTransport = 'pg'
    addLiveReport(liveCode('fb', reason))
    for (const sub of [..._liveSubs]) sub.fallback()
  })
  onRealtimeReauth(() => { if (_liveBroadcast) void _liveBroadcast.refresh() })
  return _liveBroadcast
}

// Shared body of subscribe()/subscribeShared(): the defer-stub dance (sync
// return shape, client awaited internally) with a per-flavor listener.
// resolveOpts runs AFTER the client is ready; db.subscribe's identity is read
// per event (makeAppDataListener), never captured here.
function _subscribeAppData(tableName, resolveOpts, callback, readAction) {
  let stopped = false
  const cleanups = []
  const sub = { fallback: () => {} }

  ;(async () => {
    // A broadcast page's client comes from its first topics answer (the app's cell);
    // only the database-stream path needs one before that.
    const broadcast = _liveTransport === 'broadcast'
    const client = broadcast ? null : await getRealtimeClient()
    if (stopped || (!broadcast && !client)) return

    const listener = makeAppDataListener(tableName, resolveOpts(), callback)
    // The database stream hands a row over as stored: a private file in it
    // still has its stable address, which opens for no one. Such a row is read
    // again through the server, which hands back working links; events keep
    // their order (_private-files.js). Broadcast rows come with links already.
    const pgListener = makeAppDataListener(tableName, resolveOpts(), inOrderWithFileLinks(
      callback,
      (ev) => !!ev && ev.type !== 'DELETE' && hasUnsignedPrivateFile(ev.data),
      async (ev) => {
        const row = await _rawApiCall(readAction, { collection: tableName, id: ev.data.id })
        return row && typeof row === 'object' ? { ...ev, data: row } : null
      },
    ))
    const joinPg = (client) => { cleanups.push(_joinPg(client, pgListener)) }
    if (broadcast) {
      cleanups.push(_getLiveBroadcast().subscribe(listener))
      // broadcast-pg bundles only (the rollback): move to the database stream.
      sub.fallback = () => {
        if (stopped) return
        void getRealtimeClient().then((c) => { if (!stopped && c) joinPg(c) })
      }
      _liveSubs.add(sub)
    } else {
      joinPg(client)
    }
    if (stopped) { for (const c of cleanups.splice(0)) c() }
  })()

  // A function that also carries .unsubscribe — generated code spells the
  // cleanup both ways (_unsubscribe.js).
  return unsubscribeHandle(() => {
    stopped = true
    _liveSubs.delete(sub)
    for (const c of cleanups.splice(0)) c()
  })
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export const db = {
  /**
   * Insert data. Optionally pass a custom id (string) as the third argument;
   * if omitted, a UUID is auto-generated. Pass options.expiresAt (ISO date) to
   * make the record self-delete after that timestamp.
   *
   * @example await db.insert('transactions', { amount: 100 })
   * @example await db.insert('settings', { theme: 'dark' }, 'user-settings')
   * @example await db.insert('codes', { value: 'X' }, undefined, { expiresAt: '2026-05-01T00:00:00Z' })
   */
  async insert(tableName, data, id, options) {
    const shaped = insertShape(data, id, options)
    data = shaped.data; id = shaped.id; options = shaped.options
    _noExpect('insert', options)
    const params = { collection: tableName, data: _linked.strip(tableName, data) }
    if (id !== undefined) params.id = id
    if (options?.expiresAt) params.expiresAt = options.expiresAt
    return apiCall('insert', params)
  },

  /**
   * Bulk-insert an array of records in ONE request — use instead of a loop of
   * db.insert (a loop is N round-trips and can hit the rate limit). Ideal for
   * importing parsed data, e.g. ai.run({ json: true }) → db.insertMany.
   * options.idField — name of a field on each row to use as its stable id; makes
   *   re-import idempotent (re-running REPLACES your existing rows with that id
   *   instead of duplicating). Omit to append with auto-generated ids.
   * options.expiresAt — ISO date; all inserted rows self-delete after it.
   * Returns the inserted records ([{ id, ...fields }]). Max 500 rows per call.
   * @example
   *   const { json: students } = await ai.run("Return [{name, grade}]", { csvs: [url], json: true })
   *   if (students) await db.insertMany('students', students, { idField: 'name' })
   */
  async insertMany(tableName, rows, options) {
    _noExpect('insertMany', options)
    const params = { collection: tableName, rows: Array.isArray(rows) ? rows.map((r) => _linked.strip(tableName, r)) : rows }
    if (options?.idField) params.idField = options.idField
    if (options?.expiresAt) params.expiresAt = options.expiresAt
    return apiCall('insertMany', params)
  },

  /**
   * Query data. Filters support comparison operators pushed down to the database,
   * so you NEVER need to fetch every row and filter in JS (which silently drops
   * data past the ~1000-row read cap). A bare value means equality; an object
   * value means operators: gte / gt / lte / lt / ne / in / between.
   *   { status: 'paid' }                          // equality (unchanged)
   *   { amount: { gte: 100 } }                    // amount >= 100
   *   { createdAt: { gte: '2026-06-01', lt: '2026-07-01' } }  // date range (AND)
   *   { category: { in: ['food', 'rent'] } }      // set membership
   *   { score: { between: [10, 20] } }            // inclusive range
   * Same grammar on count / sum / avg / groupBy and their *Shared variants.
   * @example const list = await db.select('transactions', { type: 'income' })
   * @example const recent = await db.select('orders', { date: { gte: monthStart } })
   * @example const page = await db.select('transactions', {}, { limit: 20, offset: 40 })
   */
  async select(tableName, filters = {}, options) {
    const shaped = readShape(filters, options)
    filters = shaped.filters; options = shaped.options || {}
    return _readWith('select', {
      collection: tableName,
      filters,
      limit: options.limit ?? LIST_DEFAULT_LIMIT,
      order: options.order,
      offset: options.offset,
    }, tableName, options)
  },

  /**
   * Get a single record by ID, returns the object or null.
   * options.include — the rows its fields point to, as on select.
   * @example const txn = await db.get('transactions', 'uuid-123')
   */
  async get(tableName, id, options) {
    return _readWith('get', { collection: tableName, id }, tableName, options)
  },

  /**
   * Update data — SHALLOW merge (nested objects are replaced wholesale).
   * To update one field of a nested object, pass the full updated object.
   * @example await db.update('transactions', 'uuid-123', { amount: 200 })
   */
  async update(tableName, id, data, options) {
    const shaped = updateShape(id, data)
    id = shaped.id; data = shaped.data
    _noExpect('update', options)
    return apiCall('update', { collection: tableName, id, data: _linked.strip(tableName, data) })
  },

  /**
   * Delete data; resolves false when no row matched.
   * @example await db.delete('transactions', 'uuid-123')
   */
  async delete(tableName, id, options) {
    _noExpect('delete', options)
    const res = await apiCall('delete', { collection: tableName, id })
    return !(res && res.deleted === false)
  },

  /**
   * Insert or update (upsert) a record by custom id.
   * Pass options.expiresAt only when creating; ignored when updating an existing row.
   * @example await db.upsert('settings', { theme: 'dark' }, 'user-settings')
   * @example await db.upsert('session', { token: 't' }, 'current', { expiresAt: in15Min })
   */
  async upsert(tableName, data, id, options) {
    const shaped = upsertShape(data, id)
    data = shaped.data; id = shaped.id
    if (shaped.options && options === undefined) options = shaped.options
    _noExpect('upsert', options)
    if (!id) throw new Error('db.upsert() requires an id')
    const params = { collection: tableName, data: _linked.strip(tableName, data), id }
    if (options?.expiresAt) params.expiresAt = options.expiresAt
    return apiCall('upsert', params)
  },

  // ─────────────────────────────────────────────
  // Shared data (cross-user) — for social features, feeds, public content
  // ─────────────────────────────────────────────

  /**
   * Insert shared data. Adds _createdBy automatically.
   *
   * options.groupId — bind the row to a social group. Group admins/owners
   *   can then edit/delete it, even if they're not the creator.
   *
   * options.visibleTo — controls who can READ the row (server-enforced).
   *   'public'                  — anyone can read, signed-out visitors included.
   *   (omitted)                 — this app's default, as its build instructions say:
   *                               public in older apps; in newer ones the writer and
   *                               the app's admins, like 'creator-and-admin'. Pass
   *                               visibleTo whenever who reads the row matters.
   *   'group'                   — symmetric: all members of options.groupId read.
   *                               Requires the caller to be signed in and a member.
   *   'creator-and-admin'       — asymmetric: the creator sees their own row;
   *                               admins/owners of options.groupId see all rows.
   *                               Submitters need not be members. Use for "user
   *                               submits to a service" patterns.
   *   'role:<name>'             — only members of options.groupId whose role is
   *                               exactly <name> can read, plus admins of the same
   *                               group. Use when rows are partitioned by role
   *                               within a group.
   *   'user:<userId>'           — only the named target user can read, plus admins
   *                               of options.groupId. Use when an admin assigns a
   *                               row to one specific user (task assignments, shift
   *                               schedules, private routed records). The target can
   *                               also update/delete it (write scope follows read
   *                               scope); where they must only read, lock it with
   *                               writableFields or a src/rules.json entry.
   *
   * @example await db.insertShared('posts', { title: 'Hello' })  // public
   * @example await db.insertShared('rooms', { name: 'Game' }, 'room-1', { expiresAt: in1Hour })
   * @example await db.insertShared('rosters', data, undefined, { groupId, visibleTo: 'group' })
   * @example await db.insertShared('finance', row, undefined, { groupId, visibleTo: 'role:accountant' })
   * @example await db.insertShared('shifts', row, undefined, { groupId, visibleTo: `user:${employeeId}` })
   */
  async insertShared(tableName, data, id, options) {
    const shaped = insertShape(data, id, options)
    data = shaped.data; id = shaped.id; options = shaped.options
    _noExpect('insertShared', options)
    const params = { collection: tableName, data: _linked.strip(tableName, data) }
    if (id !== undefined) params.id = id
    if (options?.expiresAt) params.expiresAt = options.expiresAt
    if (options?.groupId) params.groupId = options.groupId
    if (options?.visibleTo) params.visibleTo = options.visibleTo
    // writableBy controls who may UPDATE/DELETE after creation (separate from visibleTo reads):
    //   'admins'      tamper-proof — only group admins write, creator locked out (approvals)
    //   'members'     creator + any group member write the same row (shared operational records)
    //   'role:<name>' creator + members holding <name> (+ admins) write
    //   'user:<uuid>' creator + that one named user write (e.g. a request the addressee accepts)
    //   'anyone'      open participation — every caller edits; delete stays creator/admins
    // admins/members/role need a groupId; user/anyone do not.
    if (options?.writableBy) params.writableBy = options.writableBy
    // writableFields: ['status', 'read'] — policy-granted writers (writableBy /
    // membership, NOT the creator/admins/owner) may change ONLY these fields.
    if (options?.writableFields) params.writableFields = options.writableFields
    // options.keepalive (internal — share.whatsappOrder): the request survives
    // a same-gesture navigation. Never sent to the server.
    return apiCall('insertShared', params, options?.keepalive ? { keepalive: true } : undefined)
  },

  /**
   * Bulk-insert an array of SHARED records in ONE request (cross-user). Same
   * visibleTo / groupId / writableBy options as insertShared, applied to every
   * row in the batch. Use for importing shared content (a catalog, a roster).
   * options.idField — stable-id field; makes re-import idempotent: your rows with
   *   those ids are replaced, and a row someone else created is updated in place
   *   when you may change it (it keeps its creator, readers and group); otherwise
   *   nothing is imported. Needs an identified caller.
   * Returns the records. Max 500 rows per call.
   * @example await db.insertManyShared('catalog', items, { groupId, idField: 'sku' })
   */
  async insertManyShared(tableName, rows, options) {
    _noExpect('insertManyShared', options)
    const params = { collection: tableName, rows: Array.isArray(rows) ? rows.map((r) => _linked.strip(tableName, r)) : rows }
    // updateOthers: this SDK may update rows someone else created (ledger P55);
    // the server keeps the old rule for bundles that do not say so.
    if (options?.idField) { params.idField = options.idField; params.updateOthers = true }
    if (options?.expiresAt) params.expiresAt = options.expiresAt
    if (options?.groupId) params.groupId = options.groupId
    if (options?.visibleTo) params.visibleTo = options.visibleTo
    if (options?.writableBy) params.writableBy = options.writableBy
    if (options?.writableFields) params.writableFields = options.writableFields
    return apiCall('insertManyShared', params)
  },

  /**
   * Query shared data across all users. Filters take the same operator grammar
   * as db.select (gte/gt/lte/lt/ne/in/between) — bound server-side, so a date or
   * amount range never needs a fetch-all-then-filter.
   * @example const posts = await db.selectShared('posts')
   * @example const open = await db.selectShared('orders', { status: { in: ['new','paid'] } })
   */
  async selectShared(tableName, filters = {}, options) {
    const shaped = readShape(filters, options)
    filters = shaped.filters; options = shaped.options || {}
    return _readWith('selectShared', {
      collection: tableName,
      filters,
      limit: options.limit ?? LIST_DEFAULT_LIMIT,
      order: options.order,
      offset: options.offset,
    }, tableName, options)
  },

  /**
   * Fetch EVERY matching row of a private collection, safely paged server-side
   * (a single select returns at most 1000 rows). Returns rows in creation order.
   * For totals/stats prefer count/sum/avg/groupBy — exact at any size without
   * transferring rows. Throws past options.max (default 20000): a collection
   * that large should be aggregated or filtered, not fully loaded.
   * @example const all = await db.selectAll('transactions', { type: 'income' })
   */
  async selectAll(tableName, filters = {}, options) {
    const shaped = readShape(filters, options)
    return _selectAllLoop('select', tableName, shaped.filters, shaped.options || {})
  },

  /**
   * Shared-scope variant of selectAll: every visible row, safely paged.
   * @example const catalog = await db.selectAllShared('products')
   */
  async selectAllShared(tableName, filters = {}, options) {
    const shaped = readShape(filters, options)
    return _selectAllLoop('selectShared', tableName, shaped.filters, shaped.options || {})
  },

  /**
   * Get a single shared record by ID, returns the object or null.
   * @example const post = await db.getShared('posts', 'uuid-123')
   */
  async getShared(tableName, id, options) {
    return _readWith('getShared', { collection: tableName, id }, tableName, options)
  },

  /**
   * A shared row's change history, newest first: every create, change, delete and
   * restore, recorded by the platform for a collection whose src/rules.json entry
   * says "history": true — whoever made it (the app, the builder's chat, the owner's
   * Data page, automation); no call changes or deletes an entry. Read by whoever
   * can read the row; the app owner reads every entry.
   * Each entry: { seq, at, op: 'create' | 'update' | 'delete' | 'restore',
   *   by: { via: 'app' | 'chat' | 'console' | 'automation' | 'platform', id?, device?, self? },
   *   changes: { field: { from, to } }, audience? } — no `from` / `to` = the field was not there;
   *   by.id is a signed-in person's (a visitor is { device: true }); a value over 4 KB reads
   *   as { $omitted: <bytes> }; audience = who could read the row before / after, when it moved.
   * options.limit: 1–100 (default 50). Older entries: { before: entries.next } (null at the end).
   * @example const entries = await db.history('leave_requests', id)
   */
  async history(tableName, id, options) {
    const opts = options || {}
    const params = { collection: tableName, id }
    if (opts.limit !== undefined) params.limit = opts.limit
    if (opts.before !== undefined && opts.before !== null) params.before = opts.before
    const res = await apiCall('history', params)
    const entries = res && Array.isArray(res.entries) ? res.entries.slice() : []
    entries.next = res && typeof res.next === 'string' ? res.next : null
    return entries
  },

  /**
   * Update shared data — SHALLOW merge. Pass groupId to allow group members to edit.
   * options.expect — write only while the row still meets it (the rules' condition
   *   words: { status: 'pending' }, { qty: { gte: 1 } }, null = empty / absent);
   *   otherwise it throws code 'EXPECT_FAILED' and writes nothing.
   * @example await db.updateShared('posts', 'uuid-123', { title: 'Updated' })
   * @example await db.updateShared('products', 'item-1', { qty: 5 }, groupId)
   * @example await db.updateShared('slots', slotId, { takenBy: me }, { expect: { takenBy: null } })
   */
  async updateShared(tableName, id, data, groupIdOrOptions, options) {
    const shaped = updateShape(id, data)
    id = shaped.id; data = shaped.data
    const groupId = groupIdArg(groupIdOrOptions)
    const params = { collection: tableName, id, data: _linked.strip(tableName, data) }
    if (groupId) params.groupId = groupId
    // { expect } in the options — or after a bare group id, as upsertShared's (groupId, options).
    const expect = expectArg(groupIdOrOptions) ?? expectArg(options)
    if (expect !== undefined) params.expect = expect
    return apiCall('updateShared', params)
  },

  /**
   * Delete shared data; resolves false when no row matched. Pass groupId to allow group members to delete.
   * options.expect — delete only while the row still meets it (else 'EXPECT_FAILED').
   * @example await db.deleteShared('posts', 'uuid-123')
   */
  async deleteShared(tableName, id, groupIdOrOptions, options) {
    const groupId = groupIdArg(groupIdOrOptions)
    const params = { collection: tableName, id }
    if (groupId) params.groupId = groupId
    const expect = expectArg(groupIdOrOptions) ?? expectArg(options)
    if (expect !== undefined) params.expect = expect
    const res = await apiCall('deleteShared', params)
    return !(res && res.deleted === false)
  },

  /**
   * Several shared writes at once: all of them happen, or none does. Up to 20;
   * each is the single call's own request — { action: 'insertShared' |
   * 'updateShared' | 'incrementShared' | 'deleteShared', collection, id, data,
   * field, by, groupId, visibleTo, writableBy, writableFields, expiresAt, expect }.
   * Every write is judged as its single call is (the app's src/rules.json, the
   * row's own writableBy); one refused, one row not as its `expect` says, or one
   * row to change that is not there → it throws (err.body.index = which write)
   * and nothing is written. Each row at most once per batch.
   * Resolves to each write's answer, in order (a delete: { ok, deleted }).
   * @example
   *   await db.batch([
   *     { action: 'updateShared', collection: 'requests', id, data: { status: 'approved' }, expect: { status: 'manager_ok' } },
   *     { action: 'incrementShared', collection: 'balances', id: employeeId, field: 'days', by: -days },
   *   ])
   */
  async batch(ops) {
    const list = Array.isArray(ops)
      ? ops.map(batchOpShape).map((op) => (op && typeof op === 'object' && op.data && typeof op.collection === 'string'
        ? (() => { const data = _linked.strip(op.collection, op.data); return data === op.data ? op : { ...op, data } })()
        : op))
      : ops
    const res = await apiCall('batch', { collection: '*', ops: list })
    // The writes landed: drop the cached reads of every collection they touched.
    if (Array.isArray(list)) for (const op of list) if (op && typeof op.collection === 'string') _readLayer.invalidate(op.collection)
    return res && Array.isArray(res.results) ? res.results : res
  },

  // ── Secrets the server checks (never stored in the row) ──
  // A password, PIN or code the app compares itself has to sit in a row the
  // phone can read, which means anyone can read it. These four keep the value
  // on the server: the app's own code box stays exactly as it is; people who
  // sign in are Teams logins (team.js).

  /**
   * Store a secret for a shared row or one of the caller's own. The server
   * keeps it and compares it; no read ever returns it. Resolves false when there
   * is no such row.
   * Replacing one needs the old value (the app owner, or the caller on their own
   * row, may skip it); { ownerCanRead: true } lets the owner read it back later.
   * The value comes from a screen, never from the app's code.
   * @example await db.setSecret('config', 'backoffice', 'code', typedByOwner)
   * @example await db.setSecret('config', 'backoffice', 'code', next, { current: old })
   */
  async setSecret(tableName, id, secret, value, options) {
    const opts = options || {}
    const params = { collection: tableName, id, secret, value }
    if (opts.current !== undefined) params.current = opts.current
    if (opts.ownerCanRead) params.ownerCanRead = true
    if (opts.groupId) params.groupId = opts.groupId
    const res = await apiCall('setSecret', params)
    return !!(res && res.set)
  },

  /**
   * Compare a secret the server stored: the row (without the secret) when it
   * matches, null when it does not. A wrong value, an unknown row and a name
   * that was never set all answer null. Too many wrong tries throw
   * SECRET_ATTEMPTS: show "try again in a minute".
   * @example const result = await db.checkSecret('results', { number }, 'code', typed)
   * @example const ok = await db.checkSecret('config', 'admin', 'code', typed)
   */
  async checkSecret(tableName, where, secret, value) {
    return apiCall('checkSecret', { collection: tableName, where, secret, value })
  },

  /**
   * Read a secret back — the app owner only (auth.isAppOwner), and only one
   * stored with { ownerCanRead: true }. Resolves null otherwise.
   * @example const code = await db.readSecret('config', 'backoffice', 'code')
   */
  async readSecret(tableName, id, secret) {
    const res = await apiCall('readSecret', { collection: tableName, id, secret })
    return res && res.value != null ? res.value : null
  },

  /**
   * Remove a secret: the app owner, or whoever passes the current value.
   * Resolves true for the one call that removed it (a redeem code used up).
   * @example await db.clearSecret('cards', serial, 'code', { current: typed })
   */
  async clearSecret(tableName, id, secret, options) {
    const opts = options || {}
    const params = { collection: tableName, id, secret }
    if (opts.current !== undefined) params.current = opts.current
    const res = await apiCall('clearSecret', params)
    return !!(res && res.cleared)
  },

  /**
   * Insert or update (upsert) a shared record. Takes the SAME options object as
   * insertShared as the 4th argument ({ groupId, visibleTo, writableBy,
   * writableFields, expiresAt }); create-time options apply on create only —
   * an existing row keeps its visibility and group (move rows with data_migrate).
   * @example await db.upsertShared('config', { open: true }, 'site-config')
   * @example await db.upsertShared('team-cfg', data, 'c1', { groupId, visibleTo: 'group' })
   * @example await db.upsertShared('clients', row, phone, { groupId, visibleTo: 'creator-and-admin', writableBy: 'admins' })
   */
  async upsertShared(tableName, data, id, groupIdOrOptions, legacyOptions) {
    const shaped = upsertShape(data, id)
    data = shaped.data; id = shaped.id
    if (shaped.options && groupIdOrOptions === undefined) groupIdOrOptions = shaped.options
    _noExpect('upsertShared', groupIdOrOptions)
    _noExpect('upsertShared', legacyOptions)
    if (!id) throw new Error('db.upsertShared() requires an id')
    // Historical signature was (table, data, id, groupId, options) while every
    // sibling (insertShared & co) takes options as the 4th arg — generated code
    // reasonably passed { groupId, ... } here and the whole object landed in
    // params.groupId, 400-ing every call ("groupId must be a string"; 104 apps
    // in the wild, slotwise booking form a total loss — 0713 audit). Accept
    // BOTH shapes: an object 4th arg is options; a string 4th arg is the
    // legacy bare groupId (with options 5th).
    const opts = (groupIdOrOptions && typeof groupIdOrOptions === 'object') ? groupIdOrOptions : (legacyOptions || {})
    const groupId = typeof groupIdOrOptions === 'string' && groupIdOrOptions ? groupIdOrOptions : opts.groupId
    const params = { collection: tableName, data: _linked.strip(tableName, data), id }
    if (groupId) params.groupId = groupId
    if (opts.expiresAt) params.expiresAt = opts.expiresAt
    if (opts.visibleTo) params.visibleTo = opts.visibleTo
    if (opts.writableBy) params.writableBy = opts.writableBy
    if (opts.writableFields) params.writableFields = opts.writableFields
    return apiCall('upsertShared', params)
  },

  // ─────────────────────────────────────────────
  // Aggregations — server-side, scale to millions of rows
  // ─────────────────────────────────────────────

  /**
   * Count records matching filters. Filters take the operator grammar
   * (gte/gt/lte/lt/ne/in/between) — count "this month" or "amount >= X" in the
   * database, never by reading rows and counting in JS.
   * @example const total = await db.count('expenses')
   * @example const open = await db.count('tasks', { status: 'open' })
   * @example const big = await db.count('orders', { total: { gte: 100 } })
   */
  async count(tableName, filters = {}) {
    filters = readShape(filters).filters
    const { count } = await apiCall('count', { collection: tableName, filters })
    return count
  },

  async countShared(tableName, filters = {}) {
    filters = readShape(filters).filters
    const { count } = await apiCall('countShared', { collection: tableName, filters })
    return count
  },

  /**
   * Sum a numeric field across matching records. Field path supports nested via dot.
   * Filters take the operator grammar (gte/gt/lte/lt/ne/in/between), so a bounded
   * total like "this month's revenue" is exact at any size — no fetch-all.
   * @example const spent = await db.sum('expenses', 'amount', { month: '2026-04' })
   * @example const mtd = await db.sum('orders', 'total', { date: { gte: monthStart }, status: 'paid' })
   * @example const totalKg = await db.sum('weighIns', 'weight.kg')
   */
  async sum(tableName, field, filters = {}) {
    filters = readShape(filters).filters
    const { value } = await apiCall('sum', { collection: tableName, field, filters })
    return value
  },

  async sumShared(tableName, field, filters = {}) {
    filters = readShape(filters).filters
    const { value } = await apiCall('sumShared', { collection: tableName, field, filters })
    return value
  },

  /**
   * Average a numeric field across matching records.
   * @example const avgScore = await db.avg('runs', 'score')
   */
  async avg(tableName, field, filters = {}) {
    filters = readShape(filters).filters
    const { value } = await apiCall('avg', { collection: tableName, field, filters })
    return value
  },

  async avgShared(tableName, field, filters = {}) {
    filters = readShape(filters).filters
    const { value } = await apiCall('avgShared', { collection: tableName, field, filters })
    return value
  },

  /**
   * Group records by a field, returning [{ key, count, value? }].
   * groupField: 'field' · { day | week | month: 'dateField' } (the day 'YYYY-MM-DD', the
   *   week's first day, the month 'YYYY-MM', in the device's time zone) · a list of two
   *   of them → key: [first, second].
   * options.agg: 'sum' | 'avg' | 'min' | 'max' (requires options.field; min / max compare
   *   numbers as numbers, text as text — the latest ISO date is its max)
   * options.order: '-count' (default) | 'count' | '-value' | 'value' | 'key' | '-key'
   * options.limit: max buckets (default 100, up to 20000); options.offset: buckets to skip —
   *   a paged call's answer carries .next, the offset of the next page (null when there is none)
   * options.filters: equality OR operator filters (gte/gt/lte/lt/ne/in/between)
   * options.tz (a time zone name) / options.weekStart (0 Sunday … 6 Saturday, default 1 Monday): for day / week / month
   *
   * @example await db.groupBy('expenses', 'category')
   *   // → [{ key: 'food', count: 23 }, { key: 'rent', count: 1 }, ...]
   * @example await db.groupBy('expenses', 'category', { agg: 'sum', field: 'amount' })
   *   // → [{ key: 'food', count: 23, value: 412.5 }, ...]
   * @example await db.groupBy('orders', 'category', { agg: 'sum', field: 'total', filters: { date: { gte: monthStart } } })
   * @example await db.groupBy('timesheets', ['staffId', { month: 'date' }], { agg: 'sum', field: 'hours' })
   *   // → [{ key: ['s1', '2026-11'], count: 12, value: 86 }, ...]
   */
  async groupBy(tableName, groupField, options = {}) {
    return _groupBy('groupBy', tableName, groupField, options)
  },

  async groupByShared(tableName, groupField, options = {}) {
    return _groupBy('groupByShared', tableName, groupField, options)
  },

  // ─────────────────────────────────────────────
  // Text search — case-insensitive substring match
  // ─────────────────────────────────────────────

  /**
   * Substring search across record JSON values. Case-insensitive (ILIKE).
   * options.fields: array of field paths to restrict the search
   * options.limit, options.offset, options.order: same as select()
   *
   * @example const hits = await db.search('notes', 'birthday')
   * @example const hits = await db.search('products', 'red shoes', { fields: ['name', 'description'] })
   */
  async search(tableName, query, options = {}) {
    return apiCall('search', {
      collection: tableName,
      query,
      fields: options.fields,
      limit: options.limit,
      offset: options.offset,
      order: options.order,
    })
  },

  async searchShared(tableName, query, options = {}) {
    return apiCall('searchShared', {
      collection: tableName,
      query,
      fields: options.fields,
      limit: options.limit,
      offset: options.offset,
      order: options.order,
    })
  },

  // ─────────────────────────────────────────────
  // Atomic counters — race-safe increment/decrement
  // ─────────────────────────────────────────────

  /**
   * Atomically add `by` to a numeric field. Missing field is treated as 0;
   * a missing row is not created (resolves null, writes nothing).
   * For decrement, pass a negative number.
   * @example await db.increment('posts', postId, 'likes')          // +1
   * @example await db.increment('inventory', sku, 'qty', -1)       // -1
   */
  async increment(tableName, id, field, by = 1, options) {
    _noExpect('increment', by)
    _noExpect('increment', options)
    return apiCall('increment', { collection: tableName, id, field, by })
  },

  /**
   * Atomic increment on a shared record (a missing row is not created:
   * resolves null, writes nothing). Permission follows READ access:
   * if the caller can see the row, they can bump a numeric field on it.
   * This is intentionally more permissive than updateShared — supports
   * "anyone can like / view-count" patterns without client-side bypass.
   * options.expect — only while the row still meets it (else 'EXPECT_FAILED').
   * @example await db.incrementShared('post-stats', postId, 'views')
   * @example await db.incrementShared('post-stats', postId, 'likes', 1)
   * @example await db.incrementShared('events', id, 'seatsLeft', -1, { expect: { status: 'open' } })
   */
  async incrementShared(tableName, id, field, by = 1, options) {
    // { expect } written where `by` goes (incrementShared(coll, id, field, { expect })): read as meant, by 1.
    if (expectArg(by) !== undefined && options === undefined) { options = by; by = typeof options.by === 'number' ? options.by : 1 }
    const params = { collection: tableName, id, field, by }
    const expect = expectArg(options)
    if (expect !== undefined) params.expect = expect
    return apiCall('incrementShared', params)
  },

  /**
   * Retrofit legacy shared rows (created before group existed) into a group.
   * Only the ORIGINAL creator of each row can migrate it. Rows with different
   * creators are skipped and returned in `results` with `ok: false`.
   * After migration the row's _groupId is set, so group admins can edit it.
   *
   * options.visibleTo also flips visibility on each migrated row. Accepts 'public',
   * 'group', or 'role:<name>'. (creator-and-admin can't be set in bulk — it relies on
   * per-row creator identity; insert new rows with that visibility instead.)
   *
   * @param {string} tableName
   * @param {string[]} ids - doc_ids of the shared rows to migrate
   * @param {string} groupId - target group to bind these rows to
   * @param {object} [options]
   * @param {'public'|'group'|string} [options.visibleTo] - 'public' | 'group' | 'role:<name>'
   * @returns {Promise<{ results: Array<{ id: string, ok: boolean, reason?: string }> }>}
   * @example await db.migrateSharedToGroup('clubs', ['club-a', 'club-b'], clubAGroupId)
   * @example await db.migrateSharedToGroup('rosters', oldIds, classGroupId, { visibleTo: 'group' })
   */
  async migrateSharedToGroup(tableName, ids, groupId, options) {
    const params = { collection: tableName, ids, groupId }
    if (options?.visibleTo) params.visibleTo = options.visibleTo
    return apiCall('migrateSharedToGroup', params)
  },

  // ─────────────────────────────────────────────
  // Real-time subscriptions (Supabase Realtime, read-only)
  // ─────────────────────────────────────────────

  /**
   * Subscribe to real-time updates for user-scoped data.
   * @example
   * const sub = db.subscribe('tasks', (event) => {
   *   console.log(event.type, event.data)  // type: 'INSERT' | 'UPDATE' | 'DELETE'
   * })
   * sub.unsubscribe()
   */
  subscribe(tableName, callback) {
    // Whose rows count as "mine" is read per event, not once at subscribe: a
    // sign-in without a reload otherwise kept filtering for the previous
    // person and dropped every event of the new one's own rows (P11).
    return _subscribeAppData(tableName, () => ({ userId: _cacheIdentity }), callback, 'get')
  },

  /**
   * Subscribe to real-time updates for shared (cross-user) data.
   * @example
   * const sub = db.subscribeShared('posts', (event) => {
   *   if (event.type === 'INSERT') addPost(event.data)
   * })
   */
  subscribeShared(tableName, callback) {
    return _subscribeAppData(tableName, () => ({ sharedOnly: true }), callback, 'getShared')
  },
}
