/* ============================================================
   app.js · 应用外壳
   ------------------------------------------------------------
   这个文件只做四件事，业务逻辑一律不写在这里：
     1. 装配 ctx —— 把数据层、视图层、抽屉层串成一个对象
     2. 路由 —— 五个功能分类之间的切换
     3. 渲染壳 —— 顶栏 / 主区 / 底栏
     4. 全局兜底 —— 只在顶栏和底栏生效，不碰视图内部

   功能分类的依据（这是这个程序的组织主线）：
     智能体   = 个人工作时间管理：自动运行、自动提醒、时间块
     客户     = 会员与会籍：数据指挥销售、精细化卡管理、定期跟进
     运营     = 获客与社群：内容带线索、社群接线索
     成长     = 个人能力成长：技能课题、能力雷达、复盘
     数据     = 经营复盘：目标、漏斗、指标口径、系统对接
   ============================================================ */
import {
  init, get, subscribe, resetDemo, clearAll, exportJSON, importJSON,
  setRuleConfig, setRuleParam, saveSettings, addBlock, updateBlock,
  toggleBlock, removeBlock, resetDayPlan, bumpWorkload, todayWorkload,
  deleteCampaign, deleteLead, todayQueue, leadFunnel,
  deleteBizRecord, markBriefRead, setMemberNote,
} from './store.js';
import { initKeys } from './models.js';
import { maybeFirstRunPrivacy } from './consent.js';
import { computeMetrics } from './metrics.js';
import { toast, confirmDialog, openSheet, badge, notice, sectionTitle, emptyState, statCard } from './components.js';
import { esc, today, weekday, downloadFile, daysBetween } from './util.js';
import * as agentView from './views/agent.js';
import * as membersView from './views/members.js';
import * as opsView from './views/ops.js';
import * as learningView from './views/learning.js';
import * as analyticsView from './views/analytics.js';
import {
  openMemberSheet, openMemberForm, openApptForm, openRenewalForm, openFollowupForm,
  openCardForm, openCardActions,   openBlockForm, openAiSheet, openAiHub, openModelMarket, openAiPortal,
  openGroupPlanForm, openCampaignForm, openLeadForm, openTopicEvidence,
  openDouyinBindSheet, openStoreHeatForm, openTopBoardSheet,
  openXhsBindSheet, openXhsNoteForm,
  openFeaturesSheet, openBriefSheet, openBizReportSheet, openBizDetailSheet,
} from './sheets.js';
import { openConnectorSheet, openImportSheet, openSettingsSheet } from './connectorConsole.js';
import { openContactSheet } from './outreach.js';
import { syncDouyinAccount, syncDouyinBoard } from './douyinSync.js';
import { defaultRankDate } from './douyin.js';
import { buildBrief, unreadOf, readIdsOf } from './opsBrief.js';
import { advisorGradeOf, gradeRoster, gradeStats, dailyTaskList, staleText, membersOfAdvisor } from './salesGrade.js';
import { GRADE_ORDER, GRADE_COLOR, GRADE_BADGE, GRADE_BY_ID } from './data/salesGrade.js';

/* ---------------- 五个功能分类 ---------------- */
const NAV = [
  { id: 'agent', label: '智能体', long: '智能体运行台', icon: 'i-spark', view: agentView },
  { id: 'members', label: '客户', long: '客户与会籍', icon: 'i-users', view: membersView },
  { id: 'ops', label: '运营', long: '运营中心', icon: 'i-ops', view: opsView },
  { id: 'learning', label: '成长', long: '技能成长', icon: 'i-learn', view: learningView },
  { id: 'analytics', label: '数据', long: '经营数据', icon: 'i-data', view: analyticsView },
];
const navById = (id) => NAV.find((n) => n.id === id) || NAV[0];

/* ---------------- 上下文：视图与抽屉的唯一入口 ---------------- */
const ctx = {
  state: null,
  metrics: null,

  /* 各视图的轻量 UI 状态，不落库 */
  _tab: 'agent',
  _memberSeg: 'overview',
  _memberTab: 'profile',
  _cardFilter: 'attention',
  /* 社群管理现在是可选配功能，默认收起，所以首屏落在「线上营销」上 */
  _opsSeg: 'content',
  _contentSub: 'douyin',
  _stageTab: 's1',
  _q: '',
  _stage: 'all',
  _openTopic: null,
  _aiTopic: null,

  /* ---- 基础信息 ---- */
  greeting() {
    const h = new Date().getHours();
    if (h < 6) return '这个点还在忙，先把手上这件收个尾';
    if (h < 11) return '早上好，先看清今天该动谁';
    if (h < 14) return '中午好，午后半小时是回访黄金档';
    if (h < 18) return '下午好，趁热把该推的往前推一步';
    return '晚上好，把今天的跟进补齐再收工';
  },
  weekday() { return weekday(today()); },
  funnel() {
    return leadFunnel().map((x) => ({ label: x.label, value: x.value, noConv: x.noConv }));
  },

  /* ---- 渲染 ---- */
  refresh(opts) { return refresh(opts); },
  go(id) { return go(id); },
  /**
   * 跳到成长页并展开某个课题。
   * 顺序不能反：applyTab 会在切页时把 _openTopic 清掉，
   * 所以先切页，再写 _openTopic，最后重渲染。
   */
  goTopic(topicId) {
    applyTab('learning', true);
    ctx._openTopic = topicId;
    refresh({ top: true });
  },
  /** 视图改了子分段之后调它，把地址栏同步过来（失败不影响渲染） */
  syncHash() {
    try {
      if (location.hash.replace(/^#\/?/, '') !== hashPath()) location.hash = hashPath();
    } catch { /* 忽略 */ }
  },
  toast,
  _applyMeta() {
    /* 视图切换后把页面标题与顶栏对齐 */
    const n = navById(ctx._tab);
    document.title = `${n.long} · FitFlow`;
  },

  /* ---- 智能体：规则配置 ---- */
  setRule(id, patch) { setRuleConfig(id, patch); },
  setRuleParam(id, key, value) { setRuleParam(id, key, value); },

  /* ---- 时间块 ---- */
  addBlock(b) { addBlock({ ...b, done: false }); },
  updateBlock(id, patch) { updateBlock(id, patch); },

  /* ---- 个人设置 / 数据管理 ---- */
  saveSettings(patch) { saveSettings(patch); },

  exportData() {
    const stamp = today();
    downloadFile(`FitFlow 数据备份-${stamp}.json`, exportJSON(), 'application/json');
    toast('已导出全部数据');
  },
  openImport() {
    openImportSheet(ctx, null, () => {
      ctx.metrics = computeMetrics(ctx.state);
      refresh();
    });
  },
  openSettings() { openSettingsSheet(ctx); },

  clearDemo() {
    confirmDialog({
      title: '清空示例数据',
      message: '会清掉所有示例会员、跟进、预约、卡与内容，换成一张空台账给你录入真实数据。这个动作不可撤销。',
      confirmText: '清空',
      danger: true,
      onConfirm() {
        clearAll();
        toast('已清空，可以开始录你自己的会员了');
      },
    });
  },

  /* ---- 会员与会籍 ---- */
  /**
   * 会员档案抽屉。
   * 从哪一屏点进来，左上角返回就回哪一屏：
   * 智能体首页的指挥卡片进来回智能体，客户列表进来回客户。
   * 不传 from 就按当前所在分类算 —— 五个分类都能对上，
   * 而且不会出现在客户页点开、返回却跑去别处的情况。
   */
  openMember(id, opts) {
    /* 工作量：点开一张客户卡看详情 = 一次观察量 */
    bumpWorkload('obs');
    openMemberSheet(id, ctx, { from: (opts && opts.from) || ctx._tab || 'members' });
  },
  openMemberForm(id, onSaved) { openMemberForm(id, ctx, onSaved); },
  openFollowupForm(memberId, onSaved) { openFollowupForm(memberId, ctx, onSaved); },
  openApptForm(id, opts) { openApptForm(id, ctx, opts || {}); },
  openRenewalForm(memberId, onSaved) { openRenewalForm(memberId, ctx, onSaved); },

  /**
   * 客户触达台。
   * 队列里的「去处理」、指挥中心的「去处理」都落在这里：
   * 一屏之内把"说什么"和"怎么发出去"做完，不用先跳档案再找电话。
   */
  openContact(memberId, opts) { openContactSheet(ctx, memberId, opts || {}); },

  /** 备注就地保存。silent 用于边打字边存，避免重渲染把光标弹走。 */
  setMemberNote(id, note, opts) { setMemberNote(id, note, opts || {}); },

  /* ---- 会籍卡 ---- */
  openCardForm(cardId, preset, onSaved) { openCardForm(cardId, preset || {}, ctx, onSaved); },
  openCardActions(cardId, onSaved) {
    openCardActions(cardId, ctx, onSaved || (() => { ctx.metrics = computeMetrics(ctx.state); refresh(); }));
  },

  /* ---- 运营 ---- */
  openGroupPlanForm(groupId, index) { openGroupPlanForm(groupId, ctx, index); },
  openCampaignForm(id) { openCampaignForm(id, ctx); },
  openLeadForm(id) { openLeadForm(id, ctx); },
  deleteCampaign(id) { deleteCampaign(id); },
  deleteLead(id) { deleteLead(id); },

  /* ---- 运营 · 抖音账号监控 ---- */
  openDouyinBind() { openDouyinBindSheet(ctx); },
  openStoreHeat(kind) { openStoreHeatForm(ctx, kind); },
  openXhsBind() { openXhsBindSheet(ctx); },
  openXhsNote(id) { openXhsNoteForm(ctx, id); },
  openTopBoard() { openTopBoardSheet(ctx); },

  /* ---- 运营 · 可选配功能库 ---- */
  openFeatures() { openFeaturesSheet(ctx); },

  /* ---- 运营 · 未读提醒 ---- */
  openBrief() { openBriefSheet(ctx); },

  /**
   * 一键把今天的未读全部标掉。
   * id 从当前简报现算，而不是缓存一份，避免"提醒内容变了但清单还是旧的"。
   * 已读完就不弹提示，免得点一下什么都没发生却还报一句成功。
   */
  readAllBrief() {
    const brief = buildBrief(ctx.state);
    const ids = unreadOf(brief, readIdsOf(ctx.state)).map((x) => x.id);
    if (!ids.length) { toast('今天已经全部读过了'); return; }
    markBriefRead(ids);
    toast(`已把 ${ids.length} 条标为已读`);
  },

  /* ---- 运营 · 交易后台 ---- */
  openBizReport(sourceId) { openBizReportSheet(ctx, sourceId); },
  openBizDetail(sourceId) { openBizDetailSheet(ctx, sourceId); },
  deleteBizRecord(id) {
    confirmDialog({
      title: '删除这天的经营记录',
      message: '只会删掉这一天的一条记录，其他日期不受影响。这个动作不可撤销。',
      confirmText: '删除',
      danger: true,
      onConfirm() { deleteBizRecord(id); toast('已删除'); },
    });
  },

  /**
   * 同步抖音账号。
   * 编排放在 douyinSync.js，这里只负责"把结果翻译成一句人话"。
   */
  async syncDouyin() {
    const b = ctx.state.douyin?.binding;
    if (!b) { toast('先在运营 → 线上营销里绑定抖音账号', 'warn'); return; }

    const d = ctx.state.douyin;
    toast('正在同步，先探本地代理与密钥');

    const res = await syncDouyinAccount({
      uniqueName: b.uniqueName,
      proxyUrl: d.proxyUrl,
      endpointsVerified: d.endpointsVerified,
      monitor: d.monitor,
    });

    if (res.ok) {
      const n = res.works.length;
      toast(n ? `同步完成，取到 ${n} 条作品` : '同步完成，但作品列表是空的');
    } else if (res.error?.code === 'insufficient_credits') {
      /* 平台自己的 msg 已经说清了本次扣多少、剩多少，直接透传不要重写 */
      toast(res.error.message, 'warn');
    } else if (res.step === 'proxy') {
      toast('连不上本地代理，先运行 node server/proxy.mjs', 'warn');
    } else if (res.step === 'key') {
      toast('代理已启动，但 REDFOX_API_KEY 没配', 'warn');
    } else {
      toast(res.error?.message || '同步失败，已记到同步记录里', 'warn');
    }
    ctx.refresh();
  },

  /**
   * 取官方赛道榜。
   * 这里没有"绑定账号"的前置条件：榜单是赛道维度的，跟绑没绑抖音号无关，
   * 但那三个边界要在界面上先说清，别让人以为拿到了本地经营排名。
   *
   * rankDate 是一次性参数而不是持久偏好：存下来的话，隔天再点会把旧日期
   * 当成默认值，用户会以为"榜单没更新"。没显式传就按榜期重新推算。
   */
  async syncDouyinBoard(override = {}) {
    const d = ctx.state.douyin || {};
    const q = d.boardQuery || {};
    const dateType = override.dateType || q.dateType || 'days';
    const category = override.category || q.category || '身体锻炼';
    const rankDate = override.rankDate || defaultRankDate(dateType);

    toast('正在取官方赛道榜');

    const res = await syncDouyinBoard({
      dateType, rankDate, category,
      proxyUrl: d.proxyUrl,
      endpointsVerified: d.endpointsVerified,
    });

    if (res.ok) {
      toast(`取到 ${res.items.length} 条，「${category}」榜位已存`);
    } else if (res.empty) {
      toast(`「${category}」这一期是空榜，换个日期再试`, 'warn');
    } else if (res.error?.code === 'insufficient_credits') {
      toast(res.error.message, 'warn');
    } else {
      toast(res.error?.message || '赛道榜取数失败，已记到同步记录里', 'warn');
    }
    ctx.refresh();
  },
  openTopicEvidence(topicId) { openTopicEvidence(topicId, ctx); },

  /* ---- 智能体 / AI 工作流 ---- */
  openBlockForm(blockId) { openBlockForm(ctx, blockId); },
  openAi(packId, memberId, topicId, opts) {
    ctx._aiTopic = topicId || null;
    openAiSheet(packId, memberId, ctx, null, null, opts);
  },
  openAiHub(preTopic) {
    ctx._aiTopic = preTopic || null;
    openAiHub(ctx, preTopic || null);
  },
  openModelMarket() { openModelMarket(ctx); },
  openAiPortal() { openAiPortal(ctx); },

  /* ---- 业务系统对接 ---- */
  openConnector(id) {
    openConnectorSheet(id, ctx);
  },
};

/* ---------------- 主体色彩 ---------------- */

/**
 * 只有两套：品牌绿（默认）与黑白基础版。
 * 切换方式是给 :root 换一个 data-theme，由 CSS 把那几个颜色变量整体换掉，
 * 组件样式一行都不用改 —— 否则每加一个组件都得写两遍颜色，迟早会漏。
 */
const THEMES = ['brand', 'mono'];

function applyTheme(name) {
  document.documentElement.dataset.theme = THEMES.includes(name) ? name : 'brand';
}

/* ---------------- 视图挂载与切换 ---------------- */
let viewEl = null;
let headerEl = null;
let tabbarEl = null;

const current = () => navById(ctx._tab).view;
const currentEl = () => document.getElementById('view');

function renderView(keep = {}) {
  const view = current();
  const html = view.render(ctx);
  const old = viewEl || currentEl();

  /* 用浅克隆替换节点：属性保留、子节点与事件监听全部重置，
     这样每次重渲染都不会叠加重复的事件委托。 */
  const fresh = document.createElement('main');
  fresh.id = 'view';
  fresh.className = 'app-main';
  fresh.innerHTML = html;

  old.replaceWith(fresh);
  viewEl = fresh;

  /* 视图节点每次都是新的，滚动监听得重新挂一次 */
  bindHeaderScroll(fresh);

  view.mount && view.mount(fresh, ctx);

  /* 必须在布局稳定后再复位滚动位置：#view 是 replaceWith 重建的节点，
     同步写 scrollTop 时新内容可能还没量出真实高度，会被浏览器钳到 0
     （表现为勾选任务后页面跳回顶部）。用 rAF 延到下一帧布局完成后再设，
     同时给 keepFocus 的输入框也放到同一帧，避免两者打架。 */
  if (keep.scroll != null) requestAnimationFrame(() => { fresh.scrollTop = keep.scroll; });
  else fresh.scrollTop = 0;

  if (keep.focus) {
    const el = fresh.querySelector(`#${keep.focus}`);
    if (el) {
      el.focus();
      const v = el.value;
      if (el.setSelectionRange) el.setSelectionRange(v.length, v.length);
    }
  }
}

/**
 * 顶栏。
 * 默认只留右上角那颗星星气泡，门店、顾问、运行、设置全收进 hd-panel，
 * 点气泡才滑下来盖住字标 —— 首页第一眼只剩品牌。
 * 下滑之后顶栏补底色，正中间浮出一个平铺的 F 当回落标识。
 */
function renderHeader() {
  const n = navById(ctx._tab);
  const s = ctx.state;
  const on = Boolean(ctx._panelOpen);
  headerEl.classList.toggle('panel-on', on);
  headerEl.innerHTML = `
    <div class="hd-mark-flat" aria-hidden="true">F</div>
    <button class="bubble${on ? ' on' : ''}" data-hdr="brand"
      aria-label="${on ? '收起顶栏' : '展开顶栏'}" aria-expanded="${on}">
      <svg viewBox="0 0 24 24"><use href="#i-spark"/></svg>
    </button>
    <div class="hd-panel${on ? ' on' : ''}">
      <div class="hd-row">
        <div class="logo-mark">F</div>
        <div class="hd-main">
          <div class="hd-title"><span class="wordmark" style="font-size:19px">FitFlow</span></div>
          <div class="hd-sub">
            <span style="color:var(--brand-2);font-weight:650">${esc(n.long)}</span>
            <span>·</span>
            <span>${esc(s.settings.store)}</span>
          </div>
        </div>
        <div class="hd-actions">
          <button class="icon-btn" data-hdr="ai-hub" aria-label="AI 任务包" title="AI 任务包">
            <svg viewBox="0 0 24 24"><use href="#i-spark"/></svg>
          </button>
          <button class="icon-btn accent" data-hdr="run" aria-label="立即运行智能体" title="立即运行智能体">
            <svg viewBox="0 0 24 24"><use href="#i-sync"/></svg>
          </button>
          <button class="icon-btn" data-hdr="ai-portal" aria-label="AI 接口总开关" title="AI 接口总开关">
            <svg viewBox="0 0 24 24"><use href="#i-plug"/></svg>
          </button>
          <button class="icon-btn" data-hdr="settings" aria-label="个人设置" title="个人设置">
            <svg viewBox="0 0 24 24"><use href="#i-settings"/></svg>
          </button>
        </div>
      </div>
      ${accountPreview(s)}
      ${agentView.workflowSection(s)}
    </div>`;
}

/**
 * 星星下拉里的账号大预览。
 * 三块：个人信息 → 销售等级大卡 → 客户等级分布与关键指标。
 *
 * 全部数据来自本地使用日志的确定性计算，没有一项是推测值：
 * 拿不到分母时显示「未获取」，不用 0 冒充。
 */
export function accountPreview(s) {
  const a = advisorGradeOf(s);
  /* 顶栏是「这名顾问的账号」，分布必须限定在他名下的客户里。
     早先这里拿全店的 gradeStats 去除以 a.metrics.size（顾问名下人数），
     示例数据里全员归属同一人所以碰巧相等，一旦有第二个顾问比例就算错。 */
  const mine = membersOfAdvisor(s, a.advisor);
  const roster = gradeRoster(s, mine);
  const st = gradeStats(s, mine);
  const onboardDays = a.onboardAt ? daysBetween(a.onboardAt, today()) : null;
  const initial = String(a.advisor || '?').slice(0, 1);
  /* 待激活 = 需要唤醒的那两档：C 低频待激活 + D 休眠观察 */
  const dormant = st.C.count + st.D.count;

  const bars = GRADE_ORDER.map((id) => {
    const g = st[id];
    const pct = a.metrics.size ? Math.round((g.count / a.metrics.size) * 100) : 0;
    const on = id === a.grade.id;
    return `<div class="hdg-col${on ? ' on' : ''}">
      <div class="hdg-n">${g.count}</div>
      <div class="hdg-b"><i style="height:${Math.max(g.count ? 8 : 0, pct)}%;background:${GRADE_COLOR[id]}"></i></div>
      <div class="hdg-l">${id}</div>
    </div>`;
  }).join('');

  return `
    <div class="hd-acc">
      <div class="acc-av">${esc(initial)}</div>
      <div class="acc-info">
        <div class="acc-name">${esc(a.advisor)}<span class="acc-role">${esc(a.role)}</span></div>
        <div class="acc-sub">${esc(a.store)}${onboardDays != null ? ` · 入职 ${onboardDays} 天` : ''}</div>
      </div>
    </div>

    <div class="hd-grade" data-hdr="grade-detail" role="button" tabindex="0"
      aria-label="销售等级 ${esc(a.grade.label)}，综合分 ${a.score}">
      <div class="hg-badge" style="background:${GRADE_COLOR[a.grade.id]}">${esc(a.grade.id)}</div>
      <div class="hg-main">
        <div class="hg-top">
          <span>${esc(a.grade.label)} · ${esc(a.grade.name)}</span>
          <span class="hg-score">${a.score} 分</span>
        </div>
        <div class="hg-bar"><i style="width:${Math.min(100, a.score)}%"></i></div>
        <div class="hg-sub">${a.gap == null
          ? '已到最高档 A 级'
          : `距 ${esc(a.nextGrade)} 级还差 ${a.gap} 分（${esc(a.nextGrade)} 级线 ${a.nextAt} 分）`}</div>
      </div>
      <svg class="hg-chev" viewBox="0 0 24 24"><use href="#i-chev"/></svg>
    </div>

    <div class="hd-dist">
      <div class="hdd-bars">${bars}</div>
      <div class="hdd-kpi">
        <div class="kpi"><span class="kpi-v">${a.metrics.dealRate == null ? '未获取' : a.metrics.dealRate + '%'}</span><span class="kpi-k">成交率</span></div>
        <div class="kpi"><span class="kpi-v">${a.metrics.renewRate == null ? '未获取' : a.metrics.renewRate + '%'}</span><span class="kpi-k">续费率</span></div>
        <div class="kpi"><span class="kpi-v">${a.metrics.size}</span><span class="kpi-k">在册客户</span></div>
        <div class="kpi"><span class="kpi-v">${dormant}</span><span class="kpi-k">待激活 C+D</span></div>
      </div>
    </div>`;
}

/** 展开 / 收起顶栏面板。只改 class，不整体重渲染，滑动才连贯。 */
function setPanel(on) {
  ctx._panelOpen = Boolean(on);
  headerEl.classList.toggle('panel-on', ctx._panelOpen);
  const p = headerEl.querySelector('.hd-panel');
  if (p) p.classList.toggle('on', ctx._panelOpen);
  const b = headerEl.querySelector('.bubble');
  if (b) {
    b.classList.toggle('on', ctx._panelOpen);
    b.setAttribute('aria-expanded', String(ctx._panelOpen));
    b.setAttribute('aria-label', ctx._panelOpen ? '收起顶栏' : '展开顶栏');
  }
}

/**
 * 下滑置顶：滚过字标一半之后，顶栏补上底色并让 F 居中平铺。
 * 用 rAF 节流，滚动时不要每帧都读写滚动位置。
 */
const SCROLL_TOP_AT = 88;
function bindHeaderScroll(el) {
  let raf = 0;
  const apply = () => {
    raf = 0;
    headerEl.classList.toggle('solid', el.scrollTop > SCROLL_TOP_AT);
  };
  el.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(apply); }, { passive: true });
  apply();
}

function renderTabbar() {
  const queue = todayQueue().length;
  /* 运营那一格挂未读提醒：不点进去也能看到还有几条没读 */
  const brief = buildBrief(ctx.state);
  const unread = unreadOf(brief, readIdsOf(ctx.state)).length;

  /* 左栏品牌只在桌面断点显示（手机端 .tabbar 是 5 等分网格，
     多一个子元素就会挤掉一格，所以 .nav-brand 默认 display:none）。
     元素始终渲染，避免断点切换时还要重建导航。 */
  tabbarEl.innerHTML = `
    <div class="nav-brand" aria-hidden="true">
      <span class="nav-brand-mark">F</span>
      <span class="nav-brand-name wordmark">FitFlow</span>
    </div>` + NAV.map((n) => {
    const count = n.id === 'agent' ? queue : n.id === 'ops' ? unread : 0;
    /* 徽章一律用同一颗 .badge 胶囊。
       这一格原先在 ops 上多挂了一个 .dot，而 .dot 是 6×6、给纯色小圆点用的，
       盒子里还塞着数字，数字会溢出到圆点外面 —— 两条规则一起算出个不是设计出来的形状。
       数字本来就是要显示的（"还有几条没读"），所以去掉 .dot，和智能体那格保持一致。 */
    return `
    <button class="tab ${ctx._tab === n.id ? 'on' : ''}" data-tab="${n.id}" aria-label="${esc(n.long)}">
      <svg viewBox="0 0 24 24"><use href="#${n.icon}"/></svg>
      <span>${esc(n.label)}</span>
      ${count ? `<span class="badge">${count > 99 ? '99+' : count}</span>` : ''}
    </button>`;
  }).join('');
}

function renderShell() {
  renderHeader();
  renderTabbar();
  ctx._applyMeta();
  applyTheme(ctx.state.settings?.theme);
}

function refresh(opts = {}) {
  const el = viewEl || currentEl();
  const keep = {};
  /* 默认保留滚动位置（页内筛选、切换分段时不跳），只有切分类才回到顶部 */
  if (opts.top) keep.scroll = null;
  else keep.scroll = opts.keepScroll === false ? null : el.scrollTop;
  if (opts.keepFocus) keep.focus = opts.keepFocus;

  ctx.state = get();
  ctx.metrics = computeMetrics(ctx.state);

  renderView(keep);
  renderShell();
}

/**
 * 解析地址栏。
 * 支持两级： #ops  只切分类
 *            #ops/content/store  连子分段一起定位
 * 子分段能深链之后，预览、截图、把某一屏发给同事都省事。
 */
const OPS_SEGS = ['community', 'content', 'leads'];
const CONTENT_SUBS = ['douyin', 'biz', 'store', 'ledger'];

function routeFromHash() {
  const parts = (location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  const tab = NAV.some((n) => n.id === parts[0]) ? parts[0] : null;
  const seg = OPS_SEGS.includes(parts[1]) ? parts[1] : null;
  const sub = CONTENT_SUBS.includes(parts[2]) ? parts[2] : null;
  return { tab, seg, sub };
}

/** 当前状态对应的地址栏路径 */
function hashPath() {
  return [
    ctx._tab,
    ctx._tab === 'ops' ? ctx._opsSeg : null,
    ctx._tab === 'ops' && ctx._opsSeg === 'content' ? ctx._contentSub : null,
  ].filter(Boolean).join('/');
}

function applyTab(id, push, seg, sub) {
  if (seg) ctx._opsSeg = seg;
  if (sub) ctx._contentSub = sub;

  if (ctx._tab === id) { refresh({ top: true }); return; }
  ctx._tab = id;
  ctx._openTopic = null;
  ctx._aiTopic = null;
  /* 写进地址栏：既能直接分享某一屏，也能用浏览器后退键回上一个分类 */
  if (push) {
    try { location.hash = hashPath(); } catch { /* 某些嵌入环境受限，忽略即可 */ }
  }
  refresh({ top: true });
}

function go(id) { applyTab(id, true); }

/* ---------------- 全局兜底：只认顶栏与底栏自己的标记 ---------------- */
function bindShell() {
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { go(tab.dataset.tab); return; }

    /* 今日工作流落在星星面板底部，面板不在任何视图 root 内，
       所以它的交互由外壳统一接管（放在 data-hdr 判定之前，免得被面板开合逻辑吃掉）。
       这里一律 return，不走到下面的 setPanel(false)，操作时面板保持展开。 */
    const blk = e.target.closest('[data-block]');
    if (blk) { toggleBlock(blk.dataset.block); ctx.refresh({ keepScroll: true }); return; }

    const blkDel = e.target.closest('[data-block-del]');
    if (blkDel) { removeBlock(blkDel.dataset.blockDel); ctx.refresh({ keepScroll: true }); return; }

    const blkEdit = e.target.closest('[data-block-edit]');
    if (blkEdit) { ctx.openBlockForm(blkEdit.dataset.blockEdit); return; }

    const wfAct = e.target.closest('[data-act="add-block"],[data-act="reset-plan"],[data-act="ai-weekly"]');
    if (wfAct) {
      const a = wfAct.dataset.act;
      if (a === 'add-block') return ctx.openBlockForm();
      if (a === 'reset-plan') {
        return confirmDialog({
          title: '套用每日模板',
          message: '会用标准时间块模板替换今天现有的安排。确认吗？',
          confirmText: '套用',
          onConfirm() { resetDayPlan(); toast('已套用每日模板'); ctx.refresh(); },
        });
      }
      if (a === 'ai-weekly') return ctx.openAi('weekly', null);
    }

    const hdr = e.target.closest('[data-hdr]');
    if (!hdr) return;
    const a = hdr.dataset.hdr;
    /* 气泡只负责开合这一层，别的事不做 */
    if (a === 'brand') { setPanel(!ctx._panelOpen); return; }
    /* 用了面板里的任何一个功能，就把它收回去，别挡着后面 */
    setPanel(false);
    if (a === 'ai-hub') return ctx.openAiHub();
    if (a === 'ai-portal') return ctx.openAiPortal();
    if (a === 'settings') return ctx.openSettings();
    if (a === 'grade-detail') return openGradeSheet();
    if (a === 'run') {
      /* 顶栏的运行按钮与智能体页内的"立即运行"走同一套引擎 */
      const view = current();
      if (ctx._tab !== 'agent') { go('agent'); setTimeout(() => runFromHeader(), 120); return; }
      runFromHeader();
    }
  });
}

/**
 * 销售等级明细。从顶栏那张三卡点进来。
 *
 * 三屏内容，顺序按"先看自己 → 再看盘子 → 最后看标准"排：
 *   ① 我的评分明细：五维各拿了多少分，缺哪一项
 *   ② 客户等级分布：每档多少人、续费率 / 成交率是多少
 *   ③ 各档标准：跟进周期、每日任务、技能要求
 *
 * 拿不到分母的指标一律显示「未获取」。
 * 这里不会出现 0% —— 0% 和"没数据"是两回事，混起来会让人以为做得极差。
 */
function openGradeSheet() {
  const s = get();
  const a = advisorGradeOf(s);
  const mine = membersOfAdvisor(s, a.advisor);
  const stats = gradeStats(s, mine);
  const tasks = dailyTaskList(s, today(), mine);

  const rows = a.detail.map((d) => `
    <div class="gr-dim${d.missing ? ' miss' : ''}">
      <div class="grd-h">
        <span class="grd-k">${esc(d.label)}</span>
        <span class="grd-v">${d.missing ? '未获取' : esc(d.show)}</span>
      </div>
      <div class="grd-bar"><i style="width:${Math.round((d.pts / d.weight) * 100)}%"></i></div>
      <div class="grd-f">${d.missing ? '无数据，该维度不计入评分' : `${d.pts} / ${d.weight} 分`}</div>
    </div>`).join('');

  const dist = GRADE_ORDER.map((id) => {
    const g = stats[id];
    return `
      <div class="gr-row">
        <span class="badge ${GRADE_BADGE[id]}">${id}</span>
        <div class="grr-main">
          <div class="grr-t">${esc(g.grade.name)}</div>
          <div class="grr-s">${g.count} 人 · 跟进周期 ${esc(g.grade.cycleNote)} · ${esc(g.grade.touchpoints)}</div>
        </div>
        <div class="grr-k">
          <div>成交率 <b>${g.dealRate == null ? '未获取' : g.dealRate + '%'}</b></div>
          <div>续费率 <b>${g.renewRate == null ? '未获取' : g.renewRate + '%'}</b></div>
        </div>
      </div>`;
  }).join('');

  const std = GRADE_ORDER.map((id) => {
    const g = GRADE_BY_ID[id];
    return `
      <div class="gr-std">
        <div class="grs-h">
          <span class="badge ${GRADE_BADGE[id]}">${esc(g.label)}</span>
          <span class="grs-n">${esc(g.name)}</span>
          <span class="grs-c">${esc(g.cycleNote)}一触</span>
        </div>
        <div class="grs-d">${esc(g.summary)}</div>
        <div class="grs-sec">每日任务</div>
        <ul class="grs-ul">${g.dailyTasks.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        <div class="grs-sec">技能要求</div>
        <ul class="grs-ul">${g.skillReq.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>`;
  }).join('');

  const due = tasks.flatMap((t) => t.due.map((x) => ({ ...x, g: t.grade })));

  openSheet({
    title: '销售等级',
    subtitle: `${esc(a.advisor)} · ${esc(a.grade.label)} ${esc(a.grade.name)} · 综合分 ${a.score}`,
    size: 'tall',
    body: `
      ${notice('等级依据全部来自<strong>本机使用日志</strong>的确定性计算：累计消费、续费次数、到店频次、跟进密度、卡种。没有接入任何外部数据源，也没有用行业平均值替代 —— 取不到真值的指标直接显示「未获取」。', 'info', 'i-shield')}

      <div class="stat-grid g4" style="margin:12px 0">
        ${statCard({ k: '综合分', v: a.score, unit: '分' })}
        ${statCard({ k: '当前等级', v: esc(a.grade.id), d: esc(a.grade.name) })}
        ${statCard({ k: '在册客户', v: a.metrics.size, unit: '人' })}
        ${statCard({ k: '管理业绩', v: '¥' + a.metrics.paidSum.toLocaleString('zh-CN') })}
      </div>

      ${sectionTitle('① 我的评分明细', '满分 100')}
      ${rows}
      <div class="hint" style="margin-top:8px">权重：成交率 30 · 续费率 28 · 管理业绩 22 · 在册客户 12 · 跟进密度 8。缺项的维度不参与评分，分母同步缩小，不会因为数据不全就被算成低分。</div>

      ${sectionTitle('② 客户等级分布')}
      ${dist}
      <div class="hint" style="margin-top:8px">成交率 = 已成交 ÷ 该档人数；续费率 = 有续费卡的 ÷ 已成交人数。某档没人时分母为 0，显示「未获取」而不是 0%。</div>

      ${due.length ? `${sectionTitle('久未跟进', `${due.length} 人`)}
      <div class="list dense">${due.slice(0, 8).map((x) => `
        <div class="list-item">
          <span class="badge ${GRADE_BADGE[x.g.id]}">${esc(x.g.id)}</span>
          <div class="li-body">
            <div class="li-top"><span class="li-name">${esc(x.m.name)}</span></div>
            <div class="li-meta"><span>${esc(staleText(x.stale))}</span></div>
          </div>
        </div>`).join('')}</div>` : ''}

      ${sectionTitle('③ 各档标准')}
      ${std}`,
    footer: `<button class="btn primary" data-sheet-close>知道了</button>`,
  });
}

/* 顶栏运行：复用智能体视图的同一套逻辑，避免两处实现漂移 */
function runFromHeader() {
  const el = document.getElementById('view');
  const btn = el && el.querySelector('[data-act="run"]');
  if (btn) { btn.click(); return; }
  toast('运行入口在智能体页', 'warn');
}

/* ---------------- 键盘：数字键切分类，F 在抽屉里用 ---------------- */
function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName) || t.isContentEditable)) return;
    if (document.querySelector('.sheet-mask')) return;
    const i = Number(e.key);
    if (i >= 1 && i <= NAV.length) go(NAV[i - 1].id);
  });
}

/* ---------------- 全局兜底：任何初始化/渲染失败都显示可见错误，绝不静默白屏 ---------------- */
function showFatal(err) {
  const msg = (err && (err.stack || err.message)) || String(err);
  const view = document.getElementById('view');
  if (view) {
    view.innerHTML = `<div class="card" style="margin:18px;border-color:var(--danger,#c0392b)">
      <h2 style="margin:0 0 6px;font-size:16px">页面未能正常启动</h2>
      <p class="muted" style="line-height:1.75;font-size:13px">应用初始化时抛出了异常，已停止渲染以避免白屏。最常见的原因：预览环境以<b>非安全上下文</b>（非 https、非 localhost）打开页面，导致浏览器 Web Crypto（AES-GCM 加密）不可用，解密本地数据这一步直接失败。</p>
      <pre style="white-space:pre-wrap;word-break:break-all;background:var(--surface-2,#f4f6f5);padding:10px;border-radius:10px;font-size:11.5px;max-height:200px;overflow:auto;margin:10px 0 0">${esc(msg)}</pre>
      <p class="muted" style="font-size:12px;margin:10px 0 0">建议在 <b>https</b> 或 <b>localhost</b> 下打开本页。本地预览请用 <code>python -m http.server 8779</code> 启动后访问 <code>http://127.0.0.1:8779/try.html</code>。</p>
    </div>`;
  }
  console.error('[FitFlow] 启动失败：', err);
}
/* 仅当主区还是空（说明 boot 在渲染前就挂了）才兜底，避免误伤运行期普通报错 */
function maybeFatal(err) {
  const view = document.getElementById('view');
  if (view && !view.children.length) showFatal(err);
}
window.addEventListener('error', (e) => maybeFatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => maybeFatal(e.reason));

/* ---------------- 启动 ---------------- */
async function boot() {
  await init();          // 解密并载入本地（已加密）数据
  await initKeys();      // 解密密钥库（密钥同样加密存储）
  ctx.state = get();
  ctx.metrics = computeMetrics(ctx.state);

  /* 支持用地址栏直接打开某一屏（#members、#ops/content/store ...），默认落在智能体台 */
  const r0 = routeFromHash();
  ctx._tab = r0.tab || 'agent';
  if (r0.seg) ctx._opsSeg = r0.seg;
  if (r0.sub) ctx._contentSub = r0.sub;

  viewEl = currentEl();
  viewEl.innerHTML = '';
  viewEl.className = 'app-main';
  headerEl = document.getElementById('appHeader');
  tabbarEl = document.getElementById('tabbar');

  bindShell();
  bindKeys();

  /* 地址栏变化（后退键、手动改 hash）同步到分类与子分段 */
  window.addEventListener('hashchange', () => {
    const r = routeFromHash();
    if (r.seg) ctx._opsSeg = r.seg;
    if (r.sub) ctx._contentSub = r.sub;
    if (r.tab && r.tab !== ctx._tab) applyTab(r.tab, false);
    else refresh();
  });

  /* 数据一变就整体重算：视图自己不负责同步，只负责画。
     放在这里而不是各 view 里，是为了避免"某个写入忘了刷新界面"。 */
  subscribe(() => {
    ctx.state = get();
    ctx.metrics = computeMetrics(ctx.state);
    refresh();
  });

  refresh();

  /* 首次运行：弹出隐私与数据处理说明，取得整体同意（PIPL 第 17 条） */
  maybeFirstRunPrivacy();

  /* 首屏骨架：不是转圈，是一句说明，避免白屏显得像坏了 */
  const n = todayQueue().length;
  if (n) setTimeout(() => toast(`智能体扫出 ${n} 条待办，已按优先级排好`), 420);
}

/* 试用入口引导卡：纯展示用途的关闭逻辑。
   放在模块里注册，是为了让 try.html 不含任何内联脚本，从而能用 script-src 'self'
   的严格 CSP（不放开 'unsafe-inline'）。若 app.js 加载失败，引导卡仍在，但不会
   盖住启动失败面板的关闭路径 —— 故此处独立注册、不依赖 boot() 是否成功。 */
const trialStartBtn = document.getElementById('trialStart');
if (trialStartBtn) {
  trialStartBtn.addEventListener('click', () => document.getElementById('trialIntro')?.remove());
}

/* Service Worker：只缓存应用自己的静态资源，让没网时也能打开。
   三个前置条件缺一个就不注册，静默跳过（不打扰正常使用）：
   ① 浏览器支持 serviceWorker（老 WebView / 某些内嵌环境没有）
   ② 跑在 http(s) 下（file:// 打开单文件时没有 SW，注册会直接抛错）
   ③ 不是 localhost 之外的 http 明文页（SW 只在安全上下文生效）
   注册失败不影响应用本身，所以不用 await，也不往上抛。 */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* 离线缓存不可用时忽略 */ });
}

boot().catch(showFatal);
