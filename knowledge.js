/**
 * Knowledge base — semantic retrieval over a text corpus.
 *
 * Use this for any body of reference text (> 2KB total) the app searches by
 * meaning rather than exact match: course / lesson content, personal notes
 * and journal entries, FAQ / support docs, product catalogs, character lore,
 * reference material. Records are embedded once at write time and retrieved
 * by cosine similarity at search time.
 *
 * DO NOT use for:
 *   - Structured rows (users, orders, todos) — use db.insert
 *   - Small personas / system prompts (< 500 chars) — keep them in code
 *   - Private per-user data in a multi-tenant app — use db with owner_id
 *     (knowledge is project-scoped, not user-isolated)
 *
 * Namespaces must be English alphanumeric kebab-case (e.g. 'course-algebra',
 * 'user-journal', 'support-kb'). Names with no ASCII letters (written entirely
 * in CJK, Arabic, Cyrillic, etc.) are rejected — use an English slug even when
 * the content inside is non-English.
 *
 * Failures throw the SDK's standard Error: .message = the server's sentence,
 * .status, .code — BAD_REQUEST (namespace / record shape), QUOTA_EXCEEDED
 * (records ceiling), CREDITS_EXHAUSTED, DAILY_LIMIT, RATE_LIMITED, PROVIDER_ERROR …;
 * TIMEOUT / NETWORK carry no status (the server never answered).
 */

import { fetchWithCreditRetry } from './_rate-limit'
import { getHeaders } from './_headers'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { absorbSessionRenewal } from './_session-expiry'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID
// upsert embeds up to 100 records in one call.
const UPSERT_TIMEOUT_MS = 120_000

async function call(path, body, { timeoutMs } = {}) {
  // fetchWithCreditRetry: shared 429 handling (modal + throw) + one retry
  // after an anonymous visitor signs in from the credits prompt. getHeaders()
  // runs per attempt, so the retry carries the fresh signed-in identity.
  const route = `knowledge/${path}`
  const res = await fetchWithCreditRetry(() => sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/knowledge/${path}`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  }, { timeoutMs, route }))
  absorbSessionRenewal(res)
  if (!res.ok) await throwFromResponse(res, `knowledge ${path} failed`, route)
  return res.json()
}

export const knowledge = {
  /**
   * Insert or update records in a namespace. Records are embedded on write
   * and become searchable immediately. Idempotent by record id — passing the
   * same id updates the existing record in place.
   *
   * @param {string} namespace - Lowercase English kebab-case group name
   * @param {Array<{id?: string, text: string, meta?: object}>} records - Up to 100 per call
   * @returns {Promise<{namespace: string, total: number, skipped: Array<{index: number, reason: string}>}>}
   * @example
   *   // Tutor — course content
   *   await knowledge.upsert('course-algebra', [
   *     { id: 'variables',  text: 'A variable is a symbol...' },
   *     { id: 'linear-eqns', text: 'A linear equation has the form ax + b = c...' },
   *   ])
   *
   *   // Notebook app — a user's journal entry
   *   await knowledge.upsert('user-journal', [
   *     { text: 'Today I realised...', meta: { date: '2026-04-24' } },
   *   ])
   *
   *   // Support bot — ingest an updated article
   *   await knowledge.upsert('support-kb', [
   *     { id: 'refund-policy', text: 'Refunds are processed within...' },
   *   ])
   */
  async upsert(namespace, records) {
    return call('upsert', { namespace, records }, { timeoutMs: UPSERT_TIMEOUT_MS })
  },

  /**
   * Semantic top-k search within a namespace. Returns records ranked by
   * cosine similarity; server-side min_score 0.5 drops low-confidence noise.
   *
   * TUNING: the default minScore (0.5) is right for factual Q&A shapes
   * (tutor, FAQ, reference) where queries and records share shape. For
   * CHARACTER / ROLEPLAY CHAT apps, where users ask "you"-style questions
   * of named-entity records, top scores drop to 0.3-0.4 — pass
   * `minScore: 0.3` or retrieval will return empty. Same for cross-
   * language (query in one language, records in another).
   *
   * @param {string} namespace
   * @param {string} query - Free-form text, typically the user's current message
   * @param {{k?: number, minScore?: number}} [options] - k defaults to 5, max 20; minScore default 0.5
   * @returns {Promise<{namespace: string, results: Array<{record_id: string, text: string, score: number, meta: object}>}>}
   * @example
   *   // One-shot Q&A (NotebookLM / tutor / FAQ pattern)
   *   const { results } = await knowledge.search('course-algebra', question, { k: 4 })
   *   if (results.length === 0) return "I don't have material on that."
   *   const context = results.map(r => r.text).join('\n\n')
   *   const { text } = await ai.run(
   *     `Answer using ONLY the context below.\n\nCONTEXT:\n${context}\n\nQUESTION: ${question}`
   *   )
   *
   *   // Chat with persistent persona (character / support agent)
   *   const { results } = await knowledge.search('support-kb', userMessage, { k: 3 })
   *   const ctx = results.length ? '\n\nDocs:\n' + results.map(r => r.text).join('\n\n') : ''
   *   const reply = await ai.chat({ system: PERSONA.system + ctx, messages })
   */
  async search(namespace, query, options = {}) {
    return call('search', {
      namespace,
      query,
      k: options.k,
      minScore: options.minScore,
    })
  },

  /**
   * Delete records by id list, or wipe the whole namespace with { all: true }.
   *
   * @param {string} namespace
   * @param {string[] | {all: true}} idsOrAll
   * @returns {Promise<{namespace: string, removed: number}>}
   * @example
   *   await knowledge.remove('course-algebra', ['variables'])
   *   await knowledge.remove('course-algebra', { all: true })
   */
  async remove(namespace, idsOrAll) {
    if (idsOrAll && typeof idsOrAll === 'object' && idsOrAll.all === true) {
      return call('remove', { namespace, all: true })
    }
    return call('remove', { namespace, ids: idsOrAll })
  },

  /**
   * List records in a namespace, ordered by most recently updated. For
   * admin/debug UIs — not a retrieval call (use search for retrieval).
   *
   * @param {string} namespace
   * @param {{limit?: number, offset?: number}} [options] - limit default 50, max 200
   * @returns {Promise<{namespace: string, records: Array<{record_id: string, text: string, meta: object, created_at: string, updated_at: string}>, total: number}>}
   */
  async list(namespace, options = {}) {
    return call('list', {
      namespace,
      limit: options.limit,
      offset: options.offset,
    })
  },
}
