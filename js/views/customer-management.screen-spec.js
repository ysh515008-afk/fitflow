/* ============================================================
   views/customer-management.screen-spec.js
   ------------------------------------------------------------
   客户管理「四栏」的纯函数模型层，承担两件事：
   1) 口径计算（poolStats / statsCalc / maintenanceList / followPriority）
      —— 与浏览器端 members.js 共用同一套 store / data 派生函数，
         数字绝不在本文件里写死，全部由真实状态算出来。
   2) 把算好的数据 + 设计令牌（brand / ink / surface / line / warn / danger 等）
      组装成 figma/ 插件能直接重建的节点树（screen.json 同形）。

   约定：默认注册 = 到店客户；搜索只命中本地数据包。
   本文件不碰任何 DOM，可在浏览器与 Node 双端运行。
   ============================================================ */
import {
  expiry, latestFollowup, renewalBuckets, pendingReachOf,
  memberById, originOf, cardsOfMember, connectorById, getState,
} from '../store.js';
import { motionOf } from '../outreach.js';
import { cardStatus, cardProgress } from '../data/membership.js';
import { daysBetween, today, sum } from '../util.js';

/* ---------------- 节点构造小工具 ---------------- */
const T = (name, text, size, weight, fill) => ({ type: 'text', name, text, size, weight, fill });
const F = (o) => Object.assign({ type: 'frame' }, o);
const R = (o) => Object.assign({ type: 'rect' }, o);

/* ---------------- 口径函数（确定性，绝不靠"多半/可能"推断） ---------------- */

/** 门店总池 / 个人池 / 近 30 天新增 / 待过期 */
export function poolStats(s, advisor) {
  const members = s.members;
  const storePool = members.length;
  const personalPool = members.filter((m) => (m.owner || '') === advisor).length;
  const new30 = members.filter((m) => {
    if (!m.createdAt) return false;
    const dd = daysBetween(m.createdAt, today());
    return dd >= 0 && dd <= 30;
  }).length;
  const rb = renewalBuckets();
  const expiring = rb.urgent.length + rb.upcoming.length;
  return { storePool, personalPool, new30, expiring };
}

/** 客户池统计：全部基于本地数据包 */
export function statsCalc(s, advisor) {
  const members = s.members;
  const storeFootfall = sum(members, (m) => m.visits30 || 0);          // 门店客流 = 近 30 天到店总人次
  const paid = (arr) => arr.filter((m) => (m.totalPaid || 0) > 0).length;
  const memberCount = paid(members);                                    // 会员数量 = 已成交会员
  const regCount = members.length;                                      // 注册客户量 = 全部在册客户
  const personal = members.filter((m) => (m.owner || '') === advisor);
  const personalRate = personal.length ? Math.round((paid(personal) / personal.length) * 100) : 0;
  const storeRate = regCount ? Math.round((memberCount / regCount) * 100) : 0;
  return { storeFootfall, memberCount, regCount, personalRate, storeRate, personalTotal: personal.length };
}

/** 维护名单：手上有"剩余额度 > 20%"且在生效中的会籍卡 */
export function maintenanceList(s, threshold) {
  return s.members
    .map((m) => {
      const cards = cardsOfMember(m.id);
      const active = cards.filter((c) => cardStatus(c).key === 'active');
      const remaings = active.map((c) => 1 - cardProgress(c));
      const hasRemain = remaings.some((r) => r > 0.2);
      const maxRemain = remaings.length ? Math.max(...remaings) : 0;
      const mo = motionOf(m);
      const drop = mo.known && mo.perWeek < threshold;
      return { m, cards: active, maxRemain, mo, drop };
    })
    .filter((x) => x.hasRemain);
}

/** 跟进优先级：纯本地字段打分，分数越高越该先处理 */
export function followPriority(m) {
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
const THRESHOLDS = [
  { v: 0.5, label: '0.5 次/周' },
  { v: 1, label: '1 次/周' },
  { v: 2, label: '2 次/周' },
  { v: 3, label: '3 次/周' },
];

/* ============================================================
   节点树构建（与现有 figma/customer-management.screen.json 同形）
   ============================================================ */

function statCard(k, v, unit, d, fill = 'surface') {
  return F({
    name: `stat-${k}`, fill, stroke: 'line', radius: 14, pad: 12,
    children: [
      T('k', k, 11, 400, 'ink-3'),
      T('v', `${v} ${unit}`, 21, 750, 'ink'),
      ...(d ? [T('d', d, 11, 400, 'ink-3')] : []),
    ],
  });
}

function colHd(idx, name) {
  return F({ name: 'col-hd', fill: 'brand-tint', radius: 18, pad: 10, children: [
    T('col-title', `${idx} · ${name}`, 14, 700, 'brand-2'),
  ] });
}

function buildCol1(pool, stats, advisor) {
  const rb = renewalBuckets();
  const urgent = [...rb.urgent, ...rb.upcoming].sort((a, b) => expiry(a).days - expiry(b).days).slice(0, 5);
  return F({
    name: 'col1-客户总览', w: 305, layout: 'V', gap: 12, pad: 0, fill: 'transparent',
    children: [
      colHd(1, '客户总览'),
      F({ name: 'stats-2x2', layout: 'H', gap: 10, pad: 0, fill: 'transparent', children: [
        F({ name: 'col-stats-left', layout: 'V', gap: 10, pad: 0, fill: 'transparent', children: [
          statCard('门店总会员池', pool.storePool, '人'),
          statCard('近 30 天新增会员', pool.new30, '人'),
        ]}),
        F({ name: 'col-stats-right', layout: 'V', gap: 10, pad: 0, fill: 'transparent', children: [
          statCard('个人会员池', pool.personalPool, '人', `归属 ${advisor}`),
          statCard('待过期会员', pool.expiring, '人', '30 天内到期'),
        ]}),
      ]}),
      F({ name: 'search', fill: 'surface', stroke: 'line', radius: 10, pad: 10, children: [
        T('placeholder', '搜姓名 / 手机 / 卡种（搜本地数据包）', 13, 400, 'ink-4'),
      ]}),
      T('section-待过期名单', '待过期名单 · 最近 5 位', 13, 700, 'ink-2'),
      ...urgent.map((m) => {
        const e = expiry(m);
        const badFill = e.key === 'expired' ? 'danger-tint' : 'warn-tint';
        const badText = e.key === 'expired' ? 'danger' : 'warn';
        const meta = `${m.cardType || '未办卡'} · ${e.days >= 0 ? e.days + ' 天后' : '已过期 ' + Math.abs(e.days) + ' 天'}`;
        return F({ name: `row-${m.name}`, fill: 'surface', stroke: 'line', radius: 12, pad: 10, children: [
          T('name', m.name, 14.5, 650, 'ink'),
          F({ name: 'badge', fill: badFill, radius: 999, pad: 4, children: [
            T('t', e.label, 11, 600, badText),
          ]}),
          T('meta', meta, 11.5, 400, 'ink-3'),
        ]});
      }),
      T('hint', `门店客流 ${stats.storeFootfall} 人次（近 30 天到店总人次）。搜索只命中 FitFlow 本地数据包，不实时调取三体 / 勤鸟接口。`, 11.5, 400, 'ink-3'),
    ],
  });
}

function buildCol2(list, threshold) {
  const ba = connectorById('bodyAnalyzer');
  return F({
    name: 'col2-客户维护', w: 305, layout: 'V', gap: 12, pad: 0, fill: 'transparent',
    children: [
      colHd(2, '客户维护'),
      F({ name: 'freq-alert', fill: 'surface', stroke: 'line', radius: 14, pad: 12, children: [
        T('label', '运动频率降低预警', 13, 700, 'ink-2'),
        F({ name: 'chips', layout: 'H', gap: 6, pad: 0, fill: 'transparent', children: THRESHOLDS.map((t) => {
          const on = Number(threshold) === t.v;
          return F({ name: `chip-${t.v}`, fill: on ? 'brand-tint' : 'surface-3', radius: 999, pad: 4, children: [
            T('t', t.label, 11, 600, on ? 'brand-2' : 'ink-2'),
          ]});
        })}),
      ]}),
      T('section-剩余额度', `剩余额度 > 20% 的会员 · ${list.length} 人`, 13, 700, 'ink-2'),
      ...list.map((x) => {
        const m = x.m;
        const card = x.cards[0];
        const remainPct = Math.round(x.maxRemain * 100);
        const mo = x.mo;
        return F({ name: `card-${m.name}`, fill: 'surface', stroke: 'line', radius: 14, pad: 12, children: [
          T('name', m.name, 14.5, 650, 'ink'),
          ...(x.drop ? [F({ name: 'badge-频率下降', fill: 'warn-tint', radius: 999, pad: 4, children: [
            T('t', '频率下降', 11, 600, 'warn'),
          ]})] : []),
          F({ name: 'remain-bar', layout: 'H', clip: true, w: 280, h: 8, radius: 4, fill: 'line', children: [
            R({ name: 'fill', w: Math.round((remainPct / 100) * 280), h: 8, radius: 4, fill: 'brand' }),
          ]}),
          T('remain-meta', `剩余额度 ${remainPct}% · 周频次 ${mo.known ? mo.perWeek + ' 次' : '无记录'}`, 11.5, 400, 'ink-3'),
          F({ name: 'btns', layout: 'H', gap: 8, pad: 0, fill: 'transparent', children: [
            F({ name: 'btn-提醒', fill: 'surface-3', radius: 10, pad: 6, children: [ T('t', (m.remind && m.remind.on) ? `提醒每 ${m.remind.days} 天` : '周期提醒', 12, 600, 'ink-2') ] }),
            F({ name: 'btn-效果档案', fill: 'surface-3', radius: 10, pad: 6, children: [ T('t', '效果档案', 12, 600, 'ink-2') ] }),
            F({ name: 'btn-看会员', fill: 'surface-3', radius: 10, pad: 6, children: [ T('t', '看会员', 12, 600, 'ink-2') ] }),
          ]}),
        ]});
      }),
      T('section-体测仪', '体测仪数据互通（预留接口）', 13, 700, 'ink-2'),
      F({ name: 'card-体测仪', fill: 'brand-tint', radius: 14, pad: 12, children: [
        T('title', ba ? `${ba.name} · 已接入` : '体测仪 · 未接入', 13, 700, 'brand-2'),
        T('desc', '适配 InBody / Tanita / seca / EGYM / 联合意达等主流品牌，数据通道按三体 · 勤鸟同款适配器模式预留。', 11.5, 400, 'brand-2'),
        F({ name: 'btn-接入', fill: 'surface', radius: 10, pad: 6, children: [ T('t', ba ? '查看通道' : '接入体测仪', 12, 600, 'brand-2') ] }),
      ]}),
    ],
  });
}

function buildCol3(s) {
  const items = s.members
    .filter((m) => latestFollowup(m.id) || pendingReachOf(m.id).length)
    .map((m) => ({ m, pr: followPriority(m) }))
    .sort((a, b) => b.pr.p - a.pr.p);
  return F({
    name: 'col3-客户跟进', w: 305, layout: 'V', gap: 12, pad: 0, fill: 'transparent',
    children: [
      colHd(3, `客户跟进`),
      T('section-排序', '按优先级自动排序 · 跟进后实时换位', 13, 700, 'ink-2'),
      ...items.map(({ m, pr }) => {
        const f = latestFollowup(m.id);
        const pend = pendingReachOf(m.id);
        const e = expiry(m);
        const eFill = e.key === 'expired' ? 'danger' : e.key === 'urgent' ? 'warn' : 'ink';
        return F({ name: `card-${m.name}`, fill: 'surface', stroke: 'line', radius: 14, pad: 12, children: [
          T('name', m.name, 14.5, 650, 'ink'),
          F({ name: `badge-${pr.tier}`, fill: PRI_CLS[pr.tier] === 'b-danger' ? 'danger-tint' : PRI_CLS[pr.tier] === 'b-warn' ? 'warn-tint' : 'surface-3', radius: 999, pad: 4, children: [
            T('t', pr.tier, 11, 700, PRI_CLS[pr.tier] === 'b-danger' ? 'danger' : PRI_CLS[pr.tier] === 'b-warn' ? 'warn' : 'ink-2'),
          ]}),
          ...(f ? [T('summary', `${f.summary}${f.nextAction ? '｜下一步：' + f.nextAction : ''}`, 11.5, 400, 'ink-3')] : []),
          ...(pr.reasons.length ? [T('reasons', '# ' + pr.reasons.join(' # '), 11.5, 400, 'warn')] : []),
          ...(pend.length ? [F({ name: 'badge-未闭环', fill: 'warn-tint', radius: 999, pad: 4, children: [ T('t', '未闭环触达', 11, 700, 'warn') ] })] : []),
          F({ name: 'btns', layout: 'H', gap: 8, pad: 0, fill: 'transparent', children: [
            F({ name: 'btn-去处理', fill: pr.tier === 'P1' ? 'brand' : 'surface-3', radius: 10, pad: 6, children: [ T('t', '去处理', 12, 600, pr.tier === 'P1' ? 'surface' : 'ink-2') ] }),
            F({ name: 'btn-看会员', fill: 'surface-3', radius: 10, pad: 6, children: [ T('t', '看会员', 12, 600, 'ink-2') ] }),
          ]}),
        ]});
      }),
    ],
  });
}

function buildCol4(pool, stats, advisor) {
  const barW = (rate) => Math.round((rate / 100) * 280);
  return F({
    name: 'col4-客户池统计', w: 305, layout: 'V', gap: 12, pad: 0, fill: 'transparent',
    children: [
      colHd(4, '客户池统计'),
      F({ name: 'stats-2x2', layout: 'H', gap: 10, pad: 0, fill: 'transparent', children: [
        F({ name: 'col-stats-left', layout: 'V', gap: 10, pad: 0, fill: 'transparent', children: [
          statCard('门店客流', stats.storeFootfall, '人次', '近 30 天到店总人次'),
          statCard('注册客户量', stats.regCount, '人', '全部在册客户'),
        ]}),
        F({ name: 'col-stats-right', layout: 'V', gap: 10, pad: 0, fill: 'transparent', children: [
          statCard('会员数量', stats.memberCount, '人', '已成交会员'),
          statCard('个人会员池', stats.personalTotal, '人'),
        ]}),
      ]}),
      T('section-成交率', '成交率', 13, 700, 'ink-2'),
      F({ name: 'card-成交率', fill: 'surface', stroke: 'line', radius: 14, pad: 12, children: [
        T('label-门店', '门店成交率', 12, 600, 'ink-3'),
        T('num-门店', `${stats.storeRate}%`, 24, 750, 'ink'),
        F({ name: 'bar-门店', layout: 'H', clip: true, w: 280, h: 8, radius: 4, fill: 'line', children: [
          R({ name: 'fill', w: barW(stats.storeRate), h: 8, radius: 4, fill: 'brand' }),
        ]}),
        T('label-个人', `个人成交率（${advisor}）`, 12, 600, 'ink-3'),
        T('num-个人', `${stats.personalRate}%`, 24, 750, 'brand-2'),
        F({ name: 'bar-个人', layout: 'H', clip: true, w: 280, h: 8, radius: 4, fill: 'line', children: [
          R({ name: 'fill', w: barW(stats.personalRate), h: 8, radius: 4, fill: 'brand' }),
        ]}),
        T('hint', '成交率 = 已成交会员数 ÷ 在册客户数。', 11.5, 400, 'ink-3'),
      ]}),
    ],
  });
}

/* ============================================================
   对外入口：把真实状态组装成 screen.json 同形节点树
   ============================================================ */
export function buildCustomerManagementScreen(s) {
  const advisor = s.settings.advisor;
  const pool = poolStats(s, advisor);
  const stats = statsCalc(s, advisor);
  const threshold = s.settings.freqDropAlert ?? 1;
  const list = maintenanceList(s, threshold);

  return {
    screen: '客户管理 · 四栏重组',
    frame: F({
      name: '客户管理', w: 1280, fill: 'surface-2', layout: 'V', gap: 14, pad: 14,
      children: [
        T('标题', '客户管理', 20, 700, 'ink'),
        T('副标题', '总览 · 维护 · 跟进 · 统计，四栏共用同一份数据。默认注册即到店客户（来源 = 到店）。', 12.5, 400, 'ink-3'),
        F({ name: 'board', layout: 'H', gap: 12, pad: 0, fill: 'transparent', children: [
          buildCol1(pool, stats, advisor),
          buildCol2(list, threshold),
          buildCol3(s),
          buildCol4(pool, stats, advisor),
        ]}),
      ],
    }),
  };
}
