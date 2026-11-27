import { Link } from 'react-router-dom'
import { money } from '../shop'
import ProductImage from './ProductImage'

export default function ProductCard({ product, currency = 'ج.م', delay = 0 }) {
  const soldOut = Number(product.stock ?? 1) <= 0

  return (
    <Link
      to={`/product/${product.id}`}
      className="group reveal block"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="relative overflow-hidden rounded-2xl border border-white/[0.06]">
        <ProductImage
          src={product.image}
          alt={product.name}
          className="aspect-[3/4]"
          imgClassName="group-hover:scale-[1.06]"
        />

        {product.badge && !soldOut && (
          <span className="absolute right-3 top-3 rounded-full bg-primary px-2.5 py-1 text-[10px] font-black text-black">
            {product.badge}
          </span>
        )}

        {soldOut && (
          <span className="absolute right-3 top-3 rounded-full bg-[#0a0a0b]/85 px-2.5 py-1 text-[10px] font-black text-[#cfcfcf]">
            خلص
          </span>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-2 bg-gradient-to-t from-black/85 to-transparent p-3 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
          <span className="text-[11px] font-black text-[#f2f2f2]">شوف التفاصيل ←</span>
        </div>
      </div>

      <div className="mt-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-display truncate text-[15px] font-bold text-[#f2f2f2]">
            {product.name}
          </h3>
          <p className="mt-0.5 text-[11px] text-[#8a8a8a]">{product.category}</p>
        </div>
        <div className="shrink-0 text-left">
          <div className="text-sm font-black text-primary">{money(product.price, currency)}</div>
          {product.oldPrice ? (
            <div className="text-[11px] text-[#6b6b6b] line-through">
              {money(product.oldPrice, currency)}
            </div>
          ) : null}
        </div>
      </div>
    </Link>
  )
}
