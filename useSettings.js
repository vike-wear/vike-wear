import { useLiveShared } from '../lib/useLive'
import { DEFAULT_SETTINGS } from '../shop'

// Live shop settings (brand name, images, currency, shipping…).
export function useSettings() {
  const { data, loading } = useLiveShared('settings', { limit: 1 })
  const settings = { ...DEFAULT_SETTINGS, ...(data?.[0] || {}) }
  return { settings, loading }
}
