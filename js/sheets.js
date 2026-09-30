/* ============================================================
   sheets.js · 会员详情 / 表单 / 三体数据 / AI 任务包 抽屉
   ============================================================ */
import {
  memberById, followupsOf, appointmentsOf, latestFollowup, renewalOf,
  saveMember, setMemberStage, addFollowup, updateFollowup, upsertAppointment,
  setApptStatus, deleteAppointment, upsertRenewal, setAiResult, saveSettings, STAGES,
  markMemberHandled,
  CHANNELS, CHANNEL_BUBBLES, APPT_TYPES, APPT_STATUS, expiry, activity, todayQueue, originOf,
  cardsOfMember, saveCard, deleteCard, setCardStatus,
  reportCardError,
  freezeCard, unfreezeCard, renewCard, consumeCard, convertLead,
  upsertGroupPlanItem, upsertCampaign, upsertLead, setTopicProgress,
  bindDouyinAccount, unbindDouyinAccount, setDouyinMonitor, douyinBinding,
  upsertStoreHeatManual, deleteStoreHeatManual, setBoardQuery,
  bindXhsAccount, unbindXhsAccount, upsertXhsNote, deleteXhsNote,
  setFeature, resetFeatures, bizSource, bizRecordsOf, saveBizRecords,
  deleteBizRecord, setBizSource, logBizEvent, clearBizRecords,
  markBriefRead, resetBriefRead, logReach, pendingReachOf, reachTime, RESULT_LABEL,
  checkinsOf, visitStats, aiMaterialsOf,
  colleagueNotesOf, addColleagueNote, deleteColleagueNote,
  markMemberLost, restoreMember,
  addWritebackLog, writebackLogsOf,
} from './store.js';
import { getProvider, BIZ_SOURCE_LIST, getBizSource } from './integrations/index.js';
import {
  WRITE_CAPABILITY, writeCapable, route, renderPasteText, csvText,
  buildFollowupPayload, logEntry, alreadyPushed,
} from './integrations/writeback.js';
import { FEATURE_GROUPS, ALL_FEATURES, isFeatureOn, countOn } from './features.js';
import { buildBrief, unreadOf, readIdsOf, briefTotal, LEVEL_META } from './opsBrief.js';
import { parseBizReport, hasNoMetricMatch, BIZ_METRIC_FIELDS, collapseByDate } from './bizMetrics.js';
import {
  estimateCost, FULL_SYNC_KEYS, STORE_HEAT_ITEMS,
  RANK_CATEGORIES, FITNESS_CATEGORIES, RANK_PERIODS, defaultRankDate, BOARD_CAVEATS,
} from './douyin.js';
import { TOPICS } from './data/learningFramework.js';
import {
  MODELS, MODEL_BY_ID, queryModels, diffMeta, costMeta, callModel, activeModelConfig,
  loadKey, saveKey, estimateCost as modelEstimateCost,
} from './models.js';
/* 时间块抽屉要用它渲染「类型」下拉。agent.js 一直有引，sheets.js 漏了，
   表现是点「编辑时间块」直接 ReferenceError 白屏。 */
import { BLOCK_KINDS } from './data/automation.js';
import { CARD_TYPES, CARD_STATUS, CARD_TEMPLATES, cardProgress, cardStatus, cardUrgency } from './data/membership.js';
import { STAGES as PSY_STAGES, PRINCIPLES, CLIENT_STATES, STATE_BY_ID, QUALITY_CHECKS, nextMove } from './data/psychology.js';
import { RULES, ruleConfig, command } from './agentEngine.js';
import { openReachResultSheet, redactPII } from './outreach.js';
import { ensureConsent, hasConsent } from './consent.js';
import { openAiMaterialSheet } from './aiMaterial.js';

const STATUS_LABEL = { connected: '已连接', pending: '待授权', unauthorized: '未授权', error: '异常' };

/** 把一条跟进记录的心理存档转成可读文本（也给 AI 任务包用）
    始终输出真实姓名 —— 脱敏只在外发端口（doModelCall 的 redactPII）做。 */
function psychLine(f) {
  const st = PSY_STAGES.find((x) => x.id === f.psych?.stage);
  const cs = STATE_BY_ID[f.psych?.state];
  return {
    date: f.date,
    memberId: f.memberId,
    memberName: memberById(f.memberId)?.name || '-',
    stageName: st?.name || '未记录',
    stateName: cs?.label || '未记录',
    principleNames: (f.psych?.principles || []).map((p) => PRINCIPLES.find((x) => x.id === p)?.name).filter(Boolean),
    microCommit: f.psych?.microCommit || '',
    note: f.psych?.note || '',
    failedChecks: QUALITY_CHECKS.filter((_, i) => !(f.psych?.checks || []).includes(i)),
    result: f.result,
    summary: f.summary,
    feedback: f.feedback,
  };
}
import {
  openSheet, confirmDialog, toast, field, selectField, textareaField, serialize,
  stageBadge, badge, kvRow, emptyState, notice, statCard,
} from './components.js';
import { esc, avatarHtml, fmtDate, relDay, today, d, fmtMoney, moneyFull, daysBetween, mondayOf, addMonths, pad } from './util.js';
import { PACKS, PACK_BY_ID } from './aiPacks.js';
import { computeMetrics } from './metrics.js';

const SOURCE_TEXT = {
  tri: '三体同步', douyin: '抖音', xiaohongshu: '小红书', referral: '转介绍', walkin: '自然到店', wechat: '朋友圈',
};

/**
 * 自动 vs 手动的统一标识（全站一套语言）：
 *   自动 = 系统同步回来 / 智能体算出来的信息 → 统一蓝色（--info）+「自动」角标
 *   手动 = 用户自己填写的备注、复盘 → 保持正文色 +「手动」角标
 * 颜色之外必须有文字角标，色弱用户靠角标也能分。图例见会员档案提示条。
 */
const autoV = (safeHtml) => `<span class="auto-val">${safeHtml}</span><span class="auto-chip">自动</span>`;
const manV = (safeHtml) => `${safeHtml}<span class="manual-chip">手动</span>`;

/**
 * 会员档案左上角返回按钮的「返回去向」（返回逻辑，不表现在前端）。
 *
 * 语义：智能体界面是综合入口，点各任务会调起会员管理、线上营销等详情页；
 * 这些详情页都是叠加在底层界面之上的抽屉，在抽屉里做完处理 / 修改操作后，
 * 返回就是关掉抽屉、露出底下那一屏 —— 从智能体进来的，关掉自然还是智能体界面。
 *
 * 返回按钮只显示「返回」两个字；去向（智能体 / 客户 / 运营 / 成长 / 数据）
 * 是返回逻辑，不进可见文案，只在无障碍 aria-label 里说明（如「返回（智能体）」）。
 * 行为上不做额外跳转：抽屉盖在哪屏之上，关掉就回到哪屏，返回逻辑不变。
 */
const MEMBER_DEST = {
  agent: '智能体',
  members: '客户',
  ops: '运营',
  learning: '成长',
  analytics: '数据',
};

/* ============================================================
   会员详情
   ============================================================ */
export function openMemberSheet(id, ctx, opts = {}) {
  const from = opts.from || ctx._memberFrom || ctx._tab || 'members';
  const dest = MEMBER_DEST[from] || '';
  const backTo = '返回';
  const backAria = dest ? `返回（${dest}）` : '返回';
  /* 返回按钮只显示「返回」，去向是返回逻辑、不进可见文案（只在 aria-label 里）。
     行为就是关掉抽屉（和右上角 X 一致），回到你刚才那一屏，不另写跳转动。 */
  const sheet = openSheet({
    title: '会员档案',
    subtitle: '按 F 键可快速切换标签',
    size: 'tall',
    backTo,
    backAria,
    body: `<div id="msBody"></div>`,
    onMount(el, close) {
      const body = el.querySelector('#msBody');
      let tab = ctx._memberTab || 'profile';
      const paint = () => { body.innerHTML = memberSheetBody(id, tab, ctx); };
      paint();
      el.addEventListener('click', (e) => {
        const t = e.target.closest('[data-mtab]');
        if (t) { tab = t.dataset.mtab; ctx._memberTab = tab; paint(); el.querySelector('.sheet-bd').scrollTop = 0; return; }
        const cal = e.target.closest('[data-cal]');
        if (cal) {
          const cur = (ctx._calMonth || today().slice(0, 7)) + '-01';
          ctx._calMonth = addMonths(cur, cal.dataset.cal === 'next' ? 1 : -1);
          paint();
          return;
        }
        const a = e.target.closest('[data-act]');
        if (!a) return;
        handleMemberAction(a.dataset.act, id, ctx, close, paint);
      });
    },
  });
  return sheet;
}

/* 导出是为了能在 Node 里直接渲染校验（浏览器端由 openMemberSheet 调用）。
   项目里 renderModelMarket / renderCheckinCalendar 都是同样做法：
   纯函数出 HTML，测试桩拿字符串断言，不依赖 DOM。 */
export function memberSheetBody(id, tab, ctx) {
  const m = memberById(id);
  if (!m) return emptyState('会员不存在，可能已被删除');
  const f = latestFollowup(id);
  const e = expiry(m);
  const a = activity(m);
  const p = renewalOf(id);

  const tabs = [
    ['checkin', '出勤'],
    ['profile', '档案'],
    ['card', '会籍', cardsOfMember(id).length],
    ['follow', '跟进', followupsOf(id).length],
    ['appt', '预约', appointmentsOf(id).filter((x) => daysBetween(today(), x.date) >= 0).length],
    ['renew', '续费'],
  ];

  const cmd = command(m, ctx.state);
  const pending = pendingReachOf(id);
  const hero = `
  <div class="detail-hero">
    ${avatarHtml(m.name)}
    <div style="flex:1;min-width:0">
      <h3>${esc(m.name)}</h3>
      <div class="m">
        <span>${esc(m.gender)} · ${m.age} 岁</span>
        <span>${esc(m.phone || '')}</span>
      </div>
      <div class="tag-row">
        ${stageBadge(m.stage)}
        <span class="badge ${SOURCE_TEXT[m.source] === '三体同步' ? 'b-info' : 'b-plain'}">${esc(SOURCE_TEXT[m.source] || m.source)}</span>
        ${m.cardType && m.cardType !== '未成交' ? badge(m.cardType.split('·')[0].trim(), 'b-green') : ''}
        ${e.days != null ? badge(e.label, e.key === 'expired' ? 'b-danger' : e.key === 'urgent' ? 'b-warn' : 'b-plain') : ''}
      </div>
    </div>
  </div>

  <div class="card tight" style="margin-top:12px;border-color:var(--brand-tint-2);background:var(--brand-tint)">
    <div class="between">
      <div class="small" style="font-weight:700;color:var(--brand-2)">现在最该做的动作<span class="auto-chip">自动</span></div>
      <span class="badge ${cmd.level === 1 ? 'b-danger' : cmd.level === 2 ? 'b-warn' : 'b-plain'}">优先级 ${cmd.level}</span>
    </div>
    <div style="font-size:13.5px;font-weight:680;margin-top:6px;color:var(--brand-2)">${esc(cmd.action)}</div>
    <div class="small" style="margin-top:4px;line-height:1.6;color:var(--brand-2)">为什么：${esc(cmd.why)}</div>
    <div class="tag-row" style="margin-top:7px">
      <span class="src">建议渠道 ${esc(cmd.channel)}</span>
      <span class="src">建议窗口 ${esc(cmd.window)}</span>
      ${cmd.principle ? `<span class="src qn">心理学切入 ${esc(cmd.principle.name)}</span>` : ''}
      ${cmd.psychState ? `<span class="src">上次状态 ${esc(STATE_BY_ID[cmd.psychState]?.label || '')}</span>` : ''}
    </div>
  </div>

  ${pending.length ? `
    <div class="card tight" style="margin-top:12px;border-color:var(--warn-tint);background:var(--warn-tint)">
      <div class="between">
        <div class="small" style="font-weight:700;color:var(--warn)">${esc(pending[0].date)} ${esc(reachTime(pending[0]))} 那次联系还没补结果</div>
        <button class="btn ghost sm" data-act="reach-fill:${esc(pending[0].id)}">补上</button>
      </div>
    </div>` : ''}

  ${m.phone ? `
    <div class="btn-row" style="margin-top:12px">
      <button class="btn ghost" data-act="dial:${esc(m.phone)}"><svg viewBox="0 0 24 24"><use href="#i-phone"/></svg>拨打 ${esc(m.phone)}</button>
      <button class="btn ghost" data-act="contact"><svg viewBox="0 0 24 24"><use href="#i-chat"/></svg>客户触达台</button>
    </div>` : ''}

  <div class="btn-row" style="margin-top:10px">
    <button class="btn primary narrow" data-act="follow" title="记录一次跟进"><svg viewBox="0 0 24 24"><use href="#i-plus"/></svg>跟进</button>
    <button class="btn ghost" data-act="appt"><svg viewBox="0 0 24 24"><use href="#i-calendar"/></svg>加预约</button>
    <button class="btn ghost" data-act="ai"><svg viewBox="0 0 24 24"><use href="#i-spark"/></svg>AI 话术</button>
    <button class="btn ghost" data-act="aimat-open"><svg viewBox="0 0 24 24"><use href="#i-upload"/></svg>AI 转写跟进</button>
  </div>`;

  const tabsBar = `<div class="tabs-mini">${tabs.map(([k, label, count]) =>
    `<button data-mtab="${k}" class="${tab === k ? 'on' : ''}">${esc(label)}${count != null ? `<span class="cnt">${count}</span>` : ''}</button>`).join('')}</div>`;

  let panel = '';

  if (tab === 'checkin') {
    panel = renderCheckinCalendar(m, ctx);
  }

  if (tab === 'profile') {
    panel = `
      <div class="notice info" style="margin-bottom:12px">
        <svg viewBox="0 0 24 24"><use href="#i-alert"/></svg>
        <div>
          <span class="auto-val">蓝色字段是自动的</span>：三体 / 勤鸟同步回来，或 FitFlow 按到店记录算出来；
          <span style="color:var(--ink)">带「手动」角标的是你自己登记的</span>。
          空值分两种，不能混为一谈：<strong>「未获取」= 来源系统没返回这一项</strong>；<strong>「未登记」= 需要你手动填</strong>。
          两种空都不会被填成推测值。发现同步信息不对？每张卡右下角可以<a href="javascript:void(0)" style="color:var(--info);font-weight:650" data-act="go-report">报错</a>。
        </div>
      </div>

      <div class="section-title">系统同步（自动）</div>
      ${kvRow('累计消费', m.totalPaid ? autoV(moneyFull(m.totalPaid)) : '未获取', !m.totalPaid)}
      ${kvRow('私教 / 课时', m.hasPT ? autoV(`剩余 ${m.ptLeft} / ${m.ptTotal} 节`) : '无', !m.hasPT)}
      ${kvRow('近 30 天到店', autoV(`${m.visits30 || 0} 次`))}
      ${kvRow('最近到店', m.lastVisit ? autoV(`${fmtDate(m.lastVisit, 'ymd')}（${a.label}）`) : '未获取', !m.lastVisit)}
      ${kvRow('入会日期', m.joinDate ? autoV(fmtDate(m.joinDate, 'ymd')) : '未获取', !m.joinDate)}
      ${kvRow('会籍到期', m.expireDate ? autoV(`${fmtDate(m.expireDate, 'ymd')}（${e.label}）`) : '未获取', !m.expireDate)}
      <div class="small muted" style="margin:-2px 0 10px;line-height:1.5">「会籍到期」指会员资格（这张卡的会籍）到期，与下面「会籍卡」页里每张卡的<strong>课程 / 课时有效期</strong>不是一回事：会籍管"能不能进"，课时管"还剩几节"。</div>
      ${kvRow('标签', (m.tags || []).length ? autoV(m.tags.map((t) => badge(t, 'b-plain')).join(' ')) : '无')}

      <div class="section-title">手动登记</div>
      <div class="small muted" style="margin:-2px 0 8px;line-height:1.5">训练目标、主要需求、顾虑 / 阻碍这三项，<strong>三体与勤鸟都不返回</strong>（两家系统的会员档案里没有"训练目标"这类字段），只能在本机登记，不会从来源系统同步。</div>
      ${kvRow('训练目标', (m.goals || []).length ? manV(m.goals.map(esc).join('<br/>')) : '未登记', !(m.goals || []).length)}
      ${kvRow('主要需求', (m.intents || []).length ? manV(m.intents.map(esc).join(' · ')) : '未登记', !(m.intents || []).length)}
      ${kvRow('顾虑 / 阻碍', (m.concerns || []).length ? manV(m.concerns.map(esc).join('<br/>')) : '未登记', !(m.concerns || []).length)}
      ${kvRow('我的备注', m.note ? manV(esc(m.note)) : '未登记', !m.note)}

      ${colleagueNotesHtml(m)}

      <div class="section-title">阶段流转</div>
      <div class="chips">
        ${Object.entries(STAGES).map(([k, v]) => `<button class="chip ${m.stage === k ? 'on' : ''}" data-act="stage:${k}">${esc(v.label)}</button>`).join('')}
      </div>

      <div class="section-title">档案操作</div>
      <div class="btn-row">
        <button class="btn ghost" data-act="edit">编辑会员资料</button>
        ${m.lost
          ? `<button class="btn ghost" data-act="unlost"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg>恢复档案</button>`
          : `<button class="btn danger" data-act="lost">登记流失</button>`}
      </div>
      ${m.lost ? `<div class="notice warn" style="margin-top:8px"><svg viewBox="0 0 24 24"><use href="#i-alert"/></svg><div>已于 <strong>${esc(m.lostAt || '—')}</strong> 标记登记流失${m.lostReason ? `：${esc(m.lostReason)}` : ''}。档案、跟进、预约与历史全部保留在本机，只是不再进入名单与待办。</div></div>` : ''}
      ${renderSysSection(m, id, ctx)}`;
  }

  if (tab === 'card') {
    const list = cardsOfMember(id);
    const sumRow = list.reduce((a, c) => {
      a.paid += c.paidPrice || 0;
      if (c.typeId === 'pt' || c.typeId === 'group' || c.typeId === 'count') a.remain += c.remainCount || 0;
      if (c.typeId === 'stored') a.stored += c.remainCount || 0;
      return a;
    }, { paid: 0, remain: 0, stored: 0 });

    panel = `
      <div class="stat-grid g3" style="margin-bottom:12px">
        ${statCard({ k: '持卡数', v: list.length, unit: '张' })}
        ${statCard({ k: '剩余课时/次数', v: sumRow.remain, unit: '节' })}
        ${statCard({ k: '累计实付', v: moneyFull(sumRow.paid) })}
      </div>

      ${list.length ? list.map((c) => {
        const st = cardStatus(c);
        const u = cardUrgency(c);
        const prog = cardProgress(c);
        const origin = c.source === 'santi' ? { label: '三体同步', cls: 'tri' } : c.source === 'qinniao' ? { label: '勤鸟同步', cls: 'qn' } : { label: '本地档案', cls: '' };
        return `<div class="card tight">
          <div class="between">
            <div style="min-width:0">
              <div class="li-top"><span class="li-name">${esc(c.name)}</span><span class="badge ${st.cls}">${esc(st.label)}</span></div>
              <div class="li-meta"><span class="mono">${esc(c.cardNo)}</span><span>${esc(CARD_TYPES[c.typeId]?.label || c.typeId)}</span><span class="src ${origin.cls}">${esc(origin.label)}</span></div>
            </div>
          </div>
          <div class="divider" style="margin:10px 0"></div>
          <div class="between"><span class="small muted">进度</span><span class="small num auto-val">${Math.round(prog * 100)}%<span class="auto-chip">自动</span></span></div>
          <div class="bar ${u.level === 1 ? 'danger' : u.level === 2 ? 'warn' : ''}" style="margin-top:5px"><i style="width:${(prog * 100).toFixed(1)}%"></i></div>
          <div class="kv" style="margin-top:8px"><div class="k">紧迫度</div><div class="v auto-val" style="color:${u.level === 1 ? 'var(--danger)' : u.level === 2 ? 'var(--warn)' : 'inherit'}">${esc(u.label)}<span class="auto-chip">自动</span></div></div>
          ${c.remainCount != null ? kvRow('剩余 / 总数', autoV(`${c.remainCount} / ${c.totalCount ?? '-'}${CARD_TYPES[c.typeId]?.unit || ''}`)) : ''}
          ${c.startDate || c.endDate ? kvRow('课程 / 课时有效期', autoV(`${c.startDate ? fmtDate(c.startDate, 'ymd') : '未激活'} 至 ${c.endDate ? fmtDate(c.endDate, 'ymd') : '不限'}`)) : ''}
          ${kvRow('实付 / 标价', autoV(`${moneyFull(c.paidPrice || 0)} / ${moneyFull(c.listPrice || 0)}`))}
          ${(c.freezeLog || []).length ? kvRow('冻结记录', autoV(c.freezeLog.map((f) => `${f.from}～${f.to || '至今'}${f.reason ? '（' + esc(f.reason) + '）' : ''}`).join('<br/>'))) : ''}
          ${c.note ? kvRow('备注', manV(esc(c.note))) : ''}
          <div class="between" style="margin-top:10px">
            <span class="small muted" style="line-height:1.5">信息有出入？来源系统同步的错漏在这里反馈</span>
            <button class="btn ghost sm" data-act="card-err:${esc(c.id)}"><svg viewBox="0 0 24 24"><use href="#i-alert"/></svg>报错</button>
          </div>
        </div>`;
      }).join('') : emptyState('这位会员名下还没有卡记录（卡种由三体 / 勤鸟实时同步）。', 'i-target')}

      ${notice('卡种信息以来源系统的实时记录为准，本页<b>只读展示</b>，不提供修改、删除、冻结等写操作。变更请到对应系统端处理。', 'info', 'i-sync')}`;
  }

  if (tab === 'follow') {
    const list = followupsOf(id);
    const withPsych = list.filter((x) => x.psych);
    panel = `
      ${renderStageJourney(m, ctx)}

      ${list.length ? `<div class="timeline">${list.map((x) => {
        const cs = STATE_BY_ID[x.psych?.state];
        const stg = PSY_STAGES.find((s) => s.id === x.psych?.stage);
        const pendingReach = x.kind === 'reach' && x.result === 'pending';
        return `
      <div class="tl-item ${pendingReach ? 'warn' : x.result === 'positive' ? 'on' : x.result === 'no_reply' ? 'warn' : ''}">
        <div class="tl-date">${fmtDate(x.date, 'ymd')}${reachTime(x) ? ' ' + esc(reachTime(x)) : ''} · ${esc(CHANNELS[x.channel]?.label || x.channel)}${stg ? ' · ' + esc(stg.name) : ''}</div>
        <div class="tl-title">${esc(x.summary)}${pendingReach ? ` <span class="src warn">${esc(RESULT_LABEL.pending)}</span>` : ''}</div>
        <div class="tl-body">客户反馈：${esc(x.feedback || (pendingReach ? '还没补' : '-'))}</div>
        <div class="tl-body" style="color:var(--ink-3)">下一步：${esc(x.nextAction || '-')}${x.nextDate ? `（约定 ${fmtDate(x.nextDate, 'md')}）` : ''}</div>
        ${pendingReach ? `<button class="btn ghost sm" style="margin-top:7px" data-act="reach-fill:${x.id}">补这次的结果</button>` : ''}
        ${x.psych ? `
          <div class="tag-row" style="margin-top:6px">
            ${cs ? `<span class="badge b-info">状态 ${esc(cs.label)}</span>` : ''}
            ${(x.psych.principles || []).map((p) => {
              const pr = PRINCIPLES.find((y) => y.id === p);
              return pr ? `<span class="badge b-teal">${esc(pr.name)}</span>` : '';
            }).join('')}
          </div>
          ${x.psych.microCommit ? `<div class="small" style="margin-top:5px">微承诺：${esc(x.psych.microCommit)}</div>` : ''}
          ${x.psych.note ? `<div class="small muted" style="margin-top:4px;line-height:1.6">我的复盘：${esc(x.psych.note)}</div>` : ''}
          <button class="btn ghost sm" style="margin-top:7px" data-act="psych-edit:${x.id}">编辑心理存档</button>
        ` : `<button class="btn ghost sm" style="margin-top:7px" data-act="psych-edit:${x.id}">补上心理存档</button>`}
      </div>`;
      }).join('')}</div>`
      : emptyState('还没有跟进记录。第一次沟通后立刻记下来，队列才不会失控。', 'i-chat')}
      ${followupsOf(id).length ? `<button class="btn ghost block" style="margin-top:8px" data-act="writeback"><svg viewBox="0 0 24 24"><use href="#i-sync"/></svg>回写到三体 / 勤鸟</button>` : ''}
      <button class="btn primary block" style="margin-top:12px" data-act="follow"><svg viewBox="0 0 24 24"><use href="#i-plus"/></svg>新增跟进记录</button>
      <div class="section-title" style="margin-top:16px">AI 转写跟进（可选方式）</div>
      ${renderAiMaterialPanel(id)}`;
  }

  if (tab === 'appt') {
    const list = appointmentsOf(id);
    panel = `${list.length ? `<div class="list">${list.map((x) => {
      const st = APPT_STATUS[x.status] || APPT_STATUS.pending;
      const past = daysBetween(today(), x.date) < 0;
      return `<div class="list-item" style="opacity:${past ? .62 : 1}">
        <div class="li-body">
          <div class="li-top"><span class="li-name">${esc(x.type)}</span>${badge(st.label, st.cls)}</div>
          <div class="li-meta"><span>${fmtDate(x.date, 'md')} ${esc(x.time)}（${relDay(x.date)}）</span><span>${esc(x.coach || '')}</span></div>
          ${x.note ? `<div class="li-meta" style="color:var(--ink-2)">${esc(x.note)}</div>` : ''}
          ${!past && x.status !== 'canceled' ? `<div class="btn-row" style="margin-top:7px">
            ${x.status === 'pending' ? `<button class="btn sm ghost" data-act="appt-ok:${x.id}">确认预约</button>` : ''}
            ${x.status !== 'arrived' ? `<button class="btn sm ghost" data-act="appt-arrived:${x.id}">标记到店</button>` : ''}
            ${x.status !== 'noshow' ? `<button class="btn sm ghost" data-act="appt-noshow:${x.id}">爽约</button>` : ''}
          </div>` : ''}
        </div></div>`;
    }).join('')}</div>` : emptyState('暂无预约记录', 'i-calendar')}
      <button class="btn primary block" style="margin-top:12px" data-act="appt"><svg viewBox="0 0 24 24"><use href="#i-plus"/></svg>新建预约</button>`;
  }

  /* 系统数据并入「档案」一栏：来源系统的原始字段 + 本地记录，
     用 section-title 与上面的自动/手动分组清晰隔开，不再单独占一个 tab。
     「未获取」原因必须逐字段写清，绝不用推测值补空。 */
  function renderSysSection(m, id, ctx) {
    const origin = originOf(m);
    const prov = origin.id === 'manual' ? null : getProvider(origin.id);
    const conn = origin.id === 'manual' ? null : ctx.state.connectors[origin.id];
    const remoteId = m.triId || m.qinniaoId || null;

    /* 每个字段"拿不到"的原因必须写清楚，不能含糊成空白 */
    const NOTES = {
      santi: {
        '订单 / 收款流水': '接口路径待核对（当前状态：待授权）',
        '预约记录': '官方说明可查预约，但要等网关授权；现用FitFlow 内自建预约',
        '退款记录': '本工作台不纳入退款口径',
        '体测数据': '不在官方说明的查询范围内',
      },
      qinniao: {
        '订单 / 收款流水': '需先向勤鸟开通开放平台，端点待核对',
        '预约记录': '需先开通开放平台，端点待核对',
        '退款记录': '需先开通开放平台，端点待核对',
        '体测数据': '勤鸟有智能体测仪，数据需在其后台导出后导入',
      },
    };

    const rows = prov ? [
      ['会员 ID', remoteId, '关联键，用于去重与更新'],
      ['姓名', m.name, ''],
      ['手机号', m.phone, ''],
      ['会籍 / 卡种', m.cardType !== '未成交' ? m.cardType : null, '原样保留对方系统的会籍名称'],
      ['会籍到期日', m.expireDate, ''],
      ['建档日期', m.registeredAt ? fmtDate(m.registeredAt, 'ymd') : null, '三体 / 勤鸟建档日期代表该会员开始到店运动，与会籍卡生效不是一回事'],
      ['剩余课时', m.hasPT ? `${m.ptLeft} / ${m.ptTotal}` : null, m.hasPT ? '' : '该会员没有课时包'],
      ['入场 / 到店记录', m.lastVisit ? `${m.lastVisit}（近 30 天 ${m.visits30 || 0} 次）` : null, ''],
      ['订单 / 收款流水', null, NOTES[origin.id]?.['订单 / 收款流水'] || '未获取'],
      ['预约记录', null, NOTES[origin.id]?.['预约记录'] || '未获取'],
      ['退款记录', null, NOTES[origin.id]?.['退款记录'] || '未获取'],
      ['体测数据', null, NOTES[origin.id]?.['体测数据'] || '未获取'],
    ] : [    ];

    return `
      ${!prov ? notice('这位会员是<strong>自建档案</strong>，不属于任何外部系统的同步结果。上面的目标、顾虑、备注都是你自己记的。', 'info') : `
        ${notice(`档案来源：<strong>${esc(prov.name)}</strong>｜最近同步：${m.syncedAt || conn?.lastSyncAt || '未记录'}｜同步范围：${conn?.scope === 'all' ? '全店会员' : '本人负责会员'}`, 'green', 'i-sync')}
        ${conn?.status !== 'connected' ? notice(`当前授权状态：<strong>${conn?.status === 'pending' ? '待授权' : conn?.status === 'unauthorized' ? '未授权' : '异常'}</strong>。上面这些资料来自「导出表格导入」的兜底通道，不是实时接口返回值。授权接通后会改写为接口数据并更新同步时间。`, 'warn') : ''}
        <div class="section-title">${esc(prov.name)} 字段</div>
        ${rows.map(([k, v, noteText]) => `
          <div class="kv">
            <div class="k">${esc(k)}</div>
            <div class="v ${v ? '' : 'muted'}">${v ? esc(v) : '未获取'}</div>
          </div>
          ${!v && noteText ? `<div class="hint" style="margin:-4px 0 8px 102px">${esc(noteText)}</div>` : ''}
        `).join('')}
      `}

      <div class="section-title">本地记录（不来自对方系统）</div>
      ${kvRow('跟进记录', `${followupsOf(id).length} 条`)}
      ${kvRow('我的备注', m.note ? esc(m.note) : '无', !m.note)}
      ${kvRow('标签', (m.tags || []).length ? m.tags.map((x) => badge(x, 'b-plain')).join(' ') : '无')}
      <div class="hint" style="margin-top:8px">原则：对方系统能给的就读，给不了的就写「未获取」，绝不用推测值补空。</div>
      <button class="btn ghost block" style="margin-top:10px" data-act="go-data">前往数据连接</button>`;
  }

  if (tab === 'renew') {
    panel = `
      ${e.days != null && e.days <= 30 && e.days >= 0 ? notice(`距离到期还有 <strong>${e.days} 天</strong>，属于${e.key === 'urgent' ? '紧急' : '可推进'}续费窗口。`, e.key === 'urgent' ? 'danger' : 'warn') : ''}
      ${e.key === 'expired' ? notice('会籍已过期，续费口径应改为「回流」：先关心近况，再谈月卡回归。', 'danger') : ''}
      ${p ? `
        <div class="section-title">当前续费计划</div>
        ${kvRow('阶段', esc(p.stage))}
        ${p.quoteAmount
          ? `<div class="kv"><div class="k">报价</div><div class="v num">${moneyFull(p.quoteAmount)}${p.quoteAuto ? '<span class="auto-chip">自动提取</span>' : ''}</div></div>${p.quoteAuto ? `<div class="hint" style="margin:-4px 0 8px 102px">从最近一次提及报价的跟进自动提取，点「更新续费计划」可直接改为最终报价</div>` : ''}`
          : kvRow('报价', '未报价', true)}
        ${kvRow('预期成交', p.expectedAmount ? moneyFull(p.expectedAmount) : '未设置', !p.expectedAmount)}
        ${kvRow('卡点', (p.blockers || []).length ? p.blockers.map(esc).join('<br/>') : '无')}
        ${kvRow('更新于', p.updatedAt || '-')}
      ` : emptyState('还没有续费计划。临期会员应该提前 30 天建立计划，而不是到期才谈。', 'i-target')}
      <button class="btn primary block" style="margin-top:12px" data-act="renew">${p ? '更新续费计划' : '建立续费计划'}</button>
      <button class="btn ghost block" style="margin-top:8px" data-act="ai-renew"><svg viewBox="0 0 24 24"><use href="#i-spark"/></svg>生成续费方案提示词
      </button>`;
  }

  /* 布局：客户信息卡置顶，其下为 tab 切换 + 面板。
     运动日历（出勤）作为第一个 tab 子集，不再独立成左栏。 */
  return `
    <div class="member-detail">
      ${hero}
      ${tabsBar}
      ${panel}
    </div>`;
}

/**
 * 会员档案「AI 转写跟进」标签：会面转写文档的入口与归档总览。
 * 真正的上传 / 提炼 / 归档交互在 openAiMaterialSheet 里，这里只做入口与列表，
 * 避免在深抽屉里再嵌一层 drawer。
 */
function renderAiMaterialPanel(id) {
  const list = aiMaterialsOf(id);
  const extracted = list.filter((x) => x.note).length;
  return `
    ${notice('把面谈谈话的转写文档上传到这位会员名下，由 AI 提炼成「会面过程 / 结果 / 异议 / 跟进事项」四段纪要，核对后一键存为跟进记录。<strong>文档只在本机解析，只有点提炼并确认后才会外发，外发前姓名与手机号自动脱敏。</strong>', 'info', 'i-shield')}

    <div class="stat-grid g3" style="margin:12px 0">
      ${statCard({ k: '已归档资料', v: list.length, unit: '份' })}
      ${statCard({ k: '已提炼纪要', v: extracted, unit: '份' })}
      ${statCard({ k: '仅存档待提炼', v: list.length - extracted, unit: '份' })}
    </div>

    <button class="btn primary block" data-act="aimat-open"><svg viewBox="0 0 24 24"><use href="#i-upload"/></svg>上传会面转写文档</button>

    <div class="section-title">归档记录</div>
    ${list.length ? `<div class="list">${list.map((x) => `
      <div class="list-item">
        <div class="li-body">
          <div class="li-top">
            <span class="li-name">${esc(x.fileName || '粘贴的转写稿')}</span>
            ${x.note ? badge('已提炼', 'b-green') : badge('仅存档', 'b-plain')}
          </div>
          <div class="li-meta">
            <span>${esc(fmtDate(String(x.createdAt).slice(0, 10), 'ymd'))}</span>
            <span>${x.rawText.length} 字</span>
            ${x.note ? `<span>${esc(x.note.verdictText || '')}</span>` : ''}
          </div>
          ${x.note ? `<div class="small muted" style="margin-top:4px;line-height:1.55">${esc(x.note.summary)}</div>` : ''}
        </div>
      </div>`).join('')}</div>` : emptyState('还没有上传过会面转写文档。面谈时用录音转写工具录全程，导出文档后传上来。', 'i-doc')}`;
}

/**
 * 同事备注：三体 / 勤鸟的「跟进记录」对全店可见，备注人与备注内容系统里都有，
 * 这里按「备注人 + 内容」原样列出。
 *
 * 来源必须能一眼分辨，不合并成一个"备注"字段：
 *   同步（三体 / 勤鸟）—— 来源系统里别人留的，FitFlow 只读，删不掉；
 *   本地补录 —— 你自己在本机补的，可删。
 * 分不清来源，事后就无法判断一句话到底是谁留的。
 */
function colleagueNotesHtml(m) {
  const list = colleagueNotesOf(m.id);
  const SRC = {
    santi: { label: '三体同步', cls: 'tri' },
    qinniao: { label: '勤鸟同步', cls: 'qn' },
    local: { label: '本地补录', cls: '' },
  };
  return `
    <div class="section-title">同事备注 ${list.length ? `（${list.length}）` : ''}</div>
    <div class="small muted" style="margin:-2px 0 8px;line-height:1.5">别人留在这位客户名下的备注。同步来的条目只读，改与删都要回来源系统；本地补录的可以删。</div>
    ${list.length ? `<div class="list">${list.map((n) => {
      const s = SRC[n.source] || SRC.local;
      return `
      <div class="list-item">
        <div class="li-body">
          <div class="li-top">
            <span class="li-name">${esc(n.author)}</span>
            <span class="src ${s.cls}">${esc(s.label)}</span>
            ${n.source === 'local' ? `<button class="btn ghost sm" data-act="cn-del:${esc(n.id)}">删除</button>` : ''}
          </div>
          <div class="li-meta"><span>${esc(n.at || '')}</span></div>
          <div class="small" style="margin-top:4px;line-height:1.55;color:var(--ink-2)">${esc(n.text)}</div>
        </div>
      </div>`;
    }).join('')}</div>` : emptyState('还没有同事备注。三体 / 勤鸟同步回来后自动出现，也可以自己补一条。', 'i-chat')}
    <button class="btn ghost block" style="margin-top:8px" data-act="cn-add"><svg viewBox="0 0 24 24"><use href="#i-plus"/></svg>补一条同事备注</button>`;
}

/**
 * 会员档案「打卡」标签：可视化月视图日历 + 周期性统计。
 * 数据全部来自 m.checkins 真实明细（三体 / 勤鸟「到店记录」映射而来），
 * 没有明细的会员诚实展示「尚未同步」，不拿聚合字段反推补点。
 *
 * 月份导航用 [data-cal] 上一月 / 下一月，存到 ctx._calMonth（'YYYY-MM'），
 * 默认是当前月。
 */
export function renderCheckinCalendar(m, ctx) {
  const monthStr = (ctx._calMonth || today().slice(0, 7));
  const [yy, mm] = monthStr.split('-').map(Number);
  const list = checkinsOf(m.id);
  /* 建档来源标签：三体 / 勤鸟 / 自建。建档日期代表这个人在来源系统里
     开始到店运动，与名下有没有会籍卡是两件事。 */
  const regLabel = m.triId ? '三体建档' : m.qinniaoId ? '勤鸟建档' : '建档日期';
  const regSrc = m.triId ? '三体' : m.qinniaoId ? '勤鸟' : '';

  /* 没有逐日明细：诚实占位，但还把能拿到的聚合数字摆出来，不编造 */
  if (!list.length) {
    return `
      <div class="notice info" style="margin-bottom:12px">
        <svg viewBox="0 0 24 24"><use href="#i-alert"/></svg>
        <div>这位会员的<strong>逐日打卡明细尚未同步</strong>。可视化日历需要来源系统（三体 / 勤鸟）的「到店记录」接口返回每日明细，当前没有可绘制的数据。</div>
      </div>
      <div class="section-title">已获取的聚合数据</div>
      ${kvRow('近 30 天到店', `${m.visits30 || 0} 次`)}
      ${kvRow('最近到店', m.lastVisit ? `${fmtDate(m.lastVisit, 'ymd')}` : '未获取', !m.lastVisit)}
      ${m.registeredAt ? kvRow(regLabel, fmtDate(m.registeredAt, 'ymd')) : ''}
      <div class="hint" style="margin-top:10px">${m.registeredAt ? `${regSrc ? regSrc : '来源系统'}建档于 ${fmtDate(m.registeredAt, 'ymd')}，但这份建档记录里还没有逐日打卡明细。` : '来源系统里还没有这份会员的建档记录。'}接入打卡明细接口后，这里会自动变成月历 + 周期性统计。现有聚合数字如实保留，不会凭空补全。</div>`;
  }

  const stats = visitStats(m);
  const checked = new Set(list.map((c) => (c.checkinAt || '').slice(0, 10)));
  const todayStr = today();

  /* 月视图网格：周一起始。先算出当月 1 号所在周的周一，前导空格 = 距月初的天数。 */
  const firstOfMonth = `${yy}-${pad(mm)}-01`;
  const startMon = mondayOf(firstOfMonth);
  const lead = startMon ? daysBetween(startMon, firstOfMonth) : new Date(yy, mm - 1, 1).getDay();
  const daysInMonth = new Date(yy, mm, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let dnum = 1; dnum <= daysInMonth; dnum++) {
    cells.push(`${yy}-${pad(mm)}-${pad(dnum)}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
  const cellHtml = cells.map((ds) => {
    if (!ds) return `<div class="cal-cell empty"></div>`;
    const dom = Number(ds.slice(-2));
    const isOn = checked.has(ds);
    const isToday = ds === todayStr;
    const isFuture = ds > todayStr;
    const cls = ['cal-cell', isOn ? 'on' : '', isToday ? 'today' : '', isFuture ? 'future' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" title="${esc(ds)}">${dom}</div>`;
  }).join('');

  const maxMonth = Math.max(1, ...stats.monthAgg.map((x) => x.count));
  const barsHtml = stats.monthAgg.map((x) => {
    const h = maxMonth ? Math.round((x.count / maxMonth) * 100) : 0;
    const label = Number(x.ym.split('-')[1]) + '月';
    return `<div class="cal-bar-col">
      <div class="cal-bar-track"><div class="cal-bar ${x.count ? 'on' : ''}" style="height:${h}%"></div></div>
      <div class="cal-bar-num">${x.count || 0}</div>
      <div class="cal-bar-label">${label}</div>
    </div>`;
  }).join('');

  return `
    <div class="cal-wrap">
      <div class="cal-meta">
        ${m.registeredAt
          ? `<span>${regLabel} ${fmtDate(m.registeredAt, 'ymd')}</span><span class="sep">·</span><span>建档至今 ${daysBetween(m.registeredAt, today())} 天</span><span class="sep">·</span><span>累计打卡 ${stats.total} 次</span>`
          : `<span>累计打卡 ${stats.total} 次</span>`}
      </div>
      <div class="cal-head between">
        <button class="btn ghost sm" data-cal="prev">‹ 上月</button>
        <div class="cal-title">${yy} 年 ${mm} 月</div>
        <button class="btn ghost sm" data-cal="next">下月 ›</button>
      </div>
      <div class="cal-weekdays">
        ${WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}
      </div>
      <div class="cal-grid">${cellHtml}</div>
      <div class="cal-legend">
        <span><i class="dot on"></i>已打卡</span>
        <span><i class="dot today"></i>今天</span>
        <span class="muted">上月 / 下月用顶部按钮切换</span>
      </div>
      <div class="cal-caption">打卡即到店运动记录，来自三体 / 勤鸟建档，与名下是否持会籍卡无关。</div>

      <div class="stat-grid g4" style="margin-top:14px">
        ${statCard({ k: '本周打卡', v: stats.thisWeek, unit: '次' })}
        ${statCard({ k: '本月打卡', v: stats.thisMonth, unit: '次' })}
        ${statCard({ k: '连续打卡', v: stats.streak, unit: '天' })}
        ${statCard({ k: '周均打卡', v: (Math.round(stats.weekAvg * 10) / 10).toFixed(1), unit: '次' })}
      </div>

      <div class="section-title" style="margin-top:14px">近 6 个月打卡</div>
      <div class="cal-bars">${barsHtml}</div>
    </div>`;
}

/**
 * 关系推进阶段图（纯函数，可在 Node 里直接渲染校验）。
 * 解决的问题：原来"交互阶段轨迹"只是一串阶段名 chips，用户看不出
 *   ① 现在停在哪个阶段（位置）
 *   ② 这张图是干嘛用的（作用）
 *   ③ 对我写下一次跟进有什么帮助（对跟进的帮助）
 * 这里用一条横向推进轴把 6 个阶段铺开，走过的点亮、当前阶段高亮，
 * 并基于最新一次沟通的心理状态给出"下一步该聊什么"的具体建议。
 */
export function renderStageJourney(m, ctx) {
  const list = followupsOf(m.id);
  const withPsych = list.filter((x) => x.psych && x.psych.stage);
  if (!withPsych.length) return '';

  const order = PSY_STAGES.map((s) => s.id);
  const reached = [...new Set(withPsych.map((x) => x.psych.stage))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const current = reached[reached.length - 1];
  const currentStage = PSY_STAGES.find((s) => s.id === current);
  const lastPsych = withPsych[withPsych.length - 1].psych;
  const nm = lastPsych.state ? nextMove(lastPsych.state, lastPsych.stage, lastPsych.principles || []) : null;
  const microCount = withPsych.filter((x) => x.psych.microCommit).length;

  return `
    <div class="card tight journey">
      <div class="between">
        <div class="small" style="font-weight:650">关系推进阶段</div>
        <span class="badge ${currentStage?.cls || 'b-plain'}">当前：${esc(currentStage?.name || '—')}</span>
      </div>
      <div class="hint" style="margin:5px 0 12px">这条轴帮你看清"现在该聊什么"：先定位客户处在哪个阶段，再决定用哪套话术、下一步说什么。轴下方给出针对最新一次沟通的具体建议。</div>
      <div class="journey-track">
        ${PSY_STAGES.map((s) => {
          const idx = reached.indexOf(s.id);
          const isCurrent = s.id === current;
          const cls = ['j-node', idx > -1 ? 'reached' : '', isCurrent ? 'current' : ''].filter(Boolean).join(' ');
          return `<div class="${cls}">
            <div class="j-dot">${idx > -1 ? (isCurrent ? '●' : '✓') : ''}</div>
            <div class="j-name">${esc(s.name)}</div>
            <div class="j-goal">${esc(s.goal)}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="divider"></div>
      <div class="small" style="line-height:1.8">
        <span class="muted">已走过</span> <b>${reached.length}</b>/6 个阶段
        · <span class="muted">有效交互</span> <b>${withPsych.length}</b>/${list.length}
        · <span class="muted">拿到微承诺</span> <b>${microCount}</b> 次
      </div>
      <div class="card tight" style="margin-top:9px;background:var(--brand-tint)">
        <div class="small" style="font-weight:650;color:var(--brand-2)">对这次跟进的帮助</div>
        <div class="small" style="margin-top:4px;line-height:1.75;color:var(--brand-2)">
          客户现在停在「${esc(currentStage?.name || '—')}」，下一步建议：${esc(nm?.text || '先记录一次对话再判断')}。
          ${nm?.principle ? `可以试试 <b>${esc(nm.principle.name)}</b>：${esc(nm.principle.what)}` : ''}
        </div>
      </div>
    </div>`;
}

function handleMemberAction(act, id, ctx, close, paint) {
  const m = memberById(id);
  if (!m) return;

  if (act.startsWith('stage:')) {
    setMemberStage(id, act.split(':')[1]);
    toast('阶段已更新');
    paint();
    return;
  }
  if (act === 'follow' || act === 'followup') return openFollowupForm(id, ctx, paint);
  if (act === 'writeback') return openWritebackSheet(id, ctx, paint);
  if (act === 'appt') return openApptForm(null, ctx, { memberId: id, onSaved: paint });
  if (act === 'renew') return openRenewalForm(id, ctx, paint);
  if (act === 'ai') return openAiSheet('followup', id, ctx, paint);
  if (act === 'ai-renew') return openAiSheet('renew', id, ctx, paint);
  if (act === 'ai-card') return openAiSheet('card', id, ctx, paint);
  if (act === 'ai-psych') return openAiSheet('psych', id, ctx, paint);
  if (act === 'go-data') { close(); ctx.go('data'); return; }
  if (act === 'edit') return openMemberForm(id, ctx, paint);
  if (act === 'contact') return ctx.openContact(id);
  /* AI 转写跟进：上传会面转写文档 → 提炼纪要 → 存为跟进记录。
     打开的是并列抽屉，关掉回到档案页，返回逻辑与其他抽屉一致。 */
  if (act === 'aimat-open') {
    openAiMaterialSheet(id, {
      ...ctx,
      refresh: () => { paint(); ctx.refresh(); },
    });
    return;
  }

  /* 客户卡报错：档案页提示条里的入口（不带具体卡 → 让用户先到会籍页挑卡），
     和每张卡右下角的「报错」按钮 */
  if (act === 'go-report') { ctx._memberTab = 'card'; paint(); return; }
  if (act.startsWith('card-err:')) {
    return openCardErrorSheet(ctx, id, act.split(':')[1], paint);
  }

  if (act.startsWith('psych-edit:')) {
    const fid = act.split(':')[1];
    return openPsychForm(fid, ctx, paint);
  }

  /* 补一次拨号 / 微信的结果。抽屉里点，补完就地重画这一层 */
  if (act.startsWith('reach-fill:')) {
    const fid = act.split(':')[1];
    return openReachResultSheet(ctx, fid, paint);
  }

  /* 从档案里直接拨号。和触达台是同一条路径：先落记录，再交给系统电话 */
  if (act.startsWith('dial:')) {
    const phone = act.slice(5);
    const rec = logReach(id, { channel: 'phone', phone });
    toast('已记「拨出 · 结果待补」，打完回来补一句');
    location.href = `tel:${phone.replace(/[^\d+]/g, '')}`;
    paint();
    ctx.refresh();
    return;
  }

  /* 登记流失：只打标记，档案与全部历史留在本机，从名单与待办里移出。
     和「删除会员」是两件事，删除会把历史一起抹掉，这里不会。 */
  if (act === 'lost') {
    return openMemberLostSheet(m, ctx, paint, close);
  }

  /* 撤销登记流失：人放回名单，流失原因一并清掉 */
  if (act === 'unlost') {
    confirmDialog({
      title: '恢复档案',
      message: `把 <strong>${esc(m.name)}</strong> 放回日常名单，重新进入智能体首页与待跟进队列。档案从未被删除，恢复后历史全部照旧。`,
      confirmText: '恢复',
      onConfirm() { restoreMember(id); toast('已恢复，回到日常名单'); close(); ctx.refresh(); },
    });
    return;
  }

  /* 同事备注：本地补录一条（备注人 + 内容），同步来的条目在源头改，这里删不掉 */
  if (act === 'cn-add') {
    return openSheet({
      title: '补一条同事备注',
      body: `
        <div class="form-grid">
          ${field({ label: '备注人', name: 'author', value: ctx.state.settings.advisor || '', placeholder: '如：王教练', required: true })}
          ${field({ label: '日期', name: 'at', value: today(), type: 'date' })}
        </div>
        ${textareaField({ label: '备注内容', name: 'text', rows: 3, placeholder: '例：今天体测后主动问了产后修复课，报价还没给' })}
        <div class="hint" style="margin-top:-4px">这条只在 FitFlow 本机可见，标记为「本地补录」，不会写回三体 / 勤鸟。</div>
      `,
      footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存</button>`,
      onMount(el, c) {
        el.querySelector('[data-save]').onclick = () => {
          const f = serialize(el);
          if (!String(f.author || '').trim()) return toast('备注人不能为空', 'warn');
          if (!String(f.text || '').trim()) return toast('备注内容不能为空', 'warn');
          addColleagueNote(id, { author: f.author, text: f.text, at: f.at });
          toast('已补一条同事备注');
          c(); paint(); ctx.refresh();
        };
      },
    });
  }

  if (act.startsWith('cn-del:')) {
    confirmDialog({
      title: '删除这条备注',
      message: '只删本机补录的这一条，三体 / 勤鸟同步来的备注不受影响。',
      confirmText: '删除', danger: true,
      onConfirm() { deleteColleagueNote(id, act.slice(7)); toast('已删除'); paint(); ctx.refresh(); },
    });
    return;
  }

  if (act.startsWith('appt-')) {
    const [_, kind, apptId] = act.split(':');
    const map = { ok: 'confirmed', arrived: 'arrived', noshow: 'noshow' };
    setApptStatus(apptId, map[kind]);
    toast('预约状态已更新');
    paint();
    ctx.refresh({ keepSheet: true });
    return;
  }
}

/* ============================================================
   登记流失确认
   ------------------------------------------------------------
   点「登记流失」先走这一层：把后果讲清楚，再要一次确认。
   与「删除会员」的区别必须写在界面上 —— 删除会连跟进、预约、会籍卡
   一起抹掉，登记流失只打标记，历史一条不少地留在本机。
   ============================================================ */
function openMemberLostSheet(m, ctx, paint, parentClose) {
  openSheet({
    title: '标记为登记流失',
    body: `
      ${notice(`确认后 <strong>${esc(m.name)}</strong> 会从客户名单、智能体首页与待跟进队列里移出，不再产生任何待办。<br/><strong>档案、跟进记录、预约、会籍卡与全部历史一条不少地留在本机</strong>，随时可以恢复。<br/>这和「删除会员」不是一回事：删除会把上面的历史一起抹掉，登记流失不会。`, 'warn', 'i-alert')}
      ${textareaField({ label: '流失原因（选填）', name: 'reason', rows: 2, value: '', placeholder: '例：搬离本区 / 转去别家 / 明确表示不再续费', hint: '填了才能在客户池统计里复盘流失原因，不填也能确认。' })}
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn danger" data-lost-ok>确认登记流失</button>`,
    onMount(el, close) {
      el.querySelector('[data-lost-ok]').onclick = () => {
        const reason = String(el.querySelector('[name="reason"]')?.value || '').trim();
        markMemberLost(m.id, reason);
        toast('已标记为登记流失，档案仍保留在本机');
        close();
        parentClose && parentClose();
        paint && paint();
        ctx.refresh();
      };
    },
  });
}

/* ============================================================
   表单：新增 / 编辑会员
   ============================================================ */
/**
 * 编辑会员资料。
 *
 * 字段分两档，判断依据是「这份档案是不是来源系统同步来的」：
 *   ① 只读灰字 —— 档案带三体 / 勤鸟会员 ID，且这一项对方确实返回了值。
 *      改不了，因为源头在对方系统里，本地改了下次同步会被覆盖回去。
 *   ② 可编辑 —— 要么是 FitFlow 本机登记的（阶段 / 训练目标 / 需求 / 顾虑 /
 *      标签 / 备注），要么是对方没返回、允许本机补填的空字段。
 * 只读字段根本不渲染 input：光加 disabled 不够，serialize 读的是 DOM，
 * 不渲染就保证取不到值，也就不会被 undefined 覆盖回去。
 */
export function openMemberForm(id, ctx, onSaved) {
  const m = id ? memberById(id) : null;
  const v = m || { gender: '男', age: '', source: 'walkin', stage: 'lead', cardType: '未成交', intents: [], concerns: [], goals: [], tags: [] };
  /* 来源系统只认会员 ID：有 ID 就是对方系统的档案，没有就是本机自建。
     不靠"看起来像同步来的"这种印象判断。 */
  const src = m ? (m.triId ? '三体' : m.qinniaoId ? '勤鸟' : '') : '';
  const SOURCE_TEXT = {
    tri: '三体同步', douyin: '抖音', xiaohongshu: '小红书',
    referral: '转介绍', walkin: '自然到店', wechat: '朋友圈',
  };
  const ro = (has) => !!(src && has);
  const sys = ({ label, value, hint }) => `
    <div class="field sys-ro">
      <label>${esc(label)}<span class="ro-tag">${esc(src)} · 只读</span></label>
      <div class="ro-val">${value === '' || value == null ? '<span class="muted">未获取</span>' : esc(String(value))}</div>
      ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
    </div>`;

  const readOnly = [];
  const editable = [];
  /* 按字段逐个决定进哪一档：ro(判断式) 为真 → 只读；否则 → 可编辑 */
  const put = (isRo, sysHtml, editHtml) => { (isRo ? readOnly : editable).push(isRo ? sysHtml : editHtml); };

  put(ro(v.name), sys({ label: '姓名', value: v.name }),
    field({ label: '姓名', name: 'name', value: v.name || '', placeholder: '如：林嘉怡', required: true }));
  put(ro(v.phone), sys({ label: '手机号', value: v.phone }),
    field({ label: '手机号', name: 'phone', value: v.phone || '', placeholder: '11 位手机号' }));
  put(ro(v.gender), sys({ label: '性别', value: v.gender }),
    selectField({ label: '性别', name: 'gender', value: v.gender, options: ['男', '女'] }));
  put(ro(v.age), sys({ label: '年龄', value: v.age }),
    field({ label: '年龄', name: 'age', value: v.age, type: 'number' }));
  put(ro(v.source), sys({ label: '来源', value: SOURCE_TEXT[v.source] || v.source }),
    selectField({ label: '来源', name: 'source', value: v.source, options: [
      { value: 'tri', label: '三体同步' }, { value: 'douyin', label: '抖音' }, { value: 'xiaohongshu', label: '小红书' },
      { value: 'referral', label: '转介绍' }, { value: 'walkin', label: '自然到店' }, { value: 'wechat', label: '朋友圈' },
    ] }));
  put(ro(v.triId || v.qinniaoId), sys({ label: `${src || '来源系统'}会员 ID`, value: v.triId || v.qinniaoId }),
    field({ label: '三体会员 ID', name: 'triId', value: v.triId || '', placeholder: '未接入可留空' }));
  put(ro(v.cardType), sys({ label: '会籍 / 卡种', value: v.cardType }),
    field({ label: '会籍 / 卡种', name: 'cardType', value: v.cardType || '', placeholder: '如：年卡 · 私教 24 节' }));
  put(ro(v.joinDate), sys({ label: '入会日期', value: v.joinDate }),
    field({ label: '入会日期', name: 'joinDate', value: v.joinDate || '', type: 'date' }));
  put(ro(v.expireDate), sys({ label: '会籍到期', value: v.expireDate }),
    field({ label: '会籍到期', name: 'expireDate', value: v.expireDate || '', type: 'date' }));
  put(ro(v.ptTotal > 0), sys({ label: '私教总课时', value: v.ptTotal }),
    field({ label: '私教总课时', name: 'ptTotal', value: v.ptTotal || 0, type: 'number' }));
  put(ro(v.ptTotal > 0), sys({ label: '剩余课时', value: v.ptLeft }),
    field({ label: '剩余课时', name: 'ptLeft', value: v.ptLeft || 0, type: 'number' }));
  put(ro(v.totalPaid > 0), sys({ label: '累计消费', value: v.totalPaid ? moneyFull(v.totalPaid) : '' }),
    field({ label: '累计消费（元）', name: 'totalPaid', value: v.totalPaid || 0, type: 'number' }));
  put(ro(Number.isFinite(Number(v.visits30)) && src), sys({ label: '近 30 天到店', value: `${v.visits30 || 0} 次` }),
    field({ label: '近 30 天到店次数', name: 'visits30', value: v.visits30 || 0, type: 'number' }));
  put(ro(v.lastVisit), sys({ label: '最近到店', value: v.lastVisit }),
    field({ label: '最近到店', name: 'lastVisit', value: v.lastVisit || '', type: 'date' }));

  /* 阶段永远可编辑：阶段是本机对这位客户的判断，不是来源系统的字段 */
  editable.push(selectField({ label: '阶段', name: 'stage', value: v.stage, options: Object.entries(STAGES).map(([k, x]) => ({ value: k, label: x.label })) }));

  openSheet({
    title: id ? '编辑会员资料' : '新增会员 / 线索',
    size: 'tall',
    body: `
      ${src ? `${notice(`这份档案由<strong>${esc(src)}</strong>同步而来。<strong>灰字字段由来源系统维护，改不了</strong>。要改请回${esc(src)}，同步后这里自动更新。白底可编辑的字段分两类：一是 FitFlow 本机登记的（阶段、训练目标、需求、顾虑、标签、备注），二是${esc(src)}没返回、允许本机补填的空字段。`, 'info', 'i-alert')}` : ''}

      ${readOnly.length ? `
        <div class="section-title">${esc(src)}同步字段 · 只读</div>
        <div class="form-grid">${readOnly.join('')}</div>` : ''}

      <div class="section-title">${readOnly.length ? '可编辑字段' : '档案字段'}</div>
      <div class="form-grid">${editable.join('')}</div>

      <div class="section-title">本机登记（三体 / 勤鸟都不返回这三项）</div>
      ${textareaField({ label: '训练目标（每行一条）', name: 'goals', value: (v.goals || []).join('\n'), rows: 2 })}
      ${textareaField({ label: '主要需求（用、或逗号分隔）', name: 'intents', value: (v.intents || []).join('、'), rows: 1 })}
      ${textareaField({ label: '顾虑 / 阻碍（每行一条）', name: 'concerns', value: (v.concerns || []).join('\n'), rows: 2 })}
      ${textareaField({ label: '标签（逗号分隔）', name: 'tags', value: (v.tags || []).join('、'), rows: 1 })}
      ${textareaField({ label: '我的备注', name: 'note', value: v.note || '', rows: 2, hint: '只写本地可见的判断，不要写成会籍资料。' })}
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>${id ? '保存修改' : '创建档案'}</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        /* 只读字段不在 DOM 里，f 里取不到 —— 用档案里的现有值兜住，
           否则 saveMember 会把 undefined 合并进去，把同步来的值冲成空 */
        const cur = m || {};
        const pick = (k) => (f[k] !== undefined ? f[k] : cur[k]);
        if (!pick('name')) return toast('姓名不能为空', 'warn');
        const split = (s, sep) => String(s || '').split(sep).map((x) => x.trim()).filter(Boolean);
        const arrPick = (k, sep) => (f[k] !== undefined ? split(f[k], sep) : (cur[k] || []));
        const ptTotal = Number(pick('ptTotal')) || 0;
        const data = {
          name: pick('name'), phone: pick('phone'), gender: pick('gender'), age: Number(pick('age')) || null,
          source: pick('source'), stage: pick('stage'), cardType: pick('cardType') || '未成交', triId: pick('triId') || null,
          joinDate: pick('joinDate') || null, expireDate: pick('expireDate') || null,
          ptTotal, ptLeft: Number(pick('ptLeft')) || 0, hasPT: ptTotal > 0,
          totalPaid: Number(pick('totalPaid')) || 0, visits30: Number(pick('visits30')) || 0, lastVisit: pick('lastVisit') || null,
          goals: arrPick('goals', /\n/), intents: arrPick('intents', /[、,，]/), concerns: arrPick('concerns', /\n/),
          tags: arrPick('tags', /[、,，]/), note: pick('note'),
        };
        saveMember(data, id);
        toast(id ? '资料已保存' : '档案已创建');
        close();
        onSaved && onSaved();
        ctx.refresh();
      };
    },
  });
}

/* ============================================================
   表单：预约
   ============================================================ */
export function openApptForm(id, ctx, opts = {}) {
  const a = id ? ctx.state.appointments.find((x) => x.id === id) : null;
  const memberId = opts.memberId || a?.memberId || ctx.state.members[0]?.id;
  const memberOptions = ctx.state.members.map((m) => ({ value: m.id, label: `${m.name}（${STAGES[m.stage]?.label}）` }));
  openSheet({
    title: id ? '编辑预约' : '新建预约',
    body: `
      ${selectField({ label: '会员', name: 'memberId', value: memberId, options: memberOptions })}
      <div class="form-grid">
        ${field({ label: '日期', name: 'date', value: a?.date || today(), type: 'date', required: true })}
        ${field({ label: '时间', name: 'time', value: a?.time || '19:00', type: 'time', required: true })}
      </div>
      ${selectField({ label: '类型', name: 'type', value: a?.type || '体验课', options: APPT_TYPES })}
      <div class="form-grid">
        ${selectField({ label: '负责人', name: 'coach', value: a?.coach || ctx.state.settings.advisor, options: ['陈默', '王教练', '李教练'] })}
        ${selectField({ label: '状态', name: 'status', value: a?.status || 'pending', options: Object.entries(APPT_STATUS).map(([k, v]) => ({ value: k, label: v.label })) })}
      </div>
      ${textareaField({ label: '备注（到店前要准备什么）', name: 'note', rows: 2, value: a?.note || '', placeholder: '例：第一次到店，带好体测仪' })}
    `,
    footer: `${id ? '<button class="btn danger" data-del>删除</button>' : ''}
      <button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        if (!f.date || !f.time) return toast('日期与时间必填', 'warn');
        upsertAppointment(f, id);
        toast('预约已保存');
        close();
        opts.onSaved && opts.onSaved();
        ctx.refresh();
      };
      const del = el.querySelector('[data-del]');
      if (del) del.onclick = () => confirmDialog({
        title: '删除预约', message: '确认删除这条预约吗？', confirmText: '删除', danger: true,
        onConfirm() { deleteAppointment(id); close(); ctx.refresh(); },
      });
    },
  });
}

/* ============================================================
   表单：续费计划
   ============================================================ */
export function openRenewalForm(memberId, ctx, onSaved) {
  const m = memberById(memberId);
  const p = renewalOf(memberId) || {};
  openSheet({
    title: '续费计划',
    subtitle: `${esc(m?.name || '')} · 到期 ${m?.expireDate ? fmtDate(m.expireDate, 'ymd') : '未记录'}`,
    size: 'tall',
    body: `
      ${selectField({ label: '当前阶段', name: 'stage', value: p.stage || '未启动', options: ['未启动', '方案沟通', '已报价', '待付款', '已完成', '已放弃'] })}
      <div class="form-grid">
        ${field({ label: '报价金额（元）', name: 'quoteAmount', value: p.quoteAmount || '', type: 'number' })}
        ${field({ label: '预期成交（元）', name: 'expectedAmount', value: p.expectedAmount || '', type: 'number' })}
      </div>
      ${textareaField({ label: '卡点 / 阻碍（每行一条）', name: 'blockers', rows: 3, value: (p.blockers || []).join('\n'), placeholder: '例：担心续费后换教练' })}
      ${textareaField({ label: '本次推进动作', name: 'nextAction', rows: 2, placeholder: '例：今天内发两档方案，约周六面谈' })}
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存计划</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        upsertRenewal({
          stage: f.stage,
          quoteAmount: Number(f.quoteAmount) || 0,
          expectedAmount: Number(f.expectedAmount) || 0,
          blockers: String(f.blockers || '').split('\n').map((x) => x.trim()).filter(Boolean),
          dueDate: m?.expireDate || null,
          /* 手动保存即视为最终报价，清除"自动提取"标记 */
          quoteAuto: false,
          quoteFromFollowup: null,
        }, memberId);
        if (f.nextAction) {
          addFollowup({ memberId, channel: 'visit', summary: '续费计划更新：' + f.stage, feedback: f.blockers ? '卡点：' + f.blockers.replace(/\n/g, '；') : '无', result: 'neutral', nextDate: d(1), nextAction: f.nextAction });
        }
        toast('续费计划已保存');
        close();
        onSaved && onSaved();
        ctx.refresh();
      };
    },
  });
}

/* ============================================================
   表单：跟进记录（含心理学交互存档）
   ============================================================ */
/* ============================================================
   跨平台跟进回写
   ------------------------------------------------------------
   能不能自动写，只取决于一件事：目标系统有没有开放写接口。
     开放 → 接口直写
     没开放 → 生成文本 / 表格，由人完成最后一步
   两种都留痕。事后必须能回答「这条到底进没进对方系统」——
   复制了不等于写进去了，所以复制与导出的状态记的是「待人工」，不是「成功」。
   ============================================================ */

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 非安全上下文或权限被拒时退回老办法 */
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/** 导出 CSV。加 BOM 是让 Excel 认出 UTF-8，否则中文全是乱码。 */
function downloadCsv(filename, text) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 走本地代理写接口。密钥在代理进程里，前端永远不接触。 */
async function pushViaApi(providerId, methodName, payload) {
  const cap = WRITE_CAPABILITY[providerId];
  const path = cap?.gateway?.businessPath || '/api/gateway';
  const res = await fetch(`http://localhost:8787/proxy/${providerId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resource: 'followUpCreate',
      path,
      body: { method: methodName, timestamp: Math.floor(Date.now() / 1000), params: payload },
    }),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

export function openWritebackSheet(memberId, ctx, onChanged) {
  const m = memberById(memberId);
  if (!m) return;
  let providerId = ctx.state?.settings?.connectors?.primary || ctx.state?.connectors?.primary || 'santi';
  const advisor = ctx.state?.settings?.advisor || '';

  openSheet({
    title: '回写到经营系统',
    subtitle: `${esc(m.name)} · 把 FitFlow 里写好的跟进落到对方会员档案`,
    size: 'tall',
    body: `<div id="wbBody"></div>`,
    onMount(el, close) {
      const body = el.querySelector('#wbBody');
      let busy = false;
      const paint = () => { body.innerHTML = html(); };

      const html = () => {
        const cap = WRITE_CAPABILITY[providerId] || WRITE_CAPABILITY.santi;
        const r = route(providerId);
        const logs = ctx.state.writebackLogs || [];
        const list = followupsOf(memberId);

        const head = `
          <div class="section-title">目标系统</div>
          <div class="chips" data-wbgroup="provider">
            <button type="button" class="chip ${providerId === 'santi' ? 'on' : ''}" data-val="santi">三体云动</button>
            <button type="button" class="chip ${providerId === 'qinniao' ? 'on' : ''}" data-val="qinniao">勤鸟</button>
          </div>
          <div style="margin-top:10px">${
            r.blocked
              ? notice(`<strong>现在做不到「自动填写」，原因是对方没开写接口，不是这边做不到。</strong><br>${esc(cap.write.followUpCreate.basis)}<br><br><b>解锁方式：</b>${esc(cap.write.followUpCreate.unblock || '向厂商申请开放跟进写入接口')}<br><br>解锁之前，下面两条路现在就能用：` +
                `<br>① 复制文本，到对方后台的跟进框里粘贴；<br>② 导出表格，用对方的批量导入功能一次性导入。`, 'warn', 'i-alert')
              : notice(`<strong>可以接口直写。</strong>${esc(cap.write.followUpCreate.basis)}`, 'green', 'i-check')
          }</div>`;

        const rows = list.length ? `<div class="list">${list.map((f) => {
          const mine = logs.filter((x) => x.followupId === f.id && x.providerId === providerId)
            .sort((a, b) => String(b.at).localeCompare(String(a.at)));
          const last = mine[0] || null;
          const st = !last
            ? { text: '未回写', cls: 'b-plain' }
            : last.status === 'ok' ? { text: '已写入', cls: 'b-green' }
              : last.status === 'manual' ? { text: '已备好，待人工粘贴', cls: 'b-info' }
                : { text: '写入失败', cls: 'b-danger' };
          return `
            <div class="list-item">
              <div class="li-body">
                <div class="li-top">
                  <span class="li-name">${fmtDate(f.date, 'md')} ${esc(f.summary || '（无摘要）').slice(0, 40)}</span>
                  ${badge(st.text, st.cls)}
                </div>
                <div class="li-meta"><span>${esc((f.channel && CHANNELS[f.channel]?.label) || '沟通')}</span><span>${esc(RESULT_LABEL[f.result] || '')}</span></div>
                ${last ? `<div class="small muted" style="margin-top:4px">${esc(last.message || '')}</div>` : ''}
                <div class="tag-row" style="margin-top:7px">
                  <button class="btn ghost sm" data-wb="copy:${f.id}"><svg viewBox="0 0 24 24"><use href="#i-copy"/></svg>复制跟进文本</button>
                  <button class="btn ghost sm" data-wb="csv:${f.id}"><svg viewBox="0 0 24 24"><use href="#i-download"/></svg>导出这条</button>
                  ${r.blocked ? '' : `<button class="btn primary sm" data-wb="api:${f.id}">写入对方系统</button>`}
                </div>
              </div>
            </div>`;
        }).join('')}</div>` : emptyState('还没有跟进记录，先记一条再回来回写。', 'i-chat');

        const tail = `
          <div class="section-title" style="margin-top:14px">回写留痕</div>
          ${logs.length ? `<div class="list">${logs.slice(0, 30).map((x) => `
            <div class="list-item">
              <div class="li-body">
                <div class="li-top">
                  <span class="li-name">${x.providerId === 'santi' ? '三体云动' : '勤鸟'}</span>
                  ${badge(x.status === 'ok' ? '已写入' : x.status === 'manual' ? '待人工' : '失败', x.status === 'ok' ? 'b-green' : x.status === 'manual' ? 'b-info' : 'b-danger')}
                </div>
                <div class="li-meta"><span>${esc(String(x.at || '').slice(0, 16).replace('T', ' '))}</span><span>${esc(x.mode || '')}</span></div>
                ${x.message ? `<div class="small muted" style="margin-top:4px">${esc(x.message)}</div>` : ''}
              </div>
            </div>`).join('')}</div>` : `<div class="hint">还没有回写记录。</div>`}`;

        return head
          + `<div class="section-title" style="margin-top:14px">跟进记录 ${list.length} 条</div>` + rows
          + (list.length ? `<button class="btn ghost block" style="margin-top:10px" data-wb="csvall"><svg viewBox="0 0 24 24"><use href="#i-download"/></svg>导出全部为导入表格</button>` : '')
          + tail;
      };

      paint();

      el.addEventListener('click', async (e) => {
        const chip = e.target.closest('[data-wbgroup="provider"] .chip');
        if (chip) { providerId = chip.dataset.val; paint(); return; }

        const b = e.target.closest('[data-wb]');
        if (!b || busy) return;
        const [kind, fid] = String(b.dataset.wb).split(':');
        const cap = WRITE_CAPABILITY[providerId];

        if (kind === 'csvall') {
          const list = followupsOf(memberId);
          downloadCsv(`fitflow-跟进导入-${m.name}-${today()}.csv`,
            csvText(providerId, list.map((f) => ({ member: m, followup: f, advisor }))));
          list.forEach((f) => {
            if (!alreadyPushed(ctx.state.writebackLogs, providerId, f.id)) {
              addWritebackLog(logEntry({ providerId, memberId, followupId: f.id, mode: 'csv', status: 'manual', message: '已导出表格，需在对方系统完成导入' }));
            }
          });
          toast(`已导出 ${list.length} 条，状态记为「待人工」`);
          paint(); onChanged && onChanged();
          return;
        }

        const f = followupsOf(memberId).find((x) => x.id === fid);
        if (!f) return;
        const { payload } = buildFollowupPayload(providerId, { member: m, followup: f, advisor });

        if (kind === 'copy') {
          busy = true;
          const ok = await copyToClipboard(renderPasteText(providerId, { member: m, followup: f, advisor }));
          busy = false;
          if (!ok) { toast('复制失败，请手动选中文本复制', 'warn'); return; }
          if (!alreadyPushed(ctx.state.writebackLogs, providerId, f.id)) {
            addWritebackLog(logEntry({ providerId, memberId, followupId: f.id, mode: 'paste', status: 'manual', message: '已复制文本，需在对方后台粘贴确认' }));
          }
          toast('已复制。粘贴到对方后台后，这条才算真正落进去');
          paint(); onChanged && onChanged();
          return;
        }

        if (kind === 'csv') {
          downloadCsv(`fitflow-跟进-${m.name}-${f.date}.csv`, csvText(providerId, [{ member: m, followup: f, advisor }]));
          addWritebackLog(logEntry({ providerId, memberId, followupId: f.id, mode: 'csv', status: 'manual', message: '已导出表格，需在对方系统完成导入' }));
          toast('已导出');
          paint(); onChanged && onChanged();
          return;
        }

        if (kind === 'api') {
          const methodName = cap.write.followUpCreate.method;
          if (!methodName) { toast('该系统的写入方法名还没配置', 'warn'); return; }
          if (alreadyPushed(ctx.state.writebackLogs, providerId, f.id)) { toast('这条已经回写过，不重复推'); return; }
          confirmDialog({
            title: `写入${cap.name}`,
            message: `将把 ${fmtDate(f.date, 'md')} 这条跟进写入 ${esc(m.name)} 的会员档案。<br><br><b>${esc(payload[cap.fields.content] || '')}</b><br><br>写入后对方系统里会多一条跟进记录。确认吗？`,
            confirmText: '确认写入',
            onConfirm: async () => {
              busy = true;
              try {
                const { status, json } = await pushViaApi(providerId, methodName, payload);
                const ok = status < 400 && json && (json.code === 0 || json?.data?.code === 0);
                addWritebackLog(logEntry({
                  providerId, memberId, followupId: f.id, mode: 'api',
                  status: ok ? 'ok' : 'failed',
                  remoteId: ok ? (json?.data?.data?.follow_id ?? null) : null,
                  message: ok ? `写入成功 request_id=${json?.request_id || '-'}` : `写入失败 HTTP ${status}：${json?.error || json?.msg || '未知原因'}`,
                }));
                toast(ok ? '已写入对方系统' : '写入失败，已记进留痕');
              } catch (err) {
                addWritebackLog(logEntry({ providerId, memberId, followupId: f.id, mode: 'api', status: 'failed', message: `网络错误：${err.message}` }));
                toast('连不上本地代理，确认代理已启动', 'warn');
              } finally {
                busy = false; paint(); onChanged && onChanged();
              }
            },
          });
        }
      });
    },
  });
}

export function openFollowupForm(memberId, ctx, onSaved) {
  const m = memberById(memberId);
  const last = followupsOf(memberId).find((x) => x.psych);
  const pre = last?.psych || {};
  openSheet({
    title: '记录一次跟进',
    subtitle: `${esc(m?.name || '')} · ${today()} · 这次沟通之后要能回答"他现在处在哪个阶段"`,
    size: 'tall',
    body: `
      <div class="field">
        <label>沟通渠道</label>
        <div class="chips channel-bubbles" data-chipgroup="channel">
          ${CHANNEL_BUBBLES.map((k) => `<button type="button" class="chip ch-bubble ${k === 'wechat' ? 'on' : ''}" data-val="${k}"><svg viewBox="0 0 24 24" class="bi"><use href="#${CHANNELS[k].icon}"/></svg>${esc(CHANNELS[k].label)}</button>`).join('')}
        </div>
        <input type="hidden" name="channel" value="wechat"/>
        <div class="hint">一次点击即可选定沟通渠道</div>
      </div>
      ${textareaField({ label: '这次聊了什么', name: 'summary', rows: 2, placeholder: '例：发了本月体测对比，客户主动问到续费' })}
      ${textareaField({ label: '客户反馈（尽量写原话）', name: 'feedback', rows: 2, placeholder: '例：想续但担心教练换人' })}
      ${selectField({ label: '本次结果', name: 'result', value: 'neutral', options: [
        { value: 'positive', label: '正向：有明确推进' },
        { value: 'neutral', label: '中性：有回应但没定' },
        { value: 'no_reply', label: '未回复' },
        { value: 'negative', label: '负向：明确拒绝' },
      ] })}

      <div class="section-title">心理维度存档</div>
      ${notice('这一块不是为了分析客户，是为了让你自己看清"这次沟通到底是什么性质"。填完再决定下一步。', 'info', 'i-spark')}
      ${selectField({ label: '交互阶段', name: 'psychStage', value: pre.stage || 'p1', options: PSY_STAGES.map((s) => ({ value: s.id, label: `${s.name}（${s.goal}）` })) })}
      <div class="field">
        <label>客户当时的状态</label>
        <div class="chips" data-chipgroup="psychState">
          ${CLIENT_STATES.map((s) => `<button type="button" class="chip ${pre.state === s.id ? 'on' : ''}" data-val="${s.id}" title="${esc(s.hint)}">${esc(s.label)}</button>`).join('')}
        </div>
        <input type="hidden" name="psychState" value="${esc(pre.state || '')}"/>
        <div class="hint" id="stateHint">${esc(STATE_BY_ID[pre.state]?.hint || '选一个最接近的状态，附带的建议会显示在这里')}</div>
      </div>
      <div class="field">
        <label>这次用到的心理学原理（可多选）</label>
        <div class="chips" data-chipgroup="principles" data-multi="1">
          ${PRINCIPLES.map((p) => `<button type="button" class="chip ${(pre.principles || []).includes(p.id) ? 'on' : ''}" data-val="${p.id}">${esc(p.name)}</button>`).join('')}
        </div>
        <input type="hidden" name="principles" value="${esc((pre.principles || []).join(','))}"/>
        <div class="hint">不确定用了哪个就不选。宁可空着，也别给自己贴标签。</div>
      </div>
      ${field({ label: '拿到的微承诺', name: 'microCommit', value: pre.microCommit || '', placeholder: '例：答应周六下午到店看方案。没有就留空。' })}
      ${textareaField({ label: '我的复盘（这次哪里做得不对）', name: 'psychNote', value: pre.note || '', rows: 2, placeholder: '例：我问了"要不要续费"，他刚恢复联系就问钱，这是我的错' })}
      <div class="field">
        <label>交互质量自检</label>
        <div class="chips" data-chipgroup="checks" data-multi="1">
          ${QUALITY_CHECKS.map((c, i) => `<button type="button" class="chip ${(pre.checks || []).includes(i) ? 'on' : ''}" data-val="${i}" style="height:auto;padding:6px 11px;white-space:normal;text-align:left">${esc(c)}</button>`).join('')}
        </div>
        <input type="hidden" name="checks" value="${esc((pre.checks || []).join(','))}"/>
        <div class="hint">没勾上的项，会在下次「交互复盘」里被点出来。</div>
      </div>

      <div class="section-title">下一步</div>
      <div class="form-grid">
        ${field({ label: '下次跟进日期', name: 'nextDate', value: d(3), type: 'date', hint: '不填就不会进今日队列' })}
        ${field({ label: '提醒时间', name: 'remind', value: '', placeholder: '可选', attrs: 'disabled' })}
      </div>
      ${textareaField({ label: '下次要做的具体动作', name: 'nextAction', rows: 2, placeholder: '例：出两档续费方案，今天内发报价' })}
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存并进入队列</button>`,
    onMount(el, close) {
      bindChipGroups(el);
      el.querySelector('[data-chipgroup="psychState"]').addEventListener('click', (e) => {
        const b = e.target.closest('[data-val]');
        if (!b) return;
        const hint = el.querySelector('#stateHint');
        hint.textContent = STATE_BY_ID[b.dataset.val]?.hint || '';
      });

      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        if (!f.summary) return toast('先写清这次聊了什么', 'warn');
        addFollowup({
          memberId, channel: f.channel, summary: f.summary, feedback: f.feedback,
          result: f.result, nextDate: f.nextDate || null, nextAction: f.nextAction || '',
          psych: {
            stage: f.psychStage,
            state: f.psychState || null,
            principles: String(f.principles || '').split(',').filter(Boolean),
            microCommit: f.microCommit || '',
            note: f.psychNote || '',
            checks: String(f.checks || '').split(',').filter((x) => x !== '').map(Number),
          },
        });
        const nm = f.psychState ? nextMove(f.psychState, f.psychStage, String(f.principles || '').split(',').filter(Boolean)) : null;
        toast(nm?.text ? '已存档｜' + nm.text.slice(0, 18) + '…' : '已记录' + (f.nextDate ? `，将于 ${relDay(f.nextDate)} 进入队列` : ''));
        markMemberHandled(memberId);
        close();
        onSaved && onSaved();
        ctx.refresh();
      };
    },
  });
}

/** chips 组 → 隐藏 input 同步 */
function bindChipGroups(el) {
  el.querySelectorAll('[data-chipgroup]').forEach((group) => {
    const input = group.parentElement.querySelector('input[type="hidden"]');
    const multi = group.dataset.multi === '1';
    group.addEventListener('click', (e) => {
      const b = e.target.closest('[data-val]');
      if (!b) return;
      if (multi) {
        b.classList.toggle('on');
        const vals = [...group.querySelectorAll('.chip.on')].map((x) => x.dataset.val);
        input.value = vals.join(',');
      } else {
        group.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b));
        input.value = b.dataset.val;
      }
    });
  });
}

/* ============================================================
   表单：单独编辑某条跟进的心理存档
   ============================================================ */
export function openPsychForm(followupId, ctx, onSaved) {
  const f = ctx.state.followups.find((x) => x.id === followupId);
  if (!f) return toast('找不到这条记录', 'warn');
  const p = f.psych || {};
  openSheet({
    title: '编辑心理存档',
    subtitle: `${esc(memberById(f.memberId)?.name || '')} · ${f.date}`,
    size: 'tall',
    body: `
      ${notice(`这次沟通的内容：<br/>${esc(f.summary)}<br/><br/>客户反馈：${esc(f.feedback || '未记录')}`, 'info')}
      ${selectField({ label: '交互阶段', name: 'psychStage', value: p.stage || 'p1', options: PSY_STAGES.map((s) => ({ value: s.id, label: `${s.name}（${s.goal}）` })) })}
      <div class="field">
        <label>客户当时的状态</label>
        <div class="chips" data-chipgroup="psychState">
          ${CLIENT_STATES.map((s) => `<button type="button" class="chip ${p.state === s.id ? 'on' : ''}" data-val="${s.id}" title="${esc(s.hint)}">${esc(s.label)}</button>`).join('')}
        </div>
        <input type="hidden" name="psychState" value="${esc(p.state || '')}"/>
        <div class="hint">${esc(STATE_BY_ID[p.state]?.hint || '选一个最接近的状态')}</div>
      </div>
      <div class="field">
        <label>用到的心理学原理</label>
        <div class="chips" data-chipgroup="principles" data-multi="1">
          ${PRINCIPLES.map((x) => `<button type="button" class="chip ${(p.principles || []).includes(x.id) ? 'on' : ''}" data-val="${x.id}">${esc(x.name)}</button>`).join('')}
        </div>
        <input type="hidden" name="principles" value="${esc((p.principles || []).join(','))}"/>
      </div>
      ${field({ label: '拿到的微承诺', name: 'microCommit', value: p.microCommit || '' })}
      ${textareaField({ label: '我的复盘', name: 'psychNote', value: p.note || '', rows: 2 })}
      <div class="field">
        <label>交互质量自检</label>
        <div class="chips" data-chipgroup="checks" data-multi="1">
          ${QUALITY_CHECKS.map((c, i) => `<button type="button" class="chip ${(p.checks || []).includes(i) ? 'on' : ''}" data-val="${i}" style="height:auto;padding:6px 11px;white-space:normal;text-align:left">${esc(c)}</button>`).join('')}
        </div>
        <input type="hidden" name="checks" value="${esc((p.checks || []).join(','))}"/>
      </div>
      ${(() => {
        const nm = p.state ? nextMove(p.state, p.stage, p.principles || []) : null;
        return nm ? `<div class="card tight"><div class="small" style="font-weight:650">按这套存档，下一步建议</div>
          <div class="small" style="margin-top:5px;line-height:1.65">${esc(nm.text)}</div>
          ${nm.principle ? `<div class="hint" style="margin-top:6px">可以试试：<b>${esc(nm.principle.name)}</b>。${esc(nm.principle.what)}</div>` : ''}
          ${nm.principle?.say?.[0] ? `<div class="prompt-box" style="margin-top:8px"><pre>${esc(nm.principle.say.join('\n'))}</pre></div>` : ''}
        </div>` : '';
      })()}
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存存档</button>`,
    onMount(el, close) {
      bindChipGroups(el);
      el.querySelector('[data-save]').onclick = () => {
        const v = serialize(el);
        updateFollowup(followupId, {
          psych: {
            stage: v.psychStage,
            state: v.psychState || null,
            principles: String(v.principles || '').split(',').filter(Boolean),
            microCommit: v.microCommit || '',
            note: v.psychNote || '',
            checks: String(v.checks || '').split(',').filter((x) => x !== '').map(Number),
          },
        });
        toast('心理存档已保存');
        close();
        onSaved && onSaved();
        ctx.refresh();
      };
    },
  });
}

/* ============================================================
   表单：会籍卡
   ============================================================ */
export function openCardForm(cardId, preset, ctx, onSaved) {
  const c = cardId ? ctx.state.cards.find((x) => x.id === cardId) : null;
  const v = c || preset;
  const memberOptions = ctx.state.members.map((m) => ({ value: m.id, label: `${m.name}（${STAGES[m.stage]?.label}）` }));
  openSheet({
    title: cardId ? '编辑会籍卡' : '发一张新卡',
    size: 'tall',
    body: `
      ${selectField({ label: '持卡会员', name: 'memberId', value: v.memberId, options: memberOptions })}
      <div class="field">
        <label>卡种模板（点了自动填下面几项）</label>
        <div class="chips" data-tpl>
          ${CARD_TEMPLATES.map((t, i) => `<button type="button" class="chip" data-tpl-idx="${i}" style="height:auto;padding:6px 11px">${esc(t.name)}</button>`).join('')}
        </div>
      </div>
      <div class="form-grid">
        ${field({ label: '卡名称', name: 'name', value: v.name || '', placeholder: '如：年卡 / 私教 24 节', required: true })}
        ${field({ label: '卡号', name: 'cardNo', value: v.cardNo || '', placeholder: '留空自动生成' })}
      </div>
      <div class="form-grid">
        ${selectField({ label: '类型', name: 'typeId', value: v.typeId || 'term', options: Object.entries(CARD_TYPES).map(([k, t]) => ({ value: k, label: `${t.label}（按${t.unit}）` })) })}
        ${selectField({ label: '状态', name: 'status', value: v.status || 'active', options: Object.entries(CARD_STATUS).map(([k, t]) => ({ value: k, label: t.label })) })}
      </div>
      <div class="form-grid">
        ${field({ label: '购买 / 激活日期', name: 'startDate', value: v.startDate || today(), type: 'date' })}
        ${field({ label: '到期日（次数卡可留空）', name: 'endDate', value: v.endDate || '', type: 'date' })}
      </div>
      <div class="form-grid">
        ${field({ label: '总次数 / 总金额', name: 'totalCount', value: v.totalCount ?? '', type: 'number' })}
        ${field({ label: '剩余次数 / 余额', name: 'remainCount', value: v.remainCount ?? '', type: 'number' })}
      </div>
      <div class="form-grid">
        ${field({ label: '标价（元）', name: 'listPrice', value: v.listPrice ?? 0, type: 'number' })}
        ${field({ label: '实付（元）', name: 'paidPrice', value: v.paidPrice ?? 0, type: 'number', hint: '计入业绩时用实付' })}
      </div>
      ${textareaField({ label: '备注', name: 'note', value: v.note || '', rows: 2, placeholder: '例：已售未激活，提醒客户预约第一次体验' })}
      <div class="hint">卡是可以独立存在的实体。冻结、延期、转让、续卡都会留下记录，方便算清一位会员的完整消费史。</div>
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存</button>`,
    onMount(el, close) {
      el.querySelectorAll('[data-tpl-idx]').forEach((b) => {
        b.onclick = () => {
          const t = CARD_TEMPLATES[Number(b.dataset.tplIdx)];
          const set = (n, val) => { const i = el.querySelector(`[name="${n}"]`); if (i && val != null) i.value = val; };
          set('name', t.name);
          set('typeId', t.typeId);
          if (t.totalCount != null) { set('totalCount', t.totalCount); set('remainCount', t.totalCount); }
          set('listPrice', t.listPrice);
          set('paidPrice', t.listPrice);
          if (t.durationDays) {
            const x = new Date(); x.setDate(x.getDate() + t.durationDays);
            set('endDate', x.toISOString().slice(0, 10));
          }
          toast(`已套用「${t.name}」模板`);
        };
      });
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        if (!f.name) return toast('卡名称不能为空', 'warn');
        saveCard({
          memberId: f.memberId, name: f.name, cardNo: f.cardNo || undefined, typeId: f.typeId,
          status: f.status, startDate: f.startDate || null, endDate: f.endDate || null,
          totalCount: f.totalCount === '' ? null : Number(f.totalCount),
          remainCount: f.remainCount === '' ? null : Number(f.remainCount),
          listPrice: Number(f.listPrice) || 0, paidPrice: Number(f.paidPrice) || 0,
          note: f.note,
        }, cardId);
        toast(cardId ? '卡已更新' : '已发卡');
        if (!cardId) markMemberHandled(f.memberId);
        close();
        onSaved && onSaved();
        ctx.refresh();
      };
    },
  });
}

function openFreezeForm(cardId, ctx, onSaved) {
  const c = ctx.state.cards.find((x) => x.id === cardId);
  openSheet({
    title: '冻结会籍卡',
    subtitle: `${esc(c?.name || '')} · ${esc(c?.cardNo || '')}`,
    body: `
      ${notice('冻结期间不计时。解冻时FitFlow 会按实际冻结天数自动顺延到期日，不需要手动算。', 'info', 'i-sync')}
      ${field({ label: '冻结起始日', name: 'from', value: today(), type: 'date', required: true })}
      ${field({ label: '预计解冻日（可留空）', name: 'to', value: '', type: 'date' })}
      ${textareaField({ label: '冻结原因', name: 'reason', rows: 2, placeholder: '例：膝盖受伤，医生建议休息 6 周' })}
      <div class="hint">伤病、出差、孕期是常见冻结原因。记下来，解冻回访时用得上。</div>
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>确认冻结</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        if (!f.from) return toast('请选择冻结起始日', 'warn');
        freezeCard(cardId, { from: f.from, to: f.to || null, reason: f.reason });
        toast('已冻结，解冻时会自动顺延');
        close();
        onSaved && onSaved();
        ctx.refresh();
      };
    },
  });
}

function openRenewCardForm(cardId, ctx, onSaved) {
  const c = ctx.state.cards.find((x) => x.id === cardId);
  const m = memberById(c?.memberId);
  openSheet({
    title: '续卡',
    subtitle: `${esc(m?.name || '')} · 原卡 ${esc(c?.name || '')}`,
    size: 'tall',
    body: `
      ${notice(`原卡（${esc(c?.cardNo || '')}）会保留记录并标记为已到期，新卡会用「续自」关联上，这样一位会员的完整消费史不会断。`, 'info', 'i-target')}
      <div class="field">
        <label>续卡模板</label>
        <div class="chips" data-tpl>
          ${CARD_TEMPLATES.map((t, i) => `<button type="button" class="chip" data-tpl-idx="${i}" style="height:auto;padding:6px 11px">${esc(t.name)}</button>`).join('')}
        </div>
      </div>
      <div class="form-grid">
        ${field({ label: '新卡名称', name: 'name', value: c?.name || '', required: true })}
        ${field({ label: '开始日期', name: 'startDate', value: today(), type: 'date' })}
      </div>
      ${field({ label: '到期日', name: 'endDate', value: '', type: 'date', hint: '留空则按模板天数自动计算' })}
      <div class="form-grid">
        ${field({ label: '总次数 / 总金额', name: 'totalCount', value: '', type: 'number' })}
        ${field({ label: '剩余次数', name: 'remainCount', value: '', type: 'number' })}
      </div>
      <div class="form-grid">
        ${field({ label: '标价（元）', name: 'listPrice', value: '', type: 'number' })}
        ${field({ label: '实付（元）', name: 'paidPrice', value: '', type: 'number' })}
      </div>
      ${textareaField({ label: '备注', name: 'note', rows: 2, placeholder: '例：含教练更换承诺，续费价按老会员政策' })}
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>确认续卡</button>`,
    onMount(el, close) {
      let durationDays = null;
      el.querySelectorAll('[data-tpl-idx]').forEach((b) => {
        b.onclick = () => {
          const t = CARD_TEMPLATES[Number(b.dataset.tplIdx)];
          durationDays = t.durationDays || null;
          const set = (n, val) => { const i = el.querySelector(`[name="${n}"]`); if (i && val != null) i.value = val; };
          set('name', t.name);
          set('totalCount', t.totalCount ?? '');
          set('remainCount', t.totalCount ?? '');
          set('listPrice', t.listPrice);
          set('paidPrice', t.listPrice);
          if (t.durationDays) {
            const x = new Date(); x.setDate(x.getDate() + t.durationDays);
            set('endDate', x.toISOString().slice(0, 10));
          }
        };
      });
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        if (!f.name) return toast('卡名称不能为空', 'warn');
        renewCard(cardId, {
          name: f.name, startDate: f.startDate, endDate: f.endDate || null, durationDays,
          totalCount: f.totalCount === '' ? null : Number(f.totalCount),
          remainCount: f.remainCount === '' ? null : Number(f.remainCount),
          listPrice: Number(f.listPrice) || 0, paidPrice: Number(f.paidPrice) || 0, note: f.note,
        });
        toast('已续卡，原卡记录保留');
        close();
        onSaved && onSaved();
        ctx.refresh();
      };
    },
  });
}

/** 卡的快捷操作面板（从会籍卡列表进入） */
export function openCardActions(cardId, ctx, onSaved) {
  const c = ctx.state.cards.find((x) => x.id === cardId);
  if (!c) return toast('找不到这张卡', 'warn');
  const m = memberById(c.memberId);
  const st = cardStatus(c);
  const u = cardUrgency(c);
  const origin = c.source === 'santi' ? { label: '三体云动', cls: 'tri' }
    : c.source === 'qinniao' ? { label: '勤鸟', cls: 'qn' }
    : { label: '本地档案', cls: '' };
  openSheet({
    title: '会籍卡实时状态',
    subtitle: `${esc(m?.name || '')} · ${esc(c.name)} · ${esc(c.cardNo)}`,
    body: `
      <div class="card tight">
        ${kvRow('当前状态', `<span class="badge ${st.cls}">${esc(st.label)}</span>`)}
        ${kvRow('数据来源', `<span class="src ${origin.cls}">${esc(origin.label)}</span>`)}
        ${kvRow('紧迫度', esc(u.label))}
        ${kvRow('类型', esc(CARD_TYPES[c.typeId]?.label || c.typeId))}
        ${c.remainCount != null ? kvRow('剩余 / 总数', `${c.remainCount} / ${c.totalCount ?? '-'}${CARD_TYPES[c.typeId]?.unit || ''}`) : ''}
        ${kvRow('课程 / 课时有效期', `${c.startDate ? fmtDate(c.startDate, 'ymd') : '未激活'} 至 ${c.endDate ? fmtDate(c.endDate, 'ymd') : '不限'}`)}
        ${kvRow('实付 / 标价', `${moneyFull(c.paidPrice || 0)} / ${moneyFull(c.listPrice || 0)}`)}
        ${(c.freezeLog || []).length ? kvRow('冻结记录', c.freezeLog.map((f) => `${f.from}～${f.to || '至今'}${f.reason ? '（' + esc(f.reason) + '）' : ''}`).join('<br/>')) : ''}
        ${c.note ? kvRow('备注', esc(c.note)) : ''}
      </div>
      ${notice(`卡种状态以来源系统（<b>${esc(origin.label)}</b>）实时记录为准，本系统<b>只读展示</b>，不提供修改、删除、冻结等写操作。如需变更，请到对应系统端处理。`, 'info', 'i-sync')}
    `,
  });
}

/* ============================================================
   表单：客户卡报错
   同步回来的卡信息和实际对不上时，用户在这里主动挑错。
   只落工单不改卡数据 —— 卡以来源系统为准，改数要在来源端改。
   ============================================================ */
const CARD_ERR_FIELDS = [
  ['name', '卡名'], ['cardNo', '卡号'], ['type', '卡种'],
  ['remain', '剩余次数 / 课时'], ['validity', '有效期'],
  ['paid', '实付金额'], ['freeze', '冻结记录'], ['other', '其他'],
];

export function openCardErrorSheet(ctx, memberId, cardId, onSaved) {
  const m = memberById(memberId);
  const card = cardId ? ctx.state.cards.find((x) => x.id === cardId) : null;
  if (!m) return toast('先选一位会员', 'warn');
  openSheet({
    title: '客户卡报错',
    subtitle: card ? `${esc(m.name)} · ${esc(card.name)}` : esc(m.name),
    body: `
      <div class="notice info" style="margin-bottom:12px">
        <svg viewBox="0 0 24 24"><use href="#i-sync"/></svg>
        <div>卡数据以来源系统为准，这里提交的是<b>核对工单</b>：我们拿你说的正确信息去和三体 / 勤鸟对账，确认后由来源端修正。</div>
      </div>
      ${selectField({ label: '哪里不对', name: 'field', value: 'remain', options: CARD_ERR_FIELDS.map(([v, l]) => ({ value: v, label: l })) })}
      ${field({ label: '系统里显示的是', name: 'shown', value: card?.remainCount != null ? String(card.remainCount) : '', placeholder: '例：剩余 8 节' })}
      ${field({ label: '实际应该是', name: 'actual', value: '', placeholder: '例：剩余 5 节（上次核销了 3 节）' })}
      ${field({ label: '补充说明（可选）', name: 'note', value: '', placeholder: '例：9月26日私教课已核销，系统没扣次' })}
      <div class="hint">带「自动」标识的字段都来自三体 / 勤鸟同步，本系统不直接改；你提交的每一条报错都会留档，可在报错记录里追溯。</div>
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>提交报错</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        if (!f.actual) return toast('写清实际应该是多少', 'warn');
        reportCardError({
          memberId, cardId: cardId || null,
          field: f.field, shown: f.shown || '', actual: f.actual, note: f.note || '',
        });
        toast('报错已提交，我们会拿它与来源系统对账');
        close();
        if (onSaved) onSaved();
        ctx.refresh();
      };
    },
  });
}

/* ============================================================
   表单：时间块
   ============================================================ */
export function openBlockForm(ctx, blockId, opts) {
  const b = blockId ? ctx.state.dayPlan.blocks.find((x) => x.id === blockId) : null;
  const base = b?.remind || { method: 'inapp', lead: 10, sound: true, vibrate: true };
  const rm = { ...base, ...(opts && opts.method ? { method: opts.method } : {}) };
  const LEADS = [5, 10, 15, 30];
  /* 系统通知权限：浏览器原生 API 能读到当前状态，但 Web 应用不能直接跳进
     手机系统的通知设置页，只能请求授权 + 给出按平台的操作步骤。
     这里老实说明，不假装"一键跳转到系统设置"。 */
  const permState = () => {
    if (!('Notification' in window)) return { key: 'unsupported', text: '此浏览器不支持系统通知' };
    const p = Notification.permission;
    return { default: { key: 'default', text: '未授权' }, granted: { key: 'granted', text: '已授权' }, denied: { key: 'denied', text: '已拒绝' } }[p] || { key: p, text: p };
  };
  const sysGuide = () => {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return 'iOS：设置 → 通知 → Safari → 允许通知；再到「网站通知」里开启本站点。';
    if (/Android/.test(ua)) return 'Android：Chrome 右上角 ⋮ → 设置 → 网站设置 → 通知 → 允许；或在地址栏锁形图标里开启。';
    return '桌面：地址栏左侧锁形 / 调谐图标 → 网站设置 → 通知 → 允许；系统层面在「系统设置 → 通知 → 浏览器」保持开启。';
  };
  /** 申请系统通知授权。受限环境（无 Notification、headless、已拒绝）下静默失败，不抛错。 */
  const requestNotifyPerm = (cb) => {
    try {
      if (!('Notification' in window) || Notification.permission !== 'default') return;
      const r = Notification.requestPermission((p) => cb && cb());
      if (r && r.then) r.then(() => cb && cb());
    } catch { /* 忽略：无授权通道时不做任何事 */ }
  };
  openSheet({
    title: blockId ? '修改调整栏' : '加一个时间块',
    subtitle: '改时段、换类型、设提醒，一步到位',
    body: `
      <div class="section-title">日程</div>
      <div class="form-grid">
        ${field({ label: '开始', name: 'start', value: b?.start || '09:00', type: 'time' })}
        ${field({ label: '结束', name: 'end', value: b?.end || '10:00', type: 'time' })}
      </div>
      ${selectField({ label: '类型', name: 'kind', value: b?.kind || 'follow', options: Object.entries(BLOCK_KINDS).map(([k, v]) => ({ value: k, label: v.label })) })}
      ${field({ label: '这段时间做什么', name: 'title', value: b?.title || '', placeholder: '例：电话跟进黄金时段' })}

      <div class="section-title" style="margin-top:14px">提醒方式</div>
      <div class="seg" data-remind-seg>
        <button type="button" data-rm="none" class="${rm.method === 'none' ? 'on' : ''}">不提醒</button>
        <button type="button" data-rm="inapp" class="${rm.method === 'inapp' ? 'on' : ''}">应用内</button>
        <button type="button" data-rm="system" class="${rm.method === 'system' ? 'on' : ''}">系统通知</button>
      </div>
      <div id="remindOpts" style="${rm.method === 'none' ? 'display:none' : ''};margin-top:12px">
        <div class="form-grid">
          ${selectField({ label: '提前量', name: 'lead', value: String(rm.lead), options: LEADS.map((n) => ({ value: String(n), label: n + ' 分钟' })) })}
          <div class="sw-row" style="margin:0">
            <span class="sw-label">声音</span>
            <label class="sw"><input type="checkbox" name="sound" ${rm.sound ? 'checked' : ''}/><span></span></label>
          </div>
        </div>
        <div class="sw-row" style="margin-top:10px">
          <span class="sw-label">震动</span>
          <label class="sw"><input type="checkbox" name="vibrate" ${rm.vibrate ? 'checked' : ''}/><span></span></label>
        </div>
      </div>
      <div id="sysNote" class="notice info" style="${rm.method === 'system' ? '' : 'display:none'};margin-top:12px">
        <svg viewBox="0 0 24 24"><use href="#i-bell"/></svg>
        <div style="flex:1;min-width:0">
          <div style="font-weight:650;margin-bottom:3px">关联手机系统设置</div>
          <div>系统通知状态：<b id="permState">${permState().text}</b></div>
          <div class="small muted" style="margin-top:3px;line-height:1.55">选了系统通知，时间块到点会借手机系统弹窗提醒。前提是本站点已在「系统设置 → 通知」里被允许发通知。</div>
          <button class="btn ghost sm" data-sys style="margin-top:8px">去开启 / 查看步骤</button>
          <div id="sysGuide" class="small" style="display:none;margin-top:8px;line-height:1.7;color:var(--ink-2)"></div>
        </div>
      </div>
      <div class="hint" style="margin-top:12px">建议把跟进类任务放在客户接电话概率高的时段（上午 9:30-11:00、傍晚 18:30 后）。提醒只在本机本浏览器生效，换设备不跟随。</div>
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存</button>`,
    onMount(el, close) {
      const seg = el.querySelector('[data-remind-seg]');
      const opts = el.querySelector('#remindOpts');
      const sysNote = el.querySelector('#sysNote');
      const setPerm = () => { const p = el.querySelector('#permState'); if (p) p.textContent = permState().text; };

      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-rm]');
        if (!btn) return;
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === btn));
        const m = btn.dataset.rm;
        opts.style.display = m === 'none' ? 'none' : '';
        sysNote.style.display = m === 'system' ? '' : 'none';
        if (m === 'system') requestNotifyPerm(setPerm);
      });

      el.querySelector('[data-sys]').addEventListener('click', () => {
        const g = el.querySelector('#sysGuide');
        g.style.display = g.style.display === 'none' ? '' : 'none';
        g.textContent = sysGuide();
        requestNotifyPerm(setPerm);
      });

      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        if (!f.title) return toast('写清这段时间做什么', 'warn');
        const method = seg.querySelector('button.on')?.dataset.rm || 'none';
        const remind = {
          method,
          lead: parseInt(f.lead, 10) || 10,
          sound: f.sound === 'on',
          vibrate: f.vibrate === 'on',
        };
        const patch = { title: f.title, kind: f.kind, start: f.start, end: f.end, remind };
        if (blockId) ctx.updateBlock(blockId, patch);
        else ctx.addBlock(patch);
        toast('已排入今天');
        close();
        ctx.refresh();
      };
    },
  });
}

/* ============================================================
   AI 任务包抽屉
   ============================================================ */
/* 纯函数：AI 话术抽屉里的「② 选模型直接调用」区块。
   抽成纯渲染便于离线校验（headless 浏览器在本机对 ES module 的时序不稳）。 */
export function renderModelCallSection(ctx, preModel) {
  const cfg = ctx ? activeModelConfig(ctx) : { model: MODEL_BY_ID['doubao'], key: '', endpoint: '' };
  const m = cfg.model;
  return `
    <div class="section-title">② 选模型直接调用（国内可直连）</div>
    <div class="ai-master-card">
      <div class="ai-mc-row"><span class="ai-mc-label">当前接口</span><b>${esc(m.name)}</b><span class="muted">· ${esc(m.vendor)}</span></div>
      <div class="hint">模型切换与密钥统一在「AI 接口」总开关里设置，这里直接调用当前接口，无需在每个功能下单独登记。</div>
      <div class="model-call-bar">
        <button class="btn primary" data-call><svg viewBox="0 0 24 24"><use href="#i-spark"/></svg>调用模型</button>
        <button class="btn ghost" data-ai-portal>去 AI 接口总开关</button>
      </div>
      <div id="aiCallStatus" class="model-status"></div>
    </div>
    <div class="hint">浏览器页面内的 fetch 受同源策略约束：目标接口未返回允许本页域名的 CORS 响应头（Access-Control-Allow-Origin）时，响应会被浏览器拦截而读取失败。若调用失败，请用「① 复制提示词 + 打开豆包」，或把调用改到你自己的服务端 / 代理上。密钥只存本机 localStorage，绝不上传。向模型发送会员信息前会要求你单独确认。</div>`;
}

export function openAiSheet(packId, memberId, ctx, onSaved, preModel, opts) {
  const pack = PACK_BY_ID[packId] || PACKS[0];
  const member = memberId ? memberById(memberId) : null;
  const M = ctx.metrics || computeMetrics(ctx.state);
  const focusRuleId = opts?.ruleId || null;

  const buildCtx = (topic) => {
    const week = d(-7);
    const weekFollowups = ctx.state.followups.filter((f) => f.date >= week);
    const weekAppts = ctx.state.appointments.filter((a) => a.date >= week);
    const weekLeads = ctx.state.leads.filter((l) => l.createdAt >= week);
    const queue = todayQueue();
    const goal = ctx.state.goals[0];
    const funnel = ctx.funnel();
    const metricLines = [
      `线索→成交：${M.leadConv.text}`, `体验→成交：${M.trialRate.text}`,
      `目标达成：${M.goalRate.text}`, `7 天跟进达标：${M.followRate.text}`,
      `续费率（填报值）：${M.renewRate.text}`, `月均到店：${M.visitFreq.text}`,
      `平均首响：${M.firstResponse.text}`, `社群活跃：${M.groupActive.text}`,
    ].map((x) => '- ' + x).join('\n');

    /* 会员身上的卡 */
    const cards = member ? cardsOfMember(member.id) : [];
    const cardLines = cards.length ? cards.map((c) => {
      const st = cardStatus(c);
      const u = cardUrgency(c);
      return `- ${c.name}（${c.cardNo}）｜类型 ${CARD_TYPES[c.typeId]?.label || c.typeId}｜状态 ${st.label}｜` +
        (c.remainCount != null ? `剩余 ${c.remainCount}${CARD_TYPES[c.typeId]?.unit || ''}（共 ${c.totalCount ?? '-'}）｜` : '') +
        (c.endDate ? `到期 ${c.endDate}｜` : '') + `紧迫度 ${u.label}｜实付 ${c.paidPrice}`;
    }).join('\n') : (member ? '（这位会员名下没有卡记录）' : '');

    /* 最近一次带心理维度的交互 */
    let lastPsych = null;
    if (member) {
      const f = followupsOf(member.id).find((x) => x.psych);
      if (f) lastPsych = psychLine(f);
    }

    const recentPsych = ctx.state.followups
      .filter((f) => f.psych && f.date >= d(-14))
      .slice(0, 10)
      .map((x) => psychLine(x));

    /* 自动化规则运行数据（单条规则调优时只聚焦该规则） */
    const ruleLines = RULES
      .filter((r) => !focusRuleId || r.id === focusRuleId)
      .map((r) => {
        const cfg = ruleConfig(ctx.state, r.id);
        const e = r.effect || { hit30: 0, done: 0, ignored: 0 };
        return `- ${r.name}｜${cfg.on ? '已开启' : '已关闭'}｜阈值 ${JSON.stringify(cfg.params)}｜近 30 天命中 ${e.hit30}、采纳 ${e.done}、忽略 ${e.ignored}｜优先级 ${r.priority}`;
      }).join('\n');

    const todayHits = queue.length;
    const todayHitLines = queue.slice(0, 12).map((q) => `- [优先级 ${q.priority}] ${q.title}：${q.reason}`).join('\n');

    const connectorLines = [
      `- 三体云动：${STATUS_LABEL[ctx.state.connectors.santi.status]}，端点核对 ${Object.values(ctx.state.connectors.santi.endpointsVerified || {}).filter(Boolean).length}/${Object.keys(getProvider('santi').endpointSpec).length}`,
      `- 勤鸟：${STATUS_LABEL[ctx.state.connectors.qinniao.status]}，端点核对 ${Object.values(ctx.state.connectors.qinniao.endpointsVerified || {}).filter(Boolean).length}/${Object.keys(getProvider('qinniao').endpointSpec).length}`,
    ].join('\n');

    const agentLines = `近 30 天命中 ${RULES.reduce((s, r) => s + (r.effect?.hit30 || 0), 0)} 次，采纳 ${RULES.reduce((s, r) => s + (r.effect?.done || 0), 0)} 次；规则开启 ${RULES.filter((r) => ruleConfig(ctx.state, r.id).on).length}/${RULES.length}`;

    return {
      state: ctx.state, member, goal, funnel, metricLines, cardLines,
      lastPsych, recentPsych, ruleLines, todayHits, todayHitLines, connectorLines, agentLines,
      topic: topic ? { ...topic, metricText: (M[topic.metricKey] || {}).text || '-' } : null,
      weekFollowups, weekAppts, weekLeads,
      memberName: (id) => memberById(id)?.name || '-',
      queueSummary: `今日队列共 ${queue.length} 项，其中紧急 ${queue.filter((q) => q.priority === 1).length} 项`,
      weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date().getDay()],
    };
  };

  const existing = ctx.state.ai[pack.id];
  /* 提示词始终用真实数据构建 —— 界面显示完整会员信息。
     脱敏只发生在「数据交换端口」：doModelCall 真正 fetch 外发前对 prompt 调 redactPII。 */
  const buildPrompt = () => pack.build(buildCtx(ctx._aiTopic));
  let prompt = buildPrompt();

  const modelSection = renderModelCallSection(ctx, preModel);

  const renderPrompt = () => `
    <div class="prompt-box">
      <pre id="aiPromptText">${esc(prompt)}</pre>
      <div class="pb-actions">
        <button data-copy><svg viewBox="0 0 24 24"><use href="#i-copy"/></svg>复制提示词</button>
        <button data-open><svg viewBox="0 0 24 24"><use href="#i-link"/></svg>打开豆包</button>
        <button data-rebuild><svg viewBox="0 0 24 24"><use href="#i-sync"/></svg>按当前数据重建</button>
      </div>
    </div>`;

  openSheet({
    title: 'AI 任务包 · ' + pack.title,
    subtitle: '状态：<span style="color:var(--warn);font-weight:650">提示词准备</span> · FitFlow 不会替你生成分析结论',
    size: 'tall',
    body: `
      <div id="aiSwap">
        ${notice('这里的文字是<strong>给 AI 的任务说明</strong>，不是分析结果。复制到豆包网页版跑完，把回答粘回下面保存，才算完成一次 AI 协作。', 'info', 'i-spark')}
        ${member ? `<div class="spacer"></div>${badge('已带入会员：' + member.name, 'b-green')}` : ''}
        ${pack.needsMember && !member ? `<div class="spacer"></div>${notice('这个任务包需要先选一位会员，才能把真实档案带进提示词。', 'warn')}` : ''}
        ${focusRuleId ? notice(`已聚焦到规则「${esc(RULES.find((r) => r.id === focusRuleId)?.name || focusRuleId)}」。下方提示词只带入这一条规则的运行数据，AI 会针对它的阈值与优先级给建议。`, 'info', 'i-target') : ''}
        <div class="section-title">① 复制提示词</div>
        ${member ? `<div class="hint" style="margin:2px 0 6px">界面显示真实会员信息；<strong>脱敏在「调用模型 / 云端润色」真正外发时自动执行</strong>，隐去姓名与手机号，年龄、卡种、到店轨迹、身体反馈等完成任务所需信息予以保留。</div>` : ''}
        ${renderPrompt()}
        ${modelSection}
        <div class="section-title">③ 粘贴 / 回填 AI 的回答</div>
        <div class="paste-zone">
          <textarea id="aiPaste" placeholder="把 AI 的回答粘贴到这里保存；或点上方「调用模型」让它直接填进来。保存后只存在你的浏览器本地，不会上传。">${esc(existing?.text || '')}</textarea>
          <div class="hint">保存时间：${existing?.savedAt ? existing.savedAt.slice(0, 16).replace('T', ' ') : '尚未保存'}</div>
        </div>
      </div>`,
    footer: `<button class="btn ghost" data-sheet-close>关闭</button><button class="btn primary" data-save>保存 AI 结果</button>`,
    onMount(el, close) {
      el.addEventListener('click', async (e) => {
        const copy = e.target.closest('[data-copy]');
        if (copy) {
          /* 含会员信息的提示词外发前，须取得单独同意（含跨境提示） */
          if (member && !await ensureConsent('aiExport', {
            title: '确认外发会员个人信息',
            danger: true,
            body: exportConsentBody(),
          })) return;
          /* 出站脱敏：复制到剪贴板即视为向外部模型提供数据，与 doModelCall 路径
             保持一致 —— 先经 redactPII 隐去姓名（→该会员）与手机号，再写入剪贴板。
             界面预览（<pre>）保持真实，但出站复制一律脱敏。 */
          const raw = el.querySelector('#aiPromptText').textContent;
          const text = redactPII(raw, ctx.state.members);
          (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(
            () => toast('提示词已复制（已脱敏：隐去姓名与手机号），去豆包粘贴即可'),
            () => {
              const ta = document.createElement('textarea');
              ta.value = text; document.body.appendChild(ta); ta.select();
              document.execCommand('copy'); ta.remove();
              toast('提示词已复制（已脱敏）');
            }
          );
          return;
        }
        if (e.target.closest('[data-open]')) {
          if (member && !await ensureConsent('aiExport', {
            title: '确认外发会员个人信息',
            danger: true,
            body: exportConsentBody(),
          })) return;
          window.open('https://www.doubao.com/', '_blank', 'noopener');
          return;
        }
        if (e.target.closest('[data-rebuild]')) {
          prompt = buildPrompt();
          el.querySelector('#aiPromptText').textContent = prompt;
          toast('已按当前数据重建提示词');
        }
        if (e.target.closest('[data-mkt]')) {
          openModelMarket(ctx);
          return;
        }
        if (e.target.closest('[data-ai-portal]')) {
          openAiPortal(ctx);
          return;
        }
        if (e.target.closest('[data-call]')) {
          doModelCall(el, ctx);
          return;
        }
      });
      el.querySelector('[data-save]').onclick = () => {
        const text = el.querySelector('#aiPaste').value.trim();
        setAiResult(pack.id, text);
        toast(text ? 'AI 结果已保存在本地' : '已清空保存内容');
        close();
        onSaved && onSaved();
        ctx.refresh();
      };
    },
  });
}

/* 向第三方模型发送会员数据前的告知文案（含接收方、字段、跨境） */
function sendConsentBody(m) {
  return `
    <p>你即将把该会员的个人信息发送给大模型 <b>${esc(m.name)}</b>（厂商：${esc(m.vendor)}）进行处理。</p>
    <p><b>外发前自动脱敏</b>：系统会在真正发送时自动隐去会员姓名与手机号（去标识化），年龄、卡种、到店记录、训练目标、需求、顾虑、累计消费等完成任务所需的结构化字段予以保留，供模型结合行动轨迹与身体反馈给出跟进建议。</p>
    <p>该模型为<b>国内可直连</b>厂商；若你填写了自定义境外 Endpoint，数据将跨境传输至境外接收方（PIPL 第 38-39 条）。</p>
    <p class="muted">模型厂商是否将你的数据用于训练，取决于其服务条款；如不同意，请勿发送或改用本地处理。</p>
  `;
}

/* 复制 / 打开豆包前的告知（国产大模型，数据不出境） */
function exportConsentBody() {
  return `
    <p>你即将复制或粘贴含会员个人信息的提示词。粘贴到豆包等国产大模型网页版时，数据由国内厂商（字节火山方舟等）处理，<b>不出境</b>；但厂商是否将你的数据用于训练，取决于其服务条款。</p>
    <p><b>出站脱敏</b>：点「复制提示词」复制的内容会先经 redactPII 处理，自动隐去会员姓名（→"该会员"）与手机号，年龄、卡种、到店轨迹、身体反馈、备注等结构化字段予以保留；若你改为<b>手动选中上方预览文本</b>复制，则含完整真实姓名与手机号，不会被脱敏。</p>
    <p class="muted">向第三方提供个人信息须已就该会员取得单独同意；如不同意请勿粘贴。</p>
  `;
}

/* 在 AI 话术抽屉里直接调用模型，把结果回填到粘贴区。
   模型与密钥统一来自「AI 接口」总开关（activeModelConfig），不在本抽屉内单独登记。 */
async function doModelCall(el, ctx) {
  const status = el.querySelector('#aiCallStatus');
  const cfg = activeModelConfig(ctx);
  const m = cfg.model;
  const apiKey = cfg.key;
  const endpoint = cfg.endpoint;
  if (!apiKey) {
    status.className = 'model-status is-err';
    status.textContent = '请先在「AI 接口」总开关里配置当前模型的密钥（点下方「去 AI 接口总开关」）。';
    return;
  }
  /* 外发会员数据前，必须取得单独同意（PIPL 第 23 / 28 / 29 条） */
  const ok = await ensureConsent('aiSend', {
    title: '确认调用模型（外发会员信息）',
    danger: true,
    body: sendConsentBody(m),
  });
  if (!ok) {
    status.className = 'model-status is-err';
    status.textContent = '已取消发送：未获得向第三方提供会员信息的单独同意。';
    return;
  }

  const prompt = el.querySelector('#aiPromptText').textContent;
  /* 数据交换端口脱敏：真正外发前，把提示词里的会员姓名替换为「该会员」、手机号打码。
     界面上的提示词预览仍是真实数据，不受影响。 */
  const outboundPrompt = redactPII(prompt, ctx.state.members);
  status.className = 'model-status is-loading';
  status.textContent = `正在调用 ${m.name} …（约 1–15 秒；跨域请求需目标接口返回 CORS 头，否则浏览器会拦截响应）`;
  const btn = el.querySelector('[data-call]');
  /* 长跑按钮：disabled 与 is-loading 成对开关（is-loading 出旋转圈并隐藏原图标）。
     成功、失败两条路径都要解锁，所以抽成一个 setBusy 统一切换，避免漏掉一侧。 */
  const setBusy = (on) => { if (!btn) return; btn.disabled = on; btn.classList.toggle('is-loading', on); };
  setBusy(true);

  callModel(m.id, { prompt: outboundPrompt, apiKey, endpoint })
    .then((r) => {
      setBusy(false);
      if (r.ok) {
        el.querySelector('#aiPaste').value = r.text;
        const est = modelEstimateCost(m, outboundPrompt.length, 800);
        status.className = 'model-status is-ok';
        status.textContent = `✓ ${m.name} 已返回，结果已填入下方。预估本次约 ¥${est.yuan.toFixed(4)}（约 ${est.inTok} 输入 token）。`;
        toast('模型已返回，结果已回填');
      } else {
        status.className = 'model-status is-err';
        status.textContent = '✗ ' + r.error;
      }
    })
    .catch((e) => {
      setBusy(false);
      status.className = 'model-status is-err';
      status.textContent = '✗ ' + (e?.message || String(e));
    });
}

/* ============================================================
   AI 任务包列表（从顶栏或页面进入）
   ============================================================ */
export function openAiHub(ctx, preTopic) {
  openSheet({
    title: 'AI 辅助工作流',
    subtitle: `${PACKS.length} 个任务包 · 复制提示词 → 外部 AI 跑 → 粘回保存`,
    size: 'tall',
    body: `
      ${notice('FitFlow 只负责把「数据 + 任务说明」整理成结构化提示词。所有分析结论都来自你自己使用的 AI 工具，FitFlow 不会生成也<b>不会伪造</b> AI 结论。', 'info', 'i-spark')}
      <div class="ai-hub-banner" data-mkt>
        <div class="aihb-l">
          <div class="icon-btn" style="width:30px;height:30px;background:var(--info-tint);color:var(--info)"><svg viewBox="0 0 24 24"><use href="#i-spark"/></svg></div>
          <div>
            <div class="t">可调用模型 · 查询代价与难易程度</div>
            <div class="small muted">${MODELS.length} 个国内可直接调用热门模型，含调用代价、接入难度与直连方式</div>
          </div>
        </div>
        <svg class="chev" viewBox="0 0 24 24"><use href="#i-chev"/></svg>
      </div>
      ${PACKS.map((p) => {
        const saved = ctx.state.ai[p.id];
        return `<div class="ai-pack" data-pack="${p.id}">
          <div class="ai-pack-hd">
            <div class="icon-btn" style="width:30px;height:30px;background:var(--brand-tint);color:var(--brand-2)">
              <svg viewBox="0 0 24 24"><use href="#${p.icon}"/></svg>
            </div>
            <div class="t">${esc(p.title)}</div>
            ${saved ? badge('已保存结果', 'b-green') : badge('提示词准备', 'b-plain')}
          </div>
          <div class="small muted" style="margin-top:6px;line-height:1.6">${esc(p.desc)}</div>
          ${saved ? `<div class="small" style="margin-top:6px;color:var(--ink-3)">上次保存：${saved.savedAt.slice(0, 16).replace('T', ' ')}</div>` : ''}
        </div>`;
      }).join('')}
    `,
    onMount(el, close) {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-mkt]')) { close(); setTimeout(() => openAiPortal(ctx), 120); return; }
        const card = e.target.closest('[data-pack]');
        if (!card) return;
        const pre = ctx._preModel || null;
        ctx._preModel = null;
        close();
        setTimeout(() => openAiSheet(card.dataset.pack, null, ctx, null, pre), 120);
      });
    },
  });
}

/* 难度刻度条：1–5 段，fill 到 level */
function diffBar(level) {
  const meta = diffMeta(level);
  let segs = '';
  for (let i = 1; i <= 5; i++) segs += `<span class="dm-seg ${i <= level ? 'on ' + meta.cls : ''}"></span>`;
  return `<div class="diff-meter" title="接入难度：${meta.label}">${segs}<span class="dm-label">${meta.label}</span></div>`;
}

/* ============================================================
   可调用模型市场：查询模型 + 阐述调用代价与难易程度
   ============================================================ */
/* 纯函数：可调用模型市场的内容（查询 + 调用代价 + 接入难度）。抽成纯渲染便于离线校验。 */
export function renderModelMarket() {
  return `
      ${notice('调用代价与难易程度以 2026-09 各官网公示为准，价格持续波动，仅作量级参考。浏览器页面内 fetch 受同源策略约束，目标接口未返回 CORS 头（Access-Control-Allow-Origin）时响应会被拦截，请改用「复制提示词 + 网页版」或自建服务端 / 代理。API Key 只存本机，绝不上传。', 'info', 'i-spark')}
      <div class="model-list">
        ${MODELS.map((m) => {
          const cm = costMeta(m.costTier);
          const dm = diffMeta(m.difficulty);
          return `<div class="model-card">
            <div class="mc-hd">
              <div class="mc-title">${esc(m.name)}</div>
              <div class="mc-vendor">${esc(m.vendor)}</div>
              ${m.recommended ? badge('推荐', 'b-green') : ''}
              ${m.callable ? badge('可直连', 'b-info') : badge('网页版', 'b-plain')}
            </div>
            <div class="mc-flag">${esc(m.flagship)} · 上下文 ${esc(m.ctx)}</div>
            <div class="mc-block">
              <div class="mc-blk-h">① 调用代价</div>
              <div class="mc-cost-row">
                <span class="cost-badge ${cm.cls}">成本 ${cm.label}</span>
                <span class="mc-price">约 ¥${m.input} / ¥${m.output} 每百万 tokens（输入 / 输出）</span>
              </div>
              <div class="mc-free">免费额度：${esc(m.free)}</div>
            </div>
            <div class="mc-block">
              <div class="mc-blk-h">② 接入难易程度</div>
              ${diffBar(m.difficulty)}
              <div class="mc-diff-desc">${esc(dm.desc)}</div>
            </div>
            <div class="mc-block">
              <div class="mc-blk-h">③ 接入方式</div>
              <div class="mc-auth">${esc(m.auth)}</div>
              <div class="mc-endpoint">${esc(m.endpoint)}/chat/completions</div>
              <div class="mc-strength">擅长：${esc(m.strength)}</div>
              <div class="mc-note">注：${esc(m.note)}</div>
            </div>
            <div class="mc-actions">
              <button class="btn primary sm" data-use="${m.id}">用这个模型跑话术</button>
              <button class="btn ghost sm" data-go="${esc(m.webUrl)}">去开通 / 文档</button>
            </div>
          </div>`;
        }).join('')}
      </div>`;
}

export function openModelMarket(ctx) {
  openSheet({
    title: '可调用模型',
    subtitle: `${MODELS.length} 个国内可直接调用热门模型 · 调用代价与接入难度`,
    size: 'tall',
    body: renderModelMarket(),
    footer: `<button class="btn ghost" data-sheet-close>关闭</button>`,
    onMount(el, close) {
      el.addEventListener('click', (e) => {
        const use = e.target.closest('[data-use]');
        if (use) { ctx._preModel = use.dataset.use; close(); setTimeout(() => openAiHub(ctx), 120); return; }
        const go = e.target.closest('[data-go]');
        if (go) { window.open(go.dataset.go, '_blank', 'noopener'); return; }
      });
    },
  });
}

/* ============================================================
   AI 接口总开关：所有功能共用的唯一模型 / 密钥配置入口。
   模型切换与 key / endpoint 填写只发生在这里；各功能（任务包调用、
   云端润色、会面转写）一律读 activeModelConfig，不在各自界面单独登记。
   ============================================================ */
export function aiPortalBody(ctx) {
  const cfg = activeModelConfig(ctx);
  const activeId = cfg.id;
  const rec = loadKey(activeId);
  const modelOpts = MODELS.map((m) =>
    `<option value="${m.id}"${m.id === activeId ? ' selected' : ''}>${esc(m.name)} · ${esc(m.vendor)}</option>`).join('');
  return `
    ${notice('所有 AI 功能（任务包调用、云端润色、会面转写）共用这一个接口配置。模型切换与密钥只在这里设置，不在各功能里单独登记。', 'info', 'i-plug')}
    <div class="section-title">总开关 · 当前接口</div>
    <div class="model-call">
      <div class="form-grid">
        <div class="fg-col">
          <label class="fld-label">激活模型</label>
          <select id="aiActive">${modelOpts}</select>
        </div>
      </div>
      <div class="form-grid">
        <div class="fg-col">
          <label class="fld-label">API Key <span class="muted">（仅存本机）</span></label>
          <input id="aiKey" type="password" placeholder="粘贴你的模型 API Key" value="${esc(rec.key)}" autocomplete="off" />
        </div>
      </div>
      <details class="model-adv">
        <summary>高级：自定义调用地址</summary>
        <div class="form-grid">
          <div class="fg-col">
            <label class="fld-label">Endpoint（留空用默认）</label>
            <input id="aiEndpoint" placeholder="https://..." value="${esc(rec.endpoint)}" />
          </div>
        </div>
      </details>
      <div class="model-call-bar">
        <button class="btn primary" data-save-key>保存到总开关</button>
        <button class="btn ghost" data-open-doubao><svg viewBox="0 0 24 24"><use href="#i-link"/></svg>打开豆包</button>
      </div>
      <div id="aiPortalStatus" class="model-status"></div>
    </div>
    <div class="section-title">可调用模型 · 代价与难易</div>
    ${renderModelMarket()}`;
}

export function openAiPortal(ctx) {
  openSheet({
    title: 'AI 接口 · 总开关',
    subtitle: '模型切换与密钥只在这里设置，所有功能共用',
    size: 'tall',
    body: aiPortalBody(ctx),
    footer: `<button class="btn ghost" data-sheet-close>关闭</button>`,
    onMount(el) {
      const status = el.querySelector('#aiPortalStatus');
      const setStatus = (cls, txt) => { if (status) { status.className = 'model-status ' + cls; status.textContent = txt; } };
      const activeSel = el.querySelector('#aiActive');

      if (activeSel) activeSel.onchange = () => {
        const id = activeSel.value;
        saveSettings({ ai: { ...(ctx.state.settings?.ai || {}), activeModelId: id } });
        const r = loadKey(id);
        el.querySelector('#aiKey').value = r.key || '';
        el.querySelector('#aiEndpoint').value = r.endpoint || '';
        setStatus('', '已切换到 ' + (MODEL_BY_ID[id]?.name || id) + '，填入它的密钥后点保存');
      };

      const saveBtn = el.querySelector('[data-save-key]');
      if (saveBtn) saveBtn.onclick = () => {
        const id = activeSel?.value || activeModelConfig(ctx).id;
        const key = el.querySelector('#aiKey').value.trim();
        const endpoint = el.querySelector('#aiEndpoint').value.trim();
        if (!key) { setStatus('is-err', '请先填 API Key 再保存'); return; }
        saveSettings({ ai: { ...(ctx.state.settings?.ai || {}), activeModelId: id } });
        saveKey(id, key, endpoint);
        setStatus('is-ok', `✓ 已保存到总开关：${MODEL_BY_ID[id]?.name || id}（密钥仅存本机）`);
        toast('AI 接口已更新');
        ctx.refresh();
      };

      const db = el.querySelector('[data-open-doubao]');
      if (db) db.onclick = () => window.open('https://www.doubao.com/', '_blank', 'noopener');

      el.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => window.open(b.dataset.go, '_blank', 'noopener'); });
      el.querySelectorAll('[data-use]').forEach((b) => {
        b.onclick = () => { if (activeSel) { activeSel.value = b.dataset.use; activeSel.dispatchEvent(new Event('change')); } };
      });
    },
  });
}

/* ============================================================
   表单：社群周计划内容
   ============================================================ */
const DAY_NAMES = ['每日', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const PLAN_STATUS = [
  { value: 'todo', label: '待发' },
  { value: 'doing', label: '进行中' },
  { value: 'done', label: '已完成' },
];

export function openGroupPlanForm(groupId, ctx, index) {
  const g = ctx.state.groups.find((x) => x.id === groupId);
  if (!g) return toast('找不到这个社群', 'warn');
  const item = index != null ? g.weeklyPlan?.[index] : null;
  openSheet({
    title: item ? '编辑内容项' : '加一条内容',
    subtitle: `${esc(g.name)} · ${esc(g.cadence || '')}`,
    body: `
      <div class="form-grid">
        ${selectField({ label: '放在哪天', name: 'day', value: item?.day || '周一', options: DAY_NAMES })}
        ${selectField({ label: '状态', name: 'status', value: item?.status || 'todo', options: PLAN_STATUS })}
      </div>
      ${field({ label: '内容主题', name: 'topic', value: item?.topic || '', placeholder: '例：会员案例：8 周变化图' })}
      ${field({ label: '负责人', name: 'owner', value: item?.owner || ctx.state.settings.advisor })}
      <div class="hint">群冷掉是渐进的。每周至少 3 条有效内容，其中 1 条必须是会员自己的成果。</div>
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        if (!f.topic) return toast('写清这条内容讲什么', 'warn');
        upsertGroupPlanItem(groupId, f, index);
        toast(item ? '内容已更新' : '已排入周内容日历');
        close();
        ctx.refresh();
      };
    },
  });
}

/* ============================================================
   表单：线上营销内容
   ============================================================ */
const PLATFORMS = ['抖音', '小红书', '视频号', '朋友圈', '私域', '其他'];
const FORMATS = ['短视频', '图文', '直播', '活动海报', '群 + 私信', '其他'];
const CAMP_STATUS = ['已发布', '进行中', '数据观察中', '草稿'];

export function openCampaignForm(id, ctx) {
  const c = id ? ctx.state.campaigns.find((x) => x.id === id) : null;
  openSheet({
    title: id ? '编辑内容' : '登记一条内容',
    subtitle: '内容的目标只有一个：让对的人来私信你',
    size: 'tall',
    body: `
      ${field({ label: '标题 / 选题', name: 'title', value: c?.title || '', placeholder: '例：膝盖疼还能练腿吗（3 个替代动作）', required: true })}
      <div class="form-grid">
        ${selectField({ label: '平台', name: 'platform', value: c?.platform || '抖音', options: PLATFORMS })}
        ${selectField({ label: '形式', name: 'format', value: c?.format || '短视频', options: FORMATS })}
      </div>
      <div class="form-grid">
        ${field({ label: '发布日期', name: 'publishedAt', value: c?.publishedAt || today(), type: 'date' })}
        ${selectField({ label: '状态', name: 'status', value: c?.status || '已发布', options: CAMP_STATUS })}
      </div>
      <div class="divider"></div>
      <div class="small" style="font-weight:650;margin-bottom:9px">数据回填（发布后 48 小时再看，短期数据会骗人）</div>
      <div class="form-grid">
        ${field({ label: '播放 / 曝光', name: 'views', value: c?.views ?? '', type: 'number' })}
        ${field({ label: '点赞', name: 'likes', value: c?.likes ?? '', type: 'number' })}
      </div>
      <div class="form-grid">
        ${field({ label: '评论', name: 'comments', value: c?.comments ?? '', type: 'number' })}
        ${field({ label: '投放花费（元）', name: 'spend', value: c?.spend ?? '', type: 'number' })}
      </div>
      <div class="form-grid">
        ${field({ label: '私信线索', name: 'dmLeads', value: c?.dmLeads ?? '', type: 'number' })}
        ${field({ label: '表单线索', name: 'formLeads', value: c?.formLeads ?? '', type: 'number' })}
      </div>
      <div class="hint">线索数才是唯一能算 ROI 的数字，播放量只是过程指标。</div>
    `,
    footer: `${id ? '<button class="btn danger" data-del>删除</button>' : ''}
      <button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        if (!f.title) return toast('标题必填', 'warn');
        upsertCampaign({
          title: f.title, platform: f.platform, format: f.format,
          publishedAt: f.publishedAt, status: f.status,
          views: Number(f.views) || 0, likes: Number(f.likes) || 0, comments: Number(f.comments) || 0,
          spend: Number(f.spend) || 0, dmLeads: Number(f.dmLeads) || 0, formLeads: Number(f.formLeads) || 0,
        }, id);
        toast('内容已保存');
        close();
        ctx.refresh();
      };
      const del = el.querySelector('[data-del]');
      if (del) del.onclick = () => confirmDialog({
        title: '删除内容', message: '确认删除这条内容记录吗？', confirmText: '删除', danger: true,
        onConfirm() { ctx.deleteCampaign && ctx.deleteCampaign(id); close(); ctx.refresh(); },
      });
    },
  });
}

/* ============================================================
   表单：线索
   这里是"数据指挥销售"的入口：线索进来必须 30 分钟内首响
   ============================================================ */
const LEAD_SOURCES = ['抖音', '小红书', '视频号', '朋友圈', '转介绍', '自然到店', '其他'];
const LEAD_STATES = [
  { value: 'new', label: '新线索' },
  { value: 'contacted', label: '已触达' },
  { value: 'booked', label: '已预约' },
  { value: 'trial', label: '体验中' },
  { value: 'won', label: '已成交' },
  { value: 'lost', label: '已流失' },
];

export function openLeadForm(id, ctx) {
  const l = id ? ctx.state.leads.find((x) => x.id === id) : null;
  const campaignOptions = [{ value: '', label: '不关联内容' }]
    .concat(ctx.state.campaigns.map((c) => ({ value: c.id, label: c.title.slice(0, 24) })));
  openSheet({
    title: id ? '线索详情' : '录入一条线索',
    subtitle: '首响速度是线索转化率的第一变量',
    size: 'tall',
    body: `
      ${notice('线索进来 30 分钟内必须有一次真实触达。超时的线索不是"晚点再跟"，基本等于已流失。', 'warn', 'i-bell')}
      <div class="form-grid">
        ${field({ label: '姓名', name: 'name', value: l?.name || '', required: true })}
        ${field({ label: '手机号', name: 'phone', value: l?.phone || '', type: 'tel' })}
      </div>
      <div class="form-grid">
        ${selectField({ label: '来源', name: 'source', value: l?.source || '抖音', options: LEAD_SOURCES })}
        ${selectField({ label: '意向等级', name: 'intent', value: l?.intent || 'B', options: [
          { value: 'A', label: 'A：明确想练，问过价格' },
          { value: 'B', label: 'B：有兴趣，还在看' },
          { value: 'C', label: 'C：只是随手问问' },
        ] })}
      </div>
      ${selectField({ label: '关联内容', name: 'campaignId', value: l?.campaignId || '', options: campaignOptions })}
      <div class="form-grid">
        ${field({ label: '进来日期', name: 'createdAt', value: l?.createdAt || today(), type: 'date' })}
        ${field({ label: '首响耗时（分钟）', name: 'firstResponseMin', value: l?.firstResponseMin ?? '', type: 'number' })}
      </div>
      <div class="form-grid">
        ${selectField({ label: '当前状态', name: 'status', value: l?.status || 'new', options: LEAD_STATES })}
        ${field({ label: '负责人', name: 'owner', value: l?.owner || ctx.state.settings.advisor })}
      </div>
      ${textareaField({ label: '流失原因（仅流失时填）', name: 'lostReason', rows: 2, value: l?.lostReason || '', placeholder: '例：首响超 90 分钟，加微信时已被同行接待' })}
      ${l?.memberId ? `<div class="spacer"></div>${badge('已转为会员档案', 'b-green')}` : ''}
    `,
    footer: `${id ? '<button class="btn danger" data-del>删除</button>' : ''}
      <button class="btn ghost" data-sheet-close>取消</button>
      ${id && !l?.memberId ? '<button class="btn ghost" data-convert>转为会员</button>' : ''}
      <button class="btn primary" data-save>保存</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        if (!f.name) return toast('姓名必填', 'warn');
        upsertLead({
          name: f.name, phone: f.phone, source: f.source, intent: f.intent,
          campaignId: f.campaignId || null, createdAt: f.createdAt,
          firstResponseMin: f.firstResponseMin === '' ? null : Number(f.firstResponseMin),
          status: f.status, owner: f.owner,
          lostReason: f.status === 'lost' ? f.lostReason : '',
        }, id);
        toast('线索已保存');
        close();
        ctx.refresh();
      };

      const conv = el.querySelector('[data-convert]');
      if (conv) conv.onclick = () => {
        const f = serialize(el);
        confirmDialog({
          title: '把这个线索转成会员档案',
          message: `会新建一条会员档案并标记线索已成交。来源记作「${f.source}」，阶段从「体验中」开始。`,
          confirmText: '转为会员',
          onConfirm() {
            upsertLead({ name: f.name, phone: f.phone, source: f.source, intent: f.intent, campaignId: f.campaignId || null }, id);
            const newId = convertLead(id, { source: f.source, name: f.name, phone: f.phone });
            close();
            ctx.refresh();
            toast('已转为会员档案');
            if (newId) setTimeout(() => ctx.openMember(newId), 160);
          },
        });
      };

      const del = el.querySelector('[data-del]');
      if (del) del.onclick = () => confirmDialog({
        title: '删除线索', message: '确认删除这条线索吗？', confirmText: '删除', danger: true,
        onConfirm() { ctx.deleteLead && ctx.deleteLead(id); close(); ctx.refresh(); },
      });
    },
  });
}

/* ============================================================
   表单：学习课题产出
   ============================================================ */
export function openTopicEvidence(topicId, ctx) {
  const t = TOPICS.find((x) => x.id === topicId);
  if (!t) return toast('找不到这个课题', 'warn');
  const prog = ctx.state.learning.progress[topicId] || {};
  const M = ctx.metrics || computeMetrics(ctx.state);
  const metric = M[t.metricKey] || { text: '-', note: '', source: '缺' };
  openSheet({
    title: '记录产出',
    subtitle: `${esc(t.title)} · 当前指标 ${esc(metric.text)}`,
    size: 'tall',
    body: `
      ${notice('这个课题的产出必须能被验证。写清「做了什么、留下什么证据」，复盘时才不算空话。', 'info', 'i-target')}
      <div class="card tight">
        ${kvRow('可验证产出', t.deliverable)}
        ${kvRow('建议周期', t.cycle)}
        ${kvRow('指标口径', metric.note || '-')}
      </div>
      <div class="form-grid">
        ${selectField({ label: '进度状态', name: 'status', value: prog.status || 'doing', options: [
          { value: 'todo', label: '未开始' }, { value: 'doing', label: '进行中' }, { value: 'done', label: '已完成' },
        ] })}
        ${field({ label: '投入学时（小时）', name: 'hours', value: prog.hours ?? '', type: 'number' })}
      </div>
      ${textareaField({ label: '产出描述（留下什么证据）', name: 'evidence', rows: 4, value: prog.evidence || '', placeholder: '例：整理了一份 12 位会员的顾虑清单，并把它变成了 3 条短视频选题' })}
      ${field({ label: '当时指标快照', name: 'metricSnapshot', value: prog.metricSnapshot || metric.text || '' })}
      <div class="hint">产出写完再切"已完成"。没产出的完成只是自我安慰。</div>
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存产出</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        setTopicProgress(topicId, {
          status: f.status,
          hours: Number(f.hours) || 0,
          evidence: f.evidence || '',
          metricSnapshot: f.metricSnapshot || '',
        });
        toast(f.status === 'done' ? '已标记完成' : '产出已保存');
        close();
        ctx.refresh();
      };
    },
  });
}

/* ============================================================
   抽屉：绑定抖音账号
   ------------------------------------------------------------
   绑的是抖音号（uniqueId）而不是昵称：昵称会重名，
   红狐官方脚本遇到中文昵称直接拒绝。
   密钥一律不进这个抽屉，也不进 localStorage。
   ============================================================ */
export function openDouyinBindSheet(ctx) {
  const b = douyinBinding();
  const mon = ctx.state.douyin.monitor || {};
  const cost = estimateCost(FULL_SYNC_KEYS);

  const MON_ROWS = [
    { key: 'account', label: '账号维度', desc: '粉丝 / 作品数 / 累计获赞 / 红狐指数 / 地区' },
    { key: 'works', label: '作品列表', desc: '单页最多 50 条，用来算平均播放、爆款率、发布间隔' },
    { key: 'benchmark', label: '对标账号', desc: '按关键词搜同赛道账号，多花一次搜索调用的钱' },
    { key: 'storeHeat', label: '门店热度', desc: '门店名 + 商圈关键词近似召回，不是 POI 口径' },
  ];

  openSheet({
    title: b ? '抖音账号设置' : '绑定抖音账号',
    subtitle: b ? `当前绑定 ${esc(b.uniqueName)}` : '绑定后智能体才能开始监控这个账号',
    size: 'tall',
    body: `
      ${notice('密钥不进浏览器。取数走本地代理进程，密钥只放在它的环境变量 <b>REDFOX_API_KEY</b> 里。这里只保存抖音号和监控开关。', 'info', 'i-key')}
      ${field({
        label: '抖音号（不是昵称）', name: 'uniqueName', value: b?.uniqueName || '',
        placeholder: '例：lijian_jrc', required: true,
        hint: '在抖音个人主页看"抖音号"，一串英文或数字。中文昵称会重名，接口要求用抖音号。',
      })}
      ${field({ label: '备注（给自己看）', name: 'note', value: b?.note || '', placeholder: '例：门店主账号，日常内容都发在这里' })}

      <div class="divider"></div>
      <div class="section-title">监控哪些维度<span class="count">关系到每次同步花多少积分</span></div>
      <div class="card tight">
        ${MON_ROWS.map((r) => `
          <div class="mon-row">
            <div style="min-width:0">
              <div style="font-size:13px;font-weight:650">${esc(r.label)}</div>
              <div class="small muted" style="margin-top:2px;line-height:1.5">${esc(r.desc)}</div>
            </div>
            <div style="flex:0 0 92px">
              <select class="select" name="mon_${r.key}" aria-label="${esc(r.label)}开关">
                <option value="on" ${mon[r.key] === false ? '' : 'selected'}>开启</option>
                <option value="off" ${mon[r.key] === false ? 'selected' : ''}>关闭</option>
              </select>
            </div>
          </div>`).join('')}
      </div>
      <div class="hint">全开的话一轮约 ${cost.calls} 次调用、${cost.credits} 积分，按官网下限价约 ¥${cost.moneyFloor}。积分与人民币的换算比例官方没公开，充值页确认。</div>
    `,
    footer: `${b ? '<button class="btn danger" data-unbind>解绑</button>' : ''}
      <button class="btn ghost" data-sheet-close>取消</button>
      <button class="btn primary" data-save>${b ? '保存设置' : '绑定账号'}</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        const name = String(f.uniqueName || '').trim();
        if (!name) return toast('抖音号必填', 'warn');
        if (/\s/.test(name)) return toast('抖音号里不能有空格', 'warn');

        bindDouyinAccount(name, { note: f.note || '', nickname: b?.nickname || name });
        setDouyinMonitor({
          account: f.mon_account !== 'off',
          works: f.mon_works !== 'off',
          benchmark: f.mon_benchmark !== 'off',
          storeHeat: f.mon_storeHeat !== 'off',
        });
        toast(b ? '设置已保存' : '已绑定，可以同步了');
        close();
        ctx.refresh();
      };

      const un = el.querySelector('[data-unbind]');
      if (un) un.onclick = () => confirmDialog({
        title: '解绑抖音账号',
        message: '解绑后智能体不再监控这个账号。已经抓到的快照会保留，历史数据不会消失。',
        confirmText: '解绑', danger: true,
        onConfirm() { unbindDouyinAccount(); toast('已解绑'); close(); ctx.refresh(); },
      });
    },
  });
}

/* ============================================================
   抽屉：官方赛道榜
   ------------------------------------------------------------
   这是红狐唯一返回「官方榜位」的接口，所以这一屏的重点不是"排好看的榜"，
   而是把三个边界一次说清，否则用户会以为拿到了本地经营排名。
   ============================================================ */
export function openTopBoardSheet(ctx) {
  const q = ctx.state.douyin?.boardQuery || { dateType: 'days', category: '身体锻炼' };
  const dateType = q.dateType || 'days';
  const category = q.category || '身体锻炼';

  /* 健身相关的三个赛道排在最前，剩下的按官方顺序，省得每次翻 28 项 */
  const rest = RANK_CATEGORIES.filter((x) => !FITNESS_CATEGORIES.includes(x) && x !== '全部');
  const catOptions = ['全部', ...FITNESS_CATEGORIES, ...rest];

  openSheet({
    title: '官方赛道榜',
    subtitle: '榜位由抖音给出，不是我们算的',
    size: 'tall',
    body: `
      ${notice(
        `榜位字段是接口返回的 <code>accountRanking</code>，我们原样显示，不做重排。<br>
         但它有三个边界，选之前先看一眼：<br>
         · <b>没有城市筛选</b>：只能按赛道查，拿不到「重庆榜」<br>
         · <b>口径是内容维度</b>：综合评分 = 粉丝 + 涨粉 + 点赞/评论/分享增量加权，不含曝光、转化、开口<br>
         · <b>本店账号不在池子里</b>：每赛道只有 TOP50，是百万粉级账号`,
        'warn', 'i-alert')}

      <div class="form-grid">
        ${selectField({ label: '榜期', name: 'dateType', value: dateType, options: RANK_PERIODS, hint: '官方：日榜每晚 8 点更新昨日' })}
        ${field({ label: '榜单日期', name: 'rankDate', value: q.rankDate || defaultRankDate(dateType), type: 'date' })}
      </div>
      ${selectField({ label: '赛道', name: 'category', value: category, options: catOptions, hint: '健身相关的是身体锻炼 / 体育 / 健康医学' })}
      <div class="hint">改榜期会自动把日期调成"最近一个已经更新过的周期"，传今天大概率是一条空榜。</div>

      <div class="divider"></div>
      ${BOARD_CAVEATS.map((c) => `
        <div class="kv">
          <div class="k">${esc(c.label)}</div>
          <div class="v" style="font-weight:500;font-size:12px;line-height:1.6">${esc(c.text)}</div>
        </div>`).join('')}
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button>
      <button class="btn primary" data-save>取这一期</button>`,
    onMount(el, close) {
      /* 改榜期时把日期跟着调成对应周期的默认值，避免手填出空榜 */
      const sel = el.querySelector('[name="dateType"]');
      const dateInput = el.querySelector('[name="rankDate"]');
      if (sel && dateInput) {
        sel.onchange = () => { dateInput.value = defaultRankDate(sel.value); };
      }
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        if (!f.rankDate) return toast('榜单日期必填', 'warn');
        /* 榜期与赛道存成偏好（下次进来不用重选）；日期只当这一次的参数传过去。
           存下来会变成"隔天再点还在拉同一天"，看起来像榜单没更新。 */
        setBoardQuery({ dateType: f.dateType, category: f.category });
        close();
        ctx.syncDouyinBoard({ dateType: f.dateType, category: f.category, rankDate: f.rankDate });
      };
    },
  });
}

/* ============================================================
   抽屉：门店热度手工登记
   ------------------------------------------------------------
   评论内容与绿标白标这两项红狐没有接口，手工登记是唯一能核对的来源。
   所以这个抽屉不写"手动模式"这种含糊说法，
   直接把"为什么必须手填"和"怎么填最省事"说清楚。
   ============================================================ */
export function openStoreHeatForm(ctx, kind) {
  const item = STORE_HEAT_ITEMS.find((x) => x.key === kind);
  if (!item) return toast('找不到这个监控项', 'warn');
  const cur = (ctx.state.douyin.storeHeat.manual || []).find((x) => x.kind === kind) || null;

  const POI_KEYWORDS = ['金融城 健身', '江北嘴 健身房', '解放碑 私教'];

  const FIELDS = {
    poiWorks: `
      ${field({ label: '召回条数', name: 'count', value: cur?.count ?? '', type: 'number', hint: '用关键词搜作品，记下命中的条数' })}
      ${field({ label: '用过的关键词', name: 'keywords', value: cur?.keywords || POI_KEYWORDS.join('、'), hint: '逗号或顿号分隔，下次照这个跑' })}
      ${textareaField({ label: '值得看的几条', name: 'detail', rows: 3, value: cur?.detail || '', placeholder: '例：「金融城 健身」召回 14 条，其中 3 条同时出现在本店账号作品里' })}`,
    commentTalk: `
      ${field({ label: '记了多少条评论', name: 'count', value: cur?.count ?? '', type: 'number', hint: '抽 10 条就够，不用全看' })}
      ${textareaField({ label: '反复出现的顾虑', name: 'detail', rows: 4, value: cur?.detail || '', placeholder: '例：器械不够用 / 停车不好停 / 私教排课太紧', hint: '写顾虑本身，别写你的判断。原话比总结有用。' })}`,
    poiBadge: `
      <div class="form-grid">
        ${field({ label: '绿标（已认领）', name: 'green', value: cur?.green ?? '', type: 'number', hint: '含本店自己' })}
        ${field({ label: '白标（未认领）', name: 'white', value: cur?.white ?? '', type: 'number' })}
      </div>
      ${textareaField({ label: '谁在带货', name: 'detail', rows: 3, value: cur?.detail || '', placeholder: '例：挂载最多的账号是 jrc_pt_studio' })}`,
  };

  openSheet({
    title: item.label,
    subtitle: `${item.availabilityLabel}｜来源：${item.source}`,
    size: 'tall',
    body: `
      ${notice(`<b>为什么是手工填：</b>${esc(item.basis)}<br><br><b>怎么填最省事：</b>${esc(item.way)}`, 'warn', 'i-alert')}
      ${FIELDS[kind] || ''}
      <div class="hint">登记一次能用一个月，不用天天填。填完这一项会在门店热度区显示成"已登记"而不是"未获取"。</div>
    `,
    footer: `${cur ? '<button class="btn danger" data-del>清除登记</button>' : ''}
      <button class="btn ghost" data-sheet-close>取消</button>
      <button class="btn primary" data-save>保存</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        const patch = { kind, detail: f.detail || '' };
        if (kind === 'poiWorks') {
          patch.count = Number(f.count) || 0;
          patch.keywords = f.keywords || '';
        } else if (kind === 'commentTalk') {
          patch.count = Number(f.count) || 0;
        } else {
          patch.green = Number(f.green) || 0;
          patch.white = Number(f.white) || 0;
          patch.count = (Number(f.green) || 0) + (Number(f.white) || 0);
        }
        upsertStoreHeatManual(patch);
        toast('已登记');
        close();
        ctx.refresh();
      };

      const del = el.querySelector('[data-del]');
      if (del) del.onclick = () => confirmDialog({
        title: '清除登记',
        message: '清除后这一项会重新变回"未获取"，需要时可以再填。',
        confirmText: '清除', danger: true,
        onConfirm() { deleteStoreHeatManual(cur.id); close(); ctx.refresh(); },
      });
    },
  });
}

/* ============================================================
   抽屉：小红书账号登记 / 笔记登记
   ------------------------------------------------------------
   这两张表单为什么是"登记"而不是"同步"：
   红狐没有小红书账号维度接口，也没有登记进项目的笔记端点，
   所以这里填的每一个数字都是使用者自己填的。表单里必须把这句话
   写在最上面，否则界面上那些数字会被误当成平台返回值。
   ============================================================ */
export function openXhsBindSheet(ctx) {
  const cur = ctx.state.xhs?.binding || null;

  openSheet({
    title: cur ? '修改小红书号登记' : '登记小红书号',
    subtitle: '小红书号唯一，昵称会重名',
    body: `
      ${notice('<b>这些数字是登记值，不是接口返回的。</b>红狐目前没有小红书账号维度接口，'
        + '粉丝数与笔记数只能自己填，填多少界面就显示多少，不会有任何"自动更新"。', 'warn', 'i-alert')}
      ${field({ label: '小红书号', name: 'uniqueName', value: cur?.uniqueName || '', placeholder: '例：lijian_jrc', hint: '不是昵称。昵称不唯一，重名会记错账号' })}
      ${field({ label: '昵称', name: 'nickname', value: cur?.nickname || '' })}
      <div class="form-grid">
        ${field({ label: '粉丝数', name: 'followerCount', value: cur?.followerCount ?? '', type: 'number', hint: '留空就显示「未获取」，不要填 0 充数' })}
        ${field({ label: '笔记数', name: 'noteCount', value: cur?.noteCount ?? '', type: 'number' })}
      </div>
      ${textareaField({ label: '备注', name: 'note', rows: 2, value: cur?.note || '', placeholder: '例：门店主账号，由前台每周更新一次数字' })}
      <div class="hint">隔一段时间改一次就够。数字是你登记的，界面上会一直标「登记值」。</div>`,
    footer: `${cur ? '<button class="btn danger" data-unbind>解除登记</button>' : ''}
      <button class="btn ghost" data-sheet-close>取消</button>
      <button class="btn primary" data-save>保存</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        if (!String(f.uniqueName || '').trim()) return toast('小红书号必填', 'warn');
        bindXhsAccount(f.uniqueName, {
          nickname: f.nickname || '',
          /* 空字符串要存成 null：0 和"没填"是两回事，
             存 0 会让界面显示"粉丝 0"，那是假数据 */
          followerCount: f.followerCount === '' || f.followerCount == null ? null : Number(f.followerCount),
          noteCount: f.noteCount === '' || f.noteCount == null ? null : Number(f.noteCount),
          note: f.note || '',
          boundAt: cur?.boundAt,
        });
        toast('已登记');
        close();
        ctx.refresh();
      };
      const un = el.querySelector('[data-unbind]');
      if (un) un.onclick = () => confirmDialog({
        title: '解除登记',
        message: '解除后账号信息会清掉，已经登记的笔记保留。',
        confirmText: '解除', danger: true,
        onConfirm() { unbindXhsAccount(); close(); ctx.refresh(); },
      });
    },
  });
}

export function openXhsNoteForm(ctx, id) {
  const cur = (ctx.state.xhs?.notes || []).find((x) => x.id === id) || null;

  openSheet({
    title: cur ? '修改笔记登记' : '登记一条笔记',
    subtitle: '发布后隔一天再记数字，当天记会偏低',
    size: 'tall',
    body: `
      ${notice('填你能在小红书后台看到的数字。<b>看不到的就留空</b>，留空显示「未获取」，'
        + '比随便填一个数字有用得多：后面的平均阅读、爆款率都是拿这些数算的。', 'info', 'i-doc')}
      ${field({ label: '笔记标题', name: 'title', value: cur?.title || '', required: true })}
      <div class="form-grid">
        ${field({ label: '发布日期', name: 'publishedAt', value: cur?.publishedAt || '', type: 'date', required: true })}
        ${field({ label: '形式', name: 'format', value: cur?.format || '', placeholder: '图文 / 视频' })}
      </div>
      <div class="form-grid">
        ${field({ label: '阅读', name: 'readCount', value: cur?.readCount ?? '', type: 'number' })}
        ${field({ label: '点赞', name: 'likeCount', value: cur?.likeCount ?? '', type: 'number' })}
      </div>
      <div class="form-grid">
        ${field({ label: '收藏', name: 'collectCount', value: cur?.collectCount ?? '', type: 'number' })}
        ${field({ label: '评论', name: 'commentCount', value: cur?.commentCount ?? '', type: 'number' })}
      </div>
      <div class="form-grid">
        ${field({ label: '分享', name: 'shareCount', value: cur?.shareCount ?? '', type: 'number' })}
        ${field({ label: '带来线索', name: 'leads', value: cur?.leads ?? '', type: 'number', hint: '从这条笔记加过来的人数' })}
      </div>`,
    footer: `${cur ? '<button class="btn danger" data-del>删除</button>' : ''}
      <button class="btn ghost" data-sheet-close>取消</button>
      <button class="btn primary" data-save>保存</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        if (!String(f.title || '').trim()) return toast('标题必填', 'warn');
        if (!String(f.publishedAt || '').trim()) return toast('发布日期必填', 'warn');
        const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
        upsertXhsNote({
          id: cur?.id,
          title: String(f.title).trim(),
          publishedAt: String(f.publishedAt).trim(),
          format: f.format || '',
          readCount: num(f.readCount),
          likeCount: num(f.likeCount),
          collectCount: num(f.collectCount),
          commentCount: num(f.commentCount),
          shareCount: num(f.shareCount),
          leads: num(f.leads),
        });
        toast(cur ? '已修改' : '已登记');
        close();
        ctx.refresh();
      };
      const del = el.querySelector('[data-del]');
      if (del) del.onclick = () => confirmDialog({
        title: '删除这条登记',
        message: '删除后这一条不再参与平均阅读与爆款率的计算。',
        confirmText: '删除', danger: true,
        onConfirm() { deleteXhsNote(cur.id); close(); ctx.refresh(); },
      });
    },
  });
}

/* ============================================================
   抽屉：功能库（可选配模块）
   ------------------------------------------------------------
   关掉一个模块和删掉一个功能是两件完全不同的事：
   关掉只是把它从导航里收起来，数据一条不动；重新打开，记录原样回来。
   这句话必须写在抽屉最上面，否则没人敢点那个「收起」。
   ============================================================ */
export function openFeaturesSheet(ctx) {
  const on = countOn(ctx.state.features);

  openSheet({
    title: '功能库',
    subtitle: `已添加 ${on} 个可选模块，核心模块不可移除`,
    size: 'tall',
    body: `
      ${notice('收起一个模块只是把它从导航里藏起来，<b>数据一条都不会删</b>。重新添加，之前的记录原样回来。', 'info', 'i-check')}
      <div id="featBody"></div>`,
    footer: `<button class="btn ghost" data-reset>恢复默认</button>
      <button class="btn primary" data-sheet-close>完成</button>`,
    onMount(el, close) {
      const body = el.querySelector('#featBody');
      const paint = () => { body.innerHTML = featuresBody(ctx.state); };
      paint();

      el.addEventListener('click', (e) => {
        const t = e.target.closest('[data-feat]');
        if (!t) return;
        const id = t.dataset.feat;
        const f = ALL_FEATURES.find((x) => x.id === id);
        if (!f) return;
        if (f.core) return toast('核心模块不能移除', 'warn');

        const next = !isFeatureOn(ctx.state.features, id);
        setFeature(id, next);
        toast(next ? `已添加「${f.label}」` : `已收起「${f.label}」`);
        paint();
        ctx.refresh();
      });

      el.querySelector('[data-reset]').onclick = () => confirmDialog({
        title: '恢复默认功能配置',
        message: '会把功能开关恢复成默认档：社群管理收起，其余打开。<strong>数据不受影响。</strong>',
        confirmText: '恢复默认',
        onConfirm() { resetFeatures(); toast('已恢复默认配置'); paint(); ctx.refresh(); },
      });
    },
  });
}

function featuresBody(state) {
  const groups = FEATURE_GROUPS.map((g) => `
    ${sectionTitleLocal(g.label, g.desc)}
    ${g.items.map((f) => {
      const on = isFeatureOn(state.features, f.id);
      return `<div class="card tight feat-row">
        <div class="flex" style="align-items:flex-start;gap:10px">
          <div class="feat-ico"><svg viewBox="0 0 24 24"><use href="#${f.icon}"/></svg></div>
          <div style="flex:1;min-width:0">
            <div class="between" style="align-items:flex-start;gap:10px">
              <div style="min-width:0">
                <div style="font-size:13.5px;font-weight:650">${esc(f.label)}</div>
                <div class="small muted" style="margin-top:3px;line-height:1.55">${esc(f.desc)}</div>
              </div>
              ${f.core
                ? badge('核心', 'b-green')
                : `<button class="btn ${on ? 'ghost' : 'primary'} sm" data-feat="${f.id}" style="flex:0 0 auto">${on ? '收起' : '添加'}</button>`}
            </div>
            <div class="small muted" style="margin-top:7px;line-height:1.6">${esc(f.detail)}</div>
            ${on && !f.core ? '<div class="small" style="margin-top:5px;color:var(--brand-2)">已添加到导航</div>' : ''}
          </div>
        </div>
      </div>`;
    }).join('')}`).join('');

  return `${groups}
  <div class="hint" style="margin-top:10px;line-height:1.7">
    判断一个模块该内置还是放进功能库，只看一件事：
    去掉它，内容带线索、线索转会员、会员成交这条链会不会断。
    会断的内置，不会断的放这里由你自己决定。
  </div>`;
}

/** 抽屉里用的小标题，和主视图的 sectionTitle 同款结构，不重复引组件 */
const sectionTitleLocal = (text, count = '') =>
  `<div class="section-title">${esc(text)}${count ? `<span class="count">${esc(count)}</span>` : ''}</div>`;

/* ============================================================
   抽屉：今日运营提醒
   ------------------------------------------------------------
   已读和未读放在同一个列表里，因为"回顾今天说过什么"和
   "把未读清掉"是同一个场景里的两个动作，拆成两个界面反而麻烦。
   未读排前面，已读压成低对比度，一眼能看出还剩几条。
   ============================================================ */
export function openBriefSheet(ctx) {
  openSheet({
    title: '今日运营提醒',
    subtitle: '由今天的真实数据生成，没数据的部分不会出现',
    size: 'tall',
    body: `${notice('每一条都能追到数据：<b>依据</b>写的是拿哪几个数比出来的，<b>下一步</b>写的是具体动什么。没有数据支撑的部分不会出现在这里。', 'info', 'i-spark')}
      <div id="briefBody"></div>`,
    footer: `<button class="btn ghost" data-readall>全部已读</button>
      <button class="btn primary" data-sheet-close>关闭</button>`,
    onMount(el, close) {
      const body = el.querySelector('#briefBody');
      const paint = () => {
        const brief = buildBrief(ctx.state);
        const read = readIdsOf(ctx.state);
        body.innerHTML = briefBody(brief, read);
        const left = unreadOf(brief, read).length;
        const ra = el.querySelector('[data-readall]');
        if (ra) ra.style.display = left ? '' : 'none';
        const sub = el.querySelector('.sheet-hd .sub');
        if (sub) sub.textContent = `${brief.date} · 共 ${briefTotal(brief)} 条，未读 ${left} 条`;
        ctx.refresh();
      };
      paint();

      el.addEventListener('click', (e) => {
        const one = e.target.closest('[data-read-one]');
        if (one) {
          markBriefRead(one.dataset.readOne);
          paint();
          return;
        }
        if (e.target.closest('[data-readall]')) {
          const brief = buildBrief(ctx.state);
          const ids = unreadOf(brief, readIdsOf(ctx.state)).map((x) => x.id);
          if (!ids.length) return toast('已经全部读过了');
          markBriefRead(ids);
          toast(`已把 ${ids.length} 条标为已读`);
          paint();
        }
      });
    },
  });
}

function briefBody(brief, readIds) {
  const read = new Set(readIds || []);
  const rank = { warn: 0, info: 1, good: 2 };
  const items = [...brief.items].sort((a, b) => {
    const ra = a.placeholder || read.has(a.id) ? 1 : 0;
    const rb = b.placeholder || read.has(b.id) ? 1 : 0;
    if (ra !== rb) return ra - rb;
    /* 同一档里让"要处理"的排在"可优化"前面 */
    return (rank[a.level] ?? 1) - (rank[b.level] ?? 1);
  });

  return items.map((x) => {
    const L = LEVEL_META[x.level] || LEVEL_META.info;
    const isRead = x.placeholder || read.has(x.id);
    return `<div class="brief-item ${isRead ? 'read' : ''}" style="border-left-color:${L.color}">
      <div class="between" style="align-items:flex-start;margin-bottom:6px;gap:10px">
        <div class="flex" style="gap:6px;min-width:0">
          <span class="badge ${L.cls}">${x.kind === 'advice' ? '建议' : '总结'}</span>
          <span class="small muted">${esc(x.source)}</span>
        </div>
        ${x.placeholder ? ''
          : isRead
            ? badge('已读', 'b-plain')
            : `<button class="btn ghost sm" data-read-one="${x.id}" style="flex:0 0 auto">标为已读</button>`}
      </div>
      <div style="font-size:13.5px;font-weight:650;line-height:1.5">${esc(x.text)}</div>
      <div class="small" style="line-height:1.7;color:var(--ink-2);margin-top:6px">${esc(x.detail)}</div>
      <div class="small" style="margin-top:7px;line-height:1.6"><span class="muted">下一步</span> ${esc(x.action)}</div>
    </div>`;
  }).join('');
}

/* ============================================================
   抽屉：交易后台报表导入
   ------------------------------------------------------------
   这是这一版真正能用的链路，所以打磨得细一点：
     · 列名不改也能认（别名表在 bizMetrics.js）
     · 认不出的列直接列出来，说清是哪几列没吃进去，不静默丢弃
     · 一个指标都没认出来就拦下，别把一张空表写进库里
     · 同一天多行会合并求和，这一点必须在导入前说清口径
     · 日期读不出来的行（通常是合计行）直接跳过并报数
   ============================================================ */
export function openBizReportSheet(ctx, sourceId) {
  const src = getBizSource(sourceId);
  if (!src) return toast('找不到这个交易后台', 'warn');

  let step = 'paste';
  let parsed = null;
  let result = null;

  openSheet({
    title: `${src.name} · 导入后台报表`,
    subtitle: '从后台导出的表格直接粘进来，不用改列名',
    size: 'tall',
    body: '<div id="bzBody"></div>',
    footer: `<button class="btn ghost" data-sheet-close>关闭</button>
      <button class="btn primary" data-bz-next>解析表格</button>`,
    onMount(el, close) {
      const body = el.querySelector('#bzBody');
      const nextBtn = el.querySelector('[data-bz-next]');

      const paint = () => {
        body.innerHTML = bizReportStep(step, src, parsed, result);
        nextBtn.textContent = step === 'paste' ? '解析表格' : step === 'preview' ? '确认导入' : '完成';
      };
      paint();

      nextBtn.onclick = () => {
        if (step === 'paste') {
          const ta = body.querySelector('#bzText');
          const fb = body.querySelector('[name="fallbackDate"]');
          const fallbackDate = (fb && fb.value) || today();
          parsed = parseBizReport(ta.value, { sourceId: src.id, fallbackDate });
          parsed.fallbackDate = fallbackDate;
          if (!parsed.headers.length) return toast('没读到内容，检查一下粘贴的表格', 'warn');
          if (!parsed.records.length) {
            return toast(parsed.dateCol != null
              ? '每一行的日期都读不出来，可能把合计行也一起粘进来了'
              : '没有一行带指标数字', 'warn');
          }
          step = 'preview';
          paint();
          return;
        }

        if (step === 'preview') {
          if (hasNoMetricMatch(parsed)) {
            return toast('一个指标列都没认出来，先看预览里列出的未匹配表头', 'warn');
          }
          /* 同一天多行先合并求和，否则同一天会存成好几条，漏斗只认得到第一条 */
          const collapsed = collapseByDate(parsed.records);
          result = saveBizRecords(collapsed, { sourceId: src.id });
          logBizEvent(src.id,
            `报表导入：新增 ${result.created} 天，合并 ${result.merged} 天，识别 ${Object.keys(parsed.map).length} 个指标列`,
            { type: 'import', records: parsed.records.length });
          step = 'done';
          paint();
          ctx.refresh();
          return;
        }

        close();
        ctx.refresh();
      };

      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-bz-again]')) {
          step = 'paste';
          parsed = null;
          result = null;
          paint();
        }
      });
    },
  });
}

function bizReportStep(step, src, parsed, result) {
  if (step === 'paste') {
    return `
      ${notice(`导出位置：<b>${esc(src.reportSpec.where)}</b><br>
        导出后可以直接从 Excel 复制粘贴，也能粘 CSV 内容。列名不用改，FitFlow 按别名自动匹配。`, 'info', 'i-doc')}

      <div class="field">
        <label>粘贴报表内容<span style="color:var(--danger)"> *</span></label>
        <textarea class="textarea" id="bzText" rows="11" style="min-height:210px;font-family:var(--mono);font-size:11.5px"
          placeholder="统计日期&#9;曝光人数&#9;页面访问&#9;开口人数&#9;下单人数&#9;核销人数&#10;2026-09-27&#9;24800&#9;2610&#9;318&#9;38&#9;27"></textarea>
        <div class="hint">第一行必须是表头。支持 Tab 分隔和逗号分隔。</div>
      </div>

      ${field({
        label: '表里没有日期列时，按哪一天记',
        name: 'fallbackDate', type: 'date', value: today(),
        hint: '报表带日期列的话这一项会被忽略，按表里的日期记。',
      })}

      ${sectionTitleLocal('这个后台的导出要点')}
      <div class="card tight">
        ${src.reportSpec.rows.map((r) => kvRow(r.label, `<span class="small muted">${esc(r.hint)}</span>`)).join('')}
      </div>
      <div class="hint" style="line-height:1.7">${esc(src.reportSpec.tip)}</div>`;
  }

  if (step === 'preview') {
    const matched = Object.entries(parsed.map);
    const total = parsed.records.length;
    const noMatch = hasNoMetricMatch(parsed);

    return `
      ${noMatch
        ? notice('一个指标列都没认出来。检查表头里有没有「曝光」「访问」「开口」「下单」「核销」这类字样，别名字典覆盖不到的先改一下表头再导。', 'danger', 'i-alert')
        : notice(`读到 <b>${total}</b> 行，识别出 <b>${matched.length}</b> 个指标列。核对一下对应关系，确认无误再导入。`, matched.length >= 4 ? 'green' : 'warn', 'i-check')}
      ${parsed.skipped ? `<div class="hint">另有 ${parsed.skipped} 行被跳过（日期读不出来，通常是合计行或表尾说明）。</div>` : ''}

      ${sectionTitleLocal('列对应关系')}
      <div class="card tight">
        ${BIZ_METRIC_FIELDS.map((f) => {
          const i = parsed.map[f.key];
          return `<div class="between" style="padding:7px 0;border-bottom:1px solid var(--line-2)">
            <div style="min-width:0">
              <div class="small" style="font-weight:650">${esc(f.label)}</div>
              <div class="small muted" style="margin-top:2px;line-height:1.5">${esc(f.note)}</div>
            </div>
            <div style="flex:0 0 auto;text-align:right;max-width:150px">
              ${i == null
                ? '<span class="small muted">没有这一列</span>'
                : `<span class="small" style="color:var(--brand-2)">${esc(parsed.headers[i])}</span>`}
            </div>
          </div>`;
        }).join('')}
      </div>

      ${parsed.dateCol == null
        ? notice(`表里没找到日期列，这 ${total} 行会<b>全部按 ${esc(parsed.fallbackDate)} 合并成一天</b>。如果这是多天的数据，回去把日期列一起导出来。`, 'warn', 'i-alert')
        : kvRow('日期列', esc(parsed.headers[parsed.dateCol]))}

      ${parsed.unmatched.length ? `
        ${sectionTitleLocal('没吃进去的列')}
        <div class="card tight">
          <div class="small muted" style="line-height:1.7">${esc(parsed.unmatched.join('、'))}</div>
          <div class="hint" style="margin-top:6px;line-height:1.6">这些列不在FitFlow 的口径里，会被忽略。转化率之类的比值列本来就不需要，FitFlow 自己按人数算。</div>
        </div>` : ''}

      ${total > 1 && parsed.dateCol == null
        ? notice('同一天的多行会按各指标<b>求和</b>后合并。分渠道或分商品的明细这样算是对的；如果是分时段明细，求和会把曝光重复计算，请先在后台按日汇总。', 'info', 'i-alert')
        : ''}

      ${sectionTitleLocal('前 3 行预览')}
      <div class="card tight">
        <div class="tbl-scroll">
          <table class="tbl">
            <thead><tr>${parsed.headers.slice(0, 6).map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
            <tbody>${parsed.rowsPreview.slice(0, 3).map((r) => `<tr>${parsed.headers.slice(0, 6).map((_, i) => `<td>${esc(r[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`;
  }

  return `
    ${notice(`导入完成：新增 <b>${result.created}</b> 天，合并 <b>${result.merged}</b> 天。`, result.created + result.merged ? 'green' : 'warn', 'i-check')}
    <div class="card tight">
      <div class="small" style="line-height:1.75">
        合并规则：<br>
        1. 按「来源 + 日期」去重，重复导同一张表不会把数字算两遍<br>
        2. 同一天分多次导入时，后一次只覆盖它带了的列。所以流量看板和交易看板可以分两次导<br>
        3. 这一次没导的列保留原值，不会被清空<br>
        4. 导入后「交易后台」那一栏的漏斗会自动重算，缺的环显示「未获取」而不是 0
      </div>
    </div>
    <div class="btn-row">
      <button class="btn ghost" data-bz-again>再导一份</button>
    </div>`;
}

/* ============================================================
   抽屉：交易后台的接口与核对清单
   ------------------------------------------------------------
   这一屏存在的意义是"说清为什么接口还没通"，不是展示进度。
   所以每条路径都标了它是占位，需要用户自己去官方文档核对替换。
   把未核对的路径写成看起来很真的样子，比留空更糟。
   ============================================================ */
export function openBizDetailSheet(ctx, sourceId) {
  const src = getBizSource(sourceId);
  if (!src) return toast('找不到这个交易后台', 'warn');
  const c = bizSource(sourceId) || {};
  const specs = Object.entries(src.endpointSpec);

  openSheet({
    title: `${src.name} · 接口与核对清单`,
    subtitle: '说清能做到哪一步，包括做不到的部分',
    size: 'tall',
    body: `
      ${notice(`<b>${esc(src.availabilityLabel)}</b>：${esc(src.verdict)}`,
        src.availability === 'api' ? 'green' : src.availability === 'no-public-api' ? 'danger' : 'warn',
        'i-alert')}

      ${sectionTitleLocal('接入配置')}
      <div class="card tight">
        ${kvRow('门店标识', c.poiId ? esc(c.poiId) : '未填写', !c.poiId)}
        ${kvRow('本地代理', `<span class="mono">${esc(c.proxyUrl || 'http://localhost:8787')}</span>`)}
        ${kvRow('鉴权方式', esc(src.authSpec.mode))}
        ${kvRow('鉴权字段', `<span class="mono small">${esc(src.authSpec.headerName)}</span>`)}
        ${src.availability === 'brand-required' ? kvRow('入驻身份', '三方服务商 / 连锁品牌（需品牌总部资质）') : ''}
        ${src.availability === 'brand-required' ? kvRow('数据时效', 'T+2（查询截止日最晚为两天前）') : ''}
        ${kvRow('密钥位置', `<span class="small muted">本地代理进程环境变量：${esc(src.authSpec.envVars.join('、'))}</span>`)}
        ${kvRow('已导入', `${bizRecordsOf(sourceId).length} 天记录`)}
        ${kvRow('最近导入', c.lastImportAt ? esc(c.lastImportAt) : '未发生', !c.lastImportAt)}
      </div>
      ${field({
        label: '门店标识（poiId，可留空）',
        name: 'poiId', value: c.poiId || '',
        placeholder: '如 金融城店 或平台给的 poiId',
        hint: '只是给你自己看，表里不会拿它发请求。接口通了之后会用它定位门店。',
      })}

      ${specs.length ? `
      ${sectionTitleLocal('端点清单', `${specs.filter(([, e]) => e.verified).length} / ${specs.length} 已核对`)}
      <div class="card tight">
        ${specs.map(([key, e]) => `
          <div class="spec-row">
            <div style="flex:1;min-width:0">
              <div class="t">${esc(e.note || key)}</div>
              <div class="m">${esc(e.host ? e.host : '')}${esc(e.method)} ${esc(e.path)}</div>
              ${e.pathNote ? `<div class="small muted" style="margin-top:4px;line-height:1.55">${esc(e.pathNote)}</div>` : ''}
              ${e.docRef ? `<div class="small" style="margin-top:4px;line-height:1.55;color:var(--brand-2)">已按文档核对：${esc(e.docRef)}</div>` : ''}
              ${e.limits ? `<div class="small muted" style="margin-top:5px;line-height:1.6">${e.limits.map((x) => esc(x)).join('<br>')}</div>` : ''}
              ${e.responseMap ? `
                <div class="divider"></div>
                <div class="small" style="font-weight:650;margin-bottom:5px">返回字段对应的口径</div>
                ${Object.entries(e.responseMap).map(([k, v]) => `
                  <div class="between small" style="padding:2px 0">
                    <span class="mono muted">${esc(k)}</span><span>${esc(v)}</span>
                  </div>`).join('')}` : ''}
            </div>
            ${e.verified ? badge('已核对', 'b-green') : badge('占位路径', 'b-warn')}
          </div>`).join('')}
      </div>
      <div class="hint" style="line-height:1.7">
        标「已核对」的是照着官方文档一行行对过的，字段名和限制都写在上头；
        标「占位路径」的我没有编造一条看起来很真的路径，等你在对应资质下查到真实路径后替换它，
        再把端点标成已核对，接口才会真正发请求。
      </div>` : ''}

      ${src.convention ? `
      ${sectionTitleLocal('公共约定')}
      <div class="card tight">
        ${kvRow('服务地址', `<span class="mono">${esc(src.convention.host)}</span>`)}
        ${kvRow('路径前缀', `<span class="mono">${esc(src.convention.pathPrefix)}</span>`)}
        ${kvRow('凭证位置', esc(src.convention.tokenUrl))}
        ${kvRow('响应结构', `<span class="small">${esc(src.convention.responseShape)}</span>`)}
        ${kvRow('限流', esc(src.convention.sla))}
        ${kvRow('数据时效', esc(src.convention.freshness))}
      </div>
      <div class="card tight">
        <div class="small" style="font-weight:650;margin-bottom:6px">请求头</div>
        ${Object.entries(src.convention.headers).map(([k, v]) => `
          <div style="padding:6px 0;border-bottom:1px solid var(--line-2)">
            <div class="between">
              <span class="mono small">${esc(k)}</span>
              ${v.required ? badge('必填', 'b-warn') : badge('可选', 'b-plain')}
            </div>
            <div class="small muted" style="margin-top:3px;line-height:1.55">${esc(v.desc)}</div>
          </div>`).join('')}
      </div>` : ''}

      ${src.solutions ? `
      ${sectionTitleLocal('解决方案枚举', '选错解决方案，能力一个都开不了')}
      <div class="card tight">
        <div class="tag-row" style="margin-top:0">
          ${Object.entries(src.solutions).map(([k, v]) =>
            badge(`${k} ${v}`, Number(k) === src.solutionForFitness ? 'b-green' : 'b-plain')).join('')}
        </div>
        <div class="hint" style="margin-top:8px;line-height:1.65">
          运动健身归在「到综行业」（${src.solutionForFitness}），不是到店餐饮。
          申请能力时选错这一项，后面所有接口都会因为权限不足失败。
        </div>
      </div>` : ''}

      ${src.authSpec.authFlows ? `
      ${sectionTitleLocal('授权方式', `${src.authSpec.authFlows.length} 条`)}
      <div class="card tight">
        ${src.authSpec.authFlows.map((f) => `
          <div class="spec-row">
            <div style="flex:1;min-width:0">
              <div class="t">${esc(f.name)}</div>
              <div class="small muted" style="margin-top:3px;line-height:1.6">${esc(f.how)}</div>
              ${f.urlPattern ? `<div class="m">${esc(f.urlPattern)}</div>` : ''}
            </div>
          </div>`).join('')}
        ${src.authSpec.quotaNote ? `<div class="divider"></div><div class="small muted">${esc(src.authSpec.quotaNote)}</div>` : ''}
      </div>` : ''}

      ${src.authSpec.authUrl ? `
      ${sectionTitleLocal('授权入口')}
      <div class="card tight">
        ${kvRow('授权地址', `<span class="mono small">${esc(src.authSpec.authUrl.base)}</span>`)}
        ${kvRow('签名参数', `<span class="small">${esc(src.authSpec.authUrl.params.join('、'))}</span>`)}
        ${kvRow('有效期', esc(src.authSpec.authUrl.validity))}
        <div class="hint" style="margin-top:7px;line-height:1.6">${esc(src.authSpec.authUrl.note)}</div>
      </div>` : ''}

      ${src.authSpec.knownPitfall ? `
      <div class="notice warn" style="margin-bottom:12px">
        <svg viewBox="0 0 24 24"><use href="#i-alert"/></svg>
        <div>${esc(src.authSpec.knownPitfall)}</div>
      </div>` : ''}

      ${sectionTitleLocal('接口能给到的')}
      <div class="card tight"><div class="tag-row">${src.knownScope.map((x) => badge(x, 'b-plain')).join('')}</div></div>

      ${sectionTitleLocal('拿不到的，别指望')}
      <div class="card tight">
        ${src.notAvailable.map((x) => `<div class="na-row"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg><span>${esc(x)}</span></div>`).join('')}
      </div>

      ${sectionTitleLocal('现在就能走的路')}
      <div class="card tight">
        <div class="small" style="line-height:1.75">${esc(src.fallback)}</div>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn primary sm" data-biz-report="${src.id}">导入后台报表</button>
          ${bizRecordsOf(sourceId).length ? '<button class="btn danger sm" data-biz-clear>清空已导入的记录</button>' : ''}
        </div>
      </div>`,
    footer: `<button class="btn ghost" data-sheet-close>关闭</button>
      <button class="btn primary" data-save>保存</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        setBizSource(sourceId, { poiId: String(f.poiId || '').trim() });
        toast('已保存');
        close();
        ctx.refresh();
      };

      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-biz-report]')) { close(); ctx.openBizReport(sourceId); return; }
        if (e.target.closest('[data-biz-clear]')) {
          confirmDialog({
            title: `清空 ${src.name} 的记录`,
            message: '会删掉这个来源已经导入的全部经营记录。<strong>不可恢复</strong>，建议先导出备份。',
            confirmText: '清空', danger: true,
            onConfirm() {
              clearBizRecords(sourceId);
              logBizEvent(sourceId, '清空了已导入的经营记录', { type: 'note', records: 0 });
              toast('已清空');
              close();
              ctx.refresh();
            },
          });
        }
      });
    },
  });
}
