/**
 * Adding someone to the team was refused for want of a team place: say so on the screen.
 *
 * Why (delivery ledger P108, 2026-11-09): when the owner's plan has no team place left,
 * the team route and social.inviteToGroup answer 429 QUOTA_EXCEEDED. The apps' own
 * approve buttons mostly swallow inviteToGroup's error as "already a member" (1,718 of
 * 2,796 recent apps; the route's sentence even says "member"), so the next step failed
 * with "not a member" or nothing at all, and owners pressed again and again. The shell
 * now shows the platform's bottom notice, as it does for a full database or storage,
 * whatever the app does with the error.
 *
 * The notice waits one task: a caller that words the refusal itself (TeamLogin,
 * TeamAdmin) calls err.worded() in its catch, which runs before the timer; nothing but
 * promises lies between the SDK's throw and that catch. The same shape as db.js's
 * e.queued for a save a move kept out.
 */

import { showWriteLimitNotice } from './_write-notice.js'

/** True for the refusal the team's places give (team route / social.inviteToGroup). */
export function isSeatRefusal(err) {
  return !!err && err.status === 429 && err.code === 'QUOTA_EXCEEDED'
}

/**
 * Arm the notice for a seat refusal; anything else is left alone.
 * @param {Error & { status?: number, code?: string, worded?: () => void }} err - the SDK error about to be thrown
 * @param {boolean} isOwner - the app owner is the one at the screen
 */
export function armSeatNotice(err, isOwner) {
  if (!isSeatRefusal(err)) return
  const timer = setTimeout(() => showWriteLimitNotice({ kind: isOwner ? 'teamFullOwner' : 'teamFull' }), 0)
  err.worded = () => clearTimeout(timer)
}
