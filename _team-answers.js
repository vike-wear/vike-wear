/**
 * What <TeamLogin> says when signing in, accepting an invite or asking to join
 * did not go through (delivery ledger P53, 2026-10-20). The card never shows a
 * server's text: the team route answers in English, so the card names one of
 * its own sentences (a labels key — en / ar defaults in TeamLogin.jsx) from
 * what the SDK error carries: no status = the request never got an answer;
 * else the status, and the code where the status alone is not enough. The
 * Whacka ID window follows the same rule (P6).
 *
 * The two rules a new account must pass are the server's, checked before
 * anything is sent (team route normalizeHandle + typedSecret, src/lib/teams/pin.ts
 * newSecretError — scripts/_test-team-login-answers.ts pins both).
 *
 * Imports only _typed-digits.js (no DOM, no import.meta): the test loads it in plain node.
 */
import { foldTypedDigits } from './_typed-digits.js'

/**
 * @param {Error & { status?: number, code?: string }} err - the SDK error team.* threw
 * @param {'login'|'accept'|'request'|'signup'} step - what the card asked for (signup: the users list, 2026-10-30)
 * @param {boolean} pinMode - the app signs in with a 6-digit PIN
 * @returns {string} a TeamLogin labels key
 */
export function teamFailureKey(err, step, pinMode) {
  const status = err && typeof err.status === 'number' ? err.status : 0
  const code = (err && err.code) || ''
  if (!status) return code === 'NETWORK' || code === 'TIMEOUT' ? 'offline' : 'genericError'
  if (status === 429) {
    if (code === 'QUOTA_EXCEEDED') return 'seatsFull'
    if (code === 'PROJECT_LIMIT') return 'genericError'
    // a sign-up meets the users list's brakes (per network, per app, waiting for approval)
    return step === 'signup' ? 'tooManySignups' : 'tooManyTries'
  }
  if (step === 'login') {
    if (status === 401 && code !== 'GATED') return pinMode ? 'wrongPin' : 'wrongPassword'
    if (status === 403 && code === 'FORBIDDEN') return 'pendingApproval'
  }
  if (step === 'accept') {
    // used, expired or unknown invite; the username it assigned was taken since
    if ((status === 404 && code === 'NOT_FOUND') || status === 409 || status === 410) return 'invalidInvite'
  }
  if ((step === 'request' || step === 'signup') && status === 409) return 'usernameTaken'
  // the owner closed sign-ups (or the users list) while the card was open
  if (step === 'signup' && status === 403 && code === 'FORBIDDEN') return 'signupsClosed'
  // the owner closed sign-up requests while the card was open: trying again cannot help
  if (step === 'request' && status === 403 && code === 'FORBIDDEN') return 'requestsClosed'
  return 'genericError'
}

/**
 * The server keeps a–z 0–9 _ of a lowercased username (٠-٩ / ۰-۹ count as
 * 0-9) and needs 3–30 of them; the card's username fields take at most 30
 * characters, so only the 3 is left.
 */
export function usernameProblem(raw) {
  const typed = foldTypedDigits(raw).toLowerCase().trim()
  const kept = typed.replace(/[^a-z0-9_]/g, '')
  if (kept.length >= 3) return null
  return kept !== typed ? 'usernameLatinOnly' : 'usernameTooShort'
}

/** A new password is 6+ characters; in PIN mode exactly 6 digits (٠-٩ / ۰-۹ count). */
export function secretProblem(pinMode, value) {
  const v = typeof value === 'string' ? foldTypedDigits(value) : ''
  if (pinMode) return /^\d{6}$/.test(v) ? null : 'pinSix'
  return v.length >= 6 ? null : 'passwordMin'
}
