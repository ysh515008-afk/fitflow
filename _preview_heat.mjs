/* 验证「门店热度栏取消显示需要手工登记的类目」：
   1) 热度卡片只剩能自己出数的「账号排名」，三项手工类目不再渲染成卡片
   2) 页面不再出现「手工登记」按钮和「未获取」占位
   3) 栏底如实列出被隐藏的是哪三项、各自为什么没有自动来源
   4) 门店热度过期的未读提醒已停用（否则会指向看不见的区域） */

import { readFileSync, writeFileSync } from 'node:fs';

const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });

const store = await import('./js/store.js');
const { computeMetrics } = await import('./js/metrics.js');
const opsView = await import('./js/views/ops.js');
const { STORE_HEAT_ITEMS } = await import('./js/douyin.js');
const { BRIEF_THRESHOLDS } = await import('./js/opsBrief.js');

await store.init();

const mkCtx = (patch = {}) => ({
  state: store.get(),
  metrics: computeMetrics(store.get()),
  _opsSeg: 'content', _contentSub: 'store', _memberSeg: 'list', _memberTab: 'profile',
  _cardFilter: 'attention', _stageTab: 's1', _q: '', _stage: 'all', _openTopic: null, _aiTopic: null,
  _tab: 'ops',
  greeting: () => '早上好',
  funnel: () => store.leadFunnel().map((x) => ({ label: x.label, value: x.value, noConv: x.noConv })),
  weekday: () => '周六',
  ...patch,
});

const html = opsView.render(mkCtx());
const text = html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');

const idx = readFileSync('./index.html', 'utf8');
const sprite = idx.match(/<svg width="0"[\s\S]*?<\/svg>/)[0];
const doc = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>FitFlow · 门店热度（已取消手工登记类目）</title>
<link rel="stylesheet" href="./styles.css">
<style>
  body{margin:0;background:#f4f6f5}
  .pv-bar{position:sticky;top:0;z-index:5;background:#0E8F5B;color:#fff;padding:10px 16px;font-size:13px;font-weight:600}
  .pv-shell{max-width:560px;margin:0 auto;padding:14px 12px 60px}
</style></head>
<body>
<div class="pv-bar">门店热度区：只保留本地可算的「账号排名」，三项需手工登记的类目已取消显示</div>
<div class="pv-shell">${html}</div>
${sprite}
</body></html>`;

writeFileSync('./preview-heat.html', doc, 'utf8');

/* ---------- 冒烟 ---------- */
let fail = 0;
const must = (c, m) => { if (!c) { fail++; console.log('FAIL ' + m); } else console.log('OK   ' + m); };

for (const [name, re] of [['undefined', /undefined/], ['NaN', /NaN/], ['[object Object]', /\[object Object\]/]]) {
  if (re.test(text)) { fail++; console.log('FAIL 门店热度区出现 ' + name); }
}
if (/[\u2014]/.test(text)) { fail++; console.log('FAIL 门店热度区出现 em-dash'); }

/* 卡片数量：manualOnly 的三项不进卡片列表，只剩账号排名 */
const cards = html.match(/class="card heat-card"/g) || [];
must(cards.length === 1, `热度卡片只剩 1 张（实际 ${cards.length}）`);
const manualKeys = STORE_HEAT_ITEMS.filter((it) => it.manualOnly).map((it) => it.key);
const autoKeys = STORE_HEAT_ITEMS.filter((it) => !it.manualOnly).map((it) => it.key);
must(manualKeys.length === 3 && autoKeys.length === 1, `数据源标记：${autoKeys.length} 项自动 / ${manualKeys.length} 项手工`);

/* 手工类目的标题不再作为卡片出现（栏底说明里会点名，那是另一回事） */
must(!/data-heat=/.test(html), '页面不再有「手工登记」按钮入口');
must(!/手工登记<\/button>/.test(html), '按钮文案「手工登记」不再出现');
must(!/heat-num num miss/.test(html), '不再出现「未获取」占位（这是取消显示的直接原因）');
must(/账号排名/.test(html), '保留本地可算的「账号排名」');
must(/自有账号池排名/.test(html), '排名明细区仍在');

/* 栏底说明：点名三项 + 各自原因 */
must(/已不显示的类目 · 3 项/.test(html), '栏底写明已不显示 3 项');
for (const it of STORE_HEAT_ITEMS.filter((x) => x.manualOnly)) {
  must(html.includes(it.label), `栏底点名被隐藏项：${it.label}`);
}
must(/接口没有这一项，只能手工登记/.test(html), '说明区分「接口没有这一项」');
must(/只能靠关键词近似召回/.test(html), '说明区分「关键词近似召回」的局限');

/* 口径没有被偷偷改：三项的取数依据仍在数据源里 */
const src = readFileSync('./js/douyin.js', 'utf8');
must(/manualOnly: true/.test(src), '数据源里保留了 manualOnly 标记（口径未删）');
must(/basis:/.test(src), '三项的取数依据（basis）仍在数据源里');

/* 未读提醒：门店热度过期提醒已停用，不再指向看不见的区域 */
const briefSrc = readFileSync('./js/opsBrief.js', 'utf8');
must(!/^\s*items\.push\(\{\s*$/m.test(briefSrc.split('advice:store-heat-stale')[1] || '') || !/id: 'advice:store-heat-stale'/.test(briefSrc.replace(/\/\/.*/g, '')),
  '门店热度过期提醒已停用（源码里不再有生效的 push）');
must(BRIEF_THRESHOLDS.storeHeatStaleDays === 30, '阈值保留未删（恢复显示时可复用）');

console.log(fail ? `\n预览失败：${fail} 项` : '\n预览生成成功 → preview-heat.html');
process.exit(fail ? 1 : 0);
