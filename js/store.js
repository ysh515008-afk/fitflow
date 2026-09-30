/* ============================================================
   store.js · 数据层
   - localStorage 持久化（个人使用阶段，后续可平滑替换为云端 API）
   - commit() 统一写入 + 通知重渲染
   - 所有派生数据（今日队列、临期、漏斗）都在 selectors 里算，不落库
   ============================================================ */
import { buildSeed } from './data/seed.js';
import { cardStatus, cardUrgency } from './data/membership.js';
import { DAY_TEMPLATE } from './data/automation.js';
import { defaultDouyinState, deriveMetrics } from './douyin.js';
import { defaultXhsState, deriveXhsSummary } from './xhs.js';
import { defaultFeatures, isFeatureOn } from './features.js';
import { defaultBizState } from './integrations/index.js';
import { uid, today, nowISO, daysBetween, sortBy, sum, groupBy, ratio, addDays, pad, parseDate, mondayOf } from './util.js';

const KEY = 'fitflow.v1';
/* 加密存储：会员个人/健康数据不再以明文 JSON 落盘（合规：PIPL 第51条、网安法第21条） */
const ENC_PREFIX = 'ffenc:';
const ENC_KEY_SLOT = 'fitflow.k';

/* ---------------- 本地加密（AES-GCM，Web Crypto） ----------------
   做法：在浏览器生成一个不导出的 AES-256 密钥，存于独立 localStorage 槽位；
   会员库写入前用它对整库 JSON 做 AES-GCM 加密。这样 localStorage 里不再是
   明文 PII，XSS / 公用电脑 / 本机恶意脚本无法直接读走会员档案。
   退化：若运行环境没有 Web Crypto（如 file:// 非安全上下文），退化为明文落盘并告警。 */

async function getCryptoKey() {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto 不可用');
  let raw = localStorage.getItem(ENC_KEY_SLOT);
  if (!raw) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    raw = btoa(String.fromCharCode(...bytes));
    localStorage.setItem(ENC_KEY_SLOT, raw);
  }
  const buf = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', buf, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptStr(str) {
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(str),
  );
  const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
  return b64(ct) + '.' + b64(iv);
}

async function decryptStr(packed) {
  const [ ctB64, ivB64 ] = packed.split('.');
  if (!ctB64 || !ivB64) throw new Error('密文格式错误');
  const key = await getCryptoKey();
  const ct = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/**
 * 状态色系统（不是装饰色）：
 *   绿 = 正向/在练  蓝 = 进行中/线索  青 = 体验期  琥珀 = 需干预  红 = 已流失  灰 = 中性/未知
 * 全站只用一个品牌色（绿），其余颜色只承担语义。
 */
export const STAGES = {
  lead: { label: '线索', cls: 'b-info', order: 0 },
  trial: { label: '体验中', cls: 'b-teal', order: 1 },
  active: { label: '在练', cls: 'b-green', order: 2 },
  renewing: { label: '续费洽谈', cls: 'b-warn', order: 3 },
  silent: { label: '沉默', cls: 'b-warn', order: 4 },
  expired: { label: '已过期', cls: 'b-danger', order: 5 },
};

/* 跟进沟通渠道。
   气泡选择器只展示 CHANNEL_BUBBLES 这 7 项：电话 / 微信 / 小红书 / 抖音 / 闲鱼 / 当面 / 其他。
   旧渠道（trial / community / system）仅保留标签做历史兜底——老跟进记录里可能仍是这些渠道，
   读的时候还能显示中文名，但不再出现在新建选择器里，避免界面露出原始 id。 */
export const CHANNELS = {
  phone: { label: '电话', icon: 'i-phone' },
  wechat: { label: '微信', icon: 'i-chat' },
  xhs: { label: '小红书', icon: 'i-xhs' },
  douyin: { label: '抖音', icon: 'i-douyin' },
  xianyu: { label: '闲鱼', icon: 'i-xianyu' },
  visit: { label: '当面', icon: 'i-users' },
  other: { label: '其他', icon: 'i-other' },
  /* 历史兜底，仅用于读老数据，不进选择器 */
  trial: { label: '体验课', icon: 'i-flame' },
  community: { label: '社群', icon: 'i-ops' },
  system: { label: '系统通知', icon: 'i-bell' },
};

/** 新建跟进时一次点击气泡选择器展示的 7 个渠道（顺序即展示顺序） */
export const CHANNEL_BUBBLES = ['phone', 'wechat', 'xhs', 'douyin', 'xianyu', 'visit', 'other'];

export const APPT_TYPES = ['体验课', '体测', '回访', '续费面谈', '私教课', '私教加课洽谈'];
export const APPT_STATUS = {
  pending: { label: '待确认', cls: 'b-plain' },
  confirmed: { label: '已确认', cls: 'b-info' },
  arrived: { label: '已到店', cls: 'b-green' },
  noshow: { label: '爽约', cls: 'b-danger' },
  canceled: { label: '已取消', cls: 'b-plain' },
};

let state = null;
const listeners = new Set();

/* ---------------- 读写 ---------------- */

function migrate(raw) {
  const seed = buildSeed();
  const dflt = defaultDouyinState();
  const dfltBiz = defaultBizState();
  const rd = raw.douyin || {};
  const rb = raw.biz || {};
  return {
    ...seed,
    ...raw,
    settings: { ...seed.settings, ...(raw.settings || {}) },
    /* 可选配功能：表里新增的模块要能自动兜到默认值，
       否则老数据升级上来会因为缺 key 而按 defaultOn 走，
       看起来像"用户设置被重置了" */
    features: { ...defaultFeatures(), ...(raw.features || {}) },
    connectors: {
      ...seed.connectors,
      ...(raw.connectors || {}),
      santi: { ...seed.connectors.santi, ...((raw.connectors || {}).santi || {}) },
      qinniao: { ...seed.connectors.qinniao, ...((raw.connectors || {}).qinniao || {}) },
    },
    /* 交易后台：两个平台的配置各自逐层兜默认值，
       报表记录是一张平表，按 source + date 去重由写入方负责 */
    biz: {
      ...dfltBiz,
      ...rb,
      laike: { ...dfltBiz.laike, ...(rb.laike || {}) },
      meituan: { ...dfltBiz.meituan, ...(rb.meituan || {}) },
      records: rb.records || [],
    },
    /* 未读提醒只记"哪些 id 已读"。消息本身每天重算，
       不落库，避免旧消息越堆越多 */
    opsBrief: {
      date: raw.opsBrief?.date || today(),
      readIds: raw.opsBrief?.readIds || [],
    },
    /* 今日工作量：操作量 / 观察量按自然天累计，跨天自动清零。
       老数据升级上来没有这个 key，兜成当天 0 / 0，
       不兜会让计数器读成 undefined，界面直接显示 NaN。 */
    workload: {
      date: raw.workload?.date || today(),
      ops: raw.workload?.ops || 0,
      obs: raw.workload?.obs || 0,
    },
    /* 抖音监控：嵌套对象都要逐层兜默认值，否则老数据里缺 monitor
       会让 setDouyinMonitor 把整个对象写坏 */
    douyin: {
      ...dflt,
      ...rd,
      monitor: { ...dflt.monitor, ...(rd.monitor || {}) },
      storeHeat: { ...dflt.storeHeat, ...(rd.storeHeat || {}) },
      boardQuery: { ...dflt.boardQuery, ...(rd.boardQuery || {}) },
      benchmarks: rd.benchmarks || [],
      log: rd.log || [],
    },
    /* 小红书：红狐没有账号维度接口，所以这一栏的账号数字是手工登记的，
       笔记也是登记进来的。和抖音那栏分开存，免得把两套口径混在一起。 */
    xhs: {
      ...defaultXhsState(),
      ...(raw.xhs || {}),
      notes: raw.xhs?.notes || defaultXhsState().notes,
    },
    learning: { ...seed.learning, ...(raw.learning || {}) },
    metrics: { ...seed.metrics, ...(raw.metrics || {}) },
    /* 会员逐条兜字段：登记流失（lost）与同事备注（colleagueNotes）是后加的，
       老数据升级上来没有这两个 key，不兜会让「流失」读成 undefined、
       同事备注渲染时 .map 直接崩。 */
    members: (raw.members || seed.members).map((m) => ({
      ...m,
      colleagueNotes: m.colleagueNotes || [],
      lost: !!m.lost,
      lostAt: m.lostAt || null,
      lostReason: m.lostReason || '',
    })),
    cards: raw.cards || seed.cards,
    automations: { ...seed.automations, ...(raw.automations || {}), rules: { ...((raw.automations || {}).rules || {}) } },
    /* 时间块提醒：老数据升级上来可能缺 remind 字段，逐块兜默认值，
       否则调整栏里读 remind.method 会拿到 undefined */
    dayPlan: {
      ...(raw.dayPlan || seed.dayPlan),
      blocks: (raw.dayPlan?.blocks || seed.dayPlan.blocks).map((b) => ({ ...b, remind: b.remind || defaultRemind() })),
    },
    followups: raw.followups || seed.followups,
    appointments: raw.appointments || seed.appointments,
    renewalPlans: raw.renewalPlans || seed.renewalPlans,
    groups: raw.groups || seed.groups,
    campaigns: raw.campaigns || seed.campaigns,
    leads: raw.leads || seed.leads,
    goals: raw.goals || seed.goals,
    history: raw.history || seed.history,
    /* 客户卡报错工单：用户对同步回来的卡信息主动挑错。
       只增不改不删（核对流程在线下），状态机留给后续接工单系统 */
    cardErrors: raw.cardErrors || [],
    /* 跨平台回写留痕：每条跟进推给三体 / 勤鸟的结果都记一笔。
       作用只有一个 —— 事后能回答「这条到底落到对方系统里没有」。 */
    writebackLogs: raw.writebackLogs || [],
    ai: raw.ai || {},
    /* AI 转写跟进：上传的会面转写文档 + 提炼出的会面纪要。
       原文与纪要都只存在本机，随 state 一起加密落盘。 */
    aiMaterials: raw.aiMaterials || [],
  };
}

async function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return migrate(buildSeed());
    /* 已加密：解密后解析；明文是旧版本（兼容迁移），直接解析，下次 persist 会自动加密 */
    let parsed;
    if (raw.startsWith(ENC_PREFIX)) {
      if (!globalThis.crypto?.subtle) {
        /* 已有加密数据，但当前环境无法解密（非安全上下文）：如实告警并回退示例数据，
           不静默吞掉，也不把异常抛给 boot 导致白屏。 */
        console.warn('本地数据已加密，但当前环境无 Web Crypto，无法解密，已回退为示例数据。请改用 https / localhost 打开以读取已加密的本地数据。');
        return buildSeed();
      }
      parsed = JSON.parse(await decryptStr(raw.slice(ENC_PREFIX.length)));
    } else {
      parsed = JSON.parse(raw);
    }
    if (!parsed || !Array.isArray(parsed.members)) return buildSeed();
    return migrate(parsed);
  } catch (e) {
    console.warn('读取本地数据失败，已使用示例数据', e);
    return buildSeed();
  }
}

async function persist() {
  try {
    const enc = await encryptStr(JSON.stringify(state));
    localStorage.setItem(KEY, ENC_PREFIX + enc);
  } catch (e) {
    /* 加密不可用：退化为明文，避免丢数据，但必须告警（此时不再符合加密存储要求） */
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
    console.warn('本地加密不可用，已退化为明文存储，请改在 https / localhost 等安全上下文运行', e);
  }
}

export async function init() {
  state = await load();
  await persist();
  return state;
}

export function get() { return state; }

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function emit() {
  listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } });
}

/** 统一写入：mutator 直接改 state，提交后落库并通知 */
export function commit(mutator, { silent = false } = {}) {
  mutator(state);
  state.settings.updatedAt = nowISO();
  void persist();
  if (!silent) emit();
}

/* ============================================================
   今日工作量：操作量 / 观察量
   ------------------------------------------------------------
   操作量 = 真做出去的动作：
     跟进备注一次 / 完成一个成长课时 / 抖音账号新发布一条视频 / 复制话术并跳转微信
   观察量 = 看与判断：
     点开客户卡详情 / 用 AI 生成话术 / 处理一条进化建议 / 主动更新或对接外部平台接口

   两者都按自然天累计，跨天自动清零；只在动作真实发生时累加，
   没有任何推算、补记或按人数放大 —— 一次动作就是一次。
   ============================================================ */

/** 读取今日工作量。日期不是今天时按 0 返回，绝不返回昨天的存量。 */
export function todayWorkload(s = state) {
  const w = s.workload;
  if (!w || w.date !== today()) return { date: today(), ops: 0, obs: 0 };
  return { date: w.date, ops: w.ops || 0, obs: w.obs || 0 };
}

/**
 * 在一次 commit 内部顺手累加（不额外触发一次提交）。
 * @param {'ops'|'obs'} kind
 */
export function addWorkload(s, kind, n = 1) {
  const t = today();
  if (!s.workload || s.workload.date !== t) s.workload = { date: t, ops: 0, obs: 0 };
  const k = kind === 'obs' ? 'obs' : 'ops';
  const add = Math.max(0, Math.round(n) || 0);
  if (!add) return;
  s.workload[k] = (s.workload[k] || 0) + add;
}

/** 记一次工作量（独立调用：自己提交并通知界面）。 */
export function bumpWorkload(kind, n = 1) {
  commit((s) => addWorkload(s, kind, n));
}

/* ---------------- 会员 ---------------- */

export function saveMember(data, id) {
  commit((s) => {
    if (id) {
      const i = s.members.findIndex((m) => m.id === id);
      if (i > -1) s.members[i] = { ...s.members[i], ...data, updatedAt: nowISO() };
    } else {
      const m = {
        gender: '男', age: 28, source: 'walkin', stage: 'lead', owner: s.settings.advisor,
        tags: [], intents: [], concerns: [], goals: [], hasPT: false, ptTotal: 0, ptLeft: 0,
        visits30: 0, totalPaid: 0, createdAt: today(), ...data, id: uid('m'),
      };
      s.members.unshift(m);
    }
  });
}

export function deleteMember(id) {
  commit((s) => {
    s.members = s.members.filter((m) => m.id !== id);
    s.followups = s.followups.filter((f) => f.memberId !== id);
    s.appointments = s.appointments.filter((a) => a.memberId !== id);
    s.renewalPlans = s.renewalPlans.filter((r) => r.memberId !== id);
    s.cards = (s.cards || []).filter((c) => c.memberId !== id);
  });
}

/**
 * 登记流失。
 *
 * 与「删除会员」是两件事：删除把档案连同跟进、预约、会籍卡一起抹掉，
 * 事后无法回答"这个人为什么没了"；登记流失只打标记 `lost = true`，
 * 档案与全部历史留在本机，从日常名单里移出，不再进智能体与待跟进队列。
 *
 * 理由必填：流失原因本身就是复盘要用的数据，空着等于丢一块。
 */
export function markMemberLost(id, reason = '') {
  commit((s) => {
    const m = s.members.find((x) => x.id === id);
    if (!m) return;
    m.lost = true;
    m.lostAt = m.lostAt || today();
    m.lostReason = reason || '';
    m.updatedAt = nowISO();
  });
}

/** 撤销登记流失：把人放回日常名单，流失原因一并清掉。 */
export function restoreMember(id) {
  commit((s) => {
    const m = s.members.find((x) => x.id === id);
    if (!m) return;
    m.lost = false;
    m.lostAt = null;
    m.lostReason = '';
    m.updatedAt = nowISO();
  });
}

/** 日常名单：未标记流失的会员。所有列表、智能体、队列都只认这一份。 */
export const liveMembers = (s = state) => (s.members || []).filter((m) => !m.lost);
/** 已登记流失的会员：流失会员池单独出数，客户池里置底灰显，不进智能体与任何待办。 */
export const lostMembers = (s = state) => (s.members || []).filter((m) => m.lost);

/* ---------------- 同事备注 ----------------
   三体 / 勤鸟里「跟进记录」是全员可见的：谁写的、写了什么，系统里都有。
   FitFlow 只做呈现与本地补录，不去改来源系统 —— 所以同步来的条目只读，
   本地补录的条目可删。
   每条结构：{ id, author, text, at, source }
   source: 'santi' | 'qinniao' | 'local'
------------------------------------------- */

export const colleagueNotesOf = (memberId) => {
  const m = memberById(memberId);
  return sortBy(m?.colleagueNotes || [], (n) => n.at, 'desc');
};

/**
 * 补一条同事备注。
 * 只补本地（source: 'local'）：来源系统里的条目由同步写进来，
 * 本地手写的和同步来的必须能分清，否则事后无法判断一句话是谁留的。
 */
export function addColleagueNote(memberId, { author, text, at }) {
  const a = String(author || '').trim();
  const t = String(text || '').trim();
  if (!a || !t) return null;
  let created = null;
  commit((s) => {
    const m = s.members.find((x) => x.id === memberId);
    if (!m) return;
    created = { id: uid('cn'), author: a, text: t, at: at || today(), source: 'local' };
    m.colleagueNotes = [created, ...(m.colleagueNotes || [])];
    m.updatedAt = nowISO();
  });
  return created;
}

/** 只删本地补录的条目；同步来的删不掉（源头在来源系统里）。 */
export function deleteColleagueNote(memberId, noteId) {
  commit((s) => {
    const m = s.members.find((x) => x.id === memberId);
    if (!m) return;
    m.colleagueNotes = (m.colleagueNotes || []).filter((n) => !(n.id === noteId && n.source === 'local'));
    m.updatedAt = nowISO();
  });
}

export function setMemberStage(id, stage) {
  commit((s) => { const m = s.members.find((x) => x.id === id); if (m) m.stage = stage; });
}

/**
 * 只写备注一个字段。
 *
 * 不复用 saveMember，是因为备注要在列表和触达台里防抖自动保存：
 * saveMember 会把整个档案合并重写一遍，表单里没带到的字段会被 undefined 冲掉，
 * 而且每敲一个字都触发一次全量重渲染，输入框会掉焦点。
 *
 * silent 给"边打字边存"用。打字过程中重渲染会把光标弹回开头，
 * 所以录入途中静默写盘，等失焦（change）再补一次带通知的写入，
 * 让会员档案、标签这些下游视图跟上。
 */
export function setMemberNote(id, note, { silent = false } = {}) {
  commit((s) => {
    const m = s.members.find((x) => x.id === id);
    if (m) { m.note = String(note || ''); m.updatedAt = nowISO(); }
  }, { silent });
}

/* ---------------- 跟进 ---------------- */

/**
 * 从跟进摘要里确定性提取"向客户报出的价格"。
 * 触发条件明确：摘要中出现报价类关键词（报价 / 报了 / 提了 / 出价 / 报个价 / 价格 / 给了…价）
 * 且其后 ~14 字内出现金额。不靠概率判断，命中规则才提取，没命中返回 0。
 * 支持的写法：报价 2980 / 报价¥2980 / 报了 2980 元 / 提了个 2680 的价 / 价格 16800 元。
 */
export function extractQuote(text) {
  if (!text) return 0;
  const re = /(报价|报了|提了|出了|出价|报个价|价格|给了[^，。]{0,6}价)[^\d¥￥元块]{0,14}?[¥￥]?\s?(\d{1,3}(?:,\d{3})+|\d+)\s*(元|块|rmb)?/i;
  const m = text.match(re);
  if (!m) return 0;
  const n = Number(String(m[2]).replace(/[,\s]/g, ''));
  return n > 0 ? n : 0;
}

export function addFollowup(f) {
  commit((s) => {
    const rec = { id: uid('f'), date: today(), channel: 'wechat', result: 'neutral', ...f };
    s.followups.unshift(rec);
    /* 工作量：写一条跟进备注 = 一次操作量 */
    addWorkload(s, 'ops');
    /* 跟进 ↔ 续费桥接：这次跟进若提及向客户报价，自动把金额送到续费计划。
       机制确定性——只有 extractQuote 命中才写，且标记 quoteAuto，方便续费栏识别"这是自动来的、可改"。 */
    const q = extractQuote(f.summary);
    if (q > 0) {
      const i = s.renewalPlans.findIndex((r) => r.memberId === f.memberId);
      const base = i > -1 ? s.renewalPlans[i] : { id: uid('r'), memberId: f.memberId, dueDate: null, stage: '未启动', quoteAmount: 0, expectedAmount: 0, blockers: [], updatedAt: today() };
      base.quoteAmount = q;
      base.quoteAuto = true;
      base.quoteFromFollowup = rec.id;
      base.updatedAt = today();
      if (i > -1) s.renewalPlans[i] = base; else s.renewalPlans.push(base);
    }
  });
}

export function updateFollowup(id, patch) {
  commit((s) => { const i = s.followups.findIndex((f) => f.id === id); if (i > -1) s.followups[i] = { ...s.followups[i], ...patch }; });
}

/* ---------------- 跨平台回写留痕 ---------------- */

/**
 * 记一次回写结果。三种都要记：
 *   api    接口写入成功 / 失败
 *   paste  复制了文本，由人粘进对方后台
 *   csv    导出了表格，由人导入对方系统
 * 「复制了」不等于「写进去了」，所以 paste / csv 的 status 是 manual，不是 ok。
 */
export function addWritebackLog(entry) {
  commit((s) => {
    s.writebackLogs = [entry, ...(s.writebackLogs || [])].slice(0, 500);
  });
}

/** 某条跟进的回写记录，最新在前 */
export const writebackLogsOf = (followupId) =>
  (state.writebackLogs || []).filter((x) => x.followupId === followupId)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));

/* ---------------- 触达留痕 ---------------- */

/** 结果的中文说法。界面和导出的提示词都用这一份，不各写各的。 */
export const RESULT_LABEL = {
  positive: '正向：有明确推进',
  neutral: '中性：有回应但没定',
  no_reply: '未回复',
  negative: '负向：明确拒绝',
  pending: '已触达，结果待补',
};

/**
 * 记一次触达（拨号或发微信）。
 *
 * 为什么必须在跳走之前写：
 *   点了「拨打」之后控制权就交给系统电话了，这个页面收不到任何回调。
 *   通没通、说没说上话、谈了多久，我们一无所知。
 *   唯一能确定的是——此刻，对这个号码，发起过一次联系。
 *   把这一件确定的事如实记下来，其余留空等人回来补。
 *
 * 为什么不直接写"已联系"：
 *   一条写着已联系、其实没接通的记录，比没有记录更危险。
 *   下次跟进的人会据此判断"这个人最近刚沟通过，先放一放"，
 *   判断就建立在假数据上了。这是「拿不到就 null 不补 0」在跟进记录上的同一条原则。
 *
 * @returns {object} 刚写入的那条记录。id 要留着，回来补结果时用它。
 */
export function logReach(memberId, { channel = 'phone', phone = '', note = '' } = {}) {
  const now = new Date();
  const at = nowISO();
  const hhmm = now.toTimeString().slice(0, 5);
  const rec = {
    id: uid('f'), memberId, date: today(), at,
    channel,
    kind: 'reach',
    result: 'pending',
    /* hhmm 单独存一份本地时刻。
       at 是 ISO（UTC），直接切字符串显示会差一个时区 ——
       同一条记录里摘要写 21:09、标题写 13:09，看着就像两条。 */
    hhmm,
    summary: channel === 'phone' ? `拨出 ${phone}（${hhmm}）` : `发微信（${hhmm}）`,
    feedback: '',
    nextDate: null,
    nextAction: '',
    reach: { at, channel, phone, note: String(note || '').slice(0, 200), outcome: null },
  };
  commit((s) => { s.followups.unshift(rec); });
  return rec;
}

/**
 * 一条触达记录的本地时刻（HH:MM）。
 * 一律走这里，不要自己去切 at 字符串 —— 那是 UTC。
 * 老记录没有 hhmm 字段，就按 ISO 反算成当地时间兜底。
 */
export function reachTime(f) {
  if (!f) return '';
  if (f.hhmm) return f.hhmm;
  if (!f.at) return '';
  try { return new Date(f.at).toTimeString().slice(0, 5); } catch { return ''; }
}

/** 这位会员还没补结果的触达记录，最新的在前 */
export const pendingReachOf = (memberId) =>
  (state.followups || []).filter((f) => f.memberId === memberId && f.kind === 'reach' && f.result === 'pending');

/* ---------------- 预约 ---------------- */

export function upsertAppointment(a, id) {
  commit((s) => {
    if (id) {
      const i = s.appointments.findIndex((x) => x.id === id);
      if (i > -1) s.appointments[i] = { ...s.appointments[i], ...a };
    } else {
      s.appointments.unshift({ id: uid('a'), status: 'pending', coach: s.settings.advisor, ...a });
    }
  });
}

export function setApptStatus(id, status) {
  commit((s) => { const a = s.appointments.find((x) => x.id === id); if (a) a.status = status; });
}

export function deleteAppointment(id) {
  commit((s) => { s.appointments = s.appointments.filter((a) => a.id !== id); });
}

/* ---------------- 续费 ---------------- */

export function upsertRenewal(p, memberId) {
  commit((s) => {
    const i = s.renewalPlans.findIndex((r) => r.memberId === memberId);
    const merged = { id: i > -1 ? s.renewalPlans[i].id : uid('r'), memberId, dueDate: null, stage: '未启动', quoteAmount: 0, expectedAmount: 0, blockers: [], updatedAt: today(), ...p };
    if (i > -1) s.renewalPlans[i] = { ...s.renewalPlans[i], ...merged };
    else s.renewalPlans.push(merged);
  });
}

/* ---------------- 社群 ---------------- */

export function upsertGroup(g, id) {
  commit((s) => {
    if (id) {
      const i = s.groups.findIndex((x) => x.id === id);
      if (i > -1) s.groups[i] = { ...s.groups[i], ...g };
    } else s.groups.push({ id: uid('g'), weeklyPlan: [], members: 0, activeRate: 0, health: 'good', ...g });
  });
}

export function setGroupPlanStatus(groupId, index, status) {
  commit((s) => {
    const g = s.groups.find((x) => x.id === groupId);
    if (g && g.weeklyPlan[index]) g.weeklyPlan[index].status = status;
  });
}

export function upsertGroupPlanItem(groupId, item, index) {
  commit((s) => {
    const g = s.groups.find((x) => x.id === groupId);
    if (!g) return;
    g.weeklyPlan = g.weeklyPlan || [];
    if (index != null && g.weeklyPlan[index]) g.weeklyPlan[index] = { ...g.weeklyPlan[index], ...item };
    else g.weeklyPlan.push({ day: '周一', topic: '', owner: s.settings.advisor, status: 'todo', ...item });
  });
}

/* ---------------- 营销 ---------------- */

export function upsertCampaign(c, id) {
  commit((s) => {
    if (id) {
      const i = s.campaigns.findIndex((x) => x.id === id);
      if (i > -1) s.campaigns[i] = { ...s.campaigns[i], ...c };
    } else s.campaigns.unshift({ id: uid('c'), platform: '抖音', format: '短视频', publishedAt: today(), views: 0, likes: 0, comments: 0, dmLeads: 0, formLeads: 0, spend: 0, status: '已发布', ...c });
  });
}

export function upsertLead(l, id) {
  commit((s) => {
    if (id) {
      const i = s.leads.findIndex((x) => x.id === id);
      if (i > -1) s.leads[i] = { ...s.leads[i], ...l };
    } else s.leads.unshift({ id: uid('l'), createdAt: today(), source: '自然到店', intent: 'B', status: 'new', owner: s.settings.advisor, ...l });
  });
}

export function deleteLead(id) {
  commit((s) => { s.leads = s.leads.filter((x) => x.id !== id); });
}

export function deleteCampaign(id) {
  commit((s) => {
    s.campaigns = s.campaigns.filter((x) => x.id !== id);
    /* 内容删了，线索上的关联要跟着断，不能留下指向空内容的引用 */
    s.leads.forEach((l) => { if (l.campaignId === id) l.campaignId = null; });
  });
}

/**
 * 线索转会员：一次写入完成三件事
 *   1. 新建会员档案（台账从此有这个人）
 *   2. 线索标记为已成交，并记住它变成了哪个会员
 *   3. 保留来源，指标里"这个渠道带来多少会员"才算得出来
 * 返回新会员 id，方便调用方直接跳到档案页。
 */
export function convertLead(leadId, patch = {}) {
  let newId = null;
  commit((s) => {
    const l = s.leads.find((x) => x.id === leadId);
    if (!l) return;
    newId = uid('m');
    s.members.unshift({
      id: newId,
      name: l.name,
      phone: l.phone || '',
      gender: '男', age: 28,
      source: normalizeSource(l.source),
      stage: 'trial',
      owner: l.owner || s.settings.advisor,
      createdAt: today(),
      note: l.campaignId ? `来源内容：${(s.campaigns.find((c) => c.id === l.campaignId) || {}).title || l.campaignId}` : '',
      tags: [], intents: [], concerns: [], goals: [],
      hasPT: false, ptTotal: 0, ptLeft: 0, visits30: 0, totalPaid: 0,
      ...patch,
    });
    l.status = 'won';
    l.memberId = newId;
    l.convertedAt = today();
  });
  return newId;
}

/* ---------------- 抖音账号监控 ---------------- */

const stamp = () => nowISO().slice(0, 16).replace('T', ' ');

/**
 * 绑定抖音账号。
 * 存的是抖音号（uniqueId），不是昵称 —— 昵称不唯一，红狐官方脚本直接拒绝。
 * 这里不保存任何密钥：密钥只在本地代理进程的环境变量里。
 */
export function bindDouyinAccount(uniqueName, patch = {}) {
  commit((s) => {
    s.douyin.binding = {
      uniqueName: String(uniqueName || '').trim(),
      nickname: patch.nickname || String(uniqueName || '').trim(),
      note: patch.note || '',
      boundAt: stamp(),
    };
  });
}

/** 解绑：账号信息清掉，但已抓到的快照保留，历史数据不该因为解绑就消失 */
export function unbindDouyinAccount() {
  commit((s) => { s.douyin.binding = null; });
}

export function setDouyinMonitor(patch) {
  commit((s) => { s.douyin.monitor = { ...s.douyin.monitor, ...patch }; });
}

/**
 * 写入一次真实快照。
 * 上一次的派生指标挪进 prevMetrics，用来算环比 —— 存指标而不是存整份原始数据，
 * 因为环比只需要指标，留整份快照会让 localStorage 迅速变大。
 */
export function saveDouyinSnapshot({ account, works, isSample = false, source = 'redfox' }) {
  commit((s) => {
    const at = stamp();
    /* 工作量：这次同步里"新出现"的作品 = 抖音账号下新发布的视频，每条算一次操作量。
       只数 remoteId 上次没见过的，重复同步同一条视频不会重复计数。 */
    const had = new Set(((s.douyin.snapshot?.works) || []).map((w) => w.remoteId).filter(Boolean));
    const fresh = (works || []).filter((w) => w.remoteId && !had.has(w.remoteId)).length;
    if (fresh) addWorkload(s, 'ops', fresh);
    s.douyin.prevMetrics = s.douyin.snapshot?.metrics || null;
    s.douyin.snapshot = {
      at,
      account: account || null,
      works: works || [],
      metrics: deriveMetrics(account, works),
      isSample,
      source,
    };
    s.douyin.log = [{
      id: uid('dy'), at, ok: true, count: (works || []).length,
      message: `同步抖音号 ${account?.remoteId || s.douyin.binding?.uniqueName || ''}，取到 ${(works || []).length} 条作品`,
    }, ...(s.douyin.log || [])].slice(0, 30);
  });
}

/** 同步失败也要留痕，否则界面上看不出"上次试过了但没成功" */
export function logDouyinError(message) {
  commit((s) => {
    s.douyin.log = [{ id: uid('dy'), at: stamp(), ok: false, count: 0, message }, ...(s.douyin.log || [])].slice(0, 30);
  });
}

export function saveBenchmarks(items, { keyword = '', isSample = false } = {}) {
  commit((s) => {
    s.douyin.benchmarks = { at: stamp(), items: items || [], keyword, isSample };
  });
}

/* ---------------- 小红书 ----------------
   红狐没有小红书账号维度接口，所以这里没有"同步"一说：
   账号数字与笔记都是登记进来的。写成 upsert 而不是 save，
   是因为改一条笔记不该把整栏清掉重写。 */

export function bindXhsAccount(uniqueName, patch = {}) {
  commit((s) => {
    s.xhs.binding = {
      uniqueName: String(uniqueName || '').trim(),
      nickname: patch.nickname || String(uniqueName || '').trim(),
      /* 粉丝数与笔记数只能手工登记：接口取不到，登记多少就是多少，
         界面上会一直标明这是登记值 */
      followerCount: patch.followerCount ?? null,
      noteCount: patch.noteCount ?? null,
      note: patch.note || '',
      boundAt: patch.boundAt || stamp(),
      at: today(),
    };
    s.xhs.updatedAt = today();
  });
}

export function unbindXhsAccount() {
  commit((s) => { s.xhs.binding = null; });
}

export function upsertXhsNote(note) {
  commit((s) => {
    const list = s.xhs.notes || [];
    const id = note.id || uid('xn');
    const i = list.findIndex((x) => x.id === id);
    const rec = { ...note, id, at: today() };
    if (i > -1) list[i] = { ...list[i], ...rec };
    else list.push(rec);
    s.xhs.notes = list;
    s.xhs.updatedAt = today();
  });
}

export function deleteXhsNote(id) {
  commit((s) => {
    s.xhs.notes = (s.xhs.notes || []).filter((x) => x.id !== id);
    s.xhs.updatedAt = today();
  });
}

export const xhsBinding = () => state.xhs?.binding || null;
export const xhsNotes = () => state.xhs?.notes || [];
/** 小红书汇总：现算不落库，改一条笔记立刻反映到卡片上 */
export const xhsSummary = () => deriveXhsSummary(state.xhs?.notes || []);

/** 记住用户选的榜期与赛道，下次进来不用重选 */
export function setBoardQuery(patch) {
  commit((s) => { s.douyin.boardQuery = { ...s.douyin.boardQuery, ...patch }; });
}

/**
 * 写入官方赛道榜。
 * 榜位（rank）是接口给的 accountRanking，原样存，不做任何重排 ——
 * 一旦我们自己排过，它就不再是"官方榜位"了。
 */
export function saveTopBoard({ items, dateType, rankDate, category, isSample = false }) {
  commit((s) => {
    s.douyin.board = {
      at: stamp(), dateType, rankDate, category,
      items: items || [], isSample,
    };
    s.douyin.boardQuery = { dateType, category };
    s.douyin.log = [{
      id: uid('dy'), at: s.douyin.board.at, ok: true, count: (items || []).length,
      message: `取到「${category}」${dateType === 'days' ? '日' : dateType === 'weeks' ? '周' : '月'}榜 ${(items || []).length} 条（${rankDate}）`,
    }, ...(s.douyin.log || [])].slice(0, 30);
  });
}

/** 门店热度手工登记。评论内容与绿标白标接口拿不到，手工是唯一可核对的来源。 */
export function upsertStoreHeatManual(item) {
  commit((s) => {
    const list = s.douyin.storeHeat.manual || [];
    const i = list.findIndex((x) => x.kind === item.kind);
    const rec = { id: i > -1 ? list[i].id : uid('sh'), at: today(), ...item };
    if (i > -1) list[i] = { ...list[i], ...rec };
    else list.push(rec);
    s.douyin.storeHeat.manual = list;
    s.douyin.storeHeat.updatedAt = today();
  });
}

export function deleteStoreHeatManual(id) {
  commit((s) => {
    s.douyin.storeHeat.manual = (s.douyin.storeHeat.manual || []).filter((x) => x.id !== id);
  });
}

export const douyinBinding = () => state.douyin?.binding || null;
export const douyinSnapshot = () => state.douyin?.snapshot || null;
export const douyinPrevMetrics = () => state.douyin?.prevMetrics || null;
export const douyinBenchmarks = () => state.douyin?.benchmarks || null;
export const douyinBoard = () => state.douyin?.board || null;
export const douyinBoardQuery = () => state.douyin?.boardQuery || { dateType: 'days', category: '身体锻炼' };
export const douyinLog = () => state.douyin?.log || [];
export const storeHeatManual = () => state.douyin?.storeHeat?.manual || [];

/* ---------------- 可选配功能 ----------------
   状态只存用户的选择（true / false），
   "核心模块恒开"这类规则留在 features.js 里，不写进数据。
   数据里存规则，规则一改老数据就要迁移，不值得。
   ------------------------------------------ */

export function setFeature(id, on) {
  commit((s) => { s.features = { ...(s.features || {}), [id]: Boolean(on) }; });
}

export function resetFeatures() {
  commit((s) => { s.features = defaultFeatures(); });
}

/** 视图用这个判断某模块要不要渲染，避免各处自己读 features 对象 */
export const featureOn = (id) => isFeatureOn(state.features, id);

/** 一次拿到全部开关，卡片式渲染时省得逐个调 */
export const featureFlags = () => ({ ...(state.features || {}) });

/* ---------------- 交易后台（抖音来客 / 美团经营宝） ---------------- */

export const bizSource = (id) => state.biz?.[id] || null;
export const bizRecords = () => state.biz?.records || [];
export const bizRecordsOf = (sourceId) => (state.biz?.records || []).filter((r) => r.source === sourceId);

/** 最近 n 天的记录，按日期倒序 */
export const recentBizRecords = (n = 14) =>
  sortBy(state.biz?.records || [], (r) => r.date, 'desc').slice(0, n);

export function setBizSource(id, patch) {
  commit((s) => { s.biz[id] = { ...s.biz[id], ...patch }; });
}

/** 后台接入的操作留痕。导入、测试、失败都要能回看 */
export function logBizEvent(id, message, { ok = true, type = 'note', records = 0 } = {}) {
  commit((s) => {
    s.biz[id].logs = [
      { id: uid('bl'), at: stamp(), ok, type, records, message },
      ...(s.biz[id].logs || []),
    ].slice(0, 40);
  });
}

/**
 * 写入报表导入的经营记录。
 *
 * 合并而不是覆盖，是因为两件事：
 *   1. 后台的流量看板和交易看板通常要分两次导出，同一天各带一半的列。
 *      覆盖会让第二次把第一次的曝光列抹掉。
 *   2. 重复导同一张表很常见。按 来源 + 日期 去重，同一天不会算两遍。
 *
 * 只合并"这次确实给了值"的列；这次没导的列保留原值，而不是清成空。
 */
export function saveBizRecords(records, { sourceId } = {}) {
  const out = { created: 0, merged: 0, total: (records || []).length };
  commit((s) => {
    const list = s.biz.records || [];
    (records || []).forEach((rec) => {
      const i = list.findIndex((x) => x.source === rec.source && x.date === rec.date);
      if (i === -1) {
        list.push({ id: uid('biz'), at: stamp(), ...rec });
        out.created++;
        return;
      }
      const next = { ...list[i], at: stamp() };
      Object.entries(rec).forEach(([k, v]) => {
        if (k === 'source' || k === 'date' || v == null) return;
        next[k] = v;
      });
      list[i] = next;
      out.merged++;
    });
    list.sort((a, b) => (a.date < b.date ? 1 : -1));
    s.biz.records = list;
    s.biz.lastImportAt = stamp();

    const id = sourceId || (records && records[0] && records[0].source);
    if (id && s.biz[id]) {
      s.biz[id].lastImportAt = stamp();
      s.biz[id].status = s.biz[id].status === 'connected' ? 'connected' : 'pending';
      s.biz[id].logs = [{
        id: uid('bl'), at: stamp(), ok: true, type: 'import', records: out.total,
        message: `报表导入：新增 ${out.created} 天，合并 ${out.merged} 天`,
      }, ...(s.biz[id].logs || [])].slice(0, 40);
    }
  });
  return out;
}

export function deleteBizRecord(id) {
  commit((s) => { s.biz.records = (s.biz.records || []).filter((r) => r.id !== id); });
}

export function clearBizRecords(sourceId) {
  commit((s) => {
    s.biz.records = sourceId
      ? (s.biz.records || []).filter((r) => r.source !== sourceId)
      : [];
  });
}

/* ---------------- 运营未读提醒 ----------------
   只存"哪些消息 id 已读"。消息本身每天重算，不落库。
   跨天自动失效：昨天的已读不该继续压住今天的新提醒。
   ---------------------------------------------- */

export function briefReadIds() {
  return (state.opsBrief?.date === today() ? state.opsBrief.readIds : []) || [];
}

export function markBriefRead(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return;
  commit((s) => {
    const t = today();
    const base = s.opsBrief?.date === t ? (s.opsBrief.readIds || []) : [];
    s.opsBrief = { date: t, readIds: [...new Set([...base, ...list])] };
  });
}

export function resetBriefRead() {
  commit((s) => { s.opsBrief = { date: today(), readIds: [] }; });
}

/* ---------------- 个人设置 ---------------- */

export function saveSettings(patch) {
  commit((s) => { s.settings = { ...s.settings, ...patch }; });
}

/* ---------------- 目标 ---------------- */

export function setGoal(patch) {
  commit((s) => { s.goals[0] = { ...s.goals[0], ...patch }; });
}

/* ---------------- 学习 ---------------- */

export function setTopicProgress(topicId, patch) {
  commit((s) => {
    const cur = s.learning.progress[topicId] || { status: 'todo', hours: 0, evidence: '', metricSnapshot: '' };
    s.learning.progress[topicId] = { ...cur, ...patch, updatedAt: today() };
  });
}

export function cycleTopicStatus(topicId) {
  const cur = state.learning.progress[topicId]?.status || 'todo';
  const next = cur === 'todo' ? 'doing' : cur === 'doing' ? 'done' : 'todo';
  setTopicProgress(topicId, { status: next });
  /* 工作量：把一个成长课时学到「已完成」= 一次操作量。
     只在真正标成 done 时记，标成「进行中」或取消完成都不记。 */
  if (next === 'done') bumpWorkload('ops');
}

export function setRadar(dimId, value) {
  commit((s) => { s.learning.radar[dimId] = value; });
}

export function setReviewDate() {
  commit((s) => { s.learning.lastReviewAt = today(); });
}

/* ---------------- AI 任务包结果 ---------------- */

export function setAiResult(packId, text) {
  commit((s) => {
    s.ai[packId] = { text, savedAt: nowISO() };
  });
}

/* ---------------- 业务系统对接（三体 / 勤鸟 / ...） ---------------- */

export function setConnector(id, patch) {
  commit((s) => { s.connectors[id] = { ...s.connectors[id], ...patch }; });
}

export function setPrimaryConnector(id) {
  commit((s) => { s.connectors.primary = id; });
}

export function setEndpointVerified(id, resource, verified) {
  commit((s) => {
    const c = s.connectors[id];
    c.endpointsVerified = { ...(c.endpointsVerified || {}), [resource]: verified };
  });
}

export function setMappingOverride(id, resource, target, source) {
  commit((s) => {
    const c = s.connectors[id];
    const cur = c.mappingOverrides?.[resource] || {};
    c.mappingOverrides = { ...(c.mappingOverrides || {}), [resource]: { ...cur, [target]: source } };
  });
}

export function addConnectorLog(id, log) {
  commit((s) => {
    const c = s.connectors[id];
    c.logs = [
      { id: uid('lg'), at: nowISO().slice(0, 16).replace('T', ' '), ok: true, records: 0, ...log },
      ...(c.logs || []),
    ].slice(0, 40);
  });
}

export const connectorById = (id) => state.connectors[id];

/* ---------------- 个人账号（操作员）管理 ----------------
   授权（系统接口）与账号登陆是两件事：
   - 授权决定"能不能读"（网关 Key / OAuth）
   - 账号决定"读谁的数据"（哪个操作员、什么范围）
   系统接口已授权后，可随时切换个人账号，不影响授权本身。 */

export function addConnectorAccount(id, account) {
  commit((s) => {
    const c = s.connectors[id];
    const a = { id: uid('acc'), boundAt: nowISO().slice(0, 16).replace('T', ' '), ...account };
    c.accounts = [...(c.accounts || []), a];
    if (!c.activeAccountId) c.activeAccountId = a.id;
  });
  return account;
}

export function setActiveAccount(id, accountId) {
  commit((s) => { s.connectors[id].activeAccountId = accountId; });
}

export function removeConnectorAccount(id, accountId) {
  commit((s) => {
    const c = s.connectors[id];
    c.accounts = (c.accounts || []).filter((x) => x.id !== accountId);
    if (c.activeAccountId === accountId) c.activeAccountId = (c.accounts[0]?.id) || null;
  });
}

export function setConnectorAuthUrl(id, url) {
  commit((s) => { s.connectors[id].authUrl = url || ''; });
}

/* ---------------- 客户维护：运动频率预警 / 周期提醒 / 体测仪预留 ----------------
   这三件事都属于"客户维护"栏目，和对接授权是两套逻辑：
   - 运动频率预警是全局阈值（周频次低于 X 触发），不落库到单个会员；
   - 周期提醒是按会员设置"每隔 N 天提醒一次运动"，状态存在会员身上；
   - 体测仪是预留的对接类型，先占位，适配器后续按三体 / 勤鸟同款模式补。 */

/** 设置运动频率降低预警阈值：周频次低于该值即标记为"频率下降"。
 *  threshold 单位=次/周。0.5 / 1 / 2 / 3 为界面可选档位。 */
export function setFreqDropAlert(threshold) {
  commit((s) => { s.settings.freqDropAlert = Number(threshold) || 0; });
}

/** 给某个会员设置"周期提醒运动"。
 *  cfg = { on, days }。on=true 时按 days 算出下次提醒日期。 */
export function setExerciseReminder(memberId, cfg = {}) {
  commit((s) => {
    const m = s.members.find((x) => x.id === memberId);
    if (!m) return;
    const on = cfg.on ?? false;
    const days = Math.max(1, Number(cfg.days) || 7);
    m.remind = {
      on,
      days,
      next: on ? addDays(today(), days) : null,
      setAt: nowISO().slice(0, 16).replace('T', ' '),
    };
  });
}

/** 接入体测仪（预留接口）。复用对接模型，但 type 固定为 bodyAnalyzer，
 *  真正的数据读取适配器后续按三体 / 勤鸟同款模式补。 */
export function addBodyAnalyzer(cfg = {}) {
  commit((s) => {
    s.connectors.bodyAnalyzer = {
      id: 'bodyAnalyzer',
      type: 'bodyAnalyzer',
      name: cfg.name || '体测仪',
      status: 'pending',
      baseUrl: cfg.baseUrl || '',
      accountRole: '',
      scope: 'all',
      mappingOverrides: {},
      endpointsVerified: {},
      accounts: [],
      activeAccountId: null,
      authUrl: '',
      brands: cfg.brands || ['InBody', 'Tanita', 'seca', 'EGYM', '联合意达'],
      note: '体测仪数据互通预留接口。主流品牌（InBody Web API、Tanita 串口/USB、seca 医疗云、EGYM Fitness Hub、联合意达标准 API）均有可对接通道，适配器后续按三体/勤鸟同款模式补。',
      logs: [],
    };
  });
}

/** 远端同步回来的字段不允许覆盖本地字段 */
const FITFLOW_ONLY = ['id', 'note', 'goals', 'intents', 'concerns', 'tags', 'stage', 'owner', 'followups'];

/**
 * 把对接方读回来的会员合并进档案
 * 规则：远端没给的字段保持原值；FitFlow 记录的目标 / 顾虑 / 备注等永远不被覆盖
 */
export function applySyncedMembers(list, providerId) {
  const idField = providerId === 'santi' ? 'triId' : 'qinniaoId';
  let created = 0, updated = 0, skipped = 0;
  const stamp = nowISO().slice(0, 16).replace('T', ' ');

  commit((s) => {
    (list || []).forEach((rec) => {
      if (!rec || !rec.remoteId || !rec.name) { skipped++; return; }
      const payload = {};
      Object.entries(rec).forEach(([k, v]) => {
        if (k.startsWith('_') || k === 'remoteId') return;
        if (v == null || v === '') return;              // 远端没给就不覆盖
        if (FITFLOW_ONLY.includes(k)) return;
        payload[k] = v;
      });
      payload[idField] = rec.remoteId;
      payload.syncedAt = stamp;

      const i = s.members.findIndex((m) =>
        m[idField] === rec.remoteId || (rec.phone && m.phone && m.phone === rec.phone));

      if (i > -1) {
        s.members[i] = { ...s.members[i], ...payload };
        updated++;
      } else {
        s.members.unshift({
          id: uid('m'), owner: s.settings.advisor, stage: payload.expireDate ? 'active' : 'lead',
          gender: '男', age: null, source: 'walkin', tags: [], intents: [], concerns: [], goals: [],
          hasPT: Boolean(payload.ptTotal), ptTotal: payload.ptTotal || 0, ptLeft: payload.ptLeft || 0,
          visits30: payload.visits30 || 0, totalPaid: payload.totalPaid || 0, createdAt: today(),
          ...payload,
        });
        created++;
      }
    });
  });

  return { created, updated, skipped };
}

/** 档案来源：有哪个系统的 ID 就算哪个系统同步来的，都没有就是自建档案 */
export function originOf(m) {
  if (m?.triId) return { id: 'santi', label: '三体同步', cls: 'tri' };
  if (m?.qinniaoId) return { id: 'qinniao', label: '勤鸟同步', cls: 'qn' };
  return { id: 'manual', label: '自建档案', cls: '' };
}

/* ---------------- 数据管理 ---------------- */

export function resetDemo() {
  state = buildSeed();
  void persist();
  emit();
}

export function exportJSON() {
  return JSON.stringify(state, null, 2);
}

export function importJSON(text) {
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.members)) throw new Error('文件格式不正确：缺少 members 数组');
  state = migrate(parsed);
  void persist();
  emit();
}

export function clearAll() {
  /* 功能开关是使用偏好，不是业务数据。清空数据时保留，
     否则用户每次清一次就要重新去功能库里配一遍。 */
  const keepFeatures = { ...(state?.features || defaultFeatures()) };
  state = {
    ...buildSeed(), isDemo: false,
    members: [], cards: [], followups: [], appointments: [], renewalPlans: [],
    groups: [], campaigns: [], leads: [], ai: {},
    /* 清空示例数据时，抖音那块要一起清干净：
       留一份示例快照会让用户以为真连上了账号 */
    douyin: defaultDouyinState(),
    xhs: defaultXhsState(),
    biz: defaultBizState(),
    features: keepFeatures,
    opsBrief: { date: today(), readIds: [] },
    automations: { ...buildSeed().automations, log: [] },
  };
  void persist();
  emit();
}

/* ---------------- 会籍卡 ---------------- */

export function saveCard(data, id) {
  commit((s) => {
    if (id) {
      const i = s.cards.findIndex((c) => c.id === id);
      if (i > -1) s.cards[i] = { ...s.cards[i], ...data };
    } else {
      s.cards.unshift({
        id: uid('card'), cardNo: 'FF-' + Math.random().toString(36).slice(2, 7).toUpperCase(),
        name: '', typeId: 'term', totalCount: null, remainCount: null, startDate: today(),
        endDate: null, listPrice: 0, paidPrice: 0, periodValue: null, status: 'active',
        source: 'manual', remoteId: null, freezeLog: [], note: '', ...data,
      });
    }
  });
}

export function deleteCard(id) {
  commit((s) => { s.cards = s.cards.filter((c) => c.id !== id); });
}

export function setCardStatus(id, status, patch = {}) {
  commit((s) => {
    const c = s.cards.find((x) => x.id === id);
    if (!c) return;
    c.status = status;
    Object.assign(c, patch);
  });
}

/** 冻结：记录起止，解冻时按冻结天数顺延到期日 */
export function freezeCard(id, { from, to, reason }) {
  commit((s) => {
    const c = s.cards.find((x) => x.id === id);
    if (!c) return;
    c.status = 'frozen';
    c.freezeLog = [...(c.freezeLog || []), { from, to: to || null, reason, days: null }];
  });
}

export function unfreezeCard(id, extraDays) {
  commit((s) => {
    const c = s.cards.find((x) => x.id === id);
    if (!c) return;
    const last = (c.freezeLog || [])[c.freezeLog.length - 1];
    if (last && !last.to) { last.to = today(); last.days = extraDays; }
    c.status = 'active';
    if (extraDays && c.endDate) c.endDate = addDays(c.endDate, extraDays);
  });
}

/** 续卡：原卡置为已到期，生成一张新卡，并用 renewFrom 串起来 */
export function renewCard(id, patch = {}) {
  const src = state.cards.find((c) => c.id === id);
  if (!src) return null;
  const start = src.endDate || today();
  const newEnd = patch.endDate || addDays(start, patch.durationDays || 365);
  const card = {
    id: uid('card'),
    memberId: src.memberId,
    cardNo: 'FF-' + Math.random().toString(36).slice(2, 7).toUpperCase(),
    name: patch.name || src.name,
    typeId: patch.typeId || src.typeId,
    totalCount: patch.totalCount ?? null,
    remainCount: patch.remainCount ?? patch.totalCount ?? null,
    startDate: patch.startDate || today(),
    endDate: newEnd,
    listPrice: patch.listPrice || 0,
    paidPrice: patch.paidPrice || 0,
    periodValue: patch.periodValue ?? src.periodValue ?? null,
    status: 'active',
    source: src.source,
    remoteId: null,
    freezeLog: [],
    renewFrom: src.id,
    note: patch.note || '',
  };
  commit((s) => {
    s.cards = s.cards.map((c) => (c.id === id ? { ...c, status: 'expired' } : c));
    s.cards.unshift(card);
  });
  return card;
}

/** 消课 / 消次：用于手动登记课时消耗 */
export function consumeCard(id, n = 1) {
  commit((s) => {
    const c = s.cards.find((x) => x.id === id);
    if (!c || c.remainCount == null) return;
    c.remainCount = Math.max(0, c.remainCount - n);
  });
}

export function cardsOfMember(id) {
  return sortBy(state.cards.filter((c) => c.memberId === id), (c) => c.endDate || '9999', 'asc');
}

/* 客户卡报错：用户发现同步回来的卡信息不对，主动提交一张工单。
   只追加不覆盖 —— 报错是给人核对用的，系统数据仍然以来源系统为准 */
export function reportCardError(payload) {
  const rec = {
    id: uid('ce'),
    at: nowISO().slice(0, 16).replace('T', ' '),
    status: 'pending',
    ...payload,
  };
  commit((s) => { s.cardErrors.push(rec); });
  return rec;
}

export function cardBuckets() {
  const arr = state.cards;
  return {
    urgent: arr.filter((c) => { const u = cardUrgency(c).level; return u <= 2; }),
    expired: arr.filter((c) => cardStatus(c).key === 'expired'),
    frozen: arr.filter((c) => c.status === 'frozen'),
    pending: arr.filter((c) => c.status === 'pending'),
    active: arr.filter((c) => cardStatus(c).key === 'active'),
  };
}

/* ---------------- 智能体 / 自动化 ---------------- */

export function setRuleConfig(ruleId, patch) {
  commit((s) => {
    const cur = s.automations.rules[ruleId] || {};
    s.automations.rules[ruleId] = { ...cur, ...patch };
  });
}

export function setRuleParam(ruleId, key, value) {
  commit((s) => {
    const cur = s.automations.rules[ruleId] || {};
    s.automations.rules[ruleId] = { ...cur, params: { ...(cur.params || {}), [key]: value } };
  });
}

export function resetRule(ruleId) {
  commit((s) => { delete s.automations.rules[ruleId]; });
}

/** 智能体运行一次并写入日志 */
export function logAgentRun(entries) {
  commit((s) => {
    s.automations.lastRunAt = nowISO().slice(0, 16).replace('T', ' ');
    s.automations.runCount = (s.automations.runCount || 0) + 1;
    s.automations.log = [...entries, ...(s.automations.log || [])].slice(0, 60);
  });
}

export function markAgentLog(id, status) {
  commit((s) => {
    const e = s.automations.log.find((x) => x.id === id);
    if (e) e.status = status;
  });
}

/** 今日已处理：把某会员标记为「今天在智能体首页处理过」。
 *  用于「待处理队列 → 今日已处理」的归档。这是确定性的本地标记，
 *  不依赖任何 AI 判断，新的一天自动清空（date 不符即重建）。 */
export function markMemberHandled(memberId) {
  if (!memberId) return;
  commit((s) => {
    const a = s.automations || (s.automations = {});
    const t = today();
    const td = a.todayDone && a.todayDone.date === t ? a.todayDone : { date: t, ids: [] };
    if (!td.ids.includes(memberId)) td.ids.push(memberId);
    a.todayDone = td;
  });
}

/** 撤销「今日已处理」标记（误操作后可恢复进待处理队列）。 */
export function unmarkMemberHandled(memberId) {
  if (!memberId) return;
  commit((s) => {
    const td = s.automations?.todayDone;
    if (td) td.ids = td.ids.filter((x) => x !== memberId);
  });
}

/** 返回今天已归档处理的会员 id 数组（新的一天自动视为空）。 */
export const todayDoneIds = (state) => {
  const td = state.automations?.todayDone;
  return td && td.date === today() ? td.ids : [];
};

/* ---------------- 个人时间管理 ---------------- */

/** 时间块提醒默认配置。
 *  method: none 不提醒 / inapp 仅应用内 / system 走系统通知
 *  lead:   提前多少分钟提醒
 *  sound/vibrate: 系统通知时的提示方式（应用内提醒也复用这两个开关） */
export function defaultRemind() {
  return { method: 'inapp', lead: 10, sound: true, vibrate: true };
}

export function toggleBlock(id) {
  commit((s) => {
    const b = s.dayPlan.blocks.find((x) => x.id === id);
    if (b) b.done = !b.done;
  });
}

export function updateBlock(id, patch) {
  commit((s) => {
    const b = s.dayPlan.blocks.find((x) => x.id === id);
    if (b) Object.assign(b, patch);
  });
}

export function addBlock(block) {
  commit((s) => {
    s.dayPlan.blocks.push({ id: uid('tb'), start: '09:00', end: '10:00', kind: 'admin', title: '', done: false, remind: defaultRemind(), ...block });
    s.dayPlan.blocks = sortBy(s.dayPlan.blocks, (b) => b.start, 'asc');
  });
}

export function removeBlock(id) {
  commit((s) => { s.dayPlan.blocks = s.dayPlan.blocks.filter((b) => b.id !== id); });
}

export function resetDayPlan() {
  commit((s) => {
    s.dayPlan = {
      date: today(),
      blocks: DAY_TEMPLATE.map((b) => ({ id: uid('tb'), ...b, done: false, linkedMemberId: null, note: '', remind: defaultRemind() })),
    };
  });
}

/* ============================================================
   Selectors · 只在内存里算，不落库
   ============================================================ */

export const memberById = (id) => state.members.find((m) => m.id === id);

export const followupsOf = (id) =>
  sortBy(state.followups.filter((f) => f.memberId === id), (f) => f.date, 'desc');

export const appointmentsOf = (id) =>
  sortBy(state.appointments.filter((a) => a.memberId === id), (a) => a.date + a.time, 'desc');

export const latestFollowup = (id) => followupsOf(id)[0] || null;

/* ---------------- AI 转写跟进（会面转写文档 + 提炼纪要） ---------------- */

export const aiMaterialsOf = (memberId) =>
  sortBy(state.aiMaterials.filter((x) => x.memberId === memberId), (x) => x.createdAt, 'desc');

export const aiMaterialById = (id) => state.aiMaterials.find((x) => x.id === id) || null;

/** 存一份上传资料。原文与提炼结果都写进 state，随加密落盘走。 */
export function addAiMaterial(rec) {
  let created = null;
  commit((s) => {
    created = {
      id: uid('aim'),
      memberId: rec.memberId,
      createdAt: nowISO(),
      fileName: rec.fileName || '',
      fileSize: rec.fileSize || 0,
      kind: rec.kind || 'text',        // text | docx
      rawText: rec.rawText || '',
      note: rec.note || null,          // 提炼后的会面纪要，未提炼时为 null
      followupId: rec.followupId || null,
    };
    s.aiMaterials.unshift(created);
  });
  return created;
}

export function updateAiMaterial(id, patch) {
  commit((s) => {
    const i = s.aiMaterials.findIndex((x) => x.id === id);
    if (i > -1) s.aiMaterials[i] = { ...s.aiMaterials[i], ...patch };
  });
}

export function deleteAiMaterial(id) {
  commit((s) => { s.aiMaterials = s.aiMaterials.filter((x) => x.id !== id); });
}

export const renewalOf = (id) => state.renewalPlans.find((r) => r.memberId === id) || null;

/** 到期状态 */
export function expiry(m) {
  if (!m.expireDate) return { key: 'none', label: '未办卡', days: null };
  const days = daysBetween(today(), m.expireDate);
  if (days < 0) return { key: 'expired', label: `已过期 ${-days} 天`, days };
  if (days <= 7) return { key: 'urgent', label: `${days} 天后到期`, days };
  if (days <= 30) return { key: 'upcoming', label: `${days} 天后到期`, days };
  return { key: 'normal', label: `${days} 天后到期`, days };
}

/** 活跃状态 */
export function activity(m) {
  if (!m.lastVisit) return { key: 'none', label: '无到店记录', days: null };
  const days = -daysBetween(today(), m.lastVisit); // 距离今天多少天
  if (days <= 0) return { key: 'hot', label: '今天到店', days: 0 };
  if (days <= 7) return { key: 'hot', label: `${days} 天前到店`, days };
  if (days <= 14) return { key: 'ok', label: `${days} 天前到店`, days };
  if (days <= 30) return { key: 'cold', label: `${days} 天未到店`, days };
  return { key: 'silent', label: `${days} 天未到店`, days };
}

export const isSilent = (m) => {
  const a = activity(m);
  return ['cold', 'silent'].includes(a.key);
};

/* ---------------- 打卡明细 / 周期性统计 ----------------
   打卡明细（m.checkins）来自三体 / 勤鸟的「到店记录」接口，按日聚合。
   本地 seed 在没有真实接口时，由 genCheckins 按到店次数确定性地铺一份明细，
   保证 lastVisit 与明细里最新一条对得上（详见 seed.js）。

   原则：拿不到逐日明细的会员，m.checkins 就是空数组，visitStats 返回
   { has:false }，由界面如实展示「尚未同步」，绝不拿 visits30 反推每天补点。 */

export const checkinsOf = (id) =>
  (memberById(id)?.checkins || []).slice();

/** 最近 n 个自然月，从旧到新，返回 'YYYY-MM' 数组 */
function lastNMonths(n) {
  const base = parseDate(today());
  if (!base) return [];
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(base.getFullYear(), base.getMonth() - i, 1);
    out.push(`${x.getFullYear()}-${pad(x.getMonth() + 1)}`);
  }
  return out;
}

/** 连续打卡天数：今天或昨天打卡都算「 streak 没断」；从起点往前数连续的天数 */
function currentStreak(set, t) {
  let cur = set.has(t) ? t : addDays(t, -1);
  if (!set.has(cur)) return 0;
  let n = 0;
  while (set.has(cur)) { n++; cur = addDays(cur, -1); }
  return n;
}

/**
 * 周期性打卡统计。全部基于真实 m.checkins 明细算，不依赖聚合字段。
 * 返回 { has:true, total, thisWeek, thisMonth, streak, weekAvg, monthAgg } 或 { has:false }
 *   - thisWeek / thisMonth：当前周（周一~周日）/ 当前自然月的打卡次数
 *   - streak：连续打卡天数（今天没去但昨天去了也算没断）
 *   - weekAvg：近 6 个月平均每周打卡次数
 *   - monthAgg：近 6 个月按月聚合，画迷你柱状用
 */
export function visitStats(m) {
  const list = checkinsOf(m.id);
  if (!list.length) return { has: false };
  const t = today();
  const dates = list.map((c) => (c.checkinAt || '').slice(0, 10)).filter(Boolean).sort();
  const set = new Set(dates);
  const month = t.slice(0, 7);
  const weekStart = mondayOf(t);

  const thisMonth = dates.filter((d) => d.slice(0, 7) === month).length;
  const thisWeek = weekStart ? dates.filter((d) => d >= weekStart && d <= t).length : 0;
  const streak = currentStreak(set, t);

  const monthAgg = lastNMonths(6).map((ym) => ({
    ym,
    count: dates.filter((d) => d.slice(0, 7) === ym).length,
  }));
  /* 周均只在"有明细覆盖的窗口"里算：明细从哪天开始，就从哪天起算。
     拿固定 6 个月当分母，明细只覆盖 30 天时会把频率压低好几倍，
     看起来像"练得很少"，这是假的。没明细覆盖的月份就照实显示 0。 */
  const spanDays = Math.max(1, daysBetween(dates[0], t) + 1);
  const weekAvg = dates.length / (spanDays / 7);

  return {
    has: true,
    total: dates.length,
    thisWeek,
    thisMonth,
    streak,
    weekAvg,
    monthAgg,
  };
}

/**
 * 今日工作队列：把所有"必须今天处理"的事拼成一条队列
 * 每一项都可直接点进去执行
 */
export function todayQueue() {
  const t = today();
  const items = [];

  // 1. 今日预约
  state.appointments
    .filter((a) => a.date === t && a.status !== 'canceled')
    .forEach((a) => {
      const m = memberById(a.memberId);
      if (!m) return;
      items.push({
        id: 'appt-' + a.id, kind: 'appointment', member: m, appt: a,
        priority: a.status === 'pending' ? 1 : 2,
        title: `${a.time} ${a.type} · ${m.name}`,
        reason: a.status === 'pending' ? '预约还未确认，先打电话确认到店' : (a.note || '按计划执行'),
        action: '查看预约',
      });
    });

  // 2. 逾期未跟进（有约定下一次跟进时间且已到期/过期）
  liveMembers(state).forEach((m) => {
    const last = latestFollowup(m.id);
    if (!last || !last.nextDate) return;
    const overdue = daysBetween(last.nextDate, t);
    if (overdue >= 0) {
      const when = overdue === 0 ? '今天到期' : `已逾期 ${overdue} 天`;
      items.push({
        id: 'follow-' + m.id, kind: 'follow', member: m, followup: last,
        priority: overdue > 3 ? 1 : 2,
        title: `跟进 ${m.name}`,
        reason: `${last.nextAction || '按上次约定跟进'}（约定 ${last.nextDate}，${when}）`,
        action: '跟进',
      });
    }
  });

  // 3. 临期续费
  liveMembers(state).forEach((m) => {
    const e = expiry(m);
    if (!['urgent', 'upcoming'].includes(e.key)) return;
    const plan = renewalOf(m.id);
    if (plan && plan.stage === '已完成') return;
    items.push({
      id: 'renew-' + m.id, kind: 'renewal', member: m, plan,
      priority: e.key === 'urgent' ? 1 : 3,
      title: `续费推进 · ${m.name}`,
      reason: `${e.label}｜当前阶段：${plan?.stage || '未启动'}${plan?.blockers?.length ? '｜卡点：' + plan.blockers.join('、') : ''}`,
      action: '推进续费',
    });
  });

  // 4. 沉默会员唤醒
  liveMembers(state).forEach((m) => {
    const a = activity(m);
    if (!['cold', 'silent'].includes(a.key)) return;
    items.push({
      id: 'wake-' + m.id, kind: 'wake', member: m,
      priority: a.key === 'silent' ? 2 : 3,
      title: `唤醒 ${m.name}`,
      reason: `${a.label}，${m.concerns?.[0] || '需要重新建立联系'}`,
      action: '记录唤醒',
    });
  });

  // 5. 新线索首响
  state.leads.forEach((l) => {
    if (!['new', 'contacted'].includes(l.status)) return;
    items.push({
      id: 'lead-' + l.id, kind: 'lead', lead: l,
      priority: l.intent === 'A' ? 1 : 2,
      title: `线索跟进 · ${l.name}`,
      reason: `${l.source} 来源，${l.intent} 级意向，状态：${l.status === 'new' ? '尚未触达' : '已触达待推进'}`,
      action: '处理线索',
    });
  });

  // 6. 私教课时将尽
  liveMembers(state).forEach((m) => {
    if (!m.hasPT || m.ptLeft == null || m.ptLeft > 3) return;
    items.push({
      id: 'pt-' + m.id, kind: 'pt', member: m,
      priority: m.ptLeft <= 1 ? 1 : 2,
      title: `私教课时将尽 · ${m.name}`,
      reason: `剩余 ${m.ptLeft} 节，课时归零后再谈续课会损失窗口期`,
      action: '谈续课包',
    });
  });

  const seen = new Set();
  return sortBy(items, (i) => i.priority)
    .filter((i) => (seen.has(i.id) ? false : seen.add(i.id)));
}

/**
 * 未到店流失预警分档。
 *
 * 判定口径：最近一次打卡时间（lastVisit），这个字段的来源就是
 * 三体 / 勤鸟的 lastCheckinTime / checkinTime（见两家适配器的映射），
 * 按今天往前倒推天数。不是本地估算。
 *
 * 两档互斥：一个人只出现在他当前最严重的那档。
 *   7 天档  = 第一次预警，习惯刚断，还拉得回来
 *   21 天档 = 二次预警，已经进入流失，微信基本无效
 * 做成两档都包含 21 天以上的人，同一条线索会同时挂在两个名单里，
 * 两个人看到同一条、都以为对方在处理，最后谁都没动。
 *
 * 没有打卡记录的一律不进任何一档。
 * 「没记录」和「确实很久没来」是两件完全相反的事：
 * 后者要马上打电话，前者要先把三体或勤鸟接通。混在一起名单就是错的。
 * 这类人单独进 noData，界面上必须如实标出来，不能默默丢掉。
 *
 * 打卡时间落在未来（时钟不同步或同步异常）也不猜，直接跳过。
 */
export function churnBuckets() {
  const t = today();
  const w7 = [], w21 = [], noData = [];
  liveMembers(state).forEach((m) => {
    if (!m.lastVisit) { noData.push(m); return; }
    const days = -daysBetween(t, m.lastVisit);
    if (days < 0) return;
    if (days >= 21) w21.push({ m, days });
    else if (days >= 7) w7.push({ m, days });
  });
  /* 久的排前面：越久越难拉回，先打最难的 */
  const by = (x) => x.slice().sort((a, b) => b.days - a.days);
  return { w7: by(w7), w21: by(w21), noData };
}

export function renewalBuckets() {
  const buckets = { urgent: [], upcoming: [], expired: [], normal: [] };
  liveMembers(state).forEach((m) => {
    if (!m.expireDate) return;
    const e = expiry(m);
    (buckets[e.key] || buckets.normal).push(m);
  });
  return {
    urgent: sortBy(buckets.urgent, (m) => daysBetween(today(), m.expireDate), 'asc'),
    upcoming: sortBy(buckets.upcoming, (m) => daysBetween(today(), m.expireDate), 'asc'),
    expired: sortBy(buckets.expired, (m) => daysBetween(today(), m.expireDate), 'desc'),
  };
}

export function appointmentsOn(dateStr) {
  return sortBy(state.appointments.filter((a) => a.date === dateStr), (a) => a.time, 'asc');
}

export function upcomingAppointments(daysAhead = 30) {
  const t = today();
  return sortBy(
    state.appointments.filter((a) => {
      const n = daysBetween(t, a.date);
      return n != null && n >= 0 && n <= daysAhead;
    }),
    (a) => a.date + a.time, 'asc'
  );
}

export function leadFunnel() {
  const h = state.history[state.history.length - 1] || { leads: 0, trials: 0, deals: 0 };
  const impressions = sum(state.campaigns, (c) => c.views);
  const leads = state.leads.length;
  const reached = state.leads.filter((l) => l.firstResponseMin != null).length;
  const booked = state.leads.filter((l) => ['booked', 'trial'].includes(l.status)).length;
  const trials = h.trials;
  const deals = h.deals;
  const activeMembers = liveMembers(state).filter((m) => (m.visits30 || 0) > 0).length;
  return [
    { key: 'impression', label: '内容曝光', value: impressions },
    { key: 'lead', label: '线索（本月）', value: h.leads },
    { key: 'reached', label: '已触达', value: reached, noConv: true },
    { key: 'booked', label: '已预约', value: booked },
    { key: 'trial', label: '体验课', value: trials, noConv: true },
    { key: 'deal', label: '成交', value: deals },
    { key: 'active', label: '在练会员', value: activeMembers, noConv: true },
  ];
}

export function sourceBreakdown() {
  const all = [
    ...state.members.map((m) => ({ source: m.source, paid: m.totalPaid || 0, isMember: true })),
    ...state.leads.map((l) => ({ source: l.source, paid: 0, isMember: false })),
  ];
  const g = groupBy(all, (x) => normalizeSource(x.source));
  return Object.entries(g).map(([source, arr]) => ({
    source,
    total: arr.length,
    members: arr.filter((x) => x.isMember).length,
    paid: sum(arr, (x) => x.paid),
    leads: arr.filter((x) => !x.isMember).length,
  })).sort((a, b) => b.total - a.total);
}

export function normalizeSource(s) {
  const map = { tri: '三体同步', douyin: '抖音', xiaohongshu: '小红书', referral: '转介绍', walkin: '自然到店', wechat: '朋友圈' };
  return map[s] || s || '其他';
}

export function groupStats() {
  const gs = state.groups;
  return {
    count: gs.length,
    members: sum(gs, (g) => g.members),
    avgActive: gs.length ? sum(gs, (g) => g.activeRate) / gs.length : 0,
    risk: gs.filter((g) => g.health === 'risk').length,
  };
}

export function campaignStats() {
  const cs = state.campaigns;
  return {
    count: cs.length,
    views: sum(cs, (c) => c.views),
    dmLeads: sum(cs, (c) => c.dmLeads),
    formLeads: sum(cs, (c) => c.formLeads),
    spend: sum(cs, (c) => c.spend),
    leads: sum(cs, (c) => c.dmLeads + c.formLeads),
    topCampaign: sortBy(cs, (c) => c.views, 'desc')[0] || null,
  };
}

export function learningSummary() {
  const p = state.learning.progress || {};
  const vals = Object.values(p);
  return {
    done: vals.filter((v) => v.status === 'done').length,
    doing: vals.filter((v) => v.status === 'doing').length,
    hours: sum(vals, (v) => v.hours),
  };
}

export function searchMembers(q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return state.members;
  return state.members.filter((m) =>
    [m.name, m.phone, m.cardType, m.triId, ...(m.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(s)
  );
}

export { ratio, sum };

/* 读取当前内存中的整份状态（供 Node 端提取器 / 测试复用，浏览器端一般用 commit 后的闭包） */
export function getState() { return state; }
