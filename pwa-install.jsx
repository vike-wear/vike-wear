// Default install-prompt banner removed from the platform template (2026-06-27).
//
// This file used to ship a ready-made "Install this app?" banner that auto-
// appeared a few seconds into every session. Because the component sat in every
// project's files, the build agent tended to wire <InstallPrompt/> into apps on
// its own — turning it into a de-facto default nag on published apps, including
// cold ad-traffic landing pages where it hurt conversion.
//
// It is now a no-op. Kept (rather than deleted) so any app that still imports or
// renders <InstallPrompt/> keeps building unchanged — it simply renders nothing.
//
// PWA installability itself is unaffected: manifest.json + the service worker
// still make "Add to Home Screen" available through the browser's own UI. If a
// specific app genuinely wants an in-page install prompt, build it explicitly
// and contextually (see the push skill's guidance — never on page load).
export default function InstallPrompt() {
  return null;
}
