/* ============================================================
   views/analytics.js · 经营数据
   目标、趋势、来源、指标、对接状态：五块拼成一张经营仪表盘
   ============================================================ */
import { sourceBreakdown, memberById, normalizeSource } from '../store.js';
import { badge, sectionTitle, emptyState, notice, statCard, cardHead } from '../components.js';
import { esc, fmtMoney, moneyFull, sum, sortBy, fmtDate, today, daysBetween } from '../util.js';
import { lineChart, barChart, progressRing, donutChart, funnelHtml } from '../charts.js';
import { metricGroups } from '../metrics.js';
import { PROVIDER_LIST } from '../integrations/index.js';

export function title() { return '数据'; }

const STATUS_TEXT = {
  connected: { label: '已连接', cls: 'b-green' },
  pending: { label: '待授权', cls: 'b-warn' },
  unauthorized: { label: '未授权', cls: 'b-plain' },
  error: { label: '异常', cls: 'b-danger' },
};

export function render(ctx) {
  const s = ctx.state;
  const M = ctx.metrics;
  const goal = s.goals[0];
  const rate = goal.targetRevenue ? goal.actualRevenue / goal.targetRevenue : 0;
  const hist = s.history;
  const latest = hist[hist.length - 1];
  const prev = hist[hist.length - 2] || latest;
  const delta = prev.revenue ? (latest.revenue - prev.revenue) / prev.revenue : 0;

  /* 目标反推：按当前转化率算本月还差多少动作量 */
  const trialRate = latest.trials ? latest.deals / latest.trials : 0.35;
  const leadRate = latest.leads ? latest.deals / latest.leads : 0.12;
  const needRev = Math.max(0, goal.targetRevenue - goal.actualRevenue);
  const avgDeal = latest.deals ? latest.revenue / latest.deals : 8600;
  const needDeals = needRev ? Math.ceil(needRev / avgDeal) : 0;
  const needTrials = trialRate ? Math.ceil(needDeals / trialRate) : 0;
  const needLeads = leadRate ? Math.ceil(needDeals / leadRate) : 0;
  const daysLeft = Math.max(1, daysBetween(today(), goal.month + '-30') > 0
    ? new Date(Number(goal.month.slice(0, 4)), Number(goal.month.slice(5, 7)), 0).getDate() - Number(today().slice(8, 10))
    : 1);

  const src = sourceBreakdown();
  const srcColors = ['#0E8F5B', '#2C6BA8', '#0F7A8C', '#C4862B', '#8A9A93', '#B0553A'];
  const srcItems = src.map((x, i) => ({ label: x.source, value: x.total, color: srcColors[i % srcColors.length] }));

  return `
  <div class="page-head">
    <h2>经营数据</h2>
    <p>目标达成、转化漏斗、来源结构、指标口径，以及各系统的对接状态</p>
  </div>

  ${s.isDemo ? `<div class="demo-banner"><svg viewBox="0 0 24 24"><use href="#i-alert"/></svg><div style="flex:1">以下数字来自<strong>示例数据</strong>。换成你门店的真实数据后口径不变。</div></div>` : ''}

  ${sectionTitle(`${goal.label}业绩目标`, `完成度 ${(rate * 100).toFixed(1)}%`)}
  <div class="card">
    <div class="flex" style="gap:16px;align-items:center">
      ${progressRing({ value: rate, size: 116, label: `目标 ${fmtMoney(goal.targetRevenue)}`, display: (rate * 100).toFixed(0) + '%' })}
      <div style="flex:1;min-width:0">
        <div class="kv" style="padding-top:0"><div class="k">已达成</div><div class="v num">${moneyFull(goal.actualRevenue)}</div></div>
        <div class="kv"><div class="k">缺口</div><div class="v num" style="color:var(--danger)">${moneyFull(needRev)}</div></div>
        <div class="kv"><div class="k">剩余天数</div><div class="v num">${daysLeft} 天</div></div>
      </div>
    </div>

    <div class="divider"></div>
    <div class="small" style="font-weight:650;margin-bottom:9px">按当前转化率反推，接下来要补的动作量</div>
    <div class="stat-grid g3">
      ${statCard({ k: '还需成交', v: needDeals, unit: '单' })}
      ${statCard({ k: '还需体验', v: needTrials, unit: '人' })}
      ${statCard({ k: '还需线索', v: needLeads, unit: '条' })}
    </div>
    <div class="hint" style="margin-top:8px">按客单 ${fmtMoney(avgDeal)}、体验转化 ${(trialRate * 100).toFixed(0)}%、线索转化 ${(leadRate * 100).toFixed(0)}% 推算。每天需要触达约 ${Math.ceil(needLeads / daysLeft)} 条新线索。</div>

    <div class="divider"></div>
    <div class="small" style="font-weight:650;margin-bottom:9px">收入结构</div>
    ${goal.breakdown.map((b) => {
      const r = b.target ? b.actual / b.target : 0;
      return `<div style="margin-bottom:9px">
        <div class="between" style="margin-bottom:4px">
          <span class="small">${esc(b.name)}</span>
          <span class="small num"><b>${moneyFull(b.actual)}</b> <span class="muted">/ ${moneyFull(b.target)}</span></span>
        </div>
        <div class="bar ${r < 0.6 ? 'danger' : r < 0.85 ? 'warn' : ''}"><i style="width:${Math.min(100, r * 100).toFixed(1)}%"></i></div>
      </div>`;
    }).join('')}
  </div>

  ${sectionTitle('转化漏斗', '本月')}
  <div class="card tight">
    ${funnelHtml(ctx.funnel())}
    <div class="hint" style="margin-top:9px">曝光取内容播放量合计；线索 / 体验 / 成交取本月汇总；已触达、已预约取本地实时明细。</div>
  </div>

  ${sectionTitle('近 6 个月业绩', `本月较上月 ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`)}
  <div class="card tight">
    ${lineChart({ points: hist.map((h) => ({ label: h.label, value: h.revenue })), formatter: (v) => (v / 10000).toFixed(1) + '万', height: 156 })}
    <div class="divider"></div>
    ${barChart({ items: hist.map((h) => ({ label: h.label, value: h.deals })), highlight: hist.length - 1, height: 128 })}
    <div class="legend"><span><i style="background:var(--brand)"></i>本月成交单数</span><span><i style="background:#BBD9C9"></i>历史月份</span></div>
  </div>

  ${sectionTitle('来源结构', '会员 + 线索合计')}
  <div class="card tight">
    ${srcItems.length ? donutChart({ items: srcItems, size: 152, centerLabel: '客户总数', centerValue: String(sum(src, (x) => x.total)) }) : emptyState('还没有来源数据')}
    <div class="legend" style="justify-content:center">
      ${srcItems.map((x) => `<span><i style="background:${x.color}"></i>${esc(x.label)} ${x.value}</span>`).join('')}
    </div>
    <div class="divider"></div>
    <div class="tbl-scroll">
      <table class="tbl">
        <thead><tr><th>来源</th><th>客户数</th><th>已成会员</th><th>贡献金额</th></tr></thead>
        <tbody>
          ${src.map((x) => `<tr>
            <td>${esc(x.source)}</td>
            <td class="n">${x.total}</td>
            <td class="n">${x.members}</td>
            <td class="n">${x.paid ? fmtMoney(x.paid) : '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>

  ${sectionTitle('指标看板', '标注来源，不含糊')}
  ${metricGroups(M).map((g) => `
    <div class="card tight">
      ${cardHead(g.title, '')}
      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr><th>指标</th><th>当前值</th><th>来源</th></tr></thead>
          <tbody>
            ${g.items.map((it) => {
              const m = M[it.k];
              return `<tr>
                <td>${esc(it.label)}</td>
                <td class="n">${esc(m.text)}</td>
                <td>${m.source === '计算' ? badge('系统计算', 'b-green') : m.source === '填报' ? badge('手工填报', 'b-warn') : badge('待补', 'b-plain')}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="hint" style="margin-top:8px">${esc(g.items.map((it) => `${it.label}：${M[it.k].note}`).join('；'))}</div>
    </div>`).join('')}

  ${sectionTitle('业务系统对接', '三体 / 勤鸟')}
  ${PROVIDER_LIST.map((p) => {
    const c = s.connectors[p.id];
    const st = STATUS_TEXT[c.status] || STATUS_TEXT.unauthorized;
    const specs = Object.entries(p.endpointSpec);
    const ready = specs.filter(([k, e]) => c.endpointsVerified?.[k] ?? e.verified).length;
    return `<div class="conn" data-conn="${p.id}" style="cursor:pointer">
      <div class="conn-hd">
        <div class="conn-logo" style="background:linear-gradient(145deg,${p.logoFrom},${p.logoTo})">${esc(p.logoText)}</div>
        <div style="flex:1;min-width:0">
          <div class="nm">${esc(p.name)}</div>
          <div class="vd">${esc(p.vendor)}</div>
        </div>
        <span class="badge ${st.cls}">${st.label}</span>
      </div>
      <div class="conn-body">
        <div class="kv"><div class="k">接口核对</div><div class="v">${ready} / ${specs.length} 个端点已核对</div></div>
        <div class="kv"><div class="k">最近同步</div><div class="v ${c.lastSyncAt ? '' : 'muted'}">${esc(c.lastSyncAt || '未发生')}</div></div>
        <div class="kv"><div class="k">兜底通道</div><div class="v">${esc(p.fallback)}</div></div>
      </div>
    </div>`;
  }).join('')}

  ${notice('对接部分只显示真实状态。接口没授权就写「待授权」，字段拿不到就写「未获取」，不会用推测值把界面填满。', 'info', 'i-alert')}

  ${sectionTitle('数据管理', '导入导出')}
  <div class="card">
    <div class="btn-row">
      <button class="btn ghost" data-act="export"><svg viewBox="0 0 24 24"><use href="#i-download"/></svg>导出全部数据</button>
      <button class="btn ghost" data-act="import"><svg viewBox="0 0 24 24"><use href="#i-upload"/></svg>导入数据表</button>
    </div>
    <div class="hint" style="margin-top:9px">导出的 JSON 含全部会员与跟进记录，可用于备份或迁移。导入支持三体 / 勤鸟导出的表格（CSV、TSV，直接粘贴也行）。</div>
  </div>`;
}

export function mount(root, ctx) {
  root.addEventListener('click', (e) => {
    const c = e.target.closest('[data-conn]');
    if (c) return ctx.openConnector(c.dataset.conn);
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'export') return ctx.exportData();
      if (act.dataset.act === 'import') return ctx.openImport();
    }
  });
}
