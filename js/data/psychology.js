/* ============================================================
   data/psychology.js · 销售 - 会员交互的心理学框架
   ------------------------------------------------------------
   用途：
     1. 跟进记录时结构化存档（阶段 / 原理 / 客户状态 / 微承诺）
     2. 为每种心理状态给出「下一句该说什么」
     3. 作为 AI 任务包的上下文，让话术不是套模板
   原则：只收录有实证依据、且在健身房销售场景真的用得上的框架。
        不写"读心术"，不写操控话术。
   ============================================================ */

/** 一次交互的六个阶段，用于给每条跟进记录定位 */
export const STAGES = [
  { id: 'p1', name: '建立安全感', en: 'Rapport', goal: '让对方觉得你在帮他，不是在卖他', signal: '客户开始聊工作、家庭、身体以外的顾虑' },
  { id: 'p2', name: '探索真实需求', en: 'Discovery', goal: '问出他自己都说不清的真实动机', signal: '客户说出"其实我主要是……"' },
  { id: 'p3', name: '呈现方案', en: 'Present', goal: '让客户自己得出结论，而不是被说服', signal: '客户开始问细节、问周期、问效果' },
  { id: 'p4', name: '处理犹豫', en: 'Resolve', goal: '区分"没想清楚"和"不方便说出口的顾虑"', signal: '出现"再想想""问一下家里""太贵了"' },
  { id: 'p5', name: '促成与启动', en: 'Commit', goal: '把同意变成今天可执行的第一个动作', signal: '客户问"什么时候开始""怎么付"' },
  { id: 'p6', name: '巩固与陪伴', en: 'Reinforce', goal: '让第一次到店成为习惯的起点', signal: '客户主动分享训练感受或打卡' },
];

/** 心理学原理卡片 */
export const PRINCIPLES = [
  {
    id: 'oars', name: '动机式访谈（OARS）', en: 'Motivational Interviewing',
    stage: ['p2', 'p4'], evidence: '成瘾与行为改变领域最成熟的对话方法之一',
    what: '用开放式提问、肯定、反映、总结四件事，让客户自己说出改变的理由。人对自己说出的话，认同度远高于被灌输的话。',
    when: '客户说"我知道该练，但就是没动起来"这类矛盾心态时。',
    say: ['开放式：这半年最让你困扰的是哪一点？', '反映：所以你其实不是没时间，是怕练了没效果？', '总结：你的目标是三个月减 8 公斤，担心中途放弃，对吗？'],
    avoid: ['别急着给建议，先让他说完', '别用"你应该"开头'],
    check: '我有没有连续说超过 3 句话？',
  },
  {
    id: 'autonomy', name: '自主性支持', en: 'Autonomy Support',
    stage: ['p1', 'p3', 'p4'], evidence: '自我决定理论（SDT）核心：自主、胜任、归属',
    what: '给对方选择权而不是命令，被推销感立刻下降。选项要真实，不能是"假选择"。',
    when: '客户防御心强、或明显在抗拒议程时。',
    say: ['两个时间段你看哪个更方便，早上七点还是晚上八点？', '我们可以先做一次体测，也可以直接看两周训练计划，你想先看哪个？'],
    avoid: ['别给"你要不要办卡"这种封闭二选一（另一个选项是拒绝）'],
    check: '我给的选项里，两个都是他能接受的吗？',
  },
  {
    id: 'commitment', name: '承诺一致性阶梯', en: 'Foot-in-the-door',
    stage: ['p5', 'p6'], evidence: '承诺与一致性原理：人倾向与自己先前的行为保持一致',
    what: '不要一步到位要年卡，先拿到一个极小的承诺，再用这个承诺推进下一步。',
    when: '客户有意愿但迟迟不决定，或成交后需要维持到店。',
    say: ['今天先不聊卡，先把体测做了，行吗？', '先来三次，三次之后你自己判断要不要继续。'],
    avoid: ['别把微承诺当套路，承诺之后你必须真的兑现服务'],
    check: '我要的这个承诺，小到对方几乎不用思考就能答应吗？',
  },
  {
    id: 'loss', name: '损失厌恶', en: 'Loss Aversion',
    stage: ['p4', 'p5'], evidence: '前景理论：同等量级的损失带来的痛感是收益的两倍',
    what: '人怕失去比想得到更强烈。把"你将获得"翻译成"你正在放弃什么"。',
    when: '客户认可价值但拖着不决定时。',
    say: ['上周你的体测数据已经到临界点了，再拖两个月，这个变化会更难逆转。', '你之前已经练了 11 次，这些进度停下来就白费了。'],
    avoid: ['别恐吓。吓人能成交一次，但会毁掉续费和转介绍'],
    check: '我说的是事实还是夸大？',
  },
  {
    id: 'social', name: '社会认同（同型对照）', en: 'Social Proof',
    stage: ['p3', 'p4'], evidence: '社会认同原理：不确定时人会参考相似他人的行为',
    what: '案例要和对方的处境相似才有用：同样带娃、同样久坐、同样膝盖伤。不相似的成功案例反而会拉远距离。',
    when: '客户问"真的有用吗""我能坚持吗"。',
    say: ['跟你情况很像的一位会员，也是产后、只有晚上有空，她现在是每周两次。', '体重基数和你接近的会员，大概第 6 周开始看到变化。'],
    avoid: ['别用肌肉男/网红案例打久坐客户', '别泄露其他会员隐私'],
    check: '我举的例子里，客户能把自己代进去吗？',
  },
  {
    id: 'reciprocity', name: '互惠', en: 'Reciprocity',
    stage: ['p1', 'p2'], evidence: '互惠规范：先获得价值的人更愿意回报',
    what: '先给一次真正有用的东西，再提请求。给的东西必须对他真的有用，而不是宣传资料。',
    when: '陌生线索首次接触、或客户长时间不回复。',
    say: ['你上次提的膝盖问题，我整理了一份替代动作清单，先发你看，不用回我。'],
    avoid: ['别"给"完立刻要回报，那就变成交换了'],
    check: '我给的这份东西，是他主动想要的吗？',
  },
  {
    id: 'peakend', name: '峰终定律', en: 'Peak-End Rule',
    stage: ['p1', 'p6'], evidence: '体验评价主要由最高峰时刻和结束时刻决定',
    what: '体验课的高峰要在"客户做到了一件他以为自己做不到的事"，结束时刻要落在被肯定上，而不是报价上。',
    when: '设计体验课流程与到店离场环节。',
    say: ['刚才那组你自己都没想到能做下来，记住这个感觉。', '今天到这就结束，下次我们从这里继续。'],
    avoid: ['别让体验课的最后一句话变成价格'],
    check: '这次到店的最后 30 秒，客户是什么情绪？',
  },
  {
    id: 'gradient', name: '目标梯度效应', en: 'Goal Gradient',
    stage: ['p6'], evidence: '越接近目标，人的动力越强',
    what: '把进度可视化。远的目标要拆近，让客户随时看到"快了"。',
    when: '会员中期动力下滑、到店频次下降。',
    say: ['你已经走完这个计划的 7/12，剩下的两个月就是收尾。', '还差 1.8 公斤就到你定的目标线了。'],
    avoid: ['别虚报进度，一旦被发现信任就没了'],
    check: '我给的进度是真的吗？',
  },
  {
    id: 'choices', name: '选择架构（三档方案）', en: 'Choice Architecture',
    stage: ['p3', 'p5'], evidence: '决策心理学：选项超过 4 个，决策质量与转化率同时下降',
    what: '只给三档，并且让中间那档最合理。给多了客户会退出决策。',
    when: '报价与呈现方案。',
    say: ['基础档是年卡自主训练，中间档是年卡加 12 节私教，进阶档是全年私教。大多数人从中间开始。'],
    avoid: ['别给五档以上的价目表', '别把最贵的放在第一档（会让人立刻防御）'],
    check: '客户能在 30 秒内说出三档的区别吗？',
  },
  {
    id: 'load', name: '认知负荷削减', en: 'Reduce Cognitive Load',
    stage: ['p3', 'p5'], evidence: '双系统理论：决策疲劳时人倾向直接拒绝',
    what: '一次只让客户做一个决定。把"要不要办卡 + 办哪种 + 什么时候付 + 什么时候来"拆成四次对话。',
    when: '客户明显开始走神、回复变短。',
    say: ['今天只需要定一件事：体验课的时间。其他我们下次再聊。'],
    avoid: ['别在一条消息里塞三个问题'],
    check: '我这条消息里，客户要做的决定是不是只有一个？',
  },
  {
    id: 'labeling', name: '情绪标注', en: 'Affect Labeling',
    stage: ['p2', 'p4'], evidence: '把情绪说出来能降低杏仁核反应',
    what: '替客户说出他没说出口的感受，防御会立刻下降。',
    when: '客户沉默、语气变冷、或反复说"再想想"。',
    say: ['我感觉你不是不想练，是怕花了钱又坚持不下来。', '你听起来对这个价格有点为难。'],
    avoid: ['别替客户下结论后立刻接推销'],
    check: '我标注的是他的感受，还是我的猜测？',
  },
  {
    id: 'recovery', name: '服务恢复悖论', en: 'Service Recovery Paradox',
    stage: ['p4', 'p6'], evidence: '一次被妥善处理的失误，可能带来比从未出问题更高的忠诚',
    what: '客户投诉或受伤、停卡、换教练这类负面事件，处理得好反而是加强关系的机会。',
    when: '出现爽约、受伤、教练更换、课包争议。',
    say: ['这件事是我们的问题，我先把安排改好，再看怎么补你的时间。'],
    avoid: ['别先解释原因，先承认影响', '别用"公司规定"挡在前面'],
    check: '我有没有先共情，再解释？',
  },
];

export const BY_ID = Object.fromEntries(PRINCIPLES.map((p) => [p.id, p]));

/** 客户心理状态标签（用于存档，不做诊断） */
export const CLIENT_STATES = [
  { id: 'watch', label: '观望', hint: '还没进入决策，先建立关系，不要报价' },
  { id: 'hesitate', label: '犹豫', hint: '认可价值但有顾虑，先问出顾虑再谈方案' },
  { id: 'anxious', label: '焦虑', hint: '先情绪标注 + 降低决策量，别推进度' },
  { id: 'resist', label: '抗拒', hint: '停推方案，回到自主性支持，给真实选项' },
  { id: 'expect', label: '期待', hint: '可以给承诺阶梯 + 明确下一步时间' },
  { id: 'trust', label: '信任', hint: '适合做转介绍与深度方案，别只谈价格' },
  { id: 'tired', label: '疲惫', hint: '缩短沟通，只给一个动作，避免长消息' },
  { id: 'excited', label: '兴奋', hint: '趁热打铁，但要把兴奋落到一个具体日程上' },
];

export const STATE_BY_ID = Object.fromEntries(CLIENT_STATES.map((s) => [s.id, s]));

/** 交互质量自检（每条跟进记录勾选，用于复盘自己的沟通质量） */
export const QUALITY_CHECKS = [
  '我说的话比他少（多听少说）',
  '我给的选择是真实的（不是假二选一）',
  '我拿到一个具体的下一步时间',
  '我记录的是他的原话，不是我的总结',
  '我没有用"你应该"开头',
  '这次沟通不推销也成立（对方仍然觉得有用）',
];

/** 根据心理状态 + 阶段，给出下一步建议（纯规则，不假装是 AI 推理） */
export function nextMove(stateId, stageId, principles = []) {
  const s = STATE_BY_ID[stateId];
  const stage = STAGES.find((x) => x.id === stageId);
  if (!s) return { text: '先记录一次对话，再判断下一步。', principle: null };
  const map = {
    watch: 'p1',
    hesitate: 'p2',
    anxious: 'p1',
    resist: 'p1',
    expect: 'p5',
    trust: 'p3',
    tired: 'p1',
    excited: 'p5',
  };
  const suggestStage = STAGES.find((x) => x.id === map[stateId]) || stage;
  const candidate = PRINCIPLES.find((p) => p.stage.includes(suggestStage?.id) && !principles.includes(p.id))
    || PRINCIPLES.find((p) => p.stage.includes(suggestStage?.id));
  return {
    text: s.hint,
    stage: suggestStage,
    principle: candidate || null,
  };
}
