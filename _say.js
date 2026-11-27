/**
 * What a person reads when an SDK call fails (2026-11-09): `err.say`, one sentence in the
 * app's language (resolveFaceLang — en / ar / pt / es).
 *
 * Why: the server's sentence (err.message) is written for the builder, in English, about our
 * rules, and apps put it on screen: an Arabic game's players read «Only the app owner or a team
 * admin (signed in) can schedule…» (11-06). Every server code names the KIND of sentence a person
 * should read instead (`say` in the envelope; src/lib/runtime-error.ts SAY_KINDS), and this
 * table words each kind once per language. An answer that names no kind (an older server, the
 * data route's refusals) is read by its status; no answer at all is a network error or a
 * time-out. An error the SDK makes itself may name its kind (sdkError's `say`).
 *
 * The sentences reuse the faces' own words where one exists (TeamLogin's genericError and
 * offline). No DOM at module scope: the unit test loads it in plain node.
 */
import { resolveFaceLang } from './_lang.js'

export const SAY_TEXT = {
  en: {
    'sign-in': 'Log in to continue.',
    'not-allowed': "You don't have permission to do this.",
    limit: 'Limit reached. Try again later.',
    'too-large': 'This file is too large.',
    changed: 'This was changed or removed. Refresh and try again.',
    unavailable: "This isn't available right now.",
    invalid: "That isn't valid. Check it and try again.",
    retry: 'Something went wrong. Please try again.',
    offline: 'Network error — check your connection and try again.',
  },
  ar: {
    'sign-in': 'سجّل الدخول للمتابعة.',
    'not-allowed': 'ليست لديك صلاحية للقيام بهذا.',
    limit: 'تم بلوغ الحد. حاول مرة أخرى لاحقًا.',
    'too-large': 'هذا الملف كبير جدًا.',
    changed: 'تم تغيير هذا أو حذفه. حدّث الصفحة وحاول مرة أخرى.',
    unavailable: 'هذا غير متاح الآن.',
    invalid: 'هذا غير صالح. تحقّق منه وحاول مرة أخرى.',
    retry: 'حدث خطأ ما. حاول مرة أخرى.',
    offline: 'خطأ في الشبكة — تحقّق من الاتصال وحاول مرة أخرى.',
  },
  pt: {
    'sign-in': 'Entre para continuar.',
    'not-allowed': 'Você não tem permissão para fazer isso.',
    limit: 'Limite atingido. Tente de novo mais tarde.',
    'too-large': 'Este arquivo é grande demais.',
    changed: 'Isto foi alterado ou removido. Atualize e tente de novo.',
    unavailable: 'Isto não está disponível agora.',
    invalid: 'Isso não é válido. Confira e tente de novo.',
    retry: 'Algo deu errado. Tente de novo.',
    offline: 'Erro de rede — verifique sua conexão e tente de novo.',
  },
  es: {
    'sign-in': 'Inicia sesión para continuar.',
    'not-allowed': 'No tienes permiso para hacer esto.',
    limit: 'Se alcanzó el límite. Inténtalo de nuevo más tarde.',
    'too-large': 'Este archivo es demasiado grande.',
    changed: 'Esto se cambió o se eliminó. Actualiza e inténtalo de nuevo.',
    unavailable: 'Esto no está disponible ahora.',
    invalid: 'Eso no es válido. Revísalo e inténtalo de nuevo.',
    retry: 'Algo salió mal. Inténtalo de nuevo.',
    offline: 'Error de red — revisa tu conexión e inténtalo de nuevo.',
  },
}

const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k)

/**
 * The kind of sentence for one failure: the kind the SDK itself named, else the envelope's,
 * else — when the server never answered — the network's or a retry, else by status.
 * @param {{ status?: number, code?: string, body?: any, say?: string }} f
 */
export function sayKindOf(f) {
  const x = f || {}
  if (own(SAY_TEXT.en, x.say)) return x.say
  const told = x.body && typeof x.body === 'object' ? x.body.say : undefined
  if (own(SAY_TEXT.en, told)) return told
  const status = typeof x.status === 'number' ? x.status : 0
  if (!status) return x.code === 'NETWORK' ? 'offline' : 'retry'
  if (status === 401) return 'sign-in'
  if (status === 403) return 'not-allowed'
  if (status === 404 || status === 409 || status === 410) return 'changed'
  if (status === 413) return 'too-large'
  if (status === 429) return 'limit'
  return 'retry'
}

/** The sentence a person reads for one failure, in `lang` (default: the app's language now). Never throws. */
export function sayFor(f, lang) {
  let l = lang
  if (!l) { try { l = resolveFaceLang() } catch { l = 'en' } }
  const table = own(SAY_TEXT, l) ? SAY_TEXT[l] : SAY_TEXT.en
  return table[sayKindOf(f)] || SAY_TEXT.en.retry
}
