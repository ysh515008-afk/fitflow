/* 演示用的抖音数据集（预览专用，不进运行时）
   ------------------------------------------------------------
   为什么单独放一份、不直接改 seed：
   seed 里那份是"有毛病"的数据（更新慢、爆款率低），专门用来触发建议引擎；
   这一份是"数据齐全"的形态，用来看抖音账号栏每一块在有数时长什么样。

   两条规矩跟项目其它示例数据一样：
     · 一律 isSample: true，界面会顶一条说明标出来，不会冒充真实同步结果
     · 缺的字段就留空，不补 0 —— 补 0 会让人以为接口返回了 0

   数字刻意做得像真实抖音健身号：多数作品几千播放，
   偶尔一两条十几万（把平均播放拉高，爆款率因此偏低，这是真实形态）。 */

const day = (n) => {
  const d = new Date(Date.now() - n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hm = ['07:30', '12:10', '18:40', '20:00', '21:20'];

export const MOCK_ACCOUNT = {
  remoteId: 'lijian_jrc',
  nickname: '力健健身·金融城店',
  signature: '重庆金融城｜私教 / 团课 / 体测 · 每天一条训练干货',
  followerCount: 8420,
  awemeCount: 216,
  totalFavorited: 96400,
  redfoxIndex: 612,
  region: '重庆',
  crawlTime: day(0) + ' 08:40',
};

/* [距今天数, 标题, 播放, 赞, 评, 分享, 收藏]
   发布节奏刻意铺成 5 天一条（中位数 5 天 → 周更 1.4 条），
   这是门店号的真实形态，也让建议引擎真的有话要说：
   预览要看的是"有毛病时建议长什么样"，数据全健康就一条建议都出不来。 */
const RAW = [
  [0,  '会员案例：硬拉 120kg 的第 200 天',                 5200,  210,  18,  24,   30],
  [2,  '练完腿第二天疼，到底该不该继续练',                 12600, 640,  72,  138,  210],
  [7,  '膝盖疼还能练腿吗（3 个替代动作）',                 41200, 1860, 214, 486,  720],
  [12, '体脂 29% → 24%，她的 12 周训练表',                87400, 4320, 386, 1120, 1860],
  [17, '上班族 30 分钟高效训练（无器械）',                 9800,  420,  42,  86,   140],
  [22, '私教课到底贵在哪（成本拆解）',                     7600,  330,  31,  64,   108],
  [27, '体测报告的 5 个数字怎么看',                        6400,  280,  26,  52,   88],
  [32, '女生怕练出肌肉？先看这组数据',                     5900,  260,  24,  48,   82],
  [37, '为什么你练了半年没变化',                           5200,  230,  21,  42,   70],
  [43, '金融城店器械区导览',                               4800,  210,  18,  36,   58],
  [48, '会员采访：从 82kg 到 71kg',                        4300,  190,  16,  32,   50],
  [53, '深蹲膝盖内扣怎么改',                               3900,  170,  14,  28,   44],
  [58, '秋季体验营名额开放',                               3200,  140,  12,  22,   36],
  [64, '训练前热身到底要几分钟',                           11800, 520,  58,  112,  168],
  [69, '减脂期能不能吃碳水',                               15600, 780,  96,  184,  260],
  [74, '一张图看懂胸背腿分化',                             4300,  180,  15,  30,   48],
  [79, '会员第一天进店要做什么',                           3600,  150,  13,  24,   40],
  [85, '私教走了之后怎么自己练',                           3100,  130,  11,  20,   34],
  [90, '金融城上班族的午间训练',                           2800,  120,  10,  18,   30],
  [95, '器械区使用礼仪（真的有人不知道）',                 9400,  430,  37,  88,   132],
];

export const MOCK_WORKS = RAW.map(([ago, title, play, digg, comment, share, collect], i) => ({
  remoteId: `mock_aw_${String(i + 1).padStart(3, '0')}`,
  title,
  createTime: `${day(ago)} ${hm[i % hm.length]}`,
  playCount: play,
  diggCount: digg,
  commentCount: comment,
  shareCount: share,
  collectCount: collect,
  url: '',
  coverUrl: '',
}));

/* 对标候选：体量同档（本店 8420 粉的 0.5 到 5 倍）+ 指数更高 + 同地区才入列，
   最后两个故意超档，用来验证筛选真的在筛、不是全量展示 */
export const MOCK_BENCHMARKS = [
  { remoteId: 'cq_gangtie_fit', nickname: '重庆钢铁健身', followerCount: 21400, awemeCount: 486, totalFavorited: 268000, redfoxIndex: 738, region: '重庆' },
  { remoteId: 'jrc_pt_studio', nickname: '金融城私教工作室', followerCount: 6800, awemeCount: 172, totalFavorited: 74300, redfoxIndex: 655, region: '重庆' },
  { remoteId: 'lian_you_ji', nickname: '练有所记', followerCount: 19800, awemeCount: 731, totalFavorited: 512000, redfoxIndex: 802, region: '重庆' },
  { remoteId: 'shan_cheng_jia_lian', nickname: '山城家练', followerCount: 12600, awemeCount: 308, totalFavorited: 142000, redfoxIndex: 690, region: '重庆' },
  /* 指数低于本店（612）、体量超 5 倍、又不同城：三条口径一条都不占，
     所以会被 pickBenchmarks 筛掉 —— 留着它是为了证明筛选真的在筛 */
  { remoteId: 'quan_guo_top_fit', nickname: '全国健身大榜', followerCount: 3280000, awemeCount: 2140, totalFavorited: 42100000, redfoxIndex: 560, region: '上海' },
];

/* 官方赛道榜：榜位是接口给的 accountRanking，示例里也保持"官方榜位"语义，
   按榜单顺序排列，不做任何重排 */
export const MOCK_BOARD = {
  dateType: 'days',
  rankDate: day(1),
  category: '身体锻炼',
  items: [
    { rank: 1, nickname: '练得狠', url: '', category: '身体锻炼', score: 89.2, followerCount: 2684000, fansGrowth: 32000, likedGrowth: 421000, commentsGrowth: 18600, sharedGrowth: 54000, rankPeriod: '日' },
    { rank: 2, nickname: '体态研究所', url: '', category: '身体锻炼', score: 85.6, followerCount: 1547000, fansGrowth: 21000, likedGrowth: 314000, commentsGrowth: 13200, sharedGrowth: 41000, rankPeriod: '日' },
    { rank: 3, nickname: '硬拉日记', url: '', category: '身体锻炼', score: 82.2, followerCount: 986000, fansGrowth: 17400, likedGrowth: 268000, commentsGrowth: 9200, sharedGrowth: 26000, rankPeriod: '日' },
    { rank: 4, nickname: '一平米健身房', url: '', category: '身体锻炼', score: 78.8, followerCount: 642000, fansGrowth: 12800, likedGrowth: 195000, commentsGrowth: 7100, sharedGrowth: 19000, rankPeriod: '日' },
    { rank: 5, nickname: '跑者笔记', url: '', category: '身体锻炼', score: 76.5, followerCount: 529000, fansGrowth: 9600, likedGrowth: 143000, commentsGrowth: 5400, sharedGrowth: 14000, rankPeriod: '日' },
    { rank: 6, nickname: '拉伸十分钟', url: '', category: '身体锻炼', score: 74.1, followerCount: 418000, fansGrowth: 11200, likedGrowth: 121000, commentsGrowth: 4800, sharedGrowth: 12400, rankPeriod: '日' },
    { rank: 7, nickname: '器械说明书', url: '', category: '身体锻炼', score: 71.9, followerCount: 386000, fansGrowth: 8400, likedGrowth: 108000, commentsGrowth: 4100, sharedGrowth: 10200, rankPeriod: '日' },
    { rank: 8, nickname: '减脂厨房', url: '', category: '身体锻炼', score: 69.4, followerCount: 302000, fansGrowth: 7600, likedGrowth: 96000, commentsGrowth: 3600, sharedGrowth: 8800, rankPeriod: '日' },
  ],
};

/** 上一次同步的派生指标，用来算环比（只存指标，不存原始作品） */
export const MOCK_PREV_METRICS = {
  followerCount: 8180, awemeCount: 208, totalFavorited: 90200, redfoxIndex: 596,
  /* 上一期：平均播放更高（17800）、互动率更高（8.4%）、爆款率更高（25%）、
     发布更勤（3.4 天一条）。和本期放一起正好构成"指数在涨、内容在退"的形态，
     指标板的环比与建议区都有东西可显示。 */
  avgPlay: 17800, avgDigg: 806, avgComment: 74,
  engRate: 0.084, commentRate: 0.0918, hitRate: 0.25,
  postGapDays: 3.4, weeklyPosts: 2.1, sampleSize: 12, playSample: 12,
};
