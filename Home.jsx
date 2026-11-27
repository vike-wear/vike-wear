import { Link } from 'react-router-dom'
import { ArrowLeft, Truck, RefreshCcw, Wallet } from 'lucide-react'
import { useLiveShared } from '../lib/useLive'
import ProductCard from '../components/ProductCard'
import Marquee from '../components/Marquee'
import Footer from '../components/Footer'
import { DEFAULT_SETTINGS } from '../shop'

const VALUES = [
  { Icon: Truck, title: 'توصيل ٢ لـ ٥ أيام', text: 'لكل محافظات مصر، وتتبع مع المندوب.' },
  { Icon: Wallet, title: 'دفع عند الاستلام', text: 'تشوف القطعة الأول، وبعدين تدفع.' },
  { Icon: RefreshCcw, title: 'استبدال ١٤ يوم', text: 'المقاس مش مضبوط؟ بنستبدله ببلاش.' },
]

export default function Home() {
  const { data: products, loading } = useLiveShared('products', { order: '-createdAt' })
  const { data: settingsRows } = useLiveShared('settings', { limit: 1 })

  const settings = { ...DEFAULT_SETTINGS, ...(settingsRows?.[0] || {}) }
  const brandWords = String(settings.brandName || DEFAULT_SETTINGS.brandName)
    .trim()
    .split(/\s+/)
  const brandLast = brandWords[brandWords.length - 1] || ''
  const brandHead = brandWords.slice(0, -1).join(' ')
  const active = (products || []).filter((p) => p.active !== false)
  const featured = active.filter((p) => p.featured)
  const picks = (featured.length ? featured : active).slice(0, 4)

  return (
    <div className="h-full overflow-y-auto">
      {/* ── HERO ─────────────────────────────────────────── */}
      <section className="relative grain overflow-hidden">
        <div className="absolute inset-0">
          <img
            src={settings.heroImage}
            alt={settings.brandName}
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
            className="h-full w-full object-cover object-[center_25%] opacity-[0.55]"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0b] via-[#0a0a0b]/70 to-[#0a0a0b]/25" />
        </div>

        <div className="relative mx-auto flex min-h-[78vh] w-full max-w-6xl flex-col justify-end px-4 pb-12 pt-16 md:min-h-[82vh] md:px-8 md:pb-20">
          <div className="reveal mb-5 inline-flex w-fit items-center gap-2 rounded-full border border-white/20 bg-black/30 px-3 py-1.5 backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            <span className="text-[10px] font-black tracking-widest text-[#f2f2f2]">
              دروب ٠١ — شتاء ٢٥
            </span>
          </div>

          <h1
            className="font-display reveal text-[19vw] font-black leading-[0.82] text-[#f2f2f2] sm:text-[13vw] md:text-[9.5vw] lg:text-[7.5rem]"
            style={{ animationDelay: '80ms' }}
          >
            {brandHead ? (
              <>
                {brandHead}
                <br />
              </>
            ) : null}
            <span className="relative inline-block">
              {brandLast}
              <span className="absolute -bottom-1 left-0 right-0 h-[6px] rounded-full bg-primary md:h-2" />
            </span>
          </h1>

          <p
            className="reveal mt-6 max-w-md text-sm leading-7 text-[#cfcfcf] md:text-base"
            style={{ animationDelay: '200ms' }}
          >
            ملابس للي بيفضّلوا الشارع بعد نص الليل. هوديز وسويت شيرتس وبناطيل بقصّات واسعة وقماش
            تقيل — متعمولة عشان تتعاش.
          </p>

          <div className="reveal mt-8 flex flex-wrap items-center gap-3" style={{ animationDelay: '320ms' }}>
            <Link
              to="/shop"
              className="group inline-flex items-center gap-2 rounded-full bg-primary px-7 py-3.5 text-sm font-black text-black transition hover:bg-[#d8d8d8] active:scale-[0.98]"
            >
              اتفرج على الدروب
              <ArrowLeft size={16} className="transition group-hover:-translate-x-1" />
            </Link>
          </div>
        </div>
      </section>

      <Marquee />

      {/* ── PICKS ────────────────────────────────────────── */}
      <section className="mx-auto w-full max-w-6xl px-4 py-14 md:px-8 md:py-20">
        <div className="mb-7 flex items-end justify-between gap-4 md:mb-10">
          <div>
            <span className="text-[11px] font-black uppercase tracking-[0.25em] text-primary">
              الجديد
            </span>
            <h2 className="font-display mt-2 text-2xl font-black md:text-4xl">أحلى ٤ قطع في الدروب</h2>
          </div>
          <Link
            to="/shop"
            className="shrink-0 text-xs font-bold text-[#909090] underline-offset-4 transition hover:text-primary hover:underline md:text-sm"
          >
            كل القطع
          </Link>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-6">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse">
                <div className="aspect-[3/4] rounded-2xl bg-[#141416]" />
                <div className="mt-3 h-3 w-2/3 rounded bg-[#141416]" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-6">
            {picks.map((p, i) => (
              <ProductCard key={p.id} product={p} currency={settings.currency} delay={i * 90} />
            ))}
          </div>
        )}
      </section>

      {/* ── VALUES ───────────────────────────────────────── */}
      <section className="border-y border-white/10 bg-[#0d0d0f]">
        <div className="mx-auto grid w-full max-w-6xl gap-px px-4 py-2 md:grid-cols-3 md:px-8">
          {VALUES.map(({ Icon, title, text }) => (
            <div key={title} className="flex items-start gap-3 py-6 md:px-6">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-primary/30 text-primary">
                <Icon size={17} strokeWidth={1.8} />
              </span>
              <div>
                <h3 className="font-display text-sm font-bold text-[#f2f2f2]">{title}</h3>
                <p className="mt-1 text-xs leading-5 text-[#8a8a8a]">{text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────── */}
      <section className="mx-auto w-full max-w-6xl px-4 pb-4 md:px-8">
        <div className="relative overflow-hidden rounded-3xl border border-primary/20 bg-gradient-to-l from-primary/[0.12] via-[#101012] to-[#0d0d0f] px-6 py-12 text-center md:px-16 md:py-16">
          <h2 className="font-display text-2xl font-black leading-snug md:text-4xl">
            الدروب بيخلص بسرعة
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[#a8a8a8]">
            كل دروب بنعمله بعدد محدود ومش بنعيده تاني. لو لقيت مقاسك — خده.
          </p>
          <Link
            to="/shop"
            className="mt-7 inline-flex items-center gap-2 rounded-full bg-primary px-8 py-3.5 text-sm font-black text-black transition hover:bg-[#d8d8d8] active:scale-[0.98]"
          >
            اتسوّق دلوقتي
            <ArrowLeft size={16} />
          </Link>
        </div>
      </section>

      <Footer settings={settings} />

      <div className="h-16 md:h-0" />
    </div>
  )
}
