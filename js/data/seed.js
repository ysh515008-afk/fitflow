/* ============================================================
   seed.js · 示例数据（首次打开 / 重置演示时写入）
   所有日期相对"今天"生成，保证数据永远看起来是活的
   ============================================================ */
import { d, uid, nowISO, pad, addDays, daysBetween } from '../util.js';
import { defaultConnector, defaultConnectors, defaultBizSource } from '../integrations/index.js';
import { deriveCards } from './membership.js';
import { DAY_TEMPLATE } from './automation.js';
import { deriveMetrics } from '../douyin.js';
import { defaultFeatures } from '../features.js';

function last6Months() {
  const out = [];
  const base = new Date();
  base.setDate(1);
  for (let i = 5; i >= 0; i--) {
    const x = new Date(base);
    x.setMonth(base.getMonth() - i);
    out.push({ key: `${x.getFullYear()}-${pad(x.getMonth() + 1)}`, label: `${x.getMonth() + 1}月` });
  }
  return out;
}

const SRC_LABEL = {
  tri: '三体同步', walkin: '自然到店', douyin: '抖音', xiaohongshu: '小红书', referral: '转介绍', wechat: '朋友圈',
};

/* ============================================================
   逐日打卡明细（m.checkins）
   ------------------------------------------------------------
   会员档案里要画可视化打卡日历，但需要的是"哪天去了哪天没去"的明细，
   而会员聚合字段只有 lastVisit（最近一次）和 visits30（近 30 天次数）。

   没有真实打卡接口时，这里按 visits30 的次数、以 lastVisit 为最新一天，
   确定性地铺一份明细（用会员 id 当种子，保证同一份 seed 每次生成一致）。
   这样日历画出来是活的、和"近 30 天 N 次"对得上，不会和聚合字段打架。

   拿不到的会员（visits30 为 0，或压根没 lastVisit）一律给空数组，
   由界面展示"尚未同步"，绝不拿次数反推、补出虚假的每日打卡点。
   ============================================================ */
function genCheckins(m) {
  if (!m.lastVisit || !m.visits30) return [];
  const n = m.visits30;
  const last = m.lastVisit;

  /* 打卡明细的窗口以「三体 / 勤鸟建档日期 registeredAt」为最早边界：
     在三体里，注册代表这个人开始到店运动（打卡），建档之前不可能有打卡记录。
     这是和「名下有没有会籍卡」彻底分开的两件事 —— 有卡没注册不会凭空产生打卡，
     注册了即使还没开卡也算已建档的潜在到店者。
     建档日若在近 30 天内（刚注册的新客），窗口就收缩到建档日当天。 */
  const winStart = (m.registeredAt && m.registeredAt > addDays(last, -29))
    ? m.registeredAt
    : addDays(last, -29);
  const span = Math.max(0, daysBetween(winStart, last));
  const dates = new Set();

  /* 用会员 id 当随机种子，xorshift 推，避免 Math.random 每刷新都变 */
  let seed = 0x9e3779b9;
  for (let i = 0; i < m.id.length; i++) seed = (seed * 31 + m.id.charCodeAt(i)) >>> 0;
  const rnd = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };

  /* visits30 就是近 30 天次数，所有点都落在 [winStart, last] 窗口里才自洽 */
  let guard = 0;
  while (dates.size < n && guard < n * 60) {
    guard++;
    const back = Math.floor(rnd() * (span + 1)); // 0..span
    dates.add(addDays(winStart, back));
  }
  /* lastVisit 必须出现在明细里（日历最新点和"最近到店"要对上）。
     但若它不在随机集合里，不能用"直接 append"的方式，否则明细总数会越过 visits30，
     和档案里的"近 30 天 N 次"对不上。这里用"替换最早一天"塞进 lastVisit，
     明细总数严格保持 = visits30。 */
  if (!dates.has(last)) {
    const sorted = [...dates].sort();
    if (sorted.length) dates.delete(sorted[0]);
    dates.add(last);
  }

  const src = m.triId ? 'santi' : m.qinniaoId ? 'qinniao' : 'manual';
  return [...dates].sort().map((ds) => ({
    checkinAt: ds,
    source: src,
    /* 营业时段里的随机时刻，仅用于详情 tooltip，不进日历网格 */
    time: `${pad(8 + Math.floor(rnd() * 12))}:${pad(Math.floor(rnd() * 60))}`,
  }));
}

/* ============================================================
   抖音账号监控的示例数据
   ------------------------------------------------------------
   这里的数据一律打 isSample: true，界面会顶一条说明把它标出来。
   接入类数据（账号快照、对标账号）伪造了会让使用者以为真连上了，
   比留空危险得多，所以"是不是示例"必须能被界面看见。

   数字刻意做成"有毛病"的状态，好让建议引擎真的触发几条：
     · 发布间隔中位数 5 天 → 周更 1.4 条 → 更新频率偏低
     · 12 条里只有 1 条过爆款线 → 爆款率 8.3%
     · 互动率比上次同步掉 26% → 互动率下滑
     · 红狐指数在涨、平均播放在掉 → 存量吃红利，新内容没接住
   这几个症状和 campaigns 里的内容台账是同一套数字，不是两套账。
   ============================================================ */
function buildDouyinSeed() {
  const acc = {
    remoteId: 'lijian_jrc',
    nickname: '力健健身·金融城店',
    signature: '重庆金融城｜私教 / 团课 / 体测',
    followerCount: 8420,
    awemeCount: 216,
    totalFavorited: 96400,
    redfoxIndex: 612,
    region: '重庆',
    crawlTime: d(0) + ' 08:40',
  };

  /* [距今天数, 标题, 播放, 点赞, 评论, 分享, 收藏] */
  const RAW = [
    [0, '会员案例：硬拉 120kg 的第 200 天', 5200, 210, 18, 24, 30],
    [2, '膝盖疼还能练腿吗（3 个替代动作）', 41200, 1860, 214, 486, 720],
    [6, '体脂 29% → 24%，她的 12 周训练表', 87400, 4320, 386, 1120, 1860],
    [13, '上班族 30 分钟高效训练', 9800, 420, 42, 86, 140],
    [17, '私教课到底贵在哪（成本拆解）', 7600, 330, 31, 64, 108],
    [21, '体测报告的 5 个数字怎么看', 6400, 280, 26, 52, 88],
    [26, '女生怕练出肌肉？先看这组数据', 5900, 260, 24, 48, 82],
    [31, '为什么你练了半年没变化', 5200, 230, 21, 42, 70],
    [38, '金融城店器械区导览', 4800, 210, 18, 36, 58],
    [46, '会员采访：从 82kg 到 71kg', 4300, 190, 16, 32, 50],
    [55, '深蹲膝盖内扣怎么改', 3900, 170, 14, 28, 44],
    [63, '秋季体验营名额开放', 3200, 140, 12, 22, 36],
  ];

  const works = RAW.map(([ago, title, play, digg, comment, share, collect]) => ({
    remoteId: uid('aw'),
    title,
    createTime: d(-ago) + ' 20:00',
    playCount: play,
    diggCount: digg,
    commentCount: comment,
    shareCount: share,
    collectCount: collect,
    url: '',
    coverUrl: '',
  }));

  return {
    binding: {
      uniqueName: 'lijian_jrc',
      nickname: '力健健身·金融城店',
      note: '门店主账号。绑定的是抖音号而不是昵称，昵称不唯一。',
      boundAt: d(-31) + ' 09:20',
    },
    monitor: { account: true, works: true, benchmark: true, storeHeat: true },
    snapshot: {
      at: d(0) + ' 08:40',
      account: acc,
      works,
      metrics: deriveMetrics(acc, works),
      isSample: true,
      source: 'redfox',
    },
    /* 上一次同步的派生指标，只留指标不留原始数据，用来算环比 */
    prevMetrics: {
      followerCount: 8180, awemeCount: 214, totalFavorited: 91200, redfoxIndex: 596,
      avgPlay: 17800, avgDigg: 806, avgComment: 74,
      engRate: 0.084, commentRate: 0.0918, hitRate: 0.083,
      postGapDays: 4.4, weeklyPosts: 1.6, sampleSize: 12, playSample: 12,
    },
    benchmarks: {
      at: d(-1) + ' 09:10',
      keyword: '重庆 健身',
      isSample: true,
      items: [
        { remoteId: 'cq_gangtie_fit', nickname: '重庆钢铁健身', followerCount: 21400, awemeCount: 486, totalFavorited: 268000, redfoxIndex: 738, region: '重庆' },
        { remoteId: 'jrc_pt_studio', nickname: '金融城私教工作室', followerCount: 6800, awemeCount: 172, totalFavorited: 74300, redfoxIndex: 655, region: '重庆' },
        { remoteId: 'lian_you_ji', nickname: '练有所记', followerCount: 45200, awemeCount: 731, totalFavorited: 512000, redfoxIndex: 802, region: '重庆' },
      ],
    },
    storeHeat: {
      updatedAt: d(-1),
      manual: [
        { id: uid('sh'), kind: 'poiWorks', at: d(-1), count: 14, detail: '关键词「金融城 健身」「江北嘴 健身房」召回 14 条，其中 3 条同时出现在本店账号作品里' },
        { id: uid('sh'), kind: 'commentTalk', at: d(-1), count: 9, detail: '高频顾虑：器械不够用 / 停车不好停 / 私教排课太紧' },
        { id: uid('sh'), kind: 'poiBadge', at: d(-2), count: 11, green: 3, white: 8, detail: '绿标 3 个（含本店），白标 8 个；挂载最多的账号是 jrc_pt_studio' },
      ],
    },
    /**
     * 官方赛道榜示例。
     * rank 字段是接口给的 accountRanking，示例里也保持"官方榜位"的语义：
     * 按榜单顺序排列，不做任何重排。金额单位已由 cnNum 转成数值。
     * 入榜账号都是百万粉级，本店 8 千粉的账号不在池子里，这是榜单的真实形态。
     */
    board: {
      at: d(-1) + ' 20:10',
      dateType: 'days',
      rankDate: d(-1),
      category: '身体锻炼',
      isSample: true,
      items: [
        { rank: 1, nickname: '练得狠', url: 'https://www.douyin.com/user/MS4wLjABAAAA_demo1', category: '身体锻炼', score: 89.2, followerCount: 2684000, fansGrowth: 32000, likedGrowth: 421000, commentsGrowth: 18600, sharedGrowth: 54000, rankPeriod: '日' },
        { rank: 2, nickname: '体态研究所', url: 'https://www.douyin.com/user/MS4wLjABAAAA_demo2', category: '身体锻炼', score: 85.6, followerCount: 1547000, fansGrowth: 21000, likedGrowth: 314000, commentsGrowth: 13200, sharedGrowth: 41000, rankPeriod: '日' },
        { rank: 3, nickname: '硬拉日记', url: 'https://www.douyin.com/user/MS4wLjABAAAA_demo3', category: '身体锻炼', score: 82.2, followerCount: 986000, fansGrowth: 17400, likedGrowth: 268000, commentsGrowth: 9200, sharedGrowth: 26000, rankPeriod: '日' },
        { rank: 4, nickname: '一平米健身房', url: 'https://www.douyin.com/user/MS4wLjABAAAA_demo4', category: '身体锻炼', score: 78.8, followerCount: 642000, fansGrowth: 12800, likedGrowth: 195000, commentsGrowth: 7100, sharedGrowth: 19000, rankPeriod: '日' },
        { rank: 5, nickname: '跑者笔记', url: 'https://www.douyin.com/user/MS4wLjABAAAA_demo5', category: '身体锻炼', score: 76.5, followerCount: 529000, fansGrowth: 9600, likedGrowth: 143000, commentsGrowth: 5400, sharedGrowth: 14000, rankPeriod: '日' },
      ],
    },
    boardQuery: { dateType: 'days', category: '身体锻炼' },
    log: [
      { id: uid('dy'), at: d(0) + ' 08:40', ok: true, count: 12, message: '同步抖音号 lijian_jrc，取到 12 条作品' },
      { id: uid('dy'), at: d(-1) + ' 20:10', ok: true, count: 5, message: '取到「身体锻炼」日榜 5 条' },
      { id: uid('dy'), at: d(-1) + ' 08:40', ok: false, count: 0, message: '红狐积分不足（code 3201），本次同步未执行，等待充值' },
    ],
  };
}

/* ============================================================
   交易后台示例数据（抖音来客 / 美团经营宝）
   ------------------------------------------------------------
   这是"后台报表已经导入之后"的样子，不是接口实时读数。
   数字之间保持自洽，让漏斗算出来的比率是可信的：
     曝光 → 访问约 10% → 开口约 12% → 下单约 12% → 核销约 71%
   核销那一环刻意留了落差（下单了没来的那批），
   因为"买了不来"是门店最真实、也最容易被忽略的一块。
   ============================================================ */
function buildBizSeed() {
  /* [距今天数, 曝光, 访问, 开口, 下单, 核销, 消耗(元)] */
  const LAIKE = [
    [0, 24800, 2610, 318, 38, 27, 600],
    [-1, 21300, 2240, 268, 31, 26, 520],
    [-2, 18900, 1980, 241, 28, 24, 480],
    [-3, 17400, 1820, 214, 22, 19, 460],
  ];
  const MEITUAN = [
    [0, 9600, 880, 96, 14, 11, 0],
    [-1, 8900, 810, 88, 12, 10, 0],
    [-2, 8200, 760, 79, 9, 8, 0],
  ];
  const mk = (source, rows) => rows.map(([ago, impression, visit, open, order, redeem, spend]) => ({
    id: uid('biz'), source, date: d(ago),
    impression, visit, open, order, redeem, spend,
    at: d(ago) + ' 09:30',
  }));

  return {
    laike: {
      ...defaultBizSource('laike'),
      status: 'pending',
      poiId: '金融城店（示例）',
      lastImportAt: d(0) + ' 09:30',
      note: '示例状态：后台报表已导入，接口授权还在走流程（需要企业认证 + 服务商或总部账户）。',
    },
    meituan: {
      ...defaultBizSource('meituan'),
      status: 'pending',
      poiId: '金融城店（示例）',
      lastImportAt: d(0) + ' 09:35',
      note: '示例状态：经营宝的流量看板与交易看板分两次导出，按日期合并进FitFlow 。',
    },
    records: [...mk('laike', LAIKE), ...mk('meituan', MEITUAN)],
    lastImportAt: d(0) + ' 09:35',
  };
}

export function buildSeed() {
  const syncedAt = nowISO().slice(0, 16).replace('T', ' ');
  /* 演示数据现实化：学员按调用次序陆续进店（铺在近 6 个月内），并归属两名顾问。
     这样「月份对比」与「个人 vs 门店」在本机演示里才有真实差异可看。
     seed 本身就是演示数据生成器，这里只改 createdAt / owner 两个本地自带字段，
     会籍卡、到期日、三体建档日（registeredAt）等与外界系统相关的字段一律不动。 */
  let memSeq = 0;
  const SEQ_BACK = [9, 24, 41, 58, 76, 97, 124, 148, 163, 176];
  const M = (o) => {
    memSeq += 1;
    return {
      gender: '男', age: 28, owner: memSeq % 4 === 0 ? '李航' : '陈默', tags: [], intents: [], concerns: [], goals: [],
      hasPT: false, ptTotal: 0, ptLeft: 0, visits30: 0, totalPaid: 0,
      source: 'tri', triId: null, qinniaoId: null, registeredAt: null, syncedAt,
      createdAt: d(-SEQ_BACK[(memSeq - 1) % SEQ_BACK.length]), ...o,
    };
  };

  const members = [
    M({
      id: 'm01', name: '林嘉怡', gender: '女', age: 29, phone: '13800132211', source: 'tri', triId: 'T3-88201', registeredAt: d(-372),
      cardType: '年卡 · 私教 24 节', hasPT: true, ptTotal: 24, ptLeft: 12,
      joinDate: d(-344), expireDate: d(21), totalPaid: 18800, lastVisit: d(-3), visits30: 11,
      stage: 'renewing', intents: ['减脂', '体态改善'], concerns: ['膝盖旧伤，深蹲会疼', '担心续费后教练更换'],
      goals: ['体脂率从 29% 降到 24%', '年底拍婚纱照'], tags: ['高价值', '续费意向高'],
      note: '对教练更换非常敏感，续费方案里必须写清教练安排。',
    }),
    M({
      id: 'm02', name: '吴迪', gender: '男', age: 41, phone: '13900137788', source: 'tri', triId: 'T3-88140', registeredAt: d(-390),
      cardType: '年卡 · 私教 36 节', hasPT: true, ptTotal: 36, ptLeft: 9,
      joinDate: d(-358), expireDate: d(3), totalPaid: 24600, lastVisit: d(-2), visits30: 9,
      stage: 'renewing', intents: ['力量提升', '腰背疼痛缓解'], concerns: ['出差频繁，怕浪费课时'],
      goals: ['硬拉突破 120kg'], tags: ['临期', '高价值'],
      note: '已口头确认续费，只差方案和付款。别再问"要不要续"，直接给方案。',
    }),
    M({
      id: 'm03', name: '赵磊', gender: '男', age: 35, phone: '13700136655', source: 'tri', triId: 'T3-88099', registeredAt: d(-40),
      cardType: '月卡', joinDate: d(-26), expireDate: d(5), totalPaid: 680,
      lastVisit: d(-28), visits30: 1, stage: 'silent',
      intents: ['减脂'], concerns: ['工作忙', '第一次办卡就没怎么来，有点灰心'],
      goals: ['先养成每周 2 次习惯'], tags: ['沉默 28 天', '低活跃'],
      note: '月卡客户最能被"习惯"打动，不要推年卡，先约一次免费体测。',
    }),
    M({
      id: 'm04', name: '孙一鸣', gender: '男', age: 20, phone: '13500129900', source: 'tri', triId: 'T3-87951', registeredAt: d(-70),
      cardType: '季卡', joinDate: d(-48), expireDate: d(41), totalPaid: 1980,
      lastVisit: d(-46), visits30: 0, stage: 'silent',
      intents: ['增肌'], concerns: ['在准备考研', '时间不确定'], goals: ['暑假练出线条'], tags: ['沉默 46 天'],
      note: '学生党，唤醒用"同学一起练"的社群方式比私信更有效。',
    }),
    M({
      id: 'm05', name: '何伟', gender: '男', age: 33, phone: '13600131122', source: 'tri', triId: 'T3-87402', registeredAt: d(-440),
      cardType: '年卡', joinDate: d(-408), expireDate: d(-43), totalPaid: 3980,
      lastVisit: d(-60), visits30: 0, stage: 'expired',
      intents: ['减脂', '体检指标'], concerns: ['换工作到外地了', '不知道还会不会回来'],
      goals: ['把血脂降下来'], tags: ['已过期 43 天', '搬迁'],
      note: '已过期。先关心近况，再谈"回来先买月卡"。',
    }),
    M({
      id: 'm06', name: '刘敏', gender: '女', age: 31, phone: '13400135566', source: 'tri', triId: 'T3-88012', registeredAt: d(-110),
      cardType: '半年卡 · 私教 12 节', hasPT: true, ptTotal: 12, ptLeft: 5,
      joinDate: d(-83), expireDate: d(96), totalPaid: 7600, lastVisit: d(-1), visits30: 14,
      stage: 'active', intents: ['产后恢复', '核心力量'], concerns: ['腰腹力量弱', '工作日只有晚上有空'],
      goals: ['产后 1 年恢复孕前体重'], tags: ['高频到店', '已转介绍 1 人'],
      note: '到店频次很稳，本月适合谈私教加课。',
    }),
    M({
      id: 'm07', name: '冯雪', gender: '女', age: 27, phone: '13300138899', source: 'tri', triId: 'T3-87988', registeredAt: d(-250),
      cardType: '年卡 · 私教 36 节', hasPT: true, ptTotal: 36, ptLeft: 2,
      joinDate: d(-215), expireDate: d(150), totalPaid: 29800, lastVisit: d(0), visits30: 19,
      stage: 'active', intents: ['塑形', '体能'], concerns: ['课时快用完，想保持每周 3 练'],
      goals: ['体测综合评分进门店前 10%'], tags: ['高价值', '已转介绍 2 人', '私教临期'],
      note: '课时只剩 2 节，本周内必须谈续课包，不要等到归零。',
    }),
    M({
      id: 'm08', name: '陈昊', gender: '男', age: 26, phone: '13100139900', source: 'walkin', triId: null, qinniaoId: 'QN-88301', registeredAt: d(-225),
      cardType: '年卡', joinDate: d(-200), expireDate: d(165), totalPaid: 4580, lastVisit: d(-4), visits30: 7,
      stage: 'active', intents: ['增肌', '力量'], concerns: ['饮食跟不上'], goals: ['卧推 80kg'],
      tags: ['自主训练型', '勤鸟档案'],
    }),
    M({
      id: 'm09', name: '郑好', gender: '女', age: 25, phone: '13000130011', source: 'walkin', triId: null, qinniaoId: 'QN-88344', registeredAt: d(-135),
      cardType: '半年卡', joinDate: d(-114), expireDate: d(69), totalPaid: 2980, lastVisit: d(-8), visits30: 5,
      stage: 'active', intents: ['减脂'], concerns: ['外食多', '最近加班'], goals: ['减 6kg'],
      tags: ['勤鸟档案', '到店下滑'],
    }),
    M({
      id: 'm10', name: '王思远', gender: '男', age: 24, phone: '18900132233', source: 'douyin', triId: null,
      cardType: '未成交', joinDate: null, expireDate: null, totalPaid: 0,
      lastVisit: null, visits30: 0, stage: 'lead',
      intents: ['增肌'], concerns: ['刚毕业预算有限', '怕坚持不下来'],
      goals: ['先练 3 个月看看'], tags: ['抖音线索', '已约体验课'],
      note: '明天 19:00 体验课，今天先微信确认到店时间。',
    }),
    M({
      id: 'm11', name: '蒋子豪', gender: '男', age: 25, phone: '18800134455', source: 'douyin', triId: null,
      cardType: '未成交', totalPaid: 0, lastVisit: null, visits30: 0, stage: 'lead',
      intents: ['减脂'], concerns: ['只问了价格就没回'], goals: [],
      tags: ['抖音线索', '未回复'],
      note: '首响已 2 天，属于高流失风险，今天必须换角度再触达一次。',
    }),
    M({
      id: 'm12', name: '周雨薇', gender: '女', age: 22, phone: '18700136677', source: 'xiaohongshu', triId: null,
      cardType: '未成交', totalPaid: 0, lastVisit: d(-7), visits30: 1, stage: 'trial',
      intents: ['塑形'], concerns: ['觉得年卡太贵', '想先买 10 次卡试试'],
      goals: ['减 4kg 拍照好看'], tags: ['小红书线索', '体验未成交', '价格异议'],
      note: '报价后犹豫。用"10 次卡 + 体态课程"做过渡方案，不要硬推年卡。',
    }),
    M({
      id: 'm13', name: '杨帆', gender: '男', age: 30, phone: '18600137799', source: 'referral', triId: null,
      cardType: '未成交', totalPaid: 0, lastVisit: d(-2), visits30: 1, stage: 'trial',
      intents: ['体能', '减脂'], concerns: ['公司体检报告不太好'], goals: ['3 个月降体脂 5%'],
      tags: ['转介绍（冯雪）', '已约体测'],
      note: '冯雪介绍，信任基础好。体测后直接给方案，转化概率高。',
    }),
    M({
      id: 'm14', name: '黄璐', gender: '女', age: 34, phone: '18500138811', source: 'wechat', triId: null,
      cardType: '未成交', totalPaid: 0, lastVisit: d(-11), visits30: 1, stage: 'trial',
      intents: ['减脂'], concerns: ['带娃，只能白天来', '要接送孩子'],
      goals: ['恢复体能'], tags: ['朋友圈线索', '体验未成交'],
      note: '时间受限，主推白天团课，价格比私教好谈。',
    }),
  ];

  /* 逐日打卡明细：有到店记录的会员生成，没有的留空（界面展示"尚未同步"）。
     必须紧跟 members 定义之后做，否则 deriveCards 拿到的是没明细的会员。 */
  members.forEach((m) => { m.checkins = genCheckins(m); });

  /* 跟进记录带心理维度存档：阶段 / 原理 / 客户状态 / 微承诺 / 自检 */
  const followups = [
    { id: uid('f'), memberId: 'm01', date: d(-2), channel: 'wechat', summary: '发了本月体测对比与训练记录', feedback: '很满意，主动问"续费有没有老会员价"', result: 'positive', nextDate: d(0), nextAction: '当面给续费方案（含教练安排说明）',
      psych: { stage: 'p5', state: 'expect', principles: ['gradient', 'commitment'], microCommit: '答应周六下午到店看方案', checks: [0, 1, 2, 4], note: '她自己说出了续费意向，不要打断，顺着接' } },
    { id: uid('f'), memberId: 'm02', date: d(-1), channel: 'visit', summary: '到店训练后聊了 15 分钟', feedback: '口头确认续费，关注是否有私教加课优惠', result: 'positive', nextDate: d(0), nextAction: '出两档续费方案，今天内发报价',
      psych: { stage: 'p5', state: 'excited', principles: ['choices', 'loss'], microCommit: '让我今天把报价发他', checks: [0, 2, 4], note: '兴奋状态下要立刻落一个具体日程，否则会冷掉' } },
    { id: uid('f'), memberId: 'm03', date: d(-9), channel: 'phone', summary: '电话关心工作节奏，约到店', feedback: '说最近忙，没答应具体时间', result: 'neutral', nextDate: d(0), nextAction: '改约免费体测，不谈续费',
      psych: { stage: 'p1', state: 'resist', principles: ['autonomy', 'load'], microCommit: null, checks: [0, 4], note: '我问了"要不要续费"，这是错的，他刚恢复联系就问钱' } },
    { id: uid('f'), memberId: 'm04', date: d(-16), channel: 'wechat', summary: '推送考研生作息训练方案', feedback: '未回复', result: 'no_reply', nextDate: d(-2), nextAction: '换社群路径：让同龄会员拉他进打卡群',
      psych: { stage: 'p2', state: 'tired', principles: ['load'], microCommit: null, checks: [], note: '消息太长，学生党看不动' } },
    { id: uid('f'), memberId: 'm06', date: d(-1), channel: 'visit', summary: '核心训练课后反馈', feedback: '腰腹力量有进步，愿意加课', result: 'positive', nextDate: d(2), nextAction: '谈私教加 12 节方案',
      psych: { stage: 'p6', state: 'trust', principles: ['gradient', 'social'], microCommit: '下节课后聊加课', checks: [0, 1, 2, 5], note: '她自己说出进步，这是最好的促成时机' } },
    { id: uid('f'), memberId: 'm07', date: d(0), channel: 'visit', summary: '今日到店，提示课时仅剩 2 节', feedback: '确认要保持每周 3 练，担心排课', result: 'positive', nextDate: d(1), nextAction: '锁定固定时段 + 续课包报价',
      psych: { stage: 'p4', state: 'hesitate', principles: ['gradient', 'load'], microCommit: '先给我她方便的三个时段', checks: [1, 2], note: '她的顾虑是排课不是价格，先解排课' } },
    { id: uid('f'), memberId: 'm10', date: d(-1), channel: 'wechat', summary: '确认体验课时间，发到店路线与停车指引', feedback: '已回复"明天见"', result: 'positive', nextDate: d(0), nextAction: '今天 17:00 前再确认一次',
      psych: { stage: 'p1', state: 'expect', principles: ['reciprocity', 'peakend'], microCommit: '明天 19:00 到店', checks: [0, 2], note: '先把到店体验做好，别在体验前谈价格' } },
    { id: uid('f'), memberId: 'm11', date: d(-2), channel: 'wechat', summary: '报价后未回复', feedback: '未回复', result: 'no_reply', nextDate: d(0), nextAction: '换角度：发同体型会员 8 周变化案例',
      psych: { stage: 'p3', state: 'watch', principles: ['social'], microCommit: null, checks: [1], note: '报价太早，他连需求都没说清就被报了价' } },
    { id: uid('f'), memberId: 'm12', date: d(-4), channel: 'wechat', summary: '发送 10 次卡过渡方案', feedback: '说再想想，可能要等下个月发工资', result: 'neutral', nextDate: d(1), nextAction: '补充"体态体验课免费"降低决策门槛',
      psych: { stage: 'p4', state: 'hesitate', principles: ['labeling', 'commitment'], microCommit: '答应先来看一次体态课', checks: [0, 1, 2], note: '她说"等发工资"是委婉说法，真实顾虑是怕不值' } },
    { id: uid('f'), memberId: 'm13', date: d(-2), channel: 'visit', summary: '第一次到店，做了基础体测', feedback: '对体测结果很在意，问细节很多', result: 'positive', nextDate: d(1), nextAction: '体测方案书 + 3 个月计划',
      psych: { stage: 'p2', state: 'anxious', principles: ['oars', 'loss'], microCommit: '明天下午看方案', checks: [0, 1, 2, 3], note: '体检指标勾起了焦虑，方案要给希望而不是加压力' } },
    { id: uid('f'), memberId: 'm05', date: d(-30), channel: 'phone', summary: '沟通工作变动', feedback: '调到外地，短期不来', result: 'neutral', nextDate: d(7), nextAction: '一个月后再联系，先转为休眠',
      psych: { stage: 'p1', state: 'tired', principles: ['recovery'], microCommit: null, checks: [0], note: '他已经不是客户了，先当朋友留着' } },
    { id: uid('f'), memberId: 'm14', date: d(-6), channel: 'wechat', summary: '推白天团课时间表', feedback: '看了但没定', result: 'neutral', nextDate: d(3), nextAction: '约一次白天团课免费体验',
      psych: { stage: 'p3', state: 'watch', principles: ['autonomy', 'load'], microCommit: '看了时间表', checks: [1, 4], note: '她的限制是接送孩子，方案要按他的时间倒推' } },
  ];

  const appointments = [
    { id: uid('a'), memberId: 'm10', date: d(0), time: '19:00', type: '体验课', coach: '王教练', status: 'confirmed', note: '第一次到店，带好体测仪' },
    { id: uid('a'), memberId: 'm07', date: d(0), time: '20:00', type: '续费面谈', coach: '陈默', status: 'confirmed', note: '锁定固定时段，带课包报价单' },
    { id: uid('a'), memberId: 'm02', date: d(0), time: '18:30', type: '续费面谈', coach: '陈默', status: 'pending', note: '两档方案，现场可刷卡' },
    { id: uid('a'), memberId: 'm13', date: d(1), time: '14:00', type: '体测', coach: '李教练', status: 'confirmed', note: '体测后出方案书' },
    { id: uid('a'), memberId: 'm12', date: d(1), time: '16:00', type: '体验课', coach: '王教练', status: 'pending', note: '体态主题，降低决策门槛' },
    { id: uid('a'), memberId: 'm03', date: d(2), time: '11:00', type: '回访', coach: '陈默', status: 'pending', note: '免费体测，不谈续费' },
    { id: uid('a'), memberId: 'm06', date: d(2), time: '20:00', type: '私教加课洽谈', coach: '陈默', status: 'confirmed', note: '12 节加课包' },
    { id: uid('a'), memberId: 'm04', date: d(-3), time: '15:00', type: '回访', coach: '陈默', status: 'noshow', note: '未到店，未回复' },
    { id: uid('a'), memberId: 'm01', date: d(-4), time: '19:00', type: '私教课', coach: '李教练', status: 'arrived', note: '训练记录已上传' },
    { id: uid('a'), memberId: 'm14', date: d(-5), time: '10:30', type: '回访', coach: '陈默', status: 'arrived', note: '沟通白天团课安排' },
  ];

  const renewalPlans = [
    { id: 'r01', memberId: 'm01', dueDate: d(21), stage: '方案沟通', quoteAmount: 16800, expectedAmount: 16800, blockers: ['担心续费后换教练'], updatedAt: d(-2) },
    { id: 'r02', memberId: 'm02', dueDate: d(3), stage: '待付款', quoteAmount: 22800, expectedAmount: 22800, blockers: ['出差频繁，怕课时浪费'], updatedAt: d(-1) },
    { id: 'r03', memberId: 'm07', dueDate: d(150), stage: '课时即将用完', quoteAmount: 12600, expectedAmount: 12600, blockers: ['担心排课时间'], updatedAt: d(0) },
    { id: 'r04', memberId: 'm03', dueDate: d(5), stage: '未启动', quoteAmount: 0, expectedAmount: 0, blockers: ['活跃度低，续费意愿弱'], updatedAt: d(-9) },
  ];

  const groups = [
    {
      id: 'g01', name: '减脂营 · 1 群', platform: '微信', members: 218, activeRate: 0.62, health: 'good',
      purpose: '28 天减脂挑战，群内打卡 + 每周榜', cadence: '每日打卡 / 周三答疑 / 周日榜单',
      lastPostAt: d(0),
      weeklyPlan: [
        { day: '周一', topic: '体重打卡 + 上周冠军公布', owner: '陈默', status: 'done' },
        { day: '周二', topic: '饮食：外食怎么点', owner: '陈默', status: 'done' },
        { day: '周三', topic: '教练答疑 20:00 直播', owner: '王教练', status: 'doing' },
        { day: '周四', topic: '会员案例：8 周变化图', owner: '陈默', status: 'todo' },
        { day: '周五', topic: '周末加练打卡任务', owner: '陈默', status: 'todo' },
        { day: '周日', topic: '本周榜单 + 下周预告', owner: '陈默', status: 'todo' },
      ],
    },
    {
      id: 'g02', name: '早课打卡群', platform: '企业微信', members: 96, activeRate: 0.44, health: 'quiet',
      purpose: '7:00 早课出勤激励，提高到店频次', cadence: '每早打卡 / 周一出勤榜',
      lastPostAt: d(-2),
      weeklyPlan: [
        { day: '每日', topic: '早课合影 + 出勤接龙', owner: '李教练', status: 'doing' },
        { day: '周一', topic: '上周出勤榜 + 奖励发放', owner: '陈默', status: 'todo' },
        { day: '周五', topic: '下周早课排班预告', owner: '李教练', status: 'todo' },
      ],
    },
    {
      id: 'g03', name: '金融城粉丝群', platform: '抖音', members: 340, activeRate: 0.21, health: 'risk',
      purpose: '承接短视频流量，沉淀本地意向客户', cadence: '每次更新一条福利',
      lastPostAt: d(-6), weeklyPlan: [
        { day: '周二', topic: '免费体测名额 5 个', owner: '陈默', status: 'todo' },
        { day: '周六', topic: '器械教学短视频同步到群', owner: '陈默', status: 'todo' },
      ],
    },
  ];

  const campaigns = [
    { id: 'c01', title: '膝盖疼还能练腿吗（3 个替代动作）', platform: '抖音', format: '短视频', publishedAt: d(-2), views: 41200, likes: 1860, comments: 214, dmLeads: 17, formLeads: 3, spend: 0, status: '已发布' },
    { id: 'c02', title: '体脂 29% → 24%，她的 12 周训练表', platform: '抖音', format: '短视频', publishedAt: d(-6), views: 87400, likes: 4320, comments: 386, dmLeads: 41, formLeads: 9, spend: 0, status: '已发布' },
    { id: 'c03', title: '为什么你练了半年没变化（饮食 3 个坑）', platform: '小红书', format: '图文', publishedAt: d(-4), views: 12600, likes: 720, comments: 96, dmLeads: 12, formLeads: 2, spend: 0, status: '已发布' },
    { id: 'c04', title: '上班族 30 分钟高效训练', platform: '视频号', format: '短视频', publishedAt: d(-9), views: 8300, likes: 310, comments: 42, dmLeads: 5, formLeads: 1, spend: 0, status: '已发布' },
    { id: 'c05', title: '9 月秋季体验营（3 天免费体测 + 训练）', platform: '朋友圈', format: '活动海报', publishedAt: d(-5), views: 0, likes: 0, comments: 0, dmLeads: 0, formLeads: 14, spend: 480, status: '进行中' },
    { id: 'c06', title: '会员案例：硬拉 120kg 的第 200 天', platform: '抖音', format: '短视频', publishedAt: d(0), views: 5200, likes: 210, comments: 18, dmLeads: 4, formLeads: 0, spend: 0, status: '数据观察中' },
    { id: 'c07', title: '秋季续费老会员专场', platform: '私域', format: '群 + 私信', publishedAt: d(-1), views: 0, likes: 0, comments: 0, dmLeads: 0, formLeads: 0, spend: 0, status: '进行中' },
  ];

  const leads = [
    { id: uid('l'), name: '王思远', phone: '18900132233', source: '抖音', campaignId: 'c02', createdAt: d(-3), firstResponseMin: 6, intent: 'A', status: 'trial', owner: '陈默' },
    { id: uid('l'), name: '蒋子豪', phone: '18800134455', source: '抖音', campaignId: 'c01', createdAt: d(-2), firstResponseMin: 9, intent: 'C', status: 'contacted', owner: '陈默' },
    { id: uid('l'), name: '周雨薇', phone: '18700136677', source: '小红书', campaignId: 'c03', createdAt: d(-8), firstResponseMin: 22, intent: 'B', status: 'trial', owner: '陈默' },
    { id: uid('l'), name: '杨帆', phone: '18600137799', source: '转介绍', campaignId: null, createdAt: d(-3), firstResponseMin: 4, intent: 'A', status: 'trial', owner: '陈默' },
    { id: uid('l'), name: '黄璐', phone: '18500138811', source: '朋友圈', campaignId: 'c05', createdAt: d(-12), firstResponseMin: 35, intent: 'B', status: 'trial', owner: '陈默' },
    { id: uid('l'), name: '徐磊', phone: '18400139922', source: '抖音', campaignId: 'c02', createdAt: d(-5), firstResponseMin: 12, intent: 'B', status: 'contacted', owner: '陈默' },
    { id: uid('l'), name: '董倩', phone: '18300131010', source: '小红书', campaignId: 'c03', createdAt: d(-1), firstResponseMin: 7, intent: 'A', status: 'booked', owner: '陈默' },
    { id: uid('l'), name: '赵一凡', phone: '18200132121', source: '抖音', campaignId: 'c04', createdAt: d(-9), firstResponseMin: 96, intent: 'C', status: 'lost', owner: '陈默', lostReason: '首响超 90 分钟，加微信时已被同行接待' },
    { id: uid('l'), name: '罗静', phone: '18100133232', source: '朋友圈', campaignId: 'c05', createdAt: d(-4), firstResponseMin: 5, intent: 'B', status: 'booked', owner: '陈默' },
    /* 今天刚进来的抖音线索，还没首响。留着它是为了让"未读提醒"里的首响超时
       有一条真实数据，而不是只有界面没有内容。 */
    { id: uid('l'), name: '唐悦', phone: '18000134343', source: '抖音', campaignId: 'c06', createdAt: d(0), firstResponseMin: null, intent: 'A', status: 'new', owner: '陈默' },
  ];

  const months = last6Months();
  const history = [
    { revenue: 128600, deals: 15, trials: 42, leads: 118 },
    { revenue: 141200, deals: 17, trials: 46, leads: 132 },
    { revenue: 133800, deals: 16, trials: 44, leads: 121 },
    { revenue: 152400, deals: 18, trials: 51, leads: 146 },
    { revenue: 146900, deals: 17, trials: 48, leads: 139 },
    { revenue: 132400, deals: 16, trials: 45, leads: 128 },
  ].map((v, i) => ({ month: months[i].key, label: months[i].label, ...v }));

  const current = history[history.length - 1];

  const goals = [{
    month: months[months.length - 1].key,
    label: months[months.length - 1].label,
    targetRevenue: 180000, actualRevenue: current.revenue,
    targetDeals: 20, actualDeals: current.deals,
    targetTrials: 55, actualTrials: current.trials,
    targetLeads: 150, actualLeads: current.leads,
    breakdown: [
      { name: '新办年卡', target: 78000, actual: 52600 },
      { name: '私教课包', target: 56000, actual: 43200 },
      { name: '续费', target: 36000, actual: 28400 },
      { name: '转介绍奖励转化', target: 10000, actual: 8200 },
    ],
  }];

  /* 由会员档案派生会籍卡，保证"会员身上的卡"和"卡列表"永远对得上 */
  const cards = deriveCards(members);

  return {
    version: 1,
    isDemo: true,
    settings: {
      advisor: '陈默',
      store: '力健健身 · 金融城店',
      role: '销售顾问',
      onboardAt: d(-400),
      updatedAt: nowISO(),
      ai: { activeModelId: 'doubao' },
    },
    members,
    followups,
    appointments,
    renewalPlans,
    groups,
    campaigns,
    leads,
    goals,
    history,
    learning: {
      /* 学习进度：status = todo | doing | done，evidence 为产出物说明 */
      progress: {
        t01: { status: 'done', hours: 9, evidence: '14 份需求诊断卡已录入，其中 11 份写清预算边界', metricSnapshot: '诊断覆盖率 79%', updatedAt: d(-6) },
        t02: { status: 'doing', hours: 7, evidence: '体验课 SOP 已完成 4/5 节点，28 次体验课转化记录在册', metricSnapshot: '体验转化 28.6%', updatedAt: d(-2) },
        t05: { status: 'doing', hours: 4, evidence: '跟进节奏表已建立，队列连续清空 12 天', metricSnapshot: '7 天跟进达标 81%', updatedAt: d(0) },
        t09: { status: 'doing', hours: 6, evidence: '3 个群已分层，减脂营周日历已排两周', metricSnapshot: '减脂营活跃 62%', updatedAt: d(-1) },
      },
      radar: { r1: 4, r2: 3, r3: 4, r4: 2, r5: 3, r6: 2 },
      lastReviewAt: d(-12),
    },
    /**
     * 业务系统对接。这里只保存"配置与状态"，不保存任何密钥。
     * 密钥放在本地代理进程的环境变量里（见 server/proxy.mjs）。
     * status 语义：unauthorized 未授权 / pending 待授权 / connected 已连接 / error 异常
     */
    connectors: {
      ...defaultConnectors(),
      primary: 'santi',
      santi: (() => {
        const s = {
          ...defaultConnector('santi'),
          status: 'pending',
          systemVersion: '',
          accountRole: '销售员工（本人）',
          scope: 'own',
          authUrl: '',
          accounts: [
            { id: uid('acc'), name: '王导（本人）', role: '销售员工', scope: 'own', boundAt: d(-30) + ' 09:00' },
            { id: uid('acc'), name: '李店长', role: '门店管理员', scope: 'all', boundAt: d(-20) + ' 14:30' },
          ],
          note: '官方对外说明：支持会员、会籍课包、预约、入场、订单、退款查询，并提供 Excel 导出；登录使用「员工账号管理」中生成的网关 Key。接口路径与 header 名称需用官方文档核对。',
          logs: [
          { id: uid('lg'), at: d(-1) + ' 09:12', type: 'import', scope: '本人负责会员', records: 14, ok: true, message: '走兜底通道：粘贴导出的会员表导入，14 条记录按会员 ID 全部匹配成功' },
          { id: uid('lg'), at: d(-3) + ' 09:05', type: 'error', scope: '会员 + 会籍', records: 0, ok: false, message: '网关 Key 未配置，接口调用被拒绝（401）。这不是同步失败的数据问题，是授权问题。' },
          { id: uid('lg'), at: d(-7) + ' 20:40', type: 'import', scope: '本人负责会员', records: 12, ok: true, message: '首次导入基线数据，建立三体会员 ID 关联' },
        ],
        };
        s.activeAccountId = s.accounts[0]?.id || null;
        return s;
      })(),
      qinniao: {
        ...defaultConnector('qinniao'),
        status: 'unauthorized',
        systemVersion: '',
        accountRole: '',
        scope: 'own',
        note: '勤鸟官网明确说明「只需做简单的 API 数据对接」即可与第三方打通，但开放平台需要向其商务或客服申请开通，公开渠道没有接口文档。适配器已按统一契约写好，端点、鉴权与签名算法全部标为待核对。',
        logs: [
          { id: uid('lg'), at: d(-2) + ' 15:20', type: 'note', scope: '待开通', records: 0, ok: true, message: '已确认勤鸟为重庆勤鸟圈科技（rocketbird.cn）；开放平台需联系其商务申请，暂无可核对的接口文档' },
        ],
      },
    },

    /** 会籍卡：一会员多卡（期限卡 / 次卡 / 私教包 / 储值），演示数据由会员派生保证自洽 */
    cards,

    /** 抖音账号监控：绑定、快照、对标账号、门店热度台账。示例数据一律带 isSample 标记 */
    douyin: buildDouyinSeed(),

    /**
     * 小红书：账号维度红狐没有接口，所以这一栏的数字一律是登记值，
     * 界面会标「登记值」而不是假装同步来的。笔记同样按条登记。
     */
    xhs: {
      binding: {
        uniqueName: 'lijian_jrc',
        nickname: '力健健身·金融城店',
        followerCount: 3260,
        noteCount: 48,
        note: '门店主账号。粉丝与笔记数是手工登记的，红狐没有小红书账号维度接口。',
        boundAt: d(-24) + ' 10:05',
        at: d(-1),
      },
      updatedAt: d(-1),
      notes: [
        { id: uid('xn'), title: '金融城上班族的午间 30 分钟训练', format: '图文', publishedAt: d(-3), readCount: 8600, likeCount: 412, collectCount: 356, commentCount: 38, shareCount: 62, leads: 3 },
        { id: uid('xn'), title: '体脂 29% → 24%，她的 12 周记录', format: '图文', publishedAt: d(-9), readCount: 32400, likeCount: 1860, collectCount: 1420, commentCount: 164, shareCount: 288, leads: 11 },
        { id: uid('xn'), title: '私教课贵在哪（价格拆开看）', format: '视频', publishedAt: d(-16), readCount: 5200, likeCount: 210, collectCount: 168, commentCount: 24, shareCount: 31, leads: 2 },
        { id: uid('xn'), title: '女生怕练出肌肉？先看这组数据', format: '图文', publishedAt: d(-23), readCount: 12800, likeCount: 640, collectCount: 502, commentCount: 57, shareCount: 96, leads: 5 },
        { id: uid('xn'), title: '体测报告上这 5 个数字最重要', format: '图文', publishedAt: d(-31), readCount: 4100, likeCount: 186, collectCount: 142, commentCount: 19, shareCount: 26, leads: 1 },
        { id: uid('xn'), title: '器械区使用礼仪（真的有人不知道）', format: '视频', publishedAt: d(-42), readCount: 9400, likeCount: 430, collectCount: 288, commentCount: 41, shareCount: 74, leads: 4 },
      ],
    },

    /**
     * 交易后台：抖音来客 / 美团经营宝。
     * records 是报表导入落地的经营记录，不是接口实时数据。
     */
    biz: buildBizSeed(),

    /**
     * 可选配功能。示例数据保持默认档：
     * 社群管理默认关闭（可去功能库添加），其余默认打开。
     */
    features: defaultFeatures(),

    /**
     * 运营未读提醒：只存"哪些消息已读"。
     * 消息本身由 opsBrief.js 每天重算，首屏会有几条未读，用来演示提醒的样子。
     */
    opsBrief: { date: d(0), readIds: [] },

    /** 智能体：规则开关与运行日志。规则本体在 data/automation.js */
    automations: {
      rules: {},                 // { [ruleId]: { on, params } } 只在用户改过之后才有值
      lastRunAt: d(0) + ' 09:00',
      runCount: 26,
      log: [
        { id: uid('ag'), at: d(0) + ' 09:00', ruleId: 'daily_standup', ruleName: '每天开工生成今日队列', group: 'time', count: 9, status: 'done', targets: ['林嘉怡', '吴迪', '冯雪', '王思远', '蒋子豪', '赵磊', '孙一鸣'] },
        { id: uid('ag'), at: d(-1) + ' 09:00', ruleId: 'expiry7', ruleName: '会籍 7 天内到期', group: 'card', count: 1, status: 'done', targets: ['吴迪'] },
        { id: uid('ag'), at: d(-1) + ' 20:30', ruleId: 'pt_low', ruleName: '私教课时 ≤ 3 节', group: 'card', count: 1, status: 'done', targets: ['冯雪'] },
        { id: uid('ag'), at: d(-2) + ' 10:15', ruleId: 'lead_sla', ruleName: '线索首响超时', group: 'lead', count: 1, status: 'done', targets: ['蒋子豪'] },
        { id: uid('ag'), at: d(-3) + ' 09:00', ruleId: 'silent14', ruleName: '14 天以上未到店（轻度沉默）', group: 'follow', count: 2, status: 'done', targets: ['赵磊', '孙一鸣'] },
        { id: uid('ag'), at: d(-4) + ' 09:00', ruleId: 'follow_overdue', ruleName: '约定跟进逾期', group: 'follow', count: 2, status: 'ignored', targets: ['孙一鸣', '何伟'] },
        { id: uid('ag'), at: d(-5) + ' 18:40', ruleId: 'high_value_silent', ruleName: '高价值会员沉默', group: 'follow', count: 1, status: 'done', targets: ['吴迪'] },
        { id: uid('ag'), at: d(-6) + ' 09:00', ruleId: 'follow_overdue', ruleName: '约定跟进逾期', group: 'follow', count: 1, status: 'ignored', targets: ['何伟'] },
        { id: uid('ag'), at: d(-7) + ' 21:00', ruleId: 'weekly_review', ruleName: '周日复盘提醒', group: 'time', count: 1, status: 'done', targets: ['我'] },
        { id: uid('ag'), at: d(-8) + ' 09:00', ruleId: 'learning_stall', ruleName: '学习课题停滞', group: 'growth', count: 1, status: 'ignored', targets: ['t05 客户档案与跟进节奏'] },
        { id: uid('ag'), at: d(-10) + ' 09:00', ruleId: 'card_pending', ruleName: '卡已售出但未激活', group: 'card', count: 1, status: 'done', targets: ['黄璐'] },
        { id: uid('ag'), at: d(-12) + ' 09:00', ruleId: 'data_sync', ruleName: '每周核对数据同步完整率', group: 'data', count: 1, status: 'done', targets: ['三体云动'] },
      ],
    },

    /** 个人时间管理：把队列任务钉进时间块 */
    dayPlan: {
      date: d(0),
      blocks: DAY_TEMPLATE.map((b, i) => ({
        id: uid('tb'),
        ...b,
        done: false,
        linkedMemberId: i === 1 ? 'm02' : i === 2 ? 'm03' : i === 5 ? 'm07' : null,
        note: '',
      })),
    },

    ai: {},   // 存放"粘贴回来的 AI 结果"，键为任务包 id

    /**
     * 指标基线：无法从本地数据直接算出的指标，先记基线值；
     * 每周手动更新一次，等数据积累够了再逐步改成自动计算。
     * 一定标明是"填报值"，不要冒充系统算出来的。
     */
    metrics: {
      baseline: {
        renewRate: { value: 0.41, unit: '%', note: '上季度门店续费率（店长报表）' },
        wakeRate: { value: 0.23, unit: '%', note: '沉默会员唤醒回店率（本季度手工统计）' },
        activityRoi: { value: 3.4, unit: '倍', note: '秋季体验营单场投入产出' },
        ltvCac: { value: 4.2, unit: '倍', note: '按客单 8600 / 续费 1.6 次估算' },
        onboardingDays: { value: 46, unit: '天', note: '上一位新人首单周期' },
        dataSyncRate: { value: 1, unit: '%', note: '本人负责会员字段完整度（暂无接口，按导入核对）' },
        planRate: { value: 0.72, unit: '%', note: '方案书通过率（手工台账）' },
      },
      updatedAt: d(-7),
    },
  };
}

export const SOURCE_LABEL = SRC_LABEL;
