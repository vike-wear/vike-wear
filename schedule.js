/**
 * Scheduled tasks — make things happen on the server at a future time, even
 * when the app is closed: send a push or email, write a row, compute an
 * aggregate, or change the rows that exist. Schedules survive app/browser
 * restarts; they run server-side.
 *
 * Actions: 'push' | 'email' | 'insert' | 'aggregate' | 'update' | 'increment'.
 * Recurrence: 'daily' | 'weekly' | 'weekdays' | 'weekends' | 'monthly' (via
 * `repeat`; 1 year max by default).
 * Limits: the active-schedule limit is set by the owner's plan (SCHEDULE_LIMIT
 * on the 429); email recipients count against the owner plan's daily ceiling.
 * Email, insert and broadcast/group push schedules can only be created by the
 * signed-in app owner or a team admin; aggregate, update and increment by the app
 * owner only; per-user pushes work for any user.
 *
 * Failures throw the SDK's standard Error: .message = the server's sentence,
 * .status, .code — BAD_REQUEST, INVALID_ACTION, INVALID_REPEAT, OWNER_REQUIRED,
 * SCHEDULE_LIMIT, QUOTA_EXCEEDED, RATE_LIMITED …; TIMEOUT / NETWORK carry no status.
 */

import { getHeaders } from './_headers'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { absorbSessionRenewal } from './_session-expiry'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID

// ─────────────────────────────────────────────
// Time normalization (same contract as push.schedule)
// ─────────────────────────────────────────────

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

// Format an absolute instant as a wall-clock string 'YYYY-MM-DDTHH:MM:SS' in
// the given IANA timezone. en-CA yields the YYYY-MM-DD ordering; hourCycle h23
// avoids rendering midnight as "24".
function wallClockInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (t) => parts.find((p) => p.type === t)?.value
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
}

// Matches an ISO string that carries a zone designator (…Z or …+08:00) — i.e.
// an absolute instant, such as anything produced by Date.prototype.toISOString().
const ABSOLUTE_INSTANT_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/

// Normalises the many ways a caller might express `at` into the wall-clock
// string + timezone the schedule endpoint expects. This is the safeguard that
// makes `at: someDate` and `at: someDate.toISOString()` fire at the SAME
// instant — without it, passing a UTC string fires hours off.
//
//  - Date            → wall-clock in the target timezone
//  - number (epoch)  → wall-clock in the target timezone
//  - ISO with Z/offset (absolute instant) → wall-clock in the target timezone
//  - plain 'YYYY-MM-DDTHH:MM:SS' (no zone) → used as-is (already local)
function normalizeSchedule(at, timezone) {
  const tz = timezone || localTimezone()

  let instant = null
  if (at instanceof Date) {
    instant = at
  } else if (typeof at === 'number') {
    instant = new Date(at)
  } else if (typeof at === 'string') {
    const trimmed = at.trim()
    if (ABSOLUTE_INSTANT_RE.test(trimmed)) {
      const d = new Date(trimmed)
      if (!isNaN(d.getTime())) instant = d
    } else {
      // Already a local wall-clock string — pass through unchanged.
      return { at: trimmed, timezone: tz }
    }
  }

  if (!instant || isNaN(instant.getTime())) {
    throw new Error('schedule.create: "at" must be a Date, epoch ms, or a local "YYYY-MM-DDTHH:MM:SS" string')
  }
  return { at: wallClockInTimezone(instant, tz), timezone: tz }
}

// ─────────────────────────────────────────────
// Recurrence sugar — daily:'21:00' etc. → first wall-clock occurrence
// ─────────────────────────────────────────────

const REPEAT_SUGAR = ['daily', 'weekly', 'weekdays', 'weekends']

function matchesRule(dow, rule) {
  if (rule === 'weekdays') return dow >= 1 && dow <= 5
  if (rule === 'weekends') return dow === 0 || dow === 6
  return true // daily / weekly: any start day
}

// 'HH:MM' (or 'HH:MM:SS') → the next local wall-clock occurrence matching the
// rule: today if that time is still ahead, otherwise the next eligible day.
function firstOccurrence(time, rule, tz) {
  const m = String(time).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) {
    throw new Error(`schedule.create: ${rule} must be a time like '21:00' (got "${time}")`)
  }
  const hhmmss = `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}`
  const nowWall = wallClockInTimezone(new Date(), tz)
  let [y, mo, d] = nowWall.slice(0, 10).split('-').map(Number)
  // Work in UTC midday so date increments never straddle a day boundary.
  const cursor = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0))
  for (let i = 0; i < 8; i++) {
    const datePart = cursor.toISOString().slice(0, 10)
    const candidate = `${datePart}T${hhmmss}`
    if (candidate > nowWall && matchesRule(cursor.getUTCDay(), rule)) return candidate
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  throw new Error('schedule.create: could not resolve a start time')
}

// ─────────────────────────────────────────────
// HTTP helper — throws the SDK's standard Error (.message / .status / .code)
// ─────────────────────────────────────────────

async function request(method, path, body) {
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/schedule${path}`, {
    method,
    headers: getHeaders(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, { route: 'schedule' })
  absorbSessionRenewal(res)
  if (!res.ok) await throwFromResponse(res, 'Request failed', 'schedule')
  return res.json().catch(() => ({}))
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export const schedule = {
  /**
   * Schedule a server-side task. One-shot via `at`, recurring via the sugar
   * keys (`daily: '21:00'`) or `at` + `repeat`. Action fields go inline.
   *
   * Targets for action 'push': `target: { userId }` (any user, themselves) |
   * `{ broadcast: true }` | `{ groupId, role? }` (owner only for those two).
   * Recipients for action 'email': `to: ['a@b.com']` (≤20) or
   * `to: { collection, field }` — resolved fresh at every send.
   *
   * Fresh-content message (push or email): add `source: { collection, filters?,
   * window?: { dateField, days }, sort?, limit? }`. The body is composed from a
   * fire-time scan of CURRENT data (NOT frozen at create time). `filters` picks
   * rows by ANY field — `{ paid: false }`, `{ stock: { lt: 10 } }` — and `window`
   * adds a relative date range. Template with `{{count}}`, `{{#rows}}…{{/rows}}`
   * (per-row `{{field}}`), `{{sum.field}}`/`{{avg.field}}`. Email needs a fixed
   * `to: [...]` list; push uses any target. 0 matches = not sent.
   *
   * @param {object} options
   * @param {Date|number|string} [options.at] - When to fire (Date / epoch ms / local 'YYYY-MM-DDTHH:MM:SS')
   * @param {string} [options.daily] - Sugar: fire every day at 'HH:MM' (local)
   * @param {string} [options.weekly] - Sugar: fire weekly at 'HH:MM', starting today/tomorrow
   * @param {string} [options.weekdays] - Sugar: fire Mon–Fri at 'HH:MM'
   * @param {string} [options.weekends] - Sugar: fire Sat–Sun at 'HH:MM'
   * @param {string} [options.timezone] - IANA timezone (auto-detected if omitted)
   * @param {'daily'|'weekly'|'weekdays'|'weekends'|'monthly'} [options.repeat] - Recurrence (when using `at`; monthly = same day-of-month as `at`, clamped to short months)
   * @param {string[]} [options.repeatExcept] - Skip these weekdays ('sun'..'sat'), e.g. ['fri']
   * @param {string} [options.repeatUntil] - Stop-by datetime; defaults to 1 year
   * @param {'push'|'email'|'insert'|'aggregate'|'update'|'increment'} options.action
   *   update: { source: { collection, filters?, window? }, data } — merged into every
   *   shared row the source matches when it fires; increment: { source, field, by }.
   *   A whole '{{field}}' of each row keeps its type; '$now' = the server's time. The
   *   app's src/rules.json holds (freeze, bounds, stamps — not its "who" rules); the
   *   app owner only.
   * @returns {Promise<{ id: string, fireAt: string, repeat: string|null }>}
   *
   * @example
   * // Date-keyed reminders ("7 days before EACH lease ends") = ONE daily job
   * // with a when-filter — NEVER one job per row (the plan's active-job cap). The collection
   * // is scanned at send time; {{field}} pulls values from each matching row:
   * await schedule.create({
   *   daily: '09:00',
   *   action: 'email',
   *   to: { collection: 'leases', field: 'tenantEmail' },
   *   when: { dateField: 'endDate', inDays: 7 },
   *   subject: 'Lease for {{unitName}} expires {{endDate}}',
   *   body: 'Hi {{tenantName}} — your lease ends on {{endDate}}. Reply to arrange renewal.',
   * })
   *
   * @example
   * // Daily 09:00 summary push to everyone (owner only):
   * await schedule.create({
   *   daily: '09:00',
   *   action: 'push',
   *   title: 'Daily summary',
   *   body: 'Your numbers for today are ready',
   *   target: { broadcast: true },
   * })
   *
   * @example
   * // Nightly stats row the app renders from:
   * await schedule.create({
   *   daily: '23:55',
   *   action: 'aggregate',
   *   op: 'count', collection: 'orders',
   *   target: { collection: 'daily_stats', docId: 'orders-count' },
   * })
   *
   * @example
   * // Fresh manager digest — every morning, ONE email listing the contracts
   * // expiring within 60 days (recomputed each send, owner only):
   * await schedule.create({
   *   daily: '08:00',
   *   action: 'email',
   *   to: ['manager@acme.com'],
   *   source: { collection: 'employees', window: { dateField: 'contractEnd', days: 60 }, sort: { field: 'contractEnd', dir: 'asc' } },
   *   subject: '{{count}} contracts expiring within 60 days',
   *   body: 'Expiring soon:\n{{#rows}}• {{name}} — {{contractEnd}}\n{{/rows}}',
   * })
   *
   * @example
   * // On the 1st of every month each balance gains 1.75 days (owner only;
   * // a series stops after a year unless repeatUntil says later):
   * await schedule.create({
   *   at: '2026-11-01T00:05:00', repeat: 'monthly', repeatUntil: '2031-12-31T23:59:00Z',
   *   action: 'increment',
   *   source: { collection: 'leave_balances' },
   *   field: 'days', by: 1.75,
   * })
   */
  async create(options) {
    const { at, timezone, repeat, repeatExcept, repeatUntil, action, ...rest } = options || {}
    if (!action) {
      throw new Error("schedule.create: \"action\" is required ('push' | 'email' | 'insert' | 'aggregate' | 'update' | 'increment')")
    }

    const tz = timezone || localTimezone()
    let resolvedAt = at
    let resolvedRepeat = repeat
    for (const rule of REPEAT_SUGAR) {
      if (rest[rule] !== undefined) {
        resolvedAt = firstOccurrence(rest[rule], rule, tz)
        resolvedRepeat = rule
        delete rest[rule]
      }
    }
    if (resolvedAt === undefined || resolvedAt === null) {
      throw new Error("schedule.create: provide \"at\" or one of daily/weekly/weekdays/weekends (e.g. daily: '21:00')")
    }

    const norm = normalizeSchedule(resolvedAt, tz)
    console.log('[schedule] Creating', action, 'at', norm.at, norm.timezone, resolvedRepeat ? `repeat=${resolvedRepeat}` : 'one-shot')
    return request('POST', '', {
      at: norm.at,
      timezone: norm.timezone,
      repeat: resolvedRepeat,
      repeatExcept,
      repeatUntil,
      action,
      config: rest, // everything else is the action config
    })
  },

  /**
   * List this app's schedules (active + recently-ended recurring).
   * Owner only.
   * @returns {Promise<Array<{ id, action, config, at, timezone, fireAt, repeat, status, lastError }>>}
   * @example const jobs = await schedule.list()
   */
  async list() {
    return request('GET', '')
  },

  /**
   * Cancel a schedule (stops the whole series for recurring ones).
   * Owner only.
   * @param {string} id - The id returned by schedule.create()
   * @returns {Promise<{ ok: boolean }>}
   * @example await schedule.cancel(job.id)
   */
  async cancel(id) {
    if (!id) throw new Error('schedule.cancel: "id" is required')
    console.log('[schedule] Cancelling', String(id).substring(0, 8))
    return request('DELETE', `?id=${encodeURIComponent(id)}`)
  },
}
