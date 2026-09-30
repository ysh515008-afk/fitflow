/* ============================================================
   views/ops.js · 运营中心
   ------------------------------------------------------------
   上层分段（线上营销 / 线索池 / 社群管理）不是写死的：
   社群管理属于可选配功能，默认隐藏，装到「功能库」里才出现。
   判断统一走 features.js 的 isFeatureOn，视图里不另写一套开关逻辑，
   否则删掉一个模块要改三处，迟早漏一处。

   顶部有一条未读提醒滚动条。它只播报"今天真实发生过的事"，
   没有数据就明说没有，不拿 0 或者占位数字把界面填满。
   ============================================================ */
import {
  groupStats, campaignStats, setGroupPlanStatus, upsertGroupPlanItem,
  memberById, normalizeSource,
} from '../store.js';
import { badge, sectionTitle, emptyState, notice, statCard, cardHead } from '../components.js';
import { esc, fmtDate, today, relDay, daysBetween, sum, moneyFull, fmtPct, countBy, sortBy, avatarHtml } from '../util.js';
import { donutChart, barChart } from '../charts.js';
import {
  MONITOR_DIMS, fmtMetric, fmtCount, diffMetrics, trendOf, buildAdvice,
  pickBenchmarks, rankAccounts, estimateCost, CALL_PLAN,
  STORE_HEAT_ITEMS, AVAILABILITY_TONE,
  RANK_PERIOD_LABEL, BOARD_CAVEATS, myRankOnBoard, fastestRising,
} from '../douyin.js';
import { XHS_CAPABILITY_ITEMS, XHS_TONE, deriveXhsSummary, fmtXhsCount } from '../xhs.js';
import { isFeatureOn, countOn, ALL_FEATURES } from '../features.js';
import { buildBrief, unreadOf, readIdsOf, LEVEL_META } from '../opsBrief.js';
import {
  BIZ_METRIC_FIELDS, bizFunnel, sumBizRecords, metricDayCount,
  costPerOpen, FUNNEL_ORDER,
} from '../bizMetrics.js';
import { BIZ_SOURCE_LIST } from '../integrations/index.js';

export function title() { return '运营'; }

const LEAD_STATUS = {
  new: { label: '新线索', cls: 'b-info' },
  contacted: { label: '已触达', cls: 'b-teal' },
  booked: { label: '已预约', cls: 'b-info' },
  trial: { label: '体验中', cls: 'b-teal' },
  won: { label: '已成交', cls: 'b-green' },
  lost: { label: '已流失', cls: 'b-danger' },
};

/* ---------------- 分段（受功能开关控制） ---------------- */

/** 上层分段。去掉的前提是关掉了对应模块，不是写死的顺序表 */
function opsSegs(ctx) {
  return [
    { id: 'content', label: '线上营销', always: true },
    { id: 'leads', label: '线索池', always: true },
    { id: 'community', label: '社群管理', feature: 'ops.community' },
  ].filter((s) => s.always || isFeatureOn(ctx.state.features, s.feature));
}

/** 线上营销的二级分段，同样受功能开关控制 */
function contentSubs(ctx) {
  return [
    { id: 'douyin', label: '抖音账号', always: true },
    { id: 'xhs', label: '小红书', feature: 'ops.xhs' },
    { id: 'biz', label: '交易后台', feature: 'ops.biz' },
    { id: 'store', label: '门店热度', feature: 'ops.store' },
    { id: 'ledger', label: '内容台账', feature: 'ops.ledger' },
  ].filter((s) => s.always || isFeatureOn(ctx.state.features, s.feature));
}

/** 快照时间戳直接展示，不做日期解析：存的就是本地时间字符串，
    再 parse 一遍会引入时区歧义，可能显示成前一天。 */
const stampText = (s) => (s ? esc(String(s)) : '未同步');

export function render(ctx) {
  const segs = opsSegs(ctx);
  /* 关掉一个模块之后，地址栏可能还指着它。这里回落到第一个可用分段，
     而不是渲染一片空白让人以为页面坏了。 */
  const seg = segs.some((s) => s.id === ctx._opsSeg) ? ctx._opsSeg : segs[0].id;

  return `
  <div class="page-head">
    <h2>运营中心</h2>
    <p>公域内容带线索，私域社群接线索，最后都落到客户档案里</p>
  </div>
  ${briefBar(ctx)}
  <div class="seg" style="margin-bottom:14px">
    ${segs.map((s) => `<button data-oseg="${s.id}" class="${seg === s.id ? 'on' : ''}">${esc(s.label)}</button>`).join('')}
    <button class="seg-add" data-features aria-label="添加功能" title="功能库">
      <svg viewBox="0 0 24 24"><use href="#i-plus"/></svg>添加功能
    </button>
  </div>
  ${seg === 'community' ? communityView(ctx) : seg === 'leads' ? leadsView(ctx) : contentView(ctx)}`;
}

/* ============================================================
   未读提醒滚动条
   ------------------------------------------------------------
   三条规则：
     · 播报的每一句都能追到真实数据，没数据就明说没有
     · 只滚动未读的；全部读完之后变成一条安静的完成态，不再滚动
     · 「全部已读」就在条上，不用点进抽屉才能清掉
   ============================================================ */

function briefBar(ctx) {
  const brief = buildBrief(ctx.state);
  const unread = unreadOf(brief, readIdsOf(ctx.state));
  const readCount = brief.items.filter((x) => !x.placeholder).length - unread.length;
  const lines = unread.length ? unread : brief.items;

  return `
  <div class="brief ${unread.length ? 'unread' : 'clear'}" data-brief>
    <div class="brief-tag">
      <span class="brief-pulse" aria-hidden="true"></span>
      <b>${unread.length ? `${unread.length} 条未读` : '提醒已读完'}</b>
    </div>
    <div class="brief-view">
      <div class="brief-track" data-brief-track>
        ${lines.map((x) => `
          <div class="brief-line">
            <i class="brief-lv" style="background:${(LEVEL_META[x.level] || LEVEL_META.info).color}"></i>
            <span class="brief-text">${esc(x.text)}</span>
            <span class="brief-src">${esc(x.source)}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="brief-acts">
      ${unread.length ? `<button class="brief-btn" data-brief-read-all>全部已读</button>` : ''}
      <button class="brief-btn ghost" data-brief-open>${unread.length ? '逐条看' : `回顾 ${readCount} 条`}</button>
    </div>
  </div>`;
}

/* ============================================================
   线上营销：四块内容的容器
   ============================================================ */
function contentView(ctx) {
  const subs = contentSubs(ctx);
  const sub = subs.some((s) => s.id === ctx._contentSub) ? ctx._contentSub : subs[0].id;
  return `
  <div class="seg sub" style="margin-bottom:14px">
    ${subs.map((s) => `<button data-csub="${s.id}" class="${sub === s.id ? 'on' : ''}">${esc(s.label)}</button>`).join('')}
  </div>
  ${sub === 'biz' ? bizView(ctx)
    : sub === 'store' ? storeHeatView(ctx)
      : sub === 'ledger' ? ledgerView(ctx)
        : sub === 'xhs' ? xhsView(ctx)
          : douyinView(ctx)}`;
}

/* ============================================================
   社群（可选配模块，默认关闭）
   ============================================================ */
function communityView(ctx) {
  const s = groupStats();
  return `
  <div class="stat-grid g3" style="margin-bottom:14px">
    ${statCard({ k: '在管社群', v: s.count, unit: '个' })}
    ${statCard({ k: '覆盖人数', v: s.members, unit: '人' })}
    ${statCard({ k: '平均周活跃', v: Math.round(s.avgActive * 100) + '%' })}
  </div>
  ${s.risk ? notice(`有 ${s.risk} 个社群已经偏冷（超过 3 天没有有效内容）。群冷掉是渐进的，先把周内容日历排上。`, 'warn') : ''}

  ${ctx.state.groups.map((g) => {
    const tone = g.health === 'good' ? 'b-green' : g.health === 'quiet' ? 'b-warn' : 'b-danger';
    const toneText = { good: '活跃', quiet: '偏冷', risk: '预警' }[g.health] || g.health;
    const plan = g.weeklyPlan || [];
    const done = plan.filter((p) => p.status === 'done').length;
    return `<div class="card">
      ${cardHead(g.name, `${g.platform}｜${g.members} 人｜${esc(g.purpose)}`, `<span class="badge ${tone}">${toneText}</span>`)}
      <div class="between" style="margin-bottom:9px">
        <div class="small muted">最近更新 ${g.lastPostAt ? esc(relDay(g.lastPostAt)) : '无记录'}</div>
        <div class="small"><span class="muted">周活跃</span> <b>${Math.round(g.activeRate * 100)}%</b></div>
      </div>
      <div class="bar ${g.activeRate < 0.3 ? 'danger' : g.activeRate < 0.5 ? 'warn' : ''}"><i style="width:${Math.round(g.activeRate * 100)}%"></i></div>

      ${plan.length ? `
        <div class="divider"></div>
        <div class="between" style="margin-bottom:8px">
          <div class="small" style="font-weight:650">本周内容日历</div>
          <div class="small muted">${done}/${plan.length} 已完成</div>
        </div>
        ${plan.map((p, i) => `
          <div class="between" style="padding:6px 0;border-top:1px solid var(--line-2)">
            <div class="flex" style="min-width:0">
              <button class="check ${p.status === 'done' ? 'on' : ''}" data-plan="${g.id}:${i}" aria-label="切换完成状态">
                <svg viewBox="0 0 24 24"><use href="#i-check"/></svg>
              </button>
              <div style="min-width:0">
                <div style="font-size:12.5px;font-weight:600">${esc(p.day)} · ${esc(p.topic)}</div>
                <div class="small muted">${esc(p.owner || '')}</div>
              </div>
            </div>
            ${p.status === 'doing' ? badge('进行中', 'b-teal') : p.status === 'done' ? badge('已完成', 'b-green') : ''}
          </div>`).join('')}
      ` : `<div class="small muted" style="margin-top:9px">还没有排周内容日历。</div>`}

      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost sm" data-addplan="${g.id}">加一条内容</button>
        <button class="btn ghost sm" data-ai-community="1">AI 排一周内容</button>
      </div>
    </div>`;
  }).join('')}

  <div class="card tight">
    ${cardHead('社群 + 内容 的配合关系', '一个月度参考节奏')}
    <div class="timeline">
      <div class="tl-item on"><div class="tl-title">公域（抖音 / 小红书 / 视频号）</div><div class="tl-body">每周 3 条短视频 + 2 条图文，选题从会员真实顾虑里出</div></div>
      <div class="tl-item on"><div class="tl-title">私域（微信群 / 企业微信 / 粉丝群）</div><div class="tl-body">承接私信线索，用打卡和答疑维持到店动机</div></div>
      <div class="tl-item"><div class="tl-title">到店</div><div class="tl-body">体验课、体测、续费面谈，全部落进客户档案</div></div>
      <div class="tl-item"><div class="tl-title">回流</div><div class="tl-body">沉默会员与已过期会员单独走唤醒与回流路径</div></div>
    </div>
  </div>

  <div class="card tight" style="margin-top:13px">
    <div class="between" style="align-items:flex-start">
      <div style="min-width:0">
        <div class="small" style="font-weight:650">这个模块是可选配的</div>
        <div class="small muted" style="margin-top:3px;line-height:1.6">没有在运营微信群的话，去功能库把它移出导航，界面会清爽一些。数据不会删。</div>
      </div>
      <button class="btn ghost sm" data-features>功能库</button>
    </div>
  </div>`;
}

/* ============================================================
   交易后台（抖音来客 / 美团经营宝）
   ------------------------------------------------------------
   这一屏的重点是把两个平台的数据对齐到同一条漏斗，
   并且把"接口能不能接"如实写清楚。

   这块默认收在功能库里（features.js 的 ops.biz，defaultOn: false），
   原因是接入门槛：来客的开放能力清单里没有流量数据，
   美团的流量接口要品牌总部资质加业务经理签约。对单店来说短期接不通，
   摆在导航里只会让人以为没配好。

   收起的是位置，不是能力。下面这些一行都没删：
     · integrations/laike.js、integrations/meituan.js 的接口协议
       （端点清单、鉴权字段、授权入口、解决方案枚举、字段对应关系）
     · bizMetrics.js 的报表口径层
     · 本文件的 bizView / bizSourceCard / bizFunnelSection / bizDailyTable
     · sheets.js 的报表导入与接口清单两个抽屉
   重新在功能库里添加，这些原样回来。
   ============================================================ */
function bizView(ctx) {
  const records = ctx.state.biz?.records || [];
  const byId = (id) => records.filter((r) => r.source === id);

  return `
  ${notice('这一栏的数据来自<b>后台报表导入</b>，不是接口实时读数，报表导入不依赖任何授权。<br>'
    + '接口那边：来客可以自助接入（来客后台 → 店铺管理 → 服务应用授权 → 商家自研服务），'
    + '但开放能力清单里只有交易与履约，<b>曝光和开口这类流量数据取不到</b>，只能从后台导；'
    + '美团有完整的流量接口（服务零售 → 经营数据API），'
    + '但要用<b>品牌总部资质</b>申请且需业务经理签约，单店走不通。', 'warn', 'i-alert')}

  ${sectionTitle('接入状态', `${BIZ_SOURCE_LIST.length} 个交易后台`)}
  ${BIZ_SOURCE_LIST.map((s) => bizSourceCard(ctx, s, byId(s.id))).join('')}

  ${bizFunnelSection(records)}
  ${bizDailyTable(records)}
  ${bizSourceLogs(ctx)}

  <div class="card tight" style="margin-top:13px">
    <div class="between" style="align-items:flex-start">
      <div style="min-width:0">
        <div class="small" style="font-weight:650">这个模块是可选配的</div>
        <div class="small muted" style="margin-top:3px;line-height:1.6">
          短期不打算接平台接口的话，去功能库把它收起，导航会清爽一些。
          接口协议与已导入的记录都保留，重新添加就原样回来。
        </div>
      </div>
      <button class="btn ghost sm" data-features>功能库</button>
    </div>
  </div>`;
}

const BIZ_STATUS = {
  connected: { label: '已连接', cls: 'b-green' },
  pending: { label: '待授权', cls: 'b-warn' },
  unauthorized: { label: '未授权', cls: 'b-plain' },
  error: { label: '异常', cls: 'b-danger' },
};

/** 可得性的语气。和门店热度那套保持一致，不另造词 */
const BIZ_AVAIL = {
  /* 接口确实存在，字段也对得上，但单店拿不到资质 */
  'brand-required': { cls: 'b-warn', text: '需品牌资质' },
  'partner-required': { cls: 'b-warn', text: '需商家授权' },
  'no-public-api': { cls: 'b-danger', text: '无公开接口' },
  api: { cls: 'b-green', text: '接口可取' },
};

function bizSourceCard(ctx, src, recs) {
  const c = ctx.state.biz?.[src.id] || {};
  const st = BIZ_STATUS[c.status] || BIZ_STATUS.unauthorized;
  const avail = BIZ_AVAIL[src.availability] || BIZ_AVAIL['partner-required'];
  const days = metricDayCount(recs, 'impression');
  const last = recs.length ? sortBy(recs, (r) => r.date, 'desc')[0].date : null;

  return `<div class="card biz-card">
    <div class="between" style="align-items:flex-start;margin-bottom:10px">
      <div class="flex" style="min-width:0">
        <div class="conn-logo" style="background:linear-gradient(145deg,${src.logoFrom},${src.logoTo});color:#fff">${esc(src.logoText)}</div>
        <div style="min-width:0">
          <div style="font-size:14.5px;font-weight:650">${esc(src.name)}</div>
          <div class="small muted" style="margin-top:2px">${esc(src.vendor)}｜${esc(src.platform)}</div>
        </div>
      </div>
      <div style="flex:0 0 auto;display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end">
        <span class="badge ${avail.cls}">${esc(avail.text)}</span>
        <span class="badge ${st.cls}">${esc(st.label)}</span>
      </div>
    </div>

    <div class="small" style="line-height:1.7;color:var(--ink-2)">${esc(src.verdict)}</div>

    <div class="divider"></div>
    <div class="small" style="font-weight:650;margin-bottom:6px">接口能给到的</div>
    <div class="tag-row">${src.knownScope.map((x) => badge(x, 'b-plain')).join('')}</div>

    <div class="small" style="font-weight:650;margin:11px 0 6px">拿不到的，别指望</div>
    <div class="card tight" style="background:var(--surface-2)">
      ${src.notAvailable.map((x) => `<div class="na-row"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg><span>${esc(x)}</span></div>`).join('')}
    </div>

    <div class="divider"></div>
    <div class="kv"><div class="k">已在FitFlow 里</div><div class="v num">${recs.length ? `${days} 天记录，最近 ${esc(last)}` : '还没有导入任何记录'}</div></div>
    <div class="kv"><div class="k">最近导入</div><div class="v ${c.lastImportAt ? '' : 'muted'}">${esc(c.lastImportAt || '未发生')}</div></div>
    ${c.poiId ? `<div class="kv"><div class="k">门店标识</div><div class="v">${esc(c.poiId)}</div></div>` : ''}
    ${c.note ? `<div class="small muted" style="margin-top:8px;line-height:1.6">${esc(c.note)}</div>` : ''}

    <div class="btn-row" style="margin-top:11px">
      <button class="btn primary sm" data-biz-report="${src.id}">
        <svg viewBox="0 0 24 24"><use href="#i-upload"/></svg>导入后台报表</button>
      <button class="btn ghost sm" data-biz-detail="${src.id}">接口与核对清单</button>
    </div>
    <div class="hint" style="margin-top:8px">导出位置：${esc(src.reportSpec.where)}</div>
  </div>`;
}

/** 漏斗：缺的那一环显示「未获取」，不补 0，也不算比率 */
function bizFunnelSection(records) {
  const withData = records.filter((r) => FUNNEL_ORDER.some((k) => typeof r[k] === 'number'));
  if (!withData.length) {
    return `
    ${sectionTitle('经营漏斗', '两个平台合计')}
    <div class="card tight">
      <div class="small muted" style="line-height:1.75">
        还没有导入过报表。导入任意一天的记录之后，这里会算出
        曝光 → 访问 → 开口 → 下单 → 核销 五环，以及各环之间的转化率。
        缺哪一列就显示「未获取」，不会补 0 把比率算歪。
      </div>
    </div>`;
  }

  const agg = sumBizRecords(withData);
  const funnel = bizFunnel(agg);
  const cpo = costPerOpen(agg);
  const maxVal = Math.max(...funnel.map((f) => (typeof f.value === 'number' ? f.value : 0)), 1);

  return `
  ${sectionTitle('经营漏斗', `${withData.length} 天记录 · 两个平台合计`)}
  <div class="card">
    ${funnel.map((f) => {
      const miss = typeof f.value !== 'number';
      const w = miss ? 4 : Math.max((f.value / maxVal) * 100, 5);
      return `<div class="bf-row">
        <div class="bf-label">${esc(f.label)}</div>
        <div class="bf-bar-wrap">
          <div class="bf-bar ${miss ? 'miss' : ''}" style="width:${w.toFixed(1)}%"></div>
          ${f.rate != null ? `<span class="bf-conv">${(f.rate * 100).toFixed(1)}%</span>` : ''}
        </div>
        <div class="bf-value num ${miss ? 'miss' : ''}">${miss ? '未获取' : fmtCount(f.value)}</div>
      </div>`;
    }).join('')}
    <div class="divider"></div>
    <div class="stat-grid g3">
      ${statCard({ k: '曝光到开口', v: funnel[2].rate != null ? (funnel[2].rate * 100).toFixed(2) + '%' : '未获取', d: '整条链最值钱的一环' })}
      ${statCard({ k: '单开口成本', v: cpo == null ? '未获取' : '¥' + cpo, d: cpo == null ? '需要消耗与开口两列' : '投放消耗 ÷ 开口人数' })}
      ${statCard({ k: '下单未核销', v: (typeof agg.order === 'number' && typeof agg.redeem === 'number') ? agg.order - agg.redeem : '未获取', unit: '人', d: '买了没来，最容易约回来的一批' })}
    </div>
    <div class="hint" style="margin-top:9px;line-height:1.65">
      口径：曝光与访问是平台口径的去重人数，开口在来客叫私信开口、在经营宝叫咨询。
      两个平台的门店归属规则不同，连锁门店并表前要确认口径一致。
    </div>
  </div>`;
}

function bizDailyTable(records) {
  const rows = sortBy(records, (r) => r.date, 'desc').slice(0, 14);
  if (!rows.length) return '';

  return `
  ${sectionTitle('按日明细', `最近 ${rows.length} 天`)}
  <div class="card tight">
    <div class="tbl-scroll">
      <table class="tbl">
        <thead>
          <tr>
            <th>日期</th><th>来源</th>
            ${BIZ_METRIC_FIELDS.map((f) => `<th>${esc(f.label)}</th>`).join('')}
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `<tr>
            <td>${esc(fmtDate(r.date, 'md'))}</td>
            <td>${esc(r.source === 'laike' ? '来客' : r.source === 'meituan' ? '经营宝' : r.source)}</td>
            ${BIZ_METRIC_FIELDS.map((f) => {
              const v = r[f.key];
              return typeof v === 'number'
                ? `<td class="n">${esc(fmtCount(v))}</td>`
                : '<td class="n muted">未获取</td>';
            }).join('')}
            <td><button class="btn ghost sm" data-biz-del="${r.id}" aria-label="删除这条记录">删</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="hint" style="margin-top:8px;line-height:1.65">
      同一天可以分多次导入，后一次只覆盖它带了的列。所以流量看板和交易看板分两次导不会互相清空。
    </div>
  </div>`;
}

function bizSourceLogs(ctx) {
  const all = BIZ_SOURCE_LIST.flatMap((s) => (ctx.state.biz?.[s.id]?.logs || []).map((l) => ({ ...l, src: s.name })));
  if (!all.length) return '';
  const rows = sortBy(all, (l) => l.at || '', 'desc').slice(0, 6);
  return `
  ${sectionTitle('接入记录', `最近 ${rows.length} 条`)}
  <div class="card tight">
    ${rows.map((l) => `
      <div class="between log-row">
        <div class="flex" style="min-width:0;align-items:flex-start">
          <span class="dot ${l.ok ? 'ok' : 'bad'}"></span>
          <div style="min-width:0">
            <div class="small" style="line-height:1.55">${esc(l.message)}</div>
            <div class="small muted" style="margin-top:2px">${esc(l.src)} · ${esc(l.at)}</div>
          </div>
        </div>
      </div>`).join('')}
  </div>`;
}

/* ---------------- 线上营销 · 抖音账号 ---------------- */

function douyinView(ctx) {
  const dy = ctx.state.douyin || {};
  const b = dy.binding;
  const snap = dy.snapshot;
  const metrics = snap?.metrics || null;
  const diff = diffMetrics(metrics, dy.prevMetrics);
  const advice = buildAdvice(metrics, diff);

  return `
  ${b ? boundAccountCard(b, snap, ctx) : bindPromptCard()}
  ${snap?.isSample ? notice('下面这份是<b>示例快照</b>，只用来预览绑定之后的界面。绑定真实账号并同步一次，它会被真实数据替换，示例数据也会一起消失。', 'warn', 'i-alert') : ''}
  ${metrics ? metricBoard(metrics, diff) : ''}
  ${worksSection(snap)}
  ${adviceCard(advice)}
  ${boardSection(ctx)}
  ${benchmarkCard(ctx, metrics)}
  ${poolRankSection(ctx, metrics)}
  ${syncLogCard(dy.log)}
  ${callCostCard()}`;
}

/* ---------------- 官方赛道榜 ---------------- */

function boardSection(ctx) {
  const dy = ctx.state.douyin || {};
  const b = dy.board;
  const q = dy.boardQuery || { dateType: 'days', category: '身体锻炼' };
  const period = RANK_PERIOD_LABEL[b?.dateType || q.dateType] || '日榜';
  const mineRank = b ? myRankOnBoard(b, dy.binding?.uniqueName, dy.binding?.nickname) : null;
  const rising = b ? fastestRising(b, 1)[0] : null;

  const caveats = `
  <div class="card tight">
    <div class="small" style="font-weight:650;margin-bottom:8px">这个榜的边界（界面上必须写清，否则会被当成本地经营排名）</div>
    ${BOARD_CAVEATS.map((c) => `
      <div class="kv">
        <div class="k">${esc(c.label)}</div>
        <div class="v" style="font-weight:500;font-size:12px;line-height:1.6">${esc(c.text)}</div>
      </div>`).join('')}
  </div>`;

  if (!b) {
    return `
    ${sectionTitle('官方赛道榜', '按赛道取平台给的榜位')}
    <div class="card">
      <div class="small" style="line-height:1.75;color:var(--ink-2)">
        这是红狐<b>唯一返回官方榜位</b>的接口（响应里的 <code>accountRanking</code>）。榜位由抖音给出，我们原样显示、不做重排。<br>
        但要先说清：它<b>只能按赛道查，没有城市筛选</b>，而且口径是内容维度，不含曝光、转化、开口。
      </div>
      <button class="btn primary block" data-board style="margin-top:12px">
        <svg viewBox="0 0 24 24"><use href="#i-data"/></svg>选择赛道取榜</button>
    </div>
    ${caveats}`;
  }

  return `
  ${sectionTitle('官方赛道榜', `${esc(b.category)} · ${period} · ${esc(b.rankDate)}`)}
  ${b.isSample ? notice('这一期是<b>示例榜单</b>，用来预览取到榜之后的样子。真实榜单要走接口，一次一处调用。', 'warn', 'i-alert') : ''}

  <div class="card tight">
    <div class="board-head">
      <div style="min-width:0">
        <div class="small" style="font-weight:650">${esc(b.category)} ${period}</div>
        <div class="small muted" style="margin-top:2px">共 ${b.items.length} 条 · 取于 ${esc(b.at || '')}</div>
      </div>
      <button class="btn ghost sm" data-board>换一期</button>
    </div>
    <div class="divider"></div>
    ${b.items.map((x) => `
      <div class="board-row ${x.rank <= 3 ? 'top' : ''}">
        <div class="br-rank">${x.rank}</div>
        <div class="br-body">
          <div class="br-name">${esc(x.nickname || '未获取')}</div>
          <div class="br-meta">
            <span>粉丝 <b>${esc(fmtCount(x.followerCount))}</b></span>
            <span class="up">涨粉 ${esc(fmtCount(x.fansGrowth))}</span>
          </div>
          <div class="br-meta">
            <span>赞 ${esc(fmtCount(x.likedGrowth))}</span>
            <span>评 ${esc(fmtCount(x.commentsGrowth))}</span>
            <span>分享 ${esc(fmtCount(x.sharedGrowth))}</span>
          </div>
        </div>
        <div class="br-score num">${x.score == null ? '未获取' : x.score.toFixed(1)}<small>分</small></div>
      </div>`).join('')}
  </div>

  <div class="card tight">
    ${mineRank != null
      ? `<div class="small" style="line-height:1.7"><b class="num">本店账号在第 ${mineRank} 位。</b></div>`
      : `<div class="small" style="line-height:1.7;color:var(--ink-2)">
           <b>本店账号不在这一期榜上。</b>榜上共 ${b.items.length} 条，入榜的是百万粉级账号：门店账号 8 千粉进不了赛道 TOP50。
           所以这个榜回答不了「我排第几」，它回答的是「赛道头部在做什么」。
         </div>`}
    ${rising ? `<div class="small muted" style="margin-top:6px;line-height:1.65">这一期涨粉最快：<b style="color:var(--ink-2)">${esc(rising.nickname)}</b>（+${esc(fmtCount(rising.fansGrowth))}）</div>` : ''}
  </div>

  ${caveats}`;
}

function bindPromptCard() {
  return `
  <div class="card">
    ${cardHead('还没有绑定抖音账号', '绑定后智能体才开始监控', badge('未绑定', 'b-plain'))}
    <div class="small" style="line-height:1.75;color:var(--ink-2)">
      绑定需要三样东西，缺一样都取不到数：
    </div>
    <div class="req-list">
      <div class="req"><b>1</b><span>要监控的<b>抖音号</b>（不是昵称，昵称会重名）</span></div>
      <div class="req"><b>2</b><span>本地代理进程跑起来：<code>node server/proxy.mjs</code></span></div>
      <div class="req"><b>3</b><span>代理进程里配好 <code>REDFOX_API_KEY</code>，且账号有积分余额</span></div>
    </div>
    ${notice('密钥不经过浏览器。它只存在本地代理进程的环境变量里，前端只发抖音号。', 'info', 'i-key')}
    <button class="btn primary block" data-bind-douyin style="margin-top:12px">
      <svg viewBox="0 0 24 24"><use href="#i-plus"/></svg>绑定抖音账号</button>
  </div>`;
}

function boundAccountCard(b, snap, ctx) {
  const m = snap?.metrics || null;
  const acc = snap?.account || {};
  return `
  <div class="card">
    ${cardHead(b.nickname || b.uniqueName, `抖音号 ${esc(b.uniqueName)}｜绑定于 ${esc(b.boundAt || '')}`,
      badge(snap ? '已同步' : '待同步', snap ? 'b-green' : 'b-warn'))}
    <div class="acct-head">
      <div class="avatar av-a" style="width:46px;height:46px;font-size:19px">${esc((b.nickname || '?').trim()[0] || '?')}</div>
      <div style="min-width:0;flex:1">
        <div class="acct-meta">
          ${acc.region ? `<span>${esc(acc.region)}</span>` : ''}
          ${m?.sampleSize ? `<span>近 ${m.sampleSize} 条作品</span>` : ''}
          <span>上次同步 ${stampText(snap?.at)}</span>
        </div>
        ${acc.signature ? `<div class="small muted" style="margin-top:4px;line-height:1.5">${esc(acc.signature)}</div>` : ''}
      </div>
    </div>
    ${m ? `
      <div class="stat-grid" style="margin-top:11px">
        ${statCard({ k: '粉丝', v: m.followerCount == null ? '未获取' : m.followerCount.toLocaleString('zh-CN') })}
        ${statCard({ k: '作品', v: m.awemeCount == null ? '未获取' : m.awemeCount, unit: '条' })}
        ${statCard({ k: '累计获赞', v: m.totalFavorited == null ? '未获取' : (m.totalFavorited / 10000).toFixed(1) + '万' })}
        ${statCard({ k: '红狐指数', v: m.redfoxIndex == null ? '未获取' : m.redfoxIndex })}
      </div>` : `<div class="small muted" style="margin-top:10px;line-height:1.7">账号已绑定，但还没同步过数据。点下面的按钮跑一次，就知道红狐那边能不能取到数了。</div>`}
    <div class="btn-row" style="margin-top:12px">
      <button class="btn primary sm" data-sync-douyin>
        <svg viewBox="0 0 24 24"><use href="#i-sync"/></svg>立即同步</button>
      <button class="btn ghost sm" data-bind-douyin>监控设置</button>
    </div>
  </div>`;
}

/**
 * 作品明细：把每一条作品的抖音数据摊开看。
 * 上面那块指标板是"算出来的结论"，这块是"算出结论用的原始数据"，
 * 两个都摆出来，才看得出一条爆款把平均值拉高了多少。
 *
 * 爆款线沿用 douyin.js 里 hitRate 的同一条：播放超过自身均值 3 倍。
 * 不在这里另定一个标准，否则两处数字会对不上。
 *
 * @param {object} snap  快照（含 works 与 metrics）
 * @param {number} [limit] 最多显示几条
 */
export function worksSection(snap, limit = 8) {
  const ws = (snap?.works || []).filter(Boolean);
  if (!ws.length) return '';

  const m = snap.metrics || null;
  const line = typeof m?.avgPlay === 'number' ? m.avgPlay * 3 : null;
  const rows = [...ws]
    .sort((a, b) => String(b.createTime || '').localeCompare(String(a.createTime || '')))
    .slice(0, limit);

  return `
  ${sectionTitle('作品明细', `最近 ${rows.length} 条 · 抖音原始数据`)}
  <div class="card tight">
    ${rows.map((w) => {
      const hit = line != null && typeof w.playCount === 'number' && w.playCount > line;
      const cells = [
        ['播放', w.playCount], ['赞', w.diggCount], ['评', w.commentCount],
        ['分享', w.shareCount], ['收藏', w.collectCount],
      ].map(([k, v]) => `<span>${k} <b class="num">${v == null ? '未获取' : esc(fmtCount(v))}</b></span>`).join('');
      return `
      <div class="work-row">
        <div class="wr-top">
          <div class="wr-title">${esc(w.title || '未获取')}</div>
          ${hit ? badge('爆款', 'b-green') : ''}
        </div>
        <div class="wr-meta">${cells}</div>
        <div class="wr-time">${esc(w.createTime || '未获取')}</div>
      </div>`;
    }).join('')}
    <div class="small muted" style="margin-top:9px;line-height:1.65">
      爆款线是自身平均播放的 3 倍（当前 ${line == null ? '未获取' : esc(fmtCount(line))}），和指标板里的爆款率用的是同一条线。
      缺的字段标「未获取」，不补 0。
    </div>
  </div>`;
}

function metricBoard(m, diff) {
  return `
  ${sectionTitle('智能体在盯的指标', `${MONITOR_DIMS.length} 项 · 来自红狐账号维度与作品列表`)}
  <div class="card tight">
    <div class="metric-grid">
      ${MONITOR_DIMS.map((dim) => {
        const v = fmtMetric(dim, m[dim.key]);
        const miss = v === '未获取';
        const d = diff[dim.key];
        const tone = trendOf(dim, diff);
        /* 百分比类维度看相对变化，数量类维度看绝对增量。
           混着显示会出现"互动率 +0"这种看不出方向的数字。 */
        const text = !d ? ''
          : dim.format === 'pct'
            ? (d.pct == null ? '持平' : (d.pct >= 0 ? '+' : '') + (d.pct * 100).toFixed(0) + '%')
            : (d.delta === 0 ? '持平' : (d.delta > 0 ? '+' : '') + d.delta);
        return `<div class="metric-cell">
          <div class="mc-k">${esc(dim.label)}</div>
          <div class="mc-v num ${miss ? 'miss' : ''}">${esc(v)}${!miss && dim.unit && dim.format !== 'pct' ? `<small>${esc(dim.unit)}</small>` : ''}</div>
          <div class="mc-d ${tone}">${d ? esc(text || '持平') + ' 环比' : '无对比'}</div>
        </div>`;
      }).join('')}
    </div>
    <div class="divider"></div>
    <div class="small muted" style="line-height:1.7">
      标「未获取」的是红狐这次没返回的字段。播放量平台常常不给，缺了就按缺处理，不补 0 也不拿点赞顶替。
    </div>
  </div>`;
}

const ADVICE_LEVEL = {
  warn: { cls: 'b-warn', label: '要处理', bar: 'var(--warn)' },
  info: { cls: 'b-info', label: '可优化', bar: 'var(--info)' },
  good: { cls: 'b-green', label: '好信号', bar: 'var(--brand)' },
};

function adviceCard(advice) {
  return `
  ${sectionTitle('智能体的判断', advice.items.length ? `${advice.items.length} 条可执行建议` : '暂无')}
  ${advice.items.length ? `<div class="advice-list">
    ${advice.items.map((a) => {
      const L = ADVICE_LEVEL[a.level] || ADVICE_LEVEL.info;
      return `<div class="advice" style="border-left-color:${L.bar}">
        <div class="between" style="align-items:flex-start;margin-bottom:6px">
          <div style="font-size:13.5px;font-weight:650;line-height:1.45">${esc(a.title)}</div>
          ${badge(L.label, L.cls)}
        </div>
        <div class="small" style="line-height:1.65;color:var(--ink-2)"><span class="muted">依据</span> ${esc(a.detail)}</div>
        <div class="small" style="line-height:1.65;color:var(--ink-2);margin-top:5px"><span class="muted">动作</span> ${esc(a.action)}</div>
      </div>`;
    }).join('')}
  </div>` : `<div class="card tight"><div class="small muted" style="line-height:1.75">${esc(advice.reason)}</div></div>`}`;
}

function benchmarkCard(ctx, metrics) {
  const bm = ctx.state.douyin?.benchmarks;
  const items = bm?.items || [];
  if (!items.length || !metrics) {
    return `
    ${sectionTitle('对标账号', '按关键词搜索')}
    <div class="card tight">
      <div class="small muted" style="line-height:1.75">
        ${metrics ? '还没有跑过对标搜索。它按关键词搜同赛道账号，再按三条口径筛：体量同档（本店账号的 0.5 到 5 倍）、红狐指数更高、同地区。' : '先同步自己的账号，有了粉丝数与指数当基准，才筛得出有意义的对标。没有基准去挑对标，挑出来的一定是最大的那几个，学不了。'}
      </div>
    </div>`;
  }
  const picked = pickBenchmarks(items, metrics);

  return `
  ${sectionTitle('对标账号', `${picked.length} 个 · 关键词「${esc(bm.keyword || '')}」`)}
  ${bm.isSample ? notice('这几个对标账号是<b>示例</b>，不是搜出来的。真实候选要走关键词搜账号接口。', 'warn', 'i-alert') : ''}
  <div class="list">
    ${picked.map((c) => `
      <div class="list-item static">
        ${avatarHtml(c.nickname || c.remoteId)}
        <div class="li-body">
          <div class="li-top">
            <span class="li-name">${esc(c.nickname || c.remoteId)}</span>
            ${badge(c.followerCount >= (metrics.followerCount || 0) ? '体量更大' : '体量相近', 'b-plain')}
          </div>
          <div class="li-meta">
            <span>粉丝 ${c.followerCount == null ? '未获取' : c.followerCount.toLocaleString('zh-CN')}</span>
            ${c.redfoxIndex != null ? `<span>指数 ${c.redfoxIndex}</span>` : ''}
            ${c.region ? `<span>${esc(c.region)}</span>` : ''}
          </div>
          ${c.reasons.map((r) => `<div class="reason"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg>${esc(r)}</div>`).join('')}
        </div>
      </div>`).join('')}
  </div>`;
}

/**
 * 自有账号池排名。
 * 和上面的官方赛道榜是两个完全不同的东西，所以标题必须写明口径：
 *   · 榜单来源是我们自己抓到的账号（本店 + 对标），不是平台榜
 *   · 口径是我们定的（粉丝数），换个指标排名就变
 * 混在一起说会让使用者以为自己的榜位是官方的。
 */
function poolRankSection(ctx, metrics) {
  const dy = ctx.state.douyin || {};
  const items = dy.benchmarks?.items || [];

  if (!metrics?.followerCount) {
    return `
    ${sectionTitle('自有账号池排名', '本地口径 · 含本店账号')}
    <div class="card tight">
      <div class="small muted" style="line-height:1.75">
        需要先同步本店账号，才有基准参与排名。这个榜的范围只有我们抓到的账号，不是平台榜。
      </div>
    </div>`;
  }

  const pool = [
    { nickname: dy.binding?.nickname || '本店账号', followerCount: metrics.followerCount, redfoxIndex: metrics.redfoxIndex, isMine: true },
    ...items,
  ];
  const ranked = rankAccounts(pool, 'followerCount');

  return `
  ${sectionTitle('自有账号池排名', `本地口径 · 粉丝数 · ${ranked.length} 个账号`)}
  <div class="card tight">
    ${ranked.map((r) => `
      <div class="between rank-row">
        <div class="flex" style="min-width:0">
          <span class="rank-no ${r.rank <= 3 ? 'top' : ''}">${r.rank}</span>
          <span style="font-size:13px;font-weight:${r.isMine ? '700' : '500'};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.nickname || r.remoteId)}${r.isMine ? '（本店）' : ''}</span>
        </div>
        <span class="num small">${r.followerCount.toLocaleString('zh-CN')}</span>
      </div>`).join('')}
    <div class="small muted" style="margin-top:9px;line-height:1.65">
      这个榜是我们自己排的，不是抖音官方榜位。范围只含已纳入监控的账号，口径是粉丝数，换成互动中位数排名就会变。
      要看官方榜位，用上面的赛道榜。
    </div>
  </div>`;
}

function syncLogCard(log) {
  const rows = (log || []).slice(0, 5);
  if (!rows.length) return '';
  return `
  ${sectionTitle('同步记录', `最近 ${rows.length} 次`)}
  <div class="card tight">
    ${rows.map((x) => `
      <div class="between log-row">
        <div class="flex" style="min-width:0;align-items:flex-start">
          <span class="dot ${x.ok ? 'ok' : 'bad'}"></span>
          <div style="min-width:0">
            <div class="small" style="line-height:1.55">${esc(x.message)}</div>
            <div class="small muted" style="margin-top:2px">${esc(x.at)}</div>
          </div>
        </div>
      </div>`).join('')}
  </div>`;
}

function callCostCard() {
  const full = estimateCost(CALL_PLAN.items.map((i) => i.key));
  const min = estimateCost(['account', 'works']);
  return `
  ${sectionTitle('取数成本', '红狐按次计价')}
  <div class="card tight">
    ${CALL_PLAN.items.map((i) => `
      <div class="between cost-row">
        <div style="min-width:0">
          <div style="font-size:12.5px;font-weight:600">${esc(i.label)}</div>
          <div class="small muted" style="margin-top:2px;line-height:1.5">${esc(i.desc)}</div>
        </div>
        <div class="num small" style="flex:0 0 auto;text-align:right">${i.credits} 积分</div>
      </div>`).join('')}
    <div class="divider"></div>
    <div class="small" style="line-height:1.75">
      只同步账号与作品：<b class="num">${min.calls} 次 / ${min.credits} 积分</b>，按官网下限价约 <b class="num">¥${min.moneyFloor}</b>。<br>
      四项全开：<b class="num">${full.calls} 次 / ${full.credits} 积分</b>，约 <b class="num">¥${full.moneyFloor}</b>。
    </div>
    <div class="hint" style="margin-top:8px;line-height:1.65">${esc(CALL_PLAN.note)}</div>
  </div>`;
}

/* ---------------- 线上营销 · 门店热度 ---------------- */

function storeHeatView(ctx) {
  const dy = ctx.state.douyin || {};
  const manual = dy.storeHeat?.manual || [];
  const byKind = Object.fromEntries(manual.map((x) => [x.kind, x]));
  const metrics = dy.snapshot?.metrics || null;

  /* 只留下能自己算出数的类目。
     标记 manualOnly 的那几项，数只能靠手工登记才出得来（storeHeat.manual
     目前只有 upsertStoreHeatManual 一个写入方，接口不回填），
     没登记时一律是「未获取」，摆在页面上只是占位，所以不在本区显示。
     口径本身没有被删掉，逐项依据仍写在 js/douyin.js 的 STORE_HEAT_ITEMS。 */
  const visible = STORE_HEAT_ITEMS.filter((it) => !it.manualOnly);
  const hidden = STORE_HEAT_ITEMS.filter((it) => it.manualOnly);
  const hiddenReason = (it) => (it.availability === 'unavailable'
    ? '接口没有这一项，只能手工登记'
    : '只能靠关键词近似召回，命中不代表真的挂了门店定位');

  return `
  ${notice('这一区只显示能自己算出数的类目。需要手工登记的几项已经不在这里显示了：它们没有接口来源，登记之前永远是「未获取」，摆着只是占位。', 'info', 'i-alert')}
  <div class="heat-list">
    ${visible.map((it) => heatCard(it, byKind[it.key], ctx)).join('')}
  </div>
  ${hidden.length ? `
  <div class="card tight" style="margin-top:12px">
    <div class="small" style="font-weight:650;color:var(--ink-2)">已不显示的类目 · ${hidden.length} 项</div>
    <div class="small muted" style="margin-top:7px;line-height:1.8">
      ${hidden.map((it) => `<div>${esc(it.label)}：${esc(hiddenReason(it))}</div>`).join('')}
    </div>
    <div class="small muted" style="margin-top:7px;line-height:1.65">这 ${hidden.length} 项的取数依据没有被推翻，只是没有自动来源，等接口开放或有登记需求时再放回来。</div>
  </div>` : ''}
  ${heatRankSection(ctx, metrics)}`;
}

function heatCard(item, rec, ctx) {
  const tone = AVAILABILITY_TONE[item.availability] || AVAILABILITY_TONE.unavailable;
  /* 口径统一读 manualOnly 一个字段，不在视图里再拿 availability 猜一遍 */
  const needManual = !!item.manualOnly;

  let body;
  if (item.key === 'accountRank') {
    body = `<div class="small muted" style="line-height:1.6">排名明细见下方，范围只含已纳入监控的账号。</div>`;
  } else if (rec) {
    const main = item.key === 'poiBadge'
      ? `<div class="heat-num num">${rec.count ?? 0}<small>条</small></div>
         <div class="heat-sub">绿标 ${rec.green ?? 0} · 白标 ${rec.white ?? 0}</div>`
      : `<div class="heat-num num">${rec.count ?? 0}<small>${item.key === 'poiWorks' ? '条' : '条评论'}</small></div>`;
    body = `${main}
      ${rec.keywords ? `<div class="heat-sub">关键词：${esc(rec.keywords)}</div>` : ''}
      ${rec.detail ? `<div class="small muted" style="margin-top:6px;line-height:1.6">${esc(rec.detail)}</div>` : ''}
      <div class="heat-sub" style="margin-top:6px">登记于 ${esc(rec.at || '')}</div>`;
  } else {
    body = `<div class="heat-num num miss">未获取</div>
      <div class="small muted" style="margin-top:4px;line-height:1.55">${item.availability === 'approximate' ? '还没跑过关键词召回' : '还没有手工登记'}</div>`;
  }

  return `<div class="card heat-card">
    <div class="between" style="align-items:flex-start;margin-bottom:9px">
      <div style="min-width:0">
        <div style="font-size:14px;font-weight:650">${esc(item.label)}</div>
        <div class="small muted" style="margin-top:3px">来源：${esc(item.source)}</div>
      </div>
      <span class="badge ${tone.cls}">${esc(tone.text)}</span>
    </div>
    ${body}
    <div class="divider"></div>
    <div class="small muted" style="line-height:1.65"><b style="color:var(--ink-2)">为什么：</b>${esc(item.basis)}</div>
    <div class="small muted" style="line-height:1.65;margin-top:5px"><b style="color:var(--ink-2)">怎么拿：</b>${esc(item.way)}</div>
    ${needManual ? `<button class="btn ghost sm block" data-heat="${item.key}" style="margin-top:10px">${rec ? '修改登记' : '手工登记'}</button>` : ''}
  </div>`;
}

function heatRankSection(ctx, metrics) {
  const dy = ctx.state.douyin || {};
  const items = dy.benchmarks?.items || [];
  if (!metrics?.followerCount) {
    return `
    ${sectionTitle('自有账号池排名', '本地口径')}
    <div class="card tight">
      <div class="small muted" style="line-height:1.75">需要先同步本店账号，才有基准参与排名。排名是本地算的，不是平台榜单。</div>
    </div>`;
  }
  const pool = [
    { nickname: dy.binding?.nickname || '本店账号', followerCount: metrics.followerCount, redfoxIndex: metrics.redfoxIndex, isMine: true },
    ...items,
  ];
  const ranked = rankAccounts(pool, 'followerCount');
  return `
  ${sectionTitle('自有账号池排名', `本地口径 · 粉丝数 · ${ranked.length} 个账号`)}
  <div class="card tight">
    ${ranked.map((r) => `
      <div class="between rank-row">
        <div class="flex" style="min-width:0">
          <span class="rank-no ${r.rank <= 3 ? 'top' : ''}">${r.rank}</span>
          <span style="font-size:13px;font-weight:${r.isMine ? '700' : '500'};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.nickname || r.remoteId)}${r.isMine ? '（本店）' : ''}</span>
        </div>
        <span class="num small">${r.followerCount.toLocaleString('zh-CN')}</span>
      </div>`).join('')}
    <div class="small muted" style="margin-top:9px;line-height:1.65">
      口径写在标题上，是因为换个指标排名就会变。想扩大范围，得先用关键词搜账号接口补充候选。
    </div>
  </div>`;
}

/* ---------------- 线上营销 · 小红书 ---------------- */

function xhsView(ctx) {
  const x = ctx.state.xhs || {};
  const b = x.binding;
  const notes = x.notes || [];
  const sum = deriveXhsSummary(notes);
  const line = sum.avgRead == null ? null : sum.avgRead * 3;

  return `
  ${notice('这一栏和抖音那栏的取数能力不一样，先说清楚：红狐<b>没有</b>小红书账号维度接口，粉丝数与笔记数只能登记；'
    + '「小红书搜索」和「小红书爆款笔记库」在红狐能力范围内，但端点还没登记进项目，所以暂时不取数，也不假装能取。', 'warn', 'i-alert')}

  ${b ? xhsAccountCard(b, sum) : `
    <div class="card">
      ${cardHead('还没有登记小红书号', '登记后这一栏才开始有数', badge('未登记', 'b-plain'))}
      <div class="small" style="line-height:1.75;color:var(--ink-2)">
        红狐目前没有小红书账号维度接口，所以登记不是"授权取数"，只是把你自己的账号信息记在这里，
        让笔记台账有个归属。取不到数的部分界面会一直标「未获取」，不会拿别的数字顶替。
      </div>
      <button class="btn primary block" data-xhs-bind style="margin-top:12px">
        <svg viewBox="0 0 24 24"><use href="#i-plus"/></svg>登记小红书号</button>
    </div>`}

  ${xhsCapabilityCard()}

  ${notes.length ? `
  ${sectionTitle('笔记台账', `${notes.length} 条 · 登记值`)}
  <div class="card tight">
    ${[...notes].sort((a, c) => String(c.publishedAt || '').localeCompare(String(a.publishedAt || ''))).map((n) => {
      const hit = line != null && isFinite(n.readCount) && n.readCount > line;
      return `
      <div class="work-row" data-xhs-edit="${esc(n.id || '')}" role="button" tabindex="0" title="点开修改这条登记">
        <div class="wr-top">
          <div class="wr-title">${esc(n.title || '未获取')}</div>
          ${hit ? badge('爆款', 'b-green') : ''}
        </div>
        <div class="wr-meta">
          ${n.format ? `<span>${esc(n.format)}</span>` : ''}
          ${[['阅读', n.readCount], ['赞', n.likeCount], ['藏', n.collectCount], ['评', n.commentCount], ['分享', n.shareCount]]
            .map(([k, v]) => `<span>${k} <b class="num">${v == null ? '未获取' : esc(fmtCount(v))}</b></span>`).join('')}
          ${n.leads != null ? `<span>线索 <b class="num">${esc(String(n.leads))}</b></span>` : ''}
        </div>
        <div class="wr-time">${esc(n.publishedAt || '未获取')}</div>
      </div>`;
    }).join('')}
    <div class="small muted" style="margin-top:9px;line-height:1.65">
      爆款线是自身平均阅读的 3 倍（当前 ${line == null ? '未获取' : esc(fmtCount(line))}）。缺的字段标「未获取」，不补 0。
    </div>
  </div>` : `
  ${sectionTitle('笔记台账', '还没有登记')}
  <div class="card tight">
    <div class="small muted" style="line-height:1.75">
      一条笔记一行：标题、发布日期、阅读、赞、藏、评、带来几条线索。
      发布后隔一天再记数字，当天记的数字还会涨，记早了会偏低。
    </div>
  </div>`}

  ${b ? `<button class="btn primary block" data-xhs-note style="margin-top:12px">
    <svg viewBox="0 0 24 24"><use href="#i-plus"/></svg>登记一条笔记</button>` : ''}
  ${x.updatedAt ? `<div class="small muted" style="text-align:center;margin-top:12px">最近登记 ${esc(x.updatedAt)}</div>` : ''}`;
}

function xhsAccountCard(b, sum) {
  return `
  <div class="card">
    ${cardHead(b.nickname || b.uniqueName, `小红书号 ${esc(b.uniqueName)}｜登记于 ${esc(b.boundAt || '')}`,
      badge('登记值', 'b-warn'))}
    <div class="acct-head">
      <div class="avatar av-a" style="width:46px;height:46px;font-size:19px">${esc((b.nickname || '?').trim()[0] || '?')}</div>
      <div style="min-width:0;flex:1">
        <div class="acct-meta">
          <span>笔记 ${sum.noteCount} 条（登记）</span>
          <span>近 30 天 ${sum.recent30} 条</span>
        </div>
        ${b.note ? `<div class="small muted" style="margin-top:4px;line-height:1.5">${esc(b.note)}</div>` : ''}
      </div>
    </div>
    <div class="stat-grid" style="margin-top:11px">
      ${statCard({ k: '粉丝', v: b.followerCount == null ? '未获取' : b.followerCount.toLocaleString('zh-CN'), d: '登记值，接口取不到' })}
      ${statCard({ k: '账号笔记数', v: b.noteCount == null ? '未获取' : b.noteCount, unit: '条', d: '登记值' })}
      ${statCard({ k: '平均阅读', v: sum.avgRead == null ? '未获取' : fmtCount(sum.avgRead), d: `${sum.readSample} 条有阅读数` })}
      ${statCard({ k: '带来线索', v: sum.leads, unit: '条' })}
    </div>
    <div class="stat-grid" style="margin-top:9px">
      ${statCard({ k: '平均赞', v: sum.avgLike == null ? '未获取' : fmtCount(sum.avgLike) })}
      ${statCard({ k: '平均收藏', v: sum.avgCollect == null ? '未获取' : fmtCount(sum.avgCollect) })}
      ${statCard({ k: '平均评论', v: sum.avgComment == null ? '未获取' : fmtCount(sum.avgComment) })}
      ${statCard({ k: '爆款率', v: sum.hitRate == null ? '未获取' : Math.round(sum.hitRate * 100) + '%', d: sum.hitRate == null ? '有阅读数的笔记不足 5 条，不报' : '阅读超均值 3 倍' })}
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn ghost sm" data-xhs-bind>修改登记</button>
    </div>
  </div>`;
}

/** 三项能力逐项标出来：能取什么、取不到什么、为什么 */
function xhsCapabilityCard() {
  return `
  ${sectionTitle('这一栏能取到什么', '逐项标出，不混着说')}
  <div class="card tight">
    ${XHS_CAPABILITY_ITEMS.map((it) => {
      const tone = XHS_TONE[it.availability] || XHS_TONE.unavailable;
      return `
      <div style="padding:9px 0;border-bottom:1px solid var(--line-2)">
        <div class="between" style="align-items:flex-start">
          <div class="small" style="font-weight:650;line-height:1.5">${esc(it.label)}</div>
          ${badge(tone.text, tone.cls)}
        </div>
        <div class="small muted" style="margin-top:4px;line-height:1.6">来源：${esc(it.source)}</div>
        <div class="small muted" style="margin-top:4px;line-height:1.65"><b style="color:var(--ink-2)">为什么：</b>${esc(it.basis)}</div>
        <div class="small muted" style="margin-top:3px;line-height:1.65"><b style="color:var(--ink-2)">怎么拿：</b>${esc(it.way)}</div>
      </div>`;
    }).join('')}
  </div>`;
}

/* ---------------- 线上营销 · 内容台账 ---------------- */

function ledgerView(ctx) {
  const s = campaignStats();
  const byPlatform = countBy(ctx.state.campaigns, (c) => c.platform);
  const platformItems = Object.entries(byPlatform).map(([k, v], i) => ({
    label: k, value: v, color: ['#0E8F5B', '#2C6BA8', '#0F7A8C', '#C4862B', '#8A9A93'][i % 5],
  }));
  const top = sortBy(ctx.state.campaigns, (c) => c.dmLeads + c.formLeads, 'desc').slice(0, 5);

  return `
  <div class="stat-grid" style="margin-bottom:14px">
    ${statCard({ k: '近 30 天内容', v: s.count, unit: '条' })}
    ${statCard({ k: '总曝光', v: s.views >= 10000 ? (s.views / 10000).toFixed(1) + '万' : s.views })}
    ${statCard({ k: '带来线索', v: s.leads, unit: '条', d: `私信 ${s.dmLeads} + 表单 ${s.formLeads}` })}
    ${statCard({ k: '投放花费', v: s.spend ? moneyFull(s.spend) : '0', d: s.spend ? `每条线索成本约 ${moneyFull(Math.round(s.spend / Math.max(s.leads, 1)))}` : '纯自然流量' })}
  </div>

  ${notice('这一栏是手工登记的，和「抖音账号」那栏的自动取数是两套账。两边数字对不上不是 bug，是口径不同：这里记的是你愿意记的内容，那里是接口返回的全量作品。', 'info', 'i-doc')}

  ${sectionTitle('线索贡献排行', '按私信 + 表单合计')}
  <div class="card">
    ${barChart({ items: top.map((c) => ({ label: c.platform, value: c.dmLeads + c.formLeads })), highlight: 0, height: 140 })}
    <div class="legend"><span><i style="background:var(--brand)"></i>线索最多的内容</span><span><i style="background:#BBD9C9"></i>其余</span></div>
    <div class="divider"></div>
    ${top.map((c) => `<div class="between" style="padding:7px 0;border-bottom:1px solid var(--line-2)">
      <div style="min-width:0">
        <div style="font-size:12.5px;font-weight:650;line-height:1.45">${esc(c.title)}</div>
        <div class="small muted" style="margin-top:3px">${esc(c.platform)}｜播放 ${c.views > 10000 ? (c.views / 10000).toFixed(1) + '万' : c.views}｜赞 ${c.likes}</div>
      </div>
      <div style="text-align:right;flex:0 0 auto">
        <div class="num" style="font-size:15px;font-weight:750">${c.dmLeads + c.formLeads}</div>
        <div class="small muted">线索</div>
      </div>
    </div>`).join('')}
  </div>

  ${sectionTitle('渠道结构', `${platformItems.length} 个平台`)}
  <div class="card tight">
    ${donutChart({ items: platformItems, size: 150, centerLabel: '内容条数', centerValue: String(s.count) })}
    <div class="legend" style="justify-content:center">
      ${platformItems.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.label)} ${p.value}</span>`).join('')}
    </div>
  </div>

  ${sectionTitle('内容明细', `${ctx.state.campaigns.length} 条`)}
  <div class="list">
    ${ctx.state.campaigns.map((c) => `
      <button class="list-item" data-campaign="${c.id}">
        <div class="li-body">
          <div class="li-top"><span class="li-name" style="font-size:13.5px;line-height:1.45">${esc(c.title)}</span></div>
          <div class="li-meta">
            <span>${esc(c.platform)}</span><span>${esc(c.format)}</span><span>${fmtDate(c.publishedAt, 'md')}</span>
            <span>播放 ${c.views >= 10000 ? (c.views / 10000).toFixed(1) + '万' : c.views}</span>
            <span>线索 ${c.dmLeads + c.formLeads}</span>
          </div>
        </div>
        <div class="li-right">${badge(c.status, c.status === '进行中' ? 'b-teal' : 'b-plain')}</div>
      </button>`).join('')}
  </div>
  <button class="btn primary block" data-act="new-campaign" style="margin-top:12px"><svg viewBox="0 0 24 24"><use href="#i-plus"/></svg>登记一条内容</button>`;
}

/* ---------------- 线索池 ---------------- */
function leadsView(ctx) {
  const leads = sortBy(ctx.state.leads, (l) => l.createdAt, 'desc');
  const byStatus = countBy(leads, (l) => l.status);
  const avgResp = leads.filter((l) => l.firstResponseMin != null);
  const slow = leads.filter((l) => (l.firstResponseMin || 0) > 30).length;

  return `
  <div class="stat-grid g3" style="margin-bottom:14px">
    ${statCard({ k: '线索总数', v: leads.length, unit: '条' })}
    ${statCard({ k: '平均首响', v: avgResp.length ? Math.round(sum(avgResp, (l) => l.firstResponseMin) / avgResp.length) : '-', unit: '分钟' })}
    ${statCard({ k: '超 30 分钟', v: slow, unit: '条', d: '首响越慢转化越低' })}
  </div>

  ${sectionTitle('漏斗状态', '本地记录 · 即时统计')}
  <div class="card tight">
    <div class="chips">
      ${Object.entries(LEAD_STATUS).map(([k, v]) => byStatus[k] ? `<span class="badge ${v.cls}">${esc(v.label)} ${byStatus[k]}</span>` : '').join('')}
    </div>
    <div class="divider"></div>
    <div class="small muted" style="line-height:1.65">
      「即时」指的是每录一条、每改一次状态，这里的计数立刻跟着变；<b>不是说它连着平台的实时接口</b>。
      线索池只统计本地记录到的线索：一条一条录入，或从内容台账带过来。
      三体 / 勤鸟里的到店客流要等接口授权后才会并进来；抖音、小红书的私信咨询目前没有接口可取，
      那一环的数字以导入的后台报表为准。
    </div>
  </div>

  ${sectionTitle('线索明细', `${leads.length} 条`)}
  <div class="list">
    ${leads.map((l) => {
      const st = LEAD_STATUS[l.status] || LEAD_STATUS.new;
      const days = -daysBetween(today(), l.createdAt);
      const resp = l.firstResponseMin;
      return `<button class="list-item" data-lead="${l.id}">
        ${avatarHtml(l.name)}
        <div class="li-body">
          <div class="li-top">
            <span class="li-name">${esc(l.name)}</span>
            ${badge(st.label, st.cls)}
            ${l.intent === 'A' ? badge('A 级意向', 'b-green') : ''}
          </div>
          <div class="li-meta">
            <span>${esc(l.source)}</span>
            <span>${days === 0 ? '今天进来' : days + ' 天前'}</span>
            <span style="color:${resp > 30 ? 'var(--danger)' : 'inherit'}">首响 ${resp != null ? resp + ' 分钟' : '未记录'}</span>
          </div>
          ${l.lostReason ? `<div class="li-meta" style="color:var(--danger)">流失原因：${esc(l.lostReason)}</div>` : ''}
        </div>
        <svg class="chev" viewBox="0 0 24 24"><use href="#i-chev"/></svg>
      </button>`;
    }).join('')}
  </div>
  <button class="btn primary block" data-act="new-lead" style="margin-top:12px"><svg viewBox="0 0 24 24"><use href="#i-plus"/></svg>录入一条线索</button>`;
}

/* ============================================================
   未读提醒的滚动
   ------------------------------------------------------------
   每一行高度固定，靠 track 的 translateY 整行滚动，不用 CSS 跑马灯：
   中文长句横向滚动根本来不及看，纵向换行才是能读的节奏。

   计时器存在模块级变量里。视图重渲染会换掉 DOM 节点，
   每次挂载都先清掉上一个计时器，否则反复切换分段会越积越多，
   最后看到好几十个计时器一起推同一行。
   ============================================================ */
let briefTimer = null;

function startBriefTicker(root) {
  clearInterval(briefTimer);
  briefTimer = null;
  const track = root.querySelector('[data-brief-track]');
  if (!track || track.children.length < 2) return;

  let i = 0;
  briefTimer = setInterval(() => {
    /* 每拍都重新取节点：期间可能已经重渲染过，闭包里的引用会失效 */
    const live = document.querySelector('[data-brief-track]');
    if (!live || !document.body.contains(live)) {
      clearInterval(briefTimer);
      briefTimer = null;
      return;
    }
    i = (i + 1) % live.children.length;
    live.style.transform = `translateY(-${i * 100}%)`;
  }, 3800);
}

export function mount(root, ctx) {
  startBriefTicker(root);

  /* 地址栏可能还指着已经被收起的模块（比如 #ops/community）。
     render 里已经回落到可用分段，这里把状态也校正过来，
     否则 syncHash 会把失效的分段又写回地址栏，刷新一次就跳一次。 */
  const segs = opsSegs(ctx);
  if (!segs.some((s) => s.id === ctx._opsSeg)) ctx._opsSeg = segs[0].id;
  /* 二级分段同理：交易后台被收起时不能停在那一栏上 */
  if (ctx._opsSeg === 'content') {
    const subs = contentSubs(ctx);
    if (!subs.some((s) => s.id === ctx._contentSub)) ctx._contentSub = subs[0].id;
  }

  root.addEventListener('click', (e) => {
    const seg = e.target.closest('[data-oseg]');
    if (seg) {
      ctx._opsSeg = seg.dataset.oseg;
      ctx.syncHash && ctx.syncHash();
      ctx.refresh();
      return;
    }

    const csub = e.target.closest('[data-csub]');
    if (csub) {
      ctx._contentSub = csub.dataset.csub;
      ctx.syncHash && ctx.syncHash();
      ctx.refresh();
      return;
    }

    /* 未读提醒：先判按钮再判整条，否则点「全部已读」会连带打开抽屉 */
    if (e.target.closest('[data-brief-read-all]')) return ctx.readAllBrief();
    if (e.target.closest('[data-brief-open]')) return ctx.openBrief();
    if (e.target.closest('[data-brief]')) return ctx.openBrief();

    /* 功能库：导航上有入口，模块空态里也有，两个入口走同一个抽屉 */
    if (e.target.closest('[data-features]')) return ctx.openFeatures();

    /* 交易后台 */
    const rep = e.target.closest('[data-biz-report]');
    if (rep) return ctx.openBizReport(rep.dataset.bizReport);
    const det = e.target.closest('[data-biz-detail]');
    if (det) return ctx.openBizDetail(det.dataset.bizDetail);
    const del = e.target.closest('[data-biz-del]');
    if (del) return ctx.deleteBizRecord(del.dataset.bizDel);

    const plan = e.target.closest('[data-plan]');
    if (plan) {
      const [gid, i] = plan.dataset.plan.split(':');
      const g = ctx.state.groups.find((x) => x.id === gid);
      const cur = g.weeklyPlan[Number(i)].status;
      const next = cur === 'todo' ? 'doing' : cur === 'doing' ? 'done' : 'todo';
      setGroupPlanStatus(gid, Number(i), next);
      ctx.refresh();
      return;
    }

    const add = e.target.closest('[data-addplan]');
    if (add) return ctx.openGroupPlanForm(add.dataset.addplan);

    if (e.target.closest('[data-ai-community]')) return ctx.openAi('community', null);

    /* 抖音账号 */
    if (e.target.closest('[data-bind-douyin]')) return ctx.openDouyinBind();
    if (e.target.closest('[data-sync-douyin]')) return ctx.syncDouyin();
    /* 取榜要走接口，先开抽屉选榜期与赛道，别直接把请求打出去 */
    if (e.target.closest('[data-board]')) return ctx.openTopBoard();

    /* 门店热度手工登记。入口随类目一起收起（storeHeatView 只渲染非手工项），
       这里先留着不删：登记能力本身还在，改回显示时不用重新接线。 */
    const heat = e.target.closest('[data-heat]');
    if (heat) return ctx.openStoreHeat(heat.dataset.heat);

    /* 小红书：账号登记 / 笔记登记 */
    if (e.target.closest('[data-xhs-bind]')) return ctx.openXhsBind();
    if (e.target.closest('[data-xhs-note]')) return ctx.openXhsNote();
    const xn = e.target.closest('[data-xhs-edit]');
    if (xn) return ctx.openXhsNote(xn.dataset.xhsEdit);

    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'new-campaign') return ctx.openCampaignForm();
      if (act.dataset.act === 'new-lead') return ctx.openLeadForm();
      return;
    }

    const c = e.target.closest('[data-campaign]');
    if (c) return ctx.openCampaignForm(c.dataset.campaign);

    const l = e.target.closest('[data-lead]');
    if (l) return ctx.openLeadForm(l.dataset.lead);
  });
}
