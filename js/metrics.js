/* ============================================================
   metrics.js · 业务指标计算
   原则：能从FitFlow 真实数据算的就算，算不出来的标明"填报值"，
        绝不用示例数据冒充分析结论。
   ============================================================ */
import { today, daysBetween, sortBy, sum, avg, ratio } from './util.js';
import { getProvider } from './integrations/index.js';

export function computeMetrics(s) {
  const members = s.members || [];
  const base = (s.metrics && s.metrics.baseline) || {};
  const h = (s.history && s.history[s.history.length - 1]) || { leads: 0, trials: 0, deals: 0, revenue: 0 };
  const goal = (s.goals && s.goals[0]) || { targetRevenue: 0 };

  /* ---- 跟进达标率 ---- */
  const pool = members.filter((m) => ['lead', 'trial', 'active', 'renewing', 'silent'].includes(m.stage));
  const recent = pool.filter((m) => {
    const f = sortBy(s.followups.filter((x) => x.memberId === m.id), (x) => x.date, 'desc')[0];
    if (!f) return false;
    const n = -daysBetween(today(), f.date);
    return n <= 7;
  });
  const followRate = ratio(recent.length, pool.length);

  /* ---- 需求诊断覆盖率 ---- */
  const diagnosed = members.filter((m) => (m.goals || []).length && (m.concerns || []).length && (m.intents || []).length);
  const diagnoseRate = ratio(diagnosed.length, members.length);

  /* ---- 到店频次 ---- */
  const activeList = members.filter((m) => (m.visits30 || 0) > 0);
  const visitFreq = avg(activeList, (m) => m.visits30);

  /* ---- 内容线索 ---- */
  const campaigns = s.campaigns || [];
  const contentLeads = sum(campaigns, (c) => (c.dmLeads || 0) + (c.formLeads || 0));
  const dmLeads = sum(campaigns.filter((c) => ['朋友圈', '私域'].includes(c.platform)), (c) => (c.dmLeads || 0) + (c.formLeads || 0));

  /* ---- 首响 ---- */
  const responded = (s.leads || []).filter((l) => l.firstResponseMin != null);
  const firstResponse = avg(responded, (l) => l.firstResponseMin);

  /* ---- 转介绍占比 ---- */
  const referralLeads = (s.leads || []).filter((l) => l.source === '转介绍').length;
  const referralRate = ratio(referralLeads, (s.leads || []).length);

  /* ---- 社群活跃 ---- */
  const groups = s.groups || [];
  const groupActive = avg(groups, (g) => g.activeRate);

  /* ---- 主用对接方的接口核对进度 ---- */
  const primaryId = (s.connectors && s.connectors.primary) || 'santi';
  const conn = (s.connectors && s.connectors[primaryId]) || {};
  const prov = getProvider(primaryId);
  const specs = Object.entries(prov?.endpointSpec || {});
  const readyCount = specs.filter(([k, e]) => conn.endpointsVerified?.[k] ?? e.verified).length;
  const mappingReady = ratio(readyCount, specs.length);

  /* ---- 目标达成 ---- */
  const goalRate = ratio(goal.actualRevenue || 0, goal.targetRevenue || 1);

  const fill = (key) => {
    const b = base[key];
    return b ? { value: b.value, unit: b.unit, note: b.note, source: '填报' } : { value: null, unit: '', note: '暂无数据，请在指标页填报', source: '缺' };
  };

  const calc = (value, unit, note, digits = 1) => ({ value, unit, note, source: '计算', digits });

  const M = {
    followRate: calc(followRate, '%', `${recent.length}/${pool.length} 位会员在 7 天内有过跟进`, 0),
    diagnoseRate: calc(diagnoseRate, '%', `${diagnosed.length}/${members.length} 位会员已写清目标·顾虑·需求`, 0),
    visitFreq: calc(visitFreq, '次/月', `${activeList.length} 位活跃会员近 30 天平均到店`, 1),
    trialRate: calc(ratio(h.deals, h.trials), '%', `本月 ${h.deals} 单成交 ÷ ${h.trials} 人次体验`, 1),
    quoteRate: calc(ratio(h.deals, h.trials), '%', '暂未单独记录报价次数，以「体验→成交」近似', 1),
    planRate: fill('planRate'),
    renewRate: fill('renewRate'),
    wakeRate: fill('wakeRate'),
    groupActive: calc(groupActive, '%', `${groups.length} 个社群的平均周活跃率`, 0),
    referralRate: calc(referralRate, '%', `${referralLeads} 条转介绍 ÷ ${(s.leads || []).length} 条线索`, 0),
    contentLeads: calc(contentLeads, '条', `近 30 天 ${campaigns.length} 条内容的私信 + 表单线索合计`, 0),
    dmLeads: calc(dmLeads, '条', '朋友圈与私域活动带来的咨询', 0),
    activityRoi: fill('activityRoi'),
    firstResponse: calc(firstResponse, '分钟', `${responded.length} 条线索的平均首次响应时长`, 0),
    leadConv: calc(ratio(h.deals, h.leads), '%', `本月 ${h.deals} 单成交 ÷ ${h.leads} 条线索`, 1),
    goalRate: calc(goalRate, '%', `目标 ¥${(goal.targetRevenue || 0).toLocaleString('zh-CN')}，当前完成 ¥${(goal.actualRevenue || 0).toLocaleString('zh-CN')}`, 1),
    ltvCac: fill('ltvCac'),
    onboardingDays: fill('onboardingDays'),
    dataSyncRate: calc(mappingReady, '%', `${prov?.name || primaryId} 的 ${readyCount}/${specs.length} 个接口端点已用官方文档核对`, 0),
  };

  // 统一格式化
  Object.values(M).forEach((m) => {
    if (m.value == null) { m.text = '-'; return; }
    if (m.unit === '%') m.text = (m.value * 100).toFixed(m.digits ?? 0) + '%';
    else if (m.unit === '倍') m.text = m.value.toFixed(1) + '倍';
    else m.text = m.value.toFixed(m.digits ?? 0) + ' ' + m.unit;
  });

  return M;
}

/** 指标看板用：把关键指标整理成分组 */
export function metricGroups(M) {
  return [
    {
      title: '线索与转化',
      items: [
        { k: 'leadConv', label: '线索 → 成交' },
        { k: 'trialRate', label: '体验 → 成交' },
        { k: 'firstResponse', label: '平均首响' },
        { k: 'contentLeads', label: '内容线索' },
      ],
    },
    {
      title: '会员与留存',
      items: [
        { k: 'renewRate', label: '续费率' },
        { k: 'wakeRate', label: '唤醒回店率' },
        { k: 'visitFreq', label: '月均到店' },
        { k: 'followRate', label: '7 天跟进达标' },
        { k: 'diagnoseRate', label: '需求诊断覆盖' },
        { k: 'referralRate', label: '转介绍占比' },
      ],
    },
    {
      title: '经营与效率',
      items: [
        { k: 'goalRate', label: '目标达成' },
        { k: 'groupActive', label: '社群活跃' },
        { k: 'dmLeads', label: '私域咨询' },
        { k: 'activityRoi', label: '活动 ROI' },
        { k: 'ltvCac', label: 'LTV / CAC' },
        { k: 'onboardingDays', label: '新人首单周期' },
        { k: 'dataSyncRate', label: '字段映射就绪' },
      ],
    },
  ];
}
