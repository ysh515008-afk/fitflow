/* ============================================================
   douyin.js · 抖音账号监控业务层
   ------------------------------------------------------------
   它不发网络请求（那是 integrations/redfox.js 的事），只做四件事：
     1. 定义"该监控哪些维度"，以及每个维度的口径
     2. 从真实快照派生指标，并和上一次快照算环比
     3. 基于真实指标出优化建议，规则即数据
     4. 定义门店热度监控区每一项的数据来源与可得性

   贯穿这个文件的一条硬规则：
     **没有快照就不出建议。**
   编一条听起来很合理的建议，比留空更糟 —— 运营会照它去改动作。

   接口可得性结论（2026-09-27 核对，证据见各项 basis）：
     · 账号维度、作品列表、关键词搜账号、关键词搜作品 → 红狐有
     · 门店 POI、评论内容、绿标白标带货        → 红狐没有，逐项标不可用
   ============================================================ */
import { parseDate, toDateStr, isNum, compact, round1, mean, median } from './util.js';

/** 界面里格式化计数用，实现在 util.js 的 compact，不另写一份 */
export const fmtCount = compact;

/* ============================================================
   1. 可监控维度
   ------------------------------------------------------------
   better 决定"涨了算好还是算坏"。别的都涨为好，只有发布间隔是越短越好。
   每一项都必须能追到一个真实字段，追不到的一律不进这张表。
   ============================================================ */
export const MONITOR_DIMS = [
  { key: 'followerCount', label: '粉丝数', unit: '人', better: 'up', from: 'account' },
  { key: 'awemeCount', label: '作品总数', unit: '条', better: 'up', from: 'account' },
  { key: 'totalFavorited', label: '累计获赞', unit: '', better: 'up', from: 'account' },
  { key: 'redfoxIndex', label: '红狐指数', unit: '', better: 'up', from: 'account' },
  { key: 'avgPlay', label: '平均播放', unit: '', better: 'up', from: 'works' },
  { key: 'avgDigg', label: '平均点赞', unit: '', better: 'up', from: 'works' },
  { key: 'avgComment', label: '平均评论', unit: '', better: 'up', from: 'works' },
  { key: 'engRate', label: '互动率', unit: '%', better: 'up', from: 'works', format: 'pct' },
  { key: 'commentRate', label: '评论意愿', unit: '%', better: 'up', from: 'works', format: 'pct' },
  { key: 'hitRate', label: '爆款率', unit: '%', better: 'up', from: 'works', format: 'pct' },
  { key: 'weeklyPosts', label: '周更条数', unit: '条', better: 'up', from: 'works' },
  { key: 'postGapDays', label: '平均发布间隔', unit: '天', better: 'down', from: 'works' },
];

export function fmtMetric(dim, v) {
  if (!isNum(v)) return '未获取';
  if (dim.format === 'pct') return (v * 100).toFixed(1) + '%';
  if (dim.key === 'avgPlay' || dim.key === 'avgDigg' || dim.key === 'avgComment') return compact(v);
  if (dim.unit === '人' || dim.key === 'totalFavorited') return compact(v);
  return String(round1(v));
}

/* ============================================================
   2. 指标派生
   ============================================================ */

/** 相邻两次发布之间的天数间隔 */
function postGaps(works) {
  const ts = works
    .map((w) => parseDate(w.createTime))
    .filter(Boolean)
    .map((x) => x.getTime())
    .sort((a, b) => b - a);
  const out = [];
  for (let i = 1; i < ts.length; i++) {
    const days = (ts[i - 1] - ts[i]) / 86400000;
    if (days > 0) out.push(days);
  }
  return out;
}

/**
 * 从账号维度 + 作品列表派生指标。
 *
 * 三个刻意的"算不出就 null"：
 *   · 播放量官方脚本注明可能为 null，缺了就不算平均播放，
 *     也不用点赞去顶替播放算互动率 —— 那会让口径悄悄变掉。
 *   · 爆款率样本少于 8 条不报，样本太少会给出 25% 这种噪声值。
 *   · 评论意愿 = 评论 / 点赞。点赞拿不到就没法算。
 */
export function deriveMetrics(account, works) {
  const ws = (works || []).filter(Boolean);
  const acc = account || {};
  const nums = (key) => ws.map((w) => w[key]).filter(isNum);

  const plays = nums('playCount');
  const diggs = nums('diggCount');
  const comments = nums('commentCount');
  const shares = nums('shareCount');

  const avgPlay = mean(plays);
  const avgDigg = mean(diggs);
  const avgComment = mean(comments);
  const avgShare = mean(shares);

  const hasAcc = ['followerCount', 'awemeCount', 'totalFavorited', 'redfoxIndex'].some((k) => isNum(acc[k]));
  if (!hasAcc && !ws.length) return null;

  const engRate = (isNum(avgPlay) && avgPlay > 0 && isNum(avgDigg))
    ? (avgDigg + (avgComment || 0) + (avgShare || 0)) / avgPlay
    : null;

  const commentRate = (isNum(avgDigg) && avgDigg > 0 && isNum(avgComment)) ? avgComment / avgDigg : null;

  const hitRate = (plays.length >= 8 && isNum(avgPlay) && avgPlay > 0)
    ? plays.filter((p) => p > avgPlay * 3).length / plays.length
    : null;

  const gaps = postGaps(ws);
  const postGapDays = median(gaps);
  const weeklyPosts = postGapDays ? 7 / postGapDays : null;

  return {
    followerCount: isNum(acc.followerCount) ? acc.followerCount : null,
    awemeCount: isNum(acc.awemeCount) ? acc.awemeCount : null,
    totalFavorited: isNum(acc.totalFavorited) ? acc.totalFavorited : null,
    redfoxIndex: isNum(acc.redfoxIndex) ? acc.redfoxIndex : null,
    region: acc.region || null,

    sampleSize: ws.length,
    playSample: plays.length,
    avgPlay: isNum(avgPlay) ? avgPlay : null,
    avgDigg: isNum(avgDigg) ? avgDigg : null,
    avgComment: isNum(avgComment) ? avgComment : null,
    engRate,
    commentRate,
    hitRate,
    postGapDays: round1(postGapDays),
    weeklyPosts: round1(weeklyPosts),
  };
}

/** 环比：只对两边都有数的维度算，缺一边就不给数字 */
export function diffMetrics(cur, prev) {
  if (!cur || !prev) return {};
  const out = {};
  MONITOR_DIMS.forEach(({ key }) => {
    const a = cur[key], b = prev[key];
    if (!isNum(a) || !isNum(b)) return;
    out[key] = { delta: round1(a - b), pct: b !== 0 ? (a - b) / Math.abs(b) : null };
  });
  return out;
}

/** 一个维度当前算好还是算坏，用于上色。拿不到差异时返回 neutral。 */
export function trendOf(dim, diff) {
  const d = diff[dim.key];
  if (!d || d.delta === 0) return 'neutral';
  const rising = d.delta > 0;
  const good = dim.better === 'up' ? rising : !rising;
  return good ? 'good' : 'bad';
}

/* ============================================================
   3. 优化建议
   ------------------------------------------------------------
   规则即数据：每条规则自己判断要不要触发，自己写清楚依据。
   阈值都是能解释的经验值，写进 detail 里，方便以后按实际数据回调。
   ============================================================ */
export const ADVICE_RULES = [
  {
    id: 'freq_low',
    level: 'warn',
    when: (m) => isNum(m.weeklyPosts) && m.weeklyPosts < 2,
    title: '更新频率低于每周 2 条',
    detail: (m) => `按最近 ${m.sampleSize} 条作品的中位间隔 ${m.postGapDays} 天算，现在周更约 ${m.weeklyPosts} 条。`,
    action: '先把节拍拉到每周 2 条，再谈选题优化。推荐权重对断更的敏感度高于单条质量。',
  },
  {
    id: 'gap_break',
    level: 'warn',
    when: (m) => isNum(m.postGapDays) && m.postGapDays > 10,
    title: '存在明显断更',
    detail: (m) => `平均发布间隔 ${m.postGapDays} 天，已经超过 10 天。`,
    action: '用存量素材先补一条稳定军心，别等下一个"完美选题"。',
  },
  {
    id: 'hit_low',
    level: 'warn',
    when: (m) => isNum(m.hitRate) && m.hitRate < 0.1 && m.playSample >= 8,
    title: '爆款率偏低，选题集中度不够',
    detail: (m) => `${m.playSample} 条里只有 ${Math.round(m.hitRate * m.playSample)} 条播放超过自身均值 3 倍，爆款率 ${(m.hitRate * 100).toFixed(1)}%。`,
    action: '把播放最高的那条拆成 3 个同母题变体连着发。抖音靠单条爆款拉账号，不靠平均分。',
  },
  {
    id: 'comment_cold',
    level: 'info',
    when: (m) => isNum(m.commentRate) && m.commentRate < 0.02,
    title: '评论区偏冷',
    detail: (m) => `评论 / 点赞 = ${(m.commentRate * 100).toFixed(1)}%，低于 2%。`,
    action: '结尾抛一个二选一的问题（"你更怕练腿还是练背"），选择题比开放题的回评率高得多。',
  },
  {
    id: 'eng_drop',
    level: 'warn',
    when: (m, d) => isNum(d.engRate?.pct) && d.engRate.pct < -0.2,
    title: '互动率环比下滑',
    detail: (m, d) => `互动率 ${(m.engRate * 100).toFixed(1)}%，比上次同步低 ${Math.abs(d.engRate.pct * 100).toFixed(0)}%。`,
    action: '先看是不是换了选题方向。互动率掉得比播放快，通常是内容跑偏而不是流量变差。',
  },
  {
    id: 'play_drop',
    level: 'warn',
    when: (m, d) => isNum(d.avgPlay?.pct) && d.avgPlay.pct < -0.3,
    title: '平均播放大幅下滑',
    detail: (m, d) => `平均播放 ${compact(m.avgPlay)}，比上次同步低 ${Math.abs(d.avgPlay.pct * 100).toFixed(0)}%。`,
    action: '核对是否集中发布了几条低完播内容。平均播放被拉低，会把后续内容的初始推荐量一起带走。',
  },
  {
    id: 'index_up_play_down',
    level: 'good',
    when: (m, d) => isNum(d.redfoxIndex?.delta) && d.redfoxIndex.delta > 0 && isNum(d.avgPlay?.pct) && d.avgPlay.pct < -0.1,
    title: '指数在涨，但新内容没接住',
    detail: (m, d) => `红狐指数涨了 ${d.redfoxIndex.delta}，平均播放却掉了 ${Math.abs(d.avgPlay.pct * 100).toFixed(0)}%。`,
    action: '存量作品还在被持续推荐，吃的是老内容的红利。趁指数在高位赶紧补新内容，别等流量退潮。',
  },
  {
    id: 'fan_up_work_flat',
    level: 'info',
    when: (m, d) => isNum(d.followerCount?.delta) && d.followerCount.delta > 0 && d.awemeCount?.delta === 0,
    title: '涨粉没靠新作品',
    detail: (m, d) => `粉丝涨了 ${compact(d.followerCount.delta)}，作品数没变。`,
    action: '涨粉来自老内容或搜索。把被搜得最多的那条做成合集或置顶，能把这波流量留住。',
  },
];

/**
 * 出建议。返回 { items, reason }。
 * items 为空时 reason 一定不为空 —— 界面永远有话说，不留白也不编造。
 */
export function buildAdvice(metrics, diff = {}) {
  if (!metrics) {
    return {
      items: [],
      reason: '还没有账号快照。绑定抖音号并同步一次之后，这里才会出建议。没数据就编一条，运营照着改反而更亏。',
    };
  }
  const items = ADVICE_RULES
    .filter((r) => { try { return r.when(metrics, diff); } catch { return false; } })
    .map((r) => ({ id: r.id, level: r.level, title: r.title, detail: r.detail(metrics, diff), action: r.action }))
    .slice(0, 5);

  return {
    items,
    reason: items.length ? '' : '各项指标都在合理区间，没有需要立刻动的地方。保持节拍即可。',
  };
}

/* ============================================================
   4. 对标账号
   ------------------------------------------------------------
   候选来自「关键词搜索抖音账号」。这里只做筛选，不负责取数。
   筛选口径写死在代码里，因为它就是业务判断，不该藏进配置。
   ============================================================ */
export function pickBenchmarks(candidates, mine) {
  const list = (candidates || []).filter((c) => c && c.remoteId);
  const scored = list.map((c) => {
    const reasons = [];
    const ratio = (isNum(mine?.followerCount) && mine.followerCount > 0 && isNum(c.followerCount))
      ? c.followerCount / mine.followerCount
      : null;

    if (isNum(ratio) && ratio >= 0.5 && ratio <= 5) {
      reasons.push(`体量同档（本店账号的 ${ratio.toFixed(1)} 倍），做法可复制`);
    }
    if (isNum(mine?.redfoxIndex) && isNum(c.redfoxIndex) && c.redfoxIndex > mine.redfoxIndex) {
      reasons.push(`红狐指数 ${c.redfoxIndex}，高于本店账号的 ${mine.redfoxIndex}`);
    }
    if (c.region && mine?.region && c.region === mine.region) {
      reasons.push(`同地区（${c.region}），选题更贴近本地客群`);
    }
    return { ...c, followerRatio: isNum(ratio) ? round1(ratio) : null, reasons, score: reasons.length };
  });

  return scored
    .filter((c) => c.reasons.length > 0)
    .sort((a, b) => b.score - a.score || (b.followerCount || 0) - (a.followerCount || 0))
    .slice(0, 6);
}

/** 账号排名：本地口径，按某个指标降序，范围仅限手里已有的账号 */
export function rankAccounts(list, metricKey = 'followerCount') {
  return (list || [])
    .filter((x) => x && isNum(x[metricKey]))
    .sort((a, b) => b[metricKey] - a[metricKey])
    .map((x, i) => ({ ...x, rank: i + 1 }));
}

/* ============================================================
   5. 门店热度监控区：口径与可得性
   ------------------------------------------------------------
   用户要四样东西，红狐能给的程度完全不同。
   这里把"能给到什么程度、依据是什么、兜底怎么办"一次写清，
   界面直接读这张表渲染，不在视图里偷偷降级。
   ============================================================ */
/**
 * manualOnly：这一项是不是「只能靠手工登记才出得来数」。
 * 判定机制是确定的 —— 看 storeHeat.manual 有没有接口写入口：
 * 目前 upsertStoreHeatManual() 是唯一写入方，关键词召回只返回列表、不落库，
 * 所以凡是走登记按钮的项都是 manualOnly: true，界面据此决定展不展示。
 */
export const STORE_HEAT_ITEMS = [
  {
    key: 'poiWorks',
    label: '门店定位下发布视频',
    availability: 'approximate',
    availabilityLabel: '关键词近似',
    manualOnly: true,
    source: '红狐 · 关键词搜抖音作品',
    basis: '红狐全 API 目录没有 POI / 位置维度接口，实测也没有任何地域筛选参数。抖音本地生活的门店口径红狐不对外提供。',
    way: '用关键词搜作品，按门店名 + 商圈词（金融城 / 江北嘴 / 解放碑）召回。命中只能说明内容提到了这个位置，不等于挂了门店 POI。当热度参考可以，当门店口径不行。',
  },
  {
    key: 'commentTalk',
    label: '评论区讨论关联度',
    availability: 'unavailable',
    availabilityLabel: '接口不可用',
    manualOnly: true,
    source: '手工登记',
    basis: '已逐字段核对「获取抖音作品内容详情」的返回结构，里面只有 commentCount（评论数），没有评论内容列表。没有评论文本，就谈不上讨论内容，更算不出关联度。',
    way: '暂用手工登记：把评论区反复出现的顾虑记下来。手动抽 10 条往往比自动打标更准，因为你能判断哪句是真实顾虑。等红狐开放评论接口再接。',
  },
  {
    key: 'poiBadge',
    label: '绿标 / 白标带货视频',
    availability: 'unavailable',
    availabilityLabel: '接口不可用',
    manualOnly: true,
    source: '手工登记',
    basis: '绿标（已认领门店）与白标（未认领点位的团购挂载）是抖音本地生活后台的概念。红狐 API 目录里没有带货、团购、商品、门店任何一类接口。',
    way: '手工登记挂载数与对应账号，用来盯住"谁在帮门店带货"。这是目前唯一可核对的来源，记一次用一个月。',
  },
  {
    key: 'accountRank',
    label: '账号排名',
    availability: 'derived',
    availabilityLabel: '本地口径',
    manualOnly: false,
    source: '本地计算',
    basis: '不是平台官方榜单。用我们自己抓到的账号按某个指标排序，口径写在界面上，换指标排名就会变。',
    way: '范围仅限已加入监控的账号。想扩大范围得先用关键词搜账号补充候选，那一步是真实接口。',
  },
];

export const AVAILABILITY_TONE = {
  api: { cls: 'b-green', text: '接口可取' },
  approximate: { cls: 'b-warn', text: '关键词近似' },
  derived: { cls: 'b-info', text: '本地口径' },
  unavailable: { cls: 'b-danger', text: '接口不可用' },
};

/* ============================================================
   6. 调用计划与成本
   ------------------------------------------------------------
   积分单价来自接口实测返回（account 0.6 / works 0.4）。
   ¥0.02/次是官网写的下限价，量大走阶梯折扣。
   积分与人民币的换算比例官网未公开，所以两者分开列，不硬凑成一个数。
   ============================================================ */
export const CALL_PLAN = {
  unitPriceFloor: 0.02,
  note: '红狐按次计价，官网写明最低 ¥0.02/次，量大走阶梯折扣。积分与人民币的换算比例官方未公开，下面两项分开列。',
  items: [
    { key: 'account', label: '账号维度', credits: 0.6, times: 1, desc: '粉丝 / 作品数 / 累计获赞 / 红狐指数 / 地区' },
    { key: 'works', label: '作品列表', credits: 0.4, times: 1, desc: '单页最多 50 条，用于算平均播放与发布间隔' },
    { key: 'searchAccount', label: '关键词搜账号', credits: 0.6, times: 1, desc: '找对标账号，一次一个关键词' },
    { key: 'searchWork', label: '关键词搜作品', credits: 0.6, times: 1, desc: '门店热度近似召回，一次一个关键词' },
  ],
};

export function estimateCost(keys = []) {
  const picked = CALL_PLAN.items.filter((i) => keys.includes(i.key));
  const calls = picked.reduce((s, i) => s + i.times, 0);
  const credits = picked.reduce((s, i) => s + i.credits * i.times, 0);
  return {
    items: picked,
    calls,
    credits: Math.round(credits * 100) / 100,
    moneyFloor: Math.round(calls * CALL_PLAN.unitPriceFloor * 100) / 100,
  };
}

/** 全量跑一轮（用于界面上的"同步一次大概花多少"） */
export const FULL_SYNC_KEYS = ['account', 'works', 'searchAccount', 'searchWork'];

/* ============================================================
   7. 官方赛道榜
   ------------------------------------------------------------
   这是红狐唯一返回「官方榜位」的接口（响应里的 accountRanking）。
   榜位是平台给的，不是我们自己算的，所以它能直接回答"我排第几"这类问题的一半。

   两件必须先想清楚的事，界面上也要照实说：
     1. type 是赛道维度，没有城市参数。所谓"本地官方排名"的"本地"这一半拿不到。
     2. 口径是内容维度：综合评分 = 总粉丝数 + 新增粉丝 + 新增点赞/分享/评论 加权。
        曝光 / 转化 / 开口 不在里面，因为它们只存在于商家自己的后台。
   ============================================================ */

/** 官方文档给出的全部赛道（27 个，加"全部"共 28 个取值） */
export const RANK_CATEGORIES = [
  '全部', '个人才艺', '生活vlog', '财富理财', '二次元', '居家装修', '学习教育',
  '小剧场', '数码科技', '旅行', '美食', '化妆美容', '动物', '亲子', '汽车', '情感',
  '三农', '健康医学', '潮流风尚', '舞蹈才艺', '颜值造型', '人文', '音乐', '影视',
  '身体锻炼', '体育', '明星娱乐', '游戏',
];

/** 和健身场馆最相关的三个赛道，默认排在前面，省得每次翻 28 项 */
export const FITNESS_CATEGORIES = ['身体锻炼', '体育', '健康医学'];

export const RANK_PERIODS = [
  { value: 'days', label: '日榜' },
  { value: 'weeks', label: '周榜' },
  { value: 'months', label: '月榜' },
];

export const RANK_PERIOD_LABEL = { days: '日榜', weeks: '周榜', months: '月榜' };

/**
 * 榜单日期的默认值。
 * 官方更新节奏：日榜每晚 8 点更新昨日，周榜每周一更新上周，月榜每月 1 号更新上月。
 * 所以默认取"最近一个已经更新过的周期"，而不是今天：
 * 传今天大概率是一条空榜，看起来像接口坏了。
 */
export function defaultRankDate(dateType = 'days') {
  const x = new Date();
  x.setHours(12, 0, 0, 0);
  if (dateType === 'weeks') {
    const dow = (x.getDay() + 6) % 7;      // 以周一为 0
    x.setDate(x.getDate() - dow - 7);      // 上一个完整周的周一
    return toDateStr(x);
  }
  if (dateType === 'months') {
    x.setDate(1);
    x.setMonth(x.getMonth() - 1);
    return toDateStr(x);
  }
  x.setDate(x.getDate() - 1);
  return toDateStr(x);
}

/** 榜位口径说明，界面与抽屉共用同一份文案，避免两处漂移 */
export const BOARD_CAVEATS = [
  {
    key: 'geo',
    label: '没有城市筛选',
    text: 'type 参数只接受赛道名，没有地区参数，所以拿不到「重庆榜」。这个榜是全国赛道榜，不是本地榜。',
  },
  {
    key: 'metric',
    label: '口径是内容维度',
    text: '综合评分 = 总粉丝数 + 新增粉丝 + 新增点赞/分享/评论 加权，满分 100。不含曝光、转化、开口。',
  },
  {
    key: 'entry',
    label: '本店账号不在池子里',
    text: '每赛道只有 TOP50，入榜的是百万粉级账号。门店 8 千粉的账号进不去，所以这个榜看不到「我排第几」，只能用来看赛道头部在做什么。',
  },
];

/** 本店账号在榜上吗。不在就返回 null，不返回 -1 这种容易被误读的值 */
export function myRankOnBoard(board, uniqueName, nickname) {
  const list = board?.items || [];
  const hit = list.find((x) => (uniqueName && x.url && String(x.url).includes(uniqueName))
    || (nickname && x.nickname === nickname));
  return hit ? hit.rank : null;
}

/** 榜单里涨粉最快的那条，用来回答"最近谁在起量" */
export function fastestRising(board, n = 3) {
  return [...(board?.items || [])]
    .filter((x) => isNum(x.fansGrowth))
    .sort((a, b) => b.fansGrowth - a.fansGrowth)
    .slice(0, n);
}

/* ============================================================
   8. 状态默认值
   ============================================================ */
export function defaultDouyinState() {
  return {
    /* 绑定的是抖音号（uniqueId）而不是昵称：昵称不唯一，红狐官方脚本直接拒绝中文昵称。 */
    binding: null,
    monitor: {
      account: true,      // 账号维度
      works: true,        // 作品列表
      benchmark: false,   // 对标账号（要多花一次搜索调用的钱）
      storeHeat: false,   // 门店热度近似召回
    },
    /** 代理地址。密钥在代理进程的环境变量里，这里只存地址与口令。 */
    proxyUrl: 'http://localhost:8787',
    /** 线上代理访问口令（对应 PROXY_ACCESS_TOKEN），本地代理留空 */
    proxyToken: '',
    /**
     * 用户核对过端点之后可以在这里把它标成 true 来解除拦截。
     * 放在状态里而不是写死在代码里，是因为"我核对过了"是使用者的判断，
     * 不该由代码替他决定。
     */
    endpointsVerified: {},
    snapshot: null,       // { at, account, works, metrics, isSample, source }
    prevMetrics: null,    // 上一次的派生指标，用于算环比
    benchmarks: [],       // { at, items, isSample, keyword }
    /** 官方赛道榜缓存：{ at, dateType, rankDate, category, items, isSample } */
    board: null,
    boardQuery: { dateType: 'days', category: '身体锻炼' },
    storeHeat: { manual: [], updatedAt: null },
    log: [],
  };
}
