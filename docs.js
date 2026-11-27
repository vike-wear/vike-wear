/**
 * Document generation — turn structured content into a real downloadable file.
 *
 *   import { docs } from '../lib/docs'
 *   import { download } from '../lib/download'
 *
 *   const file = await docs.pdf({
 *     title: 'Inspection Report',
 *     pages: [{ sections: [
 *       { type: 'cover', title: 'Inspection Report', subtitle: '12 Main St',
 *         meta: [{ label: 'Inspector', value: 'A. Smith' }, { label: 'Date', value: '2026-05-28' }] },
 *       { type: 'pageBreak' },
 *       { type: 'heading', text: 'Findings' },
 *       { type: 'paragraph', text: 'Bathroom ceiling shows moderate water damage…' },
 *       { type: 'badge', text: 'SEVERITY: HIGH', color: '#dc2626' },
 *       { type: 'imageGrid', columns: 2, images: [{ url: photoUrl, caption: 'Ceiling' }] },
 *       { type: 'table', columns: [{ header: 'Item', key: 'item' }, { header: 'Status', key: 'status' }],
 *         rows: [{ item: 'Smoke alarm', status: 'Pass' }, { item: 'Exit sign', status: 'Fail' }] },
 *       { type: 'signature', label: 'Inspector signature', name: 'A. Smith', date: '2026-05-28' },
 *     ]}],
 *   })
 *
 *   // file is a ref: { bucket, path, filename, sizeBytes }. Hand it to the user:
 *   await download.saveFile(file, 'inspection-report.pdf')
 *
 * Generating a document is free — it does not call AI and does not cost credits.
 * Images referenced in a PDF must be reachable jpg/png URLs (e.g. from
 * storage.upload or AI image generation).
 *
 * Failures throw the SDK's standard Error: .message = the server's sentence
 * (which section / field was wrong), .status, .code (BAD_REQUEST,
 * PAYLOAD_TOO_LARGE, QUOTA_EXCEEDED, RATE_LIMITED, PROVIDER_ERROR …); TIMEOUT /
 * NETWORK / KEEPALIVE_CUT carry no status (the server never finished answering).
 */

import { getHeaders } from './_headers'
import { buildSheetHtml } from './print'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { absorbSessionRenewal } from './_session-expiry'
import { KEEPALIVE_HEADERS, readKeepaliveJson, throwFromEnvelope } from './_keepalive'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID
// Rendering a long PDF with many images can run well past a minute; the
// keep-alive header keeps Cloudflare from cutting the answer at 100s.
const DOCS_TIMEOUT_MS = 150_000

async function generate(format, spec, options = {}) {
  const route = `docs/${format}`
  const fallback = `${format.toUpperCase()} generation failed`
  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/docs/${format}`, {
    method: 'POST',
    headers: { ...getHeaders(), ...KEEPALIVE_HEADERS },
    // private: the document opens only for its maker, the app owner and whoever
    // can read a row the ref is saved in (the ref then carries a working url).
    body: JSON.stringify({ spec, filename: options.filename, ...(options.private ? { private: true } : {}) }),
  }, { timeoutMs: DOCS_TIMEOUT_MS, route })
  absorbSessionRenewal(res)
  if (!res.ok) await throwFromResponse(res, fallback, route)
  // Long renders arrive as a keep-alive envelope (heartbeat spaces + ONE
  // {__wk:'envelope',status,body}); a plain answer unwraps to itself.
  const out = await readKeepaliveJson(res, route, { timeoutMs: DOCS_TIMEOUT_MS })
  if (!out.ok) throwFromEnvelope(out, res, fallback, route)
  return out.body
}

export const docs = {
  /**
   * Render a PDF from a JSON spec.
   *
   * @param {object} spec - { title?, dir?, theme?, header?, footer?, pages: [{ size?, orientation?, sections: [...] }] }
   *   dir: 'rtl' lays the whole document out right-to-left (Arabic/Hebrew) — blocks
   *   right-align; table columns keep listed order (per-table dir:'rtl' flips them).
   *   Section types: cover, heading, paragraph, list, quote, callout, kpiCards,
   *   image, imageGrid, chart, gantt, timeline, table, keyValue, badge, toc,
   *   divider, spacer, signature, pageBreak.
   *   For charts/Gantt pass DATA (chart/gantt sections render crisp vector SVG) —
   *   never draw on a canvas and embed a PNG. header/footer repeat on every page
   *   and footer.pageNumbers adds "Page X of Y".
   * @param {object} [options]
   * @param {string} [options.filename] - e.g. "report.pdf"
   * @param {boolean} [options.private] - Opens only for its maker, the app owner and
   *   whoever can read a row the ref is saved in (save the whole ref).
   * @returns {Promise<{ bucket: string, path: string, filename: string, sizeBytes: number }>}
   *   A file ref — pass it straight to download.saveFile(ref, name).
   */
  pdf: (spec, options) => generate('pdf', spec, options),

  /**
   * Render an on-screen element to a PDF that matches the PRINTED sheet
   * exactly — same document, same layout engine as Print. Use this when the
   * download must look identical to what the user sees / prints (certificates,
   * letterheads, formatted sheets); use docs.pdf when building a structured
   * report from data.
   *
   * @param {HTMLElement|{current: HTMLElement}} elOrRef - element or React ref
   *   (the same ref you would hand to print.printElement)
   * @param {object} [options]
   * @param {string} [options.filename] - e.g. "certificate.pdf"
   * @param {string} [options.title]    - PDF document title
   * @param {string} [options.margin]   - paper inset, e.g. "12mm" (default) or "0"
   * @param {string} [options.size]     - paper size, e.g. "A4", "A4 landscape", "Letter"
   * @param {string} [options.fit]      - 'page' scales the sheet down to fit exactly
   *                                      ONE page (measured, never clipped) — use for
   *                                      certificates / cards / terms / receipts
   * @returns {Promise<{ bucket, path, filename, sizeBytes }>}
   *   A file ref — pass it straight to download.saveFile(ref, name).
   *   CSS background-images won't render in the file — use <img> for anything
   *   that must appear (logos, signatures, photos).
   */
  pdfFromElement: async (elOrRef, options = {}) =>
    generate('pdf-element', { html: await buildSheetHtml(elOrRef, options) }, options),

  /**
   * Render a PowerPoint (.pptx) from a JSON spec.
   * @param {object} spec - { title?, slides: [{ title?, elements: [...] }] }
   *   Element types: title, text, bullets, image, table.
   * @param {object} [options] - { filename? }
   * @returns {Promise<{ bucket, path, filename, sizeBytes }>}
   */
  pptx: (spec, options) => generate('pptx', spec, options),

  /**
   * Render a Word document (.docx) from a JSON spec.
   * @param {object} spec - { title?, dir?, sections: [{ type, ... }] }
   *   Section types: heading, paragraph, list, table, pageBreak, spacer. Table rows:
   *   keyed objects (like docs.pdf) or positional arrays. Arabic/Hebrew text is
   *   auto-detected and laid out RTL.
   * @param {object} [options] - { filename? }
   * @returns {Promise<{ bucket, path, filename, sizeBytes }>}
   */
  docx: (spec, options) => generate('docx', spec, options),

  /**
   * Render an Excel spreadsheet (.xlsx) from a JSON spec.
   * @param {object} spec - { sheets: [{ name?, columns: [{header, key, width?}], rows: [...] }] }
   *   rows may be arrays (positional) or objects keyed by column key.
   * @param {object} [options] - { filename? }
   * @returns {Promise<{ bucket, path, filename, sizeBytes }>}
   */
  xlsx: (spec, options) => generate('xlsx', spec, options),
}
