/* ============================================================
   bizMetrics.js · 交易后台指标口径
   ------------------------------------------------------------
   抖音来客和美团经营宝的后台报表，列名不一样，但口径能对齐成同一条漏斗：

     曝光人数 → 页面访问 → 开口人数 → 下单人数 → 核销人数

   对齐了才能做两件事：
     1. 两个平台并排看，知道钱该往哪边挪
     2. 和FitFlow 自己的线索池接上，看"平台开口"到"真实到店"漏在哪一环

   一条硬规则：**没给的字段就是 null，不补 0。**
   后台报表漏了"核销"一列是常事，补 0 会让核销率显示成 0%，
   运营会以为到店全没了，实际只是没导这一列。这两件事必须能分开。
   ============================================================ */
import { parseTable, toDateStr } from './util.js';

const isNum = (v) => typeof v === 'number' && isFinite(v);

/**
 * 漏斗指标表。
 * aliases 覆盖两个平台后台导出的常见列名写法，按"先长后短"的顺序匹配，
 * 否则「下单人数」会被「人数」这种短别名先抢走。
 */
export const BIZ_METRIC_FIELDS = [
  {
    key: 'impression',
    label: '曝光人数',
    unit: '人',
    aliases: ['商品曝光人数', '内容曝光人数', '曝光人数', '曝光人次', '展现量', '曝光量', '曝光'],
    note: '内容和商品被看到的去重人数，两个平台口径基本一致',
  },
  {
    key: 'visit',
    label: '页面访问',
    unit: '人',
    aliases: ['店铺访问人数', '页面访问人数', '门店访问人数', '访问人数', '浏览人数', '访客数', '访问量', '访问'],
    note: '进到店铺页 / 商品页的人数，是曝光之后的第一个动作',
  },
  {
    key: 'open',
    label: '开口人数',
    unit: '人',
    aliases: ['私信开口人数', '咨询人数', '会话人数', '开口人数', '开口数', '咨询数', '会话数', '开口',
      '预约人数', '客资数', '留资人数', '预约客资数', 'bookUv'],
    /*
     * 两个平台在这一环的口径不一样，别名收在一起但要说清差异：
     *   抖音来客 = 私信开口人数（用户主动发私信的会话数）
     *   美团     = 预约人数 / 客资数（接口字段 bookUv，留了联系方式的人）
     * 两者都是「最接近意向线索的一环」，但不是同一个动作，
     * 所以跨平台比这条数时要留意，别当成同一件事直接相加。
     */
    note: '抖音来客叫私信开口，美团叫预约客资数。这是最接近"意向线索"的一环，但两平台口径不同，别直接相加',
  },
  {
    key: 'order',
    label: '下单人数',
    unit: '人',
    aliases: ['团购下单人数', '支付人数', '成交人数', '下单人数', '下单数', '订单数', '下单'],
    note: '在平台上完成支付的人数，不等于到店',
  },
  {
    key: 'redeem',
    label: '核销人数',
    unit: '人',
    aliases: ['到店核销人数', '核销人数', '核销数', '核销量', '已核销', '核销'],
    note: '真正到店消费的人数。下单到核销之间的落差就是"买了不来"',
  },
  {
    key: 'spend',
    label: '投放消耗',
    unit: '元',
    aliases: ['推广消耗', '投放消耗', '消耗金额', '消耗', '花费', '支出'],
    note: '平台内推广花费，用来算单开口成本',
  },
];

export const BIZ_METRIC_LABEL = Object.fromEntries(BIZ_METRIC_FIELDS.map((f) => [f.key, f.label]));

/** 漏斗顺序，视图和简报共用，避免两处顺序写反 */
export const FUNNEL_ORDER = ['impression', 'visit', 'open', 'order', 'redeem'];

/* ---------------- 解析 ---------------- */

/** 去掉千分位、货币符号、单位后缀（人 / 次 / 元 / %），把"1.2万"还原成 12000 */
export function toMetricNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s || /^[-—–]+$/.test(s)) return null;
  const isPct = s.includes('%');
  s = s.replace(/[,，¥￥\s]/g, '').replace(/(人|人次|次|元|笔|单|个)$/g, '');
  const m = s.match(/^(-?[\d.]+)(万|亿|w|W|k|K)?/);
  if (!m) return null;
  const base = parseFloat(m[1]);
  if (isNaN(base)) return null;
  const mul = m[2] === '亿' ? 1e8
    : (m[2] === '万' || m[2] === 'w' || m[2] === 'W') ? 1e4
      : (m[2] === 'k' || m[2] === 'K') ? 1e3 : 1;
  const n = base * mul;
  /* 百分比列（如转化率）不是我们要的口径，统一返回 null，别混进人数里 */
  return isPct ? null : Math.round(n * 100) / 100;
}

/** 后台导出的日期写法很杂，这几种都要能认出来 */
export function normalizeReportDate(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (m) return toDateStr(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  m = s.match(/^(\d{1,2})[-/月.](\d{1,2})/);
  if (m) return toDateStr(new Date(new Date().getFullYear(), Number(m[1]) - 1, Number(m[2])));
  return null;
}

const DATE_ALIASES = ['统计日期', '数据日期', '日期', '时间', 'date'];

export function findDateColumn(headers) {
  const norm = headers.map((h) => String(h).toLowerCase().replace(/\s/g, ''));
  const idx = norm.findIndex((h) => DATE_ALIASES.some((a) => h.includes(a)));
  return idx > -1 ? idx : null;
}

/**
 * 表头 → 指标字段。
 * 按 aliases 从长到短匹配，让「下单人数」优先于「数量」这类短词命中。
 */
export function guessMetricColumns(headers) {
  const norm = headers.map((h) => String(h).toLowerCase().replace(/[\s()（）]/g, ''));
  const out = {};
  const used = new Set();

  const pairs = [];
  BIZ_METRIC_FIELDS.forEach((f) => f.aliases.forEach((a, i) => pairs.push({ key: f.key, alias: a.toLowerCase(), prio: i })));
  pairs.sort((a, b) => b.alias.length - a.alias.length || a.prio - b.prio);

  pairs.forEach(({ key, alias }) => {
    if (out[key] != null) return;
    const i = norm.findIndex((h, idx) => !used.has(idx) && h.includes(alias));
    if (i > -1) { out[key] = i; used.add(i); }
  });
  return out;
}

/**
 * 把粘贴进来的后台报表转成结构化记录。
 * 有日期列时，读不出日期的行会被丢掉 —— 那种行通常是"合计"行，
 * 混进来会把整段时间的数字重复计一遍。
 */
export function parseBizReport(text, { sourceId, fallbackDate }) {
  const { headers, rows } = parseTable(text);
  if (!headers.length) {
    return { headers, rows: [], rowsPreview: [], records: [], map: {}, dateCol: null, skipped: 0, unmatched: [] };
  }

  const map = guessMetricColumns(headers);
  const dateCol = findDateColumn(headers);
  const records = [];
  let skipped = 0;

  rows.forEach((r) => {
    let date = fallbackDate;
    if (dateCol != null) {
      const dv = normalizeReportDate(r[dateCol]);
      if (!dv) { skipped++; return; }
      date = dv;
    }
    const rec = { source: sourceId, date };
    let hit = false;
    Object.entries(map).forEach(([key, i]) => {
      const n = toMetricNumber(r[i]);
      if (n != null) { rec[key] = n; hit = true; }
    });
    if (hit) records.push(rec);
    else skipped++;
  });

  const matchedIdx = new Set([...Object.values(map), ...(dateCol != null ? [dateCol] : [])]);
  const unmatched = headers.filter((_, i) => !matchedIdx.has(i));

  return { headers, rows, rowsPreview: rows.slice(0, 5), records, map, dateCol, skipped, unmatched };
}

/** 解析结果里一个指标都没匹配上，界面要提示用户改列名而不是静默导入 */
export const hasNoMetricMatch = (parsed) => Object.keys(parsed.map || {}).length === 0;

/* ---------------- 派生 ---------------- */

/** 一条记录的漏斗与各环转化率。上一环没数就不给比率，不给 0 */
export function bizFunnel(rec) {
  const out = [];
  for (let i = 0; i < FUNNEL_ORDER.length; i++) {
    const key = FUNNEL_ORDER[i];
    const field = BIZ_METRIC_FIELDS.find((f) => f.key === key);
    const value = isNum(rec?.[key]) ? rec[key] : null;
    const prevKey = FUNNEL_ORDER[i - 1];
    const prev = prevKey ? rec?.[prevKey] : null;
    const rate = (isNum(prev) && prev > 0 && isNum(value)) ? value / prev : null;
    out.push({ key, label: field.label, unit: field.unit, value, rate });
  }
  return out;
}

/** 单开口成本。开口为 0 或没有消耗时返回 null，不返回 Infinity */
export function costPerOpen(rec) {
  if (!isNum(rec?.spend) || !isNum(rec?.open) || rec.open <= 0) return null;
  return Math.round((rec.spend / rec.open) * 100) / 100;
}

/** 下单到核销的落差，用于回答"买了不来" */
export function redeemGap(rec) {
  if (!isNum(rec?.order) || !isNum(rec?.redeem)) return null;
  return rec.order - rec.redeem;
}

/** 把多天记录按指标求和。某天缺某列时不计入，也不当 0 */
export function sumBizRecords(records) {
  const out = {};
  BIZ_METRIC_FIELDS.forEach((f) => {
    const vals = records.map((r) => r[f.key]).filter(isNum);
    if (!vals.length) return;
    out[f.key] = Math.round(vals.reduce((s, x) => s + x, 0) * 100) / 100;
    out[`${f.key}__days`] = vals.length;
  });
  return out;
}

/** 指标在某段时间内覆盖了几天，界面用它说明"这个合计不含缺失的列" */
export function metricDayCount(records, key) {
  return records.filter((r) => isNum(r[key])).length;
}

/** 按来源分组并按日期倒序，视图直接用 */
export function groupBySource(records) {
  const g = {};
  (records || []).forEach((r) => { (g[r.source] = g[r.source] || []).push(r); });
  Object.values(g).forEach((arr) => arr.sort((a, b) => (a.date < b.date ? 1 : -1)));
  return g;
}

/**
 * 把同一天多条记录合并成一条（各指标求和）。
 *
 * 为什么必须做这一步：后台导出的明细常常是一天多行（分渠道 / 分商品 / 分时段）。
 * 直接落库的话，同一天会存成好几条，漏斗把首条当全部，数字会少一大截。
 *
 * 求和只累加"确实给了值"的行，某行缺某列时不计入，也不按 0 拉低。
 * 注意口径：分商品明细求和是对的；分时段明细求和会重复计曝光，
 * 那种表要先在后台按日汇总再导。界面在预览里会提醒这一点。
 */
export function collapseByDate(records) {
  const byDate = new Map();
  (records || []).forEach((r) => {
    if (!byDate.has(r.date)) {
      byDate.set(r.date, { source: r.source, date: r.date });
    }
    const acc = byDate.get(r.date);
    BIZ_METRIC_FIELDS.forEach((f) => {
      const v = r[f.key];
      if (!isNum(v)) return;
      acc[f.key] = Math.round(((acc[f.key] || 0) + v) * 100) / 100;
    });
  });
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}
