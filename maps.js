/**
 * Maps helper — geocoding and distance utilities for generated apps.
 * Uses free Nominatim API (OpenStreetMap) for geocoding.
 */

import { sdkFetch } from './_fetch'

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org'
// Nominatim's usage policy wants a User-Agent that identifies the application
// with a way to reach it — the URL does that. Brand-neutral for the app since
// 2026-09-28 (white-label): a published app is not "WhackaApp" to its visitors.
const NOMINATIM_UA = 'AppRuntime/1.0 (+https://whacka.app)'
// A third-party host: give up after 15s rather than hanging the caller.
const GEOCODE_TIMEOUT_MS = 15_000

export const maps = {
  /**
   * Get the user's current location using the browser Geolocation API.
   * @param {object} [options]
   * @param {boolean} [options.highAccuracy=true] - Use GPS if available
   * @param {number} [options.timeout=10000] - Timeout in ms
   * @returns {Promise<{ lat: number, lng: number, accuracy: number }>}
   *
   * @example
   * const { lat, lng } = await maps.getCurrentLocation()
   */
  getCurrentLocation(options = {}) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation is not supported'))
        return
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
        (err) => reject(new Error(`Location error: ${err.message}`)),
        {
          enableHighAccuracy: options.highAccuracy !== false,
          timeout: options.timeout || 10000,
          maximumAge: 0,
        }
      )
    })
  },

  /**
   * Convert an address or place name to coordinates (geocoding).
   * @param {string} query - Address or place name
   * @returns {Promise<{ lat: number, lng: number, displayName: string } | null>}
   *
   * @example
   * const result = await maps.geocode('Tokyo Tower')
   * // result: { lat: 35.6586, lng: 139.7454, displayName: 'Tokyo Tower, ...' }
   */
  async geocode(query) {
    const url = `${NOMINATIM_BASE}/search?format=json&q=${encodeURIComponent(query)}&limit=1`
    const res = await sdkFetch(url, {
      headers: { 'User-Agent': NOMINATIM_UA },
    }, { timeoutMs: GEOCODE_TIMEOUT_MS, route: 'nominatim/search' })
    if (!res.ok) throw new Error('Geocoding failed')
    const data = await res.json()
    if (data.length === 0) return null
    return {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
      displayName: data[0].display_name,
    }
  },

  /**
   * Convert coordinates to an address (reverse geocoding).
   * @param {number} lat
   * @param {number} lng
   * @returns {Promise<{ address: string, details: object }>}
   *
   * @example
   * const { address } = await maps.reverseGeocode(35.6586, 139.7454)
   */
  async reverseGeocode(lat, lng) {
    const url = `${NOMINATIM_BASE}/reverse?format=json&lat=${lat}&lon=${lng}`
    const res = await sdkFetch(url, {
      headers: { 'User-Agent': NOMINATIM_UA },
    }, { timeoutMs: GEOCODE_TIMEOUT_MS, route: 'nominatim/reverse' })
    if (!res.ok) throw new Error('Reverse geocoding failed')
    const data = await res.json()
    return {
      address: data.display_name,
      details: data.address || {},
    }
  },

  /**
   * Calculate the distance between two points in meters (Haversine formula).
   * @param {number} lat1
   * @param {number} lng1
   * @param {number} lat2
   * @param {number} lng2
   * @returns {number} Distance in meters
   *
   * @example
   * const meters = maps.distance(35.6586, 139.7454, 35.6762, 139.6503)
   */
  distance(lat1, lng1, lat2, lng2) {
    const R = 6371000 // Earth radius in meters
    const toRad = (deg) => (deg * Math.PI) / 180
    const dLat = toRad(lat2 - lat1)
    const dLng = toRad(lng2 - lng1)
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  },

  /**
   * Watch the user's location continuously.
   * @param {function} callback - Called with { lat, lng, accuracy } on each update
   * @param {object} [options]
   * @param {boolean} [options.highAccuracy=true]
   * @returns {{ stop: () => void }}
   *
   * @example
   * const watcher = maps.watchLocation(({ lat, lng }) => {
   *   console.log('Moved to', lat, lng)
   * })
   * // Later: watcher.stop()
   */
  watchLocation(callback, options = {}) {
    if (!navigator.geolocation) {
      console.warn('[maps] Geolocation not supported')
      return { stop: () => {} }
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => callback({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      (err) => console.error('[maps] Watch error:', err.message),
      {
        enableHighAccuracy: options.highAccuracy !== false,
        maximumAge: 5000,
      }
    )

    return { stop: () => navigator.geolocation.clearWatch(watchId) }
  },
}
