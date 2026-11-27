/**
 * Download helper — save a stored file or image to the user's device.
 *
 * Why this exists: a plain `<a download>` on a cross-origin URL fails silently
 * in iOS Safari (and especially in installed PWAs). This helper routes the file
 * through a signed proxy URL and then picks the path that actually works per
 * platform — the native share sheet on iOS, the system browser inside the
 * Capacitor shell, a direct download elsewhere.
 *
 * Always use this instead of hand-rolling URL.createObjectURL + anchor clicks.
 */

// Explicit .js extensions: keeps this module importable by plain node for
// download.test.mjs (Vite resolves both forms identically).
import { getHeaders } from './_headers.js'
import { shouldUseHostBridge, sendHostRequest } from './_host-bridge.js'
import { sdkFetch } from './_fetch.js'
import { throwFromResponse } from './_errors.js'
import { absorbSessionRenewal } from './_session-expiry.js'

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {}
const API_BASE = ENV.VITE_API_BASE || ''
const PROJECT_ID = ENV.VITE_PROJECT_ID
// Pulling the file bytes same-origin: a large PDF on a slow connection.
const FILE_FETCH_TIMEOUT_MS = 120_000

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  // iPadOS 13+ reports as Mac; detect via touch points
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

// Native shell (Capacitor). Two things differ there and BOTH broke downloads
// until 2026-08-02 (zaduna: "PDF: Download fetch failed (404)" on every report,
// while the same report downloaded fine from the web app one minute later):
//   1. window.location.origin is the webview's local origin — https://localhost
//      on Android, capacitor://localhost on iOS. Nothing serves /whacka-file/
//      there (that route lives on the platform origin; the web app only reaches
//      it because the CF Worker forwards same-origin requests to it), so the
//      minted URL 404'd against Capacitor's own asset server.
//   2. Even with a reachable URL, this webview cannot land a file itself:
//      Capacitor registers no DownloadListener, so blob: anchors are silently
//      dropped, and shipped binaries carry no Filesystem/Share plugin
//      (App / Browser / PushNotifications / CapacitorUpdater only) — a fix that
//      needed a new plugin would never reach an already-installed app, which
//      updates the web layer over the air but never its native side.
// So: mint against API_BASE (the apex, baked into every native build) and hand
// the URL to the system browser, which honours Content-Disposition.
const isNativeShell = () => {
  try {
    return !!window.Capacitor?.isNativePlatform?.()
  } catch {
    return false
  }
}

// The app's own Android file (androidApp().url, 2026-10-22): a signed platform
// link, not a stored file, so it needs no proxy — following it downloads the
// APK and leaves the page where it is. Same pattern as src/lib/files/path.ts
// NATIVE_APK_PATH_RE (the editor accepts exactly this shape from the preview).
const ANDROID_APP_PATH_RE = /^\/api\/native\/dl\/apk\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\?t=[0-9a-f]{24}&e=\d{1,12}$/
const androidAppPath = (target) => {
  if (typeof target !== 'string') return null
  try {
    const u = new URL(target)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    const p = u.pathname + u.search
    return ANDROID_APP_PATH_RE.test(p) ? p : null
  } catch {
    return null
  }
}

/**
 * Exchange a storage URL or file ref for a short-lived proxy URL that streams
 * the file with a Content-Disposition attachment header. Same-origin on the
 * web (so iOS Safari downloads work); anchored to API_BASE in the native shell,
 * whose own origin serves no such route.
 *
 * @param {string|{bucket:string, path:string}} target - public storage URL, or
 *        a { bucket, path } ref (e.g. what docs.pdf returns for private files).
 */
async function mintProxyUrl(target, filename) {
  // A private file's ref carries the working link the server handed out with
  // it: that link is what lets this person download it (file-token).
  const payload =
    typeof target === 'string'
      ? { url: target, filename }
      : typeof target.url === 'string'
        ? { url: target.url, filename }
        : { bucket: target.bucket, path: target.path, filename }

  // Failures throw the SDK's standard Error (.message, .status, .code — e.g.
  // NOT_FOUND / FORBIDDEN for a file that is not this app's, RATE_LIMITED;
  // TIMEOUT / NETWORK without a status).
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/file-token`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
  }, { route: 'file-token' })
  absorbSessionRenewal(res)
  if (!res.ok) await throwFromResponse(res, 'Could not prepare download', 'file-token')
  const { proxyPath } = await res.json()
  const base = isNativeShell() && API_BASE ? API_BASE : window.location.origin
  return base + proxyPath
}

export const download = {
  /**
   * Save any stored file (PDF, doc, image, audio…) to the user's device.
   *
   * @param {string|{bucket:string, path:string}} target - a storage URL from
   *        storage.upload / storage.fromUrl / AI image generation, OR a file ref
   *        like docs.pdf returns. Must belong to this app.
   * @param {string} [filename] - Suggested filename, e.g. "report.pdf".
   * @returns {Promise<{ ok: boolean, method: string }>}
   */
  async saveFile(target, filename = 'download') {
    const apkPath = androidAppPath(target)
    if (apkPath) return saveAndroidApp(target, apkPath, filename)
    const proxyUrl = await mintProxyUrl(target, filename)

    // Editor preview: the iframe swallows anchor downloads — the file
    // generates but nothing lands, which reads as "downloads are broken".
    // Hand the same-origin proxy path to the editor shell, which performs
    // the download top-level where it actually works.
    if (shouldUseHostBridge()) {
      try {
        const u = new URL(proxyUrl)
        await sendHostRequest('whacka-host-download', {
          proxyPath: u.pathname + u.search,
          filename,
        })
        return { ok: true, method: 'host' }
      } catch (err) {
        console.warn('[download] host download failed, trying in-frame:', err && err.message)
        // fall through to the normal path
      }
    }

    // Native shell: the system browser is the only surface that can land a file
    // on the device from here (see isNativeShell above). The proxy token is
    // short-lived and self-authenticating, so the handoff carries no session and
    // needs none. Android opens a Custom Tab, iOS an SFSafariViewController;
    // both honour Content-Disposition and drop the file in Downloads / Files.
    if (isNativeShell()) {
      // ?ui=1 → the route answers with a page that starts the download and
      // stays up as a tap target. A raw attachment URL in a Custom Tab /
      // SFSafariViewController shows a blank tab if the browser declines to
      // auto-download, which is the same silent failure this fix exists to end.
      const handoffUrl = proxyUrl + (proxyUrl.includes('?') ? '&' : '?') + 'ui=1'
      const nativeBrowser = window.Capacitor?.Plugins?.Browser
      if (nativeBrowser?.open) {
        try {
          await nativeBrowser.open({ url: handoffUrl })
          return { ok: true, method: 'browser' }
        } catch (err) {
          console.warn('[download] Browser.open failed, falling back:', err && err.message)
        }
      }
      // No Browser plugin, or it failed: a top-level navigation to a non-app
      // URL is intercepted by Capacitor and handed to the system browser on
      // BOTH platforms (Android Bridge.launchIntent → ACTION_VIEW; iOS
      // decidePolicyFor → UIApplication.open + .cancel), so the webview itself
      // never leaves the app. Only safe while the shell sets no
      // allowNavigation for whacka.app — it doesn't, and must not.
      window.location.href = handoffUrl
      return { ok: true, method: 'external' }
    }

    // Pull the bytes same-origin (no CORS), so share/anchor get a clean Blob.
    const res = await sdkFetch(proxyUrl, {}, { timeoutMs: FILE_FETCH_TIMEOUT_MS, route: 'file-proxy' })
    if (!res.ok) await throwFromResponse(res, 'Download fetch failed', 'file-proxy')
    const blob = await res.blob()

    // iOS: the native share sheet is the only reliable way to land a file in
    // Photos / Files. canShare with files is true on iOS 15+.
    if (isIOS() && navigator.canShare) {
      const file = new File([blob], filename, {
        type: blob.type || 'application/octet-stream',
      })
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file] })
          return { ok: true, method: 'share' }
        } catch (err) {
          if (err && err.name === 'AbortError') {
            return { ok: false, method: 'share' } // user dismissed the sheet
          }
          // any other share failure → fall through to anchor
        }
      }
    }

    // Everyone else (and iOS fallback): same-origin anchor download works.
    const blobUrl = URL.createObjectURL(blob)
    try {
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = filename
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      return { ok: true, method: 'anchor' }
    } finally {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000)
    }
  },

  /**
   * Convenience alias for images. Same behavior as saveFile.
   *
   * @param {string} url
   * @param {string} [filename]
   */
  async saveImage(url, filename = 'image.png') {
    return this.saveFile(url, filename)
  },

  /**
   * This app's own Android file — the newest APK the owner built in App tab →
   * Direct install — for an "Install on Android" / "Download the app" button.
   * Ask when the visitor taps and pass the url to saveFile: each call mints a
   * fresh link, and a copied one stops working, so never store it or write it
   * into the code.
   *
   * @returns {Promise<{ url: string, version: string, sizeBytes: number|null, fileName: string } | null>}
   *          null when there is no Android file to offer (none built yet, or
   *          the owner's plan no longer includes phone apps).
   */
  async androidApp() {
    const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/android-app`, {
      headers: getHeaders(),
    }, { route: 'android-app' })
    absorbSessionRenewal(res)
    if (!res.ok) await throwFromResponse(res, 'Could not get the Android app', 'android-app')
    const data = await res.json().catch(() => null)
    if (!data || data.available !== true || typeof data.url !== 'string') return null
    return {
      url: data.url,
      version: typeof data.version === 'string' ? data.version : '',
      sizeBytes: typeof data.sizeBytes === 'number' ? data.sizeBytes : null,
      fileName: typeof data.fileName === 'string' && data.fileName ? data.fileName : 'app.apk',
    }
  },
}

/** saveFile for the app's own Android file (see androidAppPath above). */
async function saveAndroidApp(url, path, filename) {
  // Editor preview: its sandbox blocks downloads, so the editor clicks the
  // link top-level (it accepts exactly this path shape).
  if (shouldUseHostBridge()) {
    try {
      await sendHostRequest('whacka-host-download', { proxyPath: path, filename })
      return { ok: true, method: 'host' }
    } catch (err) {
      console.warn('[download] host download failed, trying in-frame:', err && err.message)
    }
  }
  // Native shell: the system browser lands the file (see isNativeShell above).
  if (isNativeShell()) {
    const nativeBrowser = window.Capacitor?.Plugins?.Browser
    if (nativeBrowser?.open) {
      try {
        await nativeBrowser.open({ url })
        return { ok: true, method: 'browser' }
      } catch (err) {
        console.warn('[download] Browser.open failed, falling back:', err && err.message)
      }
    }
    window.location.href = url
    return { ok: true, method: 'external' }
  }
  // Web: the link answers as an attachment, so the browser downloads it and the
  // page stays (an installed web app opens it in the browser, which downloads).
  window.location.href = url
  return { ok: true, method: 'navigate' }
}
