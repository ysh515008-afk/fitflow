/* ============================================================
   xhs.js · 小红书监控的口径与派生计算
   ------------------------------------------------------------
   和抖音分开一个文件，是因为两平台的取数能力完全不同，
   混在一张表里迟早会有人拿抖音的口径去解释小红书的数字。

   能力边界（依据 integrations/redfox.js 的 meta，不是推测）：
     · 小红书账号维度（粉丝 / 笔记表现）：红狐当前**没有**该接口
       → 账号数字只能手工登记
     · 小红书搜索、小红书爆款笔记库：在红狐能力范围（knownScope）内，
       但端点和字段契约还没登记进 endpointSpec
       → 当前未接线，接线后这两块换成自动取数

   数字口径和抖音那栏一致：缺字段就是「未获取」，不补 0，
   不拿点赞顶替阅读，不拿收藏顶替线索。
   ============================================================ */
import { isNum, round1, mean, median, compact, sum, today } from './util.js';

export const fmtXhsCount = compact;

/** 三项能力的逐项说明，界面直接读这张表，不在视图里偷偷降级 */
export const XHS_CAPABILITY_ITEMS = [
  {
    key: 'account',
    label: '账号维度（粉丝 / 笔记表现）',
    availability: 'unavailable',
    availabilityLabel: '接口未提供',
    source: '手工登记',
    basis: '红狐 API 目录里没有小红书账号维度接口。这条写在该适配器的 notAvailable 清单里：'
      + '原文是「小红书账号维度（粉丝 / 笔记表现），红狐当前没有该接口」。',
    way: '在「账号登记」里自己填粉丝数与笔记数，隔一段时间改一次。数字是你登记的，不是平台返回的，界面上会一直标明。',
  },
  {
    key: 'search',
    label: '小红书搜索',
    availability: 'pending',
    availabilityLabel: '能力已知 · 未接线',
    source: '红狐 · 小红书搜索',
    basis: '这一项在红狐能力清单（knownScope）里，但项目还没登记它的端点路径与字段契约，'
      + 'endpointSpec 里目前全是抖音端点。没有端点就不能发请求，编一个路径出来只会拿到 404。',
    way: '拿到官方文档里的路径、请求体与返回字段之后，照 endpointSpec 现有条目的格式补一项，'
      + '这一块就能换成自动取数。在那之前它不假装能取。',
  },
  {
    key: 'hotNotes',
    label: '小红书爆款笔记库',
    availability: 'pending',
    availabilityLabel: '能力已知 · 未接线',
    source: '红狐 · 小红书爆款笔记库',
    basis: '同样在 knownScope 里，同样没有登记端点与字段契约。爆款笔记库给的是同赛道的热门笔记，'
      + '用来看选题，不是本店账号的表现。',
    way: '补端点登记后自动生效。当前只登记本店自己发的笔记，不拿别人的爆款冒充本店数据。',
  },
];

export const XHS_TONE = {
  api: { cls: 'b-green', text: '接口可取' },
  pending: { cls: 'b-warn', text: '未接线' },
  unavailable: { cls: 'b-danger', text: '接口未提供' },
};

/** 一条笔记登记哪些字段。缺的就留空，界面显示「未获取」。 */
export const XHS_NOTE_FIELDS = [
  { key: 'title', label: '笔记标题', type: 'text', required: true },
  { key: 'publishedAt', label: '发布日期', type: 'date', required: true },
  { key: 'format', label: '形式', type: 'text', hint: '图文 / 视频' },
  { key: 'readCount', label: '阅读', type: 'number' },
  { key: 'likeCount', label: '点赞', type: 'number' },
  { key: 'collectCount', label: '收藏', type: 'number' },
  { key: 'commentCount', label: '评论', type: 'number' },
  { key: 'shareCount', label: '分享', type: 'number' },
  { key: 'leads', label: '带来线索', type: 'number' },
];

/** 爆款线沿用抖音那栏的同一条定义：阅读超过自身均值 3 倍 */
export const XHS_HIT_MULTIPLIER = 3;

/**
 * 由登记的笔记派生汇总。
 * 任何一项算不出来就给 null，界面显示「未获取」。
 * 给 0 会让人以为"这个月一条都没发"或者"阅读真的是 0"。
 */
export function deriveXhsSummary(notes, todayStr = today()) {
  const ws = (notes || []).filter(Boolean);
  const nums = (key) => ws.map((n) => n[key]).filter(isNum);
  const reads = nums('readCount');

  const avgRead = mean(reads);
  const avgLike = mean(nums('likeCount'));
  const avgCollect = mean(nums('collectCount'));
  const avgComment = mean(nums('commentCount'));

  const hitRate = (reads.length >= 5 && isNum(avgRead) && avgRead > 0)
    ? reads.filter((r) => r > avgRead * XHS_HIT_MULTIPLIER).length / reads.length
    : null;

  /* 近 30 天发布数：publishedAt 是 YYYY-MM-DD，字符串比较即可，
     不做 Date 解析（解析会引入时区歧义） */
  const recent = todayStr
    ? ws.filter((n) => typeof n.publishedAt === 'string' && n.publishedAt >= addDaysStr(todayStr, -30))
    : [];

  const gaps = [];
  const sorted = ws.map((n) => n.publishedAt).filter((x) => typeof x === 'string').sort();
  for (let i = 1; i < sorted.length; i++) {
    const g = (Date.parse(sorted[i]) - Date.parse(sorted[i - 1])) / 86400000;
    if (Number.isFinite(g)) gaps.push(g);
  }
  const postGapDays = median(gaps);

  return {
    noteCount: ws.length,
    readSample: reads.length,
    recent30: recent.length,
    avgRead: isNum(avgRead) ? Math.round(avgRead) : null,
    avgLike: isNum(avgLike) ? Math.round(avgLike) : null,
    avgCollect: isNum(avgCollect) ? Math.round(avgCollect) : null,
    avgComment: isNum(avgComment) ? Math.round(avgComment) : null,
    hitRate,
    postGapDays: postGapDays == null ? null : round1(postGapDays),
    leads: sum(nums('leads')),
  };
}

/** 日期字符串加减天数，返回 YYYY-MM-DD */
function addDaysStr(ymd, n) {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 默认状态。小红书这栏目前没有自动取数，所以默认值里没有 snapshot 之类的东西 */
export function defaultXhsState() {
  return {
    binding: null,   // { uniqueName, nickname, followerCount, noteCount, note, boundAt, at }
    notes: [],       // 登记的笔记
    updatedAt: null,
  };
}
