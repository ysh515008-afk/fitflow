/* 智能体首页（交互页面）预览：渲染 views/agent.js 的 render，套 styles.css + SVG sprite，
   生成自包含 preview-agent.html。冒烟同 _render.mjs：查 undefined / NaN / [object Object] / 横线。 */

import { readFileSync, writeFileSync } from 'node:fs';

const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });

const store = await import('./js/store.js');
const { computeMetrics } = await import('./js/metrics.js');
const agentView = await import('./js/views/agent.js');

await store.init();

function mkCtx(patch = {}) {
  return {
    state: store.get(),
    metrics: computeMetrics(store.get()),
    _opsSeg: 'content', _contentSub: 'douyin', _memberSeg: 'list', _memberTab: 'profile',
    _cardFilter: 'attention', _stageTab: 's1', _q: '', _stage: 'all', _openTopic: null, _aiTopic: null,
    _tab: 'agent',
    greeting: () => '早上好，先看清今天该动谁',
    funnel: () => store.leadFunnel().map((x) => ({ label: x.label, value: x.value, noConv: x.noConv })),
    weekday: () => '周六',
    ...patch,
  };
}

const html = agentView.render(mkCtx({ _tab: 'agent' }));

/* 内联 SVG sprite */
const idx = readFileSync('./index.html', 'utf8');
const sprite = idx.match(/<svg width="0"[\s\S]*?<\/svg>/)[0];

const doc = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>FitFlow · 智能体首页预览</title>
<link rel="stylesheet" href="./styles.css">
<style>
  body{margin:0;background:#f4f6f5}
  .pv-bar{position:sticky;top:0;z-index:5;background:#0E8F5B;color:#fff;padding:10px 16px;font-size:13px;font-weight:600;display:flex;gap:10px;align-items:center}
  .pv-bar .dot{width:8px;height:8px;border-radius:50%;background:#7CFFC4}
</style></head>
<body>
<div class="pv-bar"><span class="dot"></span>FitFlow · 智能体首页（交互页面）预览 · 真实种子数据渲染</div>
${html}
${sprite}
</body></html>`;

writeFileSync('./preview-agent.html', doc, 'utf8');

/* 冒烟校验 */
const t = String(html).replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
let fail = 0;
for (const [name, re] of [['undefined', /undefined/], ['NaN', /NaN/], ['[object Object]', /\[object Object\]/]]) {
  if (re.test(t)) { fail++; console.log('FAIL 出现 ' + name); }
}
if (/[\u2014\u2013]|(?<![-])--(?![-])/.test(t)) { fail++; console.log('FAIL 出现横线'); }
console.log(`智能体首页渲染 ${String(html).length} 字节`);
console.log(fail ? `预览生成失败：${fail} 项` : '预览生成成功 → preview-agent.html');
process.exit(fail ? 1 : 0);
