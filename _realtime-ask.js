/**
 * Ask the app's cell where its Realtime is (cells M2b, 2026-11-02) — for chat,
 * presence and payment pokes on a page whose live data has not asked yet (db.js gets
 * the answer with its topics). One small request per page: the data route's
 * liveChannels with homeOnly (no topics, no membership read). A server from before
 * M2b answers without `realtime`, and the page keeps its bundle's own.
 */
import { getHeaders } from './_headers.js'
import { sdkFetch } from './_fetch.js'
import { askRealtimeHome } from './_realtime-home.js'

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}
const API_BASE = ENV.VITE_API_BASE || ''
const PROJECT_ID = ENV.VITE_PROJECT_ID
const HOME_TIMEOUT_MS = 15_000

export function appRealtimeHome() {
  return askRealtimeHome(async () => {
    const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/data`, {
      method: 'POST',
      headers: getHeaders(),
      // '*' satisfies the route's "collection is required" contract; the action reads no collection.
      body: JSON.stringify({ action: 'liveChannels', collection: '*', homeOnly: true }),
    }, { timeoutMs: HOME_TIMEOUT_MS, route: 'data' })
    if (!res.ok) throw new Error(`liveChannels ${res.status}`)
    return res.json()
  })
}
