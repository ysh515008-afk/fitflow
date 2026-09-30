/* ============================================================
   aiPacks.js · AI 辅助工作流任务包
   定位：把"该问 AI 什么"标准化。FitFlow 只负责生成结构化的提示词，
        并把 AI 回答存回本地，不做任何"假装 AI 已分析"的展示。
   ============================================================ */
import { today, fmtDate, relDay, daysBetween, fmtMoney } from './util.js';
import { STAGES, expiry, activity, latestFollowup, renewalOf, RESULT_LABEL } from './store.js';

const line = (k, v) => (v ? `${k}：${v}` : null);

/* 会员档案块始终以真实数据构建 —— 用户界面显示的就是完整信息。
   脱敏不在这里做：它属于「数据交换端口」职责，由 outreach.js 的 redactPII()
   在真正 fetch 外发前一刻执行（UI 与提示词预览保持真实）。 */
function memberBlock(m, s) {
  if (!m) return '（未选择会员）';
  const f = latestFollowup(m.id);
  const p = renewalOf(m.id);
  const e = expiry(m);
  const a = activity(m);
  const rows = [
    `姓名：${m.name}（${m.gender}，${m.age} 岁）`,
    line('会员阶段', STAGES[m.stage]?.label),
    line('会籍', m.cardType),
    line('到期', m.expireDate ? `${m.expireDate}（${e.label}）` : '未办卡'),
    line('私教课时', m.hasPT ? `剩余 ${m.ptLeft}/${m.ptTotal} 节` : '无'),
    line('来源', m.source === 'tri' ? '三体同步' : m.source),
    line('近 30 天到店', `${m.visits30 || 0} 次`),
    line('最近到店', m.lastVisit ? `${m.lastVisit}（${a.label}）` : '无记录'),
    line('训练目标', (m.goals || []).join('；')),
    line('需求', (m.intents || []).join('、')),
    line('顾虑', (m.concerns || []).join('；')),
    line('标签', (m.tags || []).join('、')),
    line('累计消费', m.totalPaid ? fmtMoney(m.totalPaid) : null),
    line('最近一次沟通', f ? `${f.date} · ${f.summary}｜客户反馈：${f.feedback}｜结果：${RESULT_LABEL[f.result] || f.result || '未记'}` : '暂无记录'),
    line('上次约定的下一步', f?.nextAction ? `${f.nextAction}（约定 ${f.nextDate}）` : null),
    line('续费计划', p ? `阶段 ${p.stage}｜报价 ${p.quoteAmount || 0}｜卡点 ${(p.blockers || []).join('、') || '无'}` : null),
    line('我的备注', m.note),
  ];
  return rows.filter(Boolean).join('\n');
}

const COMMON_RULE = `约束：
- 不要编造我的会员没有提供的信息；缺数据的地方写"信息不足，需补充____"。
- 不要给通用鸡汤式建议，每条建议都要能落到一个具体动作和一句具体话术。
- 输出用中文，短句，直接可复制使用。`;

export const PACKS = [
  {
    id: 'followup',
    title: '会员跟进话术',
    icon: 'i-chat',
    desc: '根据会员阶段、上次沟通与顾虑，生成 3 套可直接发送的跟进话术。',
    needsMember: true,
    build: (ctx) => `你是健身房销售顾问的话术教练。请基于下面的真实会员档案，帮我准备今天的跟进。

【会员档案】
${memberBlock(ctx.member, ctx.state)}

【当前时间】${today()}（${ctx.weekday}）

【任务】
1. 判断这位会员当前最关键的一个心理阻碍是什么，用一句话说清。
2. 给我 3 套跟进话术，分别为：
   A. 微信私信版（不超过 80 字，自然，不像广告）
   B. 电话开场版（前 15 秒说什么，含一个提问）
   C. 到店面谈版（3 步推进结构）
3. 每套话术后面标注：预期客户反应 + 我该怎么接。
4. 最后给一个明确的收尾动作：本次沟通要拿到什么具体结果（时间/承诺/资料）。

【输出格式】
阻碍判断：
话术 A（微信）：
话术 B（电话）：
话术 C（面谈）：
收尾动作：

${COMMON_RULE}`,
  },
  {
    id: 'renew',
    title: '临期续费方案',
    icon: 'i-target',
    desc: '针对到期会员生成两档续费方案与异议预演。',
    needsMember: true,
    build: (ctx) => `你是健身门店的续费教练。请为下面这位临期会员设计续费方案。

【会员档案】
${memberBlock(ctx.member, ctx.state)}

【任务】
1. 用客户视角说清"他为什么值得继续练"依据是他的真实目标和已取得的进展，不要空夸。
2. 设计两档方案（保守档 / 进阶档），每档包含：内容、周期、价格区间建议、我该怎么解释价格。
3. 列出他可能提出的 4 个异议，每个给一句不超过 30 字的应答。
4. 给出今天就能执行的下一步动作（一句话，带时间点）。

【输出格式】
价值回顾：
方案 A（保守）：
方案 B（进阶）：
异议预演（4 条）：
今天下一步：

${COMMON_RULE}`,
  },
  {
    id: 'wake',
    title: '沉默会员唤醒',
    icon: 'i-bell',
    desc: '为长期未到店会员设计低成本唤醒路径。',
    needsMember: true,
    build: (ctx) => `你是会员留存运营。下面这位会员已经很久没到店，请设计唤醒路径。

【会员档案】
${memberBlock(ctx.member, ctx.state)}

【任务】
1. 判断他沉默的最可能原因（从数据里推断，并说明依据）。
2. 给 3 条不同角度的唤醒路径，按"成本从低到高"排序：
   - 纯关心（不推销）
   - 福利/活动切入
   - 目标回顾 + 免费体测
3. 每条路径给出：触达渠道、发送时间、具体文案（≤60 字）、预期回复率。
4. 如果他回复了，第二步怎么接。如果他没回，间隔几天再试、换什么角度。

【输出格式】
原因判断（含依据）：
路径 1 / 2 / 3：
回复后的承接：
没回复的二次触达：

${COMMON_RULE}`,
  },
  {
    id: 'community',
    title: '社群一周内容日历',
    icon: 'i-ops',
    desc: '按社群定位生成一周内容排期，含话术与执行时间。',
    needsMember: false,
    build: (ctx) => `你是健身房私域社群运营。请为下面这些社群排一周内容日历。

【社群现状】
${(ctx.state.groups || []).map((g) => `- ${g.name}｜平台：${g.platform}｜人数：${g.members}｜周活跃率：${(g.activeRate * 100).toFixed(0)}%｜定位：${g.purpose}｜节奏：${g.cadence}｜健康度：${g.health}`).join('\n')}

【本周已知安排】
${(ctx.state.appointments || []).filter((a) => daysBetween(today(), a.date) >= 0 && daysBetween(today(), a.date) <= 7).map((a) => `- ${a.date} ${a.time} ${a.type}`).join('\n') || '无'}

【任务】
1. 针对每个社群，给出 7 天内容排期表：日期 / 内容主题 / 形式（图文/接龙/直播/福利）/ 发布时段 / 负责人。
2. 内容要包含：专业价值、会员案例、互动任务、转化动作四类，比例约 2:1:1:1。
3. 挑出 3 条最可能带来到店的帖子，写出可直接发布的完整文案（每条 ≤120 字）。
4. 指明哪个群当前最需要干预，为什么。

【输出格式】
（按社群分节的排期表）
重点文案 1 / 2 / 3：
需干预社群：

${COMMON_RULE}`,
  },
  {
    id: 'shortvideo',
    title: '短视频选题与脚本',
    icon: 'i-flame',
    desc: '基于门店真实素材生成选题库与 15 秒脚本骨架。',
    needsMember: false,
    build: (ctx) => `你是本地健身门店的短视频编导。请基于真实素材出选题与脚本。

【我的素材库】
会员真实变化：${ctx.state.members.filter((m) => (m.goals || []).length).slice(0, 6).map((m) => `${m.name}（${(m.intents || []).join('/')}）`).join('、')}
常见顾虑：${[...new Set(ctx.state.members.flatMap((m) => m.concerns || []))].slice(0, 8).join('；')}
在售内容：${(ctx.state.campaigns || []).map((c) => `${c.title}（${c.platform}，播放 ${c.views}）`).join('；')}

【任务】
1. 出 8 个选题，每个标注：目标人群、钩子（前 3 秒说什么）、价值点、结尾行动引导。
2. 挑 3 个最适合本周拍的，写成 15-25 秒脚本骨架：分镜 / 口播词 / 画面。
3. 结合"在售内容"的数据，指出哪一类选题已经验证有效，应该加量；哪一类应该停。
4. 给 1 个可能踩坑的合规提醒（健身内容容易违禁的说法）。

【输出格式】
选题表（8 条）：
本周脚本 1 / 2 / 3：
加量 / 停更建议：
合规提醒：

${COMMON_RULE}`,
  },
  {
    id: 'review',
    title: '经营数据复盘',
    icon: 'i-data',
    desc: '把当前漏斗与目标数据交给 AI，找出最该改的一环。',
    needsMember: false,
    build: (ctx) => `你是门店经营分析顾问。请基于以下真实数据做一次漏斗复盘，找出瓶颈。

【本月目标与达成】
目标业绩：${fmtMoney(ctx.goal.targetRevenue)}｜已达成：${fmtMoney(ctx.goal.actualRevenue)}
目标成交：${ctx.goal.targetDeals} 单｜已成交：${ctx.goal.actualDeals} 单
目标体验：${ctx.goal.targetTrials} 人｜已体验：${ctx.goal.actualTrials} 人
目标线索：${ctx.goal.targetLeads} 条｜已获取：${ctx.goal.actualLeads} 条

【漏斗（本月）】
${ctx.funnel.map((f, i) => `${i + 1}. ${f.label}：${f.value}${i ? `（较上一步 ${((f.value / (ctx.funnel[i - 1].value || 1)) * 100).toFixed(0)}%）` : ''}`).join('\n')}

【近 6 个月趋势】
${ctx.state.history.map((h) => `${h.label}：业绩 ${h.revenue}｜成交 ${h.deals}｜体验 ${h.trials}｜线索 ${h.leads}`).join('\n')}

【内容表现】
${(ctx.state.campaigns || []).map((c) => `${c.title}｜${c.platform}｜播放 ${c.views}｜线索 ${c.dmLeads + c.formLeads}`).join('\n')}

【关键指标】
${ctx.metricLines}

【任务】
1. 指出漏斗中转化率最差的一环，并给出判断依据（用数字说话）。
2. 只针对这一环，给 3 个本周可执行的具体动作。
3. 按当前节奏预测本月最终业绩，并说明预测依据。
4. 用一句话总结这个月最该记住的教训。

【输出格式】
瓶颈环节（含依据）：
三个动作：
月末预测：
一句话教训：

${COMMON_RULE}`,
  },
  {
    id: 'learning',
    title: '学习课题推进',
    icon: 'i-learn',
    desc: '把当前学习课题变成本周可完成的练习任务。',
    needsMember: false,
    build: (ctx) => `你是我的销售能力教练。我正在按"销售顾问 → 会员运营 → 项目负责人 → 经营者"四阶段框架学习，请帮我把当前课题落到本周。

【当前课题】
${ctx.topic ? `课题：${ctx.topic.title}\n目标：${ctx.topic.objective}\n关键动作：${(ctx.topic.actions || []).join('；')}\n要求产出：${ctx.topic.deliverable}\n关联指标：${ctx.topic.metric}（当前：${ctx.topic.metricText}）` : '（未选择课题）'}

【我的真实数据】
${ctx.metricLines}

【任务】
1. 判断这个课题我目前的真实水平，指出证据（用上面的数据）。
2. 把课题拆成 3 个本周可完成的小练习，每个练习写清：做什么、做几次、怎么算完成。
3. 给一个"能力自检清单"（5 条），我月底用来判断自己是否真的进步了。
4. 指出这个能力未来可以迁移到哪些岗位或场景。

【输出格式】
当前水平判断：
本周三个练习：
自检清单（5 条）：
可迁移方向：

${COMMON_RULE}`,
  },
  {
    id: 'psych',
    title: 'AI 话术设计',
    icon: 'i-spark',
    desc: '按会员当前心理状态与交互阶段，设计下一步对话（含该用的原理与禁忌）。',
    needsMember: true,
    build: (ctx) => `你是行为改变与销售沟通的教练，方法基于动机式访谈、自我决定理论与决策心理学。请帮我准备下一次沟通。

【会员档案】
${memberBlock(ctx.member, ctx.state)}

【最近一次交互存档】
${ctx.lastPsych ? `交互阶段：${ctx.lastPsych.stageName}
客户心理状态：${ctx.lastPsych.stateName}
已使用的原理：${ctx.lastPsych.principleNames.join('、') || '未记录'}
客户给出的微承诺：${ctx.lastPsych.microCommit || '无'}
我的复盘：${ctx.lastPsych.note || '无'}
自检未通过项：${ctx.lastPsych.failedChecks.join('、') || '无'}` : '（还没有带心理维度的跟进记录，请先把最近一次沟通补上存档）'}

【会籍卡状态】
${ctx.cardLines || '（无卡）'}

【任务】
1. 基于上面的事实，判断他此刻真实的心理阻碍是什么。只能从数据推断，不要编造。
2. 选定这次沟通的目标阶段（建立安全感 / 探索需求 / 呈现方案 / 处理犹豫 / 促成 / 巩固），并说明为什么是这个阶段而不是下一个。
3. 设计一段可以直接用的对话，逐句标注用了哪个心理学原理：
   原理候选：动机式访谈 OARS、自主性支持、承诺一致性、损失厌恶、社会认同、互惠、峰终定律、目标梯度、选择架构、认知负荷削减、情绪标注、服务恢复。
4. 明确写出这次绝对不要做的 2 件事。
5. 给出这次要拿到的「微承诺」是什么（必须小到对方几乎不用思考）。

【输出格式】
真实阻碍（含依据）：
本次目标阶段与理由：
对话（逐句标注原理）：
本次禁忌 2 条：
要拿到的微承诺：

${COMMON_RULE}`,
  },
  {
    id: 'card',
    title: '会籍卡方案与续卡设计',
    icon: 'i-target',
    desc: '基于会员手上的卡（剩余课时 / 次数 / 到期日 / 余额）设计续卡或换卡方案。',
    needsMember: true,
    build: (ctx) => `你是健身房会籍产品顾问。请为这位会员设计续卡或换卡方案。

【会员档案】
${memberBlock(ctx.member, ctx.state)}

【他手上的卡】
${ctx.cardLines || '（没有卡记录）'}

【任务】
1. 算清他现在的"剩余价值"：还剩多少课时 / 多少次 / 多少余额 / 还有多久到期。用数字说话。
2. 指出最合适的动作是哪一种，并说明为什么：
   - 原卡续费 / 升级卡种 / 换卡种（例如次卡转期限卡）/ 加购私教课包 / 先不推，只做陪伴
3. 设计三档方案（基础 / 推荐 / 进阶），每档写清：内容、周期、价格区间、我该怎么解释价格。
4. 预测他会提的 4 个异议，每个给一句 30 字以内的应答。
5. 给出一个不会让他觉得被推销的开场句。

【输出格式】
剩余价值核算：
建议动作与理由：
三档方案：
异议预演：
开场句：

${COMMON_RULE}`,
  },
  {
    id: 'reflect',
    title: '交互复盘（心理学视角）',
    icon: 'i-doc',
    desc: '把最近的跟进记录按心理学框架复盘，找出自己话术里的问题。',
    needsMember: false,
    build: (ctx) => `你是我的销售沟通教练。请用心理学框架复盘我最近的交互记录，指出我自己没意识到的问题。

【最近交互存档】
${ctx.recentPsych.map((x) => `- ${x.date}｜${x.memberName}｜阶段：${x.stageName}｜客户状态：${x.stateName}｜原理：${x.principleNames.join('、') || '未记录'}｜结果：${x.result}\n  内容：${x.summary}\n  客户反馈：${x.feedback}\n  微承诺：${x.microCommit || '无'}\n  我的复盘：${x.note || '无'}\n  自检未过：${x.failedChecks.join('、') || '无'}`).join('\n') || '（最近 14 天没有带心理维度的记录）'}

【统计】
${ctx.metricLines}

【任务】
1. 找出我重复出现的 2 个沟通习惯（好的和坏的各一个），每个都要引用具体记录作为证据。
2. 指出我在哪个阶段最容易跳步（比如需求没探清就报价），并用数据说明后果。
3. 给我一段可直接照读的"下次改口"脚本，替换掉我原来的说法。
4. 列出 3 个我下周要刻意练习的动作。

【输出格式】
重复出现的习惯（好 / 坏，各带证据）：
最容易跳步的阶段与后果：
改口脚本：
下周刻意练习的 3 个动作：

${COMMON_RULE}`,
  },
  {
    id: 'tune',
    title: '自动化规则调优',
    icon: 'i-sync',
    desc: '把规则的命中与采纳数据交给 AI，让它建议阈值与优先级怎么调。',
    needsMember: false,
    build: (ctx) => `你是运营自动化顾问。下面是我这套销售工作台的自动化规则运行数据，请帮我判断怎么调。

【规则运行数据（近 30 天）】
${ctx.ruleLines}

【今天的运行结果】
命中 ${ctx.todayHits} 条，其中：
${ctx.todayHitLines}

【我的数据完整度】
${ctx.metricLines}
${ctx.connectorLines}

【任务】
1. 指出哪 2 条规则的阈值明显不合理（用命中率和采纳率说话）。
2. 建议新增 1 到 2 条规则，写清触发条件、动作、渠道、时机。要针对我当前的真实缺口，不要泛泛而谈。
3. 说明哪些规则依赖的数据还没接入，在数据补齐前不应该开启。
4. 给一个"如果只能改一条"的建议。

【输出格式】
阈值不合理的规则：
建议新增的规则：
暂不应开启的规则（含原因）：
只改一条的话：

${COMMON_RULE}`,
  },
  {
    id: 'weekly',
    title: '本周工作复盘',
    icon: 'i-doc',
    desc: '把本周的跟进、预约、线索数据整理成一份周复盘。',
    needsMember: false,
    build: (ctx) => `你是我的销售主管。请基于下面这周的真实记录，帮我做一份周复盘。

【本周跟进记录】
${ctx.weekFollowups.map((f) => `- ${f.date}｜${ctx.memberName(f.memberId)}｜${f.channel}｜${f.summary}｜反馈：${f.feedback}｜结果：${RESULT_LABEL[f.result] || f.result || '未记'}｜下一步：${f.nextAction}`).join('\n') || '无'}

【本周预约与结果】
${ctx.weekAppts.map((a) => `- ${a.date} ${a.time}｜${a.type}｜${ctx.memberName(a.memberId)}｜状态：${a.status}`).join('\n') || '无'}

【本周新增线索】
${ctx.weekLeads.map((l) => `- ${l.name}｜${l.source}｜意向 ${l.intent}｜状态 ${l.status}｜首响 ${l.firstResponseMin} 分钟`).join('\n') || '无'}

【本周智能体运行】
${ctx.agentLines}

【当前队列压力】
${ctx.queueSummary}

【任务】
1. 用数据总结本周做得好的 2 件事、做得差的 2 件事（每件都要有数字）。
2. 指出本周浪费时间的 1 个环节，给替代做法。
3. 列出下周必须清掉的 3 件积压事项，按优先级排序。
4. 给下周定一个可量化的单一重点目标。

【输出格式】
做得好的两件事：
做得差的两件事：
时间浪费点：
下周积压优先级：
下周唯一重点：

${COMMON_RULE}`,
  },
];

export const PACK_BY_ID = Object.fromEntries(PACKS.map((p) => [p.id, p]));
