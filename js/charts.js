/* ============================================================
   charts.js · 纯 SVG 图表（不依赖任何外部库 / CDN）
   全部返回字符串，直接插进 innerHTML
   ============================================================ */

const INK = '#0F1A17';
const MUTED = '#6B7B74';
const FAINT = '#9BA8A1';
const GRID = '#E4EBE6';
const BRAND = '#0E8F5B';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- 柱状图 ---------------- */
export function barChart({ items, height = 150, color = BRAND, minColor = '#BBD9C9', highlight = -1, unit = '', digits = 0 }) {
  const W = 340, H = height, padT = 16, padB = 24, padX = 6;
  const n = Math.max(items.length, 1);
  const slot = (W - padX * 2) / n;
  const bw = Math.min(30, slot * 0.56);
  const max = Math.max(...items.map((i) => i.value), 1);
  const plotH = H - padT - padB;

  const bars = items.map((it, i) => {
    const h = Math.max(3, (it.value / max) * plotH);
    const x = padX + slot * i + (slot - bw) / 2;
    const y = padT + plotH - h;
    const c = i === highlight ? color : minColor;
    const showVal = it.value > 0 && slot > 32;
    return `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${c}"/>
      ${showVal ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="9.5" font-weight="700" fill="${INK}" text-anchor="middle">${it.value.toFixed(digits)}</text>` : ''}
      <text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" font-size="9.5" fill="${MUTED}" text-anchor="middle">${esc(it.label)}</text>`;
  }).join('');

  const gridLines = [0.25, 0.5, 0.75, 1].map((p) =>
    `<line x1="${padX}" x2="${W - padX}" y1="${(padT + plotH * (1 - p)).toFixed(1)}" y2="${(padT + plotH * (1 - p)).toFixed(1)}" stroke="${GRID}" stroke-width="1" stroke-dasharray="3 4"/>`
  ).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="柱状图">${gridLines}${bars}</svg>`;
}

/* ---------------- 折线 / 面积图 ---------------- */
export function lineChart({ points, height = 150, color = BRAND, formatter = (v) => v, showDots = true }) {
  const W = 340, H = height, padT = 20, padB = 24, padX = 10;
  const n = Math.max(points.length, 1);
  const max = Math.max(...points.map((p) => p.value), 1);
  const min = Math.min(...points.map((p) => p.value), 0);
  const span = max - min || 1;
  const plotH = H - padT - padB;
  const stepX = n > 1 ? (W - padX * 2) / (n - 1) : 0;

  const xy = points.map((p, i) => {
    const x = padX + stepX * i;
    const y = padT + plotH * (1 - (p.value - min) / span);
    return [x, y];
  });

  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${xy[xy.length - 1][0].toFixed(1)},${(padT + plotH).toFixed(1)} L${xy[0][0].toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
  const gid = 'g' + Math.random().toString(36).slice(2, 7);

  const dots = showDots ? xy.map(([x, y], i) => {
    const last = i === xy.length - 1;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${last ? 4 : 2.6}" fill="#fff" stroke="${color}" stroke-width="${last ? 2.4 : 1.8}"/>
      ${last ? `<text x="${x.toFixed(1)}" y="${(y - 10).toFixed(1)}" font-size="10" font-weight="700" fill="${INK}" text-anchor="middle">${esc(formatter(points[i].value))}</text>` : ''}`;
  }).join('') : '';

  const labels = points.map((p, i) =>
    `<text x="${xy[i][0].toFixed(1)}" y="${H - 8}" font-size="9.5" fill="${MUTED}" text-anchor="middle">${esc(p.label)}</text>`
  ).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="趋势图">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <line x1="${padX}" x2="${W - padX}" y1="${padT + plotH}" y2="${padT + plotH}" stroke="${GRID}" stroke-width="1"/>
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}${labels}
  </svg>`;
}

/* ---------------- 环形图 ---------------- */
export function donutChart({ items, size = 148, thickness = 17, centerLabel = '', centerValue = '' }) {
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  const r = (size - thickness) / 2;
  const cx = size / 2, cy = size / 2;
  const C = 2 * Math.PI * r;
  let offset = 0;

  const arcs = items.map((it) => {
    const frac = it.value / total;
    const len = frac * C;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${it.color}" stroke-width="${thickness}"
      stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
      transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt"/>`;
    offset += len;
    return seg;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${size} ${size}" style="max-width:${size}px;margin:0 auto" role="img" aria-label="环形图">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${GRID}" stroke-width="${thickness}"/>
    ${arcs}
    <text x="${cx}" y="${cy - 2}" font-size="19" font-weight="750" fill="${INK}" text-anchor="middle">${esc(centerValue)}</text>
    <text x="${cx}" y="${cy + 15}" font-size="10" fill="${MUTED}" text-anchor="middle">${esc(centerLabel)}</text>
  </svg>`;
}

/* ---------------- 能力雷达 ---------------- */
export function radarChart({ axes, size = 260, max = 5, color = BRAND }) {
  const cx = size / 2, cy = size / 2 + 4;
  const R = size / 2 - 42;
  const n = axes.length;
  const pt = (i, v) => {
    const ang = (Math.PI * 2 * i) / n - Math.PI / 2;
    const rr = (v / max) * R;
    return [cx + rr * Math.cos(ang), cy + rr * Math.sin(ang)];
  };

  const rings = [0.25, 0.5, 0.75, 1].map((p) => {
    const pts = axes.map((_, i) => pt(i, max * p).map((v) => v.toFixed(1)).join(',')).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="${GRID}" stroke-width="1"/>`;
  }).join('');

  const spokes = axes.map((a, i) => {
    const [x, y] = pt(i, max);
    const [lx, ly] = pt(i, max * 1.24);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>
      <text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" font-size="10" fill="${MUTED}" text-anchor="middle">${esc(a.name)}</text>`;
  }).join('');

  const shape = axes.map((a, i) => pt(i, a.value).map((v) => v.toFixed(1)).join(',')).join(' ');
  const dots = axes.map((a, i) => { const [x, y] = pt(i, a.value); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#fff" stroke="${color}" stroke-width="2"/>`; }).join('');

  return `<svg class="chart" viewBox="0 0 ${size} ${size}" style="max-width:${size}px;margin:0 auto" role="img" aria-label="能力雷达">
    ${rings}${spokes}
    <polygon points="${shape}" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
}

/* ---------------- 环进度 ---------------- */
export function progressRing({ value, size = 104, stroke = 9, color = BRAND, label = '', display = null }) {
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  const dash = (v * C).toFixed(2);
  const txt = display != null ? display : Math.round(v * 100) + '%';
  return `<div class="ring-wrap" style="width:${size}px;height:${size}px">
    <svg class="chart" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${GRID}" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${dash} ${(C - Number(dash)).toFixed(2)}"
        transform="rotate(-90 ${size / 2} ${size / 2})"/>
    </svg>
    <div class="ring-label"><b>${esc(txt)}</b>${label ? `<span>${esc(label)}</span>` : ''}</div>
  </div>`;
}

/* ---------------- 迷你趋势 ---------------- */
export function sparkline({ values, w = 76, h = 26, color = BRAND }) {
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/* ---------------- 漏斗（HTML 实现，响应式更好） ---------------- */
export function funnelHtml(steps) {
  const max = Math.max(...steps.map((s) => s.value), 1);
  return `<div class="funnel">${steps.map((s, i) => {
    const w = Math.max((s.value / max) * 100, 6);
    const prev = i > 0 ? steps[i - 1].value : null;
    /* 相邻两层数据口径不同时（实时明细 vs 本月汇总）不算转化率，
       硬算会冒出 750% 这种让人误读的数字 */
    const conv = prev && !s.noConv ? s.value / prev : null;
    return `<div class="fn-row">
      <div class="fn-label">${esc(s.label)}</div>
      <div class="fn-bar-wrap">
        <div class="fn-bar" style="width:${w.toFixed(1)}%"></div>
        ${conv != null ? `<span class="fn-conv">${(conv * 100).toFixed(0)}%</span>` : ''}
      </div>
      <div class="fn-value num">${s.value >= 10000 ? (s.value / 10000).toFixed(1) + '万' : s.value}</div>
    </div>`;
  }).join('')}</div>`;
}
