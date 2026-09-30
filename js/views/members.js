/* ============================================================
   views/members.js · 客户管理（四栏重组）
   ------------------------------------------------------------
   四栏共用同一份 state.members 数据：

   第一栏 客户总览  —— 门店总会员池 / 个人会员池 / 近 30 天新增 / 待过期
   第二栏 客户维护  —— 剩余额度 >20% 会员、运动频率监控、频率下降预警、
                        周期提醒运动（可设间隔）、会员效果档案、体测仪预留接口
   第三栏 客户跟进  —— 所有客户跟进，密集卡片 + 简单概要，按优先级自动排序
                        （跟进后优先级变动 → 重渲染即实时换位）
   第四栏 客户池统计 —— 门店客流 / 会员数量 / 注册客户量 / 个人成交率 / 门店成交率

   约定：默认注册 = 到店客户（source 默认为 walkin），搜索只命中本地数据包。
   ============================================================ */
import {
  searchMembers, expiry, activity, latestFollowup, renewalOf, renewalBuckets, churnBuckets,
  upcomingAppointments, memberById, originOf, STAGES, APPT_STATUS, cardsOfMember,
  setExerciseReminder, setFreqDropAlert, addBodyAnalyzer, connectorById, pendingReachOf,
} from '../store.js';
import { CARD_TYPES, CARD_STATUS, cardStatus, cardUrgency, cardProgress, cardSummary } from '../data/membership.js';
import { dueBadge, motionTags, silentBadge, motionOf } from '../outreach.js';
import { badge, stageBadge, sectionTitle, emptyState, notice, statCard, cardHead, openSheet, toast, field } from '../components.js';
import { esc, avatarHtml, fmtDate, relDay, today, d, daysBetween, moneyFull, fmtMoney, sortBy, sum } from '../util.js';

export function title() { return '客户'; }

/* ============================================================
   工具：口径函数（全部确定性，绝不靠"多半/可能"推断）
   ============================================================ */

/** 门店总池 / 个人池 / 近 30 天新增 / 待过期 / 已登记流失池 */
function poolStats(s, advisor) {
  /* 已登记流失的人不计入在册池：池子回答的是"现在手上有多少人"，
     流失的人另有流失会员池单独出数，不混进在册分母。 */
  const members = s.members.filter((m) => !m.lost);
  const storePool = members.length;
  const personalPool = members.filter((m) => (m.owner || '') === advisor).length;
  const new30 = members.filter((m) => {
    if (!m.createdAt) return false;
    const dd = daysBetween(m.createdAt, today());
    return dd >= 0 && dd <= 30;
  }).length;
  const rb = renewalBuckets();
  const expiring = rb.urgent.length + rb.upcoming.length;
  /* 流失会员池：已登记流失的人数，单独成池，不进在册统计 */
  const lostPool = (s.members || []).filter((m) => m.lost).length;
  return { storePool, personalPool, new30, expiring, lostPool };
}

/**
 * 客户池排序：在册在前，已登记流失的一律置底。
 * 流失的档案仍然留在池子里可查（灰显），只是不再参与在册口径与智能体待办。
 */
function poolOrdered(s) {
  const all = s.members || [];
  const live = all.filter((m) => !m.lost);
  const lost = all.filter((m) => m.lost);
  return [...live, ...lost];
}

/** 任意名单里把已登记流失的排到最后（置底） */
const sortLostLast = (arr) => [...arr.filter((m) => !m.lost), ...arr.filter((m) => m.lost)];

/* ============================================================
   月度序列工具（趋势图 / 环比 / 个人 vs 门店 共用）
   ------------------------------------------------------------
   全部从本地数据包按月聚合得出，没有任何一项是推算值：
   某个月在明细里没有记录，那个月的计数就是 0，不向前填充、不做平滑。
   ============================================================ */
const pad2 = (v) => String(v).padStart(2, '0');

/** 近 n 个自然月（末位为当月），返回 [{key:'YYYY-MM',label:'9月'}] */
function monthWindow(n = 6) {
  const out = [];
  const base = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(base.getFullYear(), base.getMonth() - i, 1);
    out.push({ key: `${x.getFullYear()}-${pad2(x.getMonth() + 1)}`, label: `${x.getMonth() + 1}月` });
  }
  return out;
}

/** 把一组 {ym, memberId, w} 落成「门店线条 + 个人线条」双序列 */
function toSeries(win, rows, mine) {
  const keys = win.map((w) => w.key);
  const store = keys.map(() => 0);
  const personal = keys.map(() => 0);
  rows.forEach(({ ym, memberId, w = 1 }) => {
    const i = keys.indexOf(ym);
    if (i < 0) return;                       // 窗口外的月份直接丢弃，不参与统计
    store[i] += w;
    if (memberId && mine.has(memberId)) personal[i] += w;
  });
  return { keys, labels: win.map((w) => w.label), store, personal };
}

/** 由会员自身字段派生的月度序列：pick(m) => [{ym, w}] */
function memberSeries(s, advisor, pick) {
  const members = s.members.filter((m) => !m.lost);
  const mine = new Set(members.filter((m) => (m.owner || '') === advisor).map((m) => m.id));
  const rows = [];
  members.forEach((m) => pick(m).forEach(({ ym, w = 1 }) => rows.push({ ym, memberId: m.id, w })));
  return toSeries(monthWindow(6), rows, mine);
}

/** 由事件表（跟进 / 预约）派生的月度序列 */
function eventSeries(s, advisor, arr, memberKey) {
  const members = s.members.filter((m) => !m.lost);
  const mine = new Set(members.filter((m) => (m.owner || '') === advisor).map((m) => m.id));
  const rows = (arr || []).map((x) => ({ ym: (x.date || '').slice(0, 7), memberId: x[memberKey], w: 1 }));
  return toSeries(monthWindow(6), rows, mine);
}

/** y 轴上取整到好看的刻度 */
function niceCeil(v) {
  if (!v) return 1;
  if (v <= 5) return Math.max(1, Math.ceil(v));
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / (mag / 2)) * (mag / 2);
}

const fmtNum = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(v < 10 ? 1 : 0));

/**
 * 纯函数折线图（内联 SVG，无第三方图表库）。
 * 两条序列：门店 store / 个人 personal；最多同时画，便于直接对比。
 */
function lineChartSVG({ labels, series }) {
  const W = 600, H = 190, pl = 38, pr = 14, pt = 12, pb = 26;
  const n = labels.length;
  const all = series.flatMap((x) => x.values);
  const max = niceCeil(Math.max(0, ...all));
  const iw = W - pl - pr, ih = H - pt - pb;
  const X = (i) => (n <= 1 ? pl + iw / 2 : pl + (iw * i) / (n - 1));
  const Y = (v) => pt + ih * (1 - v / max);

  const grid = [];
  for (let g = 0; g <= 4; g++) {
    const val = (max / 4) * g;
    const y = Y(val);
    grid.push(
      `<line x1="${pl}" y1="${y.toFixed(1)}" x2="${W - pr}" y2="${y.toFixed(1)}" stroke="rgba(128,128,128,.22)" stroke-width="1"/>` +
      `<text x="${pl - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="currentColor" opacity=".62">${fmtNum(val)}</text>`
    );
  }
  const paths = series.map((s) => {
    const pts = s.values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    const dots = s.values.map((v, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3" fill="${s.color}"/>`).join('');
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join('');
  const xLabels = labels.map((l, i) =>
    `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="currentColor" opacity=".62">${esc(l)}</text>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="lc-svg" style="width:100%;height:auto;display:block">${grid.join('')}${paths}${xLabels}</svg>`;
}

/**
 * 环比文案。上月为 0 时不算百分比 —— 用 0 当分母得出的涨跌幅没有意义，
 * 这里如实回退成「上月无记录」，不用虚假的百分比充数。
 */
function momText(cur, prev) {
  if (prev === 0) {
    return cur === 0
      ? { label: '本月与上月均无记录', color: 'var(--muted)', arrow: '' }
      : { label: `上月无记录，本月 ${cur}`, color: 'var(--muted)', arrow: '↑' };
  }
  const dd = Math.round(((cur - prev) / prev) * 100);
  if (dd > 0) return { label: `环比 +${dd}%（上月 ${prev}）`, color: '#0A6E46', arrow: '↑' };
  if (dd < 0) return { label: `环比 ${dd}%（上月 ${prev}）`, color: '#B3402E', arrow: '↓' };
  return { label: `环比持平（上月 ${prev}）`, color: 'var(--muted)', arrow: '' };
}

/** 客户池统计：全部基于本地数据包，定义写在 UI 提示里 */
function statsCalc(s, advisor) {
  const members = s.members.filter((m) => !m.lost);
  const storeFootfall = sum(members, (m) => m.visits30 || 0);          // 门店客流 = 近 30 天到店总人次
  const paid = (arr) => arr.filter((m) => (m.totalPaid || 0) > 0).length;
  const memberCount = paid(members);                                    // 会员数量 = 已成交会员
  const regCount = members.length;                                      // 注册客户量 = 全部在册客户
  const personal = members.filter((m) => (m.owner || '') === advisor);
  const personalRate = personal.length ? Math.round((paid(personal) / personal.length) * 100) : 0;
  const storeRate = regCount ? Math.round((memberCount / regCount) * 100) : 0;

  /* ---- 月度趋势（门店线 / 个人线）---- */
  const footfall = memberSeries(s, advisor, (m) => (m.checkins || []).map((c) => ({ ym: (c.checkinAt || '').slice(0, 7) })));
  const newcomers = memberSeries(s, advisor, (m) => (m.createdAt ? [{ ym: m.createdAt.slice(0, 7) }] : []));
  const deals = memberSeries(s, advisor, (m) => (m.totalPaid > 0 && m.createdAt ? [{ ym: m.createdAt.slice(0, 7) }] : []));
  const followups = eventSeries(s, advisor, s.followups, 'memberId');
  const appts = eventSeries(s, advisor, s.appointments, 'memberId');

  /* ---- 本月 / 上月：末位为当月，倒数第二位为上月 ---- */
  const winLen = monthWindow(6).length;
  const li = winLen - 1;
  const snap = (ser) => ({
    cur: ser.store[li], prev: ser.store[li - 1] ?? 0,
    curP: ser.personal[li], prevP: ser.personal[li - 1] ?? 0,
  });

  /* ---- 结构性快照 ---- */
  const paidMembers = members.filter((m) => (m.totalPaid || 0) > 0);
  const revenue = sum(paidMembers, (m) => m.totalPaid || 0);
  const avgTicket = paidMembers.length ? Math.round(revenue / paidMembers.length) : 0;
  const activeCount = members.filter((m) => (m.visits30 || 0) > 0).length;
  const lostCount = (s.members || []).filter((m) => m.lost).length;
  const dist = (fn) => Object.entries(members.reduce((acc, m) => {
    const k = fn(m); acc[k] = (acc[k] || 0) + 1; return acc;
  }, {})).sort((a, b) => b[1] - a[1]);

  return {
    storeFootfall, memberCount, regCount, personalRate, storeRate, personalTotal: personal.length,
    footfall, newcomers, deals, followups, appts,
    mom: {
      footfall: snap(footfall), newcomers: snap(newcomers), deals: snap(deals),
      followups: snap(followups), appts: snap(appts),
    },
    revenue, avgTicket, activeCount, lostCount,
    stageDist: dist((m) => STAGES[m.stage]?.label || m.stage || '未分'),
    sourceDist: dist((m) => SRC_LABEL[m.source] || (m.source === 'tri' ? '三体同步' : m.source || '未标')),
  };
}

const SRC_LABEL = {
  tri: '三体同步', walkin: '自然到店', douyin: '抖音', xiaohongshu: '小红书', referral: '转介绍', wechat: '朋友圈', manual: '手动录入',
};

/**
 * 维护名单：手上有"剩余有效额度或有效期不足 20%"且在生效中的会籍卡。
 *
 * 口径（确定性，两种卡各自按自己的总量算）：
 *   · 次数 / 私教 / 团课卡：剩余次数 ÷ 购买总次数
 *   · 期限卡：剩余天数 ÷ 购买总时长
 * 两张口径任一低于 20% 即入列。取不到总量的卡（无 totalCount 也非期限卡）
 * 算不出剩余比例，不入列 —— 不用默认值顶替。
 */
function maintenanceList(s, threshold) {
  return s.members
    .filter((m) => !m.lost)
    .map((m) => {
      const cards = cardsOfMember(m.id);
      const active = cards.filter((c) => cardStatus(c).key === 'active');
      const remainings = active.map((c) => ({ c, r: 1 - cardProgress(c) }));
      const nearEnd = remainings.some((x) => x.r < 0.2);
      /* 展示最接近耗尽的那张卡：维护要优先处理它 */
      const worst = remainings.length ? remainings.reduce((a, b) => (b.r < a.r ? b : a)) : null;
      const mo = motionOf(m);
      const drop = mo.known && mo.perWeek < threshold;
      return { m, cards: active, card: worst ? worst.c : null, remain: worst ? worst.r : 0, mo, drop, nearEnd };
    })
    .filter((x) => x.nearEnd)
    /* 越接近耗尽越靠前 */
    .sort((a, b) => a.remain - b.remain);
}

/** 跟进优先级：纯本地字段打分，分数越高越该先处理 */
function followPriority(m) {
  let p = 0;
  const reasons = [];
  const e = expiry(m);
  if (e.days != null) {
    if (e.days <= 7) { p += 100; reasons.push('7 天内到期'); }
    else if (e.days <= 30) { p += 40; reasons.push('30 天内到期'); }
  }
  const mo = motionOf(m);
  if (mo.silentDays != null) {
    if (mo.silentDays >= 30) { p += 80; reasons.push('沉默 30 天+'); }
    else if (mo.silentDays >= 14) { p += 40; reasons.push('沉默 14 天+'); }
  }
  if (pendingReachOf(m.id).length) { p += 60; reasons.push('有未闭环触达'); }
  const f = latestFollowup(m.id);
  if (f && f.nextDate && daysBetween(f.nextDate, today()) >= 0) { p += 50; reasons.push('跟进已逾期'); }
  const cards = cardsOfMember(m.id);
  if (cards.some((c) => c.remainCount != null && c.remainCount <= 3)) { p += 30; reasons.push('课时将尽'); }
  if (m.stage === 'trial' || m.stage === 'lead') p += 20;
  const tier = p >= 80 ? 'P1' : p >= 40 ? 'P2' : 'P3';
  return { p, tier, reasons };
}

const PRI_CLS = { P1: 'b-danger', P2: 'b-warn', P3: 'b-plain' };

/* ============================================================
   渲染入口
   ============================================================ */
const MEMBER_SEGS = [
  { id: 'overview', label: '总览' },
  { id: 'maintain', label: '维护' },
  { id: 'follow', label: '跟进' },
  { id: 'stats', label: '统计' },
];

export function render(ctx) {
  const s = ctx.state;
  const advisor = s.settings.advisor;
  const pool = poolStats(s, advisor);
  const stats = statsCalc(s, advisor);
  const threshold = s.settings.freqDropAlert ?? 1;

  const seg = MEMBER_SEGS.some((x) => x.id === ctx._memberSeg) ? ctx._memberSeg : 'overview';
  const body =
    seg === 'overview' ? colOverview(ctx, pool, stats) :
    seg === 'maintain' ? colMaintain(ctx, threshold) :
    seg === 'follow' ? colFollow(ctx) :
    colStats(ctx, pool, stats);

  return `
  <div class="page-head">
    <h2>客户管理</h2>
    <p>总览 · 维护 · 跟进 · 统计，四块共用同一份数据。默认注册即到店客户（来源 = 到店）。</p>
  </div>
  <div class="seg" style="margin-bottom:14px">
    ${MEMBER_SEGS.map((x) => `<button data-mseg="${x.id}" class="${seg === x.id ? 'on' : ''}">${esc(x.label)}</button>`).join('')}
  </div>
  ${body}
  <button class="fab" data-act="new-member" aria-label="新增会员"><svg viewBox="0 0 24 24"><use href="#i-plus"/></svg></button>`;
}

/* ---------------- 第一栏：客户总览 ---------------- */
function colOverview(ctx, pool, stats) {
  const s = ctx.state;
  const q = ctx._q || '';
  const rb = renewalBuckets();
  const urgent = [...rb.urgent, ...rb.upcoming].sort((a, b) => expiry(a).days - expiry(b).days).slice(0, 5);
  const found = q ? sortLostLast(searchMembers(q)) : [];

  return `
    <div class="stat-grid g2">
        ${statCard({ k: '门店总会员池', v: pool.storePool, unit: '人' })}
        ${statCard({ k: '个人会员池', v: pool.personalPool, unit: '人', d: `归属 ${esc(s.settings.advisor)}` })}
        ${statCard({ k: '近 30 天新增会员', v: pool.new30, unit: '人' })}
        ${statCard({ k: '待过期会员', v: pool.expiring, unit: '人', d: '30 天内到期' })}
        ${statCard({ k: '流失会员池', v: pool.lostPool, unit: '人', d: '已登记流失，不计入在册' })}
      </div>

      <div class="search-wrap" style="margin:12px 0">
        <svg viewBox="0 0 24 24"><use href="#i-search"/></svg>
        <input class="input" id="mSearch" placeholder="搜姓名 / 手机 / 卡种（搜本地数据包）" value="${esc(q)}"/>
      </div>

      ${q ? `
        ${sectionTitle('搜索结果', `${found.length} 人`)}
        ${found.length ? `<div class="list dense">${found.map(overviewRow).join('')}</div>` : emptyState('本地数据包里没有匹配的会员', 'i-users')}
      ` : `
        ${sectionTitle('待过期名单', '最近 5 位')}
        ${urgent.length ? urgent.map((m) => {
          const e = expiry(m);
          return `<button class="list-item" data-member="${m.id}">
            ${avatarHtml(m.name)}
            <div class="li-body">
              <div class="li-top"><span class="li-name">${esc(m.name)}</span>${badge(e.label, e.key === 'expired' ? 'b-danger' : 'b-warn')}</div>
              <div class="li-meta"><span>${esc(m.cardType || '未办卡')}</span><span>${e.days >= 0 ? e.days + ' 天后' : '已过期 ' + Math.abs(e.days) + ' 天'}</span></div>
            </div>
            <svg class="chev" viewBox="0 0 24 24"><use href="#i-chev"/></svg>
          </button>`;
        }).join('') : emptyState('30 天内没有待过期会员', 'i-check')}

        ${sectionTitle('客户池', `${poolOrdered(s).length} 人 · 已登记流失的置底并灰显`)}
        <div class="list dense">${poolOrdered(s).map(overviewRow).join('')}</div>
      `}
      <div class="hint" style="margin-top:10px">门店客流 ${stats.storeFootfall} 人次（近 30 天到店总人次）。搜索只命中 FitFlow 本地数据包，不实时调取三体 / 勤鸟接口。</div>`;
}

function overviewRow(m) {
  const e = expiry(m);
  const o = originOf(m);
  const lost = !!m.lost;
  return `<button class="list-item${lost ? ' lost' : ''}" data-member="${m.id}">
    ${avatarHtml(m.name)}
    <div class="li-body">
      <div class="li-top"><span class="li-name">${esc(m.name)}</span>${lost ? badge('登记流失', 'b-plain') : stageBadge(m.stage)}</div>
      <div class="li-meta">
        <span>${esc(m.cardType || '未办卡')}</span>
        ${lost && m.lostAt ? `<span>流失于 ${esc(m.lostAt)}</span>` : ''}
        ${o.id !== 'manual' ? `<span class="src ${o.cls}">${esc(o.label)}</span>` : ''}
      </div>
    </div>
    <svg class="chev" viewBox="0 0 24 24"><use href="#i-chev"/></svg>
  </button>`;
}

/* ---------------- 第二栏：客户维护 ---------------- */
function colMaintain(ctx, threshold) {
  const s = ctx.state;
  const list = maintenanceList(s, threshold);
  const ba = connectorById('bodyAnalyzer');
  const THRESHOLDS = [
    { v: 0.5, label: '0.5 次/周' },
    { v: 1, label: '1 次/周' },
    { v: 2, label: '2 次/周' },
    { v: 3, label: '3 次/周' },
  ];

  return `
    <div class="sw-row" style="padding:6px 0 10px">
        <div class="small" style="font-weight:650">运动频率降低预警</div>
        <div class="chips" style="margin-top:6px">
          ${THRESHOLDS.map((t) => `<button class="chip ${Number(threshold) === t.v ? 'on' : ''}" data-freq-alert="${t.v}">${esc(t.label)}</button>`).join('')}
        </div>
      </div>
      <div class="hint" style="margin-bottom:10px">周频次低于所选阈值即标记"频率下降"。当前阈值：<b>${esc(String(threshold))}</b> 次/周。</div>

      ${sectionTitle('剩余不足 20% 的会员', `${list.length} 人 · 按剩余升序`)}
      <div class="hint" style="margin-bottom:10px">本栏定义：生效中的会籍卡，<b>剩余有效额度</b>（剩余次数 ÷ 购买总次数）或 <b>剩余有效期</b>（剩余天数 ÷ 购买总时长）<b>低于 20%</b> 即入列。</div>
      ${list.length ? list.map((x) => maintainCard(x, threshold)).join('') : emptyState('没有剩余额度或有效期低于 20% 的生效会籍卡', 'i-target')}

      ${sectionTitle('体测仪数据互通（预留接口）')}
      <div class="card tight" style="border-color:var(--brand-tint-2);background:var(--brand-tint)">
        <div class="between">
          <div class="small" style="font-weight:700;color:var(--brand-2)">${ba ? esc(ba.name) : '体测仪'}</div>
          ${badge(ba ? '已接入（待校准）' : '未接入', ba ? 'b-info' : 'b-plain')}
        </div>
        <div class="small" style="margin-top:6px;line-height:1.6;color:var(--brand-2)">
          适配 InBody / Tanita / seca / EGYM / 联合意达等主流品牌，数据通道按三体 · 勤鸟同款适配器模式预留。
        </div>
        <div class="btn-row" style="margin-top:9px">
          ${ba ? `<button class="btn ghost sm" data-bodyanalyzer="view">查看通道</button>` : `<button class="btn ghost sm" data-bodyanalyzer="add">接入体测仪</button>`}
        </div>
      </div>
  `;
}

function maintainCard(x, threshold) {
  const m = x.m;
  const card = x.card || x.cards[0];
  const remainPct = Math.round(x.remain * 100);
  const mo = x.mo;
  const remind = m.remind;
  return `<div class="card tight" data-mbr="${m.id}">
    <div class="between">
      <div class="flex" style="min-width:0">
        ${avatarHtml(m.name)}
        <div style="min-width:0">
          <div class="li-top"><span class="li-name">${esc(m.name)}</span>${stageBadge(m.stage)}</div>
          <div class="li-meta"><span>${esc(card?.name || '会籍卡')}</span></div>
        </div>
      </div>
      ${x.drop ? badge('频率下降', 'b-warn') : ''}
    </div>
    <div class="bar thin" style="margin:8px 0 4px"><i style="width:${remainPct}%"></i></div>
    <div class="between small muted">
      <span>剩余额度 ${remainPct}%</span>
      <span>周频次 ${mo.known ? mo.perWeek + ' 次' : '无记录'}</span>
    </div>
    <div class="btn-row" style="margin-top:9px">
      <button class="btn ghost sm" data-remind="${m.id}">${remind?.on ? `提醒每 ${remind.days} 天` : '周期提醒'}</button>
      <button class="btn ghost sm" data-effect="${m.id}">效果档案</button>
      <button class="btn ghost sm" data-mbr-open="${m.id}">看会员</button>
    </div>
  </div>`;
}

/* ---------------- 第三栏：客户跟进 ---------------- */
function colFollow(ctx) {
  const s = ctx.state;
  const items = s.members
    .filter((m) => !m.lost)
    .filter((m) => latestFollowup(m.id) || pendingReachOf(m.id).length)
    .map((m) => ({ m, pr: followPriority(m) }))
    .sort((a, b) => b.pr.p - a.pr.p);

  return `
    ${sectionTitle('客户跟进', `${items.length} 人 · 按优先级自动排序`)}
    ${items.length ? items.map(({ m, pr }) => followCard(m, pr)).join('') : emptyState('暂无需要跟进的客户', 'i-chat')}
  `;
}

function followCard(m, pr) {
  const f = latestFollowup(m.id);
  const pend = pendingReachOf(m.id);
  const e = expiry(m);
  return `<div class="card tight follow-card" data-mbr="${m.id}">
    <div class="between">
      <div class="flex" style="min-width:0">
        ${avatarHtml(m.name)}
        <div style="min-width:0">
          <div class="li-top"><span class="li-name">${esc(m.name)}</span>${badge(pr.tier, PRI_CLS[pr.tier])}</div>
          <div class="li-meta"><span>${esc(m.cardType || '未办卡')}</span>${e.days != null ? `<span style="color:${e.key === 'expired' ? 'var(--danger)' : e.key === 'urgent' ? 'var(--warn)' : 'inherit'}">${esc(e.label)}</span>` : ''}</div>
        </div>
      </div>
      ${pend.length ? badge('未闭环触达', 'b-warn') : ''}
    </div>
    ${f ? `<div class="small muted" style="margin-top:6px;line-height:1.6">最近：${esc(f.summary)}${f.nextAction ? '｜下一步：' + esc(f.nextAction) : ''}</div>` : ''}
    <div class="tag-row" style="margin-top:6px">${pr.reasons.map((r) => `<span class="src warn">${esc(r)}</span>`).join('')}</div>
    <div class="btn-row" style="margin-top:9px">
      <button class="btn ghost sm" data-follow="${m.id}">去处理</button>
      <button class="btn ghost sm" data-mbr-open="${m.id}">看会员</button>
    </div>
  </div>`;
}

/* ---------------- 第四栏：客户池统计（门店大盘） ----------------
   四块内容，全部从本地数据包确定性算出：
     ① 大盘 KPI（当前快照）        ② 近 6 个月趋势折线图（门店线 / 个人线）
     ③ 本月 vs 上月（环比）        ④ 个人 vs 门店 对比 + 结构分布
   某月无记录的计数就是 0，绝不向前插值。 */
function colStats(ctx, pool, stats) {
  const s = ctx.state;
  const advisor = s.settings.advisor;
  const STORE_COLOR = '#0A6E46';
  const PERS_COLOR = '#E0892B';

  /* 一张图卡：标题 + 图例 + 折线 + 口径脚注 */
  const chartCard = (title, hint, ser) => {
    const maxV = Math.max(0, ...ser.store, ...ser.personal);
    const note = maxV === 0
      ? '近 6 个月本地包里该指标没有任何记录（图上的 0 是真实计数，不是缺数）。'
      : '';
    return `
      <div class="card tight" style="margin-bottom:10px">
        <div class="between" style="margin-bottom:6px">
          <div style="font-weight:650">${esc(title)}</div>
          <div class="small muted" style="display:flex;gap:10px">
            <span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${STORE_COLOR};margin-right:3px"></i>门店</span>
            <span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${PERS_COLOR};margin-right:3px"></i>个人</span>
          </div>
        </div>
        ${lineChartSVG({
          labels: ser.labels,
          series: [
            { name: '门店', color: STORE_COLOR, values: ser.store },
            { name: '个人', color: PERS_COLOR, values: ser.personal },
          ],
        })}
        <div class="hint" style="margin-top:6px">${note || esc(hint)}</div>
      </div>`;
  };

  /* 环比行 */
  const momRow = (label, unit, snap) => {
    const t = momText(snap.cur, snap.prev);
    return `
      <div class="row-line" style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)">
        <div class="small">${esc(label)}</div>
        <div style="display:flex;align-items:baseline;gap:10px">
          <div class="big-num" style="font-size:18px">${snap.cur}<span class="small muted" style="margin-left:2px">${esc(unit)}</span></div>
          <div class="small" style="color:${t.color}">${t.arrow} ${esc(t.label)}</div>
        </div>
      </div>`;
  };

  /* 个人 vs 门店 双条对比 */
  const cmpRow = (label, storeV, persV, unit) => {
    const mx = Math.max(1, storeV, persV);
    return `
      <div style="padding:9px 0;border-bottom:1px solid var(--line)">
        <div class="between"><div class="small muted">${esc(label)}（门店）</div><div class="big-num" style="font-size:16px">${storeV}${esc(unit)}</div></div>
        <div class="bar thin" style="margin:5px 0"><i style="width:${(storeV / mx) * 100}%"></i></div>
        <div class="between"><div class="small muted">${esc(label)}（个人 · ${esc(advisor)}）</div><div class="big-num" style="font-size:16px;color:var(--brand-2)">${persV}${esc(unit)}</div></div>
        <div class="bar thin brand" style="margin:5px 0"><i style="width:${(persV / mx) * 100}%"></i></div>
      </div>`;
  };

  /* 分布：带占比条 */
  const distRows = (dist, total) => {
    const mx = Math.max(1, ...dist.map((d) => d[1]));
    return dist.map(([k, v]) => `
      <div style="padding:6px 0;border-bottom:1px solid var(--line)">
        <div class="between"><div class="small">${esc(k)}</div><div class="small muted">${v} 人 · ${Math.round((v / total) * 100)}%</div></div>
        <div class="bar thin" style="margin-top:4px"><i style="width:${(v / mx) * 100}%"></i></div>
      </div>`).join('') || '<span class="small muted">无记录</span>';
  };

  /* 个人结构占比（在门店大盘里"我占多少"） */
  const share = (p) => (stats.regCount ? Math.round((p / stats.regCount) * 100) : 0);

  return `
    ${sectionTitle('门店大盘 · 关键指标')}
    <div class="stat-grid g2">
      ${statCard({ k: '门店客流', v: stats.storeFootfall, unit: '人次', d: '近 30 天到店总人次' })}
      ${statCard({ k: '会员数量', v: stats.memberCount, unit: '人', d: '已成交会员' })}
      ${statCard({ k: '注册客户量', v: stats.regCount, unit: '人', d: '全部在册客户' })}
      ${statCard({ k: '活跃会员', v: stats.activeCount, unit: '人', d: '近 30 天到店大于 0' })}
      ${statCard({ k: '本月新增会员', v: stats.mom.newcomers.cur, unit: '人', d: '本月建档客户' })}
      ${statCard({ k: '本月到店', v: stats.mom.footfall.cur, unit: '人次', d: '本月打卡明细合计' })}
      ${statCard({ k: '累计成交额', v: moneyFull(stats.revenue), d: `${stats.memberCount} 位已成交会员合计` })}
      ${statCard({ k: '平均客单价', v: moneyFull(stats.avgTicket), d: '累计成交额 ÷ 已成交会员数' })}
    </div>

    ${sectionTitle('趋势 · 近 6 个月（门店线 vs 个人线）')}
    ${chartCard('到店人次', '口径：按会员打卡明细（checkinAt）逐日聚合，同月内多人多次叠加计人次。', stats.footfall)}
    ${chartCard('新增会员', '口径：按会员建档日期（createdAt）归属月份，每人只计一次。', stats.newcomers)}
    ${chartCard('新成交单', '口径：建档于该月且已付费（totalPaid 大于 0）的客户数。', stats.deals)}

    ${sectionTitle('本月 vs 上月（环比）')}
    <div class="card tight">
      ${momRow('到店人次', '人次', stats.mom.footfall)}
      ${momRow('新增会员', '人', stats.mom.newcomers)}
      ${momRow('新成交单', '单', stats.mom.deals)}
      ${momRow('跟进记录', '条', stats.mom.followups)}
      ${momRow('到店预约', '次', stats.mom.appts)}
      <div class="hint" style="margin-top:8px">上月为 0 时不出百分比：以 0 作分母得出的涨跌幅没有意义，这里如实显示「上月无记录」。指标口径与上面趋势图一致。</div>
    </div>

    ${sectionTitle('个人 vs 门店')}
    <div class="card tight">
      <div class="between"><div class="small muted">门店成交率</div><div class="big-num">${stats.storeRate}%</div></div>
      <div class="bar thin" style="margin:6px 0"><i style="width:${stats.storeRate}%"></i></div>
      <div class="between" style="margin-top:10px"><div class="small muted">个人成交率（${esc(advisor)}）</div><div class="big-num" style="color:var(--brand-2)">${stats.personalRate}%</div></div>
      <div class="bar thin brand" style="margin:6px 0"><i style="width:${stats.personalRate}%"></i></div>
      ${cmpRow('本月到店', stats.mom.footfall.cur, stats.mom.footfall.curP, ' 人次')}
      ${cmpRow('本月新增', stats.mom.newcomers.cur, stats.mom.newcomers.curP, ' 人')}
      ${cmpRow('本月跟进', stats.mom.followups.cur, stats.mom.followups.curP, ' 条')}
      <div class="hint" style="margin-top:8px">我在门店大盘里的份额：名下 ${stats.personalTotal} 人，占注册客户量 ${stats.regCount} 人的 ${share(stats.personalTotal)}%。门店数按全店计，个人数按归属顾问（${esc(advisor)}）计，两者不是同一批人，故门店值恒大于或等于个人值。</div>
    </div>

    ${sectionTitle('结构分布（当前在册）')}
    <div class="card tight">
      <div class="small muted" style="margin-bottom:4px">客户阶段</div>
      ${distRows(stats.stageDist, stats.regCount)}
      <div class="small muted" style="margin:10px 0 4px">客户来源</div>
      ${distRows(stats.sourceDist, stats.regCount)}
      <div class="hint" style="margin-top:8px">已登记流失 ${stats.lostCount} 人，不计入在册池，仅在总览的「流失会员池」单独出数。</div>
    </div>

    ${notice('口径说明：会员 = 已付费成交；注册客户 = 全部在册（含线索 / 体验）。到店人次来自会员打卡明细，明细窗口与「近 30 天 N 次」自洽绑定，因此更早月份在明细里确实没有记录（图上为真实 0，不是缺数）；接入三体 / 勤鸟的历史到店数据后，趋势线会自动补齐。所有数值均由本地数据包直接统计得出，无推算、无平滑。', 'info', 'i-alert')}
  `;
}

/* ============================================================
   弹层：周期提醒 / 效果档案 / 体测仪接入
   ============================================================ */

/** 周期提醒运动：开关节点 + 自主设置间隔天数 */
function openRemindSheet(ctx, memberId) {
  const m = memberById(memberId);
  if (!m) return toast('找不到这位会员', 'warn');
  const cur = m.remind || { on: false, days: 7 };
  let on = cur.on;
  let days = cur.days || 7;

  openSheet({
    title: '周期提醒运动',
    subtitle: esc(m.name),
    body: `
      <div class="sw-row">
        <div><div style="font-weight:650">开启周期提醒</div><div class="small muted">按设定间隔自动提醒该会员回店运动</div></div>
        <button class="switch ${on ? 'on' : ''}" data-remind-on role="switch" aria-checked="${on}"><i></i></button>
      </div>
      ${field({ label: '提醒间隔（天）', name: 'days', type: 'number', value: days, attrs: 'min="1" max="60"' })}
      <div class="hint" id="remindHint">${on ? `下次提醒：${fmtDate(addDaysSafe(days), 'ymd')}` : '当前未开启'}</div>
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存</button>`,
    onMount(el, close) {
      el.querySelector('[data-remind-on]').onclick = (e) => {
        on = !on;
        e.currentTarget.classList.toggle('on', on);
        e.currentTarget.setAttribute('aria-checked', on);
        el.querySelector('#remindHint').textContent = on ? `下次提醒：${fmtDate(addDaysSafe(days), 'ymd')}` : '当前未开启';
      };
      el.querySelector('[name="days"]').addEventListener('input', (e) => {
        days = Math.max(1, Number(e.target.value) || 1);
        if (on) el.querySelector('#remindHint').textContent = `下次提醒：${fmtDate(addDaysSafe(days), 'ymd')}`;
      });
      el.querySelector('[data-save]').onclick = () => {
        setExerciseReminder(m.id, { on, days });
        toast(on ? `已设每 ${days} 天提醒 ${m.name}` : `已关闭 ${m.name} 的周期提醒`);
        close();
        ctx.refresh();
      };
    },
  });
}

/** 会员效果档案：只读汇总（含体测仪预留说明） */
function openEffectSheet(ctx, memberId) {
  const m = memberById(memberId);
  if (!m) return toast('找不到这位会员', 'warn');
  const mo = motionOf(m);
  const cards = cardsOfMember(m.id);
  const ba = connectorById('bodyAnalyzer');
  openSheet({
    title: '会员效果档案',
    subtitle: esc(m.name),
    size: 'tall',
    body: `
      <div class="stat-grid g2" style="margin-bottom:12px">
        ${statCard({ k: '近 30 天到店', v: mo.known ? mo.freq : 0, unit: '次', d: mo.tier.label })}
        ${statCard({ k: '累计消费', v: moneyFull(m.totalPaid || 0) })}
      </div>
      ${sectionTitle('目标 / 顾虑')}
      <div class="tag-row">${(m.goals || []).map((g) => `<span class="src qn">目标：${esc(g)}</span>`).join('') || '<span class="small muted">未记录目标</span>'}</div>
      <div class="tag-row" style="margin-top:6px">${(m.concerns || []).map((g) => `<span class="src warn">顾虑：${esc(g)}</span>`).join('') || '<span class="small muted">未记录顾虑</span>'}</div>

      ${sectionTitle('体测数据（来自体测仪通道）')}
      ${ba ? `<div class="card tight" style="border-color:var(--brand-tint-2);background:var(--brand-tint)">
        <div class="small" style="color:var(--brand-2);line-height:1.7">体测仪通道「${esc(ba.name)}」已预留。接入并校准后，体重 / 体脂 / 围度等会按三体 · 勤鸟同款适配器写入此处，自动生成前后对比。</div>
      </div>` : notice('体测仪通道尚未接入。在「客户维护」栏接入后，这里会自动出现体重 / 体脂 / 围度前后对比。', 'info', 'i-target')}

      ${sectionTitle('在生效会籍卡')}
      ${cards.filter((c) => cardStatus(c).key === 'active').map((c) => `<div class="small" style="padding:4px 0">${esc(c.name)} · 剩余 ${c.remainCount != null ? c.remainCount + (CARD_TYPES[c.typeId]?.unit || '') : (c.endDate ? '至 ' + fmtDate(c.endDate, 'ymd') : '长期')}</div>`).join('') || '<span class="small muted">无生效会籍卡</span>'}
    `,
    footer: `<button class="btn primary" data-sheet-close>知道了</button>`,
  });
}

/** 体测仪接入：占位 + 录入基础配置 */
function openBodyAnalyzerSheet(ctx, mode) {
  const ba = connectorById('bodyAnalyzer');
  if (mode === 'view' && ba) {
    openSheet({
      title: '体测仪通道',
      subtitle: esc(ba.name),
      body: `
        ${badge('状态：' + (ba.status || 'pending'), 'b-info')}
        <div class="kv"><span>接入地址</span><span class="mono">${esc(ba.baseUrl || '未填写')}</span></div>
        <div class="kv"><span>适配品牌</span><span>${esc((ba.brands || []).join('、'))}</span></div>
        <div class="hint" style="margin-top:8px">${esc(ba.note || '')}</div>
      `,
      footer: `<button class="btn primary" data-sheet-close>关闭</button>`,
    });
    return;
  }
  openSheet({
    title: '接入体测仪（预留接口）',
    body: `
      ${field({ label: '设备 / 通道名称', name: 'name', value: '体测仪', placeholder: '例：InBody 770' })}
      ${field({ label: '数据接入地址（可选）', name: 'baseUrl', placeholder: '厂商 API / 网关地址' })}
      <div class="hint">真实数据读取适配器将按三体 · 勤鸟同款模式后续补齐。此处先占位，不影响其他模块。</div>
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存通道</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const box = el.querySelector('.sheet-bd');
        const v = {};
        box.querySelectorAll('[name]').forEach((n) => { v[n.name] = n.value.trim(); });
        addBodyAnalyzer({ name: v.name || '体测仪', baseUrl: v.baseUrl || '' });
        toast('已预留体测仪通道，待适配器补齐');
        close();
        ctx.refresh();
      };
    },
  });
}

function addDaysSafe(n) {
  const t = new Date();
  t.setDate(t.getDate() + (Number(n) || 1));
  return t.toISOString().slice(0, 10);
}

/* ============================================================
   交互
   ============================================================ */
export function mount(root, ctx) {
  root.addEventListener('click', (e) => {
    const mseg = e.target.closest('[data-mseg]');
    if (mseg) { ctx._memberSeg = mseg.dataset.mseg; ctx.syncHash && ctx.syncHash(); ctx.refresh(); return; }

    const freq = e.target.closest('[data-freq-alert]');
    if (freq) { setFreqDropAlert(Number(freq.dataset.freqAlert)); ctx.refresh(); return; }

    const remind = e.target.closest('[data-remind]');
    if (remind) { openRemindSheet(ctx, remind.dataset.remind); return; }

    const effect = e.target.closest('[data-effect]');
    if (effect) { openEffectSheet(ctx, effect.dataset.effect); return; }

    const ba = e.target.closest('[data-bodyanalyzer]');
    if (ba) { openBodyAnalyzerSheet(ctx, ba.dataset.bodyanalyzer); return; }

    const follow = e.target.closest('[data-follow]');
    if (follow) { ctx.openContact(follow.dataset.follow); return; }

    const mOpen = e.target.closest('[data-mbr-open]');
    if (mOpen) { ctx.openMember(mOpen.dataset.mbrOpen); return; }

    const mbr = e.target.closest('[data-mbr]');
    if (mbr) { ctx.openMember(mbr.dataset.mbr); return; }

    const mb = e.target.closest('[data-member]');
    if (mb && mb.dataset.member) { ctx.openMember(mb.dataset.member); return; }

    const act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 'new-member') { ctx.openMemberForm(); return; }
  });

  const input = root.querySelector('#mSearch');
  if (input) {
    let t;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        ctx._q = input.value;
        ctx.refresh({ keepFocus: 'mSearch' });
      }, 220);
    });
  }
}
