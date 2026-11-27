function isTrustedHost(origin) {
  try {
    const host = new URL(origin).hostname
    return host.endsWith('whacka.app') || host.includes('localhost')
  } catch {
    return false
  }
}

export function shouldUseHostBridge() {
  if (window.self === window.top) return false
  if (!document.referrer) return false
  return isTrustedHost(document.referrer)
}

export function sendHostRequest(type, payload) {
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new Error('Host bridge timed out'))
    }, 30000)

    function onMessage(event) {
      if (event.source !== window.parent) return
      if (!isTrustedHost(event.origin)) return
      if (event.data?.type !== 'whacka-host-response') return
      if (event.data.requestId !== requestId) return

      window.clearTimeout(timeout)
      window.removeEventListener('message', onMessage)

      if (event.data.ok) {
        resolve(event.data.result)
        return
      }

      const error = new Error(event.data.error || 'Host action failed')
      if (event.data.name) {
        error.name = event.data.name
      }
      reject(error)
    }

    window.addEventListener('message', onMessage)
    window.parent.postMessage({ type, requestId, ...payload }, '*')
  })
}

// The editor preview tells its frame that the person looking is the app's
// owner (PreviewFrame, 2026-10-27): the sign-in window then offers "Continue
// as owner", and the workspace mints that session (owner link, delivery
// 'preview'). Honoured in a preview build only, so a published app framed by
// any other page never shows it.
const IN_PREVIEW_BUILD = !!((typeof import.meta !== 'undefined' && import.meta.env) || {}).VITE_PREVIEW_TOKEN
let ownerHint = null

/** { email } once the editor preview has said its viewer owns this app; else null. */
export function hostOwnerHint() {
  return ownerHint
}

/** Ask the editor preview for an owner session: resolves { code } for /api/auth/exchange-code. */
export function requestOwnerSession() {
  return sendHostRequest('whacka-host-owner-session', {})
}

export function installHostBridge() {
  if (!shouldUseHostBridge()) return

  if (IN_PREVIEW_BUILD) {
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent || !isTrustedHost(event.origin)) return
      if (event.data?.type !== 'whacka-owner-available') return
      ownerHint = { email: typeof event.data.email === 'string' ? event.data.email : '' }
    })
  }

  try {
    const nativeShare = typeof navigator.share === 'function'
      ? navigator.share.bind(navigator)
      : null

    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data) => {
        if (nativeShare) {
          try {
            return await nativeShare(data)
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
              throw error
            }
          }
        }

        return sendHostRequest('whacka-host-share', { data })
      },
    })
  } catch {}

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      const nativeWriteText = navigator.clipboard.writeText.bind(navigator.clipboard)

      navigator.clipboard.writeText = async (text) => {
        try {
          return await nativeWriteText(text)
        } catch {
          return sendHostRequest('whacka-host-copy', { text })
        }
      }
    }
  } catch {}
}
