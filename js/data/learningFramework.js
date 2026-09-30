/* ============================================================
   learningFramework.js · 可持续技能学习框架
   4 个阶段 × 5 项课题 = 20 项实践课题
   每项课题都绑定一个"可从FitFlow 数据里读出来的指标"，避免学习悬空
   ============================================================ */

export const STAGES = [
  {
    id: 's1',
    name: '销售顾问',
    en: 'Advisor',
    window: '0 - 3 个月',
    focus: '把体验课变成成交，把跟进变成节奏',
    color: '#0E8F5B',    outcome: '能独立完成「需求诊断 → 体验课 → 报价 → 成交」全流程，成交率≥25%',
  },
  {
    id: 's2',
    name: '会员运营',
    en: 'Member Ops',
    window: '3 - 9 个月',
    focus: '把成交变成到店，把到店变成续费',
    color: '#2C6BA8',
    outcome: '负责 80+ 活跃会员，续费率≥45%，沉默唤醒率≥20%',
  },
  {
    id: 's3',
    name: '项目负责人',
    en: 'Growth Lead',
    window: '9 - 18 个月',
    focus: '把个人能力变成内容和流程，跑通获客链路',
    color: '#0F7A8C',
    outcome: '月自主产出线索≥60条，线索到成交转化率≥12%，首响≤10分钟',
  },
  {
    id: 's4',
    name: '经营者',
    en: 'Operator',
    window: '18 个月以上',
    focus: '把流程变成模型，把模型变成可复制的门店',
    color: '#A96500',
    outcome: '能独立做目标拆解与单位经济模型，CAC/LTV 可控，新人 30 天出单',
  },
];

/**
 * metric = 这项学习对应的"真实业务指标"
 * metricKey 若与数据模块可计算的指标同名，则学习页会自动拉取真实数值
 */
export const TOPICS = [
  /* ---------- 阶段一：销售顾问 ---------- */
  {
    id: 't01', stage: 's1', title: '会员画像与需求诊断',
    objective: '用结构化问题在 15 分钟内问出真实目标、可投入时间和金钱边界。',
    actions: ['固定 6 问：目标 / 现状 / 时间 / 预算 / 伤病 / 过往失败原因', '每次诊断后立刻写进FitFlow 的"目标与顾虑"字段', '每周回看 5 份诊断卡，标注哪一问最有效'],
    deliverable: '累计 10 份完整需求诊断卡（本地可查）',
    metric: '需求诊断覆盖率', metricKey: 'diagnoseRate',
    hours: 8, cycle: '第 1-4 周',
  },
  {
    id: 't02', stage: 's1', title: '体验课流程与转化话术',
    objective: '把体验课做成"客户自己得出结论"的过程，而不是教练的推销。',
    actions: ['拆解体验课 5 个节点：破冰 / 体测 / 试练 / 反馈 / 转场', '每个节点写 3 句标准话术并背下来', '体验课后 24 小时内完成首次跟进'],
    deliverable: '体验课 SOP 一页纸 + 20 次体验课的转化记录',
    metric: '体验 → 成交转化率', metricKey: 'trialRate',
    hours: 12, cycle: '第 3-8 周',
  },
  {
    id: 't03', stage: 's1', title: '价格呈现与异议处理',
    objective: '不再用降价成交，学会用方案结构消化价格异议。',
    actions: ['建立 20 条常见异议应答库（贵 / 考虑 / 家里人商量 / 没时间）', '练"三档方案对比"报价法', '每次被拒后记录真实原因，周复盘'],
    deliverable: '20 条异议应答库 + 报价到成交率记录',
    metric: '报价 → 成交率', metricKey: 'quoteRate',
    hours: 10, cycle: '第 4-10 周',
  },
  {
    id: 't04', stage: 's1', title: '体测数据解读与方案呈现',
    objective: '把体测报告翻译成客户能听懂、愿意买单的计划。',
    actions: ['掌握 8 项核心体测指标的正常区间与话术', '做一份标准化方案书模板（目标 / 周期 / 频次 / 里程碑）', '用会员真实数据做 5 次模拟呈现'],
    deliverable: '方案书模板 + 5 份完整方案',
    metric: '方案通过率', metricKey: 'planRate',
    hours: 8, cycle: '第 5-12 周',
  },
  {
    id: 't05', stage: 's1', title: '客户档案与跟进节奏',
    objective: '建立"1 / 3 / 7 / 14 天"跟进节奏，让每条线索都有下一个动作。',
    actions: ['所有线索进FitFlow ，禁止记在微信收藏里', '给每类阶段设置默认跟进间隔', '每天开工先看「今日跟进队列」'],
    deliverable: '跟进节奏表 + 连续 30 天队列清空记录',
    metric: '7 天跟进达标率', metricKey: 'followRate',
    hours: 6, cycle: '持续',
  },

  /* ---------- 阶段二：会员运营 ---------- */
  {
    id: 't06', stage: 's2', title: '到店频率与训练陪伴',
    objective: '把"买卡"变成"来练"，用陪伴感提高到店频次。',
    actions: ['为每位会员设一个训练目标与第 1 个月到店目标', '每周一次训练反馈私信', '识别连续 7 天未到店的会员并当天触达'],
    deliverable: '80 位会员的到店目标表',
    metric: '月均到店频次', metricKey: 'visitFreq',
    hours: 10, cycle: '持续',
  },
  {
    id: 't07', stage: 's2', title: '续费节奏与临期管理',
    objective: '把续费提前到"到期前 30 天"，不再做救火式催单。',
    actions: ['按 30 / 14 / 7 / 3 天建立临期提醒', '每位临期会员配一个续费方案与一个 blockers 记录', '到期前 7 天完成一次面对面复盘'],
    deliverable: '续费管理看板 + 20 次续费面谈记录',
    metric: '续费率', metricKey: 'renewRate',
    hours: 12, cycle: '持续',
  },
  {
    id: 't08', stage: 's2', title: '沉默会员唤醒',
    objective: '用低成本触达把"没来"变成"回来了"。',
    actions: ['定义沉默：连续 14 天未到店', '设计 3 套唤醒脚本（关心型 / 福利型 / 目标回顾型）', '记录回复率与回店率，保留有效脚本'],
    deliverable: '3 套唤醒脚本 + 唤醒效果台账',
    metric: '沉默唤醒回店率', metricKey: 'wakeRate',
    hours: 8, cycle: '持续',
  },
  {
    id: 't09', stage: 's2', title: '社群分层与内容节奏',
    objective: '让群不只是发通知，而是产生到店和转介绍。',
    actions: ['按目标分群：减脂营 / 打卡群 / 粉丝群', '为每群定一份周内容日历（3 私域 + 1 活动）', '每周统计群活跃率与群线索数'],
    deliverable: '3 个社群的周内容日历 + 活跃度台账',
    metric: '社群周活跃率', metricKey: 'groupActive',
    hours: 10, cycle: '持续',
  },
  {
    id: 't10', stage: 's2', title: '口碑与转介绍机制',
    objective: '把满意会员变成稳定的线索来源。',
    actions: ['设定转介绍触发点（首次达成目标 / 第 20 次到店）', '设计转介绍权益与话术，避免"帮我个忙"', '记录每位转介绍来源与成交结果'],
    deliverable: '转介绍机制说明 + 转介绍台账',
    metric: '转介绍线索占比', metricKey: 'referralRate',
    hours: 6, cycle: '持续',
  },

  /* ---------- 阶段三：项目负责人 ---------- */
  {
    id: 't11', stage: 's3', title: '短视频选题与脚本',
    objective: '用门店真实场景产出可信内容，而不是跟风拍段子。',
    actions: ['建立选题库（体态纠错 / 会员改变 / 器械用法 / 反常识）', '用"钩子 3 秒 + 价值 15 秒 + 行动 5 秒"写脚本', '每周发布 3 条，记录播放与私信数'],
    deliverable: '30 条选题库 + 每周 3 条发布记录',
    metric: '内容带来的线索数', metricKey: 'contentLeads',
    hours: 20, cycle: '第 1-12 周',
  },
  {
    id: 't12', stage: 's3', title: '私域内容日历与朋友圈节奏',
    objective: '让朋友圈成为可信的专业形象，而不是广告墙。',
    actions: ['按 5 类内容排周节奏：专业 / 案例 / 日常 / 活动 / 人格', '固定发布时间与条数（每天不超过 2 条）', '统计朋友圈带来的咨询数'],
    deliverable: '一个月私域内容日历 + 咨询归因记录',
    metric: '私域咨询数', metricKey: 'dmLeads',
    hours: 12, cycle: '持续',
  },
  {
    id: 't13', stage: 's3', title: '活动策划与体验营',
    objective: '用一场活动同时完成拉新、体验和口碑。',
    actions: ['按"主题 → 目标人群 → 权益 → 转化路径"写方案', '控制成本，算清单场投入与产出', '活动后 48 小时内完成全部跟进'],
    deliverable: '3 场完整活动方案与复盘',
    metric: '活动到场率 / ROI', metricKey: 'activityRoi',
    hours: 16, cycle: '每季度 1 场',
  },
  {
    id: 't14', stage: 's3', title: '线索分配与首响 SLA',
    objective: '把线索当成有保质期的资产，10 分钟内必须触达。',
    actions: ['定义线索分级（A 明确意向 / B 有意愿 / C 观望）', '设定首响 SLA 并公开看板', '每周复盘流失线索的真实原因'],
    deliverable: '线索分级规则 + 首响看板',
    metric: '平均首响时长 / 线索转化率', metricKey: 'firstResponse',
    hours: 10, cycle: '持续',
  },
  {
    id: 't15', stage: 's3', title: '单店数据分析与复盘',
    objective: '从漏斗每一环找瓶颈，而不是只看成交数字。',
    actions: ['建立固定漏斗：曝光 → 线索 → 体验 → 成交 → 到店 → 续费', '每月做一次漏斗拆解，只改最差的一环', '把结论写成一句话行动，不写形容词'],
    deliverable: '3 份月度漏斗复盘报告',
    metric: '漏斗各环节转化率', metricKey: 'leadConv',
    hours: 14, cycle: '每月',
  },

  /* ---------- 阶段四：经营者 ---------- */
  {
    id: 't16', stage: 's4', title: '目标拆解与业绩预测',
    objective: '把月度目标拆到"每天该谈几个人"，而不是月底惊讶。',
    actions: ['按 目标 → 成交单数 → 体验数 → 线索数 反推', '用过去 3 个月转化率做预测，不拍脑袋', '每周核对进度并调整动作量'],
    deliverable: '3 个月目标拆解表（业绩目标模块内）',
    metric: '目标达成率', metricKey: 'goalRate',
    hours: 12, cycle: '每月',
  },
  {
    id: 't17', stage: 's4', title: '单位经济模型：客单 / 毛利 / 获客成本',
    objective: '算清一位会员到底赚多少，才知道能花多少钱获客。',
    actions: ['算 LTV：客单价 × 续费次数 × 毛利率', '算 CAC：活动与内容投入 ÷ 新增成交', '定一条红线：CAC 不超过首单毛利的 40%'],
    deliverable: '一张单位经济模型表',
    metric: 'CAC / LTV 比值', metricKey: 'ltvCac',
    hours: 12, cycle: '每季度',
  },
  {
    id: 't18', stage: 's4', title: '团队招聘与带教 SOP',
    objective: '把你自己跑通的动作变成手册，让新人 30 天能出单。',
    actions: ['写清岗位画像与淘汰标准', '把 t01-t05 整理成新人 30 天带教计划', '为新人设 4 个检查点（话术 / 体验 / 报价 / 独立成交）'],
    deliverable: '新人 30 天带教手册 + 检查点表',
    metric: '新人首单周期', metricKey: 'onboardingDays',
    hours: 16, cycle: '每次招人',
  },
  {
    id: 't19', stage: 's4', title: '会员资产与门店口碑运营',
    objective: '把会员当成可经营资产，用续费与口碑替代单纯买流量。',
    actions: ['建立会员生命周期地图（获取 / 激活 / 留存 / 推荐 / 流失）', '为每个阶段配一个自动化动作', '每季度算一次留存曲线与转介绍贡献'],
    deliverable: '会员生命周期地图 + 季度留存报告',
    metric: '续费率 / 转介绍占比', metricKey: 'renewRate',
    hours: 14, cycle: '每季度',
  },
  {
    id: 't20', stage: 's4', title: '系统化与自动化（三体 × FitFlow 打通）',
    objective: '让数据自己流动，把时间从"抄表格"里省出来。',
    actions: ['打通三体会员 / 预约 / 订单读取（见数据连接模块）', '接口未授权前用导出导入兜底，保证数据不断档', '每周核对一次同步完整率与失败记录'],
    deliverable: '数据连接配置 + 每周同步核对记录',
    metric: '数据同步完整率', metricKey: 'dataSyncRate',
    hours: 20, cycle: '持续',
  },
];

/** 可持续性机制：每项课题完成后必须留下"证据"，否则不算完成 */
export const EVIDENCE_RULE = '完成标准：产出物写进FitFlow + 关联指标有真实数值变化。只写"已学习"不算完成。';

/** 发散性扩展：这些能力可以从健身房销售迁移出去，作为长期护城河 */
export const TRANSFERABLE = [
  { from: '需求诊断 (t01)', to: ['保险 / 理财顾问', '教培课程顾问', 'B 端 SaaS 售前'], value: '结构化提问能力，是所有高客单销售的底座' },
  { from: '社群运营 (t09)', to: ['品牌私域操盘手', '用户运营', '社区产品运营'], value: '分层 + 内容日历 = 可复制的私域方法论' },
  { from: '短视频内容 (t11)', to: ['内容 IP / 个人品牌', '本地生活代运营', '知识付费'], value: '选题库与脚本能力可直接变现' },
  { from: '数据复盘 (t15)', to: ['商业分析', '增长运营', '门店咨询'], value: '漏斗拆解是通用商业语言' },
  { from: '带教 SOP (t18)', to: ['培训师', '区域督导', '连锁加盟运营'], value: '把个人能力产品化的能力' },
  { from: '单位经济 (t17)', to: ['开店 / 加盟决策', '创业财务模型', '投资判断'], value: '算得清账，才敢做更大的决定' },
];

/** 能力雷达：用于每月自评（1-5 分），数据存本地 */
export const RADAR_DIMENSIONS = [
  { id: 'r1', name: '需求诊断', topic: 't01' },
  { id: 'r2', name: '成交转化', topic: 't03' },
  { id: 'r3', name: '会员陪伴', topic: 't06' },
  { id: 'r4', name: '内容获客', topic: 't11' },
  { id: 'r5', name: '数据复盘', topic: 't15' },
  { id: 'r6', name: '经营模型', topic: 't17' },
];

/** 月度复盘模板（学习页可直接复制） */
export const REVIEW_TEMPLATE = `【月复盘 · 请填空后回看】
1. 本月目标达成率：___%（目标 ___ / 实际 ___）
2. 最有效的一个动作：__________
   → 对应数据变化：__________
3. 最差的一环（漏斗里哪一步）：__________
   → 下月只改这一件事：__________
4. 本月新学的课题：__________
   → 留下的产出物：__________
   → 关联指标变化：__________
5. 下月目标与反推动作量：
   目标 ___ → 成交 ___ 单 → 体验 ___ 人 → 线索 ___ 条 → 每天触达 ___ 人`;
