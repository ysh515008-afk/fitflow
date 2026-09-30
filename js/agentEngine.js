/* ============================================================
   agentEngine.js · 智能体引擎
   ------------------------------------------------------------
   三件事：
     1. run()      自动运行：按规则扫描全部数据，产出今日队列与提醒
     2. command()  数据指挥：给每个会员 / 每张卡算出「现在该做什么」
     3. evolve()   自主进化：根据规则的历史命中与采纳率，提出调整建议
   全部是确定性规则计算，不涉及任何"AI 猜测"。
   ============================================================ */
import { RULES, RULE_BY_ID, RULE_GROUPS, EVOLVE_TYPES } from './data/automation.js';
import { cardStatus, cardUrgency } from './data/membership.js';
import { nextMove, STATE_BY_ID, PRINCIPLES, BY_ID as PSY_BY_ID } from './data/psychology.js';
import { today, daysBetween, nowISO, uid, sortBy, sum, ratio, fmtDate } from './util.js';
import { stalenessOf, staleText } from './salesGrade.js';

/* ---------------- 规则开关 / 参数覆盖 ---------------- */

export function ruleConfig(state, id) {
  const base = RULE_BY_ID[id];
  const over = state.automations?.rules?.[id] || {};
  return { ...base, on: over.on ?? base.on, params: { ...base.params, ...(over.params || {}) } };
}

export const activeRules = (state) => RULES.filter((r) => ruleConfig(state, r.id).on);

/* ---------------- 自动运行 ---------------- */

/**
 * 扫描全部数据，产出命中列表。
 * @returns {{ hits: Array, byRule: Record<string, Array>, count: number }}
 */
export function run(state) {
  const hits = [];
  const push = (ruleId, target, text, meta = {}) => {
    const cfg = ruleConfig(state, ruleId);
    if (!cfg.on) return;
    hits.push({ ruleId, ruleName: cfg.name, group: cfg.group, priority: cfg.priority, target, text, ...meta });
  };

  /* 已标记「登记流失」的人不再进智能体：名单留着，但不再产生待办 */
  const members = (state.members || []).filter((m) => !m.lost);
  const cards = state.cards || [];
  const leads = state.leads || [];
  const t = today();

  /* --- 跟进逾期 --- */
  members.forEach((m) => {
    const fs = sortBy(state.followups.filter((f) => f.memberId === m.id), (f) => f.date, 'desc');
    const f = fs[0];
    if (!f?.nextDate) return;
    const over = daysBetween(f.nextDate, t);
    if (over >= 0) {
      const when = over === 0 ? '今天到期' : `已逾期 ${over} 天`;
      push('follow_overdue', m, `${f.nextAction || '按上次约定跟进'}（约定 ${fmtDate(f.nextDate, 'md')}，${when}）`, { overdue: over });
    }
  });

  /* --- 沉默 --- */
  members.forEach((m) => {
    if (!m.lastVisit) return;
    const days = -daysBetween(t, m.lastVisit);
    if (days >= 30) push('silent30', m, `${days} 天未到店，需要换渠道，微信已经无效了`, { days });
    else if (days >= 14) push('silent14', m, `${days} 天未到店，习惯正在断裂`, { days });
  });

  /* --- 会籍到期 --- */
  members.forEach((m) => {
    if (!m.expireDate) return;
    const left = daysBetween(t, m.expireDate);
    if (left == null || left < 0) return;
    if (left <= 7) push('expiry7', m, `${left} 天后到期，方案要已就绪、可当场签`, { left });
    else if (left <= 30) push('expiry30', m, `${left} 天后到期，进入续费推进窗口`, { left });
  });

  /* --- 课时 / 次数 --- */
  cards.forEach((c) => {
    const m = members.find((x) => x.id === c.memberId);
    if (!m) return;
    if (c.typeId === 'pt') {
      const lim = ruleConfig(state, 'pt_low').params['剩余阈值'] ?? 3;
      if ((c.remainCount ?? 99) <= lim) push('pt_low', m, `${c.name} 只剩 ${c.remainCount} 节，趁没归零谈续课包`, { cardId: c.id });
    }
    if (c.typeId === 'count' || c.typeId === 'group') {
      const lim = ruleConfig(state, 'count_low').params['剩余阈值'] ?? 3;
      if ((c.remainCount ?? 99) <= lim) push('count_low', m, `${c.name} 只剩 ${c.remainCount} 次`, { cardId: c.id });
    }
    if (c.status === 'pending') {
      push('card_pending', m, `${c.name}（${c.cardNo}）已售未激活，卡在沉默中会直接变成退款`, { cardId: c.id });
    }
    if (c.status === 'frozen' && c.freezeLog?.length) {
      const from = c.freezeLog[c.freezeLog.length - 1].from;
      const days = from ? -daysBetween(t, from) : null;
      const lim = ruleConfig(state, 'card_frozen').params['冻结天数'] ?? 60;
      if (days != null && days >= lim) push('card_frozen', m, `已冻结 ${days} 天，复课概率在快速下降`, { cardId: c.id, days });
    }
  });

  /* --- 高价值沉默 --- */
  const hv = ruleConfig(state, 'high_value_silent').params;
  members.forEach((m) => {
    if (!m.lastVisit || (m.totalPaid || 0) < (hv['金额阈值'] ?? 15000)) return;
    const days = -daysBetween(t, m.lastVisit);
    if (days >= (hv['未到店天数'] ?? 14)) push('high_value_silent', m, `累计消费 ${m.totalPaid}，已 ${days} 天未到店`, { days });
  });

  /* --- 线索首响 --- */
  const sla = ruleConfig(state, 'lead_sla').params['分钟'] ?? 30;
  leads.forEach((l) => {
    if (!['new', 'contacted'].includes(l.status)) return;
    if (l.firstResponseMin == null || l.firstResponseMin > sla) {
      push('lead_sla', l, l.firstResponseMin == null ? '还没有首次触达记录' : `首响用了 ${l.firstResponseMin} 分钟，超过 ${sla} 分钟`, { lead: true });
    }
  });

  /* --- 生日（默认关闭，数据补齐后才开） --- */
  members.forEach((m) => {
    if (!m.birthday) return;
    const mm = String(m.birthday).slice(5, 7);
    if (mm && mm === t.slice(5, 7)) push('birthday', m, '本月生日，适合做不带推销的关怀', {});
  });

  /* --- 个人时间 / 成长 / 数据（自身运行类，产出提醒而不是会员任务） --- */
  const stalled = Object.entries(state.learning?.progress || {})
    .filter(([, v]) => v.status === 'doing' && v.updatedAt && daysBetween(v.updatedAt, t) >= (ruleConfig(state, 'learning_stall').params['停滞天数'] ?? 7));
  stalled.forEach(([id, v]) => {
    const topic = id;
    push('learning_stall', { id: 'topic:' + id, name: '学习课题' }, `课题 ${id} 已停滞 ${-daysBetween(t, v.updatedAt)} 天没有更新产出`, { topicId: topic });
  });

  const triReady = Object.entries(state.connectors?.santi?.endpointSpec || {}).length;
  push('data_sync', { id: 'data', name: '数据健康' }, '核对接口端点进度与最近同步时间，列出仍未获取的字段', {});

  push('daily_standup', { id: 'standup', name: '智能体' }, `本次扫描生成 ${hits.length} 条待办`, {});
  push('weekly_review', { id: 'review', name: '智能体' }, '生成周复盘提示词，带本周跟进、预约、线索数据', {});

  const dedup = new Map();
  hits.forEach((h) => {
    const key = h.ruleId + '|' + (h.target?.id || '');
    if (!dedup.has(key)) dedup.set(key, h);
  });
  const list = sortBy([...dedup.values()], (h) => h.priority, 'asc');

  const byRule = {};
  list.forEach((h) => { (byRule[h.ruleId] = byRule[h.ruleId] || []).push(h); });

  return { hits: list, byRule, count: list.length, at: nowISO() };
}

/* ---------------- 数据指挥 ---------------- */

/**
 * 给一位会员算出「现在最该做的动作」
 * 返回优先级、动作、为什么、建议渠道、建议窗口、心理学切入
 */
export function command(m, state) {
  const t = today();
  const cards = (state.cards || []).filter((c) => c.memberId === m.id);
  const myCards = sortBy(cards, (c) => cardUrgency(c).level, 'asc');
  const worstCard = myCards[0];
  const lastF = sortBy(state.followups.filter((f) => f.memberId === m.id), (f) => f.date, 'desc')[0];
  const silentDays = m.lastVisit ? -daysBetween(t, m.lastVisit) : null;
  const left = m.expireDate ? daysBetween(t, m.expireDate) : null;
  const psych = lastF?.psych?.state ? nextMove(lastF.psych.state, lastF.psych.stage, lastF.psych.principles || []) : null;

  const mk = (level, action, why, channel, window, principle) => ({
    level, action, why, channel, window, principle,
    card: worstCard, lastFollowup: lastF, psychState: lastF?.psych?.state || null,
  });

  if (worstCard && cardStatus(worstCard).key === 'expired') {
    return mk(1, '按「回流」处理，先关心近况再说月卡',
      `${worstCard.name} 已到期${worstCard.endDate ? `（${fmtDate(worstCard.endDate, 'ymd')}）` : ''}，用续费话术会适得其反`, '电话', '上午 9:30-11:00', PSY_BY_ID.recovery);
  }
  if (left != null && left >= 0 && left <= 7) {
    return mk(1, '锁定续费方案，约面对面签约',
      `距离到期只剩 ${left} 天，这个阶段微信基本无效`, '面谈', '今天 18:30-20:00', psych?.principle || PSY_BY_ID.loss);
  }
  if (worstCard?.typeId === 'pt' && (worstCard.remainCount ?? 99) <= 3) {
    return mk(1, '谈私教续课包，先排固定时段再谈价格',
      `课时只剩 ${worstCard.remainCount} 节，归零后就从"在练"变成"停练"`, '面谈', '今天训练后', PSY_BY_ID.gradient);
  }
  if (worstCard && cardStatus(worstCard).key === 'pending') {
    return mk(2, '催激活：约第一次体验时间',
      '卡已售未激活，沉默超过一周就是退款高危', '微信', '今天 11:00-12:00', PSY_BY_ID.commitment);
  }
  if (m.stage === 'lead' || (!m.totalPaid && m.stage !== 'expired')) {
    return mk(1, '完成首次深度沟通，约体验课',
      '还没建立价值认知，现在谈价格没有意义', '微信 + 电话', '30 分钟内', PSY_BY_ID.oars);
  }
  if (silentDays != null && silentDays >= 30) {
    return mk(2, '换渠道唤醒：打电话 + 免费体测切入',
      `已 ${silentDays} 天未到店，微信触达率已经很低`, '电话', '上午 9:30-11:00', PSY_BY_ID.reciprocity);
  }
  if (silentDays != null && silentDays >= 14) {
    return mk(2, '关心型触达，先给价值不提卡',
      `${silentDays} 天未到店，正处在习惯断裂点`, '微信', '今天 11:00-12:00', psych?.principle || PSY_BY_ID.reciprocity);
  }
  if (lastF?.nextDate && daysBetween(lastF.nextDate, t) >= 0) {
    const overD = daysBetween(lastF.nextDate, t);
    return mk(2, lastF.nextAction || '按上次约定跟进',
      `上次约定在 ${fmtDate(lastF.nextDate, 'md')}，${overD === 0 ? '今天到期' : `已逾期 ${overD} 天`}`, '微信', '今天上午', psych?.principle || PSY_BY_ID.labeling);
  }
  if ((m.visits30 || 0) >= 8) {
    return mk(3, '深化关系：复盘进展 + 邀请转介绍',
      `近 30 天到店 ${m.visits30} 次，是门店里最稳的那批人`, '面谈', '训练结束后', PSY_BY_ID.social);
  }
  return mk(4, '例行维护：更新进展与体测数据',
    '当前没有紧迫风险，保持陪伴即可', '微信', '本周内', PSY_BY_ID.gradient);
}

/* ---------------- 处理后降级 / 复现升档 ---------------- */

/**
 * 复现理由：一个今天处理过的会员，凭什么还要再出现在队列里。
 *
 * 只有两条，都是确定性的日期判断，没有第三条：
 *   ① 约定跟进日期已到或逾期 —— 上次说了"X 号再联系"，到了就得联系
 *   ② 久未跟进 —— 距上次跟进超过该会员销售等级的跟进周期
 *
 * 逾期 1 天以上算 P1，当天到期或刚过周期算 P2。
 * 没有理由时返回 null，调用方据此走降级分支。
 */
export function reviveReasonOf(m, state, todayStr) {
  const t = todayStr || today();

  /* ① 约定跟进日期 */
  const lastF = sortBy((state.followups || []).filter((f) => f.memberId === m.id), (f) => f.date, 'desc')[0];
  if (lastF?.nextDate) {
    const over = daysBetween(lastF.nextDate, t);
    if (over >= 0) {
      const act = lastF.nextAction || '按上次约定跟进';
      return over === 0
        ? { level: 2, kind: 'promised', reason: `约定今天跟进：${act}` }
        : { level: 1, kind: 'promised', reason: `约定跟进已逾期 ${over} 天：${act}` };
    }
  }

  /* ② 久未跟进：阈值由该会员的销售等级决定 */
  const st = stalenessOf(m, state, t);
  if (st.level === 'severe') return { level: 1, kind: 'stale', reason: `久未跟进：${staleText(st)}` };
  if (st.level === 'over') return { level: 2, kind: 'stale', reason: `久未跟进：${staleText(st)}` };

  return null;
}

/**
 * 把「今天已经处理过」这件事折进优先级里。
 *
 * 三种结果，判定顺序不能调换：
 *   1. 有复现理由   → 按复现等级顶上来。已经处理过也不降级，
 *                     否则"说了周三联系"的承诺会被一次随手的处理抹掉。
 *   2. 无理由且已处理 → 优先级下降一档（level +1，4 封顶）。
 *                     客户卡因此从首页前排退出，但人还在清单里，
 *                     不是凭空消失 —— 消失会让"今天做过什么"失去凭据。
 *   3. 其余         → 保持原等级。
 */
export function commandWithHandled(m, state, handledIds = [], todayStr) {
  const base = command(m, state);
  const handled = handledIds.includes(m.id);
  const revive = reviveReasonOf(m, state, todayStr);

  if (revive) {
    return {
      ...base, handled, demoted: false, revived: true,
      level: Math.min(base.level, revive.level),
      reviveReason: revive.reason, reviveKind: revive.kind,
    };
  }
  if (handled) {
    return {
      ...base, handled, demoted: true, revived: false,
      level: Math.min(4, base.level + 1),
      reviveReason: '', reviveKind: '',
    };
  }
  return { ...base, handled: false, demoted: false, revived: false, reviveReason: '', reviveKind: '' };
}

/**
 * 指挥中心的排序：把所有会员排成一张"今天该动谁"的清单。
 *
 * handledIds 是「今日已处理」的会员 id 集合。传进来之后，
 * 处理过的人优先级会自动降一档，从首页前排退出；
 * 但到了约定跟进日或久未跟进的，会被重新顶回来。
 */
export function commandCenter(state, limit = 8, opts = {}) {
  const handledIds = opts.handledIds || [];
  const todayStr = opts.today || null;
  return sortBy(
    (state.members || []).filter((m) => !m.lost)
      .map((m) => ({ member: m, cmd: commandWithHandled(m, state, handledIds, todayStr) })),
    (x) => x.cmd.level, 'asc'
  ).slice(0, limit);
}

/* ---------------- 自主进化 ---------------- */

/**
 * 根据规则的历史效果，给出调整建议。
 * 逻辑是透明的统计判断，不是黑盒。
 */
export function evolve(state) {
  const out = [];

  RULES.forEach((r) => {
    const cfg = ruleConfig(state, r.id);
    const e = r.effect || { hit30: 0, done: 0, ignored: 0 };
    const doneRate = ratio(e.done, e.hit30);
    const ignoreRate = ratio(e.ignored, e.hit30);

    if (!cfg.on) {
      if (e.hit30 === 0 && r.note.includes('默认关闭')) {
        out.push({ ruleId: r.id, type: 'data', title: r.name, text: '处于关闭状态，且需要的数据（生日等）尚未补全。补齐数据再打开，否则会误发。', action: '补数据' });
      }
      return;
    }

    if (e.hit30 >= 3 && ignoreRate >= 0.4) {
      out.push({
        ruleId: r.id, type: 'tune', title: r.name,
        text: `30 天命中 ${e.hit30} 次，但有 ${e.ignored} 次没被采纳（忽略率 ${(ignoreRate * 100).toFixed(0)}%）。建议降低优先级，或者换个渠道再试。`,
        action: '降优先级',
      });
      return;
    }
    if (e.hit30 >= 4 && doneRate >= 0.8) {
      out.push({
        ruleId: r.id, type: 'keep', title: r.name,
        text: `30 天命中 ${e.hit30} 次，采纳率 ${(doneRate * 100).toFixed(0)}%，很稳。可以考虑把阈值再前移一档，更早介入。`,
        action: '前移阈值',
      });
      return;
    }
    if (e.hit30 === 0) {
      const usingData = (state.members || []).length > 0;
      out.push({
        ruleId: r.id, type: 'data', title: r.name,
        text: usingData ? '30 天内 0 次命中。可能是阈值太严，也可能是对应字段还没数据。先去数据里核一遍再改规则。' : '还没有数据，无法判断这条规则是否有效。',
        action: '检查数据',
      });
      return;
    }
    if (e.hit30 === 1) {
      out.push({ ruleId: r.id, type: 'data', title: r.name, text: '30 天只命中 1 次，样本太少，先观察，不要急着调参。', action: '继续观察' });
    }
  });

  /* 数据缺口：对接没完成会连带影响所有指标的准确性 */
  const santi = state.connectors?.santi;
  const qn = state.connectors?.qinniao;
  if (santi && santi.status !== 'connected') {
    const specs = ['members', 'memberships', 'appointments', 'checkins', 'orders', 'refunds'];
    out.push({
      ruleId: 'data_sync', type: 'data', title: `${santi.name} 未接通`,
      text: `会籍、课时、到店、订单目前靠人工导入，所有自动提醒的准确度都受这个影响。优先把 ${specs.length} 个端点核对完。`,
      action: '去核对端点',
    });
  }
  if (qn && qn.status === 'unauthorized') {
    out.push({
      ruleId: 'data_sync', type: 'data', title: `${qn.name} 待开通`,
      text: '适配器已写好，但需要先向勤鸟开通开放平台拿到开发文档，否则端点只能停在待核对状态。',
      action: '去申请开通',
    });
  }

  /* 规则覆盖建议 */
  const cardRules = RULES.filter((r) => r.group === 'card');
  if (cardRules.length < 5) {
    out.push({ ruleId: 'new', type: 'new', title: '可新增规则', text: '会籍卡相关规则偏少，可考虑增加"储值余额低于 500 时提醒续值"。', action: '新增规则' });
  }

  const order = { tune: 0, data: 1, new: 2, keep: 3 };
  return sortBy(out, (x) => order[x.type] ?? 9, 'asc');
}

/* ---------------- 汇总 ---------------- */

export function agentSummary(state) {
  const a = state.automations || {};
  const res = run(state);
  const total = RULES.length;
  const on = activeRules(state).length;
  const agg = RULES.reduce((acc, r) => {
    const e = r.effect || {};
    acc.hit += e.hit30 || 0; acc.done += e.done || 0; acc.ignored += e.ignored || 0;
    return acc;
  }, { hit: 0, done: 0, ignored: 0 });

  return {
    rulesOn: on,
    rulesTotal: total,
    hits: res.count,
    today: res,
    lastRunAt: a.lastRunAt || null,
    runCount: a.runCount || 0,
    hit30: agg.hit,
    done30: agg.done,
    adoptRate: ratio(agg.done, agg.hit),
    suggestions: evolve(state).length,
  };
}

export { RULE_GROUPS, RULES, RULE_BY_ID, EVOLVE_TYPES };
