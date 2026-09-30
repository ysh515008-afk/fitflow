/* ============================================================
   tags.js · 客户标签自动分配引擎
   ------------------------------------------------------------
   标签不靠人手打，由自动运行程序按规则表打。
   数据来源：三体云动 / 勤鸟的同步字段。

   每个标签必须回答三个问题，界面上也一直给出答案：
     1. 这个标签是系统同步来的，还是本地算出来的？
     2. 算它用的是哪几个字段？
     3. 最后同步是什么时候？同步没跑，标签就是旧的。

   为什么要这么较真：
     会籍看到"卡 3 天到期"会立刻打电话。如果这个数字来自三天前的
     同步、而会员昨天已经续了，这通电话就是错的，而且会当场被戳穿。
     标出来源和时间，他才知道要不要先刷新一次。这是
     「拿不到就 null 不补 0」在标签上的延续。

   自动分配的边界：
     卡课续费状态全部由 MEMBERSHIP_FIELDS 里的 status / endDate /
     remainCount / renewOfRemoteId 驱动，不依赖任何手工维护。
     三体 / 勤鸟接通前，这些字段靠导入表格填；接通后同一个函数
     不用改一行代码就能吃到接口数据。
   ============================================================ */
import { cardsOfMember, originOf } from './store.js';
import { CARD_TYPES } from './data/membership.js';
import { motionOf } from './outreach.js';
import { esc, today, daysBetween, fmtDate } from './util.js';

/* ---------------- 来源 ---------------- */

export const TAG_SOURCE = {
  santi: { label: '三体同步', cls: 'tri', note: '三体云动同步回来的值' },
  qinniao: { label: '勤鸟同步', cls: 'qn', note: '勤鸟同步回来的值' },
  derived: { label: '本地推算', cls: '', note: '由同步数据算出来的，同步没跑就会过期' },
  manual: { label: '手工', cls: '', note: '会籍自己打的标签' },
};

/* ---------------- 续费阶段：完全由字段驱动，不靠人维护 ---------------- */

export const RENEW_STAGES = [
  { id: 'none', label: '无会籍', cls: 'b-plain', note: '还没有会籍，谈不上续费' },
  { id: 'fresh', label: '新办 30 天内', cls: 'b-info', note: '刚办，重点是开卡和第一次到店，不要谈续费' },
  { id: 'renewed', label: '本期已续', cls: 'b-green', note: '这张卡是上一张续来的，或上次续费在本期内' },
  { id: 'mid', label: '会籍中段', cls: 'b-plain', note: '离到期还早，保持陪伴即可' },
  { id: 'window30', label: '续费窗口已开', cls: 'b-info', note: '到期前 30 天，该建续费计划了' },
  { id: 'lock7', label: '7 天锁定期', cls: 'b-warn', note: '方案要已就绪、可当场签，微信基本无效' },
  { id: 'lapsed', label: '已过期待回流', cls: 'b-danger', note: '按回流处理，催单话术会适得其反' },
];

export const RENEW_BY_ID = RENEW_STAGES.reduce((a, s) => ({ ...a, [s.id]: s }), {});

/**
 * 续费阶段自动判定。
 * 判定顺序有讲究：先看"是不是已经续过"，再看"离到期多远"。
 * 一个刚续过卡的人，即使离新到期日只有 20 天，也不该再被推一次续费。
 */
export function renewStage(m) {
  if (!m?.expireDate) return RENEW_BY_ID.none;

  const left = daysBetween(today(), m.expireDate);
  const cards = cardsOfMember(m.id);

  /* renewOfRemoteId 有值 = 这张卡是上一张续来的，这是最硬的续费证据。
     它比"按到期日猜"可靠，因为到期日是会被各种延期操作改动的。 */
  const renewedByCard = cards.some((c) => c.renewOfRemoteId);

  /* 上次续费日期落在本张卡有效期内，也算本期已续 */
  const renewedByDate = m.lastRenewDate
    && (!m.joinDate || m.lastRenewDate >= m.joinDate)
    && daysBetween(m.lastRenewDate, today()) >= 0;

  if (left < 0) return RENEW_BY_ID.lapsed;
  if (renewedByCard || renewedByDate) return RENEW_BY_ID.renewed;
  if (left <= 7) return RENEW_BY_ID.lock7;
  if (left <= 30) return RENEW_BY_ID.window30;
  if (m.joinDate && daysBetween(m.joinDate, today()) <= 30) return RENEW_BY_ID.fresh;
  return RENEW_BY_ID.mid;
}

/* ---------------- 标签规则表 ---------------- */

/**
 * 每条规则返回 null 表示"这条不适用"，不产生标签。
 * fx 是预先算好的字段快照，规则只做判断、不重复计算。
 */
export const TAG_RULES = [
  {
    id: 'card_pending',
    source: 'sync',
    fields: ['memberships.status'],
    level: 1,
    pick(m, fx) {
      const p = fx.cards.find((c) => c.status === 'pending');
      if (!p) return null;
      return { label: `${p.name} 未开卡`, cls: 'b-danger', note: '已售未激活，沉默超过一周就是退款高危' };
    },
  },
  {
    id: 'card_frozen',
    source: 'sync',
    fields: ['memberships.status'],
    level: 2,
    pick(m, fx) {
      const f = fx.cards.find((c) => c.status === 'frozen');
      if (!f) return null;
      return { label: `${f.name} 已冻结`, cls: 'b-warn', note: '冻结期间不计时，但复课概率随时间下降' };
    },
  },
  {
    id: 'count_low',
    source: 'sync',
    fields: ['memberships.remainCount'],
    level: 1,
    pick(m, fx) {
      const c = fx.countCards[0];
      if (!c || c.remainCount == null || c.remainCount > 3) return null;
      const unit = CARD_TYPES[c.typeId]?.unit || '次';
      if (c.remainCount <= 0) return { label: `${c.name} 已用完`, cls: 'b-danger', note: '归零后再谈，客户已经从「在练」变成「停练」' };
      return { label: `${c.name} 剩 ${c.remainCount}${unit}`, cls: 'b-danger', note: '趁没归零谈续课包' };
    },
  },
  {
    id: 'membership_expiry',
    source: 'sync',
    fields: ['expireDate'],
    level: 1,
    pick(m, fx) {
      if (fx.left == null) return null;
      if (fx.left < 0) return { label: `会籍已过期 ${-fx.left} 天`, cls: 'b-danger', note: '按回流处理，催单话术会适得其反' };
      if (fx.left <= 7) return { label: `会籍 ${fx.left} 天后到期`, cls: 'b-danger', note: '方案要已就绪、可当场签' };
      if (fx.left <= 30) return { label: `会籍 ${fx.left} 天后到期`, cls: 'b-warn', note: '进入续费推进窗口' };
      return null;
    },
  },
  {
    id: 'renew_stage',
    source: 'derived',
    fields: ['expireDate', 'joinDate', 'lastRenewDate', 'memberships.renewOfRemoteId'],
    level: 2,
    pick(m, fx) {
      if (fx.stage.id === 'none' || fx.stage.id === 'mid') return null;
      return { label: `续费 · ${fx.stage.label}`, cls: fx.stage.cls, note: fx.stage.note };
    },
  },
  {
    id: 'motion',
    source: 'derived',
    fields: ['visits30', 'lastVisit'],
    level: 3,
    pick(m, fx) {
      if (!fx.motion.known) return null;
      return { label: `运动综合 · ${fx.motion.tier.label}`, cls: fx.motion.tier.cls, note: fx.motion.why };
    },
  },
  {
    id: 'silent',
    source: 'derived',
    fields: ['lastVisit'],
    level: 1,
    pick(m, fx) {
      const d = fx.motion.silentDays;
      if (d == null || d < 14) return null;
      if (d >= 30) return { label: `${d} 天未到店`, cls: 'b-danger', note: '微信触达率已经很低，换电话' };
      return { label: `${d} 天未到店`, cls: 'b-warn', note: '正处在习惯断裂点' };
    },
  },
  {
    id: 'high_value',
    source: 'sync',
    fields: ['totalPaid'],
    level: 3,
    pick(m, fx) {
      if (!m.totalPaid || m.totalPaid < 15000) return null;
      return { label: '高价值', cls: 'b-plain', note: `累计消费 ${m.totalPaid}` };
    },
  },
  {
    id: 'renewed_before',
    source: 'sync',
    fields: ['memberships.renewOfRemoteId', 'lastRenewDate'],
    level: 3,
    pick(m, fx) {
      const c = fx.cards.find((x) => x.renewOfRemoteId);
      if (c) return { label: '续费过的老会员', cls: 'b-green', note: `「${c.name}」是上一张卡续来的` };
      if (m.lastRenewDate) return { label: `上次续费 ${fmtDate(m.lastRenewDate, 'ymd')}`, cls: 'b-green', note: '有过续费记录，续费阻力比新客小' };
      return null;
    },
  },
];

/* ---------------- 主函数 ---------------- */

/**
 * 算一位会员的全部自动标签。
 * @returns {{tags:Array, source:string, synced:boolean, syncedAt:string|null, fields:Array}}
 *   tags   每项 { id, label, cls, note, source, level }
 *   source 档案来源：santi / qinniao / manual
 *   synced 是否来自同步。false 时所有标签都要标成"本地推算"，
 *          因为数据根本不是系统给的。
 */
export function tagMember(m, ctx) {
  const prov = originOf(m);
  const synced = prov.id !== 'manual';
  const cards = cardsOfMember(m.id);
  const motion = motionOf(m);
  const stage = renewStage(m);
  const left = m.expireDate ? daysBetween(today(), m.expireDate) : null;

  const fx = {
    cards,
    motion,
    stage,
    left,
    countCards: cards
      .filter((c) => ['pt', 'group', 'count'].includes(c.typeId) && c.remainCount != null)
      .sort((a, b) => a.remainCount - b.remainCount),
  };

  const tags = [];
  TAG_RULES.forEach((r) => {
    const got = r.pick(m, fx);
    if (!got) return;
    /* 档案不是同步来的，就没有任何"系统标签"可言，一律降级成本地推算 */
    const src = synced && r.source === 'sync' ? prov.id : 'derived';
    tags.push({ ...got, id: r.id, source: src, level: r.level, fields: r.fields });
  });

  /* 系统透传标签：三体 / 勤鸟自己打的等级与分组 */
  (m.sysTags || []).forEach((t, i) => {
    tags.push({
      id: 'sys_' + i, label: String(t), cls: 'b-info',
      note: `${prov.label}里已有的标签`, source: synced ? prov.id : 'derived',
      level: 4, fields: ['sysTags'],
    });
  });

  tags.sort((a, b) => (a.level - b.level) || a.label.localeCompare(b.label));

  return {
    tags,
    source: prov.id,
    sourceLabel: prov.label,
    synced,
    syncedAt: m.syncedAt || null,
    fields: [...new Set(tags.flatMap((t) => t.fields || []))],
    stage: stage.id,
    motion: motion.tier.id,
  };
}

/** 两组标签是否相同，用于判断要不要落盘（避免每次运行都写 localStorage） */
export function sameTags(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.id === b[i].id && x.label === b[i].label && x.source === b[i].source);
}

/* ---------------- 渲染 ---------------- */

/** 一个标签徽标。来源标在 title 里，鼠标悬停能看见。 */
export function tagChip(t) {
  const s = TAG_SOURCE[t.source] || TAG_SOURCE.derived;
  return `<span class="badge ${t.cls} src-tag${s.cls ? ' ' + s.cls : ''}" title="${esc(`${s.label}｜${t.note || ''}`)}">${esc(t.label)}</span>`;
}

/** 一串标签，limit 控制最多显示几个，多出来的折成 "+N" */
export function tagRow(m, ctx, limit = 4) {
  const { tags } = tagMember(m, ctx);
  if (!tags.length) return '';
  const shown = tags.slice(0, limit);
  const rest = tags.length - shown.length;
  return `<div class="tag-row">${shown.map(tagChip).join('')}${rest ? `<span class="src">+${rest}</span>` : ''}</div>`;
}

/** 来源说明条：同步状态一眼可见，不藏在悬停里 */
export function sourceLine(m, ctx) {
  const r = tagMember(m, ctx);
  const s = TAG_SOURCE[r.source] || TAG_SOURCE.derived;
  if (!r.synced) {
    return `<div class="small muted" style="line-height:1.6">标签由本地字段推算，这位会员还没有任何系统同步记录。接通三体或勤鸟后会自动改标。</div>`;
  }
  return `<div class="small muted" style="line-height:1.6">标签来自 <b>${esc(r.sourceLabel)}</b>`
    + (r.syncedAt ? `，最后同步 ${esc(r.syncedAt)}` : '，还没有同步过')
    + `。</div>`;
}
