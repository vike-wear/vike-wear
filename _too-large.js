// ─────────────────────────────────────────────
// A file over a per-file cap, refused on the device (delivery ledger P34, 2026-10-20)
// ─────────────────────────────────────────────
// The SDK checks a file's size before sending it, so an over-cap file never
// reaches the server, and the server's own refusal (413 PAYLOAD_TOO_LARGE,
// recorded as the size limit by src/lib/limit-funnel.ts) never happens. Every
// device-side refusal throws the SDK's standard error with the code and status
// the server would have answered, so app code can branch on err.code.
//
// For the account's upload cap (storage.upload, audio.upload) the refusal is
// also reported once per visit through the SDK's failure channel — the
// platform records it as the size limit it is (app_health, the owner's health
// page) instead of a crash — and the shell tells the visitor in its own voice
// (_write-notice.js): most apps show nothing, or the English sentence.
//
// Apps match on the sentence's English opening "File is too large (…MB, max
// …MB)", so it stays. Internal: not exposed to generated app code directly.
import { sdkError } from './_errors.js'
import { reportSdkFailure } from './_client-report.js'
import { showWriteLimitNotice } from './_write-notice.js'

const MB = 1048576

/** A file's size in MB as a person reads it next to the cap: one decimal when
 *  it is just over (25.3MB, never "25MB, max 25MB"), whole MB otherwise. */
export function fileSizeMb(bytes, maxMb) {
  const mb = bytes / MB
  // toFixed first: 25.2 × 10 is 252.00000000000003 in floating point
  return mb < maxMb + 1 ? Math.ceil(Number((mb * 10).toFixed(6))) / 10 : Math.round(mb)
}

/** The error a too-big file is refused with: the server's code and status. */
export function tooLargeError(message, route) {
  return sdkError(message, { status: 413, code: 'PAYLOAD_TOO_LARGE', route })
}

/** storage.upload / audio.upload: a file over the account's per-file cap.
 *  Reports it, shows the visitor the notice, and returns the error to throw. */
export function overUploadCap(route, bytes, maxMb, message) {
  const mb = fileSizeMb(bytes, maxMb)
  const e = tooLargeError(message || `File is too large (${mb}MB, max ${maxMb}MB).`, route)
  reportSdkFailure({ route, status: 413, code: 'PAYLOAD_TOO_LARGE', message: e.message })
  showWriteLimitNotice({ kind: 'uploadTooBig', mb, max: maxMb })
  return e
}
