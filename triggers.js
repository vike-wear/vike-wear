/**
 * Data-event triggers — run a server-side action the MOMENT a row changes, even
 * while the app is closed. The event-driven sibling of `schedule` (which fires on
 * a clock): triggers fire on the DATA event.
 *
 *   "When a row in collection X is inserted/updated and matches a condition →
 *    send a push or email, write a row, recompute an aggregate, or change a
 *    row that exists (update / increment)."
 *
 * The action is composed from the row that just changed ({{field}} templates pull
 * from it). Triggers run as the app owner; only the signed-in owner can manage
 * them. Limits: the active-trigger limit is set by the owner's plan (TRIGGER_LIMIT
 * on the 429); email recipients count against the owner plan's daily ceiling.
 *
 * Failures throw the SDK's standard Error: .message = the server's sentence,
 * .status, .code — BAD_REQUEST, INVALID_ACTION, OWNER_REQUIRED, TRIGGER_LIMIT,
 * QUOTA_EXCEEDED, RATE_LIMITED …; TIMEOUT / NETWORK carry no status.
 *
 * Use this for "the moment it happens" reactions (new order lands, stock crosses
 * below a threshold, a request is marked approved). For a fixed CLOCK time (daily
 * digest, expiry reminder N days out) use `schedule` instead — a daily scan, not
 * an event.
 */

import { getHeaders } from './_headers'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { absorbSessionRenewal } from './_session-expiry'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID

async function request(method, path, body) {
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/triggers${path}`, {
    method,
    headers: getHeaders(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, { route: 'triggers' })
  absorbSessionRenewal(res)
  if (!res.ok) await throwFromResponse(res, 'Request failed', 'triggers')
  return res.json().catch(() => ({}))
}

export const triggers = {
  /**
   * Create a data-event trigger.
   *
   * @param {object} options
   * @param {string} options.collection - The collection whose writes to watch.
   * @param {Array<'insert'|'update'>} options.on - Events to fire on. `update`
   *   fires on the RISING EDGE (a row crossing INTO the condition) and so requires
   *   `when`; `insert` fires for every new matching row.
   * @param {object} [options.when] - Condition the row must match: `{ field: value }`
   *   (equality) or `{ field: { gt|gte|lt|lte|ne|in|between: value } }`, ANDed.
   *   Required for `update`; optional for `insert`-only.
   * @param {'push'|'email'|'insert'|'aggregate'|'update'|'increment'} options.action
   *   ...plus the action fields inline (same shape as `schedule`, but templates
   *   render from the CHANGED ROW):
   *   - push: { title, body, url?, target: { userId } | { broadcast: true } |
   *            { groupId, role? } | { rowOwner: true } }   (rowOwner = the person
   *            the changed row belongs to)
   *   - email: { to: ['a@b.com'] | { field }, subject, body }   ({ field } reads the
   *            recipient address off the changed row)
   *   - insert: { collection, data, shared?, docId? }   (string values {{field}}-filled)
   *   - aggregate: { op: 'count'|'sum'|'avg'|'groupBy', collection, field?, shared?,
   *                  target: { collection, docId? } }
   *   - update: { data, target? }   merge data into the changed row, or into the
   *             shared row target: { collection, id: '{{field}}' } names. A whole
   *             '{{field}}' keeps its value's type; '$now' = the server's time.
   *   - increment: { field, by, target? }   by = a number or '{{field}}' / '-{{field}}'.
   *             update / increment change shared rows only; the app's src/rules.json
   *             holds for them (freeze, bounds, stamps — not its "who" rules); a row
   *             they could not change is the trigger's lastError.
   * @returns {Promise<{ id: string, collection: string, events: string[], action: string }>}
   *
   * @example
   * // The moment a new order lands, notify the manager:
   * await triggers.create({
   *   collection: 'orders',
   *   on: ['insert'],
   *   action: 'push',
   *   title: 'New order', body: 'New order from {{customer}} — {{total}}',
   *   target: { broadcast: true },
   * })
   *
   * @example
   * // Alert when a product's stock crosses below 10 (fires once on the edge):
   * await triggers.create({
   *   collection: 'products',
   *   on: ['update'],
   *   when: { stock: { lt: 10 } },
   *   action: 'push',
   *   title: 'Low stock', body: '{{name}} is down to {{stock}}',
   *   target: { broadcast: true },
   * })
   *
   * @example
   * // Email the customer when their order is marked shipped:
   * await triggers.create({
   *   collection: 'orders',
   *   on: ['update'],
   *   when: { status: 'shipped' },
   *   action: 'email',
   *   to: { field: 'email' },
   *   subject: 'Your order shipped', body: 'Hi {{customer}}, order {{id}} is on its way.',
   * })
   *
   * @example
   * // The moment a request is approved, take its days off the employee's balance:
   * await triggers.create({
   *   collection: 'leave_requests',
   *   on: ['update'],
   *   when: { status: 'approved' },
   *   action: 'increment',
   *   target: { collection: 'leave_balances', id: '{{employeeId}}' },
   *   field: 'days', by: '-{{days}}',
   * })
   */
  async create(options) {
    const { collection, on, when, action, ...rest } = options || {}
    if (!collection) throw new Error('triggers.create: "collection" is required')
    if (!on) throw new Error("triggers.create: \"on\" is required (e.g. on: ['insert'] or ['update'])")
    if (!action) throw new Error("triggers.create: \"action\" is required ('push' | 'email' | 'insert' | 'aggregate' | 'update' | 'increment')")
    console.log('[triggers] Creating', action, 'on', collection, Array.isArray(on) ? on.join(',') : on)
    return request('POST', '', { collection, events: on, condition: when ?? null, action, config: rest })
  },

  /**
   * List this app's triggers (owner only).
   * @returns {Promise<Array<{ id, collection, on, when, action, config, status, fireCount, lastFiredAt, lastError }>>}
   * @example const list = await triggers.list()
   */
  async list() {
    return request('GET', '')
  },

  /**
   * Remove a trigger (owner only).
   * @param {string} id - The id returned by triggers.create()
   * @returns {Promise<{ ok: boolean }>}
   * @example await triggers.remove(t.id)
   */
  async remove(id) {
    if (!id) throw new Error('triggers.remove: "id" is required')
    console.log('[triggers] Removing', String(id).substring(0, 8))
    return request('DELETE', `?id=${encodeURIComponent(id)}`)
  },
}

export default triggers
