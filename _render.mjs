/* 渲染冒烟：把五个视图 × 各种分段组合都渲染一遍，查三样东西
     1. 渲染产物里出现 undefined / NaN / [object Object]
     2. 用户可见文案里出现 em-dash / en-dash / 双连字符
     3. 任何一个分支抛异常
   只查渲染出来的文案，源码注释里的分隔线不算。 */

const ls = new Map();
globalThis.localStorage = { getItem:(k)=>ls.has(k)?ls.get(k):null, setItem:(k,v)=>ls.set(k,String(v)), removeItem:(k)=>ls.delete(k), clear:()=>ls.clear() };
Object.defineProperty(globalThis,'navigator',{value:{userAgent:'node'},configurable:true});

const store = await import('./js/store.js');
const { computeMetrics } = await import('./js/metrics.js');
const opsView = await import('./js/views/ops.js');
const agentView = await import('./js/views/agent.js');
const membersView = await import('./js/views/members.js');
const learningView = await import('./js/views/learning.js');
const analyticsView = await import('./js/views/analytics.js');
const { setFeature, setBizSource } = store;

/* init() 是 async（加密 keystore 要 await），不 await 会在 state 还是 null 时渲染 */
await store.init();

/* ctx 桩：只放视图真正读的那几个字段 */
function mkCtx(patch = {}) {
  return {
    state: store.get(),
    metrics: computeMetrics(store.get()),
    _opsSeg: 'content', _contentSub: 'douyin', _memberSeg: 'list', _memberTab: 'profile',
    _cardFilter: 'attention', _stageTab: 's1', _q: '', _stage: 'all', _openTopic: null, _aiTopic: null,
    _tab: 'ops',
    /* 这两个由 app.js 注入，视图在 render 里会读，桩里补上 */
    greeting: () => '早上好，先看清今天该动谁',
    funnel: () => store.leadFunnel().map((x) => ({ label: x.label, value: x.value, noConv: x.noConv })),
    weekday: () => '周六',
    ...patch,
  };
}

const cases = [
  ['ops/content/douyin',  opsView, { _opsSeg:'content', _contentSub:'douyin' }],
  ['ops/content/biz',     opsView, { _opsSeg:'content', _contentSub:'biz' }],
  ['ops/content/store',   opsView, { _opsSeg:'content', _contentSub:'store' }],
  ['ops/content/xhs',     opsView, { _opsSeg:'content', _contentSub:'xhs' }],
  ['ops/content/ledger',  opsView, { _opsSeg:'content', _contentSub:'ledger' }],
  ['ops/leads',           opsView, { _opsSeg:'leads' }],
  ['ops/community',       opsView, { _opsSeg:'community' }],
  ['agent',               agentView, { _tab:'agent' }],
  ['members',             membersView, { _tab:'members' }],
  ['learning',            learningView, { _tab:'learning' }],
  ['analytics',           analyticsView, { _tab:'analytics' }],
];

/* 竖线用来看每个 case 有没有撑出足够的内容 */
const DASH = /[\u2014\u2013]|(?<![-])--(?![-])/;
let fail = 0;

function check(label, html) {
  const text = String(html).replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
  const problems = [];
  for (const [name, re] of [['undefined', /undefined/], ['NaN', /NaN/], ['[object Object]', /\[object Object\]/]]) {
    if (re.test(text)) problems.push(name);
  }
  const dash = text.match(DASH);
  if (dash) problems.push('横线:' + JSON.stringify(text.slice(Math.max(0, dash.index - 24), dash.index + 24)));
  if (/undefined|NaN|\[object Object\]/.test(text) === false && />(undefined|NaN)/.test(String(html))) problems.push('属性里的脏值');
  const size = String(html).length;
  if (size < 300) problems.push('产物过短(' + size + ')');
  if (problems.length) { fail++; console.log(`FAIL ${label}  ${problems.join(' | ')}`); }
  else console.log(`OK   ${label}  ${size} 字节`);
}

/* 1. 默认档（社群管理收起） */
console.log('--- 默认档 ---');
for (const [label, view, patch] of cases) {
  try { check(label, view.render(mkCtx(patch))); }
  catch (e) { fail++; console.log(`FAIL ${label}  抛异常 ${e.message}`); }
}

/* 2. 打开社群管理，重跑一遍运营页 */
console.log('\n--- 打开社群管理 ---');
setFeature('ops.community', true);
for (const [label, view, patch] of cases.filter((c) => c[1] === opsView)) {
  try { check(label, view.render(mkCtx(patch))); }
  catch (e) { fail++; console.log(`FAIL ${label}  抛异常 ${e.message}`); }
}

/* 3. 关掉经营后台和门店热度，确认 content 的二级分段能回落 */
console.log('\n--- 关掉经营后台 / 门店热度 / 内容台账 ---');
setFeature('ops.biz', false);
setFeature('ops.store', false);
setFeature('ops.ledger', false);
try {
  const html = opsView.render(mkCtx({ _opsSeg:'content', _contentSub:'biz' }));
  check('ops/content(biz 已收起)', html);
  if (!/data-csub="douyin"/.test(html)) { fail++; console.log('FAIL 二级分段没有回落到抖音账号'); }
} catch (e) { fail++; console.log('FAIL 抛异常 ' + e.message); }

/* 4. 清空经营记录后漏斗空态 */
console.log('\n--- 清空经营记录 ---');
store.clearBizRecords();
try { check('ops/content/biz(空态)', opsView.render(mkCtx({ _opsSeg:'content', _contentSub:'biz' }))); }
catch (e) { fail++; console.log('FAIL 抛异常 ' + e.message); }

/* 5. 未读清单：标记已读后条数要变化 */
console.log('\n--- 未读提醒 ---');
const ob = await import('./js/opsBrief.js');
const st = store.get();
const brief = ob.buildBrief(st);
const unread = ob.unreadOf(brief, ob.readIdsOf(st));
console.log(`今日 ${brief.items.length} 条，未读 ${unread.length} 条`);
const ids = unread.map((x) => x.id);
if (ids.length) {
  store.markBriefRead(ids);
  const after = ob.unreadOf(brief, ob.readIdsOf(store.get()));
  console.log(`全部标已读后未读 ${after.length} 条 ${after.length === 0 ? '（符合预期）' : '（不符合预期）'}`);
  if (after.length !== 0) fail++;
  /* id 必须稳定：重算一遍简报，同样的 id 仍然认作已读 */
  const brief2 = ob.buildBrief(store.get());
  const after2 = ob.unreadOf(brief2, ob.readIdsOf(store.get()));
  console.log(`重算简报后未读 ${after2.length} 条 ${after2.length === 0 ? '（id 稳定）' : '（id 不稳定，已读失效）'}`);
  if (after2.length !== 0) fail++;
  /* 跨天失效：把日期改成昨天，已读不该继续压住今天的提醒 */
  store.commit((s) => { s.opsBrief = { date: '2000-01-01', readIds: ids }; });
  const back = ob.unreadOf(ob.buildBrief(store.get()), ob.readIdsOf(store.get()));
  console.log(`日期改成昨天后未读 ${back.length} 条 ${back.length === ids.length ? '（跨天失效正常）' : '（跨天没失效）'}`);
  if (back.length !== ids.length) fail++;
} else {
  console.log('（没有未读，跳过已读链路）');
}

/* 6. 报表解析：一整块真实感的表头 */
console.log('\n--- 报表解析 ---');
const bm = await import('./js/bizMetrics.js');
const tsv = [
  '统计日期\t曝光人数\t商品访问人数\t私信开口人数\t团购下单人数\t核销人数\t推广消耗\t曝光转化率',
  '2026-09-25\t24800\t2610\t318\t38\t27\t600\t1.28%',
  '2026-09-25\t9200\t980\t102\t11\t8\t200\t1.11%',
  '2026-09-26\t26350\t2780\t341\t42\t30\t640\t1.29%',
  '合计\t60350\t6370\t761\t91\t65\t1440\t',
].join('\n');
const parsed = bm.parseBizReport(tsv, { sourceId: 'laike', fallbackDate: '2026-09-27' });
console.log(`表头 ${parsed.headers.length} 列，匹配 ${Object.keys(parsed.map).length} 个指标，读到 ${parsed.records.length} 行，跳过 ${parsed.skipped} 行`);
console.log(`未匹配列：${parsed.unmatched.join('、') || '（无）'}`);
const col = bm.collapseByDate(parsed.records);
console.log(`按日合并后 ${col.length} 天：${col.map((r) => r.date + '→曝光' + r.impression).join('  ')}`);
const agg = bm.sumBizRecords(col);
console.log('合计：' + bm.FUNNEL_ORDER.map((k) => bm.BIZ_METRIC_FIELDS.find((f) => f.key === k).label + ' ' + (agg[k] ?? '未获取')).join(' / '));
console.log('单开口成本：' + (bm.costPerOpen(agg) == null ? '未获取' : '¥' + bm.costPerOpen(agg)));

/* 7. 未到店预警子集：两档互斥、无记录不进档、久的排前面 */
console.log('\n--- 未到店预警 ---');
const cb = store.churnBuckets();
const inW7 = new Set(cb.w7.map((x) => x.m.id));
const overlap = cb.w21.filter((x) => inW7.has(x.m.id));
const noDataLeak = cb.w7.concat(cb.w21).filter((x) => !x.m.lastVisit);
const desc = (a) => a.every((x, i) => i === 0 || a[i - 1].days >= x.days);
console.log(`7 天档 ${cb.w7.length} 人  21 天档 ${cb.w21.length} 人  无打卡记录 ${cb.noData.length} 人`);
console.log(`21 天档天数：${cb.w21.map((x) => x.days).join(' / ') || '（空）'}`);
console.log(`7 天档天数：${cb.w7.map((x) => x.days).join(' / ') || '（空）'}`);
if (overlap.length) { fail++; console.log(`FAIL 两档重叠 ${overlap.length} 人，同一条线索会挂在两个名单上`); }
if (noDataLeak.length) { fail++; console.log(`FAIL 有 ${noDataLeak.length} 个没有打卡记录的人进了预警档`); }
if (!desc(cb.w7) || !desc(cb.w21)) { fail++; console.log('FAIL 未按未到店天数从久到近排'); }
if (!cb.w7.length || !cb.w21.length) { fail++; console.log('FAIL 示例数据里两档都该有人，否则截不出东西'); }
for (const st of ['silent7', 'silent21']) {
  try { check(`members/list/${st}`, membersView.render(mkCtx({ _tab: 'members', _stage: st }))); }
  catch (e) { fail++; console.log(`FAIL ${st} 抛异常 ${e.message}`); }
}

/* 8. 会籍卡按会员归组：姓名只在组头出现一次，卡一张不少 */
console.log('\n--- 会籍卡归组 ---');
const cardHtml = membersView.render(mkCtx({ _tab: 'members', _memberSeg: 'card', _cardFilter: 'all' }));
const groupCount = cardHtml.split('class="card-group"').length - 1;
const miniCount = cardHtml.split('class="mini-card"').length - 1;
const cardsInStore = store.get().cards;
const memberIds = new Set(cardsInStore.map((c) => c.memberId));
console.log(`归组 ${groupCount} 人  卡 ${miniCount} 张（库里 ${cardsInStore.length} 张）`);
if (miniCount !== cardsInStore.length) { fail++; console.log('FAIL 归组后卡片数量对不上，有卡被吞或重复'); }
if (groupCount !== memberIds.size) { fail++; console.log(`FAIL 归组数 ${groupCount} ≠ 有卡会员数 ${memberIds.size}`); }
/* 一人多卡（会籍 + 私教）：姓名不再逐卡重复 */
const multi = [...memberIds]
  .map((id) => ({ n: cardsInStore.filter((c) => c.memberId === id).length, m: store.memberById(id) }))
  .filter((x) => x.n >= 2 && x.m);
if (!multi.length) console.log('（示例数据里没有一人多卡，跳过姓名去重断言）');
for (const x of multi) {
  const times = cardHtml.split(x.m.name).length - 1;
  if (times !== 1) { fail++; console.log(`FAIL ${x.m.name} 有 ${x.n} 张卡，姓名却出现 ${times} 次（应为组头 1 次）`); }
  else console.log(`OK   ${x.m.name} ${x.n} 张卡，姓名只出现 1 次`);
}
try { check('members/card/grouped', cardHtml); }
catch (e) { fail++; console.log(`FAIL members/card 抛异常 ${e.message}`); }

console.log('\n' + (fail ? `共 ${fail} 项异常` : '全部通过'));

/* 9. 打卡日历：有明细的会员画月历 + 统计，无明细的诚实展示"尚未同步" */
console.log('\n--- 打卡日历 ---');
const sheets = await import('./js/sheets.js');
const ctxCal = mkCtx();
const mHas = store.memberById('m01');
const mNone = store.memberById('m10') || store.get().members.find((x) => !(x.checkins || []).length);
const htmlHas = sheets.renderCheckinCalendar(mHas, ctxCal);
const htmlNone = sheets.renderCheckinCalendar(mNone, ctxCal);
console.log(`m01 明细 ${mHas.checkins.length} 条  有数据日历含 cal-grid: ${/class="cal-grid"/.test(htmlHas)}  含统计格: ${/class="stat-grid g4"/.test(htmlHas)}`);
console.log(`无明细会员 ${mNone.id}（${mNone.checkins.length} 条）  含「尚未同步」: ${/尚未同步/.test(htmlNone)}`);
if (!/class="cal-grid"/.test(htmlHas)) { fail++; console.log('FAIL 有明细会员没渲染出日历网格'); }
if (!/class="stat-grid g4"/.test(htmlHas)) { fail++; console.log('FAIL 没渲染出周期性统计格'); }
if (!/尚未同步/.test(htmlNone)) { fail++; console.log('FAIL 无明细会员没展示「尚未同步」占位'); }
if (mHas.checkins.length && !new RegExp(`本周打卡`).test(htmlHas)) { fail++; console.log('FAIL 统计块缺「本周打卡」'); }
for (const [lbl, h] of [['m01 有明细', htmlHas], ['无明细', htmlNone]]) {
  const t = String(h).replace(/<[^>]+>/g, ' ');
  if (/undefined|NaN|\[object Object\]/.test(t)) { fail++; console.log(`FAIL ${lbl} 出现脏值`); }
  if (/[\u2014\u2013]|(?<![-])--(?![-])/.test(t)) { fail++; console.log(`FAIL ${lbl} 出现横线`); }
}

process.exit(fail ? 1 : 0);
