import { useMemo, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { useLiveShared } from '../lib/useLive'
import ProductCard from '../components/ProductCard'
import Footer from '../components/Footer'
import { CATEGORIES, DEFAULT_SETTINGS, SORTS } from '../shop'

export default function Shop() {
  const { data: products, loading } = useLiveShared('products', { order: '-createdAt' })
  const { data: settingsRows } = useLiveShared('settings', { limit: 1 })
  const settings = { ...DEFAULT_SETTINGS, ...(settingsRows?.[0] || {}) }

  const [category, setCategory] = useState('الكل')
  const [sort, setSort] = useState('new')

  const list = useMemo(() => {
    let rows = (products || []).filter((p) => p.active !== false)
    if (category !== 'الكل') rows = rows.filter((p) => p.category === category)
    if (sort === 'low') rows = [...rows].sort((a, b) => Number(a.price) - Number(b.price))
    if (sort === 'high') rows = [...rows].sort((a, b) => Number(b.price) - Number(a.price))
    return rows
  }, [products, category, sort])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 md:px-8 md:pt-12">
        <div className="flex items-end justify-between gap-4">
          <div>
            <span className="text-[11px] font-black uppercase tracking-[0.25em] text-primary">
              دروب ٠١
            </span>
            <h1 className="font-display mt-2 text-3xl font-black md:text-5xl">المتجر</h1>
          </div>
          <span className="shrink-0 pb-1 text-xs text-[#8a8a8a]">
            {loading ? 'بيحمّل…' : `${list.length} قطعة`}
          </span>
        </div>

        {/* filters */}
        <div className="mt-6 flex flex-col gap-3 border-b border-white/10 pb-4 md:flex-row md:items-center md:justify-between">
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`shrink-0 rounded-full px-4 py-2 text-xs font-bold transition ${
                  category === c
                    ? 'bg-primary text-black'
                    : 'border border-white/[0.12] text-[#a8a8a8] hover:border-white/30 hover:text-[#f2f2f2]'
                }`}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <SlidersHorizontal size={14} className="shrink-0 text-[#6b6b6b]" />
            {SORTS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSort(s.id)}
                className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition ${
                  sort === s.id ? 'bg-white/10 text-[#f2f2f2]' : 'text-[#8a8a8a] hover:text-[#f2f2f2]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* grid */}
        {loading ? (
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-6 lg:grid-cols-4">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="animate-pulse">
                <div className="aspect-[3/4] rounded-2xl bg-[#141416]" />
                <div className="mt-3 h-3 w-2/3 rounded bg-[#141416]" />
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="py-24 text-center">
            <div className="font-display text-lg font-bold text-[#f2f2f2]">مفيش قطع هنا لسه</div>
            <p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-[#8a8a8a]">
              جرّب قسم تاني، أو بص على كل الدروب.
            </p>
            <button
              onClick={() => setCategory('الكل')}
              className="mt-5 rounded-full border border-white/20 px-5 py-2.5 text-xs font-bold text-[#f2f2f2] transition hover:border-primary hover:text-primary"
            >
              كل القطع
            </button>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-6 lg:grid-cols-4">
            {list.map((p, i) => (
              <ProductCard key={p.id} product={p} currency={settings.currency} delay={i * 60} />
            ))}
          </div>
        )}
      </div>

      <Footer settings={settings} />
      <div className="h-16 md:h-0" />
    </div>
  )
}
