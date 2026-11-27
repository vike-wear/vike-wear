/**
 * Credits-gate modal — shown when a user exhausts their credits
 * in a published Whacka app. Content adapts to tier + exhaustion reason.
 *
 * NO prices are baked into this file. The server sends current plan/topup
 * pricing on the credits-exhausted 429 (`pricing` field, see
 * RUNTIME_GATE_PRICING in entitlements) and the modal renders whatever
 * arrives. When the payload is absent (older server) it falls back to
 * numberless copy linking to the platform — baked numbers in published
 * bundles are exactly what went stale before.
 */

import { brandingHidden, refreshBranding } from './_branding'
import { resolveFaceLang, isRtlLang } from './_lang.js'

const PLATFORM_URL = import.meta.env.VITE_API_BASE || 'https://whacka.app'

const PAID_TIERS = ['starter', 'pro', 'ultra']

// Fallback labels for the paid headline when no pricing payload arrived.
const TIER_LABELS = { starter: 'Starter', pro: 'Pro', ultra: 'Ultra' }

const NEXT_TIER = { free: 'starter', starter: 'pro', pro: 'ultra' }

const STRINGS_AR = {
      freeDailyH: 'نفد رصيدك اليومي',
      freeDailySub: 'يتجدد رصيدك المجاني اليومي عند منتصف الليل (UTC).<br>اشترك في خطة للحصول على رصيد شهري أكبر.',
      freeMonthlyH: 'وصلت إلى الحد الشهري المجاني',
      freeMonthlySub: 'استخدمت رصيدك المجاني لهذا الشهر.<br>اشترك في خطة للمزيد.',
      restrictedH: 'هذا الحساب لا يحصل على رصيد مجاني',
      restrictedSub: 'لا يوجد رصيد مجاني يتجدد على هذا الحساب.<br>الباقات وشحن الرصيد تعمل بشكل طبيعي.',
      paidH: (label) => `نفد رصيد خطتك ${label}`,
      paidSub: 'أعد التعبئة أو قم بالترقية للمتابعة',
      topup: (n, price) => `إضافة ${n} رصيد — $${price}`,
      topupFallback: 'إضافة رصيد',
      upgradeTo: (label, credits) => `الترقية إلى ${label} — ${credits}/شهر`,
      upgradeToFallback: (label) => `الترقية إلى ${label}`,
      perMo: '/شهر',
      needLine: (req, have) => `يحتاج هذا الطلب إلى ${req} كريدت، ولديك ${have}.`,
      seePlans: 'عرض الخطط والأسعار',
      close: 'إغلاق',
      poweredBy: 'مقدَّم من <span>Whacka</span>',
      // An app that shows no Whacka sells no Whacka (W3): the same lines
      // without the plan sentence.
      freeDailySubPlain: 'يتجدد رصيدك المجاني اليومي عند منتصف الليل (UTC).',
      freeMonthlySubPlain: 'استخدمت رصيدك المجاني لهذا الشهر.',
      restrictedSubPlain: 'لا يوجد رصيد مجاني يتجدد على هذا الحساب.',
    }

const STRINGS_EN = {
      freeDailyH: 'Today’s credits are used up',
      freeDailySub: 'Your free daily credits refresh at midnight UTC.<br>Get a plan for more credits every month.',
      freeMonthlyH: 'Monthly free limit reached',
      freeMonthlySub: 'You’ve used this month’s free credits.<br>Get a plan to unlock more.',
      restrictedH: 'This account doesn’t receive free credits',
      restrictedSub: 'No free credits refresh on this account.<br>Plans and credit top-ups work normally.',
      paidH: (label) => `Your ${label} credits are used up`,
      paidSub: 'Top up or upgrade to keep going',
      topup: (n, price) => `Top up ${n} credits — $${price}`,
      topupFallback: 'Top up credits',
      upgradeTo: (label, credits) => `Upgrade to ${label} — ${credits}/mo`,
      upgradeToFallback: (label) => `Upgrade to ${label}`,
      perMo: '/mo',
      needLine: (req, have) => `This request needs ${req} credits. You have ${have}.`,
      seePlans: 'See plans & pricing',
      close: 'Close',
      poweredBy: 'Powered by <span>Whacka</span>',
      // An app that shows no Whacka sells no Whacka (W3): the same lines
      // without the plan sentence.
      freeDailySubPlain: 'Your free daily credits refresh at midnight UTC.',
      freeMonthlySubPlain: 'You’ve used this month’s free credits.',
      restrictedSubPlain: 'No free credits refresh on this account.',
    }

const STRINGS_PT = {
      freeDailyH: 'Os créditos de hoje acabaram',
      freeDailySub: 'Seus créditos grátis diários renovam à meia-noite (UTC).<br>Assine um plano para ter mais créditos todo mês.',
      freeMonthlyH: 'Limite grátis do mês atingido',
      freeMonthlySub: 'Você usou os créditos grátis deste mês.<br>Assine um plano para liberar mais.',
      restrictedH: 'Esta conta não recebe créditos grátis',
      restrictedSub: 'Nenhum crédito grátis é renovado nesta conta.<br>Planos e recargas de créditos funcionam normalmente.',
      paidH: (label) => `Os créditos do seu plano ${label} acabaram`,
      paidSub: 'Recarregue ou faça upgrade para continuar',
      topup: (n, price) => `Recarregar ${n} créditos — $${price}`,
      topupFallback: 'Recarregar créditos',
      upgradeTo: (label, credits) => `Fazer upgrade para ${label} — ${credits}/mês`,
      upgradeToFallback: (label) => `Fazer upgrade para ${label}`,
      perMo: '/mês',
      needLine: (req, have) => `Este pedido precisa de ${req} créditos. Você tem ${have}.`,
      seePlans: 'Ver planos e preços',
      close: 'Fechar',
      poweredBy: 'Com tecnologia de <span>Whacka</span>',
      freeDailySubPlain: 'Seus créditos grátis diários renovam à meia-noite (UTC).',
      freeMonthlySubPlain: 'Você usou os créditos grátis deste mês.',
      restrictedSubPlain: 'Nenhum crédito grátis é renovado nesta conta.',
    }

const STRINGS_ES = {
      freeDailyH: 'Se acabaron los créditos de hoy',
      freeDailySub: 'Tus créditos gratis diarios se renuevan a medianoche (UTC).<br>Elige un plan para tener más créditos cada mes.',
      freeMonthlyH: 'Llegaste al límite gratis del mes',
      freeMonthlySub: 'Ya usaste los créditos gratis de este mes.<br>Elige un plan para desbloquear más.',
      restrictedH: 'Esta cuenta no recibe créditos gratis',
      restrictedSub: 'En esta cuenta no se renuevan créditos gratis.<br>Los planes y las recargas de créditos funcionan con normalidad.',
      paidH: (label) => `Se acabaron los créditos de tu plan ${label}`,
      paidSub: 'Recarga o mejora tu plan para seguir',
      topup: (n, price) => `Recargar ${n} créditos — $${price}`,
      topupFallback: 'Recargar créditos',
      upgradeTo: (label, credits) => `Mejorar a ${label} — ${credits}/mes`,
      upgradeToFallback: (label) => `Mejorar a ${label}`,
      perMo: '/mes',
      needLine: (req, have) => `Esta solicitud necesita ${req} créditos. Tienes ${have}.`,
      seePlans: 'Ver planes y precios',
      close: 'Cerrar',
      poweredBy: 'Con tecnología de <span>Whacka</span>',
      freeDailySubPlain: 'Tus créditos gratis diarios se renuevan a medianoche (UTC).',
      freeMonthlySubPlain: 'Ya usaste los créditos gratis de este mes.',
      restrictedSubPlain: 'En esta cuenta no se renuevan créditos gratis.',
    }

const STRINGS = { en: STRINGS_EN, ar: STRINGS_AR, pt: STRINGS_PT, es: STRINGS_ES }

// v5 brand (cream/ink/yellow), ported from auth-modal.js so the paywall reads as
// the same product as the sign-in surface a user sees seconds later. System font
// stack (no runtime webfont fetch — the shadow root can't reach next/font).
const STYLES = `
  :host {
    --cg-bg: #FFFFFF;
    --cg-cream: #F1EFE8;
    --cg-line: rgba(36,56,184,0.25);
    --cg-line-soft: rgba(36,56,184,0.15);
    --cg-ink: #20255C;
    --cg-ink-soft: #5A5F96;
    --cg-ink-mute: #5A5F96;
    --cg-accent: #FF4FA3;
    --cg-primary: #20255C;
    --cg-primary-hover: #000000;
    --cg-overlay: rgba(20, 16, 6, 0.42);
    --cg-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
      'Helvetica Neue', Arial, sans-serif;

    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
      max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    overflow-y: auto;
    font-family: var(--cg-font);
    color: var(--cg-ink);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  .overlay {
    position: fixed;
    inset: 0;
    background: var(--cg-overlay);
    animation: cg-fade 0.22s ease both;
  }

  @keyframes cg-fade { from { opacity: 0 } }

  @keyframes cg-pop {
    from { opacity: 0; transform: translateY(16px) scale(0.985); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  .card {
    position: relative;
    width: 100%;
    max-width: 380px;
    margin: auto;
    background: var(--cg-bg);
    border: 1px solid var(--cg-line);
    border-radius: 24px;
    box-shadow:
      0 1px 1px rgba(28, 18, 8, 0.04),
      0 30px 64px -34px rgba(28, 18, 8, 0.55),
      0 8px 22px -14px rgba(20, 16, 6, 0.20);
    animation: cg-pop 0.30s cubic-bezier(0.22, 1, 0.36, 1) both;
    overflow: hidden;
  }

  .body { padding: 28px 24px 22px; text-align: center; }

  .icon {
    width: 52px; height: 52px; margin: 0 auto 14px;
    border-radius: 15px; background: var(--cg-accent);
    display: flex; align-items: center; justify-content: center;
  }
  .icon svg { display: block; }
  /* Whacka hidden (W3): the pink chip is Whacka's — neutral, as the sign-in
     window's chip under white-label (auth-modal :host(.wk-nobrand)). */
  :host(.wk-nobrand) .icon { background: #EDEDF0; }

  .headline {
    font-size: 19px;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.2;
    color: var(--cg-ink);
    text-wrap: balance;
    margin-bottom: 7px;
  }

  .sub {
    font-size: 14px;
    font-weight: 500;
    color: var(--cg-ink-soft);
    text-wrap: pretty;
    margin-bottom: 20px;
  }

  .plans {
    border: 1px solid var(--cg-line);
    border-radius: 14px;
    overflow: hidden;
    margin-bottom: 18px;
    text-align: start;
  }

  /* The whole row is the tap target (≥46px) — the price is the affordance. */
  .plan-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 46px;
    padding: 8px 8px 8px 15px;
    font-size: 13.5px;
    color: var(--cg-ink);
    text-decoration: none;
    transition: background 0.15s;
  }
  .plan-row:hover { background: var(--cg-cream); }
  .plan-row + .plan-row { border-top: 1px solid var(--cg-line-soft); }

  .plan-name  { font-weight: 700; min-width: 52px; }
  .plan-credits { color: var(--cg-ink-mute); flex: 1; }

  .plan-price {
    flex-shrink: 0;
    padding: 7px 13px;
    font-size: 13px;
    font-weight: 700;
    color: var(--cg-ink);
    background: var(--cg-cream);
    border: 1px solid var(--cg-line);
    border-radius: 999px;
  }

  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    min-height: 48px;
    padding: 12px 16px;
    font-size: 14.5px;
    font-weight: 700;
    font-family: var(--cg-font);
    border: none;
    border-radius: 999px;
    cursor: pointer;
    text-decoration: none;
    color: #fff;
    background: var(--cg-primary);
    transition: background 0.16s;
  }

  .btn:hover { background: var(--cg-primary-hover); }

  .btn-outline {
    background: transparent;
    color: var(--cg-ink);
    border: 1.5px solid var(--cg-line);
    margin-top: 8px;
  }

  .btn-outline:hover { background: var(--cg-cream); border-color: var(--cg-ink); }

  .note {
    margin-top: 14px;
    font-size: 12px;
    color: var(--cg-ink-mute);
  }

  .close-btn {
    position: absolute;
    top: 13px;
    inset-inline-end: 13px;
    width: 30px;
    height: 30px;
    border: 1px solid var(--cg-line);
    background: var(--cg-cream);
    cursor: pointer;
    border-radius: 999px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--cg-ink-mute);
    font-size: 15px;
    line-height: 1;
    padding: 0;
    transition: background 0.18s, color 0.18s, border-color 0.18s;
  }
  /* 44px+ hit area without changing the visual size. */
  .close-btn::after { content: ''; position: absolute; inset: -9px; }
  .close-btn:hover { background: var(--cg-ink); color: #fff; border-color: var(--cg-ink); }

  .footer {
    text-align: center;
    padding: 12px 24px;
    border-top: 1px solid var(--cg-line-soft);
    font-size: 11.5px;
    color: var(--cg-ink-mute);
    font-weight: 500;
  }

  .footer span { color: var(--cg-ink); font-weight: 700; }

  @media (max-width: 480px) {
    .card { max-width: 420px; }
    .body { padding: 24px 18px 18px; }
  }
`

// v5 credits mark: an ink bolt on the yellow icon chip (matches the platform gate).
const ICON_BOLT = '<div class="icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M13 2 L4.5 13.5 H11 L10 22 L19.5 9.5 H12.5 Z" fill="#20255C"/></svg></div>'

// Server payload values land in innerHTML — coerce/escape even though the
// source is our own API.
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function fmtCredits(n, T) {
  return Number(n).toLocaleString(T === STRINGS_PT ? 'pt-BR' : 'en-US')
}

// CTAs route through the platform's tracked redirect (which 302s to the same
// upgrade/topup landing as before) so click-throughs are counted server-side;
// destinations are whitelisted there.
function upgradeHref(tierId) {
  return `${PLATFORM_URL}/api/analytics/gate-click?to=${encodeURIComponent(tierId)}`
}

// Plan table for free users: server-priced rows, or a numberless CTA when no
// payload arrived.
function buildPlansBlock(pricing, T) {
  const plans = pricing && Array.isArray(pricing.plans) ? pricing.plans : []
  if (!plans.length) {
    return `<a class="btn" href="${upgradeHref('starter')}" target="_blank" rel="noopener">${T.seePlans}</a>`
  }
  const rows = plans.map(p =>
    `<a class="plan-row" href="${upgradeHref(p.id)}" target="_blank" rel="noopener">
      <span class="plan-name">${esc(p.label)}</span>
      <span class="plan-credits">${fmtCredits(p.credits, T)}${T.perMo}</span>
      <span class="plan-price">$${Number(p.monthly)}${T.perMo}</span>
    </a>`
  ).join('')
  return `<div class="plans">${rows}</div>`
}

function buildFreeDailyContent(pricing, T) {
  return `
    ${ICON_BOLT}
    <div class="headline">${T.freeDailyH}</div>
    <div class="sub">${T.freeDailySub}</div>
    ${buildPlansBlock(pricing, T)}
  `
}

function buildFreeMonthlyContent(pricing, T) {
  return `
    ${ICON_BOLT}
    <div class="headline">${T.freeMonthlyH}</div>
    <div class="sub">${T.freeMonthlySub}</div>
    ${buildPlansBlock(pricing, T)}
  `
}

// Permanent no-free-credits account (server sends exhaustion 'restricted').
// Falling through to the daily card would promise a midnight refresh that
// never comes — the published-app twin of the platform gate's honest state.
function buildRestrictedContent(pricing, T) {
  return `
    ${ICON_BOLT}
    <div class="headline">${T.restrictedH}</div>
    <div class="sub">${T.restrictedSub}</div>
    ${buildPlansBlock(pricing, T)}
  `
}

function buildPaidContent(tier, pricing, T) {
  const plans = pricing && Array.isArray(pricing.plans) ? pricing.plans : []
  const label = plans.find(p => p.id === tier)?.label || TIER_LABELS[tier] || tier
  const topup = pricing?.topup
  const topupLabel = topup ? T.topup(fmtCredits(topup.credits, T), Number(topup.price)) : T.topupFallback
  let html = `
    ${ICON_BOLT}
    <div class="headline">${T.paidH(esc(label))}</div>
    <div class="sub">${T.paidSub}</div>
    <a class="btn" href="${PLATFORM_URL}/api/analytics/gate-click?to=topup" target="_blank" rel="noopener">${topupLabel}</a>
  `
  const next = NEXT_TIER[tier]
  if (next) {
    const np = plans.find(p => p.id === next)
    const upgradeLabel = np
      ? T.upgradeTo(esc(np.label), fmtCredits(np.credits, T))
      : T.upgradeToFallback(TIER_LABELS[next])
    html += `<a class="btn btn-outline" href="${upgradeHref(next)}" target="_blank" rel="noopener">${upgradeLabel}</a>`
  }
  return html
}

// An app whose owner turned Whacka branding off, on a plan that honours it
// (src/lib/app/brand.ts — ran 2026-10-28: an app that shows no Whacka sells no
// Whacka): the same headline and when it comes back, no plan table, prices,
// top-up or links to the platform. The owner keeps their users off this card
// by paying for them (sponsor).
function buildPlainContent(tier, exhaustion, pricing, T) {
  if (PAID_TIERS.includes(tier)) {
    const plans = pricing && Array.isArray(pricing.plans) ? pricing.plans : []
    const label = plans.find(p => p.id === tier)?.label || TIER_LABELS[tier] || tier
    return `${ICON_BOLT}<div class="headline">${T.paidH(esc(label))}</div>`
  }
  if (exhaustion === 'restricted') return `${ICON_BOLT}<div class="headline">${T.restrictedH}</div><div class="sub">${T.restrictedSubPlain}</div>`
  if (exhaustion === 'monthly') return `${ICON_BOLT}<div class="headline">${T.freeMonthlyH}</div><div class="sub">${T.freeMonthlySubPlain}</div>`
  return `${ICON_BOLT}<div class="headline">${T.freeDailyH}</div><div class="sub">${T.freeDailySubPlain}</div>`
}

let gateOpen = false

/**
 * Show a credits-exhaustion modal.
 * @param {string} tier — user tier (free, starter, pro, ultra)
 * @param {string} [exhaustion] — 'daily', 'monthly' or 'restricted'
 * @param {object} [pricing] — server-sent plan/topup pricing from the 429 body
 * @param {{required?: number, remaining?: number}} [need] — what the refused
 *   call would have cost and what the caller has (the AI gateway sends both
 *   since 2026-10-01; a document read priced by its length can need more than
 *   the balance). Rendered as one line under the headline when `required` is a
 *   number; absent on older servers → the modal is exactly as before.
 */
export function showCreditsGate(tier, exhaustion, pricing, need) {
  if (gateOpen) return Promise.resolve(null)
  gateOpen = true

  // Language at OPEN time (not module eval — apps set documentElement.dir/lang
  // during their own boot) via the one cascade every platform face shares
  // (_lang.js, 2026-09-28); white-label at open time too — refreshBranding()
  // is deduped; the launch-time fetch (main.jsx) has usually confirmed the
  // cached answer by now. Fail-open to branding.
  const lang = resolveFaceLang()
  const T = STRINGS[lang] || STRINGS_EN
  refreshBranding()

  return new Promise((resolve) => {
    const host = document.createElement('div')
    host.dir = isRtlLang(lang) ? 'rtl' : 'ltr'
    if (brandingHidden()) host.classList.add('wk-nobrand')
    const shadow = host.attachShadow({ mode: 'closed' })

    function close() {
      gateOpen = false
      document.removeEventListener('keydown', onKey)
      host.remove()
      resolve(null)
    }

    const style = document.createElement('style')
    style.textContent = STYLES
    shadow.appendChild(style)

    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    overlay.addEventListener('click', close)
    shadow.appendChild(overlay)

    const card = document.createElement('div')
    card.className = 'card'
    card.addEventListener('click', (e) => e.stopPropagation())
    shadow.appendChild(card)

    const closeBtn = document.createElement('button')
    closeBtn.className = 'close-btn'
    closeBtn.innerHTML = '&#x2715;'
    closeBtn.setAttribute('aria-label', T.close)
    closeBtn.addEventListener('click', close)
    card.appendChild(closeBtn)

    const body = document.createElement('div')
    body.className = 'body'

    if (brandingHidden()) {
      body.innerHTML = buildPlainContent(tier, exhaustion, pricing, T)
    } else if (PAID_TIERS.includes(tier)) {
      body.innerHTML = buildPaidContent(tier, pricing, T)
    } else if (exhaustion === 'restricted') {
      body.innerHTML = buildRestrictedContent(pricing, T)
    } else if (exhaustion === 'monthly') {
      body.innerHTML = buildFreeMonthlyContent(pricing, T)
    } else {
      body.innerHTML = buildFreeDailyContent(pricing, T)
    }
    if (need && typeof need.required === 'number' && need.required > 0) {
      const have = typeof need.remaining === 'number' && need.remaining >= 0 ? need.remaining : 0
      const h = body.querySelector('.headline')
      if (h) h.insertAdjacentHTML('afterend', `<div class="sub">${esc(T.needLine(fmtCredits(need.required, T), fmtCredits(have, T)))}</div>`)
    }

    card.appendChild(body)

    body.querySelectorAll('a.btn, a.plan-row').forEach((a) => {
      a.addEventListener('click', () => setTimeout(close, 300))
    })

    // White-label (Whacka off on the app's plan — the one judgment, shared
    // with the corner badge + auth modal + TeamLogin): no "Powered by Whacka"
    // footer, and no plans either (buildPlainContent above).
    if (!brandingHidden()) {
      const footer = document.createElement('div')
      footer.className = 'footer'
      footer.innerHTML = T.poweredBy
      card.appendChild(footer)
    }

    function onKey(e) { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)

    document.body.appendChild(host)
  })
}
