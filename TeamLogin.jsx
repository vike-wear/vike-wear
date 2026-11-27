/**
 * TeamLogin — the complete sign-in surface for a Whacka Teams app. Drop it in as the
 * app's auth gate; it handles all three entry paths:
 *
 *   - Staff, first time  → opened via an invite link (`?join=<code>`): "accept" mode.
 *       The admin already assigned their username on the invite, so they only set a
 *       password. (See team.createInvite — the admin picks the username.)
 *   - Staff, returning   → no invite code: "login" mode. They enter the username +
 *       password the admin gave them (team.login).
 *   - The OWNER          → a built-in "Sign in as owner" button (auth.signIn, Whacka ID).
 *       The owner is NOT a Team seat; this component includes their entry so you don't
 *       have to add it separately. The sign-in is VERIFIED: onSignedIn gets owner:true
 *       only when the signed-in account really is the builder (auth.isAppOwner());
 *       any other account gets an inline "this account doesn't own this app" notice
 *       instead of a false owner claim.
 *
 * On any success it calls onSignedIn({ user, role }); the user is then signed in
 * everywhere (auth.getCurrentUser(), db, social all work). For a modal instead of an
 * embedded form, call team.signIn().
 *
 *   <TeamLogin appName="Bouchaib" onSignedIn={() => navigate('/')} />
 *
 * Props:
 *   appName       {string}   shown in the heading
 *   mode          {'login'|'accept'}  force a mode; default auto-detects from ?join=
 *   code          {string}   invite code; default reads ?join= from the URL
 *   ownerSignIn   {boolean}  show the "Sign in as owner" button in login mode (default true)
 *   onSignedIn    {function} called with { user, role } after a successful sign-in
 *   onClose       {function} if provided, renders a close (×) button (used by the modal)
 *   fullScreen    {boolean}  render as the whole sign-in GATE — a self-centering, scrollable
 *                            full-screen surface (same recipe as the auth modal) that never
 *                            clips. Use this instead of hand-building a centered login page.
 *   brand         {node}     optional logo/tagline shown above the card (fullScreen only)
 *   bgClassName   {string}   background class for the fullScreen surface (default 'bg-stone-50')
 *   labels        {object}   override any UI string (localize the form without touching this
 *                            file): { title, subtitle, username, usernamePlaceholder,
 *                            displayName, displayNameHint, displayNamePlaceholder, password,
 *                            passwordPlaceholder, submit, busy, owner, ownerButton, ownerBusy,
 *                            ownerHint, ownerMismatch, ownerSignOut,
 *                            invalidInvite, genericError, requestLink, requestSubmit,
 *                            requestedTitle, requestedBody, backToSignIn, poweredBy, close,
 *                            pin, pinPlaceholder, pinSetPlaceholder, pinSubtitle,
 *                            pinAcceptSubtitle, pickName, findName, notYou,
 *                            wrongPassword, wrongPin, tooManyTries, pendingApproval,
 *                            usernameTaken, usernameLatinOnly, usernameTooShort, passwordMin,
 *                            pinSix, seatsFull, requestsClosed, offline }. A failure shows one of these
 *                            sentences, never the server's text.
 *                            e.g. labels={{ title: 'تسجيل الدخول' }}. Defaults are Arabic when
 *                            <html> or <body> has dir="rtl" or lang="ar", otherwise the phone's
 *                            language — Portuguese / Spanish when <html lang> is pt / es or the
 *                            phone is (the platform auth modal's rule); explicit labels always win.
 *
 * PIN mode & member picker (owner opt-in via team.setLoginConfig — nothing to wire here):
 * when the app's loginConfig has pin:true the secret field becomes a 6-digit numeric PIN
 * input, and with memberPicker:true the login form lists active members to TAP instead of
 * typing a username (falls back to the typed form when the roster is large or unavailable).
 * With loginName:'phone' the login name is a phone number (digits only; no text is sent).
 *
 * Sign-up (team and users, 2026-10-30 — nothing to wire here): when the app's users list
 * takes sign-ups (team.setSignup: 'anyone' or 'approval'), the card offers "Create an
 * account": name, login name, password / PIN, and — when the owner opened several user
 * roles for sign-up — which one. 'anyone' signs the person in (onSignedIn, list 'users');
 * 'approval' says the request was sent. userRoles = the app's user roles, each a name or
 * { name, label } (the same list <TeamAdmin userRoles> takes) — their labels name the
 * choices. On such an app the card also says who resets a forgotten password, and the
 * old "request to join" gives way to the sign-up.
 * Labels for it: { signupLink, signupTitle, signupSubmit, signupPasswordPlaceholder, roleQuestion, phone,
 * phonePlaceholder, phoneTooShort, subtitlePhone, pinSubtitlePhone, forgotPassword,
 * forgotPin, signupsClosed, tooManySignups }.
 */

import React, { useState, useEffect } from 'react'
import { team } from '../lib/team'
import { auth } from '../lib/auth'
import { onPrimaryColor } from '../lib/_on-primary'
import { brandIdentity, brandingHidden, onBrandingChange, refreshBranding } from '../lib/_branding'
import { resolveFaceLang, onFaceLangChange } from '../lib/_lang.js'
import { foldTypedDigits } from '../lib/_typed-digits.js'
import { teamFailureKey, usernameProblem, secretProblem } from '../lib/_team-answers.js'

// Overlay padding that clears notches / home indicator in standalone PWAs while
// keeping the 16px minimum everywhere else (env() is 0 on desktop).
const SAFE_PAD = {
  padding:
    'max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) ' +
    'max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left))',
}

function readInviteCode() {
  try { return new URLSearchParams(window.location.search).get('join') } catch { return null }
}

// Whacka brand mark — eight rounded spokes around an open centre. Geometry is
// mirrored from src/components/whacka/mark.ts (can't import across the template
// boundary). Used in the footer.
function WhackaMark({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ overflow: 'visible' }}>
      <path
        d="M17.9 12 L22.2 12 M16.17 16.17 L19.21 19.21 M12 17.9 L12 22.2 M7.83 16.17 L4.79 19.21 M6.1 12 L1.8 12 M7.83 7.83 L4.79 4.79 M12 6.1 L12 1.8 M16.17 7.83 L19.21 4.79"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

const FIELD =
  'w-full rounded-xl border border-stone-200 bg-stone-50 px-3.5 py-2.5 text-[15px] text-stone-900 ' +
  'outline-none transition placeholder:text-stone-400 hover:border-stone-300 ' +
  'focus:border-primary focus:bg-white focus:ring-4 focus:ring-primary/15'

export default function TeamLogin({ appName, mode, code, ownerSignIn = true, onSignedIn, onClose, fullScreen = false, brand = null, bgClassName = 'bg-stone-50', labels = {}, userRoles = [] }) {
  const inviteCode = code || readInviteCode()
  const accepting = (mode || (inviteCode ? 'accept' : 'login')) === 'accept'
  // Language per render via the one cascade every platform face shares
  // (_lang.js, 2026-09-28) — apps set documentElement.dir/lang during their
  // own boot. As the app's first screen this gate renders BEFORE that boot
  // effect runs, so it re-renders when <html>/<body> dir or lang change
  // (delivery ledger P47: it stayed English, then flipped on the first key).
  const faceLang = resolveFaceLang()
  const isArabic = faceLang === 'ar'
  const [, setFaceLang] = useState(resolveFaceLang)
  useEffect(() => {
    setFaceLang(resolveFaceLang())
    return onFaceLangChange(setFaceLang)
  }, [])

  // White-label: Whacka off on the app's plan (Pro) hides the footer and
  // un-names Whacka in the owner section (NB below); "Your brand" (Ultra, W3)
  // also puts the app's icon above the full-screen card when the app passes
  // no `brand` of its own. Reactive because the gate can mount at boot,
  // before the server confirms.
  const [brandHidden, setBrandHidden] = useState(brandingHidden)
  const [ownBrand, setOwnBrand] = useState(brandIdentity)
  // An icon that fails to load is left out, as the sign-in window does.
  const [failedIcon, setFailedIcon] = useState(null)
  useEffect(() => {
    refreshBranding()
    return onBrandingChange((hiddenNow, brandNow) => {
      setBrandHidden(hiddenNow)
      setOwnBrand(hiddenNow ? brandNow : null)
    })
  }, [])

  // UI strings — the face language's defaults (ar, pt, es, en); every key still
  // overridable via the `labels` prop (explicit localization always wins).
  const name = appName || (isArabic ? 'هذا التطبيق' : faceLang === 'pt' ? 'este app' : faceLang === 'es' ? 'esta app' : 'this app')
  const D = isArabic
    ? {
        title: accepting ? `الانضمام إلى ${name}` : `تسجيل الدخول إلى ${name}`,
        subtitle: accepting
          ? 'عيّن كلمة مرور لإكمال إعداد حسابك.'
          : 'أدخل اسم المستخدم وكلمة المرور.',
        username: 'اسم المستخدم',
        usernamePlaceholder: accepting ? 'مثال: ahmed' : 'اسم المستخدم',
        displayName: 'الاسم الظاهر',
        displayNameHint: '(اختياري)',
        displayNamePlaceholder: 'اسمك',
        password: 'كلمة المرور',
        passwordPlaceholder: accepting ? '6 أحرف على الأقل' : 'كلمة المرور',
        submit: accepting ? 'إنشاء الحساب والانضمام' : 'تسجيل الدخول',
        busy: 'يرجى الانتظار…',
        owner: 'المالك',
        ownerButton: 'تسجيل الدخول كمالك',
        ownerBusy: 'جارٍ الفتح…',
        ownerHint: 'بحساب Whacka الذي تبني به هذا التطبيق — لا توجد كلمة مرور منفصلة للمالك.',
        ownerMismatch: 'دخلت بحساب {email} وهو لا يملك هذا التطبيق. سجّل الخروج وادخل بالحساب الذي تبني به على whacka.app.',
        ownerSignOut: 'تسجيل الخروج',
        invalidInvite: 'رابط الدعوة هذا لم يعد صالحًا. اطلب رابطًا جديدًا من المشرف.',
        genericError: 'حدث خطأ ما. حاول مرة أخرى.',
        requestLink: 'جديد هنا؟ اطلب الانضمام',
        requestSubmit: 'طلب الانضمام',
        requestedTitle: 'تم إرسال الطلب',
        requestedBody: 'سيراجع المشرف طلبك — ستتمكن من تسجيل الدخول بعد الموافقة.',
        backToSignIn: 'العودة لتسجيل الدخول',
        poweredBy: 'مقدَّم من Whacka',
        close: 'إغلاق',
        pin: 'الرقم السري (PIN)',
        pinPlaceholder: 'رمزك المكوّن من 6 أرقام',
        pinSetPlaceholder: '6 أرقام',
        pinSubtitle: 'أدخل اسم المستخدم والرقم السري.',
        pinAcceptSubtitle: 'اختر رقمًا سريًا من 6 أرقام لإكمال إعداد حسابك.',
        pickName: 'اختر اسمك',
        findName: 'ابحث عن اسمك',
        notYou: 'لست أنت؟',
        wrongPassword: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
        wrongPin: 'اسم المستخدم أو الرقم السري غير صحيح.',
        tooManyTries: 'محاولات فاشلة كثيرة. حاول مرة أخرى بعد بضع دقائق.',
        pendingApproval: 'حسابك بانتظار موافقة المشرف.',
        usernameTaken: 'اسم المستخدم هذا مستخدم. اختر اسمًا آخر.',
        usernameLatinOnly: 'اسم المستخدم بحروف إنجليزية وأرقام و _ فقط.',
        usernameTooShort: 'اسم المستخدم 3 أحرف على الأقل.',
        passwordMin: 'يجب ألا تقل كلمة المرور عن 6 أحرف.',
        pinSix: 'يجب أن يتكوّن الرقم السري من 6 أرقام.',
        seatsFull: 'لا يمكن إضافة أعضاء جدد إلى هذا التطبيق الآن. تم إبلاغ المالك.',
        requestsClosed: 'هذا التطبيق لا يستقبل طلبات انضمام جديدة الآن.',
        offline: 'خطأ في الشبكة — تحقّق من الاتصال وحاول مرة أخرى.',
        signupLink: 'جديد هنا؟ أنشئ حسابًا',
        signupTitle: 'إنشاء حساب',
        signupSubmit: 'إنشاء الحساب',
        signupPasswordPlaceholder: '6 أحرف على الأقل',
        roleQuestion: 'أنا',
        phone: 'رقم الهاتف',
        phonePlaceholder: 'مثال: 0551234567',
        phoneTooShort: 'أدخل رقم هاتفك.',
        subtitlePhone: 'أدخل رقم هاتفك وكلمة المرور.',
        pinSubtitlePhone: 'أدخل رقم هاتفك والرقم السري.',
        forgotPassword: 'نسيت كلمة المرور؟ اطلب من فريق التطبيق إعادة تعيينها.',
        forgotPin: 'نسيت الرقم السري؟ اطلب من فريق التطبيق إعادة تعيينه.',
        signupsClosed: 'هذا التطبيق لا يستقبل تسجيلات جديدة الآن.',
        tooManySignups: 'تسجيلات كثيرة الآن. حاول مرة أخرى بعد بضع دقائق.',
      }
    : faceLang === 'pt'
    ? {
        title: accepting ? `Junte-se a ${name}` : `Acesse ${name}`,
        subtitle: accepting
          ? 'Defina uma senha para terminar de configurar sua conta.'
          : 'Digite seu nome de usuário e senha.',
        username: 'Nome de usuário',
        usernamePlaceholder: accepting ? 'ex.: ana' : 'Seu nome de usuário',
        displayName: 'Nome de exibição',
        displayNameHint: '(opcional)',
        displayNamePlaceholder: 'Seu nome',
        password: 'Senha',
        passwordPlaceholder: accepting ? 'Pelo menos 6 caracteres' : 'Sua senha',
        submit: accepting ? 'Criar conta e entrar' : 'Entrar',
        busy: 'Aguarde…',
        owner: 'Dono',
        ownerButton: 'Entrar como dono',
        ownerBusy: 'Abrindo…',
        ownerHint: 'Usa sua conta Whacka — a mesma com que você cria este app. Não há senha de dono separada.',
        ownerMismatch: 'Você entrou como {email}, e essa conta não é dona deste app. Saia e use a conta com que você cria em whacka.app.',
        ownerSignOut: 'Sair',
        invalidInvite: 'Este link de convite não é mais válido. Peça um novo ao seu administrador.',
        genericError: 'Algo deu errado. Tente de novo.',
        requestLink: 'Primeira vez aqui? Peça para participar',
        requestSubmit: 'Pedir para participar',
        requestedTitle: 'Pedido enviado',
        requestedBody: 'Um administrador vai analisar seu pedido — você poderá entrar assim que ele for aprovado.',
        backToSignIn: 'Voltar para o login',
        poweredBy: 'Com tecnologia de Whacka',
        close: 'Fechar',
        pin: 'PIN',
        pinPlaceholder: 'Seu PIN de 6 dígitos',
        pinSetPlaceholder: '6 dígitos',
        pinSubtitle: 'Digite seu nome de usuário e PIN.',
        pinAcceptSubtitle: 'Escolha um PIN de 6 dígitos para terminar de configurar sua conta.',
        pickName: 'Toque no seu nome',
        findName: 'Encontre seu nome',
        notYou: 'Não é você?',
        wrongPassword: 'Nome de usuário ou senha incorretos.',
        wrongPin: 'Nome de usuário ou PIN incorretos.',
        tooManyTries: 'Muitas tentativas sem sucesso. Tente de novo em alguns minutos.',
        pendingApproval: 'Sua conta está aguardando a aprovação de um administrador.',
        usernameTaken: 'Esse nome de usuário já está em uso — escolha outro.',
        usernameLatinOnly: 'O nome de usuário só pode ter letras de a a z, números e _.',
        usernameTooShort: 'O nome de usuário precisa ter pelo menos 3 caracteres.',
        passwordMin: 'A senha precisa ter pelo menos 6 caracteres.',
        pinSix: 'O PIN precisa ter exatamente 6 dígitos.',
        seatsFull: 'Este app não pode adicionar novos membros agora. O dono foi avisado.',
        requestsClosed: 'Este app não está aceitando novos pedidos agora.',
        offline: 'Erro de rede — verifique sua conexão e tente de novo.',
        signupLink: 'Primeira vez aqui? Crie uma conta',
        signupTitle: 'Criar uma conta',
        signupSubmit: 'Criar conta',
        signupPasswordPlaceholder: 'Pelo menos 6 caracteres',
        roleQuestion: 'Eu sou',
        phone: 'Número de telefone',
        phonePlaceholder: 'ex.: 11987654321',
        phoneTooShort: 'Digite seu número de telefone.',
        subtitlePhone: 'Digite seu número de telefone e senha.',
        pinSubtitlePhone: 'Digite seu número de telefone e PIN.',
        forgotPassword: 'Esqueceu a senha? Peça para a equipe do app redefinir.',
        forgotPin: 'Esqueceu o PIN? Peça para a equipe do app redefinir.',
        signupsClosed: 'Este app não está aceitando cadastros agora.',
        tooManySignups: 'Muitos cadastros agora. Tente de novo em alguns minutos.',
      }
    : faceLang === 'es'
    ? {
        title: accepting ? `Únete a ${name}` : `Inicia sesión en ${name}`,
        subtitle: accepting
          ? 'Crea una contraseña para terminar de configurar tu cuenta.'
          : 'Escribe tu nombre de usuario y contraseña.',
        username: 'Nombre de usuario',
        usernamePlaceholder: accepting ? 'ej.: ana' : 'Tu nombre de usuario',
        displayName: 'Nombre visible',
        displayNameHint: '(opcional)',
        displayNamePlaceholder: 'Tu nombre',
        password: 'Contraseña',
        passwordPlaceholder: accepting ? 'Al menos 6 caracteres' : 'Tu contraseña',
        submit: accepting ? 'Crear cuenta y unirme' : 'Iniciar sesión',
        busy: 'Espera un momento…',
        owner: 'Dueño',
        ownerButton: 'Iniciar sesión como dueño',
        ownerBusy: 'Abriendo…',
        ownerHint: 'Usa tu cuenta de Whacka — la misma con la que creas esta app. No hay una contraseña de dueño aparte.',
        ownerMismatch: 'Iniciaste sesión como {email}, y esa cuenta no es dueña de esta app. Cierra sesión y usa la cuenta con la que creas en whacka.app.',
        ownerSignOut: 'Cerrar sesión',
        invalidInvite: 'Este enlace de invitación ya no es válido. Pide uno nuevo a tu administrador.',
        genericError: 'Algo salió mal. Inténtalo de nuevo.',
        requestLink: '¿Primera vez aquí? Solicita unirte',
        requestSubmit: 'Solicitar unirme',
        requestedTitle: 'Solicitud enviada',
        requestedBody: 'Un administrador revisará tu solicitud — podrás iniciar sesión cuando la aprueben.',
        backToSignIn: 'Volver a iniciar sesión',
        poweredBy: 'Con tecnología de Whacka',
        close: 'Cerrar',
        pin: 'PIN',
        pinPlaceholder: 'Tu PIN de 6 dígitos',
        pinSetPlaceholder: '6 dígitos',
        pinSubtitle: 'Escribe tu nombre de usuario y PIN.',
        pinAcceptSubtitle: 'Elige un PIN de 6 dígitos para terminar de configurar tu cuenta.',
        pickName: 'Toca tu nombre',
        findName: 'Busca tu nombre',
        notYou: '¿No eres tú?',
        wrongPassword: 'Nombre de usuario o contraseña incorrectos.',
        wrongPin: 'Nombre de usuario o PIN incorrectos.',
        tooManyTries: 'Demasiados intentos fallidos. Inténtalo de nuevo en unos minutos.',
        pendingApproval: 'Tu cuenta está esperando que un administrador la apruebe.',
        usernameTaken: 'Ese nombre de usuario ya está en uso — elige otro.',
        usernameLatinOnly: 'El nombre de usuario solo puede tener letras de la a a la z, números y _.',
        usernameTooShort: 'El nombre de usuario debe tener al menos 3 caracteres.',
        passwordMin: 'La contraseña debe tener al menos 6 caracteres.',
        pinSix: 'El PIN debe tener exactamente 6 dígitos.',
        seatsFull: 'Esta app no puede agregar nuevos miembros ahora. Ya se avisó al dueño.',
        requestsClosed: 'Esta app no está aceptando nuevas solicitudes ahora.',
        offline: 'Error de red — revisa tu conexión e inténtalo de nuevo.',
        signupLink: '¿Primera vez aquí? Crea una cuenta',
        signupTitle: 'Crear una cuenta',
        signupSubmit: 'Crear cuenta',
        signupPasswordPlaceholder: 'Al menos 6 caracteres',
        roleQuestion: 'Soy',
        phone: 'Número de teléfono',
        phonePlaceholder: 'ej.: 5512345678',
        phoneTooShort: 'Escribe tu número de teléfono.',
        subtitlePhone: 'Escribe tu número de teléfono y contraseña.',
        pinSubtitlePhone: 'Escribe tu número de teléfono y PIN.',
        forgotPassword: '¿Olvidaste tu contraseña? Pide al equipo de la app que la restablezca.',
        forgotPin: '¿Olvidaste tu PIN? Pide al equipo de la app que lo restablezca.',
        signupsClosed: 'Esta app no está aceptando registros ahora.',
        tooManySignups: 'Demasiados registros ahora. Inténtalo de nuevo en unos minutos.',
      }
    : {
        title: accepting ? `Join ${name}` : `Sign in to ${name}`,
        subtitle: accepting
          ? 'Set a password to finish setting up your account.'
          : 'Enter your username and password.',
        username: 'Username',
        usernamePlaceholder: accepting ? 'e.g. ahmed' : 'Your username',
        displayName: 'Display name',
        displayNameHint: '(optional)',
        displayNamePlaceholder: 'Your name',
        password: 'Password',
        passwordPlaceholder: accepting ? 'At least 6 characters' : 'Your password',
        submit: accepting ? 'Create account & join' : 'Sign in',
        busy: 'Please wait…',
        owner: 'Owner',
        ownerButton: 'Sign in as owner',
        ownerBusy: 'Opening…',
        ownerHint: 'Uses your Whacka account — the one you build this app with. No separate owner password.',
        ownerMismatch: "You signed in as {email}, which doesn't own this app. Sign out and use the account you build with on whacka.app.",
        ownerSignOut: 'Sign out',
        invalidInvite: 'This invite link is no longer valid. Ask your admin for a new one.',
        genericError: 'Something went wrong. Please try again.',
        requestLink: 'New here? Request to join',
        requestSubmit: 'Request to join',
        requestedTitle: 'Request submitted',
        requestedBody: "An admin will review your request — you'll be able to sign in once you're approved.",
        backToSignIn: 'Back to sign in',
        poweredBy: 'Powered by Whacka',
        close: 'Close',
        pin: 'PIN',
        pinPlaceholder: 'Your 6-digit PIN',
        pinSetPlaceholder: '6 digits',
        pinSubtitle: 'Enter your username and PIN.',
        pinAcceptSubtitle: 'Choose a 6-digit PIN to finish setting up your account.',
        pickName: 'Tap your name',
        findName: 'Find your name',
        notYou: 'Not you?',
        wrongPassword: 'Invalid username or password.',
        wrongPin: 'Invalid username or PIN.',
        tooManyTries: 'Too many failed attempts. Try again in a few minutes.',
        pendingApproval: 'Your account is waiting for an admin to approve it.',
        usernameTaken: 'That username is already taken — pick another.',
        usernameLatinOnly: 'Usernames use English letters, numbers and _ only.',
        usernameTooShort: 'Usernames are at least 3 characters.',
        passwordMin: 'Password must be at least 6 characters.',
        pinSix: 'PIN must be exactly 6 digits.',
        seatsFull: "This app can't add new members right now. The owner has been notified.",
        requestsClosed: "This app isn't taking new requests right now.",
        offline: 'Network error — check your connection and try again.',
        signupLink: 'New here? Create an account',
        signupTitle: 'Create an account',
        signupSubmit: 'Create account',
        signupPasswordPlaceholder: 'At least 6 characters',
        roleQuestion: 'I am',
        phone: 'Phone number',
        phonePlaceholder: 'e.g. 0551234567',
        phoneTooShort: 'Enter your phone number.',
        subtitlePhone: 'Enter your phone number and password.',
        pinSubtitlePhone: 'Enter your phone number and PIN.',
        forgotPassword: "Forgot your password? Ask this app's team to reset it.",
        forgotPin: "Forgot your PIN? Ask this app's team to reset it.",
        signupsClosed: "This app isn't taking sign-ups right now.",
        tooManySignups: 'Too many sign-ups right now. Try again in a few minutes.',
      }
  // Under a hidden brand the owner section stays — it is how the owner reaches
  // TeamAdmin — but its two sentences no longer name Whacka (2026-09-28).
  // Explicit labels still win.
  const NB = brandHidden
    ? (isArabic
        ? {
            ownerHint: 'الحساب الذي تدير به هذا التطبيق — لا توجد كلمة مرور منفصلة للمالك.',
            ownerMismatch: 'دخلت بحساب {email} وهو لا يملك هذا التطبيق.',
          }
        : faceLang === 'pt'
        ? {
            ownerHint: 'A conta com que você gerencia este app — sem senha de dono separada.',
            ownerMismatch: 'Você entrou como {email}, e essa conta não é dona deste app.',
          }
        : faceLang === 'es'
        ? {
            ownerHint: 'La cuenta con la que administras esta app — sin contraseña de dueño aparte.',
            ownerMismatch: 'Iniciaste sesión como {email}, y esa cuenta no es dueña de esta app.',
          }
        : {
            ownerHint: 'The account you manage this app with — no separate owner password.',
            ownerMismatch: "You signed in as {email}, which doesn't own this app.",
          })
    : null
  const L = { ...D, ...NB, ...labels }

  const [handle, setHandle] = useState('')        // login mode, or legacy-invite fallback
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [ownerBusy, setOwnerBusy] = useState(false)
  const [ownerMismatchEmail, setOwnerMismatchEmail] = useState(null)
  const [selfSignup, setSelfSignup] = useState(false)
  const [pinMode, setPinMode] = useState(false)
  const [memberPicker, setMemberPicker] = useState(false)
  // What the login name is (a username, or a phone number) and who may sign up to the
  // app's users list (team and users, 2026-10-30).
  const [loginName, setLoginName] = useState('username')
  const [signupCfg, setSignupCfg] = useState({ signup: 'invite', signupRoles: [], defaultRole: 'member' })
  const [signupRole, setSignupRole] = useState(null)
  // An app with two lists (a users list, or user roles declared): sign-up replaces the
  // old "request to join", and the card says who resets a forgotten password.
  const [twoLists, setTwoLists] = useState(false)
  const [view, setView] = useState('signin')   // 'signin' | 'request' | 'signup' | 'requested'

  // Per-app sign-in config: "request to join" option + PIN mode + member picker.
  // Accept (invite) mode needs it too — the new member sets a PIN there.
  useEffect(() => {
    let alive = true
    team.config().then((c) => {
      if (!alive) return
      setSelfSignup(!!c?.selfSignup)
      setPinMode(c?.loginConfig?.pin === true)
      setMemberPicker(c?.loginConfig?.memberPicker === true)
      setLoginName(c?.loginConfig?.loginName === 'phone' ? 'phone' : 'username')
      setTwoLists(c?.lists === true && (c?.usersList === true || (Array.isArray(userRoles) && userRoles.length > 0)))
      if (c?.signup && typeof c.signup.signup === 'string') {
        setSignupCfg({ signup: c.signup.signup, signupRoles: Array.isArray(c.signup.signupRoles) ? c.signup.signupRoles : [], defaultRole: c.signup.defaultRole || 'member' })
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  // Member picker roster (login mode only). null = typed form (picker off, roster
  // too large, fetch failed, or empty) — every failure path degrades to typing.
  const [pickerMembers, setPickerMembers] = useState(null)
  const [pickedMember, setPickedMember] = useState(null)
  const [pickerFilter, setPickerFilter] = useState('')
  useEffect(() => {
    if (!memberPicker || accepting) return
    let alive = true
    team.loginRoster()
      .then((r) => { if (alive && Array.isArray(r?.members) && r.members.length > 0) setPickerMembers(r.members) })
      .catch(() => {})
    return () => { alive = false }
  }, [memberPicker, accepting])

  // accept mode: the admin-assigned username (read-only) for this invite.
  const [assignedHandle, setAssignedHandle] = useState(null)
  const [inviteState, setInviteState] = useState(accepting ? 'loading' : 'ok') // loading | ok | invalid

  useEffect(() => {
    if (!accepting || !inviteCode) return
    let alive = true
    team.inviteInfo(inviteCode)
      .then((info) => { if (!alive) return; setAssignedHandle(info?.handle || null); setInviteState(info?.valid ? 'ok' : 'invalid') })
      .catch(() => { if (alive) setInviteState('invalid') })
    return () => { alive = false }
  }, [accepting, inviteCode])

  // What went wrong, in the card's words — never the server's English (delivery ledger P53).
  // The card words every refusal itself, the team's places included (seatsFull), so the
  // shell's own notice for a seat refusal stands down (_seat-notice.js, ledger P108).
  const failure = (e, step) => { e?.worded?.(); return L[teamFailureKey(e, step, pinMode)] || L.genericError }

  // A phone number is only a login name: digits, typed the same way each time (no text is sent).
  // A new login is made of its digits; signing in sends what was typed — the server folds it the
  // same way (digits, no + / spaces / dashes), and a login made with letters before the owner
  // chose phone numbers still signs in.
  const isPhone = loginName === 'phone'
  const signupValue = (v) => (isPhone ? foldTypedDigits(v).replace(/[^0-9]/g, '') : v)
  const signupProblem = (v) => (isPhone ? (signupValue(v).length >= 3 ? null : 'phoneTooShort') : usernameProblem(v))
  const nameLabel = isPhone ? L.phone : L.username
  const namePlaceholder = isPhone ? L.phonePlaceholder : L.usernamePlaceholder
  // dir=auto: typed digits run left to right, the Arabic placeholder right to left.
  const nameInputProps = isPhone ? { autoComplete: 'username', dir: 'auto' } : { autoComplete: 'username' }
  const signupNameInputProps = isPhone ? { inputMode: 'tel', autoComplete: 'tel', dir: 'auto' } : { autoComplete: 'username' }
  // The users list takes sign-ups (team.setSignup): 'anyone' signs in at once, 'approval' waits.
  const signupOpen = !accepting && (signupCfg.signup === 'anyone' || signupCfg.signup === 'approval')
  // The roles a person picks from: a question only when there are two or more.
  const signupChoices = signupCfg.signupRoles
  const signupPick = signupRole || (signupChoices.includes(signupCfg.defaultRole) ? signupCfg.defaultRole : signupChoices[0])
  // userRoles entries are role names or { name, label } (the shape <TeamAdmin userRoles> takes).
  const roleLabel = (name) => {
    const entry = (Array.isArray(userRoles) ? userRoles : []).find((r) => (typeof r === 'string' ? r : r?.name) === name)
    return (entry && typeof entry === 'object' && entry.label) || name.charAt(0).toUpperCase() + name.slice(1).replace(/[_-]+/g, ' ')
  }

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setErr(null)
    // A new account meets the server's rules before anything is sent.
    const problem = accepting && ((!assignedHandle && usernameProblem(handle)) || secretProblem(pinMode, password))
    if (problem) { setErr(L[problem]); return }
    setBusy(true)
    try {
      const result = accepting
        ? await team.acceptInvite({ code: inviteCode, password, displayName, handle: assignedHandle ? undefined : handle })
        : await team.login({ handle, password })
      onSignedIn?.(result)
    } catch (e) {
      setErr(failure(e, accepting ? 'accept' : 'login'))
    } finally {
      setBusy(false)
    }
  }

  async function submitRequest(e) {
    e.preventDefault()
    if (busy) return
    setErr(null)
    const problem = usernameProblem(handle) || secretProblem(pinMode, password)
    if (problem) { setErr(L[problem]); return }
    setBusy(true)
    try {
      await team.requestAccess({ handle, password, displayName })
      setView('requested')
    } catch (e) {
      setErr(failure(e, 'request'))
    } finally {
      setBusy(false)
    }
  }

  async function submitSignup(e) {
    e.preventDefault()
    if (busy) return
    setErr(null)
    const problem = signupProblem(handle) || secretProblem(pinMode, password)
    if (problem) { setErr(L[problem]); return }
    setBusy(true)
    try {
      const role = signupChoices.length ? signupPick : undefined
      const result = await team.signUp({ handle: signupValue(handle), password, displayName, role })
      if (result?.pending) setView('requested')
      else onSignedIn?.(result)
    } catch (e) {
      setErr(failure(e, 'signup'))
    } finally {
      setBusy(false)
    }
  }

  async function ownerSignInClick() {
    if (ownerBusy) return
    setOwnerBusy(true)
    try {
      // A session can already exist right here: Google/Apple sign-in returns via
      // a full-page round trip (the await below never resumes across it), and the
      // workspace "Open as owner" link lands already signed in. For a signed-in
      // user the modal opens the ACCOUNT sheet, whose only exits are sign-out /
      // delete / dismiss — it can never resolve a user, so the right-account
      // owner would dead-end. Adopt the session instead of asking again; a
      // wrong-account session still falls through to the modal, whose sheet
      // carries the mismatch notice + sign-out.
      if (auth.isAuthenticated() && auth.isAppOwner()) {
        setOwnerMismatchEmail(null)
        onSignedIn?.({ user: auth.getCurrentUser(), role: null, owner: true })
        return
      }
      const user = await auth.signIn({ context: 'owner' })
      if (!user) return
      // Verify before claiming owner: signing in successfully with SOME account
      // is not being the owner. Asserting owner:true unverified routed
      // wrong-account owners into empty admin views ("all my data is gone").
      if (auth.isAppOwner()) {
        setOwnerMismatchEmail(null)
        onSignedIn?.({ user, role: null, owner: true })
      } else {
        setOwnerMismatchEmail(user.email || '?')
      }
    } finally {
      setOwnerBusy(false)
    }
  }

  // PIN mode swaps the secret field's copy + keyboard; the member picker replaces
  // typing a username with tapping a name (login mode only, typed-form fallback).
  const pickerActive = !accepting && view === 'signin' && !!pickerMembers
  const showSecret = !pickerActive || !!pickedMember
  const secretLabel = pinMode ? L.pin : L.password
  const secretPlaceholder = pinMode
    ? (accepting || view === 'request' || view === 'signup' ? L.pinSetPlaceholder : L.pinPlaceholder)
    : (view === 'signup' ? L.signupPasswordPlaceholder : L.passwordPlaceholder)
  const secretProps = pinMode ? { inputMode: 'numeric', pattern: '[0-9]*', maxLength: 6 } : {}
  // A PIN typed on an Arabic / Persian keypad (٠-٩ / ۰-۹) is the same PIN (P49).
  const onSecretChange = (e) => setPassword(pinMode ? foldTypedDigits(e.target.value) : e.target.value)
  const subtitle = pinMode
    ? (accepting ? L.pinAcceptSubtitle : view === 'signin' || view === 'signup' ? (isPhone ? L.pinSubtitlePhone : L.pinSubtitle) : L.subtitle)
    : (isPhone && !accepting ? L.subtitlePhone : L.subtitle)
  const pickerQuery = pickerFilter.trim().toLowerCase()
  const pickerShown = pickerActive && !pickedMember
    ? pickerMembers.filter((m) => !pickerQuery
        || (m.displayName || '').toLowerCase().includes(pickerQuery)
        || (m.handle || '').toLowerCase().includes(pickerQuery))
    : []

  const card = (
    <div dir={isArabic ? 'rtl' : 'ltr'} className="relative w-full max-w-sm rounded-3xl border border-stone-200/80 bg-white p-6 shadow-2xl shadow-stone-900/10">
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={L.close}
          className="absolute end-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-stone-200 bg-stone-50 text-lg leading-none text-stone-400 transition hover:border-stone-900 hover:bg-stone-900 hover:text-white"
        >
          ×
        </button>
      )}

      <div className={`mb-5 ${onClose ? 'pe-10' : ''}`}>
        <h2 className="text-2xl font-bold tracking-tight text-stone-900">
          {view === 'signup' ? L.signupTitle : L.title}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-stone-500">
          {subtitle}
        </p>
      </div>

      {view === 'requested' ? (
        <div className="space-y-3">
          <p className="text-base font-semibold text-stone-900">{L.requestedTitle}</p>
          <p className="text-sm leading-relaxed text-stone-500">{L.requestedBody}</p>
          <button type="button" onClick={() => { setView('signin'); setErr(null); setHandle(''); setPassword(''); setDisplayName('') }} className="text-sm font-semibold text-primary hover:underline">{L.backToSignIn}</button>
        </div>
      ) : view === 'request' ? (
        <form onSubmit={submitRequest} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[13px] font-semibold text-stone-700">{L.username}</label>
            <input value={handle} onChange={(e) => setHandle(e.target.value)} autoCapitalize="none" autoCorrect="off" autoComplete="username" placeholder={L.usernamePlaceholder} className={FIELD} required maxLength={30} />
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-semibold text-stone-700">{L.displayName} <span className="font-normal text-stone-400">{L.displayNameHint}</span></label>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={L.displayNamePlaceholder} className={FIELD} />
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-semibold text-stone-700">{secretLabel}</label>
            <input type="password" value={password} onChange={onSecretChange} autoComplete="new-password" placeholder={secretPlaceholder} className={FIELD} required {...secretProps} />
          </div>
          {err && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm font-medium text-red-700">{err}</p>}
          <button type="submit" disabled={busy} style={{ color: onPrimaryColor() }} className="mt-1 flex w-full items-center justify-center gap-2 rounded-full bg-primary py-3 font-semibold shadow-sm transition hover:opacity-90 active:scale-[0.99] disabled:opacity-60">
            {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current opacity-70" style={{ borderTopColor: 'transparent' }} />}
            {busy ? L.busy : L.requestSubmit}
          </button>
          <button type="button" onClick={() => { setView('signin'); setErr(null) }} className="w-full text-center text-sm font-medium text-stone-500 hover:text-stone-700">{L.backToSignIn}</button>
        </form>
      ) : view === 'signup' ? (
        <form onSubmit={submitSignup} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[13px] font-semibold text-stone-700">{L.displayName} <span className="font-normal text-stone-400">{L.displayNameHint}</span></label>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={L.displayNamePlaceholder} className={FIELD} autoComplete="name" />
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-semibold text-stone-700">{nameLabel}</label>
            <input value={handle} onChange={(e) => setHandle(e.target.value)} autoCapitalize="none" autoCorrect="off" placeholder={namePlaceholder} className={FIELD} required maxLength={30} {...signupNameInputProps} />
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-semibold text-stone-700">{secretLabel}</label>
            <input type="password" value={password} onChange={onSecretChange} autoComplete="new-password" placeholder={secretPlaceholder} className={FIELD} required {...secretProps} />
          </div>
          {signupChoices.length > 1 && (
            <div>
              <span className="mb-1.5 block text-[13px] font-semibold text-stone-700">{L.roleQuestion}</span>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={L.roleQuestion}>
                {signupChoices.map((r) => {
                  const picked = signupPick === r
                  return (
                    <button
                      type="button" key={r} role="radio" aria-checked={picked} onClick={() => setSignupRole(r)}
                      style={picked ? { color: onPrimaryColor() } : undefined}
                      className={`rounded-full px-4 py-2 text-sm font-semibold transition ${picked ? 'bg-primary shadow-sm' : 'bg-stone-100 text-stone-700 hover:bg-stone-200'}`}
                    >
                      {roleLabel(r)}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {err && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm font-medium text-red-700">{err}</p>}
          <button type="submit" disabled={busy} style={{ color: onPrimaryColor() }} className="mt-1 flex w-full items-center justify-center gap-2 rounded-full bg-primary py-3 font-semibold shadow-sm transition hover:opacity-90 active:scale-[0.99] disabled:opacity-60">
            {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current opacity-70" style={{ borderTopColor: 'transparent' }} />}
            {busy ? L.busy : L.signupSubmit}
          </button>
          <button type="button" onClick={() => { setView('signin'); setErr(null) }} className="w-full text-center text-sm font-medium text-stone-500 hover:text-stone-700">{L.backToSignIn}</button>
        </form>
      ) : accepting && inviteState === 'invalid' ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm font-medium text-red-700">
          {L.invalidInvite}
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {accepting ? (
            // Username is assigned by the admin → show it read-only (legacy invites with
            // no assigned username fall back to an editable field).
            assignedHandle ? (
              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-stone-700">{nameLabel}</label>
                <div className="flex items-center rounded-xl border border-stone-200 bg-stone-100 px-3.5 py-2.5 text-[15px] font-medium text-stone-700">
                  {assignedHandle}
                </div>
              </div>
            ) : (
              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-stone-700">{L.username}</label>
                <input value={handle} onChange={(e) => setHandle(e.target.value)} autoCapitalize="none" autoCorrect="off" autoComplete="username" placeholder={L.usernamePlaceholder} className={FIELD} required maxLength={30} />
              </div>
            )
          ) : pickerActive && !pickedMember ? (
            // Member picker: tap your name instead of typing a username.
            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-stone-700">{L.pickName}</label>
              {pickerMembers.length > 12 && (
                <input
                  value={pickerFilter}
                  onChange={(e) => setPickerFilter(e.target.value)}
                  placeholder={L.findName}
                  className={`${FIELD} mb-2`}
                />
              )}
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-stone-200 bg-stone-50 p-1.5">
                {pickerShown.map((m) => (
                  <button
                    type="button"
                    key={m.handle}
                    onClick={() => { setPickedMember(m); setHandle(m.handle); setErr(null) }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start transition hover:bg-white hover:shadow-sm"
                  >
                    <span className="h-8 w-8 shrink-0 rounded-full bg-stone-200 bg-cover bg-center" style={m.avatarUrl ? { backgroundImage: `url(${m.avatarUrl})` } : undefined} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-stone-900">{m.displayName || m.handle}</span>
                      {m.displayName && m.displayName !== m.handle && (
                        <span className="block truncate text-xs text-stone-400">@{m.handle}</span>
                      )}
                    </span>
                  </button>
                ))}
                {pickerShown.length === 0 && (
                  <p className="px-2.5 py-3 text-center text-sm text-stone-400">·</p>
                )}
              </div>
            </div>
          ) : pickerActive && pickedMember ? (
            <div className="flex items-center gap-2.5 rounded-xl border border-stone-200 bg-stone-100 px-3 py-2">
              <span className="h-8 w-8 shrink-0 rounded-full bg-stone-200 bg-cover bg-center" style={pickedMember.avatarUrl ? { backgroundImage: `url(${pickedMember.avatarUrl})` } : undefined} />
              <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-stone-900">{pickedMember.displayName || pickedMember.handle}</span>
              <button
                type="button"
                onClick={() => { setPickedMember(null); setHandle(''); setPassword(''); setErr(null) }}
                className="shrink-0 text-xs font-semibold text-primary hover:underline"
              >
                {L.notYou}
              </button>
            </div>
          ) : (
            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-stone-700">{nameLabel}</label>
              <input value={handle} onChange={(e) => setHandle(e.target.value)} autoCapitalize="none" autoCorrect="off" placeholder={namePlaceholder} className={FIELD} required {...nameInputProps} />
            </div>
          )}

          {accepting && (
            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-stone-700">
                {L.displayName} <span className="font-normal text-stone-400">{L.displayNameHint}</span>
              </label>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={L.displayNamePlaceholder} className={FIELD} />
            </div>
          )}

          {showSecret && (
            <div>
              <label className="mb-1.5 block text-[13px] font-semibold text-stone-700">{secretLabel}</label>
              <input
                type="password"
                value={password}
                onChange={onSecretChange}
                autoComplete={accepting ? 'new-password' : 'current-password'}
                placeholder={secretPlaceholder}
                className={FIELD}
                autoFocus={pickerActive && !!pickedMember}
                required
                {...secretProps}
              />
              {!accepting && twoLists && <p className="mt-1.5 text-xs text-stone-400">{pinMode ? L.forgotPin : L.forgotPassword}</p>}
            </div>
          )}

          {err && (
            <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm font-medium text-red-700">{err}</p>
          )}

          {showSecret && (
            <button
              type="submit"
              disabled={busy || (accepting && inviteState === 'loading')}
              style={{ color: onPrimaryColor() }}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-full bg-primary py-3 font-semibold shadow-sm transition hover:opacity-90 active:scale-[0.99] disabled:opacity-60 disabled:active:scale-100"
            >
              {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current opacity-70" style={{ borderTopColor: 'transparent' }} />}
              {busy ? L.busy : L.submit}
            </button>
          )}
        </form>
      )}

      {/* The users list's sign-up: the way in for the people the app serves. */}
      {view === 'signin' && signupOpen && (
        <button type="button" onClick={() => { setView('signup'); setErr(null) }} className="mt-4 w-full rounded-full bg-stone-100 py-2.5 text-sm font-semibold text-stone-800 transition hover:bg-stone-200">
          {L.signupLink}
        </button>
      )}

      {/* Owner entry — the person who runs the app signs in with their Whacka ID. */}
      {view === 'signin' && !accepting && ownerSignIn && (
        <div className="mt-5">
          <div className="flex items-center gap-3 text-stone-300">
            <div className="h-px flex-1 bg-stone-200" />
            <span className="text-[11px] font-medium uppercase tracking-wider text-stone-400">{L.owner}</span>
            <div className="h-px flex-1 bg-stone-200" />
          </div>
          <button
            type="button"
            onClick={ownerSignInClick}
            disabled={ownerBusy}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-full border border-stone-200 bg-white py-2.5 text-sm font-semibold text-stone-700 transition hover:border-stone-300 hover:bg-stone-50 disabled:opacity-60"
          >
            {ownerBusy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600" />}
            {ownerBusy ? L.ownerBusy : L.ownerButton}
          </button>
          <p className="mt-2 text-center text-xs leading-relaxed text-stone-400">{L.ownerHint}</p>
          {ownerMismatchEmail && (
            <div role="alert" className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs font-medium leading-relaxed text-amber-800">
              {L.ownerMismatch.replace('{email}', ownerMismatchEmail)}{' '}
              <button
                type="button"
                onClick={() => { auth.signOut(); setOwnerMismatchEmail(null) }}
                className="font-semibold underline"
              >
                {L.ownerSignOut}
              </button>
            </div>
          )}
        </div>
      )}

      {view === 'signin' && selfSignup && !twoLists && !accepting && (
        <button type="button" onClick={() => { setView('request'); setErr(null) }} className="mt-3 w-full text-center text-sm font-medium text-stone-500 transition hover:text-stone-700">
          {L.requestLink}
        </button>
      )}

      {!brandHidden && (
        <p className="mt-6 flex items-center justify-center gap-1.5 text-xs font-medium text-stone-400">
          <WhackaMark size={14} />
          {L.poweredBy}
        </p>
      )}
    </div>
  )

  // fullScreen: render as the whole sign-in gate using the same robust overlay recipe as
  // the platform auth modal (fixed + overflow-y-auto + margin-auto card) — centers when
  // short, scrolls when tall, never clips behind a device frame / on a short viewport.
  // Optional `brand` (logo/tagline) renders above the card inside the scroll area.
  if (fullScreen) {
    return (
      <div className={`fixed inset-0 flex overflow-y-auto ${bgClassName}`} style={SAFE_PAD}>
        <div className="m-auto w-full max-w-sm">
          {brand ? <div className="mb-7 text-center">{brand}</div> : ownBrand?.icon && ownBrand.icon !== failedIcon ? (
            <div className="mb-7 flex justify-center">
              <img src={ownBrand.icon} alt="" className="h-16 w-16 rounded-[17px] object-cover" onError={() => setFailedIcon(ownBrand.icon)} />
            </div>
          ) : null}
          {card}
        </div>
      </div>
    )
  }
  return card
}

/**
 * Imperative entry used by team.signIn(): mounts <TeamLogin> in a modal overlay and
 * resolves with { user, role } on success, or null if dismissed.
 * @param {object} [options] - forwarded to <TeamLogin> ({ appName, code, mode, ownerSignIn })
 * @returns {Promise<{ user, role } | null>}
 */
export async function openTeamLogin(options = {}) {
  const { createRoot } = await import('react-dom/client')
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let settled = false

    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
      setTimeout(() => {
        try { root.unmount() } catch {}
        host.remove()
      }, 0)
    }

    // Same overlay recipe as the platform auth modal (auth-modal.js): a fixed, flex,
    // overflow-y-auto layer with a margin-auto card — centers when short, scrolls when
    // tall, never clips the bottom.
    root.render(
      <div
        className="fixed inset-0 z-[2147483600] flex overflow-y-auto bg-stone-950/50 backdrop-blur-sm"
        style={SAFE_PAD}
        onClick={(e) => { if (e.target === e.currentTarget) finish(null) }}
      >
        <div className="m-auto w-full max-w-sm">
          <TeamLogin
            {...options}
            onSignedIn={(result) => finish(result)}
            onClose={() => finish(null)}
          />
        </div>
      </div>
    )
  })
}
