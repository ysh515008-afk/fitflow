/* 本轮六项改动的确定性校验：
   ① AI 资料 → AI 转写跟进   ② 记录跟进 → 跟进（缩窄）
   ③ 档案字段来源重标（自动 / 手动）  ④ 同事备注
   ⑤ 编辑资料里来源系统字段只读灰字  ⑥ 删除会员 → 永久流失

   只断言能确定判定的东西：文案是否改到位、只读字段是否真的没渲染成 input、
   标记后是否真的从名单里移出。不猜渲染效果，不写"应该没问题"这类断言。 */

const ls = new Map();
globalThis.localStorage = { getItem: (k) => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
globalThis.location = { hash: '', href: 'http://localhost/' };
globalThis.window = { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } };

/* 最小 DOM 桩：openSheet 要 getElementById / createElement / appendChild /
   querySelector，这里全给假节点，并把每次 createElement 的产物记下来 ——
   抽屉的 innerHTML 就在第一个产物上，测试靠它拿到渲染出的 HTML。 */
function makeDoc(sink) {
  const mkEl = (html = '', record = false) => {
    const el = {
      innerHTML: html, textContent: '', value: '', style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute() {}, appendChild() {}, remove() {}, addEventListener() {}, removeEventListener() {},
      querySelector() { return mkEl(); }, querySelectorAll() { return []; }, closest() { return null; },
    };
    if (record) sink.push(el);
    return el;
  };
  return {
    addEventListener() {}, removeEventListener() {},
    /* 只有 createElement 的产物要记：openSheet 先 getElementById('modalRoot')
       拿容器，再 createElement 造 mask —— 抽屉 HTML 写在 mask.innerHTML 上。
       不区分会让 sink[0] 变成容器，取到空字符串。 */
    getElementById() { return mkEl(); }, createElement() { return mkEl('', true); },
    querySelector() { return mkEl(); }, querySelectorAll() { return []; },
    body: mkEl(),
  };
}
globalThis.document = makeDoc([]);

const fs = await import('node:fs');
const store = await import('./js/store.js');
await store.init();
const sheets = await import('./js/sheets.js');
const { memberSheetBody, openMemberForm } = sheets;
const agentEngine = await import('./js/agentEngine.js');
const salesGrade = await import('./js/salesGrade.js');
const { computeMetrics } = await import('./js/metrics.js');

let bad = 0;
const ok = (c, l, e) => { if (c) console.log('OK   ' + l + (e ? '  ' + e : '')); else { bad++; console.log('FAIL ' + l + (e ? '  ' + e : '')); } };

/** 跑一个会开抽屉的函数，返回抽屉渲染出的 HTML */
function captureForm(fn) {
  const sink = [];
  const prev = globalThis.document;
  globalThis.document = makeDoc(sink);
  let err = null;
  try { fn(); } catch (e) { err = e; }
  globalThis.document = prev;
  if (err) return 'ERR:' + err.message;
  return sink.length ? String(sink[0].innerHTML) : '';
}

const src = {
  sheets: fs.readFileSync('js/sheets.js', 'utf8'),
  store: fs.readFileSync('js/store.js', 'utf8'),
  ai: fs.readFileSync('js/aiMaterial.js', 'utf8'),
  css: fs.readFileSync('styles.css', 'utf8'),
};
/* 源码扫描只扫 js/ 下三个目录，测试脚本里的历史文案不算 */
const jsFiles = ['js', 'js/views', 'js/data']
  .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(d + '/' + f, 'utf8')))
  .join('\n');

console.log('=== 1. 改名：AI 资料 → AI 转写跟进 ===');
ok(!/AI 资料/.test(jsFiles), 'js/ 下已无「AI 资料」字样');
ok(/AI 转写跟进/.test(src.sheets), 'sheets.js 有「AI 转写跟进」');
ok(/title: 'AI 转写跟进'/.test(src.ai), '抽屉标题已改');
ok(/\['aimat', `AI 转写跟进/.test(src.sheets), '档案标签名已改');

console.log('\n=== 2. 记录跟进 → 跟进（图标与配色不变，宽度缩窄）===');
ok(!/记录跟进/.test(jsFiles), 'js/ 下已无「记录跟进」');
ok(/class="btn primary narrow" data-act="follow"/.test(src.sheets), '仍是 primary（颜色不变）+ narrow（缩窄）');
ok(/data-act="follow"[^>]*>#i-plus/.test(src.sheets.replace(/<svg viewBox="0 0 24 24"><use href="#/g, '#')), '图标仍是 i-plus');
ok(/\.btn\.narrow\{flex:0 0 auto;padding:0 12px/.test(src.css), 'CSS 有 .btn.narrow 且不参与 1fr 均分');
ok(/\.btn-row \.btn\.narrow\{flex:0 0 auto\}/.test(src.css), '.btn-row 内 narrow 优先级已覆盖');

console.log('\n=== 3. 档案字段来源重标 ===');
const s0 = store.get();
const ctx = { state: s0, metrics: computeMetrics(s0), _memberTab: 'profile', _tab: 'members' };
const m1 = store.memberById('m01');
const profile = memberSheetBody(m1.id, 'profile', ctx);
const rowOf = (html, key) => {
  const i = html.indexOf(`<div class="k">${key}</div>`);
  return i < 0 ? null : html.slice(i, i + 400);
};
ok(/系统同步（自动）/.test(profile), '档案里有「系统同步（自动）」分组');
ok(/手动登记/.test(profile), '档案里有「手动登记」分组');
for (const k of ['训练目标', '主要需求', '顾虑 / 阻碍']) {
  const r = rowOf(profile, k);
  ok(!!r && (/manual-chip/.test(r) || />未登记</.test(r)), `${k} 标为手动`, r ? '' : '没找到这一行');
}
ok(/未登记/.test(profile), '手动字段空值是「未登记」');
ok(/未获取/.test(profile), '自动字段空值仍是「未获取」');
ok(/三体与勤鸟都不返回/.test(profile), '说明了这三项来源系统不返回');
for (const k of ['累计消费', '私教 / 课时', '近 30 天到店', '最近到店', '入会日期', '会籍到期', '标签']) {
  const r = rowOf(profile, k);
  ok(!!r && /auto-chip/.test(r), `${k} 标为自动`, r ? '' : '没找到这一行');
}
/* 「删除会员」只许出现在解释性文案里（说明永久流失与删除的区别），
   不许再作为按钮或 action 存在 */
ok(!/data-act="del"/.test(src.sheets), 'sheets.js 已无删除动作 data-act="del"');
ok(!/>删除会员</.test(src.sheets), 'sheets.js 已无「删除会员」按钮');
ok(!/deleteMember\(/.test(src.sheets), 'sheets.js 不再调用 deleteMember');
ok(/永久流失/.test(src.sheets), 'sheets.js 有「永久流失」');
ok(/data-act="lost"/.test(src.sheets), '有永久流失动作入口');

console.log('\n=== 4. 同事备注（备注人 + 内容）===');
ok(/function colleagueNotesHtml/.test(src.sheets), '有同事备注渲染函数');
ok(/export function addColleagueNote/.test(src.store), 'store 有 addColleagueNote');
ok(/export function deleteColleagueNote/.test(src.store), 'store 有 deleteColleagueNote');
ok(/export const colleagueNotesOf/.test(src.store), 'store 有 colleagueNotesOf');
ok(/colleagueNotes: m\.colleagueNotes \|\| \[\]/.test(src.store), 'migrate 兜底 colleagueNotes');
ok(/同事备注/.test(profile), '档案里出现「同事备注」小节');
ok(/补一条同事备注/.test(profile), '有补录入口');
const n1 = store.addColleagueNote(m1.id, { author: '王教练', text: '今天体测后主动问了产后修复课' });
ok(n1 && n1.id && n1.author === '王教练', '补录成功', n1 && n1.id);
ok(store.colleagueNotesOf(m1.id).length === 1, '能读回来');
const p2 = memberSheetBody(m1.id, 'profile', ctx);
ok(/王教练/.test(p2) && /产后修复课/.test(p2), '备注人与内容都渲染出来');
ok(/本地补录/.test(p2), '标出「本地补录」来源');
ok(/data-act="cn-del:/.test(p2), '本地条目带删除按钮');
/* 同步来的条目只读：塞一条 source=santi 的，不应出现删除按钮 */
const m1ref = store.memberById(m1.id);
m1ref.colleagueNotes.unshift({ id: 'cn_sync_x', author: '李教练', text: '同步来的备注', at: '2026-09-20', source: 'santi' });
const p3 = memberSheetBody(m1.id, 'profile', ctx);
ok(/三体同步/.test(p3), '同步条目标出「三体同步」');
ok(!/data-act="cn-del:cn_sync_x"/.test(p3), '同步条目没有删除按钮（只读）');
store.deleteColleagueNote(m1.id, 'cn_sync_x');
ok(store.colleagueNotesOf(m1.id).some((n) => n.id === 'cn_sync_x'), '同步条目删不掉（源头在来源系统）');
store.deleteColleagueNote(m1.id, n1.id);
ok(!store.colleagueNotesOf(m1.id).some((n) => n.id === n1.id), '本地条目能删');
m1ref.colleagueNotes = [];

console.log('\n=== 5. 编辑资料：来源系统字段只读灰字 ===');
const synced = store.get().members.find((m) => m.triId || m.qinniaoId);
ok(!!synced, 'seed 里存在带来源系统 ID 的会员', synced && synced.name);
if (synced) {
  const fh = captureForm(() => openMemberForm(synced.id, ctx, () => {}));
  ok(!/^ERR:/.test(fh), '表单能渲染', fh.slice(0, 80));
  ok(/sys-ro/.test(fh), '表单里有只读灰字段');
  ok(/ro-tag/.test(fh), '只读字段带来源标记');
  ok(/三体 · 只读|勤鸟 · 只读/.test(fh), '标记写明了来源系统');
  ok(/<div class="ro-val">/.test(fh), '只读值用 ro-val 呈现');
  ok(!/<input[^>]*name="name"/.test(fh), '姓名字段没有渲染成可编辑 input（同步档案）');
  ok(!/<input[^>]*name="totalPaid"/.test(fh), '累计消费没有渲染成可编辑 input');
}
const local = store.get().members.find((m) => !m.triId && !m.qinniaoId);
if (local) {
  const fh2 = captureForm(() => openMemberForm(local.id, ctx, () => {}));
  ok(/<input[^>]*name="name"/.test(fh2), '本机自建档案姓名仍是可编辑 input');
} else {
  console.log('SKIP 本机自建档案（seed 里全是同步档案）');
}
const nf = captureForm(() => openMemberForm(null, ctx, () => {}));
ok(/<input[^>]*name="name"/.test(nf), '新增档案姓名可编辑');

console.log('\n=== 6. 永久流失 ===');
ok(/export function markMemberLost/.test(src.store), 'store 有 markMemberLost');
ok(/export function restoreMember/.test(src.store), 'store 有 restoreMember');
ok(/export const liveMembers/.test(src.store), 'store 有 liveMembers');
const before = store.liveMembers().length;
const victim = store.get().members[0];
store.markMemberLost(victim.id, '搬离本区');
ok(store.liveMembers().length === before - 1, '标记后从日常名单移出', `${before} → ${store.liveMembers().length}`);
ok(store.lostMembers().length === 1, '进入流失名单');
ok(!!store.memberById(victim.id), '档案本身还在（没被删除）');
const cmdList = agentEngine.commandCenter(store.get(), 1e9, {});
ok(!cmdList.some((x) => x.member && x.member.id === victim.id), '不再出现在智能体客户卡列表');
const roster = salesGrade.gradeRoster(store.get());
ok(!roster.list.some((x) => x.m.id === victim.id), '不再进入销售等级名册');
ok(!store.todayQueue().some((x) => x.member && x.member.id === victim.id), '不再进入今日队列');
const lostProfile = memberSheetBody(victim.id, 'profile', ctx);
ok(/恢复档案/.test(lostProfile), '流失会员档案里出现「恢复档案」');
ok(/搬离本区/.test(lostProfile), '流失原因显示出来');
store.restoreMember(victim.id);
ok(store.liveMembers().length === before, '恢复后回到日常名单');
ok(!store.memberById(victim.id).lostReason, '恢复后流失原因清空');

console.log('\n=== 7. 无脏值 ===');
const all = profile + p2 + p3 + lostProfile;
ok(!/undefined/.test(all), '渲染产物没有 undefined');
ok(!/NaN/.test(all), '渲染产物没有 NaN');
ok(!/\[object Object\]/.test(all), '渲染产物没有 [object Object]');

console.log('\n' + (bad ? `❌ ${bad} 项未通过` : '✅ 全部通过'));
process.exit(bad ? 1 : 0);
