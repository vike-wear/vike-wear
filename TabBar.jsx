import { NavLink } from 'react-router-dom'
import { Home, ShoppingBag, ShoppingCart } from 'lucide-react'
import { useCart } from './CartProvider'

const TABS = [
  { to: '/', label: 'الرئيسية', Icon: Home },
  { to: '/shop', label: 'المتجر', Icon: ShoppingBag },
  { to: '/cart', label: 'السلة', Icon: ShoppingCart },
]

export default function TabBar() {
  const { count } = useCart()

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-white/10 bg-[#0a0a0b]/95 backdrop-blur pb-[env(safe-area-inset-bottom,0px)] md:hidden">
      <div className="grid grid-cols-3">
        {TABS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `relative flex min-h-[56px] flex-col items-center justify-center gap-1 pt-2 pb-1.5 text-[10px] font-bold transition ${
                isActive ? 'text-primary' : 'text-[#8a8a8a]'
              }`
            }
          >
            <span className="relative">
              <Icon size={20} strokeWidth={1.9} />
              {to === '/cart' && count > 0 && (
                <span className="absolute -top-1.5 -left-2 grid h-4 w-4 place-items-center rounded-full bg-primary text-[9px] font-black text-black">
                  {count}
                </span>
              )}
            </span>
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
