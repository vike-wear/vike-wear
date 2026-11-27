import { useEffect } from 'react'
import { HashRouter, Routes, Route } from 'react-router-dom'
import { CartProvider } from './components/CartProvider'
import Header from './components/Header'
import TabBar from './components/TabBar'
import Home from './pages/Home'
import Shop from './pages/Shop'
import ProductPage from './pages/ProductPage'
import CartPage from './pages/CartPage'
import Checkout from './pages/Checkout'
import Owner from './pages/Owner'

export default function App() {
  useEffect(() => {
    document.documentElement.lang = 'ar'
    document.documentElement.dir = 'rtl'
  }, [])

  return (
    <CartProvider>
      <HashRouter>
        <div className="flex h-full flex-col bg-[#0a0a0b] text-[#f2f2f2]">
          <Header />
          <main className="relative min-h-0 flex-1">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/shop" element={<Shop />} />
              <Route path="/product/:id" element={<ProductPage />} />
              <Route path="/cart" element={<CartPage />} />
              <Route path="/checkout" element={<Checkout />} />
              <Route path="/owner" element={<Owner />} />
            </Routes>
          </main>
          <TabBar />
        </div>
      </HashRouter>
    </CartProvider>
  )
}
