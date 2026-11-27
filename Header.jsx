import { Link, NavLink } from 'react-router-dom'
import { ShoppingBag } from 'lucide-react'
import { useCart } from './CartProvider'
import { useSettings } from '../hooks/useSettings'

const LINKS = [
  { to: '/', label: 'الرئيسية' },
  { to: '/shop', label: 'المتجر' },
]

export default function Header() {
  const { count } = useCart()
  const { settings } = useSettings()

  return (
    <header className="relative z-30 shrink-0 border-b border-white/10 bg-[#0a0a0b]/90 backdrop-blur">
      <div className="pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 md:h-20 md:px-8">
          <Link to="/" className="group flex items-center gap-2">
            {settings.logo ? (
              <img
                src={settings.logo}
                alt={settings.brandName}
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                }}
                className="h-8 w-8 rounded-lg object-cover md:h-10 md:w-10"
              />
            ) : null}
            <span className="font-display flex items-baseline gap-1">
              <span className="text-xl font-black tracking-tight text-[#f2f2f2] md:text-2xl">
                {settings.brandName}
              </span>
              <span className="text-primary text-2xl leading-none">.</span>
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {LINKS.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === '/'}
                className={({ isActive }) =>
                  `rounded-full px-4 py-2 text-sm font-bold transition ${
                    isActive
                      ? 'bg-white/10 text-[#f2f2f2]'
                      : 'text-[#909090] hover:bg-white/5 hover:text-[#f2f2f2]'
                  }`
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>

          <Link
            to="/cart"
            aria-label="السلة"
            className="relative flex h-11 w-11 items-center justify-center rounded-full border border-white/10 text-[#f2f2f2] transition hover:border-primary/60 hover:text-primary"
          >
            <ShoppingBag size={19} strokeWidth={1.8} />
            {count > 0 && (
              <span className="absolute -top-0.5 -left-0.5 grid h-5 w-5 place-items-center rounded-full bg-primary text-[10px] font-black text-black">
                {count}
              </span>
            )}
          </Link>
        </div>
      </div>
    </header>
  )
}
