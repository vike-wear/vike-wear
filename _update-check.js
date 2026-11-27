/**
 * _update-check.js — is this page already the publish its new service worker
 * serves? (2026-10-31; ran 10-30: keep the "Updated — tap to refresh" pill,
 * stop it where there is nothing to refresh.)
 *
 * Every publish writes one mark into index.html (<meta name="wk-publish">) and
 * into its sw.js (src/lib/publish/service-worker.ts). Navigations go to the
 * network first, so a page opened after a publish already IS that publish and
 * meets the new worker only a moment later, when it takes over. main.jsx asks
 * the worker for its mark on every takeover: the same mark on both sides means
 * nothing to refresh. No answer, no mark, any other answer → the pill, as
 * before — a doubt never hides an update.
 *
 * Nothing here touches the DOM or navigator at module scope (the DOM-less
 * scripts/_test-update-pill.ts loads this file).
 */

/** The mark of the publish this document is ('' when it carries none). */
export function pagePublish(doc) {
  try {
    const el = doc && doc.querySelector('meta[name="wk-publish"]')
    return (el && el.getAttribute('content')) || ''
  } catch { return '' }
}

/**
 * The mark the worker serves, asked over a MessageChannel; '' when it cannot
 * be asked or does not answer within `timeoutMs`. Never rejects.
 */
export function askWorkerPublish(worker, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false
    let channel = null
    let timer = null
    const settle = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { if (channel) channel.port1.close() } catch { /* ignore */ }
      resolve(value)
    }
    try {
      channel = new MessageChannel()
      channel.port1.onmessage = (event) => {
        const d = event && event.data
        settle(d && d.type === 'WK_PUBLISH' && typeof d.publish === 'string' ? d.publish : '')
      }
      timer = setTimeout(() => settle(''), timeoutMs)
      worker.postMessage({ type: 'WK_PUBLISH' }, [channel.port2])
    } catch {
      settle('')
    }
  })
}

/** True only when both marks are known and the same. */
export function isSamePublish(page, served) {
  return typeof page === 'string' && page !== '' && page === served
}
