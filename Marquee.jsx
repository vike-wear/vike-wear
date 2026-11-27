const ITEMS = [
  'توصيل لكل محافظات مصر',
  'دفع عند الاستلام',
  'استبدال خلال ١٤ يوم',
  'قماش ٤٠٠ جرام',
  'دروب محدود العدد',
]

export default function Marquee() {
  const line = [...ITEMS, ...ITEMS]

  return (
    <div className="overflow-hidden border-y border-black/20 bg-primary py-2.5">
      <div className="marquee-track">
        {[0, 1].map((dup) => (
          <div key={dup} className="flex shrink-0 items-center">
            {line.map((text, i) => (
              <span
                key={`${dup}-${i}`}
                className="flex items-center whitespace-nowrap text-[11px] font-black tracking-wide text-black md:text-xs"
              >
                <span className="px-5">{text}</span>
                <span className="text-black/40">✦</span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
