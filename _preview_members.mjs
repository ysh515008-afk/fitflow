/* 客户管理端预览：渲染 views/members.js，子集（seg）切换：总览 / 维护 / 跟进 / 统计，
   只读、不启用编辑器（FAB 仅展示不绑定动作）。套 styles.css + SVG sprite，生成 preview-members.html。
   冒烟：undefined / NaN / [object Object] / 横线。 */

import { readFileSync, writeFileSync } from 'node:fs';

const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });

const store = await import('./js/store.js');
const { computeMetrics } = await import('./js/metrics.js');
const membersView = await import('./js/views/members.js');

await store.init();

function mkCtx(patch = {}) {
  return {
    state: store.get(),
    metrics: computeMetrics(store.get()),
    _opsSeg: 'content', _contentSub: 'douyin', _memberSeg: 'overview', _memberTab: 'profile',
    _cardFilter: 'attention', _stageTab: 's1', _q: '', _stage: 'all', _openTopic: null, _aiTopic: null,
    _tab: 'members',
    greeting: () => '早上好', funnel: () => store.leadFunnel().map((x) => ({ label: x.label, value: x.value, noConv: x.noConv })), weekday: () => '周六',
    ...patch,
  };
}

const html = membersView.render(mkCtx({ _tab: 'members' }));

const idx = readFileSync('./index.html', 'utf8');
const sprite = idx.match(/<svg width="0"[\s\S]*?<\/svg>/)[0];

const doc = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>FitFlow · 客户管理端预览</title>
<link rel="stylesheet" href="./styles.css">
<style>
  body{margin:0;background:#f4f6f5}
  .pv-bar{position:sticky;top:0;z-index:5;background:#0E8F5B;color:#fff;padding:10px 16px;font-size:13px;font-weight:600;display:flex;gap:10px;align-items:center}
  .pv-bar .dot{width:8px;height:8px;border-radius:50%;background:#7CFFC4}
  .pv-shell{max-width:1500px;margin:0 auto;padding:0 10px}
</style></head>
<body>
<div class="pv-bar"><span class="dot"></span>FitFlow · 客户管理端（只读预览 · 编辑器未启用）· 子集切换：总览 / 维护 / 跟进 / 统计（默认显示「总览」）</div>
<div class="pv-shell">${html}</div>
${sprite}
</body></html>`;

writeFileSync('./preview-members.html', doc, 'utf8');

const t = String(html).replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
let fail = 0;
for (const [name, re] of [['undefined', /undefined/], ['NaN', /NaN/], ['[object Object]', /\[object Object\]/]]) {
  if (re.test(t)) { fail++; console.log('FAIL 出现 ' + name); }
}
if (/[\u2014\u2013]|(?<![-])--(?![-])/.test(t)) { fail++; console.log('FAIL 出现横线'); }
console.log(`客户管理端渲染 ${String(html).length} 字节`);
console.log(fail ? `预览生成失败：${fail} 项` : '预览生成成功 → preview-members.html');
process.exit(fail ? 1 : 0);
