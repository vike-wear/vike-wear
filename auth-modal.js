import { getAnonymousId } from './user'
import { storeGet, storeSet, storeRemove } from './_session-store'
import { setSupabaseToken, clearSupabaseToken } from './_supabase-token'
import { brandIdentity, brandingHidden, brandingKnown, brandingSettled, refreshBranding } from './_branding'
import { currentReturnPath } from './_oauth-return'
import { sdkFetch } from './_fetch'
import { getAuthHeaders } from './_headers'
import { throwFromResponse } from './_errors'
import { resolveFaceLang, isRtlLang } from './_lang.js'
import { hostOwnerHint, requestOwnerSession } from './_host-bridge'
import { credentialsInPage, openCredentialsFrame, warmCredentialsFrame } from './_credentials-frame'
import { markFieldKeys } from './_field-keys'

const API_BASE = import.meta.env.VITE_API_BASE || ''

const TOKEN_KEY = '__whacka_auth_token'
const USER_KEY = '__whacka_auth_user'

const VIEWS = { LOGIN: 'login', SIGNUP: 'signup', FORGOT: 'forgot', ACCOUNT: 'account', DELETE_CONFIRM: 'deleteConfirm' }
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID

// UI strings. Language = resolveFaceLang() (_lang.js — the one cascade every
// platform face shares since 2026-09-28), read at OPEN time because apps set
// documentElement.dir/lang during their own boot, after this module loads.
// The modal never shows a server's text: what the server names (a sign-in
// `reason`, a sign-up or reset `code`) picks one of these sentences, anything
// else is somethingWrong.
const STRINGS = {
  en: {
    googleContinue: 'Continue with Google',
    googleTip: 'Google sign-in works on the published app.',
    googleNativeUpdate: 'Update the app to use Google sign-in, or continue with email below.',
    appleContinue: 'Continue with Apple',
    appleTip: 'Apple sign-in works on the published app.',
    appleNativeUpdate: 'Update the app to use Apple sign-in, or continue with email below.',
    ownerContext: 'This is your Whacka account — the same one you use on whacka.app to build this app. There is no separate admin password.',
    ownerPreviewLead: 'You own this app.',
    ownerPreviewLink: 'Continue as owner →',
    ownerPreviewFailed: "Couldn't sign you in as the owner. Try again.",
    ownerWrongAccount: "This account doesn't own this app. To manage it, sign out and use the account you build with on whacka.app.",
    googleFailHint: 'Signed up with Google or Apple? Use those buttons above — that account has no password here.',
    reasonOauthOnly: 'This account uses Google or Apple sign-in.',
    reasonNoAccount: 'No account with this email.',
    reasonWrongPassword: 'Wrong password.',
    emailTaken: 'This email already has an account.',
    invalidEmail: 'Enter a valid email address.',
    sendFailed: "Couldn't send the email. Try again.",
    enterPassword: 'Enter your password, or use Google or Apple above.',
    inAppBrowser: 'To use Google, open this page in your browser.',
    credFrameFailed: "Couldn't load the sign-in form. Try again, or use Google or Apple above.",
    tryAgain: 'Try again',
    email: 'Email',
    emailPlaceholder: 'you@example.com',
    password: 'Password',
    passwordPlaceholder: 'Your password',
    signupPasswordPlaceholder: 'Min. 6 characters',
    displayName: 'Display name',
    optional: '(optional)',
    displayNamePlaceholder: 'How others see you',
    forgotLink: 'Forgot password?',
    logIn: 'Log in',
    createAccount: 'Create account',
    sendReset: 'Send reset link',
    noAccount: "Don't have an account?",
    signUp: 'Sign up',
    haveAccount: 'Already have an account?',
    backToLogin: 'Back to login',
    titleForgot: 'Reset your password',
    titleLogin: 'Welcome back',
    titleSignup: 'Create your account',
    fillAll: 'Please fill in all fields.',
    invalidCreds: 'Invalid credentials',
    needEmailPassword: 'Email and password are required.',
    passwordMin: 'Password must be at least 6 characters.',
    couldNotCreate: 'Could not create account',
    enterEmail: 'Please enter your email.',
    somethingWrong: 'Something went wrong',
    resetSent: 'Check your email for a reset link.',
    pleaseWait: 'Please wait…',
    // Server-priced when the credits 429 payload carries the free daily grant
    // (pricing.freeDaily); the literal is the fallback for older servers so
    // published bundles never advertise a stale number.
    creditsBanner: (n) => n
      ? `⚡ Sign up free for ${n} credits/day — 2× more!`
      : '⚡ Sign up free for 8 credits/day — 2× more!',
    close: 'Close',
    poweredBy: 'Powered by <span>Whacka</span>',
    // Account sheet (signed-in state) — the platform-guaranteed always-there
    // Sign out / Delete account surface (Apple 5.1.1(v)).
    titleAccount: 'Your account',
    signedInAs: 'Signed in as',
    signOutBtn: 'Sign out',
    deleteAccountLink: 'Delete my account in this app',
    titleDeleteConfirm: 'Delete account?',
    deleteWarnBody: 'This permanently deletes your account in this app: your private data, notifications, and membership here. Content you shared with others in the app may remain. If this is the only app where you use this Whacka ID, the ID itself is deleted too.',
    deleteConfirmBtn: 'Permanently delete',
    deleteKeep: 'Keep my account',
    deleteFailed: 'Could not delete the account — try again.',
    // A team login's sheet: Sign out and this line, no delete.
    teamLoginManaged: 'Your admin manages this account.',
  },
  ar: {
    googleContinue: 'المتابعة عبر Google',
    googleTip: 'تسجيل الدخول عبر Google يعمل في التطبيق المنشور.',
    googleNativeUpdate: 'حدّث التطبيق لاستخدام تسجيل الدخول عبر Google، أو تابع بالبريد الإلكتروني أدناه.',
    appleContinue: 'المتابعة عبر Apple',
    appleTip: 'تسجيل الدخول عبر Apple يعمل في التطبيق المنشور.',
    appleNativeUpdate: 'حدّث التطبيق لاستخدام تسجيل الدخول عبر Apple، أو تابع بالبريد الإلكتروني أدناه.',
    ownerContext: 'هذا حسابك في Whacka — نفس الحساب الذي تبني به هذا التطبيق على whacka.app. لا توجد كلمة مرور «مدير» منفصلة.',
    ownerPreviewLead: 'أنت مالك هذا التطبيق.',
    ownerPreviewLink: 'المتابعة كمالك ←',
    ownerPreviewFailed: 'تعذّر تسجيل دخولك كمالك. حاول مرة أخرى.',
    ownerWrongAccount: 'هذا الحساب لا يملك هذا التطبيق. لإدارته، سجّل الخروج وادخل بالحساب الذي تبني به على whacka.app.',
    googleFailHint: 'سجّلت عبر Google أو Apple؟ استخدم الأزرار أعلاه — هذا الحساب ليس له كلمة مرور هنا.',
    reasonOauthOnly: 'هذا الحساب يسجّل الدخول عبر Google أو Apple.',
    reasonNoAccount: 'لا يوجد حساب بهذا البريد.',
    reasonWrongPassword: 'كلمة المرور غير صحيحة.',
    emailTaken: 'يوجد حساب بهذا البريد بالفعل.',
    invalidEmail: 'أدخل بريدًا إلكترونيًا صحيحًا.',
    sendFailed: 'تعذّر إرسال البريد. حاول مرة أخرى.',
    enterPassword: 'أدخل كلمة المرور، أو استخدم Google أو Apple في الأعلى.',
    inAppBrowser: 'لاستخدام Google، افتح هذه الصفحة في المتصفح.',
    credFrameFailed: 'تعذّر تحميل نموذج تسجيل الدخول. حاول مرة أخرى، أو استخدم Google أو Apple في الأعلى.',
    tryAgain: 'حاول مرة أخرى',
    email: 'البريد الإلكتروني',
    emailPlaceholder: 'you@example.com',
    password: 'كلمة المرور',
    passwordPlaceholder: 'كلمة المرور',
    signupPasswordPlaceholder: '6 أحرف على الأقل',
    displayName: 'الاسم الظاهر',
    optional: '(اختياري)',
    displayNamePlaceholder: 'كيف يراك الآخرون',
    forgotLink: 'نسيت كلمة المرور؟',
    logIn: 'تسجيل الدخول',
    createAccount: 'إنشاء حساب',
    sendReset: 'إرسال رابط إعادة التعيين',
    noAccount: 'ليس لديك حساب؟',
    signUp: 'إنشاء حساب',
    haveAccount: 'لديك حساب بالفعل؟',
    backToLogin: 'العودة لتسجيل الدخول',
    titleForgot: 'إعادة تعيين كلمة المرور',
    titleLogin: 'مرحبًا بعودتك',
    titleSignup: 'أنشئ حسابك',
    fillAll: 'يرجى تعبئة جميع الحقول.',
    invalidCreds: 'بيانات الدخول غير صحيحة',
    needEmailPassword: 'البريد الإلكتروني وكلمة المرور مطلوبان.',
    passwordMin: 'يجب ألا تقل كلمة المرور عن 6 أحرف.',
    couldNotCreate: 'تعذر إنشاء الحساب',
    enterEmail: 'يرجى إدخال بريدك الإلكتروني.',
    somethingWrong: 'حدث خطأ ما',
    resetSent: 'تحقق من بريدك الإلكتروني للحصول على رابط إعادة التعيين.',
    pleaseWait: 'يرجى الانتظار…',
    creditsBanner: (n) => n
      ? `⚡ سجّل مجانًا واحصل على ${n} رصيد يوميًا — الضعف!`
      : '⚡ سجّل مجانًا واحصل على 8 رصيد يوميًا — الضعف!',
    close: 'إغلاق',
    poweredBy: 'مقدَّم من <span>Whacka</span>',
    titleAccount: 'حسابك',
    signedInAs: 'مسجّل الدخول باسم',
    signOutBtn: 'تسجيل الخروج',
    deleteAccountLink: 'حذف حسابي في هذا التطبيق',
    titleDeleteConfirm: 'حذف الحساب؟',
    deleteWarnBody: 'سيؤدي هذا إلى حذف حسابك في هذا التطبيق نهائيًا: بياناتك الخاصة والإشعارات وعضويتك هنا. قد يبقى المحتوى الذي شاركته مع الآخرين في التطبيق. إذا كان هذا هو التطبيق الوحيد الذي تستخدم فيه معرف Whacka الخاص بك، فسيُحذف المعرف نفسه أيضًا.',
    deleteConfirmBtn: 'حذف نهائي',
    deleteKeep: 'الاحتفاظ بحسابي',
    deleteFailed: 'تعذر حذف الحساب — حاول مرة أخرى.',
    teamLoginManaged: 'هذا الحساب يديره المسؤول عنك.',
  },
  pt: {
    googleContinue: 'Continuar com o Google',
    googleTip: 'O login com o Google funciona no app publicado.',
    googleNativeUpdate: 'Atualize o app para entrar com o Google, ou continue com e-mail abaixo.',
    appleContinue: 'Continuar com a Apple',
    appleTip: 'O login com a Apple funciona no app publicado.',
    appleNativeUpdate: 'Atualize o app para entrar com a Apple, ou continue com e-mail abaixo.',
    ownerContext: 'Esta é a sua conta Whacka — a mesma que você usa em whacka.app para criar este app. Não existe uma senha de administrador separada.',
    ownerPreviewLead: 'Este app é seu.',
    ownerPreviewLink: 'Continuar como dono →',
    ownerPreviewFailed: 'Não foi possível entrar como dono. Tente de novo.',
    ownerWrongAccount: 'Esta conta não é dona deste app. Para gerenciá-lo, saia e entre com a conta que você usa para criar em whacka.app.',
    googleFailHint: 'Criou a conta com o Google ou a Apple? Use esses botões acima — essa conta não tem senha aqui.',
    reasonOauthOnly: 'Esta conta entra com o Google ou a Apple.',
    reasonNoAccount: 'Não existe conta com este e-mail.',
    reasonWrongPassword: 'Senha incorreta.',
    emailTaken: 'Este e-mail já tem uma conta.',
    invalidEmail: 'Digite um e-mail válido.',
    sendFailed: 'Não foi possível enviar o e-mail. Tente de novo.',
    enterPassword: 'Digite sua senha, ou use o Google ou a Apple acima.',
    inAppBrowser: 'Para usar o Google, abra esta página no seu navegador.',
    credFrameFailed: 'Não foi possível carregar o formulário de login. Tente de novo, ou use o Google ou a Apple acima.',
    tryAgain: 'Tentar de novo',
    email: 'E-mail',
    emailPlaceholder: 'voce@exemplo.com',
    password: 'Senha',
    passwordPlaceholder: 'Sua senha',
    signupPasswordPlaceholder: 'Mín. 6 caracteres',
    displayName: 'Nome de exibição',
    optional: '(opcional)',
    displayNamePlaceholder: 'Como os outros veem você',
    forgotLink: 'Esqueceu a senha?',
    logIn: 'Entrar',
    createAccount: 'Criar conta',
    sendReset: 'Enviar link de redefinição',
    noAccount: 'Não tem uma conta?',
    signUp: 'Criar conta',
    haveAccount: 'Já tem uma conta?',
    backToLogin: 'Voltar para o login',
    titleForgot: 'Redefina sua senha',
    titleLogin: 'Olá de novo',
    titleSignup: 'Crie sua conta',
    fillAll: 'Preencha todos os campos.',
    invalidCreds: 'Dados de login inválidos',
    needEmailPassword: 'E-mail e senha são obrigatórios.',
    passwordMin: 'A senha precisa ter pelo menos 6 caracteres.',
    couldNotCreate: 'Não foi possível criar a conta',
    enterEmail: 'Digite seu e-mail.',
    somethingWrong: 'Algo deu errado',
    resetSent: 'Confira no seu e-mail o link de redefinição.',
    pleaseWait: 'Aguarde…',
    creditsBanner: (n) => n
      ? `⚡ Crie sua conta grátis e ganhe ${n} créditos/dia — 2× mais!`
      : '⚡ Crie sua conta grátis e ganhe 8 créditos/dia — 2× mais!',
    close: 'Fechar',
    poweredBy: 'Com tecnologia de <span>Whacka</span>',
    titleAccount: 'Sua conta',
    signedInAs: 'Conectado como',
    signOutBtn: 'Sair',
    deleteAccountLink: 'Excluir minha conta neste app',
    titleDeleteConfirm: 'Excluir a conta?',
    deleteWarnBody: 'Isto exclui para sempre a sua conta neste app: seus dados privados, notificações e participação aqui. O conteúdo que você compartilhou com outras pessoas no app pode continuar. Se este for o único app em que você usa este Whacka ID, o próprio ID também será excluído.',
    deleteConfirmBtn: 'Excluir para sempre',
    deleteKeep: 'Manter minha conta',
    deleteFailed: 'Não foi possível excluir a conta — tente de novo.',
    teamLoginManaged: 'Esta conta é gerenciada pelo seu administrador.',
  },
  es: {
    googleContinue: 'Continuar con Google',
    googleTip: 'El inicio de sesión con Google funciona en la app publicada.',
    googleNativeUpdate: 'Actualiza la app para iniciar sesión con Google, o continúa con tu correo abajo.',
    appleContinue: 'Continuar con Apple',
    appleTip: 'El inicio de sesión con Apple funciona en la app publicada.',
    appleNativeUpdate: 'Actualiza la app para iniciar sesión con Apple, o continúa con tu correo abajo.',
    ownerContext: 'Esta es tu cuenta de Whacka — la misma que usas en whacka.app para crear esta app. No hay una contraseña de administrador aparte.',
    ownerPreviewLead: 'Esta app es tuya.',
    ownerPreviewLink: 'Continuar como dueño →',
    ownerPreviewFailed: 'No se pudo iniciar sesión como dueño. Inténtalo de nuevo.',
    ownerWrongAccount: 'Esta cuenta no es dueña de esta app. Para administrarla, cierra sesión y entra con la cuenta con la que creas en whacka.app.',
    googleFailHint: '¿Te registraste con Google o Apple? Usa esos botones de arriba — esa cuenta no tiene contraseña aquí.',
    reasonOauthOnly: 'Esta cuenta inicia sesión con Google o Apple.',
    reasonNoAccount: 'No hay ninguna cuenta con este correo.',
    reasonWrongPassword: 'Contraseña incorrecta.',
    emailTaken: 'Este correo ya tiene una cuenta.',
    invalidEmail: 'Escribe un correo válido.',
    sendFailed: 'No se pudo enviar el correo. Inténtalo de nuevo.',
    enterPassword: 'Escribe tu contraseña, o usa Google o Apple arriba.',
    inAppBrowser: 'Para usar Google, abre esta página en tu navegador.',
    credFrameFailed: 'No se pudo cargar el formulario de inicio de sesión. Inténtalo de nuevo, o usa Google o Apple arriba.',
    tryAgain: 'Intentar de nuevo',
    email: 'Correo',
    emailPlaceholder: 'tu@ejemplo.com',
    password: 'Contraseña',
    passwordPlaceholder: 'Tu contraseña',
    signupPasswordPlaceholder: 'Mín. 6 caracteres',
    displayName: 'Nombre visible',
    optional: '(opcional)',
    displayNamePlaceholder: 'Cómo te ven los demás',
    forgotLink: '¿Olvidaste tu contraseña?',
    logIn: 'Iniciar sesión',
    createAccount: 'Crear cuenta',
    sendReset: 'Enviar enlace para restablecer',
    noAccount: '¿No tienes cuenta?',
    signUp: 'Crear cuenta',
    haveAccount: '¿Ya tienes cuenta?',
    backToLogin: 'Volver a iniciar sesión',
    titleForgot: 'Restablece tu contraseña',
    titleLogin: 'Hola de nuevo',
    titleSignup: 'Crea tu cuenta',
    fillAll: 'Completa todos los campos.',
    invalidCreds: 'Datos de acceso incorrectos',
    needEmailPassword: 'El correo y la contraseña son obligatorios.',
    passwordMin: 'La contraseña debe tener al menos 6 caracteres.',
    couldNotCreate: 'No se pudo crear la cuenta',
    enterEmail: 'Escribe tu correo.',
    somethingWrong: 'Algo salió mal',
    resetSent: 'Revisa tu correo para ver el enlace de restablecimiento.',
    pleaseWait: 'Espera un momento…',
    creditsBanner: (n) => n
      ? `⚡ Crea tu cuenta gratis y obtén ${n} créditos al día — ¡2× más!`
      : '⚡ Crea tu cuenta gratis y obtén 8 créditos al día — ¡2× más!',
    close: 'Cerrar',
    poweredBy: 'Con tecnología de <span>Whacka</span>',
    titleAccount: 'Tu cuenta',
    signedInAs: 'Sesión iniciada como',
    signOutBtn: 'Cerrar sesión',
    deleteAccountLink: 'Eliminar mi cuenta en esta app',
    titleDeleteConfirm: '¿Eliminar la cuenta?',
    deleteWarnBody: 'Esto elimina para siempre tu cuenta en esta app: tus datos privados, notificaciones y membresía aquí. El contenido que compartiste con otras personas en la app puede quedarse. Si esta es la única app en la que usas este Whacka ID, también se elimina el ID.',
    deleteConfirmBtn: 'Eliminar para siempre',
    deleteKeep: 'Conservar mi cuenta',
    deleteFailed: 'No se pudo eliminar la cuenta — inténtalo de nuevo.',
    teamLoginManaged: 'Tu administrador gestiona esta cuenta.',
  },
}

/** The language a table is (its identity: `T` is always one of STRINGS' own tables). */
function langOfTable(T) {
  return Object.keys(STRINGS).find((k) => STRINGS[k] === T) || 'en'
}

// White-label (2026-09-28): under a hidden brand (the Pro/Ultra "Remove Whacka
// branding" switch that also hides the logo + footer) the three sentences that
// name the Whacka ID say "this account" instead. Overlaid on the VIEW strings
// only — `T` itself stays the plain table (its identity tells the modal its
// language).
const STRINGS_NOBRAND = {
  en: {
    ownerContext: 'This is the account you build this app with. There is no separate admin password.',
    ownerWrongAccount: "This account doesn't own this app. Sign out and use the account you build it with.",
    deleteWarnBody: 'This permanently deletes your account in this app: your private data, notifications, and membership here. Content you shared with others in the app may remain. If this is the only app where you use this account, the account itself is deleted too.',
  },
  ar: {
    ownerContext: 'هذا هو الحساب الذي تبني به هذا التطبيق. لا توجد كلمة مرور «مدير» منفصلة.',
    ownerWrongAccount: 'هذا الحساب لا يملك هذا التطبيق. سجّل الخروج وادخل بالحساب الذي تبني به التطبيق.',
    deleteWarnBody: 'سيؤدي هذا إلى حذف حسابك في هذا التطبيق نهائيًا: بياناتك الخاصة والإشعارات وعضويتك هنا. قد يبقى المحتوى الذي شاركته مع الآخرين في التطبيق. إذا كان هذا هو التطبيق الوحيد الذي تستخدم فيه هذا الحساب، فسيُحذف الحساب نفسه أيضًا.',
  },
  pt: {
    ownerContext: 'Esta é a conta com que você cria este app. Não existe uma senha de administrador separada.',
    ownerWrongAccount: 'Esta conta não é dona deste app. Saia e entre com a conta com que você o cria.',
    deleteWarnBody: 'Isto exclui para sempre a sua conta neste app: seus dados privados, notificações e participação aqui. O conteúdo que você compartilhou com outras pessoas no app pode continuar. Se este for o único app em que você usa esta conta, a própria conta também será excluída.',
  },
  es: {
    ownerContext: 'Esta es la cuenta con la que creas esta app. No hay una contraseña de administrador aparte.',
    ownerWrongAccount: 'Esta cuenta no es dueña de esta app. Cierra sesión y entra con la cuenta con la que la creas.',
    deleteWarnBody: 'Esto elimina para siempre tu cuenta en esta app: tus datos privados, notificaciones y membresía aquí. El contenido que compartiste con otras personas en la app puede quedarse. Si esta es la única app en la que usas esta cuenta, también se elimina la cuenta.',
  },
}

function resolveAppPrimary() {
  try {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-primary').trim()
    if (!raw) return null
    const parts = raw.split(/\s+/).map(Number)
    if (parts.length !== 3 || parts.some(isNaN)) return null
    const [r, g, b] = parts
    const hex = v => v.toString(16).padStart(2, '0')
    const clamp = v => Math.max(0, Math.min(255, Math.round(v)))
    return {
      primary: `#${hex(r)}${hex(g)}${hex(b)}`,
      hover: `#${hex(clamp(r * 0.8))}${hex(clamp(g * 0.8))}${hex(clamp(b * 0.8))}`,
      light: `#${hex(clamp(r + (255 - r) * 0.88))}${hex(clamp(g + (255 - g) * 0.88))}${hex(clamp(b + (255 - b) * 0.88))}`,
    }
  } catch { return null }
}

// Brand font loads via ONE document-level <link> (injected at first open) —
// not an @import inside each shadow root's stylesheet: @font-face from
// document CSS reaches shadow content, so rendering is identical, while the
// fetch is deduped across opens, never re-parsed per shadow root, and
// decoupled from the shadow sheet entirely (on networks where
// fonts.googleapis is slow or blocked — mainland China — the modal owes the
// font nothing; system-ui swaps in via display=swap).
const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap'
function ensureBrandFont() {
  try {
    if (document.getElementById('wk-auth-font')) return
    const link = document.createElement('link')
    link.id = 'wk-auth-font'
    link.rel = 'stylesheet'
    link.href = FONT_HREF
    document.head.appendChild(link)
  } catch { /* font is cosmetic */ }
}

const STYLES = `
  :host {
    /* v6 Riso paper system */
    --wk-bg: #FFFFFF;
    --wk-cream: #F1EFE8;
    --wk-line: rgba(36,56,184,0.25);
    --wk-line-soft: rgba(36,56,184,0.15);
    --wk-ink: #20255C;
    --wk-ink-soft: #5A5F96;
    --wk-ink-mute: #5A5F96;
    --wk-ink-faint: #8A8EB8;

    /* brand accents (fixed) */
    --wk-accent: #FF4FA3;          /* pink action */
    --wk-hl: rgba(255,79,163,0.35);              /* highlighter */
    --wk-purple: #2438B8;
    --wk-danger: #C0382B;

    /* themeable CTA — host app overrides these (defaults to v5 ink) */
    --wk-primary: #2438B8;
    --wk-primary-hover: #1C2C94;
    --wk-primary-light: rgba(22, 19, 14, 0.13);

    --wk-overlay: rgba(20, 16, 6, 0.42);
    --wk-radius-card: 6px;
    --wk-radius: 4px;
    --wk-font: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI',
      Roboto, 'Helvetica Neue', Arial, sans-serif;

    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Clear notch / home indicator in standalone PWAs (env() is 0 elsewhere). */
    padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
      max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    font-family: var(--wk-font);
    color: var(--wk-ink);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  .overlay {
    position: fixed;
    inset: 0;
    background: var(--wk-overlay);
    backdrop-filter: blur(5px) saturate(115%);
    -webkit-backdrop-filter: blur(5px) saturate(115%);
    animation: wk-fade-in 0.22s ease both;
  }

  @keyframes wk-fade-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes wk-pop {
    from { opacity: 0; transform: translateY(16px) scale(0.985); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes wk-spin { to { transform: rotate(360deg); } }

  .card {
    position: relative;
    width: 100%;
    max-width: 360px;
    margin: auto;
    background: var(--wk-bg);
    border: 1px solid var(--wk-line);
    border-radius: var(--wk-radius-card);
    box-shadow:
      0 1px 1px rgba(28, 18, 8, 0.04),
      0 30px 64px -34px rgba(28, 18, 8, 0.55),
      0 8px 22px -14px rgba(20, 16, 6, 0.20);
    animation: wk-pop 0.30s cubic-bezier(0.22, 1, 0.36, 1) both;
    overflow: hidden;
  }

  .card-body { padding: 22px 24px 16px; }

  .close-btn {
    position: absolute;
    top: 14px;
    inset-inline-end: 14px;
    width: 34px;
    height: 34px;
    border: 1px solid var(--wk-line);
    background: var(--wk-cream);
    cursor: pointer;
    border-radius: 999px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--wk-ink-mute);
    font-size: 15px;
    line-height: 1;
    transition: background 0.18s, color 0.18s, border-color 0.18s;
  }
  .close-btn:hover { background: var(--wk-ink); color: #fff; border-color: var(--wk-ink); }

  /* ── v5 logo: mark + lowercase wordmark ── */
  .logo {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 10px;
  }
  .logo svg { display: block; flex-shrink: 0; overflow: visible; }
  .logo-word { font-size: 23px; font-weight: 800; letter-spacing: -0.03em; color: var(--wk-ink); line-height: 1; }

  /* ── "Your brand" (Ultra, W3 2026-10-28): the app's own icon + name in the
     logo row's place — the look of the private-app lock and the reset page ── */
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; min-width: 0; padding-inline-end: 32px; }
  .brand-icon { display: block; width: 36px; height: 36px; border-radius: 9px; object-fit: cover; flex-shrink: 0; }
  .brand-name { min-width: 0; font-size: 19px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.2; color: var(--wk-ink); overflow-wrap: anywhere; }

  .title {
    text-align: start;
    font-size: 20px;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.08;
    color: var(--wk-ink);
    margin-bottom: 12px;
  }
  .title:empty { display: none; }

  .view { display: none; }
  .view.active { display: block; }
  .view-transition { animation: wk-fade-in 0.18s ease both; }

  label {
    display: block;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.005em;
    margin-bottom: 6px;
    color: var(--wk-ink-soft);
  }

  input {
    display: block;
    width: 100%;
    height: 44px;
    padding: 0 14px;
    font-size: 14.5px;
    font-weight: 500;
    font-family: var(--wk-font);
    color: var(--wk-ink);
    background: var(--wk-cream);
    border: 1.5px solid var(--wk-line);
    border-radius: var(--wk-radius);
    outline: none;
    transition: border-color 0.18s, box-shadow 0.18s, background 0.18s;
    margin-bottom: 10px;
  }
  input::placeholder { color: var(--wk-ink-mute); font-weight: 500; }
  input:hover { border-color: var(--wk-ink-faint); }
  input:focus {
    background: var(--wk-bg);
    border-color: var(--wk-primary);
    box-shadow: 0 0 0 3px var(--wk-primary-light);
  }

  /* ── primary CTA: v5 dark pill + yellow arrow-circle ── */
  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 48px;
    padding: 0;
    padding-inline: 20px 44px;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.005em;
    font-family: var(--wk-font);
    border: none;
    border-radius: 999px;
    cursor: pointer;
    background: var(--wk-primary);
    color: #fff;
    position: relative;
    margin-top: 6px;
    transition: transform 0.16s cubic-bezier(0.22,1,0.36,1), box-shadow 0.2s ease, background 0.18s ease;
  }
  .btn:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 16px 32px -16px rgba(28, 18, 8, 0.6); }
  .btn:active:not(:disabled) { transform: translateY(0) scale(0.99); }
  .btn:disabled { opacity: 0.7; cursor: not-allowed; }

  .btn::after {
    content: '→';
    position: absolute;
    inset-inline-end: 6px;
    top: 50%;
    transform: translateY(-50%);
    width: 30px;
    height: 30px;
    border-radius: 999px;
    background: var(--wk-accent);
    color: #20255C;
    display: grid;
    place-items: center;
    font-size: 15px;
    font-weight: 700;
    transition: transform 0.2s cubic-bezier(0.22,1,0.36,1);
  }
  .btn:hover:not(:disabled)::after { transform: translateY(-50%) translateX(3px); }
  .btn:disabled::after { opacity: 0; }

  /* RTL: the arrow chip points (and nudges) toward the reading direction. */
  :host([dir='rtl']) .btn::after { content: '←'; }
  :host([dir='rtl']) .btn:hover:not(:disabled)::after { transform: translateY(-50%) translateX(-3px); }

  /* White-label ("Remove Whacka branding", Pro/Ultra): the fixed Whacka-yellow
     accents become theme-neutral so nothing on the card reads as platform brand. */
  :host(.wk-nobrand) .btn::after { background: rgba(255, 255, 255, 0.18); color: #fff; }
  :host(.wk-nobrand) .credits-banner {
    background: var(--wk-cream);
    border-color: var(--wk-line);
  }

  .btn .spinner {
    display: inline-block;
    width: 15px;
    height: 15px;
    border: 2px solid rgba(255,255,255,0.35);
    border-top-color: #fff;
    border-radius: 50%;
    animation: wk-spin 0.6s linear infinite;
    vertical-align: -2px;
    margin-inline-end: 8px;
  }

  /* ── messages ── */
  .error-msg {
    background: #FBEDE9;
    color: var(--wk-danger);
    border: 1px solid #F0CFC6;
    font-size: 12.5px;
    font-weight: 600;
    padding: 9px 12px;
    border-radius: 12px;
    margin-bottom: 12px;
    display: none;
  }
  .error-msg.visible { display: block; }

  .success-msg {
    background: #E8F5EC;
    color: #1B7A45;
    border: 1px solid #CDE8D5;
    font-size: 12.5px;
    font-weight: 600;
    padding: 9px 12px;
    border-radius: 12px;
    margin-bottom: 12px;
    display: none;
  }
  .success-msg.visible { display: block; }

  /* Owner-path context (B19): names the account this modal asks for, and calls
     out a signed-in account that doesn't own the app. */
  .owner-ctx {
    background: var(--wk-cream);
    color: var(--wk-ink);
    border: 1px solid var(--wk-line);
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.5;
    padding: 9px 12px;
    border-radius: 12px;
    margin-bottom: 12px;
  }
  .owner-mismatch {
    background: #FFF6E5;
    color: #8A5A00;
    border: 1px solid #F2DFB8;
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1.5;
    padding: 9px 12px;
    border-radius: 12px;
    margin: 12px 0;
  }

  /* ── switch links ── */
  .links {
    text-align: center;
    margin-top: 16px;
    font-size: 13.5px;
    font-weight: 500;
    color: var(--wk-ink-mute);
  }
  .links a {
    color: var(--wk-primary);
    text-decoration: none;
    cursor: pointer;
    font-weight: 700;
  }
  .links a:hover { text-decoration: underline; }

  .forgot-link {
    display: block;
    text-align: end;
    margin-top: -4px;
    margin-bottom: 12px;
  }
  .forgot-link a {
    color: var(--wk-ink-soft);
    text-decoration: none;
    cursor: pointer;
    font-size: 12.5px;
    font-weight: 600;
  }
  .forgot-link a:hover { color: var(--wk-primary); text-decoration: underline; }

  /* ── footer ── */
  .footer {
    text-align: center;
    padding: 11px 24px;
    background: var(--wk-cream);
    border-top: 1px solid var(--wk-line);
    font-size: 11px;
    letter-spacing: 0.02em;
    font-weight: 500;
    color: var(--wk-ink-mute);
  }
  .footer span { color: var(--wk-ink); font-weight: 800; }

  /* ── reason / credits chip: v5 highlighter ── */
  .credits-banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: color-mix(in oklab, var(--wk-hl) 55%, #fff);
    border: 1.5px solid color-mix(in oklab, var(--wk-accent) 50%, var(--wk-line));
    color: var(--wk-ink);
    border-radius: 14px;
    padding: 10px 13px;
    margin-bottom: 14px;
    text-align: center;
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1.35;
  }

  /* ── Google: brand-neutral white pill (NOT app-themed) ── */
  .wk-google-wrap { position: relative; margin-bottom: 12px; }

  .wk-google {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    height: 46px;
    padding: 0 16px;
    font-size: 14.5px;
    font-weight: 600;
    font-family: var(--wk-font);
    color: #3c4043;
    background: #fff;
    border: 1.5px solid var(--wk-line);
    border-radius: 999px;
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.18s, box-shadow 0.18s, border-color 0.18s;
  }
  .wk-google:hover { background: var(--wk-cream); border-color: var(--wk-ink-faint); box-shadow: 0 2px 6px rgba(28, 18, 8, 0.06); }
  .wk-google:active { background: #F0EADD; }
  .wk-google svg { width: 18px; height: 18px; flex: none; }

  /* ── Apple: solid black pill (Apple's button rules — never app-themed).
     Listed ABOVE Google: App Review checks the privacy option isn't the
     less prominent one (Guideline 4.8). ── */
  .wk-apple {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    height: 46px;
    padding: 0 16px;
    font-size: 14.5px;
    font-weight: 600;
    font-family: var(--wk-font);
    color: #fff;
    background: #000;
    border: 1.5px solid #000;
    border-radius: 999px;
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.18s, box-shadow 0.18s;
  }
  .wk-apple:hover { background: #1d1d1f; box-shadow: 0 2px 6px rgba(28, 18, 8, 0.18); }
  .wk-apple:active { background: #2c2c2e; }
  .wk-apple svg { width: 17px; height: 17px; flex: none; }

  /* ── Google tooltip (preview hint) ── */
  .wk-tip {
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    margin-top: 9px;
    background: #2438B8;
    color: #fff;
    font-size: 12px;
    line-height: 1.4;
    padding: 9px 12px;
    border-radius: 12px;
    text-align: center;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
    opacity: 0;
    transform: translateY(-4px);
    transition: opacity 0.15s ease, transform 0.15s ease;
    pointer-events: none;
    z-index: 10;
  }
  .wk-tip.show { opacity: 1; transform: translateY(0); }
  .wk-tip::before {
    content: '';
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 6px solid transparent;
    border-bottom-color: #2438B8;
  }

  /* very narrow phones: trim the outer breathing room a touch */
  @media (max-width: 360px) {
    :host {
      padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right))
        max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
    }
    .card-body { padding: 22px 20px 16px; }
  }

  /* short viewports / keyboard up: pin to top and allow the host to scroll */
  @media (max-height: 640px) {
    :host {
      align-items: flex-start;
      padding-top: max(14px, env(safe-area-inset-top));
      padding-bottom: max(14px, env(safe-area-inset-bottom));
    }
  }

  /* ── published builds: the e-mail and password fields are the platform's frame
     (credentialsForm, 2026-11-08). It reaches 16px past the content on each side and
     32px below, for the focus ring and the button's shadow, and is pulled back by as
     much: the links below it are drawn over its foot and take their own clicks. ── */
  .wk-cred { position: relative; margin-inline: -16px; }
  .wk-cred.off { display: none; }
  .wk-cred iframe {
    display: block;
    width: 100%;
    height: 269.5px;
    border: 0;
    margin-bottom: -32px;
    background: transparent;
    color-scheme: light;
  }
  /* Until the frame says its size (2026-11-09) the window draws the frame's fields itself, the same
     boxes and words and nothing that takes a key (credCopyHtml), and the frame loads unseen behind
     them; on its size the frame takes their place, at their height. */
  .wk-cred-copy { display: none; }
  .wk-cred.loading .wk-cred-copy {
    display: flow-root;
    padding: 0 16px 32px;
    margin-bottom: -32px;
    text-transform: none;
    text-indent: 0;
    text-shadow: none;
    word-spacing: normal;
    font-style: normal;
    -webkit-user-select: none;
    user-select: none;
  }
  .wk-cred.loading iframe { position: absolute; top: 0; inset-inline-start: 0; visibility: hidden; }
  .wk-cred-copy .wk-copy-label {
    display: block;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.005em;
    margin-bottom: 6px;
    color: var(--wk-ink-soft);
  }
  .wk-cred-copy .wk-copy-label .optional { font-weight: 400; color: #94a3b8; }
  .wk-cred-copy .wk-copy-box {
    display: flex;
    align-items: center;
    width: 100%;
    height: 44px;
    padding: 0 14px;
    font-size: 14.5px;
    font-weight: 500;
    font-family: var(--wk-font);
    line-height: normal;
    letter-spacing: normal;
    text-rendering: auto;
    white-space: pre;
    overflow: hidden;
    color: var(--wk-ink-mute);
    background: var(--wk-cream);
    border: 1.5px solid var(--wk-line);
    border-radius: var(--wk-radius);
    margin-bottom: 10px;
  }
  .wk-cred-copy .wk-copy-box .wk-copy-value { color: var(--wk-ink); }
  /* What the browser gives the frame's <button> and a div does not inherit. */
  .wk-cred-copy .btn { line-height: normal; text-rendering: auto; }
  .wk-cred.failed iframe, .wk-cred.failed .wk-cred-copy { display: none; }
  .wk-cred-retry { display: none; }
  .wk-cred.failed .wk-cred-retry { display: flex; width: calc(100% - 32px); margin-inline: 16px; }

  /* ── editor preview: the owner's one-tap entry inside the note box (host bridge, 2026-10-27) ── */
  .owner-ctx-link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-weight: 700;
    color: var(--wk-primary);
    cursor: pointer;
  }
  .owner-ctx-link:hover:not(:disabled) { text-decoration: underline; }
  .owner-ctx-link:disabled { opacity: 0.6; cursor: not-allowed; }

  /* ── account sheet (signed-in state) ── */
  .account-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border: 1px solid var(--wk-line-soft);
    border-radius: 14px;
    background: var(--wk-cream);
    margin-bottom: 16px;
  }
  .account-avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--wk-primary-light);
    color: var(--wk-primary);
    font-weight: 700;
    font-size: 17px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    flex-shrink: 0;
  }
  .account-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .account-who { min-width: 0; }
  .account-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--wk-ink-faint);
  }
  .account-name {
    font-size: 15px;
    font-weight: 700;
    color: var(--wk-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .account-email {
    font-size: 12.5px;
    color: var(--wk-ink-mute);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .links a.danger-link { color: var(--wk-danger); font-weight: 600; }
  .btn.btn-danger { background: var(--wk-danger); }
  .btn.btn-danger:hover { background: #A02E23; }
  .delete-warn {
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--wk-ink-soft);
    border: 1px solid var(--wk-line-soft);
    border-radius: 14px;
    padding: 12px 14px;
    background: var(--wk-cream);
    margin-bottom: 14px;
  }
`

const GOOGLE_SVG = `<svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>`

// Whacka brand mark — eight rounded spokes around an open centre. Geometry is
// mirrored from src/components/whacka/mark.ts (can't import across the template
// boundary); inks off the modal's OWN --wk-ink, so it matches the wordmark
// beside it and still does NOT theme to the host app.
const MARK_SVG = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true" style="display:block;flex-shrink:0;overflow:visible">
  <path d="M17.9 12 L22.2 12 M16.17 16.17 L19.21 19.21 M12 17.9 L12 22.2 M7.83 16.17 L4.79 19.21 M6.1 12 L1.8 12 M7.83 7.83 L4.79 4.79 M12 6.1 L12 1.8 M16.17 7.83 L19.21 4.79" stroke="var(--wk-ink)" stroke-width="2.6" stroke-linecap="round"></path>
</svg>`

// Apple logo glyph (monochrome, inherits the button's white via fill).
const APPLE_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="#fff" aria-hidden="true"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.702"/></svg>`

const googleButton = (T) => `<div class="wk-google-wrap">
      <button class="wk-google" type="button" data-google>${GOOGLE_SVG}<span>${T.googleContinue}</span></button>
      <div class="wk-tip" data-tip></div>
    </div>`

// Apple ABOVE Google in the views (Guideline 4.8: the privacy-preserving
// option must not be the less prominent one).
const appleButton = (T) => `<div class="wk-google-wrap">
      <button class="wk-apple" type="button" data-apple>${APPLE_SVG}<span>${T.appleContinue}</span></button>
      <div class="wk-tip" data-tip></div>
    </div>`

// Instagram / Facebook / TikTok / Snapchat and bare Android WebViews: Google
// refuses its sign-in inside them. Say so above the buttons, which stay — some
// get through. The store build is a WebView too but runs OAuth in the system
// browser, so it is not one of these.
const IN_APP_UA = /Instagram|FBAN|FBAV|FB_IAB|FBIOS|FB4A|musical_ly|BytedanceWebview|TikTok|Snapchat|; wv\)/
function inAppBrowser() {
  try {
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return false
    return IN_APP_UA.test(navigator.userAgent || '')
  } catch { return false }
}

const oauthButtons = (T) => `${inAppBrowser() ? `<div class="owner-ctx">${T.inAppBrowser}</div>` : ''}${appleButton(T)}${googleButton(T)}`

// The server's shape rule (src/lib/email/email-quality.ts hasPlausibleEmailShape);
// scripts/_test-app-auth-answers.ts holds the two to the same verdicts.
function plausibleEmail(raw) {
  const e = String(raw || '').trim()
  if (e.length < 5 || e.length > 254) return false
  const m = e.match(/^[^\s@]+@([^\s@]+)$/)
  if (!m) return false
  const labels = m[1].toLowerCase().split('.')
  if (labels.length < 2 || labels.some((l) => !l || l.length > 63)) return false
  const tld = labels[labels.length - 1]
  return /^[a-z]{2,}$/.test(tld) || /^xn--[a-z0-9-]{2,}$/.test(tld) || /^[^\x00-\x7F]{2,}$/u.test(tld)
}

// A message the modal wrote itself; anything else (a network error, a server's
// English) shows as the window's own "something went wrong".
function fail(msg) {
  const e = new Error(msg)
  e.wkOwn = true
  return e
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// A team login (made by the app's admin, team.js) is the app's to remove: its
// sheet offers Sign out only, and the server refuses its delete. Sessions
// minted before the teamLogin flag (2026-10-21) are known by their missing
// email — no other session is stored without one. A login its holder made by
// signing up to the users list carries teamLogin: false and keeps Delete
// (team and users, 2026-10-30).
function isTeamLogin(u) {
  return !!u && (u.teamLogin === true || (u.teamLogin !== false && u.email === null))
}

function buildView(view, T, ctx = {}, framed = false) {
  if (view === VIEWS.ACCOUNT) {
    const u = ctx.user || {}
    const name = escapeHtml(u.displayName || u.email || '')
    const email = u.displayName && u.email ? `<div class="account-email">${escapeHtml(u.email)}</div>` : ''
    const initial = escapeHtml((u.displayName || u.email || '?').trim().charAt(0).toUpperCase())
    // Owner path, signed in with an account that ISN'T the builder's: say so.
    // Silence here is what made "all my data disappeared" reports out of
    // wrong-account owners (they were just a fresh customer identity).
    const mismatch = ctx.ownerCtx && ctx.appOwnerId && u.id && u.id !== ctx.appOwnerId
      ? `<div class="owner-mismatch">${T.ownerWrongAccount}</div>`
      : ''
    return `
      <div class="account-row">
        <div class="account-avatar">${u.avatarUrl ? `<img src="${escapeHtml(u.avatarUrl)}" alt="" />` : initial}</div>
        <div class="account-who">
          <div class="account-label">${T.signedInAs}</div>
          <div class="account-name">${name}</div>
          ${email}
        </div>
      </div>
      ${mismatch}
      <div class="error-msg" data-error></div>
      <button class="btn" data-submit data-signout>${T.signOutBtn}</button>
      ${isTeamLogin(ctx.user)
        ? `<div class="links">${T.teamLoginManaged}</div>`
        : `<div class="links"><a class="danger-link" data-goto="deleteConfirm">${T.deleteAccountLink}</a></div>`}
    `
  }
  if (view === VIEWS.DELETE_CONFIRM) {
    return `
      <div class="delete-warn">${T.deleteWarnBody}</div>
      <div class="error-msg" data-error></div>
      <button class="btn btn-danger" data-submit data-delete>${T.deleteConfirmBtn}</button>
      <div class="links"><a data-goto="account">${T.deleteKeep}</a></div>
    `
  }
  if (view === VIEWS.LOGIN) {
    // Owner path: name the account being asked for. This modal is the "Sign in
    // as owner" destination, and unlabeled it reads as an app-issued admin
    // credential that was never handed out.
    // Editor preview, the app's owner looking (host bridge): one tap, no password.
    const hint = ctx.ownerHint
    const ownerEntry = hint
      ? `<div class="owner-ctx">${T.ownerPreviewLead} <button type="button" class="owner-ctx-link" data-owner-preview>${T.ownerPreviewLink}</button></div>`
      : ''
    return `
      ${ownerEntry || (ctx.ownerCtx ? `<div class="owner-ctx">${T.ownerContext}</div>` : '')}
      ${oauthButtons(T)}
      <div class="error-msg" data-error></div>
      ${framed ? CRED_SLOT : `<label for="wk-login-email">${T.email}</label>
      <input id="wk-login-email" type="email" placeholder="${T.emailPlaceholder}" autocomplete="email" />
      <label for="wk-login-password">${T.password}</label>
      <input id="wk-login-password" type="password" placeholder="${T.passwordPlaceholder}" autocomplete="current-password" />
      <div class="forgot-link"><a data-goto="forgot">${T.forgotLink}</a></div>
      <button class="btn" data-submit>${T.logIn}</button>`}
      <div class="links">${T.noAccount} <a data-goto="signup">${T.signUp}</a></div>
    `
  }
  if (view === VIEWS.SIGNUP) {
    return `
      ${oauthButtons(T)}
      <div class="error-msg" data-error></div>
      ${framed ? CRED_SLOT : `<label for="wk-signup-email">${T.email}</label>
      <input id="wk-signup-email" type="email" placeholder="${T.emailPlaceholder}" autocomplete="email" />
      <label for="wk-signup-password">${T.password}</label>
      <input id="wk-signup-password" type="password" placeholder="${T.signupPasswordPlaceholder}" autocomplete="new-password" />
      <label for="wk-signup-name">${T.displayName} <span style="font-weight:400;color:#94a3b8">${T.optional}</span></label>
      <input id="wk-signup-name" type="text" placeholder="${T.displayNamePlaceholder}" autocomplete="name" />
      <button class="btn" data-submit>${T.createAccount}</button>`}
      <div class="links">${T.haveAccount} <a data-goto="login">${T.logIn}</a></div>
    `
  }
  // FORGOT
  return `
    <div class="error-msg" data-error></div>
    <div class="success-msg" data-success></div>
    <label for="wk-forgot-email">${T.email}</label>
    <input id="wk-forgot-email" type="email" placeholder="${T.emailPlaceholder}" autocomplete="email" />
    <button class="btn" data-submit>${T.sendReset}</button>
    <div class="links"><a data-goto="login">${T.backToLogin}</a></div>
  `
}

function titleForView(view, T, noBrand) {
  if (view === VIEWS.FORGOT) return T.titleForgot
  if (view === VIEWS.ACCOUNT) return T.titleAccount
  if (view === VIEWS.DELETE_CONFIRM) return T.titleDeleteConfirm
  // Branded: the Whacka logo row is the header, no headline needed. White-label
  // (logo hidden): a neutral headline so the card doesn't start with a bare form.
  if (noBrand) return view === VIEWS.SIGNUP ? T.titleSignup : T.titleLogin
  return ''
}

// Sign-in failure reasons the server names (signin route: oauth_only /
// no_account / wrong_password — 2026-09-28): one sentence in the existing
// error slot. Anything else keeps the generic message + the Google hint.
function loginReasonText(T, reason) {
  if (reason === 'oauth_only') return T.reasonOauthOnly
  if (reason === 'no_account') return T.reasonNoAccount
  if (reason === 'wrong_password') return T.reasonWrongPassword
  return null
}

// ── Published builds: the login and sign-up fields are the platform's frame ──
// (2026-11-08, _credentials-frame.js). This window lives in the app's page, where
// the app's own code can hear every key and replace fetch; a frame from the
// platform's origin it cannot read. So the e-mail, password and name are typed
// there, the frame sends them itself and hands back a one-time code, and the
// window exchanges it as it does after Google or Apple. The window keeps all the
// rest: notes, Apple / Google, the error slot and its sentences, the links.
// The editor preview and a store build keep the fields in the window
// (credentialsInPage); a published build never does, even when the frame cannot
// load: a page that could make the frame fail would get the fields back.
//
// The view's head and tail are drawn around a frame that stays where it is from
// view to view (moving a frame reloads it, and what was typed lives only in it);
// buildView marks its place with CRED_SLOT.
const CRED_SLOT = '<!--wk-cred-->'
// Its height until it says (the fields as they were, on 16px type); then what it says.
const CRED_FRAME_PX = { login: 269.5, signup: 316.25 }
// Not ready after this long: said, with a way on; a frame that answers later still takes over.
const CRED_FRAME_WAIT_MS = 15000
// Its page has loaded: this long for its "ready" (an error page or a refusal never sends one).
const CRED_FRAME_LOAD_GRACE_MS = 1500

// The frame's fields as the frame draws them, for the moment it is still loading: the same
// labels, empty boxes and button, in the window's words. Divs and text only, never an input,
// a contenteditable or anything focusable: nothing here takes a key. "Forgot password?" goes
// to the reset form, as the frame's does.
function credCopyHtml(view, T, email) {
  const signup = view === VIEWS.SIGNUP
  const box = (placeholder, value) => value
    ? `<div class="wk-copy-box"><span class="wk-copy-value">${escapeHtml(value)}</span></div>`
    : `<div class="wk-copy-box">${placeholder}</div>`
  return `<div class="wk-copy-label">${T.email}</div>${box(T.emailPlaceholder, email)}`
    + `<div class="wk-copy-label">${T.password}</div>${box(signup ? T.signupPasswordPlaceholder : T.passwordPlaceholder)}`
    + (signup
      ? `<div class="wk-copy-label">${T.displayName} <span class="optional">${T.optional}</span></div>${box(T.displayNamePlaceholder)}`
      : `<div class="forgot-link"><a data-copy-forgot>${T.forgotLink}</a></div>`)
    + `<div class="btn">${signup ? T.createAccount : T.logIn}</div>`
}

// The sentence for a form the frame refused before sending: its checks, the window's words.
function localSentence(T, key) {
  if (key === 'fillAll') return T.fillAll
  if (key === 'enterPassword') return T.enterPassword
  if (key === 'needEmailPassword') return T.needEmailPassword
  if (key === 'invalidEmail') return T.invalidEmail
  if (key === 'passwordMin') return T.passwordMin
  return T.somethingWrong
}

// A page that can open this window fetches the frame's page early, so its fields come up with
// the window (published builds only, never with a session held: that opens the account sheet).
try { if (typeof window !== 'undefined' && !storeGet(TOKEN_KEY)) warmCredentialsFrame() } catch { /* only a hint */ }

/** The open still waiting for a first-visit branding answer (see showAuthModal). */
let pendingOpen = null

/**
 * Opens a Whacka-branded login/signup/forgot-password modal.
 * Resolves with `{ token, user }` on success, or `null` if dismissed.
 */
export function showAuthModal({ reason, pricing, context } = {}) {
  // context:'owner' → the owner-path variant (opened by "Sign in as owner"):
  // labels the modal as the Whacka builder account and flags a signed-in
  // account that doesn't own this app. Everything else is unchanged.
  const ownerCtx = context === 'owner'
  const appOwnerId = ((typeof import.meta !== 'undefined' && import.meta.env) || {}).VITE_APP_OWNER_ID || null
  // A device's first-ever open waits for the server's branding answer (at
  // most 1.2 s, the corner badge's hold) so a white-labelled app never opens
  // with Whacka's header; every later open has the cached answer at once.
  // Taps during that wait join the one window on its way, never stack more.
  if (pendingOpen) return pendingOpen
  const opening = brandingSettled().then(() => new Promise((resolve) => {
    ensureBrandFont()
    const lang = resolveFaceLang()
    const T = STRINGS[lang] || STRINGS.en
    // White-label: the app's branding answer (src/lib/app/brand.ts on the
    // server — the owner's choice AND their plan) hides the Whacka logo +
    // footer; under "Your brand" the app's own icon + name take the logo's
    // place. Read the cached answer synchronously; refreshBranding() is
    // deduped, so this only fetches if the launch-time fetch hasn't run.
    // Fail-open to branding.
    refreshBranding()
    const noBrand = brandingHidden()
    const ownBrand = noBrand ? brandIdentity() : null
    // View strings: under a hidden brand the three sentences that would name
    // the Whacka ID come from STRINGS_NOBRAND (same slots, same layout).
    const TV = noBrand ? { ...T, ...(STRINGS_NOBRAND[langOfTable(T)] || STRINGS_NOBRAND.en) } : T

    const host = document.createElement('div')
    const shadow = host.attachShadow({ mode: 'closed' })
    markFieldKeys(shadow) // a game's keyboard sees these fields as typing (games review 12)
    let resolved = false

    function finish(result) {
      if (resolved) return
      resolved = true
      host.remove()
      resolve(result)
    }

    // --- Resolve app theme and build DOM ---
    const appColor = resolveAppPrimary()

    const style = document.createElement('style')
    style.textContent = STYLES
    shadow.appendChild(style)

    if (appColor) {
      host.style.setProperty('--wk-primary', appColor.primary)
      host.style.setProperty('--wk-primary-hover', appColor.hover)
      host.style.setProperty('--wk-primary-light', appColor.light)
    }

    host.dir = isRtlLang(langOfTable(T)) ? 'rtl' : 'ltr'
    if (noBrand) host.classList.add('wk-nobrand')

    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    overlay.addEventListener('click', () => finish(null))
    shadow.appendChild(overlay)

    const card = document.createElement('div')
    card.className = 'card'
    card.addEventListener('click', (e) => e.stopPropagation())
    shadow.appendChild(card)

    const closeBtn = document.createElement('button')
    closeBtn.className = 'close-btn'
    closeBtn.innerHTML = '&#x2715;'
    closeBtn.setAttribute('aria-label', T.close)
    closeBtn.addEventListener('click', () => finish(null))
    card.appendChild(closeBtn)

    const body = document.createElement('div')
    body.className = 'card-body'
    card.appendChild(body)

    if (ownBrand) {
      const row = document.createElement('div')
      row.className = 'brand'
      if (ownBrand.icon) {
        const img = document.createElement('img')
        img.className = 'brand-icon'
        img.src = ownBrand.icon
        img.alt = ''
        img.width = 36
        img.height = 36
        img.decoding = 'async'
        img.referrerPolicy = 'no-referrer'
        img.addEventListener('error', () => img.remove())
        row.appendChild(img)
      }
      const name = document.createElement('span')
      name.className = 'brand-name'
      name.dir = 'auto'
      name.textContent = ownBrand.name
      row.appendChild(name)
      body.appendChild(row)
    } else if (!noBrand) {
      const logo = document.createElement('div')
      logo.className = 'logo'
      logo.innerHTML = `${MARK_SVG}<span class="logo-word">whacka</span>`
      body.appendChild(logo)
    }

    const titleEl = document.createElement('div')
    titleEl.className = 'title'
    body.appendChild(titleEl)

    if (reason === 'credits') {
      const banner = document.createElement('div')
      banner.className = 'credits-banner'
      // The credits 429 rides `pricing` through auth.signIn → here; render the
      // server's free daily grant when present (fallback literal otherwise).
      const freeDaily = pricing && Number(pricing.freeDaily) > 0 ? Number(pricing.freeDaily) : null
      banner.textContent = T.creditsBanner(freeDaily)
      body.appendChild(banner)
    }

    const viewContainer = document.createElement('div')
    body.appendChild(viewContainer)
    // Published builds: the login and sign-up fields in the platform's frame (credentialsForm).
    const cred = credentialsInPage() ? null : credentialsForm({
      container: viewContainer, T, TV, host, appColor, noBrand, ownerCtx,
      onAnswer: credAnswered,
      onForgot: () => { if (currentView === VIEWS.LOGIN) switchTo(VIEWS.FORGOT) },
      onEscape: () => finish(null),
    })

    if (!noBrand) {
      const footer = document.createElement('div')
      footer.className = 'footer'
      footer.innerHTML = T.poweredBy
      card.appendChild(footer)
    }

    // --- View management ---
    let currentView = null

    // Present session (if any): signed-in opens land on the ACCOUNT sheet, so
    // auth.signIn() doubles as the always-available account entry (Sign out /
    // Delete account) in every app, old and new — the platform guarantee
    // behind Apple 5.1.1(v). Before this, a signed-in tap on any "Sign in"
    // button just re-rendered the login form.
    const sessionUser = (() => {
      try {
        const t = storeGet(TOKEN_KEY)
        const raw = storeGet(USER_KEY)
        return t && raw ? JSON.parse(raw) : null
      } catch { return null }
    })()

    function switchTo(view, carry) {
      currentView = view
      titleEl.textContent = titleForView(view, T, noBrand)
      const html = buildView(view, TV, { user: sessionUser, ownerCtx, appOwnerId, ownerHint: hostOwnerHint() }, !!cred)
      if (cred) cred.draw(view, html, carry)
      else viewContainer.innerHTML = `<div class="view active view-transition">${html}</div>`
      wireView(view)
      if (carry) {
        // From the form they just used: the same email (and password) in this
        // form's fields, and the one sentence that says why they are here.
        const put = (sel, v) => { const el = viewContainer.querySelector(sel); if (el && v) el.value = v }
        put('#wk-login-email', carry.email); put('#wk-signup-email', carry.email); put('#wk-forgot-email', carry.email)
        put('#wk-login-password', carry.password); put('#wk-signup-password', carry.password)
        const slot = viewContainer.querySelector('[data-error]')
        if (slot && carry.note) slot.insertAdjacentHTML('beforebegin', `<div class="owner-ctx" data-carried>${escapeHtml(carry.note)}</div>`)
        return
      }
      const firstInput = viewContainer.querySelector('input')
      if (firstInput) setTimeout(() => firstInput.focus(), 60)
    }

    function wireView(view) {
      const root = viewContainer

      root.querySelectorAll('[data-goto]').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault()
          switchTo(a.dataset.goto)
        })
      })

      // Account sheet: sign out clears the session locally (data operations
      // fall back to anonymous identity, same as auth.signOut()).
      if (view === VIEWS.ACCOUNT) {
        root.querySelector('[data-signout]')?.addEventListener('click', () => {
          storeRemove(TOKEN_KEY)
          storeRemove(USER_KEY)
          clearSupabaseToken()
          finish({ signedOut: true })
        })
        return
      }

      // Delete confirmation: the server cascades this app's account (private
      // rows, notifications, membership; the pool identity too when this is
      // its only app). Local session cleared on success regardless.
      // Self-contained wiring — the shared showError/setLoading helpers close
      // over consts declared in the form-view code path this branch skips.
      if (view === VIEWS.DELETE_CONFIRM) {
        const btn = root.querySelector('[data-delete]')
        const errEl = root.querySelector('[data-error]')
        btn?.addEventListener('click', async () => {
          if (btn.disabled) return
          btn.disabled = true
          const label = btn.textContent
          btn.innerHTML = `<span class="spinner"></span>${T.pleaseWait}`
          if (errEl) {
            errEl.textContent = ''
            errEl.classList.remove('visible')
          }
          try {
            const token = storeGet(TOKEN_KEY)
            // The shared headers carry the editor's preview pass and a private
            // app's gate pass: without them an app not yet published answered
            // every delete with 404 (delivery ledger P41 readout, 2026-10-22).
            // The account to delete stays THIS app session, never the builder's
            // platform token getAuthHeaders may prefer.
            const res = await sdkFetch(`${API_BASE}/api/app/${PROJECT_ID}/auth/delete-account`, {
              method: 'POST',
              headers: { ...getAuthHeaders(), Authorization: `Bearer ${token}` },
            }, { route: 'auth/delete-account' })
            if (!res.ok) await throwFromResponse(res, 'Delete failed', 'auth/delete-account')
            storeRemove(TOKEN_KEY)
            storeRemove(USER_KEY)
            clearSupabaseToken()
            finish({ accountDeleted: true })
          } catch (err) {
            // A team login the sheet did not recognise: the delete can never
            // succeed, so say who manages the account and drop the button.
            if (err && err.code === 'TEAM_LOGIN_MANAGED') {
              btn.remove()
              if (errEl) {
                errEl.textContent = T.teamLoginManaged
                errEl.classList.add('visible')
              }
              return
            }
            btn.disabled = false
            btn.textContent = label
            if (errEl) {
              errEl.textContent = T.deleteFailed
              errEl.classList.add('visible')
            }
          }
        })
        return
      }

      // OAuth sign-in (Apple / Google): top-level navigate to whacka.app to run
      // the flow (a static *.whacka.app PWA can't run PKCE on its own origin).
      // The flow returns to this app with a one-time #wk_code that main.jsx
      // exchanges. ONE wiring body for both providers — only the start path and
      // the copy differ; a behavioral difference between the two buttons is a
      // bug by definition.
      const wireOAuthButton = (btn, startPath, previewTipText, nativeUpdateText) => {
        if (!btn) return
        // Each button's tip lives in its own wrap — never the first [data-tip]
        // in the root (that would pin every tip onto the Apple button).
        const tip = btn.parentElement && btn.parentElement.querySelector('[data-tip]')
        let tipTimer
        const showTip = (text) => {
          if (!tip) return
          tip.textContent = text
          tip.classList.add('show')
          clearTimeout(tipTimer)
          tipTimer = setTimeout(() => tip.classList.remove('show'), 4000)
        }
        btn.addEventListener('click', () => {
          // Providers refuse OAuth inside iframes / embedded webviews (403). The
          // editor preview runs the app in an iframe (window.self !== window.top),
          // so OAuth sign-in is only available on the published standalone app.
          // Surface that as a small tooltip near the button — not a full-width error.
          if (window.self !== window.top) {
            showTip(previewTipText)
            return
          }
          // Native shell: providers 403 OAuth inside webviews, so run the flow
          // in the SYSTEM browser (Chrome Custom Tab / SFSafariViewController)
          // and let /auth/app-callback deep-link back via this app's custom
          // scheme (= its applicationId; main.jsx's appUrlOpen listener finishes
          // the exchange). Binaries predating the Browser/App plugins degrade to
          // a hint — email sign-in below is unaffected.
          let isNativeShell = false
          try { isNativeShell = !!window.Capacitor?.isNativePlatform?.() } catch { /* web */ }
          if (isNativeShell) {
            const plugins = (window.Capacitor && window.Capacitor.Plugins) || {}
            if (!plugins.Browser || !plugins.Browser.open || !plugins.App || !plugins.App.getInfo) {
              showTip(nativeUpdateText)
              return
            }
            plugins.App.getInfo()
              .then((info) => {
                const startUrl = `${API_BASE || 'https://whacka.app'}${startPath}`
                  + `?origin=${encodeURIComponent(location.origin)}`
                  + `&anon=${encodeURIComponent(getAnonymousId() || '')}`
                  + `&native_scheme=${encodeURIComponent(info.id)}`
                return plugins.Browser.open({ url: startUrl })
              })
              .catch(() => showTip(nativeUpdateText))
            return
          }
          const anon = getAnonymousId() || ''
          // Always navigate to the PLATFORM origin, never relative: the OAuth
          // state + PKCE verifier cookies must be set on whacka.app (where the
          // provider returns), not host-only on this app's subdomain. This is a
          // top-level navigation, so the same-origin/adblock rationale behind
          // VITE_API_BASE='' doesn't apply here.
          // `to` = the page the visitor is on right now (`/?query#hash` —
          // root-anchored, see _oauth-return.js). /start signs it into the
          // OAuth state and the callback hands it back as `wk_to`, so the
          // post-sign-in boot lands on THIS page, not the app root. Omitted at
          // the root. Note: this puts the hash route on the wire (whacka.app
          // request logs) — fragments never left the browser before 0817.
          const returnTo = currentReturnPath(location)
          const url = `${API_BASE || 'https://whacka.app'}${startPath}`
            + `?origin=${encodeURIComponent(location.origin)}`
            + `&anon=${encodeURIComponent(anon)}`
            + (returnTo ? `&to=${encodeURIComponent(returnTo)}` : '')
            + `&lang=${langOfTable(T)}`
          window.location.href = url
        })
      }
      wireOAuthButton(root.querySelector('[data-apple]'), '/api/auth/app-apple/start', T.appleTip, T.appleNativeUpdate)
      wireOAuthButton(root.querySelector('[data-google]'), '/api/auth/app-google/start', T.googleTip, T.googleNativeUpdate)

      const submitBtn = root.querySelector('[data-submit]')
      const errorEl = root.querySelector('[data-error]')
      const successEl = root.querySelector('[data-success]')
      const inputs = root.querySelectorAll('input')

      function showError(msg) {
        errorEl.textContent = msg
        errorEl.classList.add('visible')
      }

      function clearMessages() {
        // The note this form was opened with says why the person is here; once
        // they submit, what the window says next replaces it. Kept, it stood
        // beside the same sentence coming back as the error (delivery ledger P6,
        // 2026-10-21: "This account uses Google or Apple sign-in." twice).
        root.querySelectorAll('[data-carried]').forEach((n) => n.remove())
        errorEl.textContent = ''
        errorEl.classList.remove('visible')
        if (successEl) {
          successEl.textContent = ''
          successEl.classList.remove('visible')
        }
      }

      function setLoading(on) {
        submitBtn.disabled = on
        if (on) {
          submitBtn.dataset.label = submitBtn.textContent
          submitBtn.innerHTML = `<span class="spinner"></span>${T.pleaseWait}`
        } else {
          submitBtn.textContent = submitBtn.dataset.label || ''
        }
      }

      // Editor preview, the owner looking: the workspace mints an owner session
      // (owner link, delivery 'preview') and this window redeems it like a
      // Google return — the same session a password sign-in would give.
      const ownerBtn = root.querySelector('[data-owner-preview]')
      ownerBtn?.addEventListener('click', async () => {
        if (ownerBtn.disabled) return
        clearMessages()
        ownerBtn.disabled = true
        try {
          const minted = await requestOwnerSession()
          if (!minted || typeof minted.code !== 'string') throw new Error('no code')
          const res = await sdkFetch(`${API_BASE}/api/auth/exchange-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: minted.code }),
          }, { route: 'auth/exchange-code' })
          const data = await res.json().catch(() => null)
          if (!res.ok || !data || !data.token) throw new Error('exchange failed')
          saveAndFinish(data)
        } catch {
          ownerBtn.disabled = false
          showError(T.ownerPreviewFailed)
        }
      })

      // A published build's login and sign-up: the fields and the button are the frame's,
      // the sentences stay the window's (credAnswered below).
      if (cred && (view === VIEWS.LOGIN || view === VIEWS.SIGNUP)) return cred.bind({ root, showError, clearMessages })

      // Submit on Enter key
      inputs.forEach((input) => {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submitBtn.click()
          }
        })
      })

      submitBtn.addEventListener('click', async () => {
        clearMessages()

        if (view === VIEWS.LOGIN) {
          const email = root.querySelector('#wk-login-email').value.trim()
          const password = root.querySelector('#wk-login-password').value
          if (!email) return showError(T.fillAll)
          // No password typed: often an account made with Google or Apple, which has none.
          if (!password) return showError(T.enterPassword)

          setLoading(true)
          try {
            // sdkFetch: a 30s deadline — a stalled sign-in used to leave the
            // spinner up for as long as the browser cared to wait.
            const res = await sdkFetch(`${API_BASE}/api/auth/signin`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              // projectId/context are telemetry only (B19-D) — the server logs
              // owner sign-in outcomes; they never change the auth result.
              body: JSON.stringify({
                email,
                password,
                anonymousId: getAnonymousId(),
                projectId: PROJECT_ID || undefined,
                context: ownerCtx ? 'owner' : undefined,
              }),
            }, { route: 'auth/signin' })
            const data = await res.json()
            if (!res.ok) {
              // Wrong password OR an account that has no password at all —
              // Google/Apple signups land here with their own correct email.
              // Since 2026-09-28 the server names the reason (oauth_only /
              // no_account / wrong_password) and the modal says that one
              // sentence, nothing else: the general hint below would repeat
              // it, or mislead someone who merely mistyped a password. Without
              // a reason, today's behaviour: the generic message plus the hint,
              // anchored on the LAST [data-tip] (the Google wrap, lowest
              // button): the first is the Apple wrap's, and this hint has no
              // auto-hide, so anchored there it would sit on top of the Google
              // button.
              if (res.status === 401) {
                // No account under this email: they came to make one.
                if (data && data.reason === 'no_account') {
                  setLoading(false)
                  return switchTo(VIEWS.SIGNUP, { email, password, note: T.reasonNoAccount })
                }
                const named = loginReasonText(T, data && data.reason)
                if (named) throw fail(named)
                const tips = root.querySelectorAll('[data-tip]')
                const tip = tips[tips.length - 1]
                if (tip && !tip.textContent) { tip.textContent = T.googleFailHint; tip.classList.add('show') }
              }
              throw fail(res.status === 401 ? T.invalidCreds : T.somethingWrong)
            }
            saveAndFinish(data)
          } catch (err) {
            setLoading(false)
            showError(err && err.wkOwn ? err.message : T.somethingWrong)
          }
        }

        if (view === VIEWS.SIGNUP) {
          const email = root.querySelector('#wk-signup-email').value.trim()
          const password = root.querySelector('#wk-signup-password').value
          const displayName = root.querySelector('#wk-signup-name').value.trim() || undefined
          if (!email || !password) return showError(T.needEmailPassword)
          if (!plausibleEmail(email)) return showError(T.invalidEmail)
          if (password.length < 6) return showError(T.passwordMin)

          setLoading(true)
          try {
            const res = await sdkFetch(`${API_BASE}/api/auth/signup`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              // lang = this modal's language (the app's dir/lang, else the
              // device's) — stored on a fresh account so Whacka's emails to
              // it speak the app's language. Never affects the auth result.
              // projectId: the app the new session and its realtime pass are for.
              body: JSON.stringify({ email, password, displayName, anonymousId: getAnonymousId(), projectId: PROJECT_ID || undefined, lang: langOfTable(T) }),
            }, { route: 'auth/signup' })
            const data = await res.json()
            if (res.status === 409) {
              // The email already has an account (another app, or Google/Apple);
              // the server has already tried this password.
              setLoading(false)
              return switchTo(VIEWS.LOGIN, { email, note: data && data.code === 'oauth_only' ? T.reasonOauthOnly : T.emailTaken })
            }
            if (!res.ok) throw fail(data && data.code === 'invalid_email' ? T.invalidEmail : T.couldNotCreate)
            saveAndFinish(data)
          } catch (err) {
            setLoading(false)
            showError(err && err.wkOwn ? err.message : T.somethingWrong)
          }
        }

        if (view === VIEWS.FORGOT) {
          const email = root.querySelector('#wk-forgot-email').value.trim()
          if (!email) return showError(T.enterEmail)
          if (!plausibleEmail(email)) return showError(T.invalidEmail)

          setLoading(true)
          try {
            const res = await sdkFetch(`${API_BASE}/api/auth/reset-password`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              // projectId lets the reset page brand itself with this app's
              // name and send the user back here instead of whacka.app; lang
              // is this modal's language, for an app that sends the reset
              // email in its own name (app_auth_email).
              body: JSON.stringify({ email, projectId: import.meta.env.VITE_PROJECT_ID || undefined, lang: langOfTable(T) }),
            }, { route: 'auth/reset-password' })
            const data = await res.json()
            if (!res.ok) {
              if (data && data.code === 'no_account') {
                setLoading(false)
                return switchTo(VIEWS.SIGNUP, { email, note: T.reasonNoAccount })
              }
              throw fail(data && data.code === 'invalid_email' ? T.invalidEmail : data && data.code === 'send_failed' ? T.sendFailed : T.somethingWrong)
            }
            setLoading(false)
            successEl.textContent = T.resetSent
            successEl.classList.add('visible')
          } catch (err) {
            setLoading(false)
            showError(err && err.wkOwn ? err.message : T.somethingWrong)
          }
        }
      })
    }

    // Data written on this device before signing in stays with the device
    // (ran 0928: by design, not a defect) — the old `__whacka_migration_pending`
    // flag written here was read by nothing and is gone (2026-09-28).
    function saveAndFinish({ token, supabaseToken, user }) {
      try {
        storeSet(TOKEN_KEY, token)
        storeSet(USER_KEY, JSON.stringify(user))
      } catch {}
      // Persist supabaseToken so Realtime / RLS see the right auth.uid().
      // Null is fine — falls back to the guest-token endpoint.
      if (supabaseToken) setSupabaseToken(supabaseToken)
      finish({ token, user })
    }

    // What the routes answered through the frame (published builds): the form's own
    // submit above, branch for branch, with what was typed staying in the frame. A
    // session comes as a one-time code, redeemed as after Google or Apple. `ui` is the
    // form view on screen (none while the reset form is up): a sign-in still finishes.
    async function credAnswered(m, ui) {
      const say = (sentence) => { if (ui) ui.showError(sentence) }
      if (m.ok === true) {
        try {
          const res = await sdkFetch(`${API_BASE}/api/auth/exchange-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: String(m.code) }),
          }, { route: 'auth/exchange-code' })
          const session = await res.json().catch(() => null)
          if (!res.ok || !session || !session.token) throw new Error('exchange failed')
          saveAndFinish(session)
        } catch {
          cred.idle()
          say(T.somethingWrong)
        }
        return
      }
      const status = Number(m.status) || 0
      const answer = m.data && typeof m.data === 'object' ? m.data : null
      if (m.kind === VIEWS.LOGIN) {
        if (status === 401) {
          if (answer && answer.reason === 'no_account') return switchTo(VIEWS.SIGNUP, { keep: 'typed', note: T.reasonNoAccount })
          const named = loginReasonText(T, answer && answer.reason)
          if (named) return say(named)
          const tips = ui ? ui.root.querySelectorAll('[data-tip]') : []
          const tip = tips[tips.length - 1]
          if (tip && !tip.textContent) { tip.textContent = T.googleFailHint; tip.classList.add('show') }
          return say(T.invalidCreds)
        }
        return say(T.somethingWrong)
      }
      if (status === 409) return switchTo(VIEWS.LOGIN, { keep: 'email', note: answer && answer.code === 'oauth_only' ? T.reasonOauthOnly : T.emailTaken })
      if (!status) return say(T.somethingWrong)
      say(answer && answer.code === 'invalid_email' ? T.invalidEmail : T.couldNotCreate)
    }

    // --- Escape key ---
    function onKey(e) {
      if (e.key === 'Escape') finish(null)
    }
    document.addEventListener('keydown', onKey)
    const origRemove = host.remove.bind(host)
    host.remove = () => {
      document.removeEventListener('keydown', onKey)
      if (cred) cred.close()
      origRemove()
    }

    // --- Mount & show ---
    document.body.appendChild(host)
    if (sessionUser) switchTo(VIEWS.ACCOUNT)
    else switchTo(reason === 'credits' ? VIEWS.SIGNUP : VIEWS.LOGIN)
    pendingOpen = null
  }))
  if (!brandingKnown()) pendingOpen = opening
  return opening
}

// The frame between a form view's head and tail (published builds; see CRED_SLOT above).
function credentialsForm({ container, T, TV, host, appColor, noBrand, ownerCtx, onAnswer, onForgot, onEscape }) {
  const head = document.createElement('div')
  const holder = document.createElement('div')
  holder.className = 'wk-cred off'
  const tail = document.createElement('div')
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className = 'btn wk-cred-retry'
  retry.textContent = T.tryAgain
  // The fields as the frame will draw them, until it does (credCopyHtml): a tap there gives the
  // frame's first field the focus as soon as the frame can take it.
  const copy = document.createElement('div')
  copy.className = 'wk-cred-copy'
  copy.setAttribute('aria-hidden', 'true')
  copy.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-copy-forgot]')) { onForgot(); return }
    want.focus = true
  })
  holder.append(copy, retry)
  container.append(head, holder, tail)

  const lang = langOfTable(T)
  const heights = {} // what the frame last said, per view
  let link = null // the open frame (openCredentialsFrame)
  let ready = false
  let failed = false
  let timers = []
  let ui = null // the form view on screen: { root, showError, clearMessages }
  let want = { view: VIEWS.LOGIN, keep: 'none', focus: true } // what the frame shows next

  const clearTimers = () => { timers.forEach(clearTimeout); timers = [] }
  const setHeight = (h) => { if (link && h > 0 && h < 4000) link.frame.style.height = `${h}px` }
  const titleFor = (view) => (view === VIEWS.SIGNUP ? TV.createAccount : TV.logIn)
  // The frame's input takes the focus once the frame has it; the window gives it the frame.
  const focusFrame = () => { try { link.frame.focus({ preventScroll: true }) } catch { /* never mind */ } }
  const viewMessage = () => ({
    type: 'view', view: want.view, keep: want.keep, email: want.email, focus: want.focus === true,
    anonymousId: getAnonymousId(),
  })

  function initMessage() {
    return {
      ...viewMessage(),
      type: 'init',
      // The app this frame signs in to: the frame takes it, with this page's origin, from the first init.
      pid: PROJECT_ID || null,
      dir: host.dir === 'rtl' ? 'rtl' : 'ltr',
      lang,
      fontSize: parseFloat(getComputedStyle(host).fontSize) || 16,
      context: ownerCtx ? 'owner' : null,
      theme: {
        primary: appColor ? appColor.primary : null,
        primaryHover: appColor ? appColor.hover : null,
        primaryLight: appColor ? appColor.light : null,
        noBrand: !!noBrand,
      },
      text: {
        email: TV.email, emailPlaceholder: TV.emailPlaceholder, password: TV.password,
        passwordPlaceholder: TV.passwordPlaceholder, signupPasswordPlaceholder: TV.signupPasswordPlaceholder,
        displayName: TV.displayName, optional: TV.optional, displayNamePlaceholder: TV.displayNamePlaceholder,
        forgotLink: TV.forgotLink, logIn: TV.logIn, createAccount: TV.createAccount, pleaseWait: TV.pleaseWait,
      },
    }
  }

  function fail() {
    if (ready || failed) return
    failed = true
    holder.classList.add('failed')
    if (ui) ui.showError(T.credFrameFailed)
  }

  function open() {
    clearTimers()
    if (link) link.close()
    ready = false
    failed = false
    holder.classList.remove('failed')
    holder.classList.add('loading')
    copy.innerHTML = credCopyHtml(want.view, TV, want.email || '')
    link = openCredentialsFrame(heard)
    link.frame.title = titleFor(want.view)
    setHeight(heights[want.view] || CRED_FRAME_PX[want.view])
    link.frame.addEventListener('load', () => { timers.push(setTimeout(fail, CRED_FRAME_LOAD_GRACE_MS)) })
    holder.insertBefore(link.frame, retry)
    timers.push(setTimeout(fail, CRED_FRAME_WAIT_MS))
  }

  function heard(m) {
    if (m.type === 'ready') {
      ready = true
      clearTimers()
      if (failed) {
        failed = false
        holder.classList.remove('failed')
        if (ui) ui.clearMessages()
      }
      // The frame is still unseen (the copy is up): the focus waits until it takes the copy's place.
      link.post({ ...initMessage(), focus: false })
      return
    }
    if (!ready) return
    if (m.type === 'size') {
      const h = Number(m.h)
      if (!(h > 0) || holder.classList.contains('off')) return
      if (m.view === VIEWS.LOGIN || m.view === VIEWS.SIGNUP) heights[m.view] = h
      if (m.view !== want.view) return
      setHeight(h)
      if (holder.classList.contains('loading')) {
        // The frame takes the copy's place, at the copy's height; then the focus it was owed.
        holder.classList.remove('loading')
        if (want.focus) { focusFrame(); link.post({ type: 'focus' }); want.focus = false }
      }
      return
    }
    if (m.type === 'busy') {
      if (m.on === true && ui) ui.clearMessages()
      return
    }
    if (m.type === 'invalid') {
      if (!ui) return
      ui.clearMessages()
      ui.showError(localSentence(T, m.key))
      return
    }
    if (m.type === 'result') return onAnswer(m, ui)
    if (m.type === 'forgot') return onForgot()
    if (m.type === 'escape') return onEscape()
  }

  retry.addEventListener('click', () => {
    if (ui) ui.clearMessages()
    want.focus = true
    open()
  })

  return {
    /** Draw `view`: a form view's head and tail around the frame; any other view whole, the frame set aside. */
    draw(view, html, carry) {
      const form = view === VIEWS.LOGIN || view === VIEWS.SIGNUP
      const at = form ? html.indexOf(CRED_SLOT) : -1
      head.innerHTML = `<div class="view active view-transition">${at >= 0 ? html.slice(0, at) : html}</div>`
      tail.innerHTML = at >= 0 ? `<div class="view active view-transition">${html.slice(at + CRED_SLOT.length)}</div>` : ''
      ui = null
      holder.classList.toggle('off', !form)
      if (!form) return
      // The copy is up until the frame takes its place: it follows every view meanwhile.
      if (holder.classList.contains('loading')) copy.innerHTML = credCopyHtml(view, TV, carry && typeof carry.email === 'string' ? carry.email : '')
      // What the frame keeps of what was typed: all of it (a login with no account goes on
      // to sign up), the e-mail (a sign-up that met an account goes to login), or nothing
      // but an address the window itself carried (the reset form's).
      want = {
        view,
        keep: carry && (carry.keep === 'typed' || carry.keep === 'email') ? carry.keep : 'none',
        email: carry && typeof carry.email === 'string' ? carry.email : undefined,
        focus: !carry,
      }
      if (!link) { open(); return }
      link.frame.title = titleFor(view)
      if (heights[view]) setHeight(heights[view])
      if (!ready) return
      const unseen = holder.classList.contains('loading')
      if (want.focus && !unseen) focusFrame()
      link.post({ ...viewMessage(), focus: want.focus && !unseen })
      if (!unseen) want.focus = false
    },
    /** The form view on screen: where the window's sentences go. */
    bind(view) {
      ui = view
      if (failed) view.showError(T.credFrameFailed)
    },
    /** A code the window could not redeem: the frame's button comes back. */
    idle() { if (link && ready) link.post({ type: 'idle' }) },
    close() {
      clearTimers()
      if (link) link.close()
      link = null
    },
  }
}
