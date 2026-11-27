import { auth } from './auth'
import { showCreditsGate } from './credits-gate'
import { handleGatedResponse } from './_gate'
import { readErrorBody, sdkError } from './_errors.js'

/**
 * Shared 429 handler for all runtime API calls.
 * Shows a contextual modal based on user tier, then always throws.
 *
 * One special throw: when an ANONYMOUS visitor exhausts credits and then
 * SUCCESSFULLY signs in from the prompt, the thrown error carries
 * `retryable = true` — the fresh account has its own credits, so callers
 * (via fetchWithCreditRetry) re-issue the original request once instead of
 * surfacing "Credits exhausted" to a user who just gained credits.
 *
 * L2 pass (2026-09-27): a credits 429 is recognised by its code
 * (CREDITS_EXHAUSTED) or its `exhaustion` field; the old "any 429 carrying
 * `tier`" heuristic stays only for servers that predate the code — it used
 * to open the paywall on the knowledge daily cap, which also carried `tier`.
 * Every throw keeps .status / .code so app code can branch on them.
 */
export async function handleRateLimit(res) {
  const d = await readErrorBody(res)
  const code = (d && d.code) || null
  const isCredits = code === 'CREDITS_EXHAUSTED' || d.exhaustion !== undefined || (!code && d.tier !== undefined)

  // Not a credits 429 = a per-minute rate limit, a plan quota, a project cap…
  // Don't open the credits modal — but DON'T bury the server's precise message
  // either (a quota wall says what to delete / upgrade; team pending-requests
  // explains the wait). Surface d.error verbatim when present.
  if (!isCredits) {
    throw sdkError(d.error || 'Too many requests — please wait a moment and try again.', {
      status: 429, code: code || 'RATE_LIMITED', body: d,
    })
  }

  if (d.tier === 'anonymous' && !auth.isAuthenticated()) {
    // Pass the 429's server pricing through so the signup modal renders
    // current numbers (same no-baked-prices contract as the credits gate).
    const user = await auth.signIn({ reason: 'credits', pricing: d.pricing })
    if (user) {
      const e = sdkError('Signed in — retrying with your new credits.', { status: 429, code: 'CREDITS_EXHAUSTED', body: d })
      e.retryable = true
      throw e
    }
  } else if (d.tier !== 'anonymous') {
    // `required` (2026-10-01): what this call would have cost — set by the AI
    // gateway (a document read priced by its length can need more than the
    // balance holds). The gate prints "needs N, you have M" when present.
    await showCreditsGate(d.tier, d.exhaustion, d.pricing, { required: d.required, remaining: d.remaining })
  }

  throw sdkError(d.error || 'Credits exhausted', { status: 429, code: 'CREDITS_EXHAUSTED', body: d })
}

/**
 * Issue a metered request with the shared 429 handling, retrying ONCE when the
 * failure was "anonymous visitor signed in from the credits prompt" (see
 * handleRateLimit). `issue` must re-create the fetch — it is called again for
 * the retry. Any non-retryable handleRateLimit throw propagates unchanged; a
 * second 429 after the retry is returned to the caller's normal error path
 * (no second modal).
 */
export async function fetchWithCreditRetry(issue) {
  let res = await issue()
  if (res.status === 429) {
    try {
      await handleRateLimit(res)
    } catch (e) {
      if (!(e && e.retryable === true)) throw e
      res = await issue()
    }
  }
  // Mid-session gate flip: the owner turned the app private (or rotated the gate
  // code) while this visitor had it open, so every metered call now 401s with
  // {gated:true}. Handle it here — in the ONE path every metered lib shares
  // (ai/audio/knowledge/…) — so they all reload into the lock screen, not just
  // the ones that inlined the check. Peek at a clone so the caller still reads
  // the body; handleGatedResponse is idempotent (reload-once guard) and a no-op
  // in the editor preview (VITE_PREVIEW_TOKEN).
  if (res.status === 401) {
    try { handleGatedResponse(await res.clone().json()) } catch { /* body not JSON / not gated */ }
  }
  return res
}
