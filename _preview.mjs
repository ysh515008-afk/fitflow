/* 预览生成：注入覆盖 p1→p6 的跟进（含报价桥接）与打卡明细，渲染会员详情页各 tab，
   生成自包含 preview.html（内联 SVG sprite，链接 styles.css）。
   同时充当渲染冒烟：任何 undefined / NaN / [object Object] / 横线 都会被判为失败。 */

import { readFileSync, writeFileSync } from 'node:fs';

const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });

const store = await import('./js/store.js');
const sheets = await import('./js/sheets.js');
const { today, d } = await import('./js/util.js');

await store.init();

/* ---------- 注入演示数据：m01 走完 p1→p6，并在 p5 提及报价触发桥接 ---------- */
const ST = {
  p1: { stage: 'p1', state: 'watch', principles: [], microCommit: '', note: '', checks: [] },
  p2: { stage: 'p2', state: 'hesitate', principles: ['oars'], microCommit: '', note: '', checks: [] },
  p3: { stage: 'p3', state: 'expect', principles: ['choices'], microCommit: '答应先看方案', note: '', checks: [] },
  p4: { stage: 'p4', state: 'anxious', principles: ['labeling'], microCommit: '', note: '', checks: [] },
  p5: { stage: 'p5', state: 'expect', principles: ['commitment'], microCommit: '答应周六交款', note: '', checks: [] },
  p6: { stage: 'p6', state: 'trust', principles: ['gradient'], microCommit: '', note: '', checks: [] },
};
const DEMOS = [
  { ch: 'wechat', summary: '微信发了健身避坑清单，没提钱，先建立信任', feedback: '说最近肩颈很僵', result: 'positive', k: 6 },
  { ch: 'phone', summary: '电话聊了 20 分钟，客户说其实主要是想改善圆肩和睡眠', feedback: '愿意多聊', result: 'positive', k: 5 },
  { ch: 'visit', summary: '到店做了体态评估，呈现了 12 周计划，客户开始问周期和效果', feedback: '问了训练频率', result: 'positive', k: 4 },
  { ch: 'wechat', summary: '客户说再想想，担心教练换人；我做了情绪标注，给了两个真实选项', feedback: '语气软了', result: 'neutral', k: 3 },
  { ch: 'visit', summary: '当面给续费方案，报价 2980 元，客户答应周六来交', feedback: '没再犹豫', result: 'positive', k: 2 },
  { ch: 'wechat', summary: '客户已打卡 3 次，主动分享了训练感受，进入陪伴期', feedback: '状态很好', result: 'positive', k: 1 },
];
for (const dm of DEMOS) {
  store.addFollowup({
    memberId: 'm01', channel: dm.ch, summary: dm.summary, feedback: dm.feedback,
    result: dm.result, date: d(-dm.k), nextDate: d(1), nextAction: '继续推进', psych: ST[dm.stage],
  });
}

const m01 = store.memberById('m01');
const ren = store.renewalOf('m01');
console.log(`m01 跟进 ${store.followupsOf('m01').length} 条；续费报价 ${ren ? ren.quoteAmount : '无'}（auto=${ren ? !!ren.quoteAuto : '—'}）`);

/* ---------- 渲染 ---------- */
const ctx = { state: store.get(), _calMonth: today().slice(0, 7), refresh() {} };
const TABS = ['checkin', 'profile', 'card', 'follow', 'appt', 'renew'];
const panes = TABS.map((t, i) =>
  `<div class="tabpane" data-tab="${t}" style="display:${i === 0 ? 'block' : 'none'}">${sheets.memberSheetBody('m01', t, ctx)}</div>`
).join('');

const journeyCard = sheets.renderStageJourney(m01, ctx);

/* 渠道气泡演示块（静态，标"当面"为选中态） */
const bubbleDemo = `<div class="chips channel-bubbles">${store.CHANNEL_BUBBLES.map((k) =>
  `<button type="button" class="chip ch-bubble ${k === 'visit' ? 'on' : ''}" data-val="${k}"><svg viewBox="0 0 24 24" class="bi"><use href="#${store.CHANNELS[k].icon}"/></svg>${store.CHANNELS[k].label}</button>`
).join('')}</div>`;

/* 内联 SVG sprite */
const html = readFileSync('./index.html', 'utf8');
const sprite = html.match(/<svg width="0"[\s\S]*?<\/svg>/)[0];

const doc = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>FitFlow 会员详情 · 改动预览</title>
<link rel="stylesheet" href="./styles.css">
<style>
  body{background:#f4f6f5;margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:1080px;margin:0 auto;padding:22px 18px 80px}
  .pv-h1{font-size:20px;margin:0 0 4px;color:#0A6E46}
  .pv-sub{color:#6B7B74;font-size:13px;margin:0 0 18px}
  .pv-sec{background:#fff;border:1px solid #e4eae7;border-radius:14px;padding:16px;margin:14px 0;box-shadow:0 1px 3px rgba(16,40,30,.05)}
  .pv-h2{font-size:15px;margin:0 0 4px}
  .pv-p{color:#6B7B74;font-size:12.5px;margin:0 0 12px;line-height:1.6}
  .pv-tip{font-size:12px;color:#0A6E46;background:#E6F4EC;border:1px solid #CFE9DB;border-radius:8px;padding:8px 10px;margin-bottom:12px;line-height:1.6}
  .sheet-frame{background:#fff;border:1px solid #e4eae7;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(16,40,30,.05)}
  .tabpane{padding:16px}
</style></head>
<body><div class="wrap">
  <h1 class="pv-h1">FitFlow · 会员卡详情页改动预览</h1>
  <p class="pv-sub">演示会员：林嘉怡（m01）· 含完整 p1→p6 跟进轨迹、报价桥接、打卡明细</p>

  <div class="pv-sec">
    <h2 class="pv-h2">① 沟通渠道 · 一次点击气泡</h2>
    <p class="pv-p">记录跟进时渠道选择改为 7 个气泡，点一下即选中（红框为选中态）：</p>
    ${bubbleDemo}
  </div>

  <div class="pv-sec">
    <h2 class="pv-h2">② 关系推进阶段图（跟进 tab 内，抽成纯函数）</h2>
    <p class="pv-p">替代原来的"交互阶段轨迹"：横向铺开 6 个阶段，走过的点亮、当前高亮，并给出"下一步该聊什么"的具体建议。</p>
    ${journeyCard}
  </div>

  <div class="pv-sec">
    <h2 class="pv-h2">③ 会员详情：客户信息卡置顶 + 单栏 tab 切换</h2>
    <div class="pv-tip">运动日历模块更名为<b>出勤</b>，并作为详情端第一个<b>子集（tab）</b>，不再独立成左栏。子集顺序：<b>出勤 → 档案（含系统数据）→ 会籍 → 跟进（AI 转写跟进作为可选方式嵌入）→ 预约 → 续费</b>。点击下方 tab 切换：<b>出勤</b>看打卡月历 · <b>档案</b>含系统数据 · <b>跟进</b>看阶段轨迹 + AI 转写可选方式 · <b>续费</b>看自动提取的报价（¥2,980，标"自动提取"，可改）。</div>
    <div class="sheet-frame">${panes}</div>
  </div>
</div>
<script>
document.addEventListener('click', function(e){
  var b = e.target.closest('[data-mtab]');
  if(b){ var t=b.dataset.mtab;
    document.querySelectorAll('.tabpane').forEach(function(p){p.style.display = p.dataset.tab===t ? 'block' : 'none';});
    document.querySelectorAll('[data-mtab]').forEach(function(x){x.classList.toggle('on', x.dataset.mtab===t);});
  }
});
</script>
${sprite}
</body></html>`;

writeFileSync('./preview.html', doc, 'utf8');

/* ---------- 冒烟校验 ---------- */
const t = doc.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
let fail = 0;
for (const [name, re] of [['undefined', /undefined/], ['NaN', /NaN/], ['[object Object]', /\[object Object\]/]]) {
  if (re.test(t)) { fail++; console.log('FAIL 出现 ' + name); }
}
if (/[\u2014\u2013]|(?<![-])--(?![-])/.test(t)) { fail++; console.log('FAIL 出现横线'); }
if (!/自动提取/.test(doc)) { fail++; console.log('FAIL 续费桥接标记缺失'); }
if (!/关系推进阶段/.test(doc)) { fail++; console.log('FAIL 阶段图缺失'); }
if (!/class="member-detail"/.test(doc)) { fail++; console.log('FAIL 详情布局缺失'); }
console.log(fail ? `预览生成失败：${fail} 项` : '预览生成成功 → preview.html');
process.exit(fail ? 1 : 0);
