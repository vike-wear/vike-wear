import { Link } from 'react-router-dom'
import { Instagram, MessageCircle } from 'lucide-react'

const CREDITS = [
  'MEHRAX',
  'RebelzZynX',
  'dinhbao1210',
  'LoboStudioHamburg',
  'mostafa_meraji',
  'Engin_Akyurt',
  'the_ahnafpiash',
  'Leroy_Skalstad',
  'Pexels',
]

export default function Footer({ settings }) {
  return (
    <footer className="mt-16 border-t border-white/10 bg-[#0a0a0b]">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 md:px-8 md:py-14">
        <div className="grid gap-8 md:grid-cols-3">
          <div>
            <div className="font-display text-2xl font-black text-[#f2f2f2]">
              {settings?.brandName || 'ليل ستريت'}
              <span className="text-primary">.</span>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-6 text-[#909090]">
              هوديز وسويت شيرتس وبناطيل، متصمّمة ومصنوعة في مصر. قصّات واسعة، قماش تقيل، وتفاصيل
              بتعيش معاك سنين.
            </p>
          </div>

          <div className="flex flex-col gap-2 text-sm">
            <span className="mb-1 text-[11px] font-black uppercase tracking-widest text-[#6b6b6b]">
              تلفّ وتلاقي
            </span>
            <Link to="/shop" className="w-fit text-[#cfcfcf] transition hover:text-primary">
              كل القطع
            </Link>
            <Link to="/cart" className="w-fit text-[#cfcfcf] transition hover:text-primary">
              سلتي
            </Link>
            <Link to="/owner" className="w-fit text-[#6b6b6b] transition hover:text-primary">
              لوحة إدارة المتجر
            </Link>
          </div>

          <div className="flex flex-col gap-3">
            <span className="text-[11px] font-black uppercase tracking-widest text-[#6b6b6b]">
              تواصل معانا
            </span>
            {settings?.whatsapp ? (
              <a
                href={`https://wa.me/${String(settings.whatsapp).replace(/[^\d]/g, '')}`}
                target="_blank"
                rel="noreferrer"
                className="flex w-fit items-center gap-2 text-sm text-[#cfcfcf] transition hover:text-primary"
              >
                <MessageCircle size={16} /> واتساب
              </a>
            ) : (
              <span className="flex items-center gap-2 text-sm text-[#6b6b6b]">
                <MessageCircle size={16} /> واتساب (هيتضاف قريب)
              </span>
            )}
            {settings?.instagram ? (
              <a
                href={`https://instagram.com/${String(settings.instagram).replace('@', '')}`}
                target="_blank"
                rel="noreferrer"
                className="flex w-fit items-center gap-2 text-sm text-[#cfcfcf] transition hover:text-primary"
              >
                <Instagram size={16} /> انستجرام
              </a>
            ) : null}
            <p className="text-xs leading-5 text-[#6b6b6b]">{settings?.note}</p>
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-white/10 pt-6 text-[11px] text-[#5c5c5c] md:flex-row md:items-center md:justify-between">
          <span>© {new Date().getFullYear()} {settings?.brandName || 'ليل ستريت'} — كل الحقوق محفوظة.</span>
          <span className="leading-5">
            صور المنتجات: {CREDITS.join(' · ')} — عبر Pixabay
          </span>
        </div>
      </div>
    </footer>
  )
}
