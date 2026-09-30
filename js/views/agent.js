/* ============================================================
   views/agent.js · 智能体运行台（首页）
   ------------------------------------------------------------
   首页回答四件事，顺序就是一天的使用顺序：
     1. 它现在什么状态（规则数、上次运行、数据新不新鲜）
     2. 数据在指挥我动谁（指挥中心，按紧迫度排）
     3. 我的时间该怎么排（时间块）
     4. 今天必须清掉什么（自动提醒队列）
   底部三块说明"它凭什么这么判断"：规则、运行日志、进化建议。

   入口原则：队列里每一条都必须点得进去，不留死路。
     会员类 → 开客户触达台：话术、拨号、微信、备注在一屏里做完
              （早先「去处理」和「看档案」都调 openMember，
               两个按钮行为一模一样，等于没闭环）
     线索类 → 开线索详情，首响耗时那一栏就在表里
     课题类 → 跳成长页并展开那一课
     数据类 → 跳数据页的对接状态
     复盘类 → 开对应的 AI 任务包
   ============================================================ */
import {
  appointmentsOn, memberById, toggleBlock, removeBlock, resetDayPlan,
  logAgentRun, markAgentLog, cardsOfMember, setApptStatus, setMemberNote,
  markMemberHandled, unmarkMemberHandled, todayDoneIds, get as getStore,
  bumpWorkload, todayWorkload,
} from '../store.js';
import { run, evolve, agentSummary, commandCenter, ruleConfig, RULES, RULE_GROUPS, EVOLVE_TYPES } from '../agentEngine.js';
import { cardStatus, cardUrgency } from '../data/membership.js';
import { BLOCK_KINDS } from '../data/automation.js';
import { dueBadge, motionTags } from '../outreach.js';
import { badge, stageBadge, sectionTitle, emptyState, notice, openSheet, confirmDialog, toast, centerNotice } from '../components.js';
import { esc, avatarHtml, fmtDate, today, daysBetween, uid } from '../util.js';
import { progressRing } from '../charts.js';
import { gradeOf } from '../salesGrade.js';
import { GRADE_BADGE } from '../data/salesGrade.js';

export function title() { return '智能体'; }

/* 指挥中心的四档。给档位写清"为什么是这一档"，
   比只挂一个 P1/P2 有用：用户要判断的是"能不能推到明天"。 */
const CMD_LEVELS = {
  1: { label: '今天就该动', sub: '有明确的时限压力，拖过今天就贬值' },
  2: { label: '这两天要动', sub: '还没到临界点，但再拖就变成本周欠账' },
  3: { label: '维护关系', sub: '没有风险信号，趁关系还热深化一下' },
  4: { label: '例行维护', sub: '保持陪伴就行，不用刻意打扰' },
};

const APPT_TEXT = { pending: '待确认', confirmed: '已确认', arrived: '已到店', noshow: '爽约', canceled: '已取消' };
const LOG_TEXT = { hit: '待处理', done: '已处理', ignored: '已忽略' };

/* 一条命中算不算「今日已处理」，只看它指向的会员 id 是否进了今日归档集合。
   线索 / 课题 / 数据类命中没有会员 id，不参与归档。 */
function isHandledHit(h, doneIds) {
  return !h.lead && !h.topicId && h.target?.id && doneIds.includes(h.target.id);
}

/* 把自动运行结果拆成「待处理」与「今日已处理」两栏。 */
function splitHits(state) {
  const doneIds = todayDoneIds(state);
  const all = run(state).hits;
  return {
    pending: all.filter((h) => !isHandledHit(h, doneIds)),
    done: all.filter((h) => isHandledHit(h, doneIds)),
  };
}

export function render(ctx) {
  const s = ctx.state;
  const sum0 = agentSummary(s);
  const res = sum0.today;
  const sug = evolve(s);
  /* 今日已处理集合只算一次。指挥中心拿它做「处理完自动降级」，
     队列区拿它做「待处理 / 今日已处理」归档，两边共用同一份。 */
  const handledIds = todayDoneIds(s);
  const cmdsAll = commandCenter(s, 1e9, { handledIds });
  const cmds = cmdsAll.slice(0, 6);
  const appts = appointmentsOn(today());
  /* 今日工作流的 blocks 由 workflowSection(s) 自己读（供星星面板复用），这里不再取 */
  const openLeads = (s.leads || []).filter((l) => ['new', 'contacted'].includes(l.status));
  const topRules = RULES.filter((r) => ruleConfig(s, r.id).on).slice(0, 4);
  const log = s.automations?.log || [];
  const recentLog = log.slice(0, 6);
  /* 待处理 / 今日已处理 按会员归档拆分：记一次跟进或发新卡后，
     该会员的待办从「待处理」移到「今日已处理」，新的一天自动清空。 */
  /* splitHits 内部会跑一遍 run(state) 全量扫描。
     早先这里连写两次，等于把同一批数据算了两遍，改成算一次两边取。 */
  const hits = splitHits(s);
  const doneHits = hits.done;
  const pendingHits = hits.pending;

  /* 数据新鲜度：队列是按"上次运行那一刻"的数据算出来的。
     隔了几天没跑，里面的沉默天数、剩余课时全是旧值，得先在卡上说清，
     否则用户会拿着过期的队列去打电话。 */
  const staleDays = sum0.lastRunAt ? daysBetween(String(sum0.lastRunAt).slice(0, 10), today()) : null;

  return `
  <!-- 首页第一行只有字标本身。日期和问候放在它下面，不挤进海报里 -->
  <div class="poster">${posterMark()}</div>

  <div class="page-head">
    <h2 style="font-size:17px">${esc(ctx.greeting())}</h2>
    <p>${fmtDate(today(), 'full')} ${esc(ctx.weekday())}｜智能体在后台按 ${sum0.rulesOn} 条规则自动运行</p>
  </div>

  ${s.isDemo ? `
    <div class="demo-banner">
      <svg viewBox="0 0 24 24"><use href="#i-alert"/></svg>
      <div style="flex:1">当前是<strong>示例数据</strong>，用来演示这套自动运行逻辑。换成你自己的会员后，规则会照常工作。</div>
      <button data-act="clear-demo">清空</button>
    </div>` : ''}

  <!-- 智能体状态 -->
  <div class="card" style="border-color:var(--brand-tint-2);background:linear-gradient(150deg,#F4FBF7,#FBFEFC)">
    <div class="flex" style="gap:14px;align-items:center">
      ${progressRing({ value: sum0.adoptRate, size: 104, label: '建议采纳率', display: (sum0.adoptRate * 100).toFixed(0) + '%' })}
      <div style="flex:1;min-width:0">
        <div class="between" style="margin-bottom:6px">
          <span class="small" style="font-weight:700">自动运行中</span>
          <span class="badge b-green"><span class="dot"></span>${sum0.rulesOn}/${sum0.rulesTotal} 条规则</span>
        </div>
        ${kvMini('上次运行', sum0.lastRunAt ? `${sum0.lastRunAt}｜${agoText(staleDays)}` : '还没跑过')}
        ${kvMini('今日命中', `${res.count} 条待办`)}
        ${kvMini('待接线索', `${openLeads.length} 条`)}
        ${kvMini('近 30 天', `命中 ${sum0.hit30} 次，采纳 ${sum0.done30} 次`)}
        ${kvMini('进化建议', `${sug.length} 条待你看`)}
      </div>
    </div>
    ${staleBlock(staleDays)}
    <div class="btn-row" style="margin-top:12px">
      <button class="btn primary" data-act="run"><svg viewBox="0 0 24 24"><use href="#i-sync"/></svg>立即运行一次</button>
      <button class="btn ghost" data-act="rules">规则中心</button>
      <button class="btn ghost" data-act="evolve">进化建议 ${sug.length}</button>
    </div>
  </div>

  ${sectionTitle('数据在指挥我动谁', cmdsAll.length > cmds.length ? `最急的 ${cmds.length} 人，共 ${cmdsAll.length} 人` : `共 ${cmdsAll.length} 人`)}
  ${cmds.length ? cmds.map(({ member, cmd }) => commandCard(member, cmd)).join('') : emptyState('还没有会员数据', 'i-users')}
  ${cmdsAll.length > cmds.length ? `<button class="btn ghost block sm" data-act="cmds">查看全部 ${cmdsAll.length} 人的动作</button>` : ''}


  ${sectionTitle('自动提醒', `${pendingHits.length} 条待清`)}
  <div class="chips" style="margin-bottom:10px">
    <button class="chip on" data-qfilter="all">全部 ${pendingHits.length}</button>
    ${Object.entries(RULE_GROUPS).map(([k, v]) => {
      const n = pendingHits.filter((h) => h.group === k).length;
      return n ? `<button class="chip" data-qfilter="${k}">${esc(v.label)} ${n}</button>` : '';
    }).join('')}
  </div>
  <div id="hitList">${pendingHits.length ? pendingHits.map(hitCard).join('') : emptyState('队列已清空。可以去做内容或学习任务。', 'i-check')}</div>

  ${doneHits.length ? `
  ${sectionTitle('今日已处理', `${doneHits.length} 条`)}
  <div class="card tight" style="background:var(--surface-2)">
    ${doneHits.map((h) => {
      const name = h.target?.name || '系统';
      return `<div class="between" style="padding:9px 0;border-bottom:1px solid var(--line-2)">
        <div style="min-width:0">
          <div class="small" style="font-weight:600">${esc(name)}</div>
          <div class="small muted" style="margin-top:2px;line-height:1.55">${esc(h.ruleName)}：${esc(h.text)}</div>
        </div>
        <button class="btn ghost sm" data-unmark-done="${esc(h.target.id)}">撤销归档</button>
      </div>`;
    }).join('')}
    <div class="hint" style="margin-top:8px">这批待办已归档为「今日已处理」。新的一天自动清空，不影响规则本身的运行记录。</div>
  </div>` : ''}

  ${sectionTitle('今日预约', `${appts.length} 场`)}
  ${appts.length ? `<div class="list">${appts.map((a) => {
    const m = memberById(a.memberId);
    const quick = a.status === 'pending' ? { to: 'confirmed', text: '确认' }
      : a.status === 'confirmed' ? { to: 'arrived', text: '到店' } : null;
    return `<div class="list-item static">
      <button class="li-hit" data-member="${a.memberId}">
        ${avatarHtml(m?.name || '?')}
        <div class="li-body">
          <div class="li-top"><span class="li-name">${esc(a.time)} ${esc(a.type)}</span>${badge(APPT_TEXT[a.status] || a.status, a.status === 'pending' ? 'b-warn' : 'b-green')}</div>
          <div class="li-meta"><span>${esc(m?.name || '')}</span>${a.note ? `<span>${esc(a.note)}</span>` : ''}</div>
        </div>
      </button>
      ${quick
        ? `<button class="btn ghost sm" data-appt="${a.id}" data-to="${quick.to}" style="flex:0 0 auto">${quick.text}</button>`
        : `<svg class="chev" viewBox="0 0 24 24"><use href="#i-chev"/></svg>`}
    </div>`;
  }).join('')}</div>` : emptyState('今天还没有预约', 'i-calendar')}

  ${sectionTitle('我在跟的规则', `${sum0.rulesOn} 条开启`)}
  <div class="card tight">
    ${topRules.map((r) => {
      const cfg = ruleConfig(s, r.id);
      return `<div class="between" style="padding:8px 0;border-bottom:1px solid var(--line-2)">
        <div style="min-width:0">
          <div class="small" style="font-weight:650">${esc(r.name)}</div>
          <div class="small muted" style="margin-top:2px;line-height:1.55">${esc(r.trigger)}</div>
        </div>
        <div class="btn-row" style="flex:0 0 auto">
          <button class="btn ghost sm" data-act="ai-tune-rule" data-rid="${r.id}" title="用 AI 调这条规则的阈值与优先级">AI 修改</button>
          <span class="badge ${cfg.on ? 'b-green' : 'b-plain'}">${cfg.on ? '已开启' : '已关闭'}</span>
        </div>
      </div>`;
    }).join('')}
    <button class="btn ghost block sm" style="margin-top:10px" data-act="rules">查看全部 ${RULES.length} 条规则</button>
  </div>

  ${sectionTitle('运行日志', log.length > recentLog.length ? `最近 ${recentLog.length} 次，共 ${log.length} 次` : `共 ${log.length} 次`)}
  ${recentLog.length ? `<div class="card tight">
    ${recentLog.map((l) => `
      <div class="between" style="padding:8px 0;border-bottom:1px solid var(--line-2)">
        <div style="min-width:0">
          <div class="small" style="font-weight:650">${esc(l.ruleName)}</div>
          <div class="small muted" style="margin-top:2px">${esc(l.at)}｜命中 ${l.count} 条${(l.targets || []).length ? '｜' + esc(l.targets.slice(0, 3).join('、')) : ''}</div>
        </div>
        <span class="badge ${l.status === 'done' ? 'b-green' : l.status === 'ignored' ? 'b-plain' : 'b-warn'}">${esc(LOG_TEXT[l.status] || l.status)}</span>
      </div>`).join('')}
    ${log.length > recentLog.length ? `<button class="btn ghost block sm" style="margin-top:10px" data-act="log">查看全部 ${log.length} 次运行</button>` : ''}
  </div>` : emptyState('还没有运行记录，先点上面的「立即运行一次」', 'i-sync')}

  ${sectionTitle('AI 辅助工作流', '12 个任务包')}
  <div class="card">
    <div class="small muted" style="line-height:1.65">
      FitFlow 负责把你的数据和任务说明整理成结构化提示词，你拿到自己的 AI 工具里跑完再粘回来。FitFlow 不生成、也不伪造分析结论。
    </div>
    <div class="btn-row" style="margin-top:11px">
      <button class="btn ghost" data-act="ai-hub"><svg viewBox="0 0 24 24"><use href="#i-spark"/></svg>打开任务包</button>
      <button class="btn ghost" data-act="ai-reflect">交互复盘</button>
      <button class="btn ghost" data-act="ai-tune">规则调优</button>
    </div>
  </div>`;
}

/* ---------------- 首页通栏字标 ---------------- */

/**
 * 用 SVG 而不是 <span>，是因为要的是「左右拉伸铺满」：
 * 字本身的横向比例被拉到刚好填满整行，并且随屏幕宽度连续变化。
 *
 * textLength + lengthAdjust="spacingAndGlyphs" 是唯一能精确做到这一点的办法。
 * 靠 font-size 配 clamp() 只能凑近似值，换一个屏宽右边就对不齐了 ——
 * 而"对不齐右边"正是通栏字标最难看的一种失败。
 *
 * viewBox 高 17：配合 800 字重的 cap height，出来的带高约为屏宽的 17%，
 * 手机上（480 宽）约 82px，既撑得起海报感，又不至于把首屏推下去。
 *
 * 为什么 viewBox 是 105 宽而 textLength 是 100：
 *   SVG 根元素默认 overflow:hidden，超出 viewBox 的部分会被直接切掉。
 *   而 textLength 约束的是"字身宽度"，管不到斜体那层右倾 ——
 *   斜体把字顶往右推，约 11° 倾斜、cap 高度 14.4 单位，右移约 2.8 单位。
 *   所以在 100 宽的 viewBox 里排 100 宽的字，最后那个 w 的右上角必然被切片。
 *   多出的 5 个单位专门是给这层倾斜留的余量，不是留白。
 *
 * 左边保持 x=0：斜体最左的点在基线，正好落在这条边上，做到左齐平。
 * 加宽只加右侧，等于把余量全给右边 —— 两边都留就会变成居中，那就不叫通栏了。
 */
function posterMark() {
  return `<svg viewBox="0 0 105 17" role="img" aria-label="FitFlow">
    <defs>
      <linearGradient id="ffPoster" x1="0" y1="0.1" x2="1" y2="0.9">
        <stop offset="0" style="stop-color:var(--grad-a)"/>
        <stop offset="0.38" style="stop-color:var(--grad-b)"/>
        <stop offset="0.72" style="stop-color:var(--grad-c)"/>
        <stop offset="1" style="stop-color:var(--grad-d)"/>
      </linearGradient>
    </defs>
    <text x="0" y="14.4" textLength="100" lengthAdjust="spacingAndGlyphs"
      font-size="20" font-weight="800" font-style="italic"
      fill="url(#ffPoster)">FitFlow</text>
  </svg>`;
}

/* ---------------- 小构件 ---------------- */

const kvMini = (k, v) => `<div class="between" style="padding:3px 0"><span class="small muted">${esc(k)}</span><span class="small" style="font-weight:650">${esc(v)}</span></div>`;

/** 到店时间文案：0 天不能写「0 天前到店」，那是今天刚来。 */
function visitLabel(dateStr) {
  const d = -daysBetween(today(), dateStr);
  if (d <= 0) return '今天到店';
  if (d === 1) return '昨天到店';
  return `${d} 天前到店`;
}

function agoText(days) {
  if (days == null) return '';
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

/** 数据过期提示。没跑过和跑太久是两种不同的问题，给两种不同的话。 */
function staleBlock(days) {
  if (days == null) {
    return `<div style="margin-top:11px">${notice('这个智能体还没跑过。点一次「立即运行一次」，它会按规则把今天的队列和提醒生成出来。', 'info', 'i-spark')}</div>`;
  }
  if (days < 2) return '';
  return `<div style="margin-top:11px">${notice(
    `距上次运行已经 ${days} 天。队列里的沉默天数、剩余课时都是按上次运行那一刻算的，这中间发生的进进出出它并不知道。点「立即运行一次」重扫一遍再照着做。`,
    'warn'
  )}</div>`;
}

/* ---------------- 指挥卡 ---------------- */

/**
 * 卡片上的销售等级角标。
 * 只显示字母和跟进周期 —— 卡片上放不下完整的评分明细，
 * 要看明细去会员档案的「销售等级」一节。
 */
function gradeChip(m) {
  const g = gradeOf(m, getStore());
  return `<span class="badge ${GRADE_BADGE[g.id]}" title="${esc(g.label + ' · ' + g.name + ' · 跟进周期 ' + g.followCycle + ' 天')}">${esc(g.id)}</span>`;
}

function commandCard(m, cmd) {
  const cards = cardsOfMember(m.id);
  const worst = cmd.card;
  return `<div class="card tight" data-member="${m.id}">
    <div class="between">
      <div class="flex" style="min-width:0;gap:10px">
        ${avatarHtml(m.name)}
        <div style="min-width:0">
          <div class="li-top">
            <span class="li-name">${esc(m.name)}</span>
            ${stageBadge(m.stage)}
            ${gradeChip(m)}
            <span class="badge ${cmd.level === 1 ? 'b-danger' : cmd.level === 2 ? 'b-warn' : 'b-plain'}">P${cmd.level}</span>
            ${dueBadge(m) || (worst ? `<span class="badge ${cardStatus(worst).cls}">${esc(cardUrgency(worst).label)}</span>` : '')}
          </div>
          <div class="li-meta"><span>${esc(m.cardType || '未办卡')}</span>${cards.length ? `<span>${cards.length} 张卡</span>` : ''}${m.lastVisit ? `<span>${esc(visitLabel(m.lastVisit))}</span>` : ''}</div>
        </div>
      </div>
    </div>
    ${cmd.revived ? `<div class="cmd-revive">${esc(cmd.reviveReason)}</div>` : ''}
    ${cmd.demoted ? `<div class="cmd-demoted">今天已处理，优先级降到 P${cmd.level}</div>` : ''}
    <div style="margin-top:9px;padding:9px 10px;background:var(--surface-2);border-radius:10px">
      <div style="font-size:13px;font-weight:680">${esc(cmd.action)}<span class="auto-chip">自动</span></div>
      <div class="small auto-val" style="margin-top:4px;line-height:1.6">${esc(cmd.why)}</div>
      <div class="tag-row" style="margin-top:6px">
        ${motionTags(m, { compact: true })}
        <span class="src">${esc(cmd.channel)}</span>
        <span class="src">${esc(cmd.window)}</span>
        ${cmd.principle ? `<span class="src qn">${esc(cmd.principle.name)}</span>` : ''}
      </div>
    </div>
    ${noteLine(m)}
    <div class="btn-row" style="margin-top:9px">
      <button class="btn primary sm" data-act="cmd-do" data-mid="${m.id}">去处理</button>
      <button class="btn ghost sm" data-act="ai-psych" data-mid="${m.id}">AI 话术</button>
      <button class="btn ghost sm" data-member="${m.id}">看档案</button>
    </div>
  </div>`;
}

/**
 * 任务卡上的备注就地编辑。
 * 「去处理」之前往往要先把刚打听到的信息记下来，
 * 为这一句话专门跳进档案再跳回来，来回两次就没人记了。
 *
 * 字号必须 16px：iOS 会在聚焦小于 16px 的输入框时把整个页面放大。
 */
function noteLine(m) {
  return `<div class="note-inline">
    <input class="input" data-note="${m.id}" value="${esc(m.note || '')}"
      placeholder="补一句备注，自动保存" aria-label="${esc(m.name)}的备注" />
    <div class="note-saved" data-note-saved="${m.id}">已保存</div>
  </div>`;
}

/* ---------------- 队列卡 ---------------- */

/**
 * 队列里的每条都得有出口。
 * 早先只有会员类带了按钮，线索 / 课题 / 数据 / 复盘四类点不动，
 * 提醒看得见却接不下去，整块等于一块只读告示。
 */
function hitActions(h) {
  const mid = h.target?.id;
  if (h.lead) {
    return `<button class="btn primary sm" data-act="lead-do" data-lid="${esc(mid)}">处理这条线索</button>`;
  }
  if (h.topicId) {
    return `<button class="btn primary sm" data-act="go-topic" data-topic="${esc(h.topicId)}">去看这一课</button>
      <button class="btn ghost sm" data-act="topic-log" data-topic="${esc(h.topicId)}">记一条产出</button>`;
  }
  if (h.target?.stage) {
    return `<button class="btn primary sm" data-act="cmd-do" data-mid="${esc(mid)}">去处理</button>
      <button class="btn ghost sm" data-act="ai-psych" data-mid="${esc(mid)}">AI 话术</button>
      <button class="btn ghost sm" data-member="${esc(mid)}">看档案</button>`;
  }
  if (mid === 'data') return `<button class="btn primary sm" data-act="go-data">去核对数据来源</button>`;
  if (h.ruleId === 'weekly_review') return `<button class="btn primary sm" data-act="ai-weekly">生成周复盘提示词</button>`;
  if (h.ruleId === 'daily_standup') return `<button class="btn ghost sm" data-act="run">重新扫描一遍</button>`;
  return '';
}

function hitCard(h) {
  const g = RULE_GROUPS[h.group] || { label: h.group };
  const name = h.target?.name || '系统';
  const isMember = Boolean(!h.lead && !h.topicId && h.target?.stage);
  const actions = hitActions(h);
  /* 会员类提醒把"卡课到期"和"运动综合"直接挂在名字那一行。
     看到名字就能决定先打谁，不用点进去才知道为什么被提醒。 */
  const m = isMember ? memberById(h.target.id) : null;
  return `<div class="card tight" ${isMember ? `data-member="${esc(h.target.id)}"` : ''}>
    <div class="between">
      <div style="min-width:0">
        <div class="li-top">
          <span class="li-name" style="font-size:13.5px">${esc(name)}</span>
          <span class="badge ${h.priority === 1 ? 'b-danger' : h.priority === 2 ? 'b-warn' : 'b-plain'}">P${h.priority}</span>
          ${m ? dueBadge(m) : ''}
          <span class="badge b-plain">${esc(g.label)}</span>
        </div>
        <div class="small muted" style="margin-top:4px;line-height:1.6">${esc(h.ruleName)}：${esc(h.text)}</div>
        ${m ? `<div class="tag-row">${motionTags(m, { compact: true })}</div>` : ''}
      </div>
    </div>
    ${actions ? `<div class="btn-row" style="margin-top:8px">${actions}</div>` : ''}
  </div>`;
}

/* ============================================================
   子面板
   ============================================================ */

export function openRulesSheet(ctx, after) {
  const s = ctx.state;
  openSheet({
    title: '规则中心',
    subtitle: `${RULES.filter((r) => ruleConfig(s, r.id).on).length} 条开启 / 共 ${RULES.length} 条`,
    size: 'tall',
    body: Object.entries(RULE_GROUPS).map(([g, meta]) => {
      const list = RULES.filter((r) => r.group === g);
      if (!list.length) return '';
      return `<div class="section-title">${esc(meta.label)}</div>
        ${list.map((r) => {
          const cfg = ruleConfig(s, r.id);
          const e = r.effect || {};
          return `<div class="card tight">
            <div class="between">
              <div style="min-width:0">
                <div class="small" style="font-weight:680">${esc(r.name)}</div>
                <div class="small muted" style="margin-top:3px;line-height:1.6">${esc(r.trigger)}</div>
              </div>
              <button class="chip ${cfg.on ? 'on' : ''}" data-rule-toggle="${r.id}" style="flex:0 0 auto">${cfg.on ? '已开' : '已关'}</button>
            </div>
            <div class="divider" style="margin:9px 0"></div>
            ${kvMini('动作', r.action)}
            ${kvMini('渠道', r.channel)}
            ${kvMini('时机', r.when)}
            ${kvMini('优先级', 'P' + r.priority)}
            ${kvMini('阈值', Object.entries(cfg.params).map(([k, v]) => `${k}=${v}`).join('，') || '无')}
            ${kvMini('近 30 天', `命中 ${e.hit30 || 0}，采纳 ${e.done || 0}，忽略 ${e.ignored || 0}`)}
            <div class="hint" style="margin-top:7px">${esc(r.note)}</div>
          </div>`;
        }).join('')}`;
    }).join(''),
    onMount(el, close) {
      el.addEventListener('click', (e) => {
        const t = e.target.closest('[data-rule-toggle]');
        if (!t) return;
        const id = t.dataset.ruleToggle;
        const cur = ruleConfig(ctx.state, id).on;
        ctx.setRule(id, { on: !cur });
        toast(!cur ? '规则已开启' : '规则已关闭');
        close();
        setTimeout(() => openRulesSheet(ctx, after), 80);
      });
    },
  });
}

/** 全部会员的指挥清单。首页只放最急的 6 个，这里是完整排序。 */
export function openCommandSheet(ctx) {
  const all = commandCenter(ctx.state, 1e9, { handledIds: todayDoneIds(ctx.state) });
  const groups = [];
  all.forEach((item) => {
    let g = groups.find((x) => x.level === item.cmd.level);
    if (!g) { g = { level: item.cmd.level, items: [] }; groups.push(g); }
    g.items.push(item);
  });

  openSheet({
    title: '指挥中心',
    subtitle: `${all.length} 位会员全部在列，按紧迫度排`,
    size: 'tall',
    body: all.length ? `
      ${notice('排序依据是卡的剩余量与到期日、多久没到店、上次约定了哪天做什么。同一档里没有先后，谁先处理都可以。', 'info', 'i-target')}
      ${groups.map((g) => {
        const meta = CMD_LEVELS[g.level] || CMD_LEVELS[4];
        return `<div class="section-title">${esc(meta.label)}<span class="count">${g.items.length} 人</span></div>
          <div class="small muted" style="margin:-4px 0 9px">${esc(meta.sub)}</div>
          ${g.items.map(({ member, cmd }) => commandCard(member, cmd)).join('')}`;
      }).join('')}` : emptyState('还没有会员数据', 'i-users'),
    onMount(el, close) {
      /* 抽屉里再叠一层抽屉会盖住返回路径，所以先关这一层再开下一层 */
      el.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        if (act) {
          const a = act.dataset.act;
          const mid = act.dataset.mid;
          if (a === 'cmd-do') { close(); ctx.openContact(mid); return; }
          if (a === 'ai-psych') { close(); ctx.openAi('psych', mid); return; }
          if (a === 'ai-weekly') { close(); ctx.openAi('weekly', null); return; }
        }
        const mb = e.target.closest('[data-member]');
        if (mb && mb.dataset.member) { close(); ctx.openMember(mb.dataset.member); }
      });
    },
  });
}

function openEvolveSheet(ctx, after) {
  const sug = evolve(ctx.state);
  openSheet({
    title: '进化建议',
    subtitle: '根据规则的历史命中与采纳率算出来的，不是猜测',
    size: 'tall',
    body: `
      ${notice('这套建议完全来自你自己的运行数据。命中多但采纳少的规则会被建议降级，稳定有效的会被建议提前介入，数据不够的会被标成"先补数据"。', 'info', 'i-spark')}
      ${sug.length ? sug.map((x) => {
        const t = EVOLVE_TYPES[x.type] || { label: x.type, cls: 'b-plain' };
        return `<div class="card tight">
          <div class="between">
            <div class="small" style="font-weight:680">${esc(x.title)}</div>
            <span class="badge ${t.cls}">${esc(t.label)}</span>
          </div>
          <div class="small" style="margin-top:6px;line-height:1.7">${esc(x.text)}</div>
          <div class="btn-row" style="margin-top:9px">
            <button class="btn ghost sm" data-sug-act="${x.ruleId}:${x.action}">${esc(x.action)}</button>
            <button class="btn ghost sm" data-sug-later="${x.ruleId}">先记下</button>
          </div>
        </div>`;
      }).join('') : emptyState('暂时没有需要调整的地方', 'i-check')}
    `,
    onMount(el, close) {
      el.addEventListener('click', (e) => {
        const a = e.target.closest('[data-sug-act]');
        if (a) {
          const [ruleId, action] = a.dataset.sugAct.split(':');
          if (action === '降优先级') {
            const cur = ruleConfig(ctx.state, ruleId).priority;
            ctx.setRule(ruleId, { priority: Math.min(5, cur + 1) });
            toast('已把优先级调低一档');
          } else if (action === '前移阈值') {
            const r = RULES.find((x) => x.id === ruleId);
            const key = r ? Object.keys(r.params)[0] : null;
            if (key) {
              const cur = ruleConfig(ctx.state, ruleId).params[key];
              const next = typeof cur === 'number' ? Math.max(1, Math.round(cur * 0.8)) : cur;
              ctx.setRuleParam(ruleId, key, next);
              toast(`阈值 ${key} 已从 ${cur} 调到 ${next}，会更早提醒`);
            } else toast('这条规则没有可调阈值');
          } else {
            toast('已记下这条建议');
          }
          /* 工作量：处理（采纳 / 记下）一条进化建议 = 一次观察量 */
          bumpWorkload('obs');
          close();
          after && after();
          ctx.refresh();
          return;
        }
        if (e.target.closest('[data-sug-later]')) {
          toast('已记下，下次运行会再提醒你');
          close();
        }
      });
    },
  });
}

/**
 * 运行日志。
 * 首页只放最近 6 条，这里是全部（最多留 60 条，见 store.logAgentRun）。
 * 日志不只是流水：标已处理会被采纳率统计进去，忽略会成为进化建议的样本，
 * 所以这里得能筛、能就地处理。
 */
export function openLogSheet(ctx) {
  const log = ctx.state.automations?.log || [];
  const counts = { hit: 0, done: 0, ignored: 0 };
  log.forEach((l) => { counts[l.status] = (counts[l.status] || 0) + 1; });

  openSheet({
    title: '运行日志',
    subtitle: `累计运行 ${ctx.state.automations?.runCount || 0} 次，留下 ${log.length} 条记录`,
    size: 'tall',
    body: log.length ? `
      ${notice('每条记录是一次规则命中。标成已处理会算进采纳率，标成忽略会成为进化建议的样本，两个都别乱点。', 'info', 'i-sync')}
      <div class="chips" style="margin-bottom:10px">
        <button class="chip on" data-log-filter="all">全部 ${log.length}</button>
        ${['hit', 'done', 'ignored'].filter((k) => counts[k]).map((k) =>
          `<button class="chip" data-log-filter="${k}">${LOG_TEXT[k]} ${counts[k]}</button>`).join('')}
      </div>
      <div id="logList"></div>` : emptyState('还没有运行记录，先回首页点一次「立即运行一次」', 'i-sync'),
    onMount(el, close) {
      const draw = (f) => {
        const list = f === 'all' ? log : log.filter((l) => l.status === f);
        el.querySelector('#logList').innerHTML = list.length
          ? `<div class="timeline">${list.map((l) => `
              <div class="tl-item ${l.status === 'done' ? 'on' : l.status === 'hit' ? 'warn' : ''}">
                <div class="tl-date">${esc(l.at)}｜${esc(LOG_TEXT[l.status] || l.status)}</div>
                <div class="tl-title">${esc(l.ruleName)}</div>
                <div class="tl-body">命中 ${l.count} 条${(l.targets || []).length ? '：' + esc(l.targets.join('、')) : ''}</div>
                ${l.status === 'hit' ? `<div class="btn-row" style="margin-top:6px">
                  <button class="btn ghost sm" data-log-done="${l.id}">标记已处理</button>
                  <button class="btn ghost sm" data-log-ignore="${l.id}">忽略这条</button>
                </div>` : ''}
              </div>`).join('')}</div>`
          : emptyState('这一类暂时没有记录');
      };

      el.addEventListener('click', (e) => {
        const f = e.target.closest('[data-log-filter]');
        if (f) {
          el.querySelectorAll('[data-log-filter]').forEach((b) => b.classList.toggle('on', b === f));
          draw(f.dataset.logFilter);
          return;
        }
        const d1 = e.target.closest('[data-log-done]');
        if (d1) { markAgentLog(d1.dataset.logDone, 'done'); toast('已标记处理'); close(); ctx.refresh(); return; }
        const d2 = e.target.closest('[data-log-ignore]');
        if (d2) { markAgentLog(d2.dataset.logIgnore, 'ignored'); toast('已忽略，进化建议会用到这个数据'); close(); ctx.refresh(); }
      });

      draw('all');
    },
  });
}

/* ============================================================
   事件
   ============================================================ */

/**
 * 备注就地存盘。
 * 两个刻意的选择：
 *   1. 静默写盘（silent）。打字途中重渲染会把光标弹回开头，
 *      安卓上还会把软键盘收掉，所以录完之前不触发全局刷新。
 *      数据已经进库了，打开档案看到的就是新的。
 *   2. 防抖 700ms。每敲一个字写一次 localStorage 在老机器上会卡。
 */
const noteTimers = new Map();

function bindNotes(root) {
  root.addEventListener('input', (e) => {
    const el = e.target.closest('[data-note]');
    if (!el) return;
    const id = el.dataset.note;
    clearTimeout(noteTimers.get(id));
    noteTimers.set(id, setTimeout(() => {
      setMemberNote(id, el.value, { silent: true });
      const flag = root.querySelector(`[data-note-saved="${id}"]`);
      if (flag) {
        flag.classList.add('on');
        setTimeout(() => flag.classList.remove('on'), 1300);
      }
    }, 700));
  });
}

/**
 * 今日工作流（原智能体页内的「个人工作流」）。
 *
 * 现在由顶栏星星下拉面板调用（app.js renderHeader），落在面板底部。
 * 交互在 app.js bindShell 里统一接管：勾选完成 / 编辑 / 删除 / 加时间块 / 套模板 / 周复盘。
 * 抽成导出函数是为了让「智能体页」和「星星面板」用的是同一份渲染与同一套口径。
 */
export function workflowSection(s) {
  const blocks = s.dayPlan?.blocks || [];
  const doneBlocks = blocks.filter((b) => b.done).length;
  return `
    ${sectionTitle('今日工作流', `${doneBlocks}/${blocks.length} 已完成`)}
    <div class="card tight">
      ${blocks.length ? `<div class="dayplan">${blocks.map((b) => {
        const k = BLOCK_KINDS[b.kind] || { label: b.kind, color: '#8A9A93' };
        const mid = b.linkedMemberId ? memberById(b.linkedMemberId) : null;
        const now = new Date().toTimeString().slice(0, 5);
        const isNow = now >= b.start && now <= b.end;
        return `<div class="tb ${b.done ? 'done' : ''} ${isNow ? 'now' : ''}">
          <div class="tb-time">${esc(b.start)}<br/><span>${esc(b.end)}</span></div>
          <div class="tb-line"><i style="background:${k.color}"></i></div>
          <div class="tb-body">
            <div class="between">
              <button class="check ${b.done ? 'on' : ''}" data-block="${b.id}" aria-label="标记完成">
                <svg viewBox="0 0 24 24"><use href="#i-check"/></svg>
              </button>
              <button class="tb-hit" data-block-edit="${b.id}">
                <span class="tb-title">${esc(b.title)}${isNow ? ' <span class="badge b-teal">正在进行</span>' : ''}</span>
                <span class="small muted" style="margin-top:2px">${esc(k.label)}${mid ? '｜' + esc(mid.name) : ''}${b.remind && b.remind.method !== 'none' ? `｜<span class="src">${b.remind.method === 'system' ? '系统' : '应用'}·提前${b.remind.lead}分</span>` : ''}</span>
              </button>
              <button class="btn ghost sm" data-block-del="${b.id}" style="flex:0 0 auto">删</button>
            </div>
          </div>
        </div>`;
      }).join('')}</div>` : emptyState('今天还没有排时间块', 'i-calendar')}
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost sm" data-act="add-block">加时间块</button>
        <button class="btn ghost sm" data-act="reset-plan">套用每日模板</button>
        <button class="btn ghost sm" data-act="ai-weekly">周复盘</button>
      </div>
      <div class="hint" style="margin-top:8px">今日工作流不是日程表，是"我打算把精力花在哪"。完成度低于 50% 通常说明排得太满。点时间块本身可以改内容和时段。</div>
    </div>`;
}

export function mount(root, ctx) {
  bindNotes(root);

  root.addEventListener('click', (e) => {
    const filter = e.target.closest('[data-qfilter]');
    if (filter) {
      root.querySelectorAll('[data-qfilter]').forEach((b) => b.classList.toggle('on', b === filter));
      const g = filter.dataset.qfilter;
      /* splitHits 跑一次就够，两个分支共用同一份 pending */
      const pending = splitHits(ctx.state).pending;
      const list = g === 'all' ? pending : pending.filter((h) => h.group === g);
      root.querySelector('#hitList').innerHTML = list.length ? list.map(hitCard).join('') : emptyState('这一类没有待办');
      return;
    }

    const unmark = e.target.closest('[data-unmark-done]');
    if (unmark) {
      unmarkMemberHandled(unmark.dataset.unmarkDone);
      toast('已撤销归档，回到待处理');
      ctx.refresh({ keepScroll: true });
      return;
    }

    const tuneRule = e.target.closest('[data-act="ai-tune-rule"]');
    if (tuneRule) { ctx.openAi('tune', null, null, { ruleId: tuneRule.dataset.rid }); return; }

    const blk = e.target.closest('[data-block]');
    if (blk) { toggleBlock(blk.dataset.block); ctx.refresh({ keepScroll: true }); return; }

    const del = e.target.closest('[data-block-del]');
    if (del) { removeBlock(del.dataset.blockDel); ctx.refresh({ keepScroll: true }); return; }

    const editBlk = e.target.closest('[data-block-edit]');
    if (editBlk) { ctx.openBlockForm(editBlk.dataset.blockEdit); return; }

    const appt = e.target.closest('[data-appt]');
    if (appt) {
      const to = appt.dataset.to;
      setApptStatus(appt.dataset.appt, to);
      toast(to === 'confirmed' ? '预约已确认' : '已标记到店');
      ctx.refresh({ keepScroll: true });
      return;
    }

    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      const mid = act.dataset.mid;
      if (a === 'run') {
        const res = run(ctx.state);
        const entries = Object.entries(res.byRule).map(([ruleId, hits]) => ({
          id: uid('ag'),
          at: new Date().toISOString().slice(0, 16).replace('T', ' '),
          ruleId,
          ruleName: hits[0].ruleName,
          group: hits[0].group,
          count: hits.length,
          status: 'hit',
          targets: hits.map((h) => h.target?.name || '').filter(Boolean),
        }));
        logAgentRun(entries);
        toast(`运行完成：${res.count} 条待办，${entries.length} 条规则命中`);
        ctx.refresh();
        /* 每次「立即运行」之后居中汇报今日工作量。
           顶栏的运行按钮走的是同一个 [data-act="run"]（runFromHeader 直接点它），
           所以这条链路只写一次就两边都覆盖。 */
        const w = todayWorkload(getStore());
        centerNotice('今日工作量', `操作量 ${w.ops} · 观察量 ${w.obs}`);
        return;
      }
      if (a === 'rules') return openRulesSheet(ctx, () => ctx.refresh());
      if (a === 'evolve') return openEvolveSheet(ctx, () => ctx.refresh());
      if (a === 'log') return openLogSheet(ctx);
      if (a === 'cmds') return openCommandSheet(ctx);
      if (a === 'clear-demo') return ctx.clearDemo();
      if (a === 'add-block') return ctx.openBlockForm();
      if (a === 'reset-plan') {
        return confirmDialog({
          title: '套用每日模板', message: '会用标准时间块模板替换今天现有的安排。确认吗？', confirmText: '套用',
          onConfirm() { resetDayPlan(); toast('已套用每日模板'); ctx.refresh(); },
        });
      }
      if (a === 'ai-hub') return ctx.openAiHub();
      if (a === 'ai-models') return ctx.openModelMarket();
      if (a === 'ai-weekly') return ctx.openAi('weekly', null);
      if (a === 'ai-reflect') return ctx.openAi('reflect', null);
      if (a === 'ai-tune') return ctx.openAi('tune', null);
      if (a === 'ai-psych') return ctx.openAi('psych', mid);
      /* 「去处理」落到客户触达台：话术、拨号、微信、备注都在那一屏里。
         早先是落到跟进表单（和「看档案」一样只是跳走），
         动作按钮做不到动作，队列永远清不空。 */
      if (a === 'cmd-do') return ctx.openContact(mid);
      if (a === 'lead-do') return ctx.openLeadForm(act.dataset.lid);
      if (a === 'topic-log') return ctx.openTopicEvidence(act.dataset.topic);
      if (a === 'go-topic') return ctx.goTopic(act.dataset.topic);
      if (a === 'go-data') { toast('对接状态在数据页底部'); ctx.go('analytics'); return; }
      return;
    }

    const mb = e.target.closest('[data-member]');
    if (mb && mb.dataset.member) ctx.openMember(mb.dataset.member);
  });
}
