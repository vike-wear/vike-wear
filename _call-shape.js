// ─────────────────────────────────────────────
// Call shapes the data SDK reads as meant (delivery ledger P30, 2026-10-20)
// ─────────────────────────────────────────────
// The db methods are siblings with different shapes: insertShared takes
// (collection, data, id, options), updateShared (collection, id, data, groupId),
// outbox.insertShared (collection, data, options), the live hooks
// (collection, { filters, limit, order }) and db.select (collection, filters,
// options). Generated code reaches for a sibling's shape, and the call then
// failed on the server (400) or read nothing at all:
//   db.insertShared('orders', row, { groupId })                → "id must be a string"
//   db.updateShared('orders', id, patch, { groupId })          → "groupId must be a string"
//   db.upsertShared('cfg', 'main', { open: true })             → "id must be a string"
//   db.selectShared('ledger', { filters: { userId }, limit })  → [] (filters on a field named "filters")
//   db.groupByShared('orders', 'status', { agg: 'count' })     → "agg must be "sum" or "avg""
// Each shape below is one that fails or reads nothing today, so nothing that
// works changes. Pure functions: no IO.

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
}

function isIdLike(v) {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
}

/** insert / insertShared: (data, id, options) as written → as meant. */
export function insertShape(data, id, options) {
  // (collection, id, data): the id and the row swapped
  if (isIdLike(data) && isPlainObject(id)) return { data: id, id: data, options }
  // (collection, data, options): the options where the id goes, no id
  if (isPlainObject(data) && isPlainObject(id) && options === undefined) return { data, id: undefined, options: id }
  return { data, id, options }
}

/** outbox.insert / insertShared: (data, options) — or db's (data, id, options), which
 *  outbox.js once called "exactly like db.insertShared". The one shape here that did
 *  not fail: the row was written with the id as its options, so with no read scope and
 *  no write policy (delivery ledger P95, 2026-10-25: 8 calls in 3 apps). Options in the
 *  third place, or no fourth argument, are used exactly as before. */
export function outboxOptions(third, fourth) {
  if (isPlainObject(third) || fourth === undefined) return third
  return isPlainObject(fourth) ? fourth : third
}

/** upsert / upsertShared: (data, id) as written → as meant; the id may sit in the row itself. */
export function upsertShape(data, id) {
  if (isIdLike(data) && isPlainObject(id)) return { data: id, id: data, options: undefined }
  if (isPlainObject(data) && isPlainObject(id)) {
    // (collection, data, options) — the options where the id goes
    return { data, id: isIdLike(data.id) ? data.id : undefined, options: id }
  }
  if ((id === undefined || id === null || id === '') && isPlainObject(data) && isIdLike(data.id) && data.id !== '') {
    return { data, id: data.id, options: undefined }
  }
  return { data, id, options: undefined }
}

/** update / updateShared: (id, data) as written → as meant. */
export function updateShape(id, data) {
  if (isPlainObject(id) && isIdLike(data)) return { id: data, data: id }
  return { id, data }
}

/** updateShared / deleteShared take the group id itself; an options object carrying one is read for it. */
export function groupIdArg(groupId) {
  if (isPlainObject(groupId)) return typeof groupId.groupId === 'string' ? groupId.groupId : undefined
  return groupId
}

/** A write's condition (W2-C): `{ expect }` in its options object; undefined when there is none. */
export function expectArg(options) {
  return isPlainObject(options) ? options.expect : undefined
}

const BATCH_OPTION_KEYS = ['groupId', 'visibleTo', 'writableBy', 'writableFields', 'expiresAt', 'expect']

/**
 * db.batch: a write with the options object its method takes
 * ({ action, collection, data, options: { groupId } }) — the server refuses
 * `options` on a write, so its fields are read onto the write itself, never
 * over one the write sets. Any other write is sent exactly as it came.
 */
export function batchOpShape(op) {
  if (!isPlainObject(op) || !isPlainObject(op.options)) return op
  const { options, ...rest } = op
  if (!Object.keys(options).every((k) => BATCH_OPTION_KEYS.includes(k))) return op
  for (const k of BATCH_OPTION_KEYS) if (options[k] !== undefined && rest[k] === undefined) rest[k] = options[k]
  return rest
}

const READ_OPTION_KEYS = ['limit', 'order', 'offset', 'include']

/**
 * select / selectShared / selectAll* / count / sum / avg: the live hooks' object
 * ({ filters, limit, order, offset }) handed over where the filters go. Read as
 * meant only when every key is one of those words and `filters` is there or
 * `limit` is a number — `{ order: 3 }` alone stays a filter on a field named order.
 */
export function readShape(filters, options) {
  if (options !== undefined || !isPlainObject(filters)) return { filters, options }
  const keys = Object.keys(filters)
  if (!keys.length || !keys.every((k) => k === 'filters' || READ_OPTION_KEYS.includes(k))) return { filters, options }
  const hasFilters = 'filters' in filters && (filters.filters === undefined || isPlainObject(filters.filters))
  const hasLimit = typeof filters.limit === 'number'
  if (!hasFilters && !hasLimit) return { filters, options }
  const opts = {}
  for (const k of READ_OPTION_KEYS) if (filters[k] !== undefined) opts[k] = filters[k]
  return { filters: filters.filters || {}, options: opts }
}

/** groupBy: agg 'count' is what every bucket already carries. */
export function groupByAgg(agg) {
  return agg === 'count' ? undefined : agg
}
