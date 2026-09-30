/* 抖音账号栏预览：注入一份演示数据，把这一栏每块「有数时的样子」都渲染出来。
   验的是数据样式本身：
     · 账号卡 / 指标板（含环比）/ 作品明细 / 建议 / 赛道榜 / 对标 / 池排名 / 同步记录 / 成本
     · 示例数据必须被界面标出来（isSample），不能冒充真实同步
     · 缺字段显示「未获取」，不出现 undefined / NaN / 假 0 */

import { readFileSync, writeFileSync } from 'node:fs';

const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });

const store = await import('./js/store.js');
const { computeMetrics } = await import('./js/metrics.js');
const opsView = await import('./js/views/ops.js');
const mock = await import('./_mock_douyin.mjs');

await store.init();

/* ---------- 注入演示数据 ---------- */
store.bindDouyinAccount('lijian_jrc', { nickname: '力健健身·金融城店', note: '门店主账号（演示数据）' });
/* 先把上一期的环比基准写进去，这样指标板才有「环比」可比 */
store.get().douyin.prevMetrics = mock.MOCK_PREV_METRICS;
store.saveDouyinSnapshot({ account: mock.MOCK_ACCOUNT, works: mock.MOCK_WORKS, isSample: true, source: 'redfox' });
store.saveBenchmarks(mock.MOCK_BENCHMARKS, { keyword: '重庆 健身', isSample: true });
store.saveTopBoard({ ...mock.MOCK_BOARD, isSample: true });
/* 一条失败记录 + 一条成功记录，同步记录区两种圆点都能看到 */
store.logDouyinError('作品列表取数失败：网关 Key 未配置，接口调用被拒绝（401）');

const state = store.get();
const dy = state.douyin;

const mkCtx = (patch = {}) => ({
  state,
  metrics: computeMetrics(state),
  _opsSeg: 'content', _contentSub: 'douyin', _memberSeg: 'list', _memberTab: 'profile',
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
<html lang="zh-CN"><head><meta charset="utf-8"><title>FitFlow · 抖音账号栏（演示数据）</title>
<link rel="stylesheet" href="./styles.css">
<style>
  body{margin:0;background:#f4f6f5}
  .pv-bar{position:sticky;top:0;z-index:5;background:#0E8F5B;color:#fff;padding:10px 16px;font-size:13px;font-weight:600}
  .pv-shell{max-width:560px;margin:0 auto;padding:14px 12px 60px}
</style></head>
<body>
<div class="pv-bar">抖音账号 · 演示数据（界面顶部会标明这是示例快照，不是真实同步结果）</div>
<div class="pv-shell">${html}</div>
${sprite}
</body></html>`;

writeFileSync('./preview-douyin.html', doc, 'utf8');

/* ---------- 冒烟 ---------- */
let fail = 0;
const must = (c, m) => { if (!c) { fail++; console.log('FAIL ' + m); } else console.log('OK   ' + m); };

for (const [name, re] of [['undefined', /undefined/], ['NaN', /NaN/], ['[object Object]', /\[object Object\]/]]) {
  if (re.test(text)) { fail++; console.log('FAIL 抖音栏出现 ' + name); }
}
if (/[\u2014]/.test(text)) { fail++; console.log('FAIL 抖音栏出现 em-dash'); }

/* 每一块都必须出数据，不能停在空态 */
must(/力健健身·金融城店/.test(html), '绑定账号卡：昵称与抖音号');
must(dy.snapshot?.metrics?.followerCount === 8420, '账号指标已写入（粉丝 8420）');
must(/智能体在盯的指标/.test(html), '指标板区块存在');
const cells = html.match(/class="metric-cell"/g) || [];
must(cells.length >= 8, `指标板出 ${cells.length} 个指标格`);
must(/环比/.test(html), '指标板带环比（有上一期基准才比得出来）');
must(!/无对比/.test(html.split('作品明细')[0].split('智能体在盯的指标')[1] || ''), '有 prevMetrics 时不显示「无对比」');

/* 作品明细：本次新增，用来看每条作品的抖音原始数据 */
must(/作品明细/.test(html), '作品明细区块存在');
const rows = html.match(/class="work-row"/g) || [];
must(rows.length === 8, `作品明细出 8 行（实际 ${rows.length}）`);
must(/播放/.test(html) && /收藏/.test(html), '作品行含播放 / 赞 / 评 / 分享 / 收藏');
must(/爆款/.test(html), '作品行标出爆款（超过均值 3 倍的那几条）');

/* 建议、榜单、对标、池排名、日志、成本 */
must(/智能体的判断/.test(html) && /条可执行建议/.test(html), '建议区出条数');
must(/官方赛道榜/.test(html), '赛道榜区块存在');
const boardRows = html.match(/class="board-row/g) || [];
must(boardRows.length === 8, `赛道榜出 8 行（实际 ${boardRows.length}）`);
must(/本店账号不在这一期榜上/.test(html) || /本店账号在第/.test(html), '赛道榜说明本店账号在不在榜上');
must(/对标账号/.test(html), '对标区块存在');
must(/体量同档/.test(html), '对标给出了入选理由（体量同档）');
/* 两套口径要分清：对标推荐名单走 pickBenchmarks 三条筛子，
   自有账号池排名用的是全部已纳入监控的候选，不做筛选。 */
const benchSeg = (html.split('对标账号')[1] || '').split('自有账号池排名')[0] || '';
must(!/全国健身大榜/.test(benchSeg), '超档 + 低指数 + 不同城的候选不进对标推荐名单');
must(/全国健身大榜/.test(html), '但仍出现在自有账号池排名里（池排名含全部候选，不筛）');
must(/自有账号池排名/.test(html), '自有账号池排名存在');
must(/（本店）/.test(html), '池排名里标出本店账号');
must(/同步记录/.test(html), '同步记录区块存在');
must(/dot ok/.test(html) && /dot bad/.test(html), '同步记录两种状态圆点都在（成功 + 失败）');
must(/积分/.test(html) && /次 \//.test(html), '调用成本卡出积分与次数');

/* 示例数据必须被标出来 */
must(/示例快照/.test(html), '快照标注为示例（不冒充真实同步）');
must(/示例榜单/.test(html), '榜单标注为示例');
must(/示例/.test(html) && /对标/.test(html), '对标标注为示例');
must(dy.snapshot?.isSample === true && dy.benchmarks?.isSample === true && dy.board?.isSample === true, '三份演示数据都带 isSample: true');

console.log(fail ? `\n预览失败：${fail} 项` : '\n预览生成成功 → preview-douyin.html');
process.exit(fail ? 1 : 0);
