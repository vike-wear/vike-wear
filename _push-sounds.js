// Push sound library — the CLIENT twin of src/lib/push/sounds.ts (the server
// registry is the source of truth; scripts/_test-push-sounds.ts asserts the
// ids, labels and channel ids here match it). Two jobs:
//   1. push.sounds() — the ids an app may pass as `sound` on send/schedule.
//   2. Android notification CHANNELS — on Android 8+ the sound belongs to the
//      channel, not the message, so the native shell creates one channel per
//      library sound at launch (idempotent) and the server addresses it by
//      channel id. iOS needs nothing here (aps.sound names the bundled file).
// The web/PWA build ignores `sound` entirely (browsers play the default tone).
export const PUSH_SOUND_IDS = ['siren', 'alarm', 'bell', 'chime', 'adhan', 'adhan-fakhry', 'adhan-alafasy', 'adhan-turkish']

const LABELS = {
  'siren': 'Siren alerts',
  'alarm': 'Alarm alerts',
  'bell': 'Bell alerts',
  'chime': 'Chime alerts',
  'adhan': 'Adhan alerts',
  'adhan-fakhry': 'Adhan (Sabah Fakhry) alerts',
  'adhan-alafasy': 'Adhan (Alafasy) alerts',
  'adhan-turkish': 'Adhan (Turkish) alerts',
}

// Android resource names allow only [a-z0-9_]: 'adhan-fakhry' → 'wk_adhan_fakhry'.
const base = (id) => `wk_${id.replace(/-/g, '_')}`

/** Channel spec per sound, mirrored from the server registry. */
export function pushSoundChannels() {
  return PUSH_SOUND_IDS.map((id) => ({
    id: `wk_sound_${id.replace(/-/g, '_')}`,
    name: LABELS[id],
    description: `Notifications that play the ${id} sound`,
    // res/raw/wk_<id>.ogg — the plugin strips the extension and resolves
    // android.resource://<pkg>/raw/wk_<id>.
    sound: `${base(id)}.ogg`,
    importance: 5, // IMPORTANCE_HIGH — heads-up + sound (what an alert wants)
    visibility: 1, // VISIBILITY_PUBLIC — full content on the lock screen
    vibration: true,
  }))
}

/** True when the string names a library sound (case-insensitive). */
export function isPushSound(id) {
  return typeof id === 'string' && PUSH_SOUND_IDS.includes(id.trim().toLowerCase())
}
