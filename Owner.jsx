import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Loader2,
  LogOut,
  Package,
  Settings2,
  ClipboardList,
  Check,
  Phone,
  MapPin,
  Camera,
  Palette,
  X,
  Plus,
  ChevronDown,
} from 'lucide-react'
import { auth } from '../lib/auth'
import { db } from '../lib/db'
import { storage } from '../lib/storage'
import { useLiveShared } from '../lib/useLive'
import { DEFAULT_SETTINGS, money, settingsPayload, sizesFor } from '../shop'

const STATUSES = [
  { id: 'new', label: 'جديد', cls: 'bg-primary text-black' },
  { id: 'shipped', label: 'اتشحن', cls: 'bg-[#2f2f33] text-white' },
  { id: 'done', label: 'اتسلّم', cls: 'bg-white text-black' },
  { id: 'cancelled', label: 'ملغي', cls: 'bg-[#242426] text-[#a8a8a8]' },
]

function statusOf(id) {
  return STATUSES.find((s) => s.id === id) || STATUSES[0]
}

function fmtDate(value) {
  if (!value) return ''
  try {
    return new Date(value).toLocaleDateString('ar-EG-u-nu-latn', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

/* ── orders ─────────────────────────────────────────────── */
function OrdersTab({ currency }) {
  const { data: orders, loading } = useLiveShared('orders', { order: '-createdAt' })
  const [busy, setBusy] = useState('')

  const list = orders || []
  const open = list.filter((o) => o.status !== 'done' && o.status !== 'cancelled').length
  const revenue = list
    .filter((o) => o.status !== 'cancelled')
    .reduce((n, o) => n + Number(o.total || 0), 0)

  const setStatus = async (id, status) => {
    setBusy(id)
    try {
      await db.updateShared('orders', id, { status })
    } catch {
      /* keep the old value on screen */
    } finally {
      setBusy('')
    }
  }

  if (loading) {
    return (
      <div className="grid place-items-center py-16 text-[#8a8a8a]">
        <Loader2 className="animate-spin" size={22} />
      </div>
    )
  }

  return (
    <div>
      <div className="mb-5 grid grid-cols-3 gap-2 md:gap-4">
        <div className="rounded-2xl border border-white/10 bg-[#0f0f11] p-3 md:p-4">
          <div className="text-[10px] font-black tracking-widest text-[#8a8a8a]">كل الطلبات</div>
          <div className="font-display mt-1 text-xl font-black md:text-2xl">{list.length}</div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-[#0f0f11] p-3 md:p-4">
          <div className="text-[10px] font-black tracking-widest text-[#8a8a8a]">محتاجة شغل</div>
          <div className="font-display mt-1 text-xl font-black text-primary md:text-2xl">{open}</div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-[#0f0f11] p-3 md:p-4">
          <div className="text-[10px] font-black tracking-widest text-[#8a8a8a]">إجمالي المبيعات</div>
          <div className="font-display mt-1 text-base font-black md:text-xl">
            {money(revenue, currency)}
          </div>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/[0.15] py-16 text-center">
          <ClipboardList size={26} className="mx-auto text-[#5c5c5c]" />
          <p className="mt-3 text-sm font-bold text-[#a8a8a8]">مفيش طلبات لسه</p>
          <p className="mt-1 text-xs text-[#6b6b6b]">أول ما حد يطلب، الطلب هيظهر هنا على طول.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((o) => {
            const st = statusOf(o.status)
            return (
              <div key={o.id} className="rounded-2xl border border-white/10 bg-[#0f0f11] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-sm font-black text-[#f2f2f2]">
                      {o.code || o.id}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-black ${st.cls}`}
                    >
                      {st.label}
                    </span>
                  </div>
                  <span className="text-[10px] text-[#6b6b6b]">{fmtDate(o.createdAt)}</span>
                </div>

                <div className="mt-3 grid gap-2 border-t border-white/10 pt-3 text-xs leading-5 text-[#a8a8a8] md:grid-cols-2">
                  <div>
                    <div className="font-bold text-[#f2f2f2]">{o.customerName}</div>
                    {o.phone && (
                      <a
                        href={`tel:${o.phone}`}
                        className="mt-0.5 inline-flex items-center gap-1 text-primary"
                      >
                        <Phone size={11} /> {o.phone}
                      </a>
                    )}
                  </div>
                  <div className="flex items-start gap-1">
                    <MapPin size={11} className="mt-1.5 shrink-0" />
                    <span>
                      {o.city} — {o.address}
                    </span>
                  </div>
                </div>

                <div className="mt-3 space-y-1 border-t border-white/10 pt-3">
                  {(o.items || []).map((i, idx) => (
                    <div key={idx} className="flex justify-between gap-2 text-[11px] text-[#a8a8a8]">
                      <span>
                        {i.name} — {i.size} / {i.color}
                      </span>
                      <span className="shrink-0 font-bold text-[#f2f2f2]">×{i.qty}</span>
                    </div>
                  ))}
                  {o.notes ? (
                    <p className="mt-2 rounded-xl bg-white/5 px-3 py-2 text-[11px] text-[#a8a8a8]">
                      ملاحظة: {o.notes}
                    </p>
                  ) : null}
                  <div className="mt-2 flex justify-between pt-1 text-sm">
                    <span className="font-bold text-[#f2f2f2]">الإجمالي</span>
                    <span className="font-display font-black text-primary">
                      {money(o.total, currency)}
                    </span>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {STATUSES.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setStatus(o.id, s.id)}
                      disabled={busy === o.id || o.status === s.id}
                      className={`rounded-full px-3 py-1.5 text-[10px] font-black transition ${
                        o.status === s.id
                          ? s.cls
                          : 'border border-white/[0.12] text-[#8a8a8a] hover:border-white/[0.35] hover:text-[#f2f2f2]'
                      }`}
                    >
                      {busy === o.id ? '…' : s.label}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ── products ───────────────────────────────────────────── */
function ProductsTab({ currency }) {
  const { data: products, loading } = useLiveShared('products', { order: '-createdAt' })
  const [draft, setDraft] = useState({})
  const [saving, setSaving] = useState('')
  const [saved, setSaved] = useState('')
  const [uploading, setUploading] = useState('')
  const [photoError, setPhotoError] = useState('')
  const [target, setTarget] = useState(null)
  const [open, setOpen] = useState('')
  const [sizeInput, setSizeInput] = useState({})
  const fileRef = useRef(null)

  const rows = products || []

  const edit = (id, patch) => setDraft((d) => ({ ...d, [id]: { ...(d[id] || {}), ...patch } }))

  const pickImage = (p) => {
    setTarget(p)
    setPhotoError('')
    if (fileRef.current) {
      fileRef.current.value = ''
      fileRef.current.click()
    }
  }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file || !target) return
    if (!file.type.startsWith('image/')) {
      setPhotoError('اختار صورة بصيغة JPG أو PNG.')
      return
    }
    setUploading(target.id)
    setPhotoError('')
    try {
      const { url } = await storage.upload(file, file.name)
      await db.updateShared('products', target.id, { image: url })
      setSaved(target.id)
      setTimeout(() => setSaved(''), 1800)
    } catch (err) {
      setPhotoError(err?.say || 'الصورة ما اتحفظتش، جرّب تاني.')
    } finally {
      setUploading('')
      setTarget(null)
    }
  }

  const save = async (p) => {
    const changes = draft[p.id] || {}
    if (!Object.keys(changes).length) return
    setSaving(p.id)
    try {
      const patch = {}
      if (changes.name !== undefined) {
        const name = String(changes.name).trim()
        if (name) patch.name = name
      }
      if (changes.price !== undefined) patch.price = Number(changes.price) || Number(p.price)
      if (changes.stock !== undefined) {
        const stock = Math.max(0, Math.round(Number(changes.stock)))
        patch.stock = Number.isFinite(stock) ? stock : Number(p.stock) || 0
      }
      if (changes.active !== undefined) patch.active = changes.active
      if (changes.colors !== undefined) {
        patch.colors = (changes.colors || [])
          .map((c) => ({ name: String(c?.name || '').trim(), hex: String(c?.hex || '').trim() }))
          .filter((c) => c.name)
      }
      if (changes.sizes !== undefined) {
        patch.sizes = (changes.sizes || []).map((s) => String(s).trim()).filter(Boolean)
      }
      await db.updateShared('products', p.id, patch)
      setDraft((d) => {
        const next = { ...d }
        delete next[p.id]
        return next
      })
      setSaved(p.id)
      setTimeout(() => setSaved(''), 1800)
    } catch {
      /* leave the draft so the owner can retry */
    } finally {
      setSaving('')
    }
  }

  if (loading) {
    return (
      <div className="grid place-items-center py-16 text-[#8a8a8a]">
        <Loader2 className="animate-spin" size={22} />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        onChange={onFile}
        className="hidden"
      />

      <p className="rounded-xl border border-white/10 bg-[#0f0f11] px-4 py-3 text-[11px] leading-5 text-[#8a8a8a]">
        من هنا بتغيّر اسم القطعة والسعر والكمية المتاحة والصورة، وتشيل/ترجّع القطعة للمتجر. دوس
        على صورة القطعة عشان تحطّ صورة جديدة من موبايلك، وبعد أي تعديل دوس علامة ✓ عشان يتحفظ.
        لو الكمية وصلت صفر، القطعة بتظهر «خلص» ومحدش يقدر يضيفها للسلة. وتحت كل قطعة زرار
        «الألوان والمقاسات» — منه تضيف وتشيل ألوان القطعة (اسم + لون) وتظبط قايمة مقاساتها
        بنفسك. الوصف بيتظبط من محادثة البناء.
      </p>

      {photoError ? (
        <p className="rounded-xl border border-white/25 bg-white/[0.07] px-4 py-2.5 text-[11px] font-bold text-[#f2f2f2]">
          {photoError}
        </p>
      ) : null}

      {rows.map((p) => {
        const d = draft[p.id] || {}
        const active = d.active !== undefined ? d.active : p.active !== false
        const colors = d.colors !== undefined ? d.colors : Array.isArray(p.colors) ? p.colors : []
        const sizes = d.sizes !== undefined ? d.sizes : sizesFor(p)
        const isOpen = open === p.id
        return (
          <div
            key={p.id}
            className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-[#0f0f11] p-3"
          >
            <button
              onClick={() => pickImage(p)}
              disabled={uploading === p.id}
              aria-label="تغيير صورة القطعة"
              className="group relative h-14 w-11 shrink-0 overflow-hidden rounded-lg bg-[#141416]"
            >
              {p.image ? (
                <img
                  src={p.image}
                  alt=""
                  onError={(e) => {
                    e.currentTarget.style.visibility = 'hidden'
                  }}
                  className="h-full w-full object-cover"
                />
              ) : null}
              <span className="absolute inset-0 grid place-items-center bg-black/50 text-primary transition md:opacity-0 md:group-hover:opacity-100">
                {uploading === p.id ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Camera size={14} />
                )}
              </span>
            </button>

            <div className="min-w-0 flex-1">
              <input
                value={d.name !== undefined ? d.name : p.name || ''}
                onChange={(e) => edit(p.id, { name: e.target.value })}
                aria-label="اسم القطعة"
                className="w-full min-w-0 rounded-lg border border-transparent bg-transparent px-1 py-1 font-display text-sm font-bold text-[#f2f2f2] outline-none transition focus:border-primary/60 focus:bg-[#141416]"
              />
              <div className="px-1 text-[10px] text-[#8a8a8a]">
                {p.sku} · {p.category}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 rounded-xl border border-white/[0.12] px-2">
                <input
                  type="number"
                  value={d.price !== undefined ? d.price : p.price}
                  onChange={(e) => edit(p.id, { price: e.target.value })}
                  className="w-16 bg-transparent py-2 text-center text-xs font-bold outline-none"
                />
                <span className="text-[10px] text-[#6b6b6b]">{currency}</span>
              </div>

              <div className="flex items-center gap-1 rounded-xl border border-white/[0.12] px-2">
                <input
                  type="number"
                  min="0"
                  value={d.stock !== undefined ? d.stock : (p.stock ?? '')}
                  onChange={(e) => edit(p.id, { stock: e.target.value })}
                  aria-label="الكمية المتاحة"
                  className="w-12 bg-transparent py-2 text-center text-xs font-bold outline-none"
                />
                <span className="text-[10px] text-[#6b6b6b]">متاح</span>
              </div>

              <button
                onClick={() => edit(p.id, { active: !active })}
                className={`rounded-full px-3 py-1.5 text-[10px] font-black transition ${
                  active ? 'bg-white text-black' : 'bg-[#3a3a3a] text-[#a8a8a8]'
                }`}
              >
                {active ? 'ظاهر' : 'مخفي'}
              </button>

              <button
                onClick={() => save(p)}
                disabled={saving === p.id || !draft[p.id]}
                className="grid h-9 w-9 place-items-center rounded-full bg-primary text-black transition disabled:opacity-30"
                aria-label="حفظ"
              >
                {saving === p.id ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : saved === p.id ? (
                  <Check size={14} />
                ) : (
                  <Check size={14} />
                )}
              </button>
            </div>

            <button
              onClick={() => setOpen(isOpen ? '' : p.id)}
              className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-[11px] font-black transition ${
                isOpen
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-white/[0.12] text-[#a8a8a8] hover:border-white/30 hover:text-[#f2f2f2]'
              }`}
            >
              <span className="inline-flex items-center gap-1.5">
                <Palette size={12} /> الألوان والمقاسات
              </span>
              <ChevronDown
                size={13}
                className={`transition ${isOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {isOpen && (
              <div className="w-full space-y-5 rounded-xl border border-white/10 bg-[#111113] p-3">
                {/* colours */}
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] font-black tracking-widest text-[#8a8a8a]">
                      الألوان ({colors.length})
                    </span>
                    <button
                      onClick={() =>
                        edit(p.id, {
                          colors: [...colors, { name: '', hex: '#111111' }],
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-full border border-white/20 px-3 py-1.5 text-[10px] font-black text-[#f2f2f2] transition hover:border-primary hover:text-primary"
                    >
                      <Plus size={10} /> ضيف لون
                    </button>
                  </div>

                  {colors.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-white/[0.15] px-3 py-3 text-center text-[10px] text-[#6b6b6b]">
                      مفيش ألوان للقطعة دي — دوس «ضيف لون».
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {colors.map((c, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <input
                            type="color"
                            value={/^#[0-9a-fA-F]{6}$/.test(c.hex || '') ? c.hex : '#111111'}
                            onChange={(e) => {
                              const next = colors.map((x, idx) =>
                                idx === i ? { ...x, hex: e.target.value } : x,
                              )
                              edit(p.id, { colors: next })
                            }}
                            aria-label="لون القطعة"
                            className="h-9 w-9 shrink-0 cursor-pointer rounded-full border border-white/20 bg-transparent p-0.5"
                          />
                          <input
                            value={c.name || ''}
                            onChange={(e) => {
                              const next = colors.map((x, idx) =>
                                idx === i ? { ...x, name: e.target.value } : x,
                              )
                              edit(p.id, { colors: next })
                            }}
                            placeholder="اسم اللون (أسود، كحلي…)"
                            className="min-w-0 flex-1 rounded-lg border border-white/[0.12] bg-[#0f0f11] px-3 py-2 text-xs text-[#f2f2f2] outline-none transition focus:border-primary/70"
                          />
                          <button
                            onClick={() =>
                              edit(p.id, { colors: colors.filter((_, idx) => idx !== i) })
                            }
                            aria-label="شيل اللون"
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/[0.12] text-[#8a8a8a] transition hover:border-[#a8a8a8] hover:text-[#f2f2f2]"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* sizes */}
                <div>
                  <span className="mb-2 block text-[11px] font-black tracking-widest text-[#8a8a8a]">
                    المقاسات ({sizes.length})
                  </span>

                  {sizes.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-white/[0.15] px-3 py-3 text-center text-[10px] text-[#6b6b6b]">
                      مفيش مقاسات — القطعة هتظهر من غير اختيار مقاس.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {sizes.map((s, i) => (
                        <span
                          key={`${s}-${i}`}
                          className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] py-1 pl-2.5 pr-1.5 text-[11px] font-black text-[#f2f2f2]"
                        >
                          {s}
                          <button
                            onClick={() =>
                              edit(p.id, { sizes: sizes.filter((_, idx) => idx !== i) })
                            }
                            aria-label={`شيل مقاس ${s}`}
                            className="grid h-5 w-5 place-items-center rounded-full bg-black/40 text-[#a8a8a8] transition hover:text-[#f2f2f2]"
                          >
                            <X size={10} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-2 flex gap-2">
                    <input
                      value={sizeInput[p.id] || ''}
                      onChange={(e) =>
                        setSizeInput((v) => ({ ...v, [p.id]: e.target.value }))
                      }
                      placeholder="مقاس جديد: L أو XL أو 3XL"
                      className="min-w-0 flex-1 rounded-lg border border-white/[0.12] bg-[#0f0f11] px-3 py-2 text-xs text-[#f2f2f2] outline-none transition focus:border-primary/70"
                    />
                    <button
                      onClick={() => {
                        const raw = String(sizeInput[p.id] || '').trim()
                        if (!raw) return
                        const next = sizes.includes(raw) ? sizes : [...sizes, raw]
                        edit(p.id, { sizes: next })
                        setSizeInput((v) => ({ ...v, [p.id]: '' }))
                      }}
                      disabled={!String(sizeInput[p.id] || '').trim()}
                      className="shrink-0 rounded-lg bg-white px-4 text-[11px] font-black text-black transition disabled:opacity-30"
                    >
                      ضيف
                    </button>
                  </div>
                </div>

                <p className="text-[10px] leading-4 text-[#6b6b6b]">
                  بعد أي تعديل دوس علامة ✓ فوق عشان يتحفظ. المقاسات والألوان دي اللي بيشوفها
                  العميل في صفحة القطعة.
                </p>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ── settings ───────────────────────────────────────────── */
function SettingsTab() {
  const { data: rows } = useLiveShared('settings', { limit: 1 })
  const current = rows?.[0]

  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!current || form) return
    setForm({
      whatsapp: current.whatsapp || '',
      instagram: current.instagram || '',
      currency: current.currency || DEFAULT_SETTINGS.currency,
      shipping: current.shipping ?? DEFAULT_SETTINGS.shipping,
      freeShippingOver: current.freeShippingOver ?? DEFAULT_SETTINGS.freeShippingOver,
      note: current.note || DEFAULT_SETTINGS.note,
    })
  }, [current, form])

  if (!form) {
    return (
      <div className="grid place-items-center py-16 text-[#8a8a8a]">
        <Loader2 className="animate-spin" size={22} />
      </div>
    )
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const save = async () => {
    setSaving(true)
    setSaved(false)
    try {
      await db.upsertShared(
        'settings',
        settingsPayload(current, {
          whatsapp: form.whatsapp.replace(/[^\d]/g, ''),
          instagram: form.instagram,
          currency: form.currency || DEFAULT_SETTINGS.currency,
          shipping: Number(form.shipping) || 0,
          freeShippingOver: Number(form.freeShippingOver) || 0,
          note: form.note,
        }),
        'shop',
        { visibleTo: 'public' },
      )
      setSaved(true)
      setTimeout(() => setSaved(false), 2200)
    } catch {
      /* stays on screen */
    } finally {
      setSaving(false)
    }
  }

  const FIELD =
    'w-full rounded-xl border border-white/[0.12] bg-[#111113] px-4 py-3 text-sm text-[#f2f2f2] outline-none transition focus:border-primary/70'

  return (
    <div className="max-w-lg space-y-4">
      <div>
        <label className="mb-1.5 block text-[11px] font-black tracking-widest text-[#8a8a8a]">
          رقم واتساب المتجر (بالكود الدولي، مثال 201012345678)
        </label>
        <input className={FIELD} value={form.whatsapp} onChange={set('whatsapp')} placeholder="201012345678" inputMode="tel" />
        <p className="mt-1 text-[10px] text-[#6b6b6b]">
          لما تحطه، هايظهر زرار "ابعتهولنا على واتساب" بعد كل طلب.
        </p>
      </div>

      <div>
        <label className="mb-1.5 block text-[11px] font-black tracking-widest text-[#8a8a8a]">
          حساب انستجرام (اختياري)
        </label>
        <input className={FIELD} value={form.instagram} onChange={set('instagram')} placeholder="layl.street" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1.5 block text-[11px] font-black tracking-widest text-[#8a8a8a]">
            سعر الشحن
          </label>
          <input className={FIELD} type="number" value={form.shipping} onChange={set('shipping')} />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] font-black tracking-widest text-[#8a8a8a]">
            شحن مجاني فوق
          </label>
          <input
            className={FIELD}
            type="number"
            value={form.freeShippingOver}
            onChange={set('freeShippingOver')}
          />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-[11px] font-black tracking-widest text-[#8a8a8a]">
          عملة الأسعار
        </label>
        <input className={FIELD} value={form.currency} onChange={set('currency')} />
      </div>

      <div>
        <label className="mb-1.5 block text-[11px] font-black tracking-widest text-[#8a8a8a]">
          ملاحظة تظهر في الفوتر
        </label>
        <textarea className={`${FIELD} min-h-[70px]`} value={form.note} onChange={set('note')} />
      </div>

      <button
        onClick={save}
        disabled={saving}
        className="flex items-center gap-2 rounded-full bg-primary px-6 py-3.5 text-sm font-black text-black transition hover:bg-[#d8d8d8] disabled:opacity-60"
      >
        {saving ? <Loader2 size={15} className="animate-spin" /> : saved ? <Check size={15} /> : null}
        {saving ? 'بيتحفظ…' : saved ? 'اتحفظ' : 'احفظ الإعدادات'}
      </button>
    </div>
  )
}

/* ── brand identity ─────────────────────────────────────── */
const IMAGE_FIELDS = [
  { key: 'logo', label: 'اللوجو (مربع صغير)', hint: 'بيظهر جنب اسم البراند فوق في الهيدر.' },
  { key: 'heroImage', label: 'صورة الصفحة الرئيسية', hint: 'الصورة الكبيرة اللي في أول الموقع.' },
  {
    key: 'sizeGuide',
    label: 'صورة «اعرف مقاسك»',
    hint: 'جدول المقاسات بتاعك — بيظهر تحت كل قطعة في صفحة القطعة. غيّرها وقت ما تحب.',
  },
]

function IdentityTab() {
  const { data: rows, loading } = useLiveShared('settings', { limit: 1 })
  const current = rows?.[0]

  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [uploading, setUploading] = useState('')
  const [error, setError] = useState('')
  const fileRef = useRef(null)
  const targetRef = useRef('')

  useEffect(() => {
    if (!current || form) return
    const c = { ...DEFAULT_SETTINGS, ...current }
    setForm({
      brandName: c.brandName || DEFAULT_SETTINGS.brandName,
      logo: c.logo || '',
      heroImage: c.heroImage || DEFAULT_SETTINGS.heroImage,
      sizeGuide: c.sizeGuide || '',
    })
  }, [current, form])

  if (loading || !form) {
    return (
      <div className="grid place-items-center py-16 text-[#8a8a8a]">
        <Loader2 className="animate-spin" size={22} />
      </div>
    )
  }

  const pick = (field) => {
    targetRef.current = field
    setError('')
    if (fileRef.current) {
      fileRef.current.value = ''
      fileRef.current.click()
    }
  }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    const field = targetRef.current
    if (!file || !field) return
    if (!file.type.startsWith('image/')) {
      setError('اختار صورة بصيغة JPG أو PNG.')
      return
    }
    const next = { ...form, [field]: '' }
    setUploading(field)
    setError('')
    try {
      const { url } = await storage.upload(file, file.name)
      next[field] = url
      setForm(next)
      await db.upsertShared('settings', settingsPayload({ ...current, ...next }), 'shop', {
        visibleTo: 'public',
      })
    } catch (err) {
      setError(err?.say || 'الصورة ما اتحفظتش، جرّب تاني.')
    } finally {
      setUploading('')
      targetRef.current = ''
    }
  }

  const saveName = async () => {
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      await db.upsertShared(
        'settings',
        settingsPayload({ ...current, ...form }, { brandName: form.brandName.trim() }),
        'shop',
        { visibleTo: 'public' },
      )
      setForm((f) => ({ ...f, brandName: f.brandName.trim() }))
      setSaved(true)
      setTimeout(() => setSaved(false), 2200)
    } catch {
      setError('الاسم ما اتحفظش، جرّب تاني.')
    } finally {
      setSaving(false)
    }
  }

  const FIELD =
    'w-full rounded-xl border border-white/[0.12] bg-[#111113] px-4 py-3 text-sm text-[#f2f2f2] outline-none transition focus:border-primary/70'

  return (
    <div className="max-w-lg space-y-6">
      <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="hidden" />

      <p className="rounded-xl border border-white/10 bg-[#0f0f11] px-4 py-3 text-[11px] leading-5 text-[#8a8a8a]">
        من هنا بتغيّر اسم البراند وصوره بنفسك. الصور بتترفع من موبايلك وبتتحفظ على طول.
        صورة «اعرف مقاسك» هي جدول المقاسات اللي بيظهر تحت كل قطعة، وبتغيّرها في أي وقت.
      </p>

      {error ? (
        <p className="rounded-xl border border-white/25 bg-white/[0.07] px-4 py-2.5 text-[11px] font-bold text-[#f2f2f2]">
          {error}
        </p>
      ) : null}

      <div>
        <label className="mb-1.5 block text-[11px] font-black tracking-widest text-[#8a8a8a]">
          اسم البراند
        </label>
        <div className="flex gap-2">
          <input
            className={FIELD}
            value={form.brandName}
            onChange={(e) => setForm((f) => ({ ...f, brandName: e.target.value }))}
            placeholder="ليل ستريت"
          />
          <button
            onClick={saveName}
            disabled={saving || !form.brandName.trim()}
            className="shrink-0 rounded-xl bg-primary px-5 text-sm font-black text-black transition hover:bg-[#d8d8d8] disabled:opacity-40"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : saved ? <Check size={15} /> : 'احفظ'}
          </button>
        </div>
        <p className="mt-1 text-[10px] text-[#6b6b6b]">
          الاسم بيظهر في الهيدر والفوتر وعنوان الصفحة الرئيسية.
        </p>
      </div>

      <div className="space-y-3">
        {IMAGE_FIELDS.map((f) => (
          <div
            key={f.key}
            className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[#0f0f11] p-3"
          >
            <button
              onClick={() => pick(f.key)}
              disabled={uploading === f.key}
              className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-[#141416]"
              aria-label={`تغيير ${f.label}`}
            >
              {form[f.key] ? (
                <img
                  src={form[f.key]}
                  alt=""
                  onError={(e) => {
                    e.currentTarget.style.visibility = 'hidden'
                  }}
                  className="h-full w-full object-cover"
                />
              ) : null}
              <span className="absolute inset-0 grid place-items-center bg-black/50 text-primary transition md:opacity-0 md:group-hover:opacity-100">
                {uploading === f.key ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Camera size={15} />
                )}
              </span>
            </button>

            <div className="min-w-0 flex-1">
              <div className="font-display text-sm font-bold text-[#f2f2f2]">{f.label}</div>
              <p className="mt-0.5 text-[10px] leading-4 text-[#8a8a8a]">{f.hint}</p>
              <button
                onClick={() => pick(f.key)}
                disabled={uploading === f.key}
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-white/[0.15] px-3 py-1.5 text-[10px] font-black text-[#cfcfcf] transition hover:border-primary/60 hover:text-primary"
              >
                {uploading === f.key ? (
                  <>
                    <Loader2 size={11} className="animate-spin" /> بيرفع…
                  </>
                ) : (
                  <>
                    <Camera size={11} /> غيّر الصورة
                  </>
                )}
              </button>
            </div>
          </div>
        ))}
      </div>

      <p className="text-[10px] leading-5 text-[#6b6b6b]">
        نصايح للصور: صورة الصفحة الرئيسية أحسن حاجة تكون طولية أو مربعة وواضحة، واللوجو يبقى مربع.
      </p>

    </div>
  )
}

/* ── gate ───────────────────────────────────────────────── */
export default function Owner() {
  const [user, setUser] = useState(() => auth.getCurrentUser())
  const [tab, setTab] = useState('orders')

  useEffect(() => auth.onAuthChange(setUser), [])

  const isOwner = auth.isAppOwner()

  const { data: settingsRows } = useLiveShared('settings', { limit: 1 })
  const currency = useMemo(
    () => settingsRows?.[0]?.currency || DEFAULT_SETTINGS.currency,
    [settingsRows],
  )

  const TABS = [
    { id: 'orders', label: 'الطلبات', Icon: ClipboardList },
    { id: 'products', label: 'المنتجات', Icon: Package },
    { id: 'identity', label: 'الهوية', Icon: Palette },
    { id: 'settings', label: 'الإعدادات', Icon: Settings2 },
  ]

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 pt-8 md:px-8 md:pt-12">
        <span className="text-[11px] font-black uppercase tracking-[0.25em] text-primary">
          لوحة المتجر
        </span>
        <h1 className="font-display mt-2 text-3xl font-black md:text-4xl">
          إدارة {settingsRows?.[0]?.brandName || DEFAULT_SETTINGS.brandName}
        </h1>

        {!user ? (
          <div className="mt-8 max-w-md rounded-3xl border border-white/10 bg-[#0f0f11] p-6">
            <h2 className="font-display text-lg font-black">دخول صاحب المتجر</h2>
            <p className="mt-2 text-sm leading-6 text-[#a8a8a8]">
              سجّل دخول بنفس الحساب اللي عملت بيه المتجر عشان تشوف الطلبات وتعدّل المنتجات.
            </p>
            <button
              onClick={() => auth.signIn()}
              className="mt-5 w-full rounded-full bg-primary px-6 py-3.5 text-sm font-black text-black transition hover:bg-[#d8d8d8]"
            >
              تسجيل الدخول
            </button>
          </div>
        ) : !isOwner ? (
          <div className="mt-8 max-w-md rounded-3xl border border-white/10 bg-[#0f0f11] p-6">
            <h2 className="font-display text-lg font-black">الحساب ده مش صاحب المتجر</h2>
            <p className="mt-2 text-sm leading-6 text-[#a8a8a8]">
              صفحة الإدارة متاحة لصاحب البراند بس. لو إنت صاحب المتجر، سجّل دخول بالحساب اللي
              عملت بيه التطبيق.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                onClick={() => auth.signIn()}
                className="rounded-full bg-primary px-5 py-3 text-xs font-black text-black"
              >
                تبديل الحساب
              </button>
              <button
                onClick={() => auth.signOut()}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.15] px-5 py-3 text-xs font-bold text-[#cfcfcf]"
              >
                <LogOut size={13} /> خروج
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-5 flex items-center justify-between gap-3">
              <p className="text-xs text-[#8a8a8a]">{user.email}</p>
              <button
                onClick={() => auth.signOut()}
                className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[#6b6b6b] transition hover:text-[#f2f2f2]"
              >
                <LogOut size={12} /> خروج
              </button>
            </div>

            <div className="mt-5 flex gap-1.5 border-b border-white/10 pb-3">
              {TABS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-black transition ${
                    tab === id
                      ? 'bg-primary text-black'
                      : 'text-[#8a8a8a] hover:bg-white/5 hover:text-[#f2f2f2]'
                  }`}
                >
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>

            <div className="mt-5">
              {tab === 'orders' && <OrdersTab currency={currency} />}
              {tab === 'products' && <ProductsTab currency={currency} />}
              {tab === 'identity' && <IdentityTab />}
              {tab === 'settings' && <SettingsTab />}
            </div>

            <Link
              to="/shop"
              className="mt-8 inline-block text-xs font-bold text-[#6b6b6b] transition hover:text-primary"
            >
              شوف المتجر زي ما العملاء بيشوفوه ←
            </Link>
          </>
        )}
      </div>

      <div className="h-24 md:h-10" />
    </div>
  )
}
