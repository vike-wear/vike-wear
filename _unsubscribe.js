// One shape for every "stop listening" handle the SDK hands out (2026-10-15).
//
// db.subscribe / db.subscribeShared, messaging.onMessage and payments.onPayment
// answered with `{ unsubscribe }` while auth.onAuthChange answered with a bare
// function, and generated code — following React's usual
// `const off = …; return () => off()` — called the object: "x is not a
// function" thrown from an effect cleanup lands in the error boundary, so the
// visitor saw "Something went wrong" on LEAVING the page (wasl-vrc7 and ~14
// more apps, 2026-10-14). The handle is now a function that also carries
// `.unsubscribe`, so `off()`, `off?.()`, `sub.unsubscribe()` and
// `useEffect(() => db.subscribeShared(…), [])` all stop the listener.
export function unsubscribeHandle(stop) {
  const off = () => { stop() }
  off.unsubscribe = off
  return off
}
