/* ============================================================
   salesGrade.js · 销售等级评定 / 久未跟进判定 / 等级统计
   ------------------------------------------------------------
   全部是确定性计算，分数怎么来的、每一项加多少，都在界面上摊开。
   数据来源只有一处：本机使用日志（state.members / cards / followups）。
   不接第三方、不做行业比对、不引入"行业平均"这种取不到真值的数
   —— 拿不到的数据一律写「未获取」，不用推测值补空。
   ============================================================ */
import { GRADES, GRADE_BY_ID, GRADE_ORDER, GRADE_SCORE_LINE, CARD_LEVEL_RULES } from './data/salesGrade.js';

/* ---------------- 五项原始指标 ---------------- */

/**
 * 抽出评定所需的原始指标。
 * 每一项拿不到就返回 null，由评分环节显式跳过，不按 0 处理
 * ——「没有记录」和「记录为 0」是两回事，混在一起会让评分失真。
 */
export function gradeMetrics(m, state) {
  const cards = (state.cards || []).filter((c) => c.memberId === m.id);
  const fus = (state.followups || []).filter((f) => f.memberId === m.id);
  const d90 = new Date();
  d90.setDate(d90.getDate() - 90);
  const cut = d90.toISOString().slice(0, 10);

  return {
    paid: m.totalPaid ?? null,                                  // 累计消费
    renewals: cards.length ? cards.length - 1 : null,           // 续费次数 = 卡数 - 1（首购不算续费）
    cardCount: cards.length || null,
    visits30: m.visits30 ?? null,                               // 近 30 天到店
    follow90: fus.filter((f) => (f.date || '') >= cut).length || null, // 近 90 天跟进条数
    lastFollowDate: fus.length ? sortDesc(fus.map((f) => f.date))[0] : null,
    cardTypeText: m.cardType || '',
  };
}

const sortDesc = (a) => a.filter(Boolean).sort().reverse();

/** 卡种得分：取命中的最高一档，不叠加 */
export function cardLevelScore(text) {
  const t = String(text || '');
  for (const r of CARD_LEVEL_RULES) {
    if (r.words.some((w) => t.includes(w))) return r;
  }
  return { key: 'none', words: [], score: 0, label: '未识别卡种' };
}

/* ---------------- 评分与评级 ---------------- */

/**
 * 评分：五维加权，满分 100。
 * 权重按"对门店现金流的解释力"给：消费 35、续费 25、到店 20、卡种 12、跟进 8。
 * 缺项按该维度的满分占比等比缩放到 100 分制，
 * 这样"数据不全"不会被误判成"低价值客户"。
 */
export function gradeScoreOf(m, state) {
  const g = gradeMetrics(m, state);
  const card = cardLevelScore(g.cardTypeText);

  const dims = [
    { key: 'paid', label: '累计消费', weight: 35, got: g.paid, full: 20000 },
    { key: 'renewals', label: '续费次数', weight: 25, got: g.renewals, full: 3 },
    { key: 'visits30', label: '近 30 天到店', weight: 20, got: g.visits30, full: 12 },
    { key: 'card', label: '卡种等级', weight: 12, got: card.score, full: 3 },
    { key: 'follow90', label: '近 90 天跟进', weight: 8, got: g.follow90, full: 6 },
  ];

  let got = 0;
  let full = 0;
  const detail = [];
  for (const d of dims) {
    full += d.weight;
    if (d.got == null) { detail.push({ ...d, missing: true, pts: 0 }); continue; }
    const r = Math.min(1, d.got / d.full);
    const pts = +(d.weight * r).toFixed(1);
    got += pts;
    detail.push({ ...d, missing: false, pts, ratio: r });
  }

  const score = full ? Math.round((got / full) * 100) : 0;
  return { score, detail, metrics: g, card, coverage: full ? +(got / full).toFixed(3) : 0 };
}

/**
 * 评级：**只看综合分**，不用阈值逐档匹配。
 *
 * 这里早先走过一段弯路，记下来免得再退回去：
 * 曾经是"先从 A 到 D 逐档比阈值，全满足就落档"，结果是高价值客户被大量误判到 C。
 * 原因是阈值是**下限**，而各档门槛高低悬殊 —— A 档要求续费 2 次，
 * 一位消费 18800、月到店 11 次的客户只因续费 1 次就落不到 A，
 * 继续往下走又立刻满足 C 档那条极低的门槛，于是被判成 C 级。
 * 更糟的是分数与等级自相矛盾：界面上会出现「73 分 · C 级」，没人看得懂。
 *
 * 综合分本身就是五维加权的结果，已经把各档门槛的意图吸收进去了，
 * 再叠一层阈值判定只会制造第二套互相打架的标准。所以只留分数这一把尺子：
 *   A ≥ 68、B ≥ 42、C ≥ 18、D 兜底
 * 各档的 threshold 保留在 data 里，但只用于界面说明"这一档大致是什么画像"，
 * 不参与任何判定。
 */
export function gradeOf(m, state) {
  const s = gradeScoreOf(m, state);
  const id = s.score >= 68 ? 'A' : s.score >= 42 ? 'B' : s.score >= 18 ? 'C' : 'D';
  return {
    ...GRADE_BY_ID[id],
    score: s.score, detail: s.detail, metrics: s.metrics, card: s.card, basis: 'score',
  };
}

/**
 * 离上一档还差多少分。
 * A 档已到顶，返回 null；其余给出分数线与差值。
 */
export function nextGradeGap(gradeId, score) {
  const i = GRADE_ORDER.indexOf(gradeId);
  if (i <= 0) return null;                       // A 档已到顶（未知等级也返回 null）
  const up = GRADE_ORDER[i - 1];                 // 上一档的字母
  const line = GRADE_SCORE_LINE[up];             // 进入上一档所需的分
  return { nextGrade: up, line, gap: Math.max(0, line - score) };
}

/* ---------------- 顾问本人的业绩等级 ---------------- */

/**
 * 顾问（当前账号使用者）的业绩等级。
 *
 * 和会员分级用的是同一套 S/A/B/C/D 五个字母，但评的是两回事：
 *   会员等级 = 这个客户值多少跟进投入
 *   顾问等级 = 这个人管出来的盘子处在什么水平
 *
 * 五维全部取自本地使用日志，没有一项来自外部调查或行业比对：
 *   在册客户数    members.length
 *   成交率        totalPaid > 0 的占比
 *   续费率        有 2 张及以上会籍卡的占已成交人数比
 *   管理业绩      名下客户 totalPaid 合计
 *   跟进密度      近 30 天跟进条数 ÷ 在册客户数
 */
export function advisorGradeOf(state) {
  const st = state.settings || {};
  const advisor = st.advisor || '';
  /* 归属为空时也算这名顾问的名下 —— seed 里所有会员默认 owner 都是他，
     把空归属排除掉会让整盘数据凭空少掉一大半 */
  const mine = (state.members || []).filter((m) => !m.lost && (!m.owner || m.owner === advisor));
  const mineIds = new Set(mine.map((m) => m.id));
  const paid = mine.filter((m) => (m.totalPaid || 0) > 0);
  const renewed = paid.filter((m) => (state.cards || []).filter((c) => c.memberId === m.id).length > 1);
  const paidSum = paid.reduce((s, m) => s + (m.totalPaid || 0), 0);

  const d30 = new Date();
  d30.setDate(d30.getDate() - 30);
  const cut = d30.toISOString().slice(0, 10);
  const fu30 = (state.followups || []).filter((f) => mineIds.has(f.memberId) && (f.date || '') >= cut);

  const total = mine.length;
  const metrics = {
    size: total,
    dealRate: total ? Math.round((paid.length / total) * 100) : null,
    renewRate: paid.length ? Math.round((renewed.length / paid.length) * 100) : null,
    paidSum,
    /* 跟进密度：近 30 天人均跟进条数。没有客户时返回 null，不能是 0 */
    followDensity: total ? +(fu30.length / total).toFixed(2) : null,
  };

  /* 五维加权：成交率 30、续费率 28、业绩 22、盘子规模 12、跟进密度 8。
     续费率权重压到接近成交率，是因为续费才是这家店真正的现金来源。 */
  const dims = [
    { key: 'dealRate', label: '成交率', weight: 30, got: metrics.dealRate, full: 100, show: (v) => v + '%' },
    { key: 'renewRate', label: '续费率', weight: 28, got: metrics.renewRate, full: 100, show: (v) => v + '%' },
    { key: 'paidSum', label: '管理业绩', weight: 22, got: paidSum, full: 200000, show: (v) => '¥' + v.toLocaleString('zh-CN') },
    { key: 'size', label: '在册客户', weight: 12, got: total, full: 60, show: (v) => v + ' 人' },
    { key: 'followDensity', label: '跟进密度', weight: 8, got: metrics.followDensity, full: 3, show: (v) => v + ' 条/人·月' },
  ];

  let got = 0; let full = 0;
  const detail = [];
  for (const d of dims) {
    full += d.weight;
    if (d.got == null) { detail.push({ ...d, missing: true, pts: 0 }); continue; }
    const r = Math.min(1, d.got / d.full);
    const pts = +(d.weight * r).toFixed(1);
    got += pts;
    detail.push({ ...d, missing: false, pts, ratio: r, show: d.show(d.got) });
  }
  const score = full ? Math.round((got / full) * 100) : 0;

  /* 四级分数线与会员分级用的是同一套：A ≥ 68、B ≥ 42、C ≥ 18、D 兜底 */
  const id = score >= 68 ? 'A' : score >= 42 ? 'B' : score >= 18 ? 'C' : 'D';
  const grade = GRADE_BY_ID[id];
  const gapInfo = nextGradeGap(id, score);

  return {
    grade, score, metrics, detail,
    nextAt: gapInfo?.line ?? null,
    nextGrade: gapInfo?.nextGrade ?? null,
    gap: gapInfo?.gap ?? null,
    advisor, store: st.store || '', role: st.role || '', onboardAt: st.onboardAt || null,
  };
}

/* ---------------- 久未跟进判定 ---------------- */

/**
 * 距上次跟进多少天。没有跟进记录时返回 null
 * —— 「从来没跟进过」和「跟进过但很久了」要用不同的文案，不能混成 0。
 */
export function daysSinceFollowup(m, state, todayStr) {
  const g = gradeMetrics(m, state);
  if (!g.lastFollowDate) return null;
  const a = new Date(g.lastFollowDate + 'T00:00:00');
  const b = new Date(todayStr + 'T00:00:00');
  return Math.floor((b - a) / 86400000);
}

/**
 * 久未跟进判定。返回：
 *   { overdue, days, cycle, ratio, level }
 *   overdue  —— 是否判定为久未跟进
 *   days     —— 距上次跟进天数（null = 无跟进记录）
 *   cycle    —— 该等级允许的跟进周期上限
 *   ratio    —— days / cycle，>1 即超期
 *   level    —— 'none' 正常 | 'warn' 接近超期 | 'over' 已超期 | 'severe' 超期 2 倍以上
 */
export function stalenessOf(m, state, todayStr) {
  const grade = gradeOf(m, state);
  const days = daysSinceFollowup(m, state, todayStr);
  const cycle = grade.followCycle;

  if (days == null) {
    /* 从来没有跟进记录：直接按超期处理，且是最严重的一档 */
    return { overdue: true, days: null, cycle, ratio: null, level: 'severe', grade, never: true };
  }
  const ratio = +(days / cycle).toFixed(2);
  const level = ratio >= 2 ? 'severe' : ratio > 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'none';
  return { overdue: ratio > 1, days, cycle, ratio, level, grade, never: false };
}

/** 久未跟进的人话描述。days 为 null 时不能写"0 天没跟进"。 */
export function staleText(st) {
  if (st.never) return `还没有任何跟进记录（${st.grade.label}要求 ${st.cycle} 天内触达一次）`;
  if (st.level === 'severe') return `${st.days} 天没跟进，是${st.grade.label}周期（${st.cycle} 天）的 ${st.ratio} 倍`;
  if (st.level === 'over') return `${st.days} 天没跟进，已超${st.grade.label}周期（${st.cycle} 天）`;
  if (st.level === 'warn') return `${st.days} 天没跟进，接近${st.grade.label}周期（${st.cycle} 天）`;
  return `${st.days} 天前跟进过，在${st.grade.label}周期（${st.cycle} 天）内`;
}

/* ---------------- 全体评级与统计 ---------------- */

/**
 * 评级并按等级分组。
 * members 省略时评全店；传了就只评这一批。
 * 顶栏账号预览要的是「这名顾问名下」的分布，不能拿全店数去除以他的客户数，
 * 所以这里必须能限定范围。
 */
export function gradeRoster(state, members) {
  const src = members || (state.members || []).filter((m) => !m.lost);
  const list = src.map((m) => ({ m, grade: gradeOf(m, state) }));
  const byGrade = { A: [], B: [], C: [], D: [] };
  for (const x of list) byGrade[x.grade.id].push(x);
  return { list, byGrade };
}

/**
 * 某个顾问名下的客户。
 * 归属为空也算他的 —— seed 里所有会员默认 owner 都是当前顾问，
 * 把空归属排除掉会让整盘数据凭空少掉一大半。
 */
export const membersOfAdvisor = (state, advisor) =>
  (state.members || []).filter((m) => !m.lost && (!m.owner || !advisor || m.owner === advisor));

/**
 * 各等级的续费率与成交率统计。
 * 口径与「客户池统计」栏保持一套：
 *   成交 = totalPaid > 0
 *   续费 = 该会员的会籍卡多于 1 张（首购之外还有卡）
 * 拿不到分母时返回 null，界面显示「未获取」，绝不返回 0 冒充。
 */
export function gradeStats(state, members) {
  const { byGrade } = gradeRoster(state, members);
  const out = {};
  for (const g of GRADES) {
    const arr = byGrade[g.id].map((x) => x.m);
    const total = arr.length;
    const paid = arr.filter((m) => (m.totalPaid || 0) > 0);
    const renewed = arr.filter((m) => (state.cards || []).filter((c) => c.memberId === m.id).length > 1);
    const paidSum = paid.reduce((s, m) => s + (m.totalPaid || 0), 0);

    out[g.id] = {
      grade: g,
      count: total,
      dealCount: paid.length,
      renewCount: renewed.length,
      /* 成交率 = 已成交 ÷ 该等级人数；续费率 = 有续费卡 ÷ 已成交人数 */
      dealRate: total ? Math.round((paid.length / total) * 100) : null,
      renewRate: paid.length ? Math.round((renewed.length / paid.length) * 100) : null,
      paidSum,
      avgPaid: paid.length ? Math.round(paidSum / paid.length) : null,
    };
  }
  return out;
}

/** 全店汇总：总人数、总成交额、整体成交率、整体续费率 */
export function gradeSummary(state) {
  const members = (state.members || []).filter((m) => !m.lost);
  const paid = members.filter((m) => (m.totalPaid || 0) > 0);
  const renewed = paid.filter((m) => (state.cards || []).filter((c) => c.memberId === m.id).length > 1);
  return {
    total: members.length,
    dealCount: paid.length,
    renewCount: renewed.length,
    dealRate: members.length ? Math.round((paid.length / members.length) * 100) : null,
    renewRate: paid.length ? Math.round((renewed.length / paid.length) * 100) : null,
    paidSum: paid.reduce((s, m) => s + (m.totalPaid || 0), 0),
  };
}

/**
 * 今日任务清单。按**等级**聚合，不是按会员 × 任务展开
 * —— 后者会产生「会员数 × 任务数」条，看不完也用不上。
 * 返回每个等级一组：标准动作 + 该等级里真正需要今天处理的人（久未跟进的）。
 */
export function dailyTaskList(state, todayStr, members) {
  const { list } = gradeRoster(state, members);
  return GRADES.map((g) => {
    const mine = list.filter((x) => x.grade.id === g.id);
    const due = mine
      .map((x) => ({ ...x, stale: stalenessOf(x.m, state, todayStr) }))
      .filter((x) => x.stale.level === 'severe' || x.stale.level === 'over')
      .sort((a, b) => (b.stale.ratio ?? 99) - (a.stale.ratio ?? 99));
    return {
      grade: g,
      total: mine.length,
      tasks: g.dailyTasks || [],
      due,
      dueCount: due.length,
    };
  });
}
