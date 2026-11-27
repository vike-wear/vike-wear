/**
 * Email helper — send transactional emails (invitations, receipts,
 * notifications) from your app to real inboxes, and email codes that prove
 * someone owns an address (sendCode / checkCode: the platform makes, mails
 * and checks the code — the app never holds one).
 *
 * Emails are sent from "<App Name> via Whacka <hello@whacka.app>".
 * The body is plain text: paragraphs (separated by blank lines),
 * single newlines render as line breaks, bare http(s) URLs are auto-linked.
 *
 * Quotas: a per-user daily ceiling and an hourly limit per address, both set
 * by the owner's plan (5 an hour to one address on free).
 *
 * Failures throw the SDK's standard Error: .message is the server's sentence,
 * .status the HTTP status, .code a stable code — BAD_RECIPIENT, QUOTA_EXCEEDED,
 * DAILY_LIMIT, RATE_LIMITED, FORBIDDEN (group sends need admin), EMAIL_PROVIDER,
 * SEND_FAILED; TIMEOUT / NETWORK carry no status (the server never answered).
 */

import { getHeaders } from './_headers'
import { resolveFaceLang } from './_lang.js'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { absorbSessionRenewal } from './_session-expiry'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID

async function postEmail(route, payload, fallback) {
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/${route}`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
  }, { route })
  absorbSessionRenewal(res)
  if (!res.ok) await throwFromResponse(res, fallback, route)
  return res.json()
}

const postSend = (payload, fallback) => postEmail('email/send', payload, fallback)

// G2: shared POST for group/role-targeted email (recipients resolved server-side).
async function groupEmail({ groupId, role, admins, subject, body, idempotencyKey }) {
  if (!groupId) throw new Error('email.sendToGroup: "groupId" is required')
  if (!subject) throw new Error('email: "subject" is required')
  if (!body) throw new Error('email: "body" is required')
  return postSend({ groupId, role, admins, subject, body, idempotencyKey }, 'Group email failed')
}

export const email = {
  /**
   * Send a transactional email.
   *
   * @param {object} options
   * @param {string|string[]} options.to - Recipient email(s)
   * @param {string} options.subject - Email subject line
   * @param {string} options.body - Plain text body. Blank lines = paragraph break.
   *   Single newlines = <br>. Bare http(s) URLs auto-link.
   * @param {string} [options.idempotencyKey] - The same email to the same
   *   recipient under the same key goes out once; a repeat answers
   *   { sent: true, duplicate: true }.
   * @returns {Promise<{ sent: boolean, deliveries: number, messageId: string|null, duplicate?: true }>}
   *
   * @example
   * // Order confirmation
   * await email.send({
   *   to: customerEmail,
   *   subject: 'Your order is confirmed',
   *   body: `Thanks! Order #${orderId} is confirmed.\n\nWe will email you when it ships.`,
   *   idempotencyKey: `order-confirmed-${orderId}`,
   * })
   *
   * @example
   * // Invitation with link
   * await email.send({
   *   to: friendEmail,
   *   subject: `${myName} invited you to BookClub`,
   *   body: `Hi!\n\n${myName} invited you to join their book club.\n\nJoin here: https://bookclub.whacka.app/join/abc123`,
   * })
   */
  async send({ to, subject, body, idempotencyKey } = {}) {
    if (!to) throw new Error('email.send: "to" is required')
    if (!subject) throw new Error('email.send: "subject" is required')
    if (!body) throw new Error('email.send: "body" is required')
    return postSend({ to, subject, body, idempotencyKey }, 'Email send failed')
  },

  /**
   * Email a one-time code to prove someone owns an address (sign-up, login,
   * password reset, a vote). The platform makes the 6-digit code and puts it
   * where the text says {code}; the app never sees or stores it. Every code
   * sent to the address in the last 10 minutes works, on any device; minutes
   * (1–10) makes this code work for less, checked on the server. A new code
   * can go out 30 seconds after the last one (RATE_LIMITED).
   * @param {string} to
   * @param {{ subject?: string, body?: string, minutes?: number }} [message] - {code} marks where the code goes
   * @returns {Promise<{ sent: true, expiresInSeconds: number }>}
   * @example await email.sendCode(addr, { subject: 'Your code', body: 'Your code is {code}. It expires in 10 minutes.' })
   * @example await email.sendCode(addr, { body: 'Your code is {code}. It expires in 1 minute.', minutes: 1 })
   */
  async sendCode(to, { subject, body, minutes } = {}) {
    if (!to || typeof to !== 'string') throw new Error('email.sendCode: "to" must be one email address')
    // lang: the window's language, for the platform's default mail when the app writes none.
    return postEmail('email/send-code', { to, subject, body, minutes, lang: resolveFaceLang() }, 'Code send failed')
  },

  /**
   * Whether `code` is one of the codes sendCode mailed to `to` in the last
   * 10 minutes. A right code is used up; after 5 wrong tries every code is
   * dropped and the person needs a new one.
   * @param {string} to
   * @param {string} code - what the person typed
   * @returns {Promise<boolean>}
   * @example const ok = await email.checkCode(addr, typed)
   */
  async checkCode(to, code) {
    if (!to || typeof to !== 'string') throw new Error('email.checkCode: "to" must be the email address the code was sent to')
    const res = await postEmail('email/check-code', { to, code: String(code ?? '') }, 'Code check failed')
    return res?.valid === true
  },

  /**
   * Email EVERY member of a social group (see the roles skill). Recipients are resolved
   * on the server from the group's membership — you don't pass addresses. Caller must be
   * the app owner (auth.isAppOwner) or a group admin. Subject to the same daily quota as send.
   * @param {string} groupId
   * @param {{ subject: string, body: string, idempotencyKey?: string }} message
   * @example await email.sendToGroup(team.id, { subject: 'Schedule', body: 'New rota is up.' })
   */
  async sendToGroup(groupId, { subject, body, idempotencyKey } = {}) {
    return groupEmail({ groupId, subject, body, idempotencyKey })
  },

  /**
   * Email only the members of a group who hold a specific ROLE (e.g. the managers).
   * @param {string} groupId
   * @param {string} role
   * @param {{ subject: string, body: string, idempotencyKey?: string }} message
   * @example await email.sendToRole(company.id, 'manager', { subject: '...', body: '...' })
   */
  async sendToRole(groupId, role, { subject, body, idempotencyKey } = {}) {
    return groupEmail({ groupId, role, subject, body, idempotencyKey })
  },

  /**
   * Email the ADMINS of a group (owner + appointed admins/managers) — the notify-up case
   * (a member emails the reviewers). Any signed-in group member may call it. Recipients resolved
   * server-side; anonymous members are skipped.
   * @param {string} groupId
   * @param {{ subject: string, body: string, idempotencyKey?: string }} message
   * @example await email.sendToAdmins(team.id, { subject: 'New report', body: 'Awaiting review' })
   */
  async sendToAdmins(groupId, { subject, body, idempotencyKey } = {}) {
    return groupEmail({ groupId, admins: true, subject, body, idempotencyKey })
  },
}
