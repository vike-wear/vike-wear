import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, Loader2, MessageCircle, ShieldCheck } from 'lucide-react'
import { db } from '../lib/db'
import { share } from '../lib/share'
import { useLiveShared } from '../lib/useLive'
import { useCart } from '../components/CartProvider'
import { cartTotal, DEFAULT_SETTINGS, money, orderCode } from '../shop'

const FIELD =
  'w-full rounded-xl border border-white/[0.12] bg-[#111113] px-4 py-3.5 text-sm text-[#f2f2f2] outline-none transition placeholder:text-[#6b6b6b] focus:border-primary/70 focus:bg-[#131315]'

const CITIES = [
  'القاهرة',
  'الجيزة',
  'الإسكندرية',
  'المنصورة',
  'طنطا',
  'أسيوط',
  'الأقصر',
  'أسوان',
  'بورسعيد',
  'الإسماعيلية',
  'الفيوم',
  'الغردقة',
  'مدينة أخرى',
]

export default function Checkout() {
  const cart = useCart()
  const navigate = useNavigate()
  const { data: settingsRows } = useLiveShared('settings', { limit: 1 })
  const settings = { ...DEFAULT_SETTINGS, ...(settingsRows?.[0] || {}) }
  const totals = cartTotal(cart.subtotal, settings)

  const [form, setForm] = useState({ name: '', phone: '', city: '', address: '', notes: '' })
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState('')
  const [placed, setPlaced] = useState(null)

  const set = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }))
    setErrors((prev) => ({ ...prev, [key]: '' }))
  }

  const validate = () => {
    const next = {}
    if (form.name.trim().length < 2) next.name = 'اكتب اسمك بالكامل'
    const digits = form.phone.replace(/[^\d]/g, '')
    if (digits.length < 10) next.phone = 'اكتب رقم موبايل صحيح'
    if (!form.city) next.city = 'اختار المحافظة'
    if (form.address.trim().length < 6) next.address = 'اكتب العنوان بالتفصيل'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const buildSummary = (order) =>
    [
      `طلب ${order.code}`,
      ...order.items.map((i) => `• ${i.name} — ${i.size} / ${i.color} × ${i.qty}`),
      `الإجمالي: ${money(order.total, settings.currency)}`,
      `الاسم: ${order.customerName}`,
      `الموبايل: ${order.phone}`,
      `${order.city} — ${order.address}`,
    ].join('\n')

  const submit = async () => {
    if (busy || !validate()) return
    setBusy(true)
    setServerError('')

    const code = orderCode()
    const order = {
      code,
      items: cart.items.map((i) => ({
        sku: i.sku,
        name: i.name,
        size: i.size,
        color: i.color,
        qty: i.qty,
        price: Number(i.price),
      })),
      subtotal: cart.subtotal,
      shipping: totals.shipping,
      total: totals.total,
      customerName: form.name.trim(),
      phone: form.phone.trim(),
      city: form.city,
      address: form.address.trim(),
      notes: form.notes.trim(),
      payment: 'الدفع عند الاستلام',
      status: 'new',
    }

    try {
      await db.insertShared('orders', order, code, {
        groupId: 'key:orders',
        visibleTo: 'creator-and-admin',
      })
      cart.clear()
      setPlaced(order)
    } catch (err) {
      setServerError(
        err?.say || 'مش قادرين نسجّل طلبك دلوقتي. جرّب تاني بعد شوية أو كلّمنا على واتساب.',
      )
    } finally {
      setBusy(false)
    }
  }

  /* ── success ─────────────────────────────────────────── */
  if (placed) {
    const hasWa = String(settings.whatsapp || '').replace(/[^\d]/g, '').length >= 10
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-xl px-4 py-14 text-center md:px-8 md:py-20">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-primary text-black">
            <Check size={30} strokeWidth={3} />
          </div>
          <h1 className="font-display mt-6 text-3xl font-black">طلبك وصل</h1>
          <p className="mt-3 text-sm leading-7 text-[#a8a8a8]">
            سجّلنا طلبك رقم <span className="font-black text-primary">{placed.code}</span> بإجمالي{' '}
            <span className="font-black text-[#f2f2f2]">{money(placed.total, settings.currency)}</span>
            . هنكلّمك على {placed.phone} لتأكيد العنوان والميعاد.
          </p>

          <div className="mt-6 rounded-2xl border border-white/10 bg-[#0f0f11] p-4 text-right">
            {placed.items.map((i, idx) => (
              <div key={idx} className="flex justify-between gap-3 py-1 text-xs text-[#a8a8a8]">
                <span>
                  {i.name} — {i.size} / {i.color}
                </span>
                <span className="shrink-0 font-bold text-[#f2f2f2]">×{i.qty}</span>
              </div>
            ))}
          </div>

          {hasWa && (
            <button
              onClick={() => share.whatsapp(settings.whatsapp, buildSummary(placed))}
              className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/25 bg-white/5 px-6 py-4 text-sm font-black text-[#f2f2f2] transition hover:border-white/60 hover:bg-white/10"
            >
              <MessageCircle size={16} />
              ابعتهولنا على واتساب لتأكيد أسرع
            </button>
          )}

          <Link
            to="/shop"
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/[0.15] px-6 py-4 text-sm font-bold text-[#f2f2f2] transition hover:border-white/40"
          >
            رجّعني للمتجر
          </Link>
        </div>
      </div>
    )
  }

  /* ── empty cart guard ────────────────────────────────── */
  if (cart.items.length === 0) {
    return (
      <div className="grid h-full place-items-center px-6 pb-24 text-center md:pb-0">
        <div>
          <h1 className="font-display text-xl font-black">سلتك فاضية</h1>
          <p className="mt-2 text-sm text-[#8a8a8a]">اختار قطعة الأول وبعدين كمّل الطلب.</p>
          <button
            onClick={() => navigate('/shop')}
            className="mt-6 rounded-full bg-primary px-6 py-3 text-sm font-black text-black"
          >
            المتجر
          </button>
        </div>
      </div>
    )
  }

  /* ── form ────────────────────────────────────────────── */
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 pt-6 md:px-8 md:pt-10">
        <button
          onClick={() => navigate('/cart')}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-[#8a8a8a] transition hover:text-primary"
        >
          <ArrowLeft size={14} className="rotate-180" />
          رجوع للسلة
        </button>

        <h1 className="font-display mt-3 text-3xl font-black md:text-4xl">إتمام الطلب</h1>
        <p className="mt-2 text-sm text-[#8a8a8a]">
          من غير حساب ومن غير دفع أونلاين — بتدفع للمندوب لما توصلك.
        </p>

        <div className="mt-7 grid gap-7 lg:grid-cols-[1fr_300px]">
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-[11px] font-black tracking-widest text-[#8a8a8a]">
                الاسم بالكامل
              </label>
              <input
                className={FIELD}
                value={form.name}
                onChange={set('name')}
                placeholder="محمد أحمد"
                autoComplete="name"
              />
              {errors.name && <p className="mt-1 text-[11px] text-[#f2f2f2]">{errors.name}</p>}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-[11px] font-black tracking-widest text-[#8a8a8a]">
                  رقم الموبايل
                </label>
                <input
                  className={FIELD}
                  value={form.phone}
                  onChange={set('phone')}
                  placeholder="01xxxxxxxxx"
                  inputMode="tel"
                  autoComplete="tel"
                />
                {errors.phone && <p className="mt-1 text-[11px] text-[#f2f2f2]">{errors.phone}</p>}
              </div>

              <div>
                <label className="mb-1.5 block text-[11px] font-black tracking-widest text-[#8a8a8a]">
                  المحافظة
                </label>
                <select className={FIELD} value={form.city} onChange={set('city')}>
                  <option value="">اختار المحافظة</option>
                  {CITIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                {errors.city && <p className="mt-1 text-[11px] text-[#f2f2f2]">{errors.city}</p>}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[11px] font-black tracking-widest text-[#8a8a8a]">
                العنوان بالتفصيل
              </label>
              <textarea
                className={`${FIELD} min-h-[90px] resize-y`}
                value={form.address}
                onChange={set('address')}
                placeholder="الحي / الشارع / رقم العمارة / الدور / علامة مميزة"
              />
              {errors.address && <p className="mt-1 text-[11px] text-[#f2f2f2]">{errors.address}</p>}
            </div>

            <div>
              <label className="mb-1.5 block text-[11px] font-black tracking-widest text-[#8a8a8a]">
                ملاحظات (اختياري)
              </label>
              <textarea
                className={`${FIELD} min-h-[70px] resize-y`}
                value={form.notes}
                onChange={set('notes')}
                placeholder="وقت التوصيل المناسب، أو أي تفاصيل تحب تقولها"
              />
            </div>

            <div className="flex items-center gap-3 rounded-2xl border border-primary/25 bg-primary/[0.07] px-4 py-3.5">
              <ShieldCheck size={18} className="shrink-0 text-primary" />
              <div className="text-[11px] leading-5 text-[#cfcfcf]">
                <span className="font-black text-primary">الدفع عند الاستلام</span> — بتفتح الشنطة
                وتشوف القطعة، وبعدين تدفع للمندوب.
              </div>
            </div>

            {serverError && (
              <p className="rounded-xl border border-white/25 bg-white/[0.07] px-4 py-3 text-xs leading-5 text-[#f2f2f2]">
                {serverError}
              </p>
            )}
          </div>

          {/* summary */}
          <div className="lg:sticky lg:top-6 lg:self-start">
            <div className="rounded-3xl border border-white/10 bg-[#0f0f11] p-5">
              <h2 className="font-display text-base font-bold">طلبك</h2>
              <div className="mt-3 space-y-2">
                {cart.items.map((i) => (
                  <div key={i.key} className="flex justify-between gap-2 text-[11px] text-[#a8a8a8]">
                    <span className="min-w-0">
                      <span className="block truncate font-bold text-[#f2f2f2]">{i.name}</span>
                      {i.size} / {i.color} × {i.qty}
                    </span>
                    <span className="shrink-0 font-bold text-[#f2f2f2]">
                      {money(i.price * i.qty, settings.currency)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-4 space-y-2 border-t border-white/10 pt-3 text-xs">
                <div className="flex justify-between text-[#a8a8a8]">
                  <span>المجموع الفرعي</span>
                  <span>{money(cart.subtotal, settings.currency)}</span>
                </div>
                <div className="flex justify-between text-[#a8a8a8]">
                  <span>الشحن</span>
                  <span>{totals.free ? 'مجاني' : money(totals.shipping, settings.currency)}</span>
                </div>
                <div className="flex justify-between pt-2 text-sm">
                  <span className="font-display font-bold">الإجمالي</span>
                  <span className="font-display font-black text-primary">
                    {money(totals.total, settings.currency)}
                  </span>
                </div>
              </div>

              <button
                onClick={submit}
                disabled={busy}
                className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-primary px-6 py-4 text-sm font-black text-black transition hover:bg-[#d8d8d8] active:scale-[0.99] disabled:cursor-wait disabled:opacity-70"
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : null}
                {busy ? 'بنسجّل طلبك…' : 'أكّد الطلب'}
              </button>
              <p className="mt-3 text-center text-[10px] leading-4 text-[#6b6b6b]">
                بتأكيدك للطلب إنت موافق على إننا نتواصل معاك على نفس الرقم.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="h-24 md:h-10" />
    </div>
  )
}
