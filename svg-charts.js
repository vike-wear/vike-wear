// SVG chart generators — platform port of the docs.pdf chart engine.
//
// Mechanical JS port of src/lib/files/svg-charts.ts (types stripped, behavior
// identical). Pure functions, no DOM, no deps. All text is XML-escaped and all
// caller colors are sanitized to a hex literal, so nothing from a spec can
// break the SVG. The app supplies structured data; this module owns the layout
// (tick density, font size, collision avoidance).
//
// ChartSpec grammar (same as docs.pdf `{ type: 'chart', chart }` sections):
//   { kind: 'bar'|'hbar'|'line'|'pie'|'donut',
//     series: [{ name?: string, data: number[], color?: '#hex' }],
//     labels?: string[],
//     options?: { title?: string, stacked?: boolean, yMax?: number } }

export const xesc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Accept #rgb / #rrggbb (and rgb()/named are rejected → fallback). */
export function safeColor(c, fallback = '#2563eb') {
  if (typeof c === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c.trim())) return c.trim();
  return fallback;
}

const PALETTE = ['#2563eb', '#16a34a', '#dc2626', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

const num = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

// Fold-based max/length so a huge data array never blows the call stack —
// Math.max(...arr) spreads every element as an argument and throws
// "Maximum call stack size exceeded" past ~150k points (identical for the PDF
// path). Same result as Math.max, O(n) with no spread.
const maxOf = (arr, seed) => arr.reduce((m, v) => (v > m ? v : m), seed);
const maxLen = (series) => series.reduce((m, s) => (s.data.length > m ? s.data.length : m), 0);

/** Compact axis number: 1234 → 1.2k, 2_500_000 → 2.5M. */
function fmtNum(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return trim(n / 1e9) + 'B';
  if (a >= 1e6) return trim(n / 1e6) + 'M';
  if (a >= 1e3) return trim(n / 1e3) + 'k';
  return trim(n);
}
const trim = (n) => {
  const r = Math.round(n * 10) / 10;
  return (Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)).replace(/\.0$/, '');
};

/** "Nice" axis max so gridlines land on round numbers. */
function niceMax(max) {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * pow;
}

// ── Chart ───────────────────────────────────────────────────────────────────

const FONT = "font-family:'NotoSans',sans-serif";

/** Render a chart spec to an <svg> string (width:100%, scales to the container). */
export function chartSvg(spec) {
  const kind = spec?.kind;
  const series = (Array.isArray(spec?.series) ? spec.series : []).filter((s) => Array.isArray(s?.data));
  const labels = Array.isArray(spec?.labels) ? spec.labels.map(String) : [];
  const title = spec?.options?.title ? String(spec.options.title) : '';
  if (!series.length) return '';
  if (kind === 'pie' || kind === 'donut') return pieSvg(series[0].data.map((d) => num(d)), labels, kind === 'donut', title);
  if (kind === 'hbar') return hbarSvg(series, labels, title);
  if (kind === 'line') return lineSvg(series, labels, title);
  return barSvg(series, labels, title, !!spec.options?.stacked, spec.options?.yMax);
}

const W = 720;

function titleBlock(title) {
  if (!title) return { svg: '', top: 16 };
  return { svg: `<text x="${W / 2}" y="22" text-anchor="middle" style="${FONT};font-size:15px;font-weight:700;fill:#111">${xesc(title)}</text>`, top: 44 };
}

function legend(series, y) {
  if (series.length < 2) return '';
  let x = 60;
  const items = series.map((s, i) => {
    const c = safeColor(s.color, PALETTE[i % PALETTE.length]);
    const label = xesc(s.name || `Series ${i + 1}`);
    const w = 18 + label.length * 6.2 + 18;
    const out = `<rect x="${x}" y="${y - 9}" width="11" height="11" rx="2" fill="${c}"/><text x="${x + 16}" y="${y}" style="${FONT};font-size:11px;fill:#374151">${label}</text>`;
    x += w;
    return out;
  });
  return items.join('');
}

function barSvg(series, labels, title, stacked, yMaxOpt) {
  const { svg: tSvg, top } = titleBlock(title);
  const n = Math.max(maxLen(series), labels.length || 0);
  const padL = 48, padR = 16, padB = 46;
  const hasLegend = series.length > 1;
  const H = 360;
  const plotTop = top, plotBot = H - padB, plotH = plotBot - plotTop, plotW = W - padL - padR;
  const max = yMaxOpt && yMaxOpt > 0 ? yMaxOpt
    : niceMax(stacked
      ? maxOf(Array.from({ length: n }, (_, i) => series.reduce((s, ser) => s + Math.max(0, num(ser.data[i])), 0)), 1)
      : maxOf(series.flatMap((s) => s.data.map((d) => Math.max(0, num(d)))), 1));
  const y = (v) => plotBot - (v / max) * plotH;

  // gridlines + y labels
  let grid = '';
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = (max / steps) * i;
    const yy = y(v);
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#e5e7eb" stroke-width="1"/>`;
    grid += `<text x="${padL - 6}" y="${yy + 3.5}" text-anchor="end" style="${FONT};font-size:10px;fill:#9ca3af">${fmtNum(v)}</text>`;
  }

  const groupW = plotW / Math.max(1, n);
  const innerPad = groupW * 0.18;
  let bars = '';
  let xlabels = '';
  for (let i = 0; i < n; i++) {
    const gx = padL + i * groupW + innerPad;
    const gw = groupW - innerPad * 2;
    if (stacked) {
      let acc = 0;
      series.forEach((s, si) => {
        const v = Math.max(0, num(s.data[i]));
        const h = (v / max) * plotH;
        const yTop = plotBot - ((acc + v) / max) * plotH;
        if (v > 0) bars += `<rect x="${gx.toFixed(1)}" y="${yTop.toFixed(1)}" width="${gw.toFixed(1)}" height="${h.toFixed(1)}" fill="${safeColor(s.color, PALETTE[si % PALETTE.length])}"/>`;
        acc += v;
      });
    } else {
      const bw = gw / series.length;
      series.forEach((s, si) => {
        const v = Math.max(0, num(s.data[i]));
        const h = (v / max) * plotH;
        const bx = gx + si * bw;
        bars += `<rect x="${bx.toFixed(1)}" y="${y(v).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${safeColor(s.color, PALETTE[si % PALETTE.length])}"/>`;
      });
    }
    const lab = labels[i];
    if (lab) xlabels += `<text x="${(gx + gw / 2).toFixed(1)}" y="${plotBot + 16}" text-anchor="middle" style="${FONT};font-size:10px;fill:#6b7280">${xesc(truncate(lab, Math.max(4, Math.floor(groupW / 6))))}</text>`;
  }

  return wrap(H, `${tSvg}${grid}${bars}${xlabels}${hasLegend ? legend(series, H - 14) : ''}`);
}

function hbarSvg(series, labels, title) {
  const { svg: tSvg, top } = titleBlock(title);
  const data = series[0].data.map((d) => num(d));
  const n = data.length;
  const rowH = 26, padL = 130, padR = 40;
  const H = top + n * rowH + 16;
  const plotW = W - padL - padR;
  const max = niceMax(maxOf(data.map((d) => Math.max(0, d)), 1));
  let rows = '';
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, data[i]);
    const y = top + i * rowH;
    const bw = (v / max) * plotW;
    const c = safeColor(series[0].color, PALETTE[i % PALETTE.length]);
    rows += `<text x="${padL - 8}" y="${y + rowH / 2 + 3.5}" text-anchor="end" style="${FONT};font-size:11px;fill:#374151">${xesc(truncate(labels[i] || '', 20))}</text>`;
    rows += `<rect x="${padL}" y="${y + 4}" width="${Math.max(1, bw).toFixed(1)}" height="${rowH - 12}" rx="2" fill="${c}"/>`;
    rows += `<text x="${(padL + bw + 6).toFixed(1)}" y="${y + rowH / 2 + 3.5}" style="${FONT};font-size:10px;fill:#6b7280">${fmtNum(v)}</text>`;
  }
  return wrap(H, `${tSvg}${rows}`);
}

function lineSvg(series, labels, title) {
  const { svg: tSvg, top } = titleBlock(title);
  const n = maxLen(series);
  const padL = 48, padR = 16, padB = 46;
  const H = 360;
  const plotTop = top, plotBot = H - padB, plotH = plotBot - plotTop, plotW = W - padL - padR;
  const max = niceMax(maxOf(series.flatMap((s) => s.data.map((d) => Math.max(0, num(d)))), 1));
  const xFor = (i) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yFor = (v) => plotBot - (v / max) * plotH;
  let grid = '';
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = (max / steps) * i, yy = yFor(v);
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#e5e7eb" stroke-width="1"/>`;
    grid += `<text x="${padL - 6}" y="${yy + 3.5}" text-anchor="end" style="${FONT};font-size:10px;fill:#9ca3af">${fmtNum(v)}</text>`;
  }
  let lines = '';
  series.forEach((s, si) => {
    const c = safeColor(s.color, PALETTE[si % PALETTE.length]);
    const pts = s.data.map((d, i) => `${xFor(i).toFixed(1)},${yFor(Math.max(0, num(d))).toFixed(1)}`).join(' ');
    lines += `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    s.data.forEach((d, i) => { lines += `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(Math.max(0, num(d))).toFixed(1)}" r="2.6" fill="${c}"/>`; });
  });
  let xlabels = '';
  const skip = Math.ceil((labels.length || n) / 12);
  for (let i = 0; i < (labels.length || 0); i++) {
    if (i % skip !== 0) continue;
    xlabels += `<text x="${xFor(i).toFixed(1)}" y="${plotBot + 16}" text-anchor="middle" style="${FONT};font-size:10px;fill:#6b7280">${xesc(truncate(labels[i], 10))}</text>`;
  }
  return wrap(H, `${tSvg}${grid}${lines}${xlabels}${series.length > 1 ? legend(series, H - 14) : ''}`);
}

function pieSvg(data, labels, donut, title) {
  const { svg: tSvg, top } = titleBlock(title);
  const vals = data.map((d) => Math.max(0, num(d)));
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const H = 360;
  const cx = 200, cy = top + (H - top) / 2, r = Math.min(130, (H - top) / 2 - 10), rInner = donut ? r * 0.58 : 0;
  let acc = -Math.PI / 2;
  let slices = '';
  let legendItems = '';
  vals.forEach((v, i) => {
    const frac = v / total;
    const a0 = acc, a1 = acc + frac * Math.PI * 2;
    acc = a1;
    const c = PALETTE[i % PALETTE.length];
    if (v <= 0) return;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    if (frac >= 0.999) {
      slices += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}"/>`;
    } else {
      slices += `<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${c}"/>`;
    }
    const ly = top + 20 + i * 22;
    legendItems += `<rect x="380" y="${ly - 10}" width="12" height="12" rx="2" fill="${c}"/><text x="400" y="${ly}" style="${FONT};font-size:12px;fill:#374151">${xesc(truncate(labels[i] || `Item ${i + 1}`, 26))} · ${Math.round(frac * 100)}%</text>`;
  });
  if (donut) slices += `<circle cx="${cx}" cy="${cy}" r="${rInner}" fill="#fff"/>`;
  return wrap(H, `${tSvg}${slices}${legendItems}`);
}

function wrap(h, body) {
  return `<svg viewBox="0 0 ${W} ${h}" width="100%" style="display:block;max-width:100%;height:auto" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${h}" fill="#fff"/>${body}</svg>`;
}

function truncate(s, max) {
  s = String(s);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ── Gantt ─────────────────────────────────────────────────────────────────
//
// GanttTask: { label, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', progress?, color?, group? }
// GanttSpec options: { today?, rowHeight?, barColor? }

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parse YYYY-MM-DD (or anything Date can read) → UTC ms, or null. */
function parseDay(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
const fmtDay = (t) => {
  const d = new Date(t);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.`;
};

/**
 * Render ONE chunk of tasks as a Gantt <svg>. The caller paginates (≤ ~22 rows
 * per chunk) and reuses the same min/max domain across chunks so every page
 * shares one axis. The axis font is fixed and tick density is collision-aware,
 * so dates are always legible.
 */
export function ganttSvg(tasks, domainMin, domainMax, opts = {}) {
  const valid = tasks.filter((t) => parseDay(t?.start) !== null && parseDay(t?.end) !== null);
  if (!valid.length || !Number.isFinite(domainMin) || !Number.isFinite(domainMax) || domainMax <= domainMin) return '';
  const rowH = Math.min(40, Math.max(18, num(opts.rowHeight, 26)));
  const gutter = 180, padR = 16, axisH = 38;
  const plotW = W - gutter - padR;
  const top = axisH + 6;
  const H = top + valid.length * rowH + 10;
  const span = domainMax - domainMin;
  const xFor = (t) => gutter + ((t - domainMin) / span) * plotW;
  const spanDays = span / DAY;

  // ── axis: month band (always) + sub-ticks (day labels if span is short) ──
  let axis = '';
  // month bands
  const start = new Date(domainMin);
  let my = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
  while (my <= domainMax) {
    const next = Date.UTC(new Date(my).getUTCFullYear(), new Date(my).getUTCMonth() + 1, 1);
    const x0 = Math.max(gutter, xFor(my));
    const x1 = Math.min(W - padR, xFor(Math.min(next, domainMax)));
    if (x1 - x0 > 24) {
      const d = new Date(my);
      axis += `<text x="${((x0 + x1) / 2).toFixed(1)}" y="14" text-anchor="middle" style="${FONT};font-size:11px;font-weight:700;fill:#374151">${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}</text>`;
    }
    axis += `<line x1="${xFor(my).toFixed(1)}" y1="20" x2="${xFor(my).toFixed(1)}" y2="${H}" stroke="#e5e7eb" stroke-width="1"/>`;
    my = next;
  }
  // sub-ticks: weekly (Mondays) with dd.mm. labels; collision-aware
  const minLabelPx = 34;
  const weekPx = (7 * DAY / span) * plotW;
  const everyWeeks = Math.max(1, Math.ceil(minLabelPx / Math.max(1, weekPx)));
  if (spanDays <= 400) {
    // first Monday ≥ domainMin
    const d0 = new Date(domainMin);
    const dow = (d0.getUTCDay() + 6) % 7; // 0=Mon
    let wk = domainMin + (dow === 0 ? 0 : (7 - dow)) * DAY;
    let wi = 0;
    for (; wk <= domainMax; wk += 7 * DAY, wi++) {
      const x = xFor(wk);
      axis += `<line x1="${x.toFixed(1)}" y1="${axisH}" x2="${x.toFixed(1)}" y2="${H}" stroke="#f1f5f9" stroke-width="1"/>`;
      if (wi % everyWeeks === 0) axis += `<text x="${x.toFixed(1)}" y="${axisH - 6}" text-anchor="middle" style="${FONT};font-size:9px;fill:#94a3b8">${fmtDay(wk)}</text>`;
    }
  }

  // ── today line ──
  const today = opts.today ? parseDay(opts.today) : null;
  let todayLine = '';
  if (today !== null && today >= domainMin && today <= domainMax) {
    const x = xFor(today);
    todayLine = `<line x1="${x.toFixed(1)}" y1="20" x2="${x.toFixed(1)}" y2="${H}" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  }

  // ── rows ──
  let rows = '';
  valid.forEach((t, i) => {
    const y = top + i * rowH;
    if (i % 2 === 1) rows += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="#f8fafc"/>`;
    const ps = parseDay(t.start), pe = Math.max(parseDay(t.end), ps + DAY);
    const bx = xFor(ps), bw = Math.max(3, xFor(pe) - bx);
    const c = safeColor(t.color, safeColor(opts.barColor, '#2563eb'));
    const barY = y + rowH / 2 - 5;
    rows += `<rect x="${bx.toFixed(1)}" y="${barY}" width="${bw.toFixed(1)}" height="10" rx="3" fill="${c}" opacity="0.32"/>`;
    const prog = Math.max(0, Math.min(100, num(t.progress, 0))) / 100;
    if (prog > 0) rows += `<rect x="${bx.toFixed(1)}" y="${barY}" width="${Math.max(2, bw * prog).toFixed(1)}" height="10" rx="3" fill="${c}"/>`;
    // label in gutter
    rows += `<text x="10" y="${y + rowH / 2 + 3.5}" style="${FONT};font-size:11px;fill:#1f2937">${xesc(truncate(t.label || '', 26))}</text>`;
    // date range label — placed so the dates are NEVER clipped or stacked on the
    // bar: prefer right of the bar; if that overflows the frame, put it in the
    // empty space left of the bar; only a full-width bar falls back to the frame.
    const rangeTxt = `${fmtDay(ps)}–${fmtDay(pe)}`;
    const estW = rangeTxt.length * 4.7;
    const ty = y + rowH / 2 + 3.5;
    if (bx + bw + 5 + estW <= W - padR) {
      rows += `<text x="${(bx + bw + 5).toFixed(1)}" y="${ty}" style="${FONT};font-size:8.5px;fill:#94a3b8">${xesc(rangeTxt)}</text>`;
    } else if (bx - 5 - estW >= gutter) {
      rows += `<text x="${(bx - 5).toFixed(1)}" y="${ty}" text-anchor="end" style="${FONT};font-size:8.5px;fill:#94a3b8">${xesc(rangeTxt)}</text>`;
    } else {
      rows += `<text x="${(W - padR).toFixed(1)}" y="${ty}" text-anchor="end" style="${FONT};font-size:8.5px;fill:#94a3b8">${xesc(rangeTxt)}</text>`;
    }
  });

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;max-width:100%;height:auto;break-inside:avoid" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#fff"/><line x1="${gutter}" y1="${axisH}" x2="${gutter}" y2="${H}" stroke="#cbd5e1" stroke-width="1"/>${axis}${rows}${todayLine}</svg>`;
}

/** Whole-Gantt domain over all tasks (so paginated chunks share one axis). */
export function ganttDomain(tasks) {
  let min = Infinity, max = -Infinity;
  for (const t of tasks) {
    const s = parseDay(t?.start), e = parseDay(t?.end);
    if (s !== null) min = Math.min(min, s);
    if (e !== null) max = Math.max(max, e);
    if (s !== null) max = Math.max(max, s);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    if (Number.isFinite(min) && Number.isFinite(max) && max === min) return { min, max: max + DAY };
    return null;
  }
  // pad 2% each side so end bars aren't flush to the frame
  const pad = (max - min) * 0.02;
  return { min: min - pad, max: max + pad };
}
