/**
 * Platform-layer read resilience for db.js.
 *
 * Dependency-free, with injectable clock/rng so it is unit-testable in plain node
 * (preview-template is "type":"module", so both Vite and node load this as ESM).
 *
 * Three guards, ordered by how often they fire:
 *   1. In-flight coalescing  — concurrent identical reads share ONE network request.
 *   2. Micro-cache (1.5s)    — repeat reads (mount fan-out / realtime bursts) reuse
 *                              the last result instead of re-hitting the network.
 *   3. Rate-limit breaker    — when the server returns 429, enter a GLOBAL
 *                              exponential-backoff cooldown during which reads are
 *                              served from the last-known-good value WITHOUT touching
 *                              the network.
 *
 * Why (3) exists: generated apps sometimes hand-roll a load()→fail→retry-every-2s
 * loop. Once the per-caller read budget is exhausted (429), that loop turns every
 * retry — across every component and every connected device — into another network
 * read, which keeps the budget pinned and the app stuck (the cutecat1 read-storm,
 * recurred 3×). The micro-cache can't stop it (a 2s retry lands outside the 1.5s
 * window, and failures were never cached). Moving an exponential backoff INTO the
 * platform read path means a naive app loop can no longer amplify into a storm — the
 * brake holds even when the app code is pathological, and survives every publish
 * (db.js is overlaid from the template, the AI can't edit it away). Serving the
 * stale-but-present value during cooldown also keeps the UI populated instead of
 * going blank on a 429 — which was the user-visible symptom.
 *
 * Identity scoping (L2 pass, 2026-09-27): every key — micro-cache, last-good and
 * the persisted store — carries the app-user id the read was made AS (`identity`
 * option; db.js passes getAppUserId). A private `select('notes')` has the same
 * action+params for every visitor of a device, so without the prefix a sign-in
 * on a shared phone could be served the PREVIOUS identity's rows from the
 * micro-cache, and a 429 could show them from last-good for a day. Now another
 * identity never reads them, and forget(uid) (called from auth.signOut through
 * _identity-cache.js) removes them from the device altogether.
 */

const READ_TTL_MS = 1500;
const CACHE_MAX = 200;
const RL_BASE_MS = 4000;   // first cooldown after a 429
const RL_MAX_MS = 60000;   // cooldown cap
const RL_JITTER_MS = 1000; // spread reconnect attempts so 6 devices don't sync up

// Persisted last-good (a store app, 2026-07-26). The in-memory fallback above
// only survives while the tab lives, so the WORST case had no fallback at all:
// staff whose per-day read quota was spent closed the app / reinstalled it (as
// this platform's own troubleshooting advice tells people to do), came back to a
// cold start where the very first read 429s with nothing remembered, and got the
// app's empty state — "no matching conversations" on 292 intact conversations.
// Measured 2026-07-26: 99.6% of live-data call sites in published apps (3,938 of
// 3,954) drop the hook's `error`, and 95.4% of hook-using apps pair that with a
// `length === 0` empty state, so a failed read reads as "your data is gone" in
// almost every app on the platform. Persisting the last good answer makes a
// cold start during exhaustion show slightly stale data instead.
//
// Deliberately narrow: this cache is ONLY read on the 429 path (never on the
// happy path, never into the micro-cache), it expires, and it is capped — a
// fallback for a failure mode, not an offline layer.
const LS_KEY = 'whacka:lastgood:v1';        // unscoped (identity option unset)
const LS_MAX_AGE_MS = 24 * 3600 * 1000; // older than a day = don't silently show it
const LS_MAX_ENTRIES = 12;              // newest N keys only
const LS_MAX_VALUE_CHARS = 96_000;      // skip huge single results
const LS_MAX_TOTAL_CHARS = 400_000;     // stay far under the ~5MB origin budget
const LS_WRITE_THROTTLE_MS = 2000;      // reads can land many/second

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** The persisted-store key for an identity ('' = the unscoped legacy key). */
export function lastGoodStorageKey(scope) {
  return scope ? `${LS_KEY}:${scope}` : LS_KEY;
}

export function createReadLayer({
  rawCall,
  now = () => Date.now(),
  random = Math.random,
  ttlMs = READ_TTL_MS,
  baseMs = RL_BASE_MS,
  maxMs = RL_MAX_MS,
  jitterMs = RL_JITTER_MS,
  cacheMax = CACHE_MAX,
  // Injectable so the pure node tests can drive persistence without a DOM.
  // null disables persistence entirely (private-mode localStorage throws on
  // access — defaultStorage() already swallows that and yields null).
  storage = defaultStorage(),
  maxAgeMs = LS_MAX_AGE_MS,
  // Called on every 429 (served stale or not) and once on recovery. The DOM
  // notice lives in db.js/_read-notice.js — this module stays dependency-free.
  onRateLimited = null,
  onRecovered = null,
  // () => current app-user id. Every key (cache, last-good, storage) is scoped
  // by it; unset = the pre-L2 unscoped keys, byte-identical.
  identity = null,
} = {}) {
  if (typeof rawCall !== 'function') throw new Error('createReadLayer requires { rawCall }');

  const cache = new Map();    // key -> { ts, coll, promise, scope }  — 1.5s coalescing/micro-cache
  const lastGood = new Map(); // key -> { ts, coll, value, scope }    — 429 fallback (longer-lived)
  let cooldownUntil = 0;      // global: while now() < this, reads serve last-good, no network
  let backoffMs = 0;          // current exponential window (0 = healthy)
  let hydrated = false;       // any persisted last-good pulled in yet?
  const hydratedScopes = new Set(); // identities whose persisted rows were pulled in
  let legacyCleared = false;  // the unscoped blob removed once (scoped mode only)
  let lastPersistAt = 0;
  let lastLimitMessage = '';  // the server's own 429 wording, for the notice

  const clone = (v) => { try { return structuredClone(v); } catch { return v; } };

  const notify = (fn, arg) => { if (typeof fn === 'function') { try { fn(arg); } catch { /* never break a read */ } } };

  /** The current identity scope ('' when no identity function was given / it failed). */
  function scopeNow() {
    if (typeof identity !== 'function') return '';
    try { const id = identity(); return id ? String(id) : ''; } catch { return ''; }
  }

  function keyFor(scope, action, json) {
    return (scope ? scope + '|' : '') + action + '|' + json;
  }

  /** The collections a read's include brings rows from (a write to one of them drops the read too). */
  function alsoOf(params) {
    const inc = params && params.include;
    if (!inc || typeof inc !== 'object' || Array.isArray(inc)) return null;
    const out = [];
    for (const spec of Object.values(inc)) if (spec && typeof spec.from === 'string' && spec.from) out.push(spec.from);
    return out.length ? out : null;
  }

  /** Pull persisted last-good for one identity into memory once. Entries
   *  already in memory win (they are fresher by definition). */
  function hydrate(scope) {
    hydrated = true;
    hydratedScopes.add(scope);
    if (!storage) return;
    // Scoped mode: the pre-L2 unscoped blob is never read again — free the space.
    if (scope && !legacyCleared) {
      legacyCleared = true;
      try { storage.removeItem(LS_KEY); } catch { /* ignore */ }
    }
    let raw;
    try { raw = storage.getItem(lastGoodStorageKey(scope)); } catch { return; }
    if (!raw) return;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!parsed || !Array.isArray(parsed.e)) return;
    const t = now();
    for (const row of parsed.e) {
      if (!row || typeof row.k !== 'string') continue;
      if (typeof row.ts !== 'number' || t - row.ts > maxAgeMs) continue;
      if (lastGood.has(row.k)) continue;
      lastGood.set(row.k, { ts: row.ts, coll: row.c || null, value: row.v, scope, fromStorage: true });
    }
  }

  /** Write one identity's newest entries back, throttled. Silent on any failure
   *  (quota, private mode, unserializable value) — persistence is best-effort. */
  function persist(scope) {
    if (!storage) return;
    const t = now();
    if (t - lastPersistAt < LS_WRITE_THROTTLE_MS) return;
    lastPersistAt = t;
    const storageKey = lastGoodStorageKey(scope);
    try {
      const rows = [];
      let total = 0;
      // Map iteration is insertion-ordered and rememberGood re-inserts on every
      // hit, so walking from the end takes the most recently refreshed keys.
      for (const [k, e] of [...lastGood.entries()].reverse()) {
        if (e.scope !== scope) continue;
        if (t - e.ts > maxAgeMs) continue;
        let json;
        try { json = JSON.stringify(e.value); } catch { continue; }
        if (json.length > LS_MAX_VALUE_CHARS) continue;
        total += json.length + k.length;
        if (total > LS_MAX_TOTAL_CHARS) break;
        rows.push({ k, c: e.coll, ts: e.ts, v: e.value });
        if (rows.length >= LS_MAX_ENTRIES) break;
      }
      storage.setItem(storageKey, JSON.stringify({ e: rows }));
    } catch {
      // Out of quota (or blocked): drop what we had rather than keep failing.
      try { storage.removeItem(storageKey); } catch { /* ignore */ }
    }
  }

  function rememberGood(key, coll, value, scope) {
    lastGood.delete(key); // re-insert so iteration order == recency
    lastGood.set(key, { ts: now(), coll, value, scope });
    if (lastGood.size > cacheMax) {
      const oldest = lastGood.keys().next().value; // bound memory
      if (oldest !== undefined) lastGood.delete(oldest);
    }
    persist(scope);
  }

  function rlError() {
    // Reuse the server's own wording when we've seen it this session (it
    // distinguishes a per-minute burst from a spent daily quota), so the notice
    // and the app's own error handling say the same thing the server said.
    const e = new Error(lastLimitMessage || 'Usage limit reached. Try again later.');
    e.status = 429;
    e.rateLimited = true;
    e.servedFrom = 'cooldown';
    return e;
  }

  /** One place for "a read just got rate-limited" so every 429 path — cooldown,
   *  coalesced sharer, primary — reports consistently to the notice layer. */
  function reportLimited(servedStale, message) {
    if (typeof message === 'string' && message) lastLimitMessage = message;
    notify(onRateLimited, { servedStale, message: lastLimitMessage });
  }

  async function read(action, params) {
    let json;
    try { json = JSON.stringify(params || {}); }
    catch { return rawCall(action, params); } // unstringifiable params → bypass all guards
    const scope = scopeNow();
    const key = keyFor(scope, action, json);
    const coll = (params && params.collection) || null;

    if (!hydratedScopes.has(scope)) hydrate(scope);

    const t = now();

    // (1)+(2) micro-cache / in-flight coalescing. A coalesced sharer of an in-flight
    // request that 429s falls back to last-good too (same rule as the primary path
    // below), so the whole concurrent batch degrades consistently rather than one
    // straggler throwing while the primary serves stale.
    const hit = cache.get(key);
    if (hit && t - hit.ts < ttlMs) {
      try { return clone(await hit.promise); }
      catch (err) {
        if (err && err.status === 429) {
          const lg = lastGood.get(key);
          reportLimited(!!lg, err.message);
          if (lg) return clone(lg.value);
        }
        throw err;
      }
    }

    // (3) circuit breaker: budget is exhausted → do NOT touch the network. Serve the
    // last good value if we have one (UI stays populated); otherwise surface a soft
    // rate-limit error — but either way no request goes out, so an app retry loop
    // cannot keep the budget pinned.
    if (t < cooldownUntil) {
      const lg = lastGood.get(key);
      reportLimited(!!lg, '');
      if (lg) return clone(lg.value);
      throw rlError();
    }

    if (cache.size >= cacheMax) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const entry = { ts: t, coll, promise: rawCall(action, params), scope };
    const also = alsoOf(params);
    if (also) entry.also = also;
    cache.set(key, entry);
    entry.promise.then(
      (val) => {
        rememberGood(key, coll, val, scope);
        const wasLimited = backoffMs > 0 || cooldownUntil > 0;
        backoffMs = 0;       // healthy read → reset the breaker
        cooldownUntil = 0;
        if (wasLimited) notify(onRecovered, undefined); // let the notice retire itself
      },
      (err) => {
        if (cache.get(key) === entry) cache.delete(key); // never cache a failure
        if (err && err.status === 429) {
          if (typeof err.message === 'string' && err.message) lastLimitMessage = err.message;
          const ft = now();
          // Escalate the window once per window: in-flight stragglers that started
          // before the window was opened must not keep doubling it.
          if (ft >= cooldownUntil) {
            backoffMs = backoffMs ? Math.min(backoffMs * 2, maxMs) : baseMs;
            cooldownUntil = ft + backoffMs + Math.floor(random() * jitterMs);
          }
        }
      },
    );

    try {
      return clone(await entry.promise);
    } catch (err) {
      // On a 429, prefer stale-but-present data over throwing — this is what breaks
      // the app's retry loop (load() "succeeds" with last-good) and prevents a blank
      // screen. Non-429 errors propagate unchanged.
      if (err && err.status === 429) {
        const lg = lastGood.get(key);
        reportLimited(!!lg, err.message);
        if (lg) return clone(lg.value);
      }
      throw err;
    }
  }

  // A write invalidates only the changed collection's cached reads, and the reads
  // whose include brings rows from it (other collections stay cached), so the
  // caller's own change is visible immediately without re-fetching everything.
  // Unknown collection → clear all (safe fallback).
  // `before` (a live list's re-read after a change notice, delivery ledger P38):
  // only the reads that started by that moment go; one another list sent after
  // it already has the change, and stays shared.
  function invalidate(coll, before) {
    const stale = typeof before === 'number' ? (e) => e.ts <= before : () => true;
    if (typeof coll === 'string' && coll) {
      for (const [k, e] of cache) if ((e.coll === coll || (e.also && e.also.includes(coll))) && stale(e)) cache.delete(k);
    } else {
      cache.clear();
    }
  }

  /**
   * Forget everything cached for one identity — memory and the persisted
   * store. Called on sign-out for the identity that just left the device.
   */
  function forget(uid) {
    const scope = uid ? String(uid) : '';
    for (const [k, e] of cache) if (e.scope === scope) cache.delete(k);
    for (const [k, e] of lastGood) if (e.scope === scope) lastGood.delete(k);
    hydratedScopes.delete(scope);
    if (storage) { try { storage.removeItem(lastGoodStorageKey(scope)); } catch { /* ignore */ } }
  }

  // Test/diagnostic introspection only.
  function debugState() {
    return {
      cooldownUntil, backoffMs, cacheSize: cache.size, lastGoodSize: lastGood.size,
      hydrated,
      persistedFallbacks: [...lastGood.values()].filter((e) => e.fromStorage).length,
      lastLimitMessage,
      scope: scopeNow(),
    };
  }

  return { read, invalidate, forget, debugState };
}
