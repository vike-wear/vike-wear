/**
 * _device-words.js — what the platform's device components (BarcodeScanner,
 * FaceCamera, PoseCamera, GestureCamera, MapView) tell a visitor while they
 * start, when they cannot, and where they are: in every face language
 * (_lang.js, 2026-11-09). These lines were English for every visitor.
 *
 * English stays exactly what the components showed before. The progress lines
 * the SDK reports (barcode.scan / face / pose / gesture `onProgress`) stay
 * English at the source — an app may read them — and are translated here, on
 * the way to the screen. A failure shows the SDK's own message in English and
 * one plain sentence, by what went wrong, in the other languages (the console
 * keeps the technical message for the owner).
 *
 * No import.meta, no DOM at module scope: loadable in plain node.
 */

import { resolveFaceLang } from './_lang.js'

// Keyed by the English line the components / the SDK use.
const PROGRESS = {
  'Preparing…': { ar: 'جارٍ التحضير…', pt: 'Preparando…', es: 'Preparando…' },
  'Opening camera…': { ar: 'جارٍ فتح الكاميرا…', pt: 'Abrindo a câmera…', es: 'Abriendo la cámara…' },
  'Loading barcode reader…': { ar: 'جارٍ تحميل قارئ الباركود…', pt: 'Carregando o leitor de código de barras…', es: 'Cargando el lector de códigos de barras…' },
  'Loading AI library…': { ar: 'جارٍ تحميل مكتبة الذكاء الاصطناعي…', pt: 'Carregando a biblioteca de IA…', es: 'Cargando la biblioteca de IA…' },
  'Requesting camera access…': { ar: 'جارٍ طلب إذن الكاميرا…', pt: 'Pedindo acesso à câmera…', es: 'Pidiendo acceso a la cámara…' },
  'Initializing AI engine…': { ar: 'جارٍ تشغيل محرك الذكاء الاصطناعي…', pt: 'Iniciando o mecanismo de IA…', es: 'Iniciando el motor de IA…' },
  'Downloading face model…': { ar: 'جارٍ تنزيل نموذج الوجه…', pt: 'Baixando o modelo de rosto…', es: 'Descargando el modelo de rostro…' },
  'Downloading pose model…': { ar: 'جارٍ تنزيل نموذج وضعية الجسم…', pt: 'Baixando o modelo de postura…', es: 'Descargando el modelo de postura…' },
  'Downloading gesture model…': { ar: 'جارٍ تنزيل نموذج الإيماءات…', pt: 'Baixando o modelo de gestos…', es: 'Descargando el modelo de gestos…' },
}

const WORDS = {
  en: { retry: 'Retry', youAreHere: 'You are here' },
  ar: { retry: 'إعادة المحاولة', youAreHere: 'أنت هنا' },
  pt: { retry: 'Tentar de novo', youAreHere: 'Você está aqui' },
  es: { retry: 'Reintentar', youAreHere: 'Estás aquí' },
}

const FAILURE = {
  camera: {
    ar: 'تعذّر فتح الكاميرا. اسمح بالوصول إلى الكاميرا ثم حاول مرة أخرى.',
    pt: 'Não foi possível abrir a câmera. Permita o acesso à câmera e tente de novo.',
    es: 'No se pudo abrir la cámara. Permite el acceso a la cámara e inténtalo de nuevo.',
  },
  unsupported: {
    ar: 'هذا المتصفح لا يدعم هذه الميزة. جرّب متصفحًا آخر.',
    pt: 'Este navegador não suporta este recurso. Tente outro navegador.',
    es: 'Este navegador no admite esta función. Prueba con otro navegador.',
  },
  other: {
    ar: 'تعذّر التشغيل. تحقّق من اتصالك ثم حاول مرة أخرى.',
    pt: 'Não foi possível iniciar. Verifique sua conexão e tente de novo.',
    es: 'No se pudo iniciar. Revisa tu conexión e inténtalo de nuevo.',
  },
}

/** What went wrong, read off the SDK's message. Pure; exported for the test. */
export function deviceFailureKind(message) {
  const m = String(message || '')
  if (/not supported/i.test(m)) return 'unsupported'
  if (/camera|permission|denied|NotAllowed|NotFound|NotReadable|getUserMedia/i.test(m)) return 'camera'
  return 'other'
}

/** The words of the device components in a face language (default: the face language now). */
export function deviceWords(lang = resolveFaceLang()) {
  return WORDS[lang] || WORDS.en
}

/** A progress line on its way to the screen: English as the SDK said it, else its translation. */
export function deviceProgressText(text, lang = resolveFaceLang()) {
  const t = PROGRESS[text]
  return (t && t[lang]) || text
}

/** A failure on its way to the screen: the SDK's message in English, else one plain sentence. */
export function deviceFailureText(message, lang = resolveFaceLang()) {
  const sentence = FAILURE[deviceFailureKind(message)][lang]
  return sentence || message
}
