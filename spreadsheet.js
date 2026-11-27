/**
 * Spreadsheet helper — turn a user-uploaded .xlsx/.csv file into structured rows
 * you can write straight to the database. Use this for the IMPORT flow (a file
 * picker in your app), then write the rows with batched db.insertMany.
 *
 *   import { readSpreadsheet } from '../lib/spreadsheet'
 *   import { db } from '../lib/db'
 *
 *   // <input type="file" accept=".csv,.xlsx" onChange={e => onPick(e.target.files[0])} />
 *   async function onPick(file) {
 *     const { rows } = await readSpreadsheet(file)            // [{ Name, Email, ... }, ...]
 *     for (let i = 0; i < rows.length; i += 500)              // batch — insertMany caps at 500/call
 *       await db.insertMany('contacts', rows.slice(i, i + 500), { idField: 'Email' })
 *   }
 *
 * Handles real Excel (.xlsx binary), quoted fields with commas/newlines, the
 * Excel BOM, ';' / tab delimiters, and non-UTF-8 encodings — do NOT hand-roll
 * file.text() + split(','), and do NOT write rows one-by-one with db.insert in a
 * loop (that breaks on those edges and trips the write rate-limiter).
 *
 * (ai.run({ csvs }) is a different tool — for the AI to READ/understand CSV text,
 * not for bulk import. For data inside a PHOTO or PDF, use ai.run OCR instead.)
 *
 * Failures throw the SDK's standard Error: .message = the server's sentence
 * ("That file has no rows", "Sheet X not found" …), .status, .code (BAD_REQUEST,
 * PAYLOAD_TOO_LARGE, DAILY_LIMIT, RATE_LIMITED …); TIMEOUT / NETWORK carry no status.
 */

import { getAuthHeaders } from './_headers'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { absorbSessionRenewal } from './_session-expiry'
import { fileSizeMb, tooLargeError } from './_too-large'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB — mirror the server cap
// Upload + parse of a 10 MB workbook on a slow uplink.
const READ_TIMEOUT_MS = 90_000

export const spreadsheet = { read: readSpreadsheet }

/**
 * Parse an uploaded spreadsheet file into rows. Parsing runs server-side
 * (robust Excel + CSV) so nothing heavy ships in your app bundle.
 *
 * @param {File|Blob} file - the file from an <input type="file"> change event
 * @param {object} [options]
 * @param {boolean} [options.header=true] - first row is column headers; rows come
 *   back as objects keyed by header. Set false to get arrays of cell strings.
 * @param {string|number} [options.sheet] - which sheet of a multi-sheet .xlsx to
 *   read (sheet name, or 0-based index). Defaults to the first non-empty sheet.
 * @returns {Promise<{ columns: string[], rows: Array<object>|Array<string[]>, rowCount: number, sheetNames?: string[], sheet?: string }>}
 */
export async function readSpreadsheet(file, options = {}) {
  if (!file) throw new Error('readSpreadsheet: no file provided')
  if (typeof file.size === 'number' && file.size === 0) {
    throw new Error('That file is empty.')
  }
  if (typeof file.size === 'number' && file.size > MAX_FILE_SIZE) {
    // The same PAYLOAD_TOO_LARGE / 413 the server answers (_too-large.js).
    throw tooLargeError(
      `That file is too large (${fileSizeMb(file.size, 10)}MB, max 10MB). Split it into smaller files.`,
      'parse-spreadsheet',
    )
  }

  const form = new FormData()
  form.append('file', file, file.name || 'upload')
  if (options.header === false) form.append('header', 'false')
  if (options.sheet != null && options.sheet !== '') {
    form.append('sheet', String(options.sheet))
  }

  const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/parse-spreadsheet`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: form,
  }, { timeoutMs: READ_TIMEOUT_MS, route: 'parse-spreadsheet' })
  absorbSessionRenewal(res)

  if (!res.ok) await throwFromResponse(res, 'Could not read the spreadsheet', 'parse-spreadsheet')

  const data = await res.json()
  console.log(
    `[spreadsheet] read ${data.rowCount} rows, ${data.columns?.length || 0} cols`,
  )
  return data
}
