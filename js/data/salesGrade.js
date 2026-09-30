/* ============================================================
   data/salesGrade.js · 销售等级定义（纯数据）
   ------------------------------------------------------------
   销售等级回答一个问题：**这个客户值多少跟进投入**。
   等级越高，跟进周期节点越密、每日维护任务越多、
   对顾问的技能要求越高。

   四级：A / B / C / D。
   评定依据是**综合使用数据 + 会员分级**，全部来自本地使用日志，
   没有一项来自推测或外部调查：
     · 累计消费      state.members[].totalPaid
     · 续费次数      state.cards 里该会员的会籍卡张数（首购 + 每次续费各一张）
     · 到店频次      state.members[].visits30（近 30 天到店次数）
     · 跟进密度      state.followups 里近 90 天该会员的记录条数
     · 卡种等级      由 cardType 文本判定（私教 / 年卡 / 月卡）

   等级只影响三件事，不参与任何"智能判断"：
     1. followCycle  —— 距上次跟进超过这个天数，即判定「久未跟进」
     2. dailyTasks   —— 这个等级每天该做的标准动作
     3. skillReq     —— 维护这个等级客户需要具备的能力项
   ============================================================ */

/**
 * 四个等级，从高到低。
 * followCycle 单位是「天」，是这一档客户能接受的最长沉默间隔：
 * 高等级客户一旦断联，流失成本最高，所以节点最密。
 */
export const GRADES = [
  {
    id: 'A',
    label: 'A 级',
    name: '核心资产',
    color: 'danger',
    summary: '高消费 + 多次续费 + 高频到店，门店现金流的主体。断联一天的损失就高于拉新三个。',
    followCycle: 7,      // 7 天没跟进即算久未跟进
    cycleNote: '7 天',
    touchpoints: '每周至少 1 次主动触点',
    dailyTasks: [
      '晨间扫一遍到店记录，昨天来过的 A 级客户当天必须有反馈',
      '本周有训练进展的，当天把数据整理成一条图文发过去',
      '检查续费窗口，剩 60 天内到期的本周内出方案',
      '关注转介绍机会：高频到店的 A 级客户身边通常有同频的人',
    ],
    skillReq: [
      '能做周期化训练方案解读，讲得出"为什么这么排"',
      '会处理价格异议之外的深层顾虑（教练更换、效果停滞）',
      '具备面谈签约能力，能在一次会面内闭环',
    ],
    threshold: { paid: 15000, renewals: 2, visits30: 8, follow90: 4 },
  },
  {
    id: 'B',
    label: 'B 级',
    name: '稳定在练',
    color: 'warn',
    summary: '有稳定消费和固定到店习惯，但还没形成强依赖。维持节奏、别断联，同时找机会往上推。',
    followCycle: 14,
    cycleNote: '14 天',
    touchpoints: '每两周至少 1 次主动触点',
    dailyTasks: [
      '本周到店 6 次以上的客户，当天做一次正向反馈',
      '剩余的私教课时低于 5 节的，本周内排续课面谈',
      '体测数据有变化的，整理前后对比发过去',
    ],
    skillReq: [
      '能把训练数据讲成客户听得懂的进展故事',
      '会做升档引导：从年卡推向年卡 + 私教组合',
      '能识别"效果停滞"信号并提前介入',
    ],
    threshold: { paid: 6000, renewals: 1, visits30: 4, follow90: 2 },
  },
  {
    id: 'C',
    label: 'C 级',
    name: '低频待激活',
    color: 'info',
    summary: '消费低或到店少，处在流失边缘。目标不是立刻成交，是先恢复联系。',
    followCycle: 30,
    cycleNote: '30 天',
    touchpoints: '每月 1 次唤醒触点',
    dailyTasks: [
      '本月未到店的 C 级客户，排一次低成本唤醒（群活动 / 体测邀请）',
      '唤醒两次无回应的，降为 D 级观察，不再占用日常触点',
    ],
    skillReq: [
      '会做低压力的唤醒沟通，不提卡只给价值',
      '能判断该继续投入还是止损',
    ],
    threshold: { paid: 1000, renewals: 0, visits30: 1, follow90: 1 },
  },
  {
    id: 'D',
    label: 'D 级',
    name: '休眠观察',
    color: 'muted',
    summary: '长期无消费、无到店、无回应。只保留周期性低成本触达，不进入日常跟进队列。',
    followCycle: 60,
    cycleNote: '60 天',
    touchpoints: '每季度 1 次节点触达（生日 / 节日 / 店庆）',
    dailyTasks: [
      '不占用日常触点，只在节点日批量触达',
      '出现主动回应时，重新评定等级并回到正常队列',
    ],
    skillReq: [
      '能写出不打扰人的节点关怀文案',
    ],
    threshold: null,   // 兜底档，前面都不满足就是 D
  },
];

export const GRADE_BY_ID = Object.fromEntries(GRADES.map((g) => [g.id, g]));

/** 等级顺序：高 → 低。排序与"离上一档还差多少"都用它 */
export const GRADE_ORDER = ['A', 'B', 'C', 'D'];

/**
 * 进入该档所需的综合分下限。与 gradeOf 里的 byScore 分数线保持一套：
 * A ≥ 68、B ≥ 42、C ≥ 18、D 兜底（0）。
 * 改分数线时要同时改 gradeOf，两处不一致会让「还差多少分升档」算错。
 */
export const GRADE_SCORE_LINE = { A: 68, B: 42, C: 18, D: 0 };

/** 综合分满分口径，进度条按它算比例 */
export const GRADE_SCORE_FULL = 100;

/** 等级 → 徽章样式类（沿用全站 badge 体系） */
export const GRADE_BADGE = {
  A: 'b-danger',
  B: 'b-warn',
  C: 'b-info',
  D: 'b-plain',
};

/** 等级 → 主色（用于卡片左侧色条与图表） */
export const GRADE_COLOR = {
  A: 'var(--danger)',
  B: 'var(--warn)',
  C: 'var(--info)',
  D: 'var(--ink-4)',
};

/**
 * 卡种等级：从 cardType 文本里判定。
 * 只看关键词，不猜：文本里没有对应关键词就不加分。
 */
export const CARD_LEVEL_RULES = [
  { key: 'private', words: ['私教'], score: 3, label: '含私教' },
  { key: 'year', words: ['年卡', '年'], score: 2, label: '年卡' },
  { key: 'quarter', words: ['季卡'], score: 1, label: '季卡' },
  { key: 'month', words: ['月卡'], score: 1, label: '月卡' },
];
