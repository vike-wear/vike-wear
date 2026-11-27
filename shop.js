// Shared shop constants + tiny helpers (no JSX here).

export const HERO_IMAGE =
  'https://api.whacka.app/storage/v1/object/public/app-images/054af651-0441-4fd3-8756-b9509750405a/0821e4f5-00e1-4868-892d-2db5831e520e.png'

export const HERO_CREDIT = 'Leroy_Skalstad'

export const STORY_IMAGE =
  'https://api.whacka.app/storage/v1/object/public/app-images/054af651-0441-4fd3-8756-b9509750405a/d64a862f-3c9d-46d1-9df0-217df4db5393.jpg'

export const STORY_CREDIT = 'Pexels'

export const CATEGORIES = ['الكل', 'هوديز', 'سويت شيرتس', 'بناطيل', 'أطقم']

// المقاسات المتاحة للقطع اللي بتتقاس (هودي / سويت شيرت / طقم)
export const DEFAULT_SIZES = ['L', 'XL', 'XXL']

export const SIZED_CATEGORIES = ['هوديز', 'سويت شيرتس', 'أطقم']

export function sizesFor(product) {
  if (!product) return []
  // لو صاحب المتجر ظبط مقاسات القطعة بنفسه، هي اللي تظهر.
  const custom = Array.isArray(product.sizes)
    ? product.sizes.map((s) => String(s).trim()).filter(Boolean)
    : []
  if (custom.length) return custom
  if (!SIZED_CATEGORIES.includes(product.category)) return []
  return DEFAULT_SIZES
}

// ألوان القطعة زي ما صاحب المتجر ظبطها.
export function colorsFor(product) {
  if (!product || !Array.isArray(product.colors)) return []
  return product.colors.filter((c) => c && String(c.name || '').trim())
}

export const SORTS = [
  { id: 'new', label: 'الأحدث' },
  { id: 'low', label: 'الأرخص' },
  { id: 'high', label: 'الأغلى' },
]

export const DEFAULT_STORY_TITLE = 'اتولدنا في\nالشارع. بعد نص الليل.'

export const DEFAULT_STORY_INTRO =
  'ليل ستريت براند مصري للستريت وير. بنعمل هوديز وسويت شيرتس وبناطيل بقصّات واسعة وقماش تقيل — عشان الهدوم اللي بتحبها تعيش معاك أكتر من موسم.'

export const DEFAULT_STORY_BLOCKS = [
  {
    title: 'الليل مش وقت نوم',
    text: 'ليل ستريت بدأ من فكرة بسيطة: أحلى لحظات المدينة بتحصل بعد ما الناس تنام. القهوة اللي على الرصيف، الكورة على الأسفلت، والكلام اللي مش بيتقال في النهار. عايزين هدوم تنفع للحظات دي — واسعة، تقيلة، ومش بتسأل حد.',
  },
  {
    title: 'قماش قبل أي حاجة',
    text: 'بنختار القماش الأول وبعدين نصمّم. قطن مبطن ٤٠٠ جرام للأغلب، و٤٥٠ للقطع التقيلة. بنجرّب كل لفة قماش بنفسنا قبل ما ندخلها إنتاج — لو بتوبّل أو بتفرط بعد أول غسلة، مش بتنزل.',
  },
  {
    title: 'قصّة واحدة بتتظبّط مرة',
    text: 'كل موديل بيعدّي على ٣ دورات تجربة قبل ما يبقى متاح. بنقيس الكتف والطول والفتحة، وبنسمع من الناس اللي لبست. القصّة اللي عندنا دلوقتي هي نسخة رابعة لكل هودي.',
  },
  {
    title: 'كميات صغيرة… وقصد',
    text: 'الدروب بعدد محدود ومش بنعيده. مش عشان نبقى "حصريين" — عشان نقدر نضبط الجودة ونمنع الهدر. لو قطعة خلصت، خلصت بجد.',
  },
]

export const DEFAULT_SETTINGS = {
  brandName: 'ليل ستريت',
  logo: '',
  heroImage: HERO_IMAGE,
  sizeGuide: '',
  storyImage: STORY_IMAGE,
  storyTitle: DEFAULT_STORY_TITLE,
  storyIntro: DEFAULT_STORY_INTRO,
  storyBlocks: DEFAULT_STORY_BLOCKS,
  currency: 'ج.م',
  shipping: 60,
  freeShippingOver: 2000,
  whatsapp: '',
  instagram: '',
  note: 'الدفع عند الاستلام متاح لكل المحافظات.',
}

// One canonical payload for the shared settings row, so saving one tab
// never drops what another tab wrote.
export function settingsPayload(current, overrides = {}) {
  const c = { ...DEFAULT_SETTINGS, ...(current || {}) }
  return {
    brandName: c.brandName || DEFAULT_SETTINGS.brandName,
    logo: c.logo || '',
    heroImage: c.heroImage || HERO_IMAGE,
    sizeGuide: c.sizeGuide || '',
    storyImage: c.storyImage || STORY_IMAGE,
    storyTitle: String(c.storyTitle || DEFAULT_STORY_TITLE),
    storyIntro: String(c.storyIntro || DEFAULT_STORY_INTRO),
    storyBlocks: (Array.isArray(c.storyBlocks) && c.storyBlocks.length
      ? c.storyBlocks
      : DEFAULT_STORY_BLOCKS
    )
      .slice(0, 12)
      .map((b) => ({ title: String(b?.title || ''), text: String(b?.text || '') })),
    currency: c.currency || DEFAULT_SETTINGS.currency,
    shipping: Number(c.shipping) || 0,
    freeShippingOver: Number(c.freeShippingOver) || 0,
    whatsapp: String(c.whatsapp || '').replace(/[^\d]/g, ''),
    instagram: c.instagram || '',
    note: c.note || '',
    ...overrides,
  }
}

export function money(value, currency = 'ج.م') {
  const n = Number(value || 0)
  return `${n.toLocaleString('en-US')} ${currency}`
}

export function cartTotal(subtotal, settings) {
  const cfg = { ...DEFAULT_SETTINGS, ...(settings || {}) }
  const free = Number(cfg.freeShippingOver || 0)
  const ship = Number(cfg.shipping || 0)
  const shipping = subtotal <= 0 || (free > 0 && subtotal >= free) ? 0 : ship
  return { shipping, total: subtotal + shipping, freeOver: free, free: shipping === 0 }
}

export function orderCode() {
  const stamp = Date.now().toString(36).slice(-4).toUpperCase()
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase()
  return `LS-${stamp}${rand}`
}
