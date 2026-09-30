/* 验证「登记流失」相关改动 + 维护栏 20% 口径：
   演示：把两位会员登记流失，渲染客户总览（含客户池 / 流失会员池）与客户维护两栏。
   冒烟：无 undefined/NaN、无 em-dash；流失卡置底且带灰显 class；流失会员池出数；维护栏口径文案正确。 */

import { readFileSync, writeFileSync } from 'node:fs';

const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });

const store = await import('./js/store.js');
const { computeMetrics } = await import('./js/metrics.js');
const membersView = await import('./js/views/members.js');

await store.init();

/* 登记两位流失，用来验证「置底 + 灰显 + 流失会员池」 */
store.markMemberLost('m03', '搬离本区');
store.markMemberLost('m05', '转去别家');
const state = store.get();
const lostNames = state.members.filter((m) => m.lost).map((m) => m.name);

const mkCtx = (seg) => ({
  state,
  metrics: computeMetrics(state),
  _opsSeg: 'content', _contentSub: 'douyin', _memberSeg: seg, _memberTab: 'profile',
  _cardFilter: 'attention', _stageTab: 's1', _q: '', _stage: 'all', _openTopic: null, _aiTopic: null,
  _tab: 'members',
  greeting: () => '早上好',
  funnel: () => store.leadFunnel().map((x) => ({ label: x.label, value: x.value, noConv: x.noConv })),
  weekday: () => '周六',
});

const overview = membersView.render(mkCtx('overview'));
const maintain = membersView.render(mkCtx('maintain'));

const idx = readFileSync('./index.html', 'utf8');
const sprite = idx.match(/<svg width="0"[\s\S]*?<\/svg>/)[0];
const doc = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>FitFlow · 登记流失与维护栏口径预览</title>
<link rel="stylesheet" href="./styles.css">
<style>
  body{margin:0;background:#f4f6f5}
  .pv-bar{position:sticky;top:0;z-index:5;background:#0E8F5B;color:#fff;padding:10px 16px;font-size:13px;font-weight:600}
  .pv-shell{max-width:1500px;margin:0 auto;padding:0 10px}
  .pv-h2{font-size:15px;margin:18px 0 6px;color:#0A6E46}
</style></head>
<body>
<div class="pv-bar">演示：${lostNames.join('、')} 已登记流失 · 客户池置底灰显 · 维护栏改为剩余不足 20%</div>
<div class="pv-shell">
  <div class="pv-h2">客户总览（含流失会员池 + 客户池）</div>
  ${overview}
  <div class="pv-h2">客户维护（剩余不足 20%）</div>
  ${maintain}
</div>
${sprite}
</body></html>`;

writeFileSync('./preview-lost.html', doc, 'utf8');

/* ---------- 冒烟 ---------- */
const vis = doc.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
let fail = 0;
const must = (c, m) => { if (!c) { fail++; console.log('FAIL ' + m); } else console.log('OK   ' + m); };

for (const [name, re] of [['undefined', /undefined/], ['NaN', /NaN/], ['[object Object]', /\[object Object\]/]]) {
  if (re.test(vis)) { fail++; console.log('FAIL 出现 ' + name); }
}
if (/[\u2014]/.test(vis)) { fail++; console.log('FAIL 出现 em-dash'); }

must(/流失会员池/.test(overview), '总览含「流失会员池」统计');
must(/客户池/.test(overview), '总览含客户池列表');
must(/list-item lost/.test(overview), '流失卡带灰显 class（list-item lost）');
must(/登记流失/.test(overview), '流失卡带「登记流失」标识');
must((overview.match(/list-item lost/g) || []).length === 2, '灰显卡数量 = 已登记流失人数（2）');

/* 置底校验：所有灰显卡的位置必须在所有正常卡之后 */
const allIdx = [...overview.matchAll(/class="list-item( lost)?"/g)].map((m, i) => ({ i, lost: !!m[1] }));
const firstLost = allIdx.find((x) => x.lost);
const lastLive = [...allIdx].reverse().find((x) => !x.lost);
must(firstLost && lastLive && firstLost.i > lastLive.i, '流失卡全部置底（排在最后）');

must(/剩余不足 20%/.test(maintain), '维护栏标题改为「剩余不足 20%」');
must(/低于 20%/.test(maintain), '维护栏写出 20% 口径定义');

/* 维护名单口径自检：列出的会员剩余比例必须 < 20% */
const { cardProgress } = await import('./js/data/membership.js');
const { cardsOfMember } = await import('./js/store.js');
const list = state.members.filter((m) => !m.lost).map((m) => {
  const active = cardsOfMember(m.id).filter((c) => c.status !== 'transferred' && c.status !== 'refunded' && c.status !== 'suspended' && c.status !== 'frozen');
  const rs = active.map((c) => 1 - cardProgress(c));
  return { name: m.name, min: rs.length ? Math.min(...rs) : 1, near: rs.some((r) => r < 0.2) };
}).filter((x) => x.near);
console.log(`维护名单（剩余 < 20%）：${list.map((x) => `${x.name} ${Math.round(x.min * 100)}%`).join(' / ') || '（空）'}`);
must(list.every((x) => x.min < 0.2), '维护名单内每位会员剩余比例均 < 20%');

console.log(fail ? `\n预览失败：${fail} 项` : '\n预览生成成功 → preview-lost.html');
process.exit(fail ? 1 : 0);
