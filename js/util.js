/* ============================================================
   util.js · 日期 / 数字 / 字符串 工具
   ============================================================ */

export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

export const pad = (n) => String(n).padStart(2, '0');

export function toDateStr(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

export const today = () => toDateStr(new Date());

/** 相对今天偏移 n 天，返回 YYYY-MM-DD */
export function d(offset = 0) {
  const x = new Date();
  x.setHours(12, 0, 0, 0);
  x.setDate(x.getDate() + offset);
  return toDateStr(x);
}

export function nowISO() {
  return new Date().toISOString();
}

export function parseDate(s) {
  if (!s) return null;
  const x = new Date(String(s).length <= 10 ? s + 'T12:00:00' : s);
  return isNaN(x.getTime()) ? null : x;
}

/** b - a，单位天 */
export function daysBetween(a, b = today()) {
  const x = parseDate(a), y = parseDate(b);
  if (!x || !y) return null;
  return Math.round((y - x) / 86400000);
}

export function addDays(dateStr, n) {
  const x = parseDate(dateStr) || new Date();
  x.setDate(x.getDate() + n);
  return toDateStr(x);
}

/** 返回 YYYY-MM 月份偏移结果。dateStr 只取年月部分参与计算，
 *  传入 '2026-09' 这类纯年月串也能正确处理（parseDate 兜底到月初）。 */
export function addMonths(dateStr, n) {
  const x = parseDate(dateStr) || new Date();
  x.setDate(1);
  x.setMonth(x.getMonth() + n);
  return toDateStr(x).slice(0, 7);
}

/**
 * 返回包含 dateStr 那一星期的周一（YYYY-MM-DD）。
 * 全站日历统一周一起始，所以任何月视图网格都先拿这一天的偏移量算前导空格。
 */
export function mondayOf(dateStr) {
  const x = parseDate(dateStr);
  if (!x) return null;
  const diff = (x.getDay() + 6) % 7; // 周日=0 -> 6；周一=1 -> 0
  return addDays(toDateStr(x), -diff);
}

/** 相对今天的自然语言描述 */
export function relDay(dateStr) {
  const n = daysBetween(today(), dateStr);
  if (n === null) return '';
  if (n === 0) return '今天';
  if (n === 1) return '明天';
  if (n === 2) return '后天';
  if (n === -1) return '昨天';
  if (n > 0) return `${n}天后`;
  return `${-n}天前`;
}

export function fmtDate(dateStr, style = 'md') {
  const x = parseDate(dateStr);
  if (!x) return '-';
  const y = x.getFullYear(), m = x.getMonth() + 1, day = x.getDate();
  if (style === 'md') return `${m}月${day}日`;
  if (style === 'mmdd') return `${pad(m)}-${pad(day)}`;
  if (style === 'full') return `${y}年${m}月${day}日`;
  if (style === 'ymd') return `${y}-${pad(m)}-${pad(day)}`;
  return `${m}月${day}日`;
}

export function weekday(dateStr) {
  const x = parseDate(dateStr);
  if (!x) return '';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][x.getDay()];
}

export const fmtMoney = (n, opt = {}) => {
  const v = Number(n) || 0;
  const s = Math.abs(v) >= 10000
    ? (v / 10000).toFixed(opt.d ?? 1).replace(/\.0$/, '') + '万'
    : Math.round(v).toLocaleString('zh-CN');
  return '¥' + s;
};

export const moneyFull = (n) => '¥' + (Number(n) || 0).toLocaleString('zh-CN');

export const fmtPct = (n, digits = 0) => {
  const v = Number(n);
  if (!isFinite(v)) return '-';
  return (v * 100).toFixed(digits) + '%';
};

export const ratio = (a, b) => (b ? a / b : 0);

export const sum = (arr, fn = (x) => x) => arr.reduce((s, x) => s + (Number(fn(x)) || 0), 0);
export const avg = (arr, fn = (x) => x) => (arr.length ? sum(arr, fn) / arr.length : 0);

export function groupBy(arr, keyFn) {
  return arr.reduce((acc, item) => {
    const k = keyFn(item);
    (acc[k] = acc[k] || []).push(item);
    return acc;
  }, {});
}

export function countBy(arr, keyFn) {
  return arr.reduce((acc, item) => {
    const k = keyFn(item);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

export const sortBy = (arr, fn, dir = 'desc') =>
  [...arr].sort((a, b) => {
    const x = fn(a), y = fn(b);
    if (x === y) return 0;
    const r = x > y ? 1 : -1;
    return dir === 'desc' ? -r : r;
  });

export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const initial = (name) => (String(name || '?').trim()[0] || '?');

const AV_CLASSES = ['av-a', 'av-b', 'av-c', 'av-d', 'av-e', 'av-f'];
export function avClass(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
  return AV_CLASSES[h % AV_CLASSES.length];
}

export function avatarHtml(name, cls = '') {
  const c = cls || avClass(name);
  return `<div class="avatar ${c}">${esc(initial(name))}</div>`;
}

export function debounce(fn, ms = 220) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function downloadFile(filename, content, type = 'application/json') {
  const blob = new Blob([content], { type: type + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** 容错 CSV / TSV 解析：自动识别分隔符，处理引号 */
export function parseTable(text) {
  const raw = String(text || '').trim();
  if (!raw) return { headers: [], rows: [] };
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const delim = (lines[0].match(/\t/g) || []).length >= (lines[0].match(/,/g) || []).length ? '\t' : ',';
  const split = (line) => {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const headers = split(lines[0]);
  const rows = lines.slice(1).map(split).filter((r) => r.some((c) => c !== ''));
  return { headers, rows };
}

export const pick = (obj, keys) => keys.map((k) => obj[k]).find((v) => v !== undefined && v !== '');

/* ---------------- 数值小工具 ----------------
   抖音与小红书两栏都要用，所以放在这里共用一份。
   isNum 只认有限数：NaN / Infinity / 字符串一律不算数，
   否则"未获取"会被当成 0 参与计算，指标直接失真。 */
export const isNum = (v) => typeof v === 'number' && isFinite(v);
export const round1 = (n) => (isNum(n) ? Math.round(n * 10) / 10 : null);
export const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
export const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** 数字压成中文习惯的紧凑写法（12800 → 1.3万）。算不出就回「未获取」，不回 0 */
export const compact = (n) => {
  if (!isNum(n)) return '未获取';
  return Math.abs(n) >= 10000
    ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万'
    : Math.round(n).toLocaleString('zh-CN');
};
