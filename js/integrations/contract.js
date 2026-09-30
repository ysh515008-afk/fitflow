/* ============================================================
   integrations/contract.js · 统一对接契约
   ------------------------------------------------------------
   设计原则：
   1. 所有对接方（三体 / 勤鸟 / 未来的其它系统）都必须实现同一套接口，
      上层视图只认这套契约，换厂商不用改页面。
   2. 字段映射是"数据"而不是"代码"--写进 store，用户能在界面上改。
   3. 拿不到的数据一律返回 null，由界面显示「未获取」，
      绝不在这里塞默认值或推测值。
   ============================================================ */

/** FitFlow 会员档案的标准字段（对接的落地目标） */
export const MEMBER_FIELDS = [
  { key: 'remoteId', label: '会员 ID', type: 'text', required: true, note: '唯一关联键' },
  { key: 'name', label: '姓名', type: 'text', required: true, note: '' },
  { key: 'phone', label: '手机号', type: 'phone', required: false, note: '用于去重' },
  { key: 'gender', label: '性别', type: 'enum', note: '' },
  { key: 'birthday', label: '生日', type: 'date', note: '可用于生日关怀' },
  { key: 'cardType', label: '会籍 / 卡种', type: 'text', note: '原样保留对方系统名称' },
  { key: 'cardStatus', label: '会籍状态', type: 'enum', note: '原样保留对方叫法，同时归一化到 active/pending/frozen/expired/refunded' },
  { key: 'expireDate', label: '会籍到期日', type: 'date', note: '驱动续费管理' },
  { key: 'joinDate', label: '入会日期', type: 'date', note: '' },
  { key: 'lastRenewDate', label: '上次续费日期', type: 'date', note: '有值即说明发生过续费，用于统计续费率' },
  { key: 'ptTotal', label: '私教总课时', type: 'int', note: '' },
  { key: 'ptLeft', label: '剩余课时', type: 'int', note: '低于 3 节进入待续课名单' },
  { key: 'totalPaid', label: '累计消费', type: 'money', note: '' },
  { key: 'lastVisit', label: '最近到店', type: 'datetime', note: '用于沉默会员识别' },
  { key: 'visits30', label: '近 30 天到店次数', type: 'int', note: '' },
  { key: 'advisorName', label: '所属会籍', type: 'text', note: '用于只读本人负责的会员' },
  { key: 'storeName', label: '所属门店', type: 'text', note: '' },
  { key: 'sysTags', label: '系统标签', type: 'text', note: '对方系统给的会员等级 / 分组标签。和会籍手工打的 tags 是两个字段，互不覆盖' },
];

/**
 * 会籍卡 / 课包维度。
 * 「卡课续费状态」这一类标签的原料全在这张表上，缺一项就有一类标签算不出来。
 * 单独成表的原因和内容侧一样：卡的必填项和信息员的必填项完全不同，
 * 混在一张表里会让"到底缺哪一项"的判断失真。
 */
export const MEMBERSHIP_FIELDS = [
  { key: 'remoteId', label: '卡 / 课包 ID', type: 'text', required: true, note: '唯一关联键' },
  { key: 'memberRemoteId', label: '会员 ID', type: 'text', required: true, note: '' },
  { key: 'cardNo', label: '卡号', type: 'text', note: '' },
  { key: 'name', label: '卡名 / 课包名', type: 'text', required: true, note: '' },
  { key: 'typeId', label: '类型', type: 'enum', required: true, note: '映射为 time 期限卡 / pt 私教 / count 次卡 / group 团课 / stored 储值' },
  { key: 'status', label: '卡状态', type: 'enum', required: true, note: '映射为 active 生效 / pending 未激活 / frozen 冻结 / expired 到期 / refunded 已退' },
  { key: 'startDate', label: '生效日', type: 'date', note: '未激活时为空' },
  { key: 'endDate', label: '到期日', type: 'date', required: true, note: '7 天 / 30 天续费窗口靠它算' },
  { key: 'totalCount', label: '总课时 / 次数', type: 'int', note: '期限卡为 null，不要补 0' },
  { key: 'remainCount', label: '剩余课时 / 次数', type: 'int', note: '低于阈值进入待续课名单' },
  { key: 'paidPrice', label: '实付金额', type: 'money', note: '' },
  { key: 'listPrice', label: '标价', type: 'money', note: '用来算折扣率，不给就空着' },
  { key: 'renewOfRemoteId', label: '上一张卡 ID', type: 'text', note: '有值即说明这是一次续费。比按到期日推算可靠得多' },
];

/** 到店 / 入场记录维度。运动频率标签的原料。 */
export const CHECKIN_FIELDS = [
  { key: 'remoteId', label: '记录 ID', type: 'text', required: true, note: '' },
  { key: 'memberRemoteId', label: '会员 ID', type: 'text', required: true, note: '' },
  { key: 'checkinAt', label: '到店时间', type: 'datetime', required: true, note: '算沉默天数与运动频率' },
  { key: 'device', label: '签到方式', type: 'text', note: '闸机 / 指静脉 / 刷掌 / 人脸 / 前台核销' },
  { key: 'durationMin', label: '停留时长', type: 'int', note: '多数系统不给。拿不到返回 null，不按 0 分钟处理' },
];

export const APPT_FIELDS = [
  { key: 'remoteId', label: '预约 ID', type: 'text', required: true, note: '' },
  { key: 'memberRemoteId', label: '会员 ID', type: 'text', required: true, note: '' },
  { key: 'date', label: '日期', type: 'date', required: true, note: '' },
  { key: 'time', label: '时间', type: 'text', required: true, note: '' },
  { key: 'type', label: '类型', type: 'text', note: '' },
  { key: 'coach', label: '教练', type: 'text', note: '' },
  { key: 'status', label: '状态', type: 'enum', note: '需映射为 pending/confirmed/arrived/noshow/canceled' },
];

export const ORDER_FIELDS = [
  { key: 'remoteId', label: '订单 ID', type: 'text', required: true, note: '' },
  { key: 'memberRemoteId', label: '会员 ID', type: 'text', required: true, note: '' },
  { key: 'paidAt', label: '收款时间', type: 'datetime', note: '' },
  { key: 'amount', label: '金额', type: 'money', note: '用于业绩核对' },
  { key: 'item', label: '项目 / 卡种', type: 'text', note: '' },
  { key: 'payMethod', label: '支付方式', type: 'text', note: '' },
  { key: 'refunded', label: '是否退款', type: 'bool', note: '本工作台默认不计入成交口径' },
];

/* ============================================================
   内容侧字段契约（抖音 / 小红书这类内容平台）
   ------------------------------------------------------------
   为什么和会员字段分开：
     会员来源是"经营系统"，落地目标是会员档案；
     内容来源是"内容平台"，落地目标是账号与作品表现。
     两者的必填项、口径、时效性要求完全不同，混在一张表里
     就会让"缺哪一项"的判断失真。
   ============================================================ */

/** 内容账号维度 */
export const ACCOUNT_FIELDS = [
  { key: 'remoteId', label: '平台账号 ID', type: 'text', required: true, note: '抖音号 / 小红书号，唯一关联键' },
  { key: 'nickname', label: '昵称', type: 'text', required: true, note: '' },
  { key: 'secUid', label: '主页标识', type: 'text', note: '用于拼主页链接' },
  { key: 'avatarUrl', label: '头像', type: 'text', note: '' },
  { key: 'signature', label: '简介', type: 'text', note: '' },
  { key: 'followerCount', label: '粉丝数', type: 'int', required: true, note: '账号维度的核心指标' },
  { key: 'awemeCount', label: '作品总数', type: 'int', note: '' },
  { key: 'totalFavorited', label: '累计获赞', type: 'int', note: '' },
  { key: 'redfoxIndex', label: '红狐指数', type: 'float', note: '平台给的账号综合指数，不给就空着' },
  { key: 'region', label: 'IP 归属地', type: 'text', note: '' },
  { key: 'crawlTime', label: '数据抓取时间', type: 'datetime', note: '第三方数据的时效性必须标出来，否则读者会当成实时值' },
];

/** 内容作品维度 */
export const WORK_FIELDS = [  { key: 'remoteId', label: '作品 ID', type: 'text', required: true, note: '' },
  { key: 'title', label: '标题 / 文案', type: 'text', note: '' },
  { key: 'createTime', label: '发布时间', type: 'datetime', note: '算更新频率用' },
  { key: 'diggCount', label: '点赞', type: 'int', note: '' },
  { key: 'commentCount', label: '评论', type: 'int', note: '' },
  { key: 'shareCount', label: '分享', type: 'int', note: '' },
  { key: 'collectCount', label: '收藏', type: 'int', note: '' },
  { key: 'playCount', label: '播放', type: 'int', note: '平台常常不返回，返回 null 时按缺数据处理，不要补 0' },
  { key: 'interactiveCount', label: '互动总数', type: 'int', note: '' },
  { key: 'url', label: '作品链接', type: 'text', note: '' },
  { key: 'coverUrl', label: '封面', type: 'text', note: '' },
];

/**
 * 赛道榜条目维度。
 * 和 ACCOUNT_FIELDS 分开，因为榜位与增量是榜单特有字段：
 * 塞进账号字段表会让"账号必填项"这张表混进只有榜单才有的东西。
 */
export const RANK_FIELDS = [
  { key: 'rank', label: '官方榜位', type: 'int', required: true, note: '接口给的 accountRanking，不重排' },
  { key: 'nickname', label: '账号名', type: 'text', required: true, note: '' },
  { key: 'url', label: '账号链接', type: 'text', note: '' },
  { key: 'category', label: '赛道', type: 'text', note: '' },
  { key: 'score', label: '综合评分', type: 'float', note: '满分 100，官方加权口径' },
  { key: 'followerCount', label: '粉丝数', type: 'int', note: '' },
  { key: 'fansGrowth', label: '粉丝增量', type: 'int', note: '' },
  { key: 'likedGrowth', label: '点赞增量', type: 'int', note: '' },
  { key: 'commentsGrowth', label: '评论增量', type: 'int', note: '' },
  { key: 'sharedGrowth', label: '分享增量', type: 'int', note: '' },
  { key: 'rankPeriod', label: '榜期', type: 'text', note: '' },
];

/* ---------------- 取值：支持 a.b.c / a.0.b 形式的路径 ---------------- */
export function valueAt(obj, path) {
  if (!obj || !path) return null;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur === undefined ? null : cur;
}

/* ---------------- 类型转换 ---------------- */
export const TRANSFORMS = {
  text: (v) => (v == null || v === '' ? null : String(v).trim()),
  int: (v) => {
    if (v == null || v === '') return null;
    const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
    return isNaN(n) ? null : n;
  },
  float: (v) => {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
    return isNaN(n) ? null : n;
  },
  money: (v) => {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
    return isNaN(n) ? null : Math.round(n * 100) / 100;
  },
  bool: (v) => {
    if (v == null || v === '') return null;
    const s = String(v).trim().toLowerCase();
    return ['1', 'true', 'y', 'yes', '是', '已退款', 'true'].includes(s);
  },
  /** 统一成 YYYY-MM-DD；识别不了就返回 null（不猜） */
  date: (v) => {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    const m = s.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString().slice(0, 10);
    if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
    return null;
  },
  datetime: (v) => {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    const dm = TRANSFORMS.date(s);
    if (!dm) return null;
    const t = s.match(/(\d{1,2}):(\d{2})/);
    return dm + (t ? ` ${String(t[1]).padStart(2, '0')}:${t[2]}` : '');
  },
  /** 去掉掩码，保留原始字符串（不尝试还原被打码的内容） */
  phone: (v) => {
    if (v == null || v === '') return null;
    const s = String(v).replace(/\s|-/g, '');
    return s || null;
  },
  /**
   * 标签数组。对方系统可能给 JSON 数组，也可能给逗号 / 分号 / 顿号串。
   * 空数组返回 null 而不是 []，这样 merge 时能区分"远端说没有标签"和
   * "远端这次没返回标签字段"，前者该清空、后者该保持原值。
   */
  tags: (v) => {
    if (v == null || v === '') return null;
    const arr = Array.isArray(v) ? v : String(v).split(/[,，;；|、]/);
    const out = arr.map((x) => String(x).trim()).filter(Boolean);
    return out.length ? out : null;
  },
  /**
   * 中文计数的紧凑写法转数值。
   * 红狐榜单把粉丝数写成 "179.79w"、增量写成 "2.56w"，直接 int 转换会得到 179，
   * 差三个数量级。这里识别 亿 / 万 / w / k 四种后缀。
   *
   * 两种情况的精度处理不一样：
   *   带单位 → 取整。带单位的都是计数（粉丝、点赞），小数位是压缩写法留下的，不是精度。
   *   不带单位 → 原样保留小数。不带单位的可能是评分这类本身就有小数的值，
   *              在这里取整会把 878.7 变成 879，属于悄悄改数据。
   * 解析失败返回 null，不返回 0：0 是"确实是零"，null 是"没拿到"，两者不能混。
   */
  cnNum: (v) => {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    const m = s.match(/^(-?[\d.]+)\s*(亿|万|w|W|k|K)?/);
    if (!m) return null;
    const base = parseFloat(m[1]);
    if (isNaN(base)) return null;
    const unit = m[2];
    if (!unit) return base;
    const mul = unit === '亿' ? 1e8
      : unit === 'k' || unit === 'K' ? 1e3
        : 1e4;                                   // 万 / w / W
    return Math.round(base * mul);
  },
};

/**
 * 按映射规则把一条远端记录归一化成FitFlow 标准对象
 * @param {object} raw 远端原始记录
 * @param {Array<{target,source,transform}>} mapping 映射规则
 * @param {Array} fields 该资源对应的字段表（决定哪些缺失算"必填没拿到"）
 */
export function normalize(raw, mapping = [], fields = MEMBER_FIELDS) {
  const out = {};
  const missing = [];
  mapping.forEach(({ target, source, transform = 'text' }) => {
    const fn = TRANSFORMS[transform] || TRANSFORMS.text;
    const v = fn(valueAt(raw, source));
    out[target] = v;
    if (v == null && fields.find((f) => f.key === target)?.required) missing.push(source);
  });
  return { data: out, missing };
}

/** 状态值归一化：不同系统叫法不同，统一到FitFlow 的 5 个状态 */
const STATUS_ALIASES = {
  pending: ['待确认', '待处理', 'pending', '未确认', '预约中'],
  confirmed: ['已确认', '已预约', 'confirmed', '预约成功'],
  arrived: ['已到店', '已签到', '已完成', 'arrived', '已核销', '已消课'],
  noshow: ['爽约', '未到店', 'no_show', 'noshow', '未签到'],
  canceled: ['已取消', '已作废', 'canceled', 'cancelled', '取消'],
};
export function normalizeApptStatus(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;                       // 拿不到就返回 null，不默认成 pending
  for (const [key, list] of Object.entries(STATUS_ALIASES)) {
    if (list.some((x) => x.toLowerCase() === s || s.includes(x.toLowerCase()))) return key;
  }
  return null;
}

/** 卡状态归一化。卡课续费标签全靠它，认不出来就返回 null，不猜成 active。 */
const CARD_STATUS_ALIASES = {
  active: ['生效', '使用中', '正常', '有效', '已激活', 'active', 'in_use'],
  pending: ['未激活', '待激活', '待开卡', '未开卡', 'pending', 'not_activated'],
  frozen: ['冻结', '暂停', '停卡', '已冻结', 'frozen', 'paused'],
  expired: ['已到期', '已过期', '过期', '失效', 'expired', 'overdue'],
  refunded: ['已退款', '退卡', '已退', '作废', 'refunded', 'canceled'],
};
export function normalizeCardStatus(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  for (const [key, list] of Object.entries(CARD_STATUS_ALIASES)) {
    if (list.some((x) => x.toLowerCase() === s || s.includes(x.toLowerCase()))) return key;
  }
  return null;
}

/** 卡类型归一化：把对方的卡种名称归到FitFlow 的 5 个 typeId */
const CARD_TYPE_ALIASES = {
  pt: ['私教', 'PT', 'pt', '教练课', '一对一'],
  group: ['团课', '团操', '小组课', '训练营', 'group'],
  count: ['次卡', '次数卡', '计次', '10 次', '20 次'],
  stored: ['储值', '充值', '余额', 'stored'],
  time: ['年卡', '半年卡', '季卡', '月卡', '期限卡', '时效卡', 'time'],
};
export function normalizeCardType(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  for (const [key, list] of Object.entries(CARD_TYPE_ALIASES)) {
    if (list.some((x) => s.toLowerCase().includes(x.toLowerCase()))) return key;
  }
  return null;
}

/* ---------------- 统一错误类型 ---------------- */
export class ConnectorError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;              // unauthorized | network | cors | endpoint_unverified | parse | unknown
    this.detail = detail;
  }
}

export function requireVerified(spec) {
  const pending = Object.entries(spec.endpoints || {})
    .filter(([, e]) => !e.verified)
    .map(([k]) => k);
  if (pending.length) {
    throw new ConnectorError(
      'endpoint_unverified',
      `端点尚未核对：${pending.join('、')}。请先用官方文档确认路径与鉴权字段后，在「数据连接 → 接口规格」里勾选已核对。`,
      { pending }
    );
  }
}

/**
 * 把映射后的数据合并进FitFlow 档案。
 *
 * 关于标签的分工（这条容易搞错，写清楚）：
 *   tags     手工标签，会籍自己打的（"高价值""已转介绍 2 人"），远端不许覆盖。
 *   sysTags  系统标签，三体 / 勤鸟直接给的会员等级与分组，远端必须覆盖。
 * 两者是两个字段，不是一回事。以前只有 tags 一个字段，所以只能整体保护，
 * 结果是系统里的会员等级永远同步不进来，只能靠人手工抄。
 */
export function mergeIntoMember(existing, incoming) {
  const FITFLOW_ONLY = ['note', 'goals', 'intents', 'concerns', 'tags', 'stage', 'id'];
  const out = { ...existing };
  Object.entries(incoming).forEach(([k, v]) => {
    if (v == null) return;                    // 远端没给 → 保持原值，不覆盖
    if (FITFLOW_ONLY.includes(k)) return;     // FitFlow 内部字段不接受远端覆盖
    out[k] = v;
  });
  out.syncedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return out;
}

/**
 * 把会籍卡合并进本地卡表。
 * 卡的更新比会员更需要"只增不减"：远端不返回 remainCount 的时候，
 * 不能把本地已有的剩余课时抹成 null，否则标签会集体变成"无数据"。
 */
export function mergeIntoCard(existing, incoming) {
  const out = { ...existing };
  Object.entries(incoming).forEach(([k, v]) => {
    if (v == null) return;
    out[k] = v;
  });
  out.syncedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return out;
}
