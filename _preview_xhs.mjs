/* 小红书子集预览：
   1) 线上营销的二级分段里出现「小红书」，且能渲染出内容
   2) 账号卡标「登记值」（接口取不到，不能冒充同步结果）
   3) 三项能力逐项标明：账号维度=接口未提供，搜索/爆款库=未接线
   4) 笔记台账出数据、爆款按自身均值 3 倍标出、缺字段显示「未获取」 */

import { readFileSync, writeFileSync } from 'node:fs';

const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });

const store = await import('./js/store.js');
const { computeMetrics } = await import('./js/metrics.js');
const opsView = await import('./js/views/ops.js');
const { XHS_CAPABILITY_ITEMS, deriveXhsSummary } = await import('./js/xhs.js');
const { isFeatureOn } = await import('./js/features.js');

await store.init();

const state = store.get();
const mkCtx = (patch = {}) => ({
  state,
  metrics: computeMetrics(state),
  _opsSeg: 'content', _contentSub: 'xhs', _memberSeg: 'list', _memberTab: 'profile',
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
<html lang="zh-CN"><head><meta charset="utf-8"><title>FitFlow · 线上营销 · 小红书</title>
<link rel="stylesheet" href="./styles.css">
<style>
  body{margin:0;background:#f4f6f5}
  .pv-bar{position:sticky;top:0;z-index:5;background:#0E8F5B;color:#fff;padding:10px 16px;font-size:13px;font-weight:600}
  .pv-shell{max-width:560px;margin:0 auto;padding:14px 12px 60px}
</style></head>
<body>
<div class="pv-bar">线上营销 · 小红书（账号维度为登记值，搜索与爆款库未接线）</div>
<div class="pv-shell">${html}</div>
${sprite}
</body></html>`;

writeFileSync('./preview-xhs.html', doc, 'utf8');

/* ---------- 冒烟 ---------- */
let fail = 0;
const must = (c, m) => { if (!c) { fail++; console.log('FAIL ' + m); } else console.log('OK   ' + m); };

for (const [name, re] of [['undefined', /undefined/], ['NaN', /NaN/], ['[object Object]', /\[object Object\]/]]) {
  if (re.test(text)) { fail++; console.log('FAIL 小红书栏出现 ' + name); }
}
if (/[\u2014]/.test(text)) { fail++; console.log('FAIL 小红书栏出现 em-dash'); }

/* 分段 */
must(isFeatureOn(state.features, 'ops.xhs'), '功能开关 ops.xhs 默认开启');
must(/data-csub="xhs"/.test(html), '二级分段里出现「小红书」');
must(/小红书/.test(html), '页面标题/分段含小红书');

/* 账号卡：必须标明是登记值 */
must(/登记值/.test(html), '账号数字标「登记值」（不冒充接口返回）');
must(/力健健身·金融城店/.test(html), '账号卡渲染出昵称');
must(/3,260/.test(html) || /3260/.test(html), '粉丝数按登记值显示 3260');
must(/data-xhs-bind/.test(html), '有「修改登记 / 登记小红书号」按钮');

/* 三项能力逐项标明 */
for (const it of XHS_CAPABILITY_ITEMS) {
  must(html.includes(it.label), `能力清单含：${it.label}`);
}
must(/接口未提供/.test(html), '账号维度标「接口未提供」');
must(/未接线/.test(html), '搜索与爆款笔记库标「未接线」');
must(/红狐当前没有该接口/.test(html), '写明依据：红狐当前没有该接口');
must(/endpointSpec 里目前全是抖音端点/.test(html) || /端点/.test(html), '写明未接线原因：端点未登记');

/* 笔记台账 */
const rows = html.match(/class="work-row"/g) || [];
must(rows.length === 6, `笔记台账出 6 行（实际 ${rows.length}）`);
must(/阅读/.test(html) && /藏/.test(html) && /线索/.test(html), '笔记行含阅读 / 赞 / 藏 / 评 / 线索');
must(/爆款/.test(html), '标出爆款（阅读超均值 3 倍）');
must(/data-xhs-edit/.test(html), '笔记行可点开修改');
must(/data-xhs-note/.test(html), '有「登记一条笔记」按钮');

/* 派生口径正确性：拿同一批数据算一遍对得上 */
const sum = deriveXhsSummary(state.xhs.notes);
must(sum.noteCount === 6, `汇总笔记数 = 6（实际 ${sum.noteCount}）`);
must(sum.readSample === 6, '6 条都有阅读数');
const reads = state.xhs.notes.map((n) => n.readCount);
const avg = reads.reduce((a, b) => a + b, 0) / reads.length;
must(sum.avgRead === Math.round(avg), `平均阅读 = ${Math.round(avg)}（实际 ${sum.avgRead}）`);
must(sum.hitRate === reads.filter((r) => r > avg * 3).length / reads.length, '爆款率按同一条线算（超过均值 3 倍）');
/* seed 里 6 条的发布日分别是 3 / 9 / 16 / 23 / 31 / 42 天前，落在近 30 天里的是 4 条 */
must(sum.recent30 === 4, `近 30 天发布 = 4（实际 ${sum.recent30}）`);
must(sum.leads === 26, `线索合计 = 26（实际 ${sum.leads}）`);

/* 缺字段不能显示成 0：给一条只有标题的笔记，平均阅读应仍由有数的那几条算 */
store.upsertXhsNote({ title: '只登记了标题的笔记', publishedAt: '2026-09-20' });
const sum2 = deriveXhsSummary(store.get().xhs.notes);
must(sum2.noteCount === 7 && sum2.readSample === 6, '缺数字的笔记计入条数，但不污染阅读样本');
must(sum2.avgRead === Math.round(avg), '平均阅读不受缺字段那条影响');
store.deleteXhsNote(store.get().xhs.notes.find((n) => n.title === '只登记了标题的笔记').id);

console.log(fail ? `\n预览失败：${fail} 项` : '\n预览生成成功 → preview-xhs.html');
process.exit(fail ? 1 : 0);
