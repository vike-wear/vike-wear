// A list read with no limit (db.select / selectShared and the live hooks) is
// the whole list up to the server's single-read cap. It used to be a 100- or
// 200-row page that silently dropped everything past it once a collection grew
// (delivery ledger P3, 2026-10-18); a limit now means "the newest N" only. Past
// 1000 rows the server flags the cut (X-Whacka-Data-Truncated). Internal module:
// the public db.js surface stays `db` alone.
export const LIST_DEFAULT_LIMIT = 1000
