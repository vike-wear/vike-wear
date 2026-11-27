import { fetchWithCreditRetry } from './_rate-limit'
import { getHeaders } from './_headers'
import { KEEPALIVE_HEADERS, readKeepaliveJson, throwFromEnvelope } from './_keepalive'
import { sdkFetch } from './_fetch'
import { throwFromResponse } from './_errors'
import { absorbSessionRenewal } from './_session-expiry'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID
// The server stops one AI call at 5 minutes and answers TIMEOUT
// (AI_CALL_BUDGET_MS, src/lib/ai/runtime-budget.ts); the keep-alive envelope
// keeps Cloudflare from cutting it at 100s, and this is the client's ceiling
// above the server's so a genuinely stuck call still ends.
const AI_TIMEOUT_MS = 330_000

// One request path for run / chat / stream (L2 pass, 2026-09-27). Failures throw
// the SDK's standard Error whether they arrived as a real status or inside the
// keep-alive envelope: .message = the server's sentence, .status, .code —
// CREDITS_EXHAUSTED (after the credits modal), DAILY_LIMIT, RATE_LIMITED,
// BAD_REQUEST (prompt / options), PAYLOAD_TOO_LARGE, OUTPUT_TRUNCATED ({json:true}
// cut at max_tokens), PROVIDER_ERROR, PROVIDER_UNAVAILABLE, TIMEOUT (server side,
// 504: the call asked for too much at once, a retry only repeats the wait, split
// it) …; TIMEOUT / NETWORK / KEEPALIVE_CUT WITHOUT a status when the server never
// finished answering.
async function callAi(body, fallback) {
  // fetchWithCreditRetry: shared 429 handling + one retry after an anonymous
  // visitor signs in from the credits prompt. getHeaders() runs per attempt,
  // so the retry carries the fresh signed-in identity.
  const res = await fetchWithCreditRetry(() => sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/ai`, {
    method: 'POST',
    headers: { ...getHeaders(), ...KEEPALIVE_HEADERS },
    body: JSON.stringify(body),
  }, { timeoutMs: AI_TIMEOUT_MS, route: 'ai' }))
  absorbSessionRenewal(res)
  if (!res.ok) await throwFromResponse(res, fallback, 'ai')
  // Long calls arrive as a keep-alive envelope (heartbeat spaces + ONE
  // {__wk:'envelope',status,body}); unwrap restores the status semantics.
  const out = await readKeepaliveJson(res, 'ai', { timeoutMs: AI_TIMEOUT_MS })
  if (!out.ok) throwFromEnvelope(out, res, fallback, 'ai')
  return out.body
}

export const ai = {
  /**
   * Run an AI prompt and get a response with text and optional images.
   *
   * Modes based on options:
   *   - text       (default)                 → 1 credit, returns { text }
   *   - vision     (images, no image:true)   → 2 credits, reads images, returns { text }
   *   - image gen  (image:true)              → 2 credits, generates/edits images, returns { text, images }
   *   - image gen  (image:true, quality:'high') → 4 credits
   *   - pdf        (pdfs)                    → 2 credits for a short document (up to ~20k tokens,
   *                                            about 10 pages), +1 credit per further 10k tokens —
   *                                            a long or scanned PDF costs more; reads PDFs, returns { text }
   *   - csv        (csvs OR csvText)         → same rule as pdf (2 credits, more for large data), returns { text }
   *
   * @param {string} prompt - The prompt to send
   * @param {object} [options] - Optional config
   * @param {boolean} [options.image] - Set true to generate or edit images
   * @param {string[]} [options.images] - Input image URLs. Without image:true → vision read.
   *                                      With image:true → edit the given images.
   * @param {string[]} [options.pdfs] - PDF URLs to read (max 8MB each, vision-quality extraction; priced by length)
   * @param {string[]} [options.csvs] - CSV URLs to fetch and inline as data (max 200KB each)
   * @param {string} [options.csvText] - Raw CSV text to inline directly (no fetch)
   * @param {boolean} [options.json] - Structured output: returns result.json already parsed
   *                                   (object/array, or null if unrecoverable). No JSON.parse needed.
   * @param {'fast'|'high'} [options.quality] - Image quality: 'fast' (default) or 'high'
   * @param {string} [options.aspectRatio] - Aspect ratio: '1:1', '16:9', '9:16', '4:3', '3:4', '5:4'
   * @param {string} [options.resolution] - Resolution: '1K' (default), '2K' (high quality only)
   * @returns {Promise<{ text: string, images: string[], json?: any }>}
   * @example const result = await ai.run("Suggest a healthy dinner recipe")
   * @example const result = await ai.run("a cute cat", { image: true, quality: 'high' })
   * @example const result = await ai.run("remove background", { image: true, images: [photoUrl] })
   * @example // Vision: extract structured data from a photo (json is parsed, or null)
   * const { json } = await ai.run(
   *   "Extract this recipe with fields: title, ingredients[], steps[].",
   *   { images: [photoUrl], json: true }
   * )
   * @example // PDF: extract questions from a sample exam
   * const { json } = await ai.run(
   *   "Extract every question as [{q, choices, answer}].",
   *   { pdfs: [pdfUrl], json: true }
   * )
   * @example // CSV from URL: import a roster
   * const { json } = await ai.run(
   *   "Read this student roster and return [{name, grade, section}].",
   *   { csvs: [csvUrl], json: true }
   * )
   * @example // CSV from string: parsed locally already, pass raw text
   * const csv = "name,age\\nAlice,30\\nBob,25"
   * const { text } = await ai.run("Summarize this data", { csvText: csv })
   */
  async run(prompt, options = {}) {
    // Never log the prompt itself: it is the visitor's own text (a diary entry,
    // a medical question) and the console is shared with every other script.
    console.log('[ai] run called: prompt=' + (typeof prompt === 'string' ? prompt.length : 0) + ' chars' +
      (options.image ? ', image' : '') + (options.images?.length ? ', images=' + options.images.length : '') +
      (options.pdfs?.length ? ', pdfs=' + options.pdfs.length : '') + (options.json ? ', json' : ''))
    const data = await callAi({ prompt, stream: false, ...options }, 'AI request failed')
    console.log('[ai] run result: text=' + (data.text?.length || 0) + ' chars, images=' + (data.images?.length || 0))
    return data
  },

  /**
   * Stream an AI response for progressive text display.
   * The server answers in one piece (it does not stream), so the returned
   * stream yields the whole text once, then closes — API unchanged.
   * @param {string} prompt - The prompt to send
   * @param {object} [options] - Optional config
   * @returns {Promise<ReadableStream>}
   * @example const stream = await ai.stream("Tell me a story")
   */
  async stream(prompt, options = {}) {
    console.log('[ai] stream called: prompt=' + (typeof prompt === 'string' ? prompt.length : 0) + ' chars')
    const data = await callAi({ prompt, stream: true, ...options }, 'AI stream failed')
    console.log('[ai] stream connected')
    const text = typeof data?.text === 'string' ? data.text : ''
    const bytes = new TextEncoder().encode(text)
    return new ReadableStream({
      start(controller) {
        if (bytes.length) controller.enqueue(bytes)
        controller.close()
      },
    })
  },

  /**
   * Multi-turn conversation with a persistent persona.
   * Use this when the app's core loop is a running conversation with a
   * consistent "it" across turns (character chat, AI companion, tutor, NPC).
   * For one-shot generation, use ai.run() instead.
   *
   * @param {object} options
   * @param {string} [options.system] - Persona system prompt (stays the same across turns)
   * @param {Array<{role: 'user'|'assistant', content: string}>} options.messages - Conversation history, text-only
   * @returns {Promise<{ text: string }>}
   * @example
   *   const reply = await ai.chat({
   *     system: "You are Mira, a patient Spanish teacher from Madrid.",
   *     messages: [
   *       { role: 'user', content: 'hola' },
   *       { role: 'assistant', content: '¡Hola! ¿Cómo estás hoy?' },
   *       { role: 'user', content: 'bien, y tú?' },
   *     ],
   *   })
   *   // reply.text === "Muy bien, gracias por preguntar ..."
   */
  async chat({ system, messages } = {}) {
    const msgCount = Array.isArray(messages) ? messages.length : 0
    console.log('[ai] chat called: system=' + (system?.length || 0) + ' chars, messages=' + msgCount)
    const data = await callAi({ system, messages }, 'AI chat failed')
    console.log('[ai] chat result: text=' + (data.text?.length || 0) + ' chars')
    return data
  }
}
