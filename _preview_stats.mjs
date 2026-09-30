/* 客户管理端「统计」栏预览 + 渲染冒烟：
   渲染 views/members.js 的 stats 子集（门店大盘：KPI / 趋势折线 / 环比 / 个人 vs 门店 / 结构分布）。
   冒烟：undefined / NaN / [object Object] / 用户可见文案出现 em-dash。 */

import { readFileSync, writeFileSync } from 'node:fs';

const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });

const store = await import('./js/store.js');
const { computeMetrics } = await import('./js/metrics.js');
const membersView = await import('./js/views/members.js');

await store.init();
const state = store.get();

const ctx = {
  state,
  metrics: computeMetrics(state),
  _opsSeg: 'content', _contentSub: 'douyin', _memberSeg: 'stats', _memberTab: 'profile',
  _cardFilter: 'attention', _stageTab: 's1', _q: '', _stage: 'all', _openTopic: null, _aiTopic: null,
  _tab: 'members',
  greeting: () => '早上好',
  funnel: () => store.leadFunnel().map((x) => ({ label: x.label, value: x.value, noConv: x.noConv })),
  weekday: () => '周六',
};

const html = membersView.render(ctx);
const idx = readFileSync('./index.html', 'utf8');
const sprite = idx.match(/<svg width="0"[\s\S]*?<\/svg>/)[0];

const doc = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>FitFlow · 门店大盘统计预览</title>
<link rel="stylesheet" href="./styles.css">
<style>
  body{margin:0;background:#f4f6f5}
  .pv-bar{position:sticky;top:0;z-index:5;background:#0E8F5B;color:#fff;padding:10px 16px;font-size:13px;font-weight:600}
  .pv-shell{max-width:1500px;margin:0 auto;padding:0 10px}
</style></head>
<body>
<div class="pv-bar">FitFlow · 客户管理端「统计」栏 · 门店大盘（只读预览）</div>
<div class="pv-shell">${html}</div>
${sprite}
</body></html>`;

writeFileSync('./preview-stats.html', doc, 'utf8');

/* ---------- 冒烟 ---------- */
const vis = doc.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ');
let fail = 0;
const must = (c, m) => { if (!c) { fail++; console.log('FAIL ' + m); } else console.log('OK   ' + m); };

for (const [name, re] of [['undefined', /undefined/], ['NaN', /NaN/], ['[object Object]', /\[object Object\]/]]) {
  if (re.test(vis)) { fail++; console.log('FAIL 出现 ' + name); }
}
if (/[\u2014]/.test(vis)) { fail++; console.log('FAIL 用户可见文案出现 em-dash'); }

must(/门店大盘/.test(html), '含「门店大盘」KPI 区');
must(/趋势 · 近 6 个月/.test(html), '含趋势区标题');
must((html.match(/<svg viewBox="0 0 600 190"/g) || []).length === 3, '渲染出 3 张折线图');
must((html.match(/<polyline/g) || []).length === 6, '每张图 2 条折线（门店 + 个人）共 6 条');
must(/本月 vs 上月/.test(html), '含环比区');
must(/个人 vs 门店/.test(html), '含对比区');
must(/结构分布/.test(html), '含结构分布区');
must(/平均客单价/.test(html) && /累计成交额/.test(html), '含成交额与客单价指标');
must(/ deg|NaN/.test(html) === false, '无非法数值');

console.log(fail ? `\n预览失败：${fail} 项` : '\n预览生成成功 → preview-stats.html');
process.exit(fail ? 1 : 0);
