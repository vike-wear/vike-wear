/**
 * Share helper — reach people OUTSIDE the app.
 *
 * These open the user's OWN WhatsApp / SMS / email / share sheet with text
 * prefilled, or copy a link. They are one-way hand-offs: the message is sent
 * from the user's own account and any reply goes to THEM, not back into the app.
 * Use this to contact a phone number, invite a friend, or share the app link —
 * NOT to receive messages (share is one-way; don't fake an inbox).
 */

// Explicit .js extension: keeps this module importable by plain node for
// share.test.mjs (Vite resolves both forms identically).
import { db } from './db.js';

function digitsOnly(phone) {
  return String(phone || '').replace(/[^\d]/g, '');
}

// Meta (Instagram/Facebook/Messenger), TikTok, LINE and WeChat webviews: window.open
// returns a handle but renders nothing, so the popup-blocked fallback never fires and
// the visitor sees a dead tap. Detect them and navigate the current tab instead.
export function isInAppBrowser(ua) {
  const s = ua || (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  return /Instagram|FBAN|FBAV|FB_IAB|FBIOS|Messenger|MicroMessenger|TikTok|musical_ly|Bytedance|\bLine\//i.test(s);
}

function openUrl(url) {
  if (isInAppBrowser()) {
    window.location.href = url;
    return;
  }
  // New tab where allowed (must be inside a user gesture); fall back to navigation.
  const w = window.open(url, '_blank', 'noopener');
  if (!w) window.location.href = url;
}

// wa.me's redirect service replaces every 4-byte UTF-8 character — i.e. ALL
// emoji — with U+FFFD before handing the text to WhatsApp (verified 2026-07-10:
// a valid %F0%9F%AA%92 came back as %EF%BF%BD in their Location header, while
// 2/3-byte chars like £ and — survived). Strip astral chars (plus orphaned
// ZWJ/variation selectors they leave behind) rather than shipping � garbage
// into the customer's message. BMP symbols (£, —, ☎, ✂) pass through fine.
function waSafeText(text) {
  return String(text)
    .replace(/[\u{10000}-\u{10FFFF}\u200D\uFE0F]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '');
}

export const share = {
  /**
   * Open WhatsApp to a phone number (international digits, no +/spaces needed) with
   * optional prefilled text. Omit phone to let the user pick a contact.
   * Note: emoji are stripped from the prefilled text — WhatsApp's own wa.me
   * service corrupts them to � (keep prefill text emoji-free by design).
   * @example share.whatsapp('15551234567', 'Hi! Your order is ready.')
   */
  whatsapp(phone, text = '') {
    const num = digitsOnly(phone);
    const clean = waSafeText(text);
    const q = clean ? `?text=${encodeURIComponent(clean)}` : '';
    openUrl(`https://wa.me/${num}${q}`);
  },

  /**
   * Order/lead hand-off to WhatsApp that records the row WITHOUT risking the jump:
   * saves via a navigation-proof (keepalive) write, then opens WhatsApp in the same
   * user gesture. The save can't be killed by the navigation, and a failed save never
   * blocks the customer — the prefilled text still reaches the chat. Do NOT await it
   * before navigating; it handles the ordering itself.
   *
   * Rows default to visibleTo:'creator-and-admin' bound to the auto-created
   * key:<collection> group — the app owner reads every row, a signed-in customer only
   * their own, and signed-out visitors can still submit.
   *
   * @example share.whatsappOrder({ phone: SHOP_PHONE, text: summary, record: { items, total, customerName } })
   * @returns {Promise<{saved: boolean}>} settles after the write (pages that stay open may show a hint)
   */
  whatsappOrder({ phone, text = '', record, collection = 'orders', groupId, visibleTo, id } = {}) {
    let saved = Promise.resolve({ saved: false });
    if (record && typeof record === 'object') {
      try {
        // Server group keys allow [a-z0-9_-], start letter/digit, max 41 chars —
        // normalize deterministically so any collection name yields a valid key.
        const slug = String(collection).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 41) || 'orders';
        // The save is db.insertShared (L2 pass, 2026-09-27) — the same path as
        // every other write, so it gets the write-limit notice, the read-cache
        // invalidation, session renewal, the private-gate reload and the 30s
        // deadline — with the ONE difference this hand-off needs: keepalive, so
        // the request survives the navigation below. That is what makes "save
        // first" safe without awaiting (an awaited save that fails would strand
        // the customer; a plain request would be cancelled by the same-tab jump).
        // db.insertShared reaches fetch() synchronously, so the request is in
        // flight before the jump starts.
        saved = db.insertShared(collection, record, id, {
          groupId: groupId || `key:${slug}`,
          visibleTo: visibleTo || 'creator-and-admin',
          keepalive: true,
        }).then(
          () => ({ saved: true }),
          () => ({ saved: false }),
        );
      } catch {
        /* saving must never block the hand-off */
      }
    }
    this.whatsapp(phone, text);
    return saved;
  },

  /**
   * Open the SMS app to a number with an optional prefilled body.
   * @example share.sms('15551234567', 'Your code is 4821')
   */
  sms(phone, body = '') {
    const q = body ? `?&body=${encodeURIComponent(body)}` : '';
    openUrl(`sms:${phone}${q}`);
  },

  /**
   * Open the user's email client (mailto) — distinct from email.send, which delivers
   * a transactional email from the platform server. Use mailto when the USER should
   * send from their own address; use email.send for app-sent OTPs/receipts/notifications.
   * @example share.email({ to: 'a@b.com', subject: 'Invite', body: 'Join me at ...' })
   */
  email({ to = '', subject = '', body = '' } = {}) {
    const params = [];
    if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
    if (body) params.push(`body=${encodeURIComponent(body)}`);
    openUrl(`mailto:${to}${params.length ? '?' + params.join('&') : ''}`);
  },

  /**
   * Native share sheet (Web Share API), falling back to copying the link.
   * Pass the PUBLISHED app URL to share the app itself.
   * @returns {Promise<'shared'|'copied'|'failed'>}
   * @example await share.link({ title: 'BookClub', text: 'Join my club!', url: location.origin })
   */
  async link({ title = '', text = '', url = '' } = {}) {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title, text, url }); return 'shared'; }
      catch (e) { if (e && e.name === 'AbortError') return 'failed'; /* else fall through */ }
    }
    return (await this.copy(url || text)) ? 'copied' : 'failed';
  },

  /**
   * Copy text to the clipboard. @returns {Promise<boolean>}
   */
  async copy(text) {
    try { await navigator.clipboard.writeText(String(text ?? '')); return true; }
    catch { return false; }
  },
};
