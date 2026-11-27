/**
 * WhatsApp helper — the APP sends a WhatsApp message from the OWNER's own
 * connected WhatsApp Business number (order confirmations, receipts, alerts).
 *
 * Requires the owner to connect their number once (Integrations panel, BYO
 * provider API key). Until then every send throws code NO_CONNECTION — gate
 * WhatsApp UI on whatsapp.isConnected().
 *
 * Delivery reality (WhatsApp platform rule, be honest in UI):
 * - Free-form text reaches a recipient only inside the 24h service window
 *   (they messaged the business number within the last 24 hours).
 * - Outside the window only an APPROVED TEMPLATE delivers (the owner creates
 *   templates in their provider dashboard) — use whatsapp.sendTemplate.
 * This is one-way sending: replies land on the owner's phone, not in the app.
 */

// Explicit .js extensions keep this module importable by plain node for
// whatsapp.test.mjs (Vite resolves both forms identically).
import { getHeaders } from './_headers.js';
import { sdkFetch } from './_fetch.js';
import { throwFromResponse } from './_errors.js';
import { absorbSessionRenewal } from './_session-expiry.js';

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const API_BASE = ENV.VITE_API_BASE || '';
const PROJECT_ID = ENV.VITE_PROJECT_ID;

// Failures throw the SDK's standard Error: .message = the server's sentence,
// .status, .code — NO_CONNECTION | WINDOW_CLOSED | QUOTA_EXCEEDED |
// TEMPLATE_NOT_ALLOWED | TEMPLATE_UNAVAILABLE | BAD_RECIPIENT | WHATSAPP_PROVIDER |
// SEND_FAILED …; an infra-level refusal that carries no code of its own gets one
// derived from the status (RATE_LIMITED, INTERNAL …), so app code switching on
// err.code always has one. TIMEOUT / NETWORK carry no status.
async function post(path, payload) {
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/whatsapp/${path}`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
  }, { route: `whatsapp/${path}` });
  absorbSessionRenewal(res);
  if (!res.ok) await throwFromResponse(res, 'WhatsApp request failed', `whatsapp/${path}`);
  return res.json().catch(() => ({}));
}

export const whatsapp = {
  /**
   * Whether the owner has connected a WhatsApp Business number.
   * Never throws — any failure reads as { connected: false }.
   * @returns {Promise<{connected: boolean, number?: string}>} number is masked (…last 4)
   */
  async isConnected() {
    try {
      const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/whatsapp/status`, {
        headers: getHeaders(),
      }, { route: 'whatsapp/status' });
      if (!res.ok) return { connected: false };
      return await res.json().catch(() => ({ connected: false }));
    } catch {
      return { connected: false };
    }
  },

  /**
   * Send a free-form text message. Delivers ONLY within the recipient's 24h
   * service window — for "notify me on every order" flows the recipient (often
   * the owner themselves) should message the business number once, or use a
   * template instead.
   * Pass idempotencyKey (a stable per-event string, e.g. `order-42-owner-alert`)
   * when the call can fire more than once (retry button, trigger) — repeats
   * within 24h return the first result ({deduped: true}) instead of re-sending.
   * @example await whatsapp.send({ to: '15551234567', text: 'New order #42: 2× Tagine, total 120 MAD', idempotencyKey: 'order-42-owner-alert' })
   * @returns {Promise<{sent: boolean, messageId?: string, deduped?: boolean}>}
   */
  async send({ to, text, idempotencyKey } = {}) {
    if (!to) throw new Error('whatsapp.send: "to" is required (digits, international format)');
    if (!text) throw new Error('whatsapp.send: "text" is required');
    return post('send', { kind: 'text', to, text, idempotencyKey });
  },

  /**
   * Send an approved template message (delivers outside the 24h window).
   * The owner creates + submits templates in their provider dashboard; pass the
   * template's name, language code, and body variables in order.
   * Whacka's anti-spam rule (not WhatsApp's): a template to a number this app
   * has never delivered to goes out only when the signed-in app owner or a team
   * admin sends it (code TEMPLATE_NOT_ALLOWED otherwise) — one successful
   * whatsapp.send to a number unlocks it for every sender.
   * @example await whatsapp.sendTemplate({ to, template: 'order_update', language: 'ar', variables: ['#42', 'shipped'] })
   * @returns {Promise<{sent: boolean, messageId?: string, deduped?: boolean}>}
   */
  async sendTemplate({ to, template, language = 'en', variables = [], idempotencyKey } = {}) {
    if (!to) throw new Error('whatsapp.sendTemplate: "to" is required');
    if (!template) throw new Error('whatsapp.sendTemplate: "template" is required');
    return post('send', { kind: 'template', to, template, language, variables, idempotencyKey });
  },
};
