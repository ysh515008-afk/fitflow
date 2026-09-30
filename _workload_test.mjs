/* 今日工作量（操作量 / 观察量）冒烟：
   验证计数、跨天清零、去重（同一条视频不重复计数）、只在真正完成时计数。 */

const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });

const store = await import('./js/store.js');
await store.init();

let fail = 0;
const must = (c, m) => { if (!c) { fail++; console.log('FAIL ' + m); } else console.log('OK   ' + m); };
const w = () => store.todayWorkload(store.get());
const t = (a, b) => w().ops === a && w().obs === b;

must(t(0, 0), `初始 0/0（实际 ${w().ops}/${w().obs}）`);

/* 1 操作量：写一条跟进备注 */
store.addFollowup({ memberId: 'm01', channel: 'wechat', summary: '测试跟进备注', result: 'neutral' });
must(t(1, 0), `跟进备注 1 次 → 操作量 1（实际 ${w().ops}/${w().obs}）`);

/* 2 操作量：成长课时标到「已完成」才计数。
   seed 的 progress 首个课题 t01 初始就是 done，直接循环会走 done→todo→doing，
   两次都不该计数。所以先把课题显式复位到 todo，再验证状态机。 */
const prog = store.get().learning.progress || {};
const topicId = Object.keys(prog)[0];
if (!topicId) {
  console.log('（learning.progress 为空，跳过课时用例）');
} else {
  store.setTopicProgress(topicId, { status: 'todo' });
  const before = w().ops;
  /* 第一下：todo → doing，不该计数 */
  store.cycleTopicStatus(topicId);
  const mid = w().ops;
  must(mid === before, `标成「进行中」不计操作量（${before} → ${mid}）`);
  /* 第二下：doing → done，计 1 次 */
  store.cycleTopicStatus(topicId);
  const after = w().ops;
  must(after === before + 1, `标成「已完成」计 1 次操作量（${mid} → ${after}）`);
  /* 第三下：done → todo（取消完成），不倒扣也不再加 */
  store.cycleTopicStatus(topicId);
  must(w().ops === after, `取消完成不倒扣也不再加（仍为 ${w().ops}）`);
}

/* 3 操作量：抖音新发布的视频，按新出现的条数计，重复同步不重复计数 */
const before3 = w().ops;
store.saveDouyinSnapshot({ account: { remoteId: 'lijian_jrc' }, works: [{ remoteId: 'new-v1' }, { remoteId: 'new-v2' }] });
const after3 = w().ops;
must(after3 === before3 + 2, `新发布 2 条视频 → 操作量 +2（实际 +${after3 - before3}）`);
store.saveDouyinSnapshot({ account: { remoteId: 'lijian_jrc' }, works: [{ remoteId: 'new-v1' }, { remoteId: 'new-v2' }] });
must(w().ops === after3, `重复同步同一批视频不再计数（仍为 ${w().ops}）`);
store.saveDouyinSnapshot({ account: { remoteId: 'lijian_jrc' }, works: [{ remoteId: 'new-v1' }, { remoteId: 'new-v2' }, { remoteId: 'new-v3' }] });
must(w().ops === after3 + 1, `再新发 1 条 → 只 +1（实际 ${w().ops}）`);

/* 4 观察量：独立调用 */
const before4 = w().obs;
store.bumpWorkload('obs');
must(w().obs === before4 + 1, `bumpWorkload('obs') → 观察量 +1（实际 ${w().obs}）`);

/* 5 跨天清零：把日期改成昨天，todayWorkload 必须返回 0，不能返回昨天的存量 */
const st = store.get();
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
st.workload = { date: yesterday, ops: 99, obs: 88 };
must(store.todayWorkload(st).ops === 0 && store.todayWorkload(st).obs === 0, '跨天后 todayWorkload 返回 0/0（不返回昨天存量）');
store.bumpWorkload('ops');
must(w().ops === 1 && w().obs === 0, `跨天后首次计数重置为 1/0（实际 ${w().ops}/${w().obs}）`);

/* 6 非法值不产生 NaN */
st.workload = { date: new Date().toISOString().slice(0, 10), ops: 3, obs: 2 };
store.bumpWorkload('ops', 0);
store.bumpWorkload('ops', -5);
must(w().ops === 3, `0 / 负数不加也不出 NaN（实际 ${w().ops}）`);

console.log(fail ? `\n工作量统计失败：${fail} 项` : '\n工作量统计全部通过');
process.exit(fail ? 1 : 0);
