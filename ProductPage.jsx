import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { ArrowRight, Minus, Plus, Check, ChevronDown, ShoppingBag, Ruler, X, Maximize2 } from 'lucide-react'
import { useLiveShared } from '../lib/useLive'
import { useCart } from '../components/CartProvider'
import ProductImage from '../components/ProductImage'
import { DEFAULT_SETTINGS, money, sizesFor, colorsFor } from '../shop'

function Accordion({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-white/10">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between py-4 text-right"
      >
        <span className="font-display text-sm font-bold text-[#f2f2f2]">{title}</span>
        <ChevronDown
          size={16}
          className={`text-[#8a8a8a] transition ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && <div className="pb-5 text-sm leading-7 text-[#a8a8a8]">{children}</div>}
    </div>
  )
}

/* «اعرف مقاسك» — جدول المقاسات اللي صاحب المتجر بيرفعه من لوحة الإدارة */
function SizeGuide({ src }) {
  const [zoom, setZoom] = useState(false)
  const [failed, setFailed] = useState(false)

  const host =
    (typeof document !== 'undefined' && document.getElementById('app-shell')) ||
    (typeof document !== 'undefined' ? document.body : null)

  if (!src || failed || !host) return null

  return (
    <div className="mt-10 border-t border-white/10 pt-7">
      <div className="mb-3 flex items-center gap-2">
        <Ruler size={15} className="text-primary" />
        <h2 className="font-display text-lg font-black">اعرف مقاسك</h2>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-[#8a8a8a]">
        بص على جدول المقاسات قبل ما تختار — دوس على الصورة عشان تكبّرها.
      </p>

      <button
        onClick={() => setZoom(true)}
        className="group relative block w-full overflow-hidden rounded-3xl border border-white/10 bg-[#0f0f11] transition hover:border-white/25"
        aria-label="تكبير جدول المقاسات"
      >
        <img
          src={src}
          alt="جدول المقاسات"
          loading="lazy"
          onError={() => setFailed(true)}
          className="max-h-[520px] w-full object-contain transition duration-500 group-hover:scale-[1.01]"
        />
        <span className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-[10px] font-black text-[#f2f2f2] backdrop-blur">
          <Maximize2 size={11} /> كبّر
        </span>
      </button>

      {zoom &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex flex-col bg-black/95"
            onClick={() => setZoom(false)}
          >
            <div className="flex items-center justify-between px-4 py-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]">
              <span className="font-display text-sm font-black text-[#f2f2f2]">جدول المقاسات</span>
              <button
                onClick={() => setZoom(false)}
                aria-label="إغلاق"
                className="grid h-10 w-10 place-items-center rounded-full border border-white/20 text-[#f2f2f2]"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-auto px-3 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]">
              <img
                src={src}
                alt="جدول المقاسات"
                onClick={(e) => e.stopPropagation()}
                className="mx-auto w-full max-w-3xl rounded-2xl bg-[#0f0f11] object-contain"
              />
            </div>
          </div>,
          host,
        )}
    </div>
  )
}

export default function ProductPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const cart = useCart()
  const { data: products, loading } = useLiveShared('products')
  const { data: settingsRows } = useLiveShared('settings', { limit: 1 })
  const settings = { ...DEFAULT_SETTINGS, ...(settingsRows?.[0] || {}) }

  const product = (products || []).find((p) => p.id === id)

  const availableSizes = sizesFor(product)
  const [color, setColor] = useState(null)
  const [size, setSize] = useState(null)
  const [qty, setQty] = useState(1)
  const [added, setAdded] = useState(false)

  useEffect(() => {
    if (!product) return
    const list = sizesFor(product)
    setColor(colorsFor(product)[0]?.name || null)
    setSize(list[0] || null)
    setQty(1)
    setAdded(false)
  }, [product?.id])

  useEffect(() => {
    if (!added) return
    const t = setTimeout(() => setAdded(false), 2600)
    return () => clearTimeout(t)
  }, [added])

  if (loading && !product) {
    return (
      <div className="h-full overflow-y-auto px-4 pt-10">
        <div className="mx-auto grid w-full max-w-6xl gap-8 md:grid-cols-2">
          <div className="aspect-[3/4] animate-pulse rounded-3xl bg-[#141416]" />
          <div className="space-y-4">
            <div className="h-8 w-2/3 animate-pulse rounded bg-[#141416]" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-[#141416]" />
            <div className="h-24 animate-pulse rounded bg-[#141416]" />
          </div>
        </div>
      </div>
    )
  }

  if (!product) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div>
          <div className="font-display text-xl font-black">القطعة دي مش موجودة</div>
          <p className="mt-2 text-sm text-[#8a8a8a]">يمكن اتشالت من الدروب.</p>
          <Link
            to="/shop"
            className="mt-6 inline-block rounded-full bg-primary px-6 py-3 text-sm font-black text-black"
          >
            رجّعني للمتجر
          </Link>
        </div>
      </div>
    )
  }

  const soldOut = Number(product.stock ?? 1) <= 0
  const colors = colorsFor(product)

  const handleAdd = () => {
    if (soldOut) return
    cart.add({
      sku: product.sku,
      id: product.id,
      name: product.name,
      price: Number(product.price),
      image: product.image,
      size: size || 'مقاس واحد',
      color: color || 'افتراضي',
      qty,
    })
    setAdded(true)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 pt-4 md:px-8 md:pt-8">
        <button
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/shop'))}
          className="mb-4 inline-flex items-center gap-1.5 text-xs font-bold text-[#8a8a8a] transition hover:text-primary"
        >
          <ArrowRight size={14} />
          رجوع
        </button>

        <div className="grid gap-7 md:grid-cols-2 md:gap-12">
          {/* image */}
          <div>
            <div className="relative overflow-hidden rounded-3xl border border-white/10">
              <ProductImage src={product.image} alt={product.name} className="aspect-[3/4]" />
              {product.badge && !soldOut && (
                <span className="absolute right-4 top-4 rounded-full bg-primary px-3 py-1.5 text-[11px] font-black text-black">
                  {product.badge}
                </span>
              )}
            </div>
            <p className="mt-2 text-[10px] text-[#5c5c5c]">تصوير: {product.credit || 'Pixabay'}</p>
          </div>

          {/* info */}
          <div className="md:pt-4">
            <span className="text-[11px] font-black uppercase tracking-[0.25em] text-primary">
              {product.category}
            </span>
            <h1 className="font-display mt-2 text-3xl font-black leading-tight md:text-4xl">
              {product.name}
            </h1>

            <div className="mt-3 flex items-baseline gap-3">
              <span className="text-xl font-black text-primary">
                {money(product.price, settings.currency)}
              </span>
              {product.oldPrice ? (
                <span className="text-sm text-[#6b6b6b] line-through">
                  {money(product.oldPrice, settings.currency)}
                </span>
              ) : null}
            </div>

            <p className="mt-5 text-sm leading-7 text-[#a8a8a8]">{product.desc}</p>

            {/* colors */}
            {colors.length > 0 && (
              <div className="mt-7">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[11px] font-black tracking-widest text-[#8a8a8a]">
                    اللون
                  </span>
                  <span className="text-[11px] text-[#f2f2f2]">{color}</span>
                </div>
                <div className="flex flex-wrap gap-2.5">
                  {colors.map((c) => (
                    <button
                      key={c.name}
                      onClick={() => setColor(c.name)}
                      aria-label={c.name}
                      className={`h-9 w-9 rounded-full border-2 transition ${
                        color === c.name
                          ? 'border-primary ring-2 ring-primary/25 ring-offset-2 ring-offset-[#0a0a0b]'
                          : 'border-white/20 hover:border-white/50'
                      }`}
                      style={{ backgroundColor: c.hex }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* sizes */}
            {availableSizes.length > 0 && (
              <div className="mt-6">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[11px] font-black tracking-widest text-[#8a8a8a]">
                    المقاس
                  </span>
                  <span className="text-[11px] text-[#f2f2f2]">{size}</span>
                </div>
                <div className="flex flex-wrap gap-2.5">
                  {availableSizes.map((s) => {
                    const on = size === s
                    return (
                      <button
                        key={s}
                        onClick={() => setSize(s)}
                        className={`min-w-[64px] rounded-full border px-5 py-2.5 text-sm font-black transition ${
                          on
                            ? 'border-primary bg-primary text-black'
                            : 'border-white/20 text-[#cfcfcf] hover:border-white/50'
                        }`}
                      >
                        {s}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* qty */}
            <div className="mt-6 flex items-center gap-4">
              <span className="text-[11px] font-black tracking-widest text-[#8a8a8a]">الكمية</span>
              <div className="flex items-center rounded-full border border-white/[0.15]">
                <button
                  onClick={() => setQty((q) => Math.max(1, q - 1))}
                  className="grid h-10 w-10 place-items-center text-[#cfcfcf] transition hover:text-primary"
                  aria-label="أقل"
                >
                  <Minus size={15} />
                </button>
                <span className="w-8 text-center text-sm font-black">{qty}</span>
                <button
                  onClick={() => setQty((q) => Math.min(20, q + 1))}
                  className="grid h-10 w-10 place-items-center text-[#cfcfcf] transition hover:text-primary"
                  aria-label="أكتر"
                >
                  <Plus size={15} />
                </button>
              </div>
            </div>

            {/* add */}
            <div className="mt-7 flex flex-col gap-3">
              <button
                onClick={handleAdd}
                disabled={soldOut}
                className={`flex w-full items-center justify-center gap-2 rounded-full px-6 py-4 text-sm font-black transition ${
                  soldOut
                    ? 'cursor-not-allowed bg-white/5 text-[#6b6b6b]'
                    : added
                      ? 'bg-white/20 text-[#f2f2f2]'
                      : 'bg-primary text-black hover:bg-[#d8d8d8] active:scale-[0.99]'
                }`}
              >
                {soldOut ? (
                  'خلص من الدروب'
                ) : added ? (
                  <>
                    <Check size={16} /> اتضافت للسلة
                  </>
                ) : (
                  <>
                    <ShoppingBag size={16} /> ضيف للسلة — {money(product.price * qty, settings.currency)}
                  </>
                )}
              </button>

              {added && (
                <Link
                  to="/cart"
                  className="text-center text-xs font-black text-primary underline-offset-4 hover:underline"
                >
                  روح للسلة وكمّل الطلب ←
                </Link>
              )}
            </div>

            {/* accordions */}
            <div className="mt-8 border-t border-white/10">
              <Accordion title="الشحن والاستبدال">
                التوصيل من ٢ لـ ٥ أيام عمل لكل المحافظات، والشحن{' '}
                {money(settings.shipping, settings.currency)}
                {Number(settings.freeShippingOver) > 0
                  ? ` — ومجاني على الطلبات فوق ${money(settings.freeShippingOver, settings.currency)}`
                  : ''}
                . الاستبدال متاح خلال ١٤ يوم بشرط إن التاج ما يكونش اتشال.
              </Accordion>
            </div>

            <SizeGuide src={settings.sizeGuide} />

            {Number(product.stock) > 0 && Number(product.stock) <= 10 && (
              <p className="mt-5 rounded-2xl border border-[#e0a03c]/30 bg-[#e0a03c]/10 px-4 py-3 text-[11px] font-bold text-[#e0a03c]">
                فاضل {product.stock} قطع بس في الدروب ده
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="h-24 md:h-10" />
    </div>
  )
}
