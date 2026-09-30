/* 验证「智能体立即运行后，居中弹出今日工作量」：
   1) 造出一批真实工作量（跟进备注 / 抖音新发视频 / 课时完成 / 观察量若干）
   2) 用真实的 centerNoticeHTML() 渲染居中提示层，盖在真实渲染的智能体首页上
   3) 断言：文案数字与 store 计数完全一致、口径说明完整、无 em-dash / 无脏值
   4) 静态断言：8 类埋点埋在正确位置，且运行分支确实调用 centerNotice */

import { readFileSync, writeFileSync } from 'node:fs';

const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });

const store = await import('./js/store.js');
const { computeMetrics } = await import('./js/metrics.js');
const agentView = await import('./js/views/agent.js');
const { centerNoticeHTML, CENTER_NOTICE_HOLD, CENTER_NOTICE_DUST } = await import('./js/components.js');

await store.init();

/* ---------- 造真实工作量（不走任何模拟值，全部由埋点自己累加） ---------- */
store.addFollowup({ memberId: 'm01', channel: 'wechat', summary: '确认本周到店时段', result: 'neutral' });
store.saveDouyinSnapshot({ account: { remoteId: 'lijian_jrc' }, works: [{ remoteId: 'w-new-1' }, { remoteId: 'w-new-2' }] });
store.cycleTopicStatus('t02'); /* t02 在 seed 里是 doing → done，计 1 次操作量 */
store.bumpWorkload('obs');     /* 看客户卡 */
store.bumpWorkload('obs');     /* AI 话术生成 */
store.bumpWorkload('obs');     /* 处理进化建议 */

const w = store.todayWorkload(store.get());
/* 灰片形态：只有一行「今日工作量」+ 一行数字，不再堆口径说明 */
const msg = '今日工作量';
const sub = `操作量 ${w.ops} · 观察量 ${w.obs}`;

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

const agentHtml = agentView.render(mkCtx());
/* 光点位置用固定随机序列，保证每次生成的预览一致（也方便断言数量） */
const seq = (() => { let s = 7; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();
const noticeHtml = `<div class="cn-mask">${centerNoticeHTML(msg, sub, { rnd: seq })}</div>`;

const idx = readFileSync('./index.html', 'utf8');
const sprite = idx.match(/<svg width="0"[\s\S]*?<\/svg>/)[0];
const doc = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>FitFlow · 今日工作量灰片（溶解吸入星星）</title>
<link rel="stylesheet" href="./styles.css">
<style>
  body{margin:0;background:#f4f6f5}
  .pv-bar{position:sticky;top:0;z-index:5;background:#0E8F5B;color:#fff;padding:10px 16px;font-size:13px;font-weight:600}
  .pv-shell{max-width:520px;margin:0 auto;padding:0 10px 60px}
  .pv-h2{font-size:14px;margin:16px 0 8px;color:#0A6E46}
  .pv-replay{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:90}
  /* 预览页没有真顶栏，这里摆一颗同款星星当吸入目标（真机上是 .bubble[data-hdr="brand"]） */
  .pv-star{position:fixed;left:16px;top:14px;z-index:95;width:34px;height:34px;border-radius:999px;
    display:grid;place-items:center;background:#fff;border:1px solid var(--line);box-shadow:var(--sh-1)}
  .pv-star svg{width:19px;height:19px;fill:none;stroke:var(--brand-2);stroke-width:1.9}
  .pv-star.hit{animation:starCatch .5s ease}
  @keyframes starCatch{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}
</style></head>
<body>
<div class="pv-bar">停留 ${CENTER_NOTICE_HOLD}ms → 文字溶解散落 → 光点收进左上角星星（灰片不拦任何操作）</div>
<div class="pv-star" id="pvStar"><svg viewBox="0 0 24 24"><use href="#i-spark"/></svg></div>
<div class="pv-shell">
  <div class="pv-h2">智能体首页（灰片浮在其上，可正常下滑 / 切页）</div>
  ${agentHtml}
</div>
${noticeHtml}
<button class="btn primary pv-replay" onclick="location.reload()">再看一次（刷新重放）</button>
<script>
  /* 与线上同一套时间线：停留 → 算光点位移 → 加 .out 触发溶解与吸入。
     位移在加 .out 前量，量的是每粒光点当前位置到星星中心的差值。 */
  setTimeout(() => {
    const m = document.querySelector('.cn-mask');
    if (!m) return;
    const star = document.getElementById('pvStar');
    const r = star.getBoundingClientRect();
    const tx = r.left + r.width / 2, ty = r.top + r.height / 2;
    m.querySelectorAll('.cn-dust i').forEach((el) => {
      const b = el.getBoundingClientRect();
      el.style.setProperty('--dx', (tx - (b.left + b.width / 2)).toFixed(1) + 'px');
      el.style.setProperty('--dy', (ty - (b.top + b.height / 2)).toFixed(1) + 'px');
    });
    m.classList.add('out');
    setTimeout(() => star.classList.add('hit'), 620);
    setTimeout(() => m.remove(), 1400);
  }, ${CENTER_NOTICE_HOLD});
</script>
${sprite}
</body></html>`;

writeFileSync('./preview-notice.html', doc, 'utf8');

/* ---------- 冒烟 ---------- */
let fail = 0;
const must = (c, m) => { if (!c) { fail++; console.log('FAIL ' + m); } else console.log('OK   ' + m); };
const text = (h) => h.replace(/<[^>]+>/g, ' ');

/* 源码快照：后面几组静态断言都要读，统一在这里取一次 */
const read = (p) => readFileSync(p, 'utf8');
const st = read('./js/store.js');
const ap = read('./js/app.js');
const ag = read('./js/views/agent.js');
const ot = read('./js/outreach.js');
const cc = read('./js/connectorConsole.js');

for (const [name, re] of [['undefined', /undefined/], ['NaN', /NaN/], ['[object Object]', /\[object Object\]/]]) {
  if (re.test(text(noticeHtml))) { fail++; console.log('FAIL 提示层出现 ' + name); }
}
if (/[\u2014]/.test(text(noticeHtml))) { fail++; console.log('FAIL 提示层出现 em-dash'); }

must(/class="cn-mask"/.test(noticeHtml), '提示层是居中定位容器（.cn-mask）');
must(/class="cn-slab"/.test(noticeHtml), '提示层是居中文字片（.cn-slab）');
must(!/data-cn-ok/.test(noticeHtml), '不再有「知道了」按钮（改自动淡出，不再依赖点击）');
must(!/<button/.test(noticeHtml), '灰片里没有任何按钮');
must(noticeHtml.includes(msg), `主文案：${msg}`);
must(new RegExp(`操作量 ${w.ops}`).test(noticeHtml), `操作量数字 = store 的 ${w.ops}`);
must(new RegExp(`观察量 ${w.obs}`).test(noticeHtml), `观察量数字 = store 的 ${w.obs}`);

/* 收场机制：停留 → 溶解散落 → 吸入星星 */
const comp = readFileSync('./js/components.js', 'utf8');
must(/CENTER_NOTICE_HOLD = 1400/.test(comp), '停留 1400ms（比上一版 1000ms 放缓）');
must(/CENTER_NOTICE_FADE = 1100/.test(comp), '溶解吸入段 1100ms');
must(/CENTER_NOTICE_STAR_SEL = '\.bubble\[data-hdr="brand"\]'/.test(comp), '吸入目标指向顶栏星星按钮');
must(/function aimDustAtStar/.test(comp) && /aimDustAtStar\(wrap\)/.test(comp), '起飞前先算每粒光点到星星的位移');
must(/setProperty\('--dx'/.test(comp) && /setProperty\('--dy'/.test(comp), '位移写进 --dx / --dy（动画里不再跑 JS）');
must(/wrap\.classList\.add\('out'\)/.test(comp), '到点加 .out 触发溶解');
must(/setTimeout\(done, CENTER_NOTICE_FADE \+ 260\)/.test(comp), '兜底计时器：动画没跑完也能收掉');
must(!/wrap\.addEventListener\('click'/.test(comp), '不绑定 click（挂点禁用指针事件，绑了也收不到）');
must(/querySelectorAll\('\.cn-mask'\)\.forEach\(\(n\) => n\.remove\(\)\)/.test(comp), '连点运行不会叠出多片灰');

/* 灰片只裹住文字 + 不拦交互 */
const css = readFileSync('./styles.css', 'utf8');
must(/\.toast-root\{[^}]*pointer-events:none/.test(css), '挂点 .toast-root 本身禁用指针事件');
must(/\.cn-mask\{[\s\S]{0,220}?pointer-events:none/.test(css), '灰片沿用 pointer-events:none（不挡下滑 / 切页）');
must(!/\.cn-mask\{[^}]*inset:0/.test(css), '灰片不再是全屏蒙层（没有 inset:0）');
must(/\.cn-slab\{[^}]*padding:13px 22px/.test(css), '灰片尺寸由文字撑起（内边距固定，不再铺满）');
must(/@keyframes cnDissolve/.test(css) && /filter:blur/.test(css), '文字走 blur 溶解（散开感）');
must(/@keyframes dustFly/.test(css), '光点有飞行动画（dustFly）');
must(/var\(--dx,0px\)[\s\S]{0,60}?var\(--dy,-120px\)/.test(css), '光点终点由 --dx / --dy 决定（收进星星）');
must((noticeHtml.match(/class="cn-dust"/g) || []).length === 1, '光点层渲染出来了');
must((noticeHtml.match(/<i style="left:/g) || []).length === CENTER_NOTICE_DUST, `光点数量 = ${CENTER_NOTICE_DUST}`);
must(!/\.cn-box/.test(css), '旧卡片样式已清掉');

/* 调用处文案 */
must(/centerNotice\('今日工作量'/.test(ag), '运行分支文案为「今日工作量」一行字');

/* 计数机制复核：埋点只在此处累加，不重复计 */
must(w.ops === 4, `操作量 = 4（跟进 1 + 抖音新发 2 + 课时完成 1，实际 ${w.ops}）`);
must(w.obs === 3, `观察量 = 3（看客户卡 / AI 话术 / 进化建议，实际 ${w.obs}）`);

/* ---------- 静态断言：8 类埋点位置 + 运行分支弹窗 ---------- */
must(/function addFollowup[\s\S]{0,600}?addWorkload\(s, 'ops'\)/.test(st), '埋点①：写跟进备注计 1 次操作量（store.addFollowup）');
must(/next === 'done'\) bumpWorkload\('ops'\)/.test(st), '埋点②：课时标成「已完成」计 1 次操作量（store.cycleTopicStatus）');
must(/addWorkload\(s, 'ops', fresh\)/.test(st), '埋点③：抖音新发布视频按新出现条数计操作量（store.saveDouyinSnapshot）');
must(/bumpWorkload\('obs'\);[\s\S]{0,200}?ctx\.openMember|openMember\(id[\s\S]{0,400}?bumpWorkload\('obs'\)/.test(ap), '埋点④：点开客户卡详情计 1 次观察量（app.openMember）');
must(/bumpWorkload\('ops'\)/.test(ot), '埋点⑤：复制话术跳转微信计 1 次操作量（outreach）');
must((ot.match(/bumpWorkload\('obs'\)/g) || []).length >= 1, '埋点⑥：AI 话术生成 / 云端润色计 1 次观察量（outreach）');
must(/bumpWorkload\('obs'\)/.test(ag), '埋点⑦：处理进化建议计 1 次观察量（views/agent）');
must((cc.match(/bumpWorkload\('obs'\)/g) || []).length >= 2, '埋点⑧：平台接口 test / sync 各计 1 次观察量（connectorConsole）');

/* 运行分支：先记日志、刷新，再弹居中提示 */
const iRun = ag.indexOf('logAgentRun(');
const iNotice = ag.indexOf('centerNotice(', iRun);
must(iRun > -1 && iNotice > iRun, '智能体运行分支在运行完成后调用 centerNotice');
must(/centerNotice\('今日工作量', `操作量 \$\{w\.ops\} · 观察量 \$\{w\.obs\}`\)/.test(ag), '弹窗为「今日工作量」+ 一行「操作量 X · 观察量 X」');
must(/const w = todayWorkload\(getStore\(\)\)/.test(ag), '弹窗数字取自 todayWorkload（当日口径，跨天自动归零）');

console.log(fail ? `\n预览失败：${fail} 项` : '\n预览生成成功 → preview-notice.html');
process.exit(fail ? 1 : 0);
