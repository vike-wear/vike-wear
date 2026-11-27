// ─────────────────────────────────────────────
// Digits a person types (delivery ledger P49, 2026-10-20)
// ─────────────────────────────────────────────
// An Arabic keyboard types ٠-٩, a Persian / Urdu one ۰-۹: the same digits as
// 0-9. TeamAdmin keeps them in a username; TeamLogin's PIN box takes them.
// Same rule as the server's src/lib/typed-digits.ts (_test-typed-digits.ts).
// Internal: not exposed to generated app code directly.

const TYPED_DIGIT = /[٠-٩۰-۹]/g

/** ٠-٩ and ۰-۹ as 0-9; every other character unchanged. */
export function foldTypedDigits(s) {
  return String(s ?? '').replace(TYPED_DIGIT, (d) => {
    const c = d.charCodeAt(0)
    return String(c - (c >= 0x06f0 ? 0x06f0 : 0x0660))
  })
}
