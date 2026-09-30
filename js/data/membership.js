/* ============================================================
   data/membership.js · 精细化会籍卡模型
   ------------------------------------------------------------
   为什么单独建卡模型：
     一个会员身上可能同时有 期限卡 + 私教课包 + 储值余额，
     把这三样塞进会员主表的几个字段里，续费、冻结、转让全算不清。
     所以卡是独立实体，会员只是卡的持有者。
   ============================================================ */
import { daysBetween, today, parseDate, uid } from '../util.js';

export const CARD_TYPES = {
  term: { label: '期限卡', unit: '天', desc: '按有效期计，到期即失效' },
  count: { label: '次卡', unit: '次', desc: '按次数计，不限时间或限期使用' },
  pt: { label: '私教课包', unit: '节', desc: '需要教练排课，按节消课' },
  group: { label: '团课包', unit: '节', desc: '按课表预约，爽约扣次' },
  stored: { label: '储值卡', unit: '元', desc: '余额消费，可买课可买商品' },
  trial: { label: '体验卡', unit: '次', desc: '短期体验，用于转化' },
};

export const CARD_STATUS = {
  pending: { label: '待激活', cls: 'b-plain', hint: '已售出但还没开卡，注意提醒客户激活' },
  active: { label: '生效中', cls: 'b-green', hint: '' },
  frozen: { label: '已冻结', cls: 'b-info', hint: '伤病或出差，冻结期间不计时' },
  suspended: { label: '已停卡', cls: 'b-warn', hint: '客户主动暂停，需要回访确认原因' },
  expired: { label: '已到期', cls: 'b-danger', hint: '进入续费或回流流程' },
  transferred: { label: '已转让', cls: 'b-plain', hint: '转让他人，注意转介绍线索' },
  refunded: { label: '已退款', cls: 'b-plain', hint: '不计入成交口径' },
};

/** 卡种模板：用于发卡表单里的快速选择 */
export const CARD_TEMPLATES = [
  { name: '年卡', typeId: 'term', durationDays: 365, listPrice: 4580 },
  { name: '半年卡', typeId: 'term', durationDays: 180, listPrice: 2980 },
  { name: '季卡', typeId: 'term', durationDays: 90, listPrice: 1980 },
  { name: '月卡', typeId: 'term', durationDays: 30, listPrice: 680 },
  { name: '10 次卡', typeId: 'count', totalCount: 10, listPrice: 980 },
  { name: '30 次卡', typeId: 'count', totalCount: 30, listPrice: 2380 },
  { name: '私教 12 节', typeId: 'pt', totalCount: 12, listPrice: 4800 },
  { name: '私教 24 节', typeId: 'pt', totalCount: 24, listPrice: 8800 },
  { name: '私教 36 节', typeId: 'pt', totalCount: 36, listPrice: 12000 },
  { name: '团课 20 节', typeId: 'group', totalCount: 20, listPrice: 1600 },
  { name: '储值 5000', typeId: 'stored', totalCount: 5000, listPrice: 5000 },
  { name: '体验 3 次', typeId: 'trial', totalCount: 3, listPrice: 99, durationDays: 14 },
];

/** 卡的实际状态：存储状态 + 时间推导 */
export function cardStatus(card) {
  if (card.status === 'transferred' || card.status === 'refunded' || card.status === 'suspended') {
    return { key: card.status, ...CARD_STATUS[card.status] };
  }
  if (card.status === 'frozen') return { key: 'frozen', ...CARD_STATUS.frozen };
  if (card.endDate) {
    const left = daysBetween(today(), card.endDate);
    if (left < 0) return { key: 'expired', ...CARD_STATUS.expired, left };
  }
  if (card.typeId === 'count' || card.typeId === 'pt' || card.typeId === 'group' || card.typeId === 'trial') {
    if ((card.remainCount ?? 0) <= 0) return { key: 'expired', ...CARD_STATUS.expired, left: card.endDate ? daysBetween(today(), card.endDate) : null };
  }
  return { key: 'active', ...CARD_STATUS.active, left: card.endDate ? daysBetween(today(), card.endDate) : null };
}

/** 卡的紧迫度：用于排序和自动化触发 */
export function cardUrgency(card) {
  const st = cardStatus(card);
  const left = st.left;
  if (st.key === 'expired') return { level: 1, label: card.endDate ? `已过期 ${Math.abs(left)} 天` : '已用完' };
  if (card.endDate && left != null && left <= 7) return { level: 1, label: `${left} 天后到期` };
  if (card.endDate && left != null && left <= 30) return { level: 2, label: `${left} 天后到期` };
  if ((card.typeId === 'pt' || card.typeId === 'group') && (card.remainCount ?? 99) <= 3) {
    return { level: 1, label: `只剩 ${card.remainCount} 节` };
  }
  if (card.typeId === 'count' && (card.remainCount ?? 99) <= 3) {
    return { level: 2, label: `只剩 ${card.remainCount} 次` };
  }
  if (st.key === 'pending') return { level: 3, label: '待激活' };
  return { level: 9, label: '正常' };
}

/** 使用进度 0-1（期限卡按时间，次数卡按次数） */
export function cardProgress(card) {
  const st = cardStatus(card);
  if (card.typeId === 'term' && card.startDate && card.endDate) {
    const total = daysBetween(card.startDate, card.endDate) || 1;
    const used = daysBetween(card.startDate, today());
    return Math.max(0, Math.min(1, used / total));
  }
  if (card.totalCount) {
    return Math.max(0, Math.min(1, 1 - (card.remainCount ?? 0) / card.totalCount));
  }
  return 0;
}

/** 单卡剩余价值（用于续费谈判时算"你还剩多少"） */
export function cardRemainValue(card) {
  if (card.typeId === 'stored') return card.remainCount || 0;
  const p = cardProgress(card);
  if (card.periodValue == null) return null;
  return Math.round(card.periodValue * (1 - p));
}

/**
 * 从会员主表派生会籍卡，保证演示数据里"会员身上的卡"和"卡列表"永远一致。
 * 真实场景下卡是从三体 / 勤鸟读回来的，这里只是让示例数据自洽。
 */
export function deriveCards(members) {
  const out = [];
  members.forEach((m) => {
    const origin = m.triId ? 'santi' : m.qinniaoId ? 'qinniao' : 'manual';
    const remotePrefix = origin === 'santi' ? 'T3' : origin === 'qinniao' ? 'QN' : null;
    const remoteId = m.triId || m.qinniaoId || null;

    if (m.cardType && m.cardType !== '未成交' && m.expireDate) {
      const baseName = m.cardType.split('·')[0].trim();
      const isTerm = /年卡|半年|季卡|月卡/.test(baseName);
      const totalDays = /年卡/.test(baseName) ? 365 : /半年/.test(baseName) ? 180 : /季/.test(baseName) ? 90 : 30;
      out.push({
        id: 'card_' + m.id + '_m',
        memberId: m.id,
        cardNo: remotePrefix ? `${remotePrefix}-${String(100000 + (m.triId || m.qinniaoId).length * 977 + m.id.charCodeAt(2) * 31).slice(0, 6)}` : `FF-${m.id.toUpperCase()}`,
        name: baseName,
        typeId: isTerm ? 'term' : 'count',
        totalCount: isTerm ? null : 30,
        remainCount: isTerm ? null : Math.max(4, (m.visits30 || 2) * 2),
        startDate: m.joinDate,
        endDate: m.expireDate,
        listPrice: m.totalPaid || 0,
        paidPrice: m.totalPaid || 0,
        periodValue: isTerm ? Math.round((m.totalPaid || 0) * (30 / totalDays)) : null,
        status: daysBetween(today(), m.expireDate) < 0 ? 'expired' : 'active',
        source: origin,
        remoteId: remoteId ? remoteId + '-C1' : null,
        freezeLog: [],
        note: '',
      });
    }

    if (m.hasPT && m.ptTotal) {
      const days = m.joinDate ? Math.max(30, Math.abs(daysBetween(m.joinDate, m.expireDate || today())) || 180) : 180;
      out.push({
        id: 'card_' + m.id + '_pt',
        memberId: m.id,
        cardNo: (remotePrefix ? remotePrefix + '-' : 'FF-') + String(200000 + m.id.charCodeAt(2) * 137).slice(0, 6),
        name: `私教 ${m.ptTotal} 节`,
        typeId: 'pt',
        totalCount: m.ptTotal,
        remainCount: m.ptLeft,
        startDate: m.joinDate,
        endDate: m.expireDate,
        listPrice: Math.round(m.ptTotal * 380),
        paidPrice: Math.round(m.ptTotal * 340),
        periodValue: 380,
        status: (m.ptLeft || 0) <= 0 ? 'expired' : 'active',
        source: origin,
        remoteId: remoteId ? remoteId + '-PT1' : null,
        freezeLog: [],
        note: '',
      });
    }
  });

  /* 补几张有代表性的特殊卡：冻结、转让、待激活、储值 */
  const byName = (n) => members.find((m) => m.name === n);
  const chen = byName('陈昊');
  if (chen) out.push({
    id: 'card_extra_stored', memberId: chen.id, cardNo: 'QN-770012',
    name: '储值 3000', typeId: 'stored', totalCount: 3000, remainCount: 1240,
    startDate: members.find((m) => m.id === 'm08')?.joinDate, endDate: null,
    listPrice: 3000, paidPrice: 3000, periodValue: null, status: 'active',
    source: 'qinniao', remoteId: 'QN-88301-S1', freezeLog: [], note: '用于买课时与补剂',
  });

  const sun = byName('孙一鸣');
  if (sun) out.push({
    id: 'card_extra_frozen', memberId: sun.id, cardNo: 'T3-661204',
    name: '季卡', typeId: 'term', totalCount: null, remainCount: null,
    startDate: members.find((m) => m.id === 'm04')?.joinDate,
    endDate: members.find((m) => m.id === 'm04')?.expireDate,
    listPrice: 1980, paidPrice: 1980, periodValue: 33, status: 'frozen',
    source: 'santi', remoteId: 'T3-87951-C1',
    freezeLog: [{ from: '2026-08-20', to: null, reason: '准备考研，申请冻结', days: null }],
    note: '冻结中，复课时需要顺延到期日',
  });

  const huang = byName('黄璐');
  if (huang) out.push({
    id: 'card_extra_pending', memberId: huang.id, cardNo: 'FF-TRIAL-8891',
    name: '体验 3 次', typeId: 'trial', totalCount: 3, remainCount: 3,
    startDate: null, endDate: daysBetween(today(), today()) === 0 ? (() => { const x = new Date(); x.setDate(x.getDate() + 14); return x.toISOString().slice(0, 10); })() : null,
    listPrice: 99, paidPrice: 0, periodValue: 33, status: 'pending',
    source: 'manual', remoteId: null, freezeLog: [], note: '已售未激活，提醒客户预约第一次体验',
  });

  const he = byName('何伟');
  if (he) out.push({
    id: 'card_extra_expired', memberId: he.id, cardNo: 'T3-554021',
    name: '年卡', typeId: 'term', totalCount: null, remainCount: null,
    startDate: members.find((m) => m.id === 'm05')?.joinDate,
    endDate: members.find((m) => m.id === 'm05')?.expireDate,
    listPrice: 3980, paidPrice: 3980, periodValue: 327, status: 'expired',
    source: 'santi', remoteId: 'T3-87402-C1', freezeLog: [], note: '已过期，按回流处理',
  });

  return out;
}

export function newCard(patch = {}) {
  return {
    id: uid('card'), cardNo: 'FF-' + Math.random().toString(36).slice(2, 7).toUpperCase(),
    name: '', typeId: 'term', totalCount: null, remainCount: null,
    startDate: today(), endDate: null, listPrice: 0, paidPrice: 0, periodValue: null,
    status: 'active', source: 'manual', remoteId: null, freezeLog: [], note: '',
    ...patch,
  };
}

export const cardsOf = (cards, memberId) => cards.filter((c) => c.memberId === memberId);

export function cardSummary(cards) {
  const active = cards.filter((c) => ['active', 'frozen', 'pending'].includes(cardStatus(c).key));
  return {
    total: cards.length,
    active: active.length,
    urgent: cards.filter((c) => cardUrgency(c).level <= 2).length,
    expired: cards.filter((c) => cardStatus(c).key === 'expired').length,
    frozen: cards.filter((c) => c.status === 'frozen').length,
    pending: cards.filter((c) => c.status === 'pending').length,
    storedBalance: cards.filter((c) => c.typeId === 'stored').reduce((s, c) => s + (c.remainCount || 0), 0),
    paidTotal: cards.reduce((s, c) => s + (c.paidPrice || 0), 0),
    ptRemain: cards.filter((c) => c.typeId === 'pt').reduce((s, c) => s + (c.remainCount || 0), 0),
  };
}
