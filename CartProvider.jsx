import { createContext, useContext, useEffect, useMemo, useState } from 'react'

const CART_KEY = 'layl_cart_v1'
const CartCtx = createContext(null)

function readStored() {
  try {
    const raw = localStorage.getItem(CART_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? parsed.filter((i) => i && i.sku && i.qty > 0) : []
  } catch {
    return []
  }
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(readStored)

  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(items))
    } catch {
      /* private mode — cart just stays in memory */
    }
  }, [items])

  const api = useMemo(() => {
    const add = (line) => {
      const key = `${line.sku}|${line.size}|${line.color}`
      setItems((prev) => {
        const found = prev.find((i) => i.key === key)
        if (found) {
          return prev.map((i) =>
            i.key === key ? { ...i, qty: Math.min(20, i.qty + (line.qty || 1)) } : i,
          )
        }
        return [...prev, { ...line, key, qty: line.qty || 1 }]
      })
      return key
    }

    const setQty = (key, qty) => {
      const next = Math.max(0, Math.min(20, Number(qty) || 0))
      setItems((prev) =>
        next === 0
          ? prev.filter((i) => i.key !== key)
          : prev.map((i) => (i.key === key ? { ...i, qty: next } : i)),
      )
    }

    const remove = (key) => setItems((prev) => prev.filter((i) => i.key !== key))
    const clear = () => setItems([])

    const count = items.reduce((n, i) => n + i.qty, 0)
    const subtotal = items.reduce((n, i) => n + i.qty * Number(i.price || 0), 0)

    return { items, add, setQty, remove, clear, count, subtotal }
  }, [items])

  return <CartCtx.Provider value={api}>{children}</CartCtx.Provider>
}

export function useCart() {
  const ctx = useContext(CartCtx)
  if (!ctx) throw new Error('useCart must be used inside CartProvider')
  return ctx
}
