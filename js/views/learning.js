/* ============================================================
   views/learning.js · 学习任务
   4 个阶段 × 5 项课题，每项都绑定一个能读出来的业务指标
   ============================================================ */
import { STAGES, TOPICS, TRANSFERABLE, RADAR_DIMENSIONS, EVIDENCE_RULE, REVIEW_TEMPLATE } from '../data/learningFramework.js';
import { setTopicProgress, cycleTopicStatus, setRadar, setReviewDate, learningSummary, memberById } from '../store.js';
import { badge, sectionTitle, emptyState, notice, statCard, cardHead } from '../components.js';
import { esc, fmtDate, today, relDay, daysBetween, sum } from '../util.js';
import { radarChart } from '../charts.js';
import { computeMetrics } from '../metrics.js';

export function title() { return '学习'; }

const STATUS = {
  todo: { label: '未开始', cls: 'b-plain' },
  doing: { label: '进行中', cls: 'b-teal' },
  done: { label: '已完成', cls: 'b-green' },
};

export function render(ctx) {
  const M = ctx.metrics;
  const sum0 = learningSummary();
  const stageId = ctx._stageTab || 's1';
  const stage = STAGES.find((s) => s.id === stageId);
  const topics = TOPICS.filter((t) => t.stage === stageId);
  const openId = ctx._openTopic;

  return `
  <div class="page-head">
    <h2>技能学习</h2>
    <p>销售顾问 → 会员运营 → 项目负责人 → 经营者，每个阶段 5 项实践课题</p>
  </div>

  <div class="stat-grid g3" style="margin-bottom:14px">
    ${statCard({ k: '已完成', v: `${sum0.done}/${TOPICS.length}`, unit: '项' })}
    ${statCard({ k: '进行中', v: sum0.doing, unit: '项' })}
    ${statCard({ k: '累计学时', v: sum0.hours, unit: '小时' })}
  </div>

  ${notice(`${esc(EVIDENCE_RULE)}`, 'warn', 'i-alert')}

  <div class="stage-tabs" style="margin-top:14px">
    ${STAGES.map((s) => {
      const p = TOPICS.filter((t) => t.stage === s.id);
      const done = p.filter((t) => ctx.state.learning.progress[t.id]?.status === 'done').length;
      return `<button class="stage-tab ${stageId === s.id ? 'on' : ''}" data-stage-tab="${s.id}">
        <b>${esc(s.name)}</b>
        <span>${esc(s.window)}｜${done}/${p.length} 完成</span>
      </button>`;
    }).join('')}
  </div>

  <div class="card" style="border-color:${stage.color}33">
    <div style="font-size:13.5px;font-weight:700;color:${stage.color}">${esc(stage.name)} · ${esc(stage.en)}</div>
    <div class="small" style="margin-top:5px;line-height:1.65">焦点：${esc(stage.focus)}</div>
    <div class="small muted" style="margin-top:4px;line-height:1.65">出师标准：${esc(stage.outcome)}</div>
  </div>

  ${topics.map((t) => topicCard(t, ctx.state.learning.progress[t.id], M, openId === t.id)).join('')}

  ${sectionTitle('能力雷达', `上次复盘 ${ctx.state.learning.lastReviewAt ? relDay(ctx.state.learning.lastReviewAt) : '未复盘'}`)}
  <div class="card tight">
    ${radarChart({ axes: RADAR_DIMENSIONS.map((d) => ({ name: d.name, value: ctx.state.learning.radar[d.id] || 1 })) })}
    <div class="hint" style="text-align:center;margin-top:6px">点分数直接改，1 分 = 完全靠感觉，5 分 = 有方法有数据</div>
    <div class="divider"></div>
    ${RADAR_DIMENSIONS.map((d) => `
      <div class="between" style="padding:6px 0">
        <div class="small" style="min-width:74px">${esc(d.name)}</div>
        <div class="chips">
          ${[1, 2, 3, 4, 5].map((v) => `<button class="chip ${(ctx.state.learning.radar[d.id] || 0) === v ? 'on' : ''}" data-radar="${d.id}:${v}" style="min-width:30px;justify-content:center">${v}</button>`).join('')}
        </div>
      </div>`).join('')}
  </div>

  ${sectionTitle('这些能力的迁移出口', '不只在健身房有用')}
  <div class="card">
    ${TRANSFERABLE.map((x) => `
      <div style="padding:9px 0;border-bottom:1px solid var(--line-2)">
        <div style="font-size:12.5px;font-weight:680">${esc(x.from)}</div>
        <div class="tag-row" style="margin-top:5px">${x.to.map((t) => badge(t, 'b-plain')).join('')}</div>
        <div class="small muted" style="margin-top:5px;line-height:1.6">${esc(x.value)}</div>
      </div>`).join('')}
  </div>

  ${sectionTitle('月度复盘模板', '复制走，填完再回来看')}
  <div class="card">
    <div class="prompt-box">
      <pre id="reviewTpl">${esc(REVIEW_TEMPLATE)}</pre>
      <div class="pb-actions">
        <button data-copy-review><svg viewBox="0 0 24 24"><use href="#i-copy"/></svg>复制模板</button>
        <button data-mark-review><svg viewBox="0 0 24 24"><use href="#i-check"/></svg>标记本月已复盘</button>
      </div>
    </div>
  </div>`;
}

function topicCard(t, prog, M, open) {
  const st = STATUS[prog?.status || 'todo'];
  const metric = M[t.metricKey] || { text: '-', source: '缺', note: '' };
  return `<div class="topic ${prog?.status === 'done' ? 'done' : ''}">
    <div class="topic-hd">
      <button class="check ${prog?.status === 'done' ? 'on' : ''}" data-toggle-topic="${t.id}" aria-label="切换完成状态">
        <svg viewBox="0 0 24 24"><use href="#i-check"/></svg>
      </button>
      <div style="flex:1;min-width:0">
        <button class="between" data-open-topic="${t.id}" style="width:100%;text-align:left">
          <div style="min-width:0">
            <div class="topic-t">${esc(t.title)}</div>
            <div class="topic-o">${esc(t.objective)}</div>
          </div>
          <div style="flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:5px;margin-left:8px">
            ${badge(st.label, st.cls)}
            <span class="small muted">${t.hours} 学时</span>
          </div>
        </button>
        <div class="topic-metric" title="${esc(metric.note)}">
          <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2"><use href="#i-target"/></svg>
          ${esc(t.metric)}：<b>${esc(metric.text)}</b>
          <span style="opacity:.7;font-weight:500">${metric.source === '计算' ? '实时计算' : metric.source === '填报' ? '填报值' : '待补'}</span>
        </div>
      </div>
    </div>
    ${open ? `
      <div class="topic-detail">
        <b>关键动作</b>
        <ul style="margin:6px 0 0;padding-left:16px;list-style:disc">
          ${(t.actions || []).map((a) => `<li style="margin-bottom:4px">${esc(a)}</li>`).join('')}
        </ul>
        <div style="margin-top:9px"><b>可验证产出：</b>${esc(t.deliverable)}</div>
        <div style="margin-top:5px"><b>建议周期：</b>${esc(t.cycle)}</div>
        <div style="margin-top:5px"><b>指标口径：</b>${esc(metric.note)}</div>
        ${prog?.evidence ? `<div style="margin-top:9px;padding:9px;background:var(--surface-2);border-radius:10px">
          <div class="small" style="font-weight:650">已记录产出</div>
          <div class="small" style="margin-top:4px;line-height:1.6">${esc(prog.evidence)}</div>
          ${prog.metricSnapshot ? `<div class="small muted" style="margin-top:4px">当时指标：${esc(prog.metricSnapshot)}</div>` : ''}
          <div class="small muted" style="margin-top:4px">更新于 ${esc(prog.updatedAt || '-')}</div>
        </div>` : ''}
        <div class="btn-row" style="margin-top:10px">
          <button class="btn ghost sm" data-evidence="${t.id}">${prog?.evidence ? '更新产出' : '记录产出'}</button>
          <button class="btn ghost sm" data-ai-topic="${t.id}">让 AI 排本周练习</button>
        </div>
      </div>` : ''}
  </div>`;
}

export function mount(root, ctx) {
  root.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-stage-tab]');
    if (tab) { ctx._stageTab = tab.dataset.stageTab; ctx._openTopic = null; ctx.refresh(); return; }

    const toggle = e.target.closest('[data-toggle-topic]');
    if (toggle) { cycleTopicStatus(toggle.dataset.toggleTopic); ctx.refresh(); return; }

    const open = e.target.closest('[data-open-topic]');
    if (open) {
      const id = open.dataset.openTopic;
      ctx._openTopic = ctx._openTopic === id ? null : id;
      ctx.refresh({ keepScroll: true });
      return;
    }

    const ev = e.target.closest('[data-evidence]');
    if (ev) return ctx.openTopicEvidence(ev.dataset.evidence);

    const ai = e.target.closest('[data-ai-topic]');
    if (ai) return ctx.openAi('learning', null, ai.dataset.aiTopic);

    const radar = e.target.closest('[data-radar]');
    if (radar) {
      const [dim, v] = radar.dataset.radar.split(':');
      setRadar(dim, Number(v));
      ctx.refresh();
      return;
    }

    if (e.target.closest('[data-copy-review]')) {
      const txt = root.querySelector('#reviewTpl').textContent;
      (navigator.clipboard?.writeText(txt) ?? Promise.reject()).then(
        () => ctx.toast('复盘模板已复制'),
        () => ctx.toast('复制失败，请手动选中复制', 'warn')
      );
      return;
    }
    if (e.target.closest('[data-mark-review]')) {
      setReviewDate();
      ctx.toast('已标记本月复盘完成');
      ctx.refresh();
    }
  });
}
