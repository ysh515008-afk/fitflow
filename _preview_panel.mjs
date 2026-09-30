/* 验证「今日工作流移入星星下拉面板底部」：
   1) workflowSection(s) 单独渲染正常（内容 / 无脏值 / 无 em-dash）
   2) 智能体页已不再重复渲染该栏
   3) 静态断言：app.js 中 workflowSection 排在 accountPreview 之后（即面板底部），
      且 .hd-panel 为纵向列 + 可滚动（保证置底后仍可看完） */

import { readFileSync, writeFileSync } from 'node:fs';

const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });

const store = await import('./js/store.js');
const { computeMetrics } = await import('./js/metrics.js');
const agentView = await import('./js/views/agent.js');

await store.init();
const state = store.get();

const mkCtx = () => ({
  state,
  metrics: computeMetrics(state),
  _opsSeg: 'content', _contentSub: 'douyin', _memberSeg: 'overview', _memberTab: 'profile',
  _cardFilter: 'attention', _stageTab: 's1', _q: '', _stage: 'all', _openTopic: null, _aiTopic: null,
  _tab: 'agent',
  greeting: () => '早上好',
  funnel: () => store.leadFunnel().map((x) => ({ label: x.label, value: x.value, noConv: x.noConv })),
  weekday: () => '周六',
});

const wf = agentView.workflowSection(state);
const agentHtml = agentView.render(mkCtx());

const idx = readFileSync('./index.html', 'utf8');
const sprite = idx.match(/<svg width="0"[\s\S]*?<\/svg>/)[0];
const doc = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>FitFlow · 星星面板底部的今日工作流</title>
<link rel="stylesheet" href="./styles.css">
<style>
  body{margin:0;background:#f4f6f5}
  .pv-bar{position:sticky;top:0;z-index:5;background:#0E8F5B;color:#fff;padding:10px 16px;font-size:13px;font-weight:600}
  .pv-shell{max-width:520px;margin:0 auto;padding:16px 12px 60px}
  .pv-h2{font-size:14px;margin:16px 0 8px;color:#0A6E46}
  /* 预览里模拟展开后的星星面板（真机上 .hd-panel 从顶部滑下） */
  .mock-panel{background:linear-gradient(180deg,#fff,#FBFDFC);border:1px solid var(--line);
    border-radius:14px;padding:13px 16px 12px;display:flex;flex-direction:column;gap:11px;
    max-height:calc(100vh - 140px);overflow-y:auto;box-shadow:var(--sh-2)}
</style></head>
<body>
<div class="pv-bar">今日工作流已移入星星下拉面板，并置于该面板底部（面板可滚动）</div>
<div class="pv-shell">
  <div class="pv-h2">星星下拉面板（Account 预览 → 今日工作流）</div>
  <div class="mock-panel">
    <div class="small muted">（上：账号 / 销售等级 / 分布 KPI，即 accountPreview）</div>
    ${wf}
  </div>
</div>
${sprite}
</body></html>`;

writeFileSync('./preview-panel.html', doc, 'utf8');

/* ---------- 冒烟 ---------- */
let fail = 0;
const must = (c, m) => { if (!c) { fail++; console.log('FAIL ' + m); } else console.log('OK   ' + m); };
const text = (h) => h.replace(/<[^>]+>/g, ' ');

for (const [name, re] of [['undefined', /undefined/], ['NaN', /NaN/], ['[object Object]', /\[object Object\]/]]) {
  if (re.test(text(wf))) { fail++; console.log('FAIL 工作流区出现 ' + name); }
}
if (/[\u2014]/.test(text(wf))) { fail++; console.log('FAIL 工作流区出现 em-dash'); }

must(/今日工作流/.test(wf), '工作流区标题为「今日工作流」');
must(/dayplan/.test(wf), '渲染出时间块列表');
must(/data-block=/.test(wf), '时间块含勾选按钮');
must(/data-act="add-block"/.test(wf) && /data-act="reset-plan"/.test(wf) && /data-act="ai-weekly"/.test(wf), '三个操作按钮齐全');
must(!/今日工作流/.test(agentHtml), '智能体页已不再重复渲染该栏');
must(!/个人工作流/.test(agentHtml), '智能体页无残留「个人工作流」');

/* 静态断言：面板内顺序 = accountPreview 之后才是 workflowSection（置底） */
const src = readFileSync('./js/app.js', 'utf8');
const iAcc = src.indexOf('${accountPreview(s)}');
const iWf = src.indexOf('${agentView.workflowSection(s)}');
must(iAcc > -1 && iWf > -1 && iWf > iAcc, '面板内 workflowSection 排在 accountPreview 之后（置底）');
const openIdx = src.indexOf('<div class="hd-panel');
const closeIdx = src.indexOf('</div>`', openIdx);
must(openIdx > -1 && closeIdx > -1 && iWf > openIdx && iWf < closeIdx, 'workflowSection 位于 hd-panel 容器内');

const css = readFileSync('./styles.css', 'utf8');
must(/\.app-header \.hd-panel\{[^}]*flex-direction:column/.test(css), 'hd-panel 为纵向列（子元素上下堆叠）');
must(/\.app-header \.hd-panel\{[^}]*overflow-y:auto/.test(css), 'hd-panel 可滚动（内容变长也不会盖满屏）');

console.log(fail ? `\n预览失败：${fail} 项` : '\n预览生成成功 → preview-panel.html');
process.exit(fail ? 1 : 0);
