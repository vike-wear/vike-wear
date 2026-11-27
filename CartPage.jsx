import { Link } from 'react-router-dom'
import { Minus, Plus, Trash2, ShoppingBag, ArrowLeft } from 'lucide-react'
import { useLiveShared } from '../lib/useLive'
import { useCart } from '../components/CartProvider'
import ProductImage from '../components/ProductImage'
import { cartTotal, DEFAULT_SETTINGS, money } from '../shop'

export default function CartPage() {
  const { items, setQty, remove, subtotal, count } = useCart()
  const { data: settingsRows } = useLiveShared('settings', { limit: 1 })
  const settings = { ...DEFAULT_SETTINGS, ...(settingsRows?.[0] || {}) }
  const totals = cartTotal(subtotal, settings)

  if (items.length === 0) {
    return (
      <div className="grid h-full place-items-center px-6 pb-24 md:pb-0">
        <div className="max-w-sm text-center">
          <div className="mx-auto grid h-20 w-20 place-items-center rounded-full border border-white/10 bg-[#111113]">
            <ShoppingBag size={28} strokeWidth={1.4} className="text-[#6b6b6b]" />
          </div>
          <h1 className="font-display mt-6 text-2xl font-black">سلتك لسه فاضية</h1>
          <p className="mt-2 text-sm leading-6 text-[#8a8a8a]">
            الدروب محدود والقطع بتخلص بسرعة. اختار قطعتك قبل ما تروح.
          </p>
          <Link
            to="/shop"
            className="mt-7 inline-flex items-center gap-2 rounded-full bg-primary px-7 py-3.5 text-sm font-black text-black transition hover:bg-[#d8d8d8]"
          >
            اتفرج على المتجر
            <ArrowLeft size={16} />
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 pt-8 md:px-8 md:pt-12">
        <span className="text-[11px] font-black uppercase tracking-[0.25em] text-primary">
          {count} قطعة
        </span>
        <h1 className="font-display mt-2 text-3xl font-black md:text-4xl">سلتك</h1>

        <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_320px]">
          {/* lines */}
          <div className="divide-y divide-white/10 border-y border-white/10">
            {items.map((item) => (
              <div key={item.key} className="flex gap-3 py-4 md:gap-4">
                <Link to={`/product/${item.id}`} className="shrink-0">
                  <ProductImage
                    src={item.image}
                    alt={item.name}
                    className="h-[104px] w-[80px] rounded-xl md:h-[128px] md:w-[100px]"
                  />
                </Link>

                <div className="flex min-w-0 flex-1 flex-col justify-between">
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        to={`/product/${item.id}`}
                        className="font-display truncate text-sm font-bold text-[#f2f2f2] hover:text-primary md:text-base"
                      >
                        {item.name}
                      </Link>
                      <button
                        onClick={() => remove(item.key)}
                        aria-label="احذف"
                        className="shrink-0 p-1.5 text-[#6b6b6b] transition hover:text-[#f2f2f2]"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] text-[#8a8a8a]">
                      {item.size && item.size !== 'مقاس واحد' ? `${item.size} · ` : ''}
                      {item.color}
                    </p>
                  </div>

                  <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="flex items-center rounded-full border border-white/[0.15]">
                      <button
                        onClick={() => setQty(item.key, item.qty - 1)}
                        className="grid h-9 w-9 place-items-center text-[#cfcfcf] transition hover:text-primary"
                        aria-label="أقل"
                      >
                        <Minus size={13} />
                      </button>
                      <span className="w-7 text-center text-xs font-black">{item.qty}</span>
                      <button
                        onClick={() => setQty(item.key, item.qty + 1)}
                        className="grid h-9 w-9 place-items-center text-[#cfcfcf] transition hover:text-primary"
                        aria-label="أكتر"
                      >
                        <Plus size={13} />
                      </button>
                    </div>
                    <span className="text-sm font-black text-primary">
                      {money(item.price * item.qty, settings.currency)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* summary */}
          <div className="lg:sticky lg:top-6 lg:self-start">
            <div className="rounded-3xl border border-white/10 bg-[#0f0f11] p-5">
              <h2 className="font-display text-base font-bold">ملخّص الطلب</h2>
              <div className="mt-4 space-y-3 text-sm">
                <div className="flex justify-between text-[#a8a8a8]">
                  <span>المجموع الفرعي</span>
                  <span className="font-bold text-[#f2f2f2]">
                    {money(subtotal, settings.currency)}
                  </span>
                </div>
                <div className="flex justify-between text-[#a8a8a8]">
                  <span>الشحن</span>
                  <span className="font-bold text-[#f2f2f2]">
                    {totals.free ? 'مجاني' : money(totals.shipping, settings.currency)}
                  </span>
                </div>
                {!totals.free && totals.freeOver > 0 && (
                  <p className="rounded-xl bg-primary/10 px-3 py-2 text-[11px] leading-5 text-primary">
                    ضيف {money(totals.freeOver - subtotal, settings.currency)} كمان والشحن يبقى مجاني.
                  </p>
                )}
                <div className="flex justify-between border-t border-white/10 pt-3 text-base">
                  <span className="font-display font-bold">الإجمالي</span>
                  <span className="font-display font-black text-primary">
                    {money(totals.total, settings.currency)}
                  </span>
                </div>
              </div>

              <Link
                to="/checkout"
                className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-primary px-6 py-4 text-sm font-black text-black transition hover:bg-[#d8d8d8] active:scale-[0.99]"
              >
                إتمام الطلب
                <ArrowLeft size={16} />
              </Link>

              <Link
                to="/shop"
                className="mt-3 block text-center text-xs font-bold text-[#8a8a8a] transition hover:text-[#f2f2f2]"
              >
                كمّل تسوّق
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="h-24 md:h-10" />
    </div>
  )
}
