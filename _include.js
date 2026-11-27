/**
 * A read that brings the records its rows point to — the client half (data
 * research step 3, 2026-11-04; the server half is src/lib/data/include.ts, the
 * record docs/claude-md/data-reads.md).
 *
 *   db.selectShared('orders', {}, { include: { customer: { from: 'customers', by: 'customerId' } } })
 *   → each order with `customer`: the customers row its customerId names (null when
 *     there is none the caller may read); a `by` that holds a list of ids brings a list.
 *
 * Three things live here, all pure (no imports, so node tests load the file as is):
 *  - includeOf: the include an options object asks for (nothing else is ever sent);
 *  - a live list's linked collections and the ids it shows from each, so a change to
 *    a brought row re-reads the list — a brought row never goes stale on screen;
 *  - the marks on brought rows: a row written back with what its read brought
 *    (`db.updateShared('orders', o.id, { ...o, status })`, an edit form seeded from
 *    a read row) leaves the brought row out, so no copy of it is ever stored by
 *    accident. Copying it into another collection or field is the code's own choice
 *    and is sent as written.
 */

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** The include an options object asks for: a non-empty plain object, else undefined. */
export function includeOf(options) {
  const inc = options && options.include
  return isPlainObject(inc) && Object.keys(inc).length ? inc : undefined
}

/** The collections a live list's include reads, once each: [{ collection, shared }] (the list's own left out). */
export function linkedCollections(include, own, ownShared) {
  const out = []
  const seen = new Set()
  if (!isPlainObject(include)) return out
  for (const spec of Object.values(include)) {
    if (!isPlainObject(spec) || typeof spec.from !== 'string' || !spec.from) continue
    const shared = typeof spec.shared === 'boolean' ? spec.shared : !!ownShared
    const key = (shared ? 's:' : 'p:') + spec.from
    if (seen.has(key) || (spec.from === own && shared === !!ownShared)) continue
    seen.add(key)
    out.push({ collection: spec.from, shared })
  }
  return out
}

function valueAt(row, path) {
  if (!row || typeof row !== 'object') return undefined
  if (Object.prototype.hasOwnProperty.call(row, path)) return row[path]
  let cur = row
  for (const part of String(path).split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

const asId = (v) => (typeof v === 'string' ? (v === '' ? null : v) : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)

/** The ids a list's rows point to, per linked collection: Map(collection → Set(id)). */
export function linkedIds(rows, include) {
  const out = new Map()
  if (!Array.isArray(rows) || !isPlainObject(include)) return out
  for (const spec of Object.values(include)) {
    if (!isPlainObject(spec) || typeof spec.from !== 'string' || typeof spec.by !== 'string') continue
    let ids = out.get(spec.from)
    if (!ids) { ids = new Set(); out.set(spec.from, ids) }
    for (const row of rows) {
      const v = valueAt(row, spec.by)
      for (const x of Array.isArray(v) ? v : [v]) { const id = asId(x); if (id !== null) ids.add(id) }
    }
  }
  return out
}

/**
 * Does a change to a linked collection touch what the list shows? A change to a
 * row it points to (one created after the list read it too: a link to a row not
 * there yet); a delete or a bulk notice always (a delete may carry the row id
 * where the list holds the row's own id).
 */
export function linkedChangeMatters(ev, ids) {
  if (!ev || ev.type === 'DELETE' || ev.type === 'REFRESH') return true
  const id = ev.data ? asId(ev.data.id) : null
  if (id === null) return true
  return !!ids && ids.has(id)
}

/** Marks on the brought rows of one page (db.js holds one for the page's life). */
export function createLinkedMarks() {
  const marks = new WeakMap() // a brought row or list → { collection, as }

  /** Note what a read with this include brought (rows, a keyset envelope or one row); returns the result. */
  function mark(result, collection, include) {
    if (!isPlainObject(include)) return result
    const names = Object.keys(include)
    const rows = Array.isArray(result) ? result : result && Array.isArray(result.rows) ? result.rows : result ? [result] : []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      for (const as of names) {
        const v = row[as]
        if (v && typeof v === 'object') marks.set(v, { collection, as })
      }
    }
    return result
  }

  /** A row about to be written to `collection`, without what a read of that collection brought on it. */
  function strip(collection, data) {
    if (!isPlainObject(data)) return data
    let out = null
    for (const k of Object.keys(data)) {
      const v = data[k]
      const m = v && typeof v === 'object' ? marks.get(v) : undefined
      if (m && m.collection === collection && m.as === k) {
        if (!out) out = { ...data }
        delete out[k]
      }
    }
    return out || data
  }

  return { mark, strip }
}
