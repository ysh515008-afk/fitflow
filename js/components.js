/* ============================================================
   components.js · 通用 UI 构件
   ============================================================ */
import { esc, uid } from './util.js';
import { STAGES } from './store.js';

/* ---------------- Toast ---------------- */
export function toast(msg, type = 'ok') {
  const root = document.getElementById('toastRoot');
  if (!root) return;
  const icon = type === 'ok' ? 'i-check' : type === 'warn' ? 'i-alert' : 'i-bell';
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<svg viewBox="0 0 24 24"><use href="#${icon}"/></svg><span>${esc(msg)}</span>`;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, 2100);
}

/**
 * 界面居中的灰片提示。
 *
 * 与 toast 的分工：toast 是底部一闪而过的小条；这个是一小块只裹住文字的灰片，
 * 用来在运行结束后把今日工作量顶到眼前一次。
 *
 * 收场是「溶解散落 → 吸入顶栏星星」：文字模糊化开，同时化出一撮光点，
 * 错落地飞向顶栏那颗星（像把星光收进去）。收起过程完全由计时器驱动，
 * **没有关闭按钮、也不接点击** —— 它挂的 #toastRoot 是禁用指针事件的容器，
 * 挂点击事件根本收不到（上一版「点知道了没反应」就是这么来的）。
 *
 * 不接点击还带来一个好处：灰片显示期间，首页照常上下滑、照常切到客户/运营页，
 * 不会被一层看不见的遮罩挡住。
 *
 * @param {string} msg  主文案
 * @param {string} [sub] 副文案（一行数字一类的补充）
 * @returns {() => void} 手动关闭函数（一般不用，给测试与异常兜底）
 */

/** 灰片停留多久后开始溶解（毫秒） */
export const CENTER_NOTICE_HOLD = 1400;
/** 溶解 + 吸入这一段动画的总时长（毫秒），只用于兜底移除，节奏本身在 CSS 里 */
export const CENTER_NOTICE_FADE = 1100;
/** 溶解出多少粒光点 */
export const CENTER_NOTICE_DUST = 22;
/** 光点最终吸向哪里：顶栏那颗星（星星按钮的中心） */
export const CENTER_NOTICE_STAR_SEL = '.bubble[data-hdr="brand"]';

/**
 * 光点层。抽成纯函数，让预览页与线上拿到同一份结构。
 * @param {number} [n] 光点数量
 * @param {function} [rnd] 随机源。测试里传一个固定序列，结果才可复现。
 */
export function centerNoticeDustHTML(n = CENTER_NOTICE_DUST, rnd = Math.random) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const x = (4 + rnd() * 92).toFixed(1);
    const y = (10 + rnd() * 80).toFixed(1);
    const delay = (rnd() * 0.26).toFixed(2);
    const dur = (0.7 + rnd() * 0.32).toFixed(2);
    out += `<i style="left:${x}%;top:${y}%;--delay:${delay}s;--dur:${dur}s"></i>`;
  }
  return `<div class="cn-dust" aria-hidden="true">${out}</div>`;
}

/**
 * 灰片的 HTML。抽成纯函数，是为了让预览脚本和断言脚本
 * 能拿到和线上完全一致的结构，不用另抄一份（抄的那份迟早会和真实的跑偏）。
 */
export function centerNoticeHTML(msg, sub = '', opt = {}) {
  return `
    <div class="cn-slab" role="status" aria-label="${esc(msg)}${sub ? ' ' + esc(sub) : ''}">
      <div class="cn-title">${esc(msg)}</div>
      ${sub ? `<div class="cn-sub">${esc(sub)}</div>` : ''}
      ${centerNoticeDustHTML(opt.dust ?? CENTER_NOTICE_DUST, opt.rnd || Math.random)}
    </div>`;
}

/**
 * 给每粒光点算出「要飞到哪」：目标点是顶栏星星的中心。
 * 位移量在加 .out 之前算好写进 CSS 变量，动画里就不用再跑 JS。
 */
export function aimDustAtStar(wrap) {
  const star = document.querySelector(CENTER_NOTICE_STAR_SEL);
  let tx = window.innerWidth / 2;
  let ty = 28; /* 找不到星星时退回顶部中间，效果还在，只是不收进星星里 */
  if (star) {
    const r = star.getBoundingClientRect();
    tx = r.left + r.width / 2;
    ty = r.top + r.height / 2;
  }
  wrap.querySelectorAll('.cn-dust i').forEach((el) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--dx', (tx - (r.left + r.width / 2)).toFixed(1) + 'px');
    el.style.setProperty('--dy', (ty - (r.top + r.height / 2)).toFixed(1) + 'px');
  });
}

export function centerNotice(msg, sub = '') {
  const root = document.getElementById('toastRoot') || document.body;
  /* 连着点几次运行会叠出好几片，所以先收掉上一片 */
  root.querySelectorAll('.cn-mask').forEach((n) => n.remove());
  const wrap = document.createElement('div');
  wrap.className = 'cn-mask';
  wrap.innerHTML = centerNoticeHTML(msg, sub);
  root.appendChild(wrap);

  const timer = setTimeout(() => {
    /* 位移要在这时候量：灰片刚渲染完可能还没布局稳定，早量会算偏 */
    aimDustAtStar(wrap);
    wrap.classList.add('out');
    const done = () => wrap.remove();
    /* 兜底：动画没跑完（页面切后台）也要保证收掉，不留一层浮在上面 */
    setTimeout(done, CENTER_NOTICE_FADE + 260);
  }, CENTER_NOTICE_HOLD);

  return () => { clearTimeout(timer); wrap.remove(); };
}

/* ---------------- 底部抽屉 ---------------- */
/**
 * @param {string} [backTo] 左上角返回按钮的可见文案。给了才会出现这个按钮。
 *        现在统一只写「返回」；具体的返回去处在 backAria 里（不进可见文案）。
 * @param {string} [backAria] 返回按钮的无障碍标签，可带上返回去向（如「返回（智能体）」），
 *        只给屏幕阅读器读，不显示在视觉界面。缺省时回退到 backTo。
 * @param {function} [onBack] 点返回时要做的事。openSheet 会先关掉抽屉再调它，
 *        这样"返回上一屏"和"关掉"是同一个动作，不会出现关了但没回去的情况。
 */
export function openSheet({ title = '', subtitle = '', body = '', footer = '', size = 'auto', backTo = '', backAria, onBack, onMount, onClose }) {
  const root = document.getElementById('modalRoot');
  const mask = document.createElement('div');
  mask.className = 'sheet-mask';
  /* 高度预算与宽度都写在 styles.css 的 .size-* 里，不再走行内 style：
     行内样式的优先级高于样式表，桌面断点就没法覆盖它。 */
  mask.innerHTML = `
    <div class="sheet size-${esc(size)}" role="dialog" aria-modal="true">
      <div class="sheet-hd">
        ${backTo ? `<button class="back-btn" data-sheet-back aria-label="${esc(backAria ?? backTo)}"><svg viewBox="0 0 24 24"><use href="#i-chev"/></svg><span>${esc(backTo)}</span></button>` : ''}
        <div style="flex:1;min-width:0">
          <h3>${esc(title)}</h3>
          ${subtitle ? `<div class="sub">${subtitle}</div>` : ''}
        </div>
        <button class="icon-btn" data-sheet-close aria-label="关闭"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>
      </div>
      <div class="sheet-bd">${body}</div>
      ${footer ? `<div class="sheet-ft">${footer}</div>` : ''}
    </div>`;

  const close = () => {
    mask.remove();
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  mask.addEventListener('click', (e) => {
    const back = e.target.closest('[data-sheet-back]');
    if (back) { close(); onBack && onBack(); return; }
    if (e.target === mask || e.target.closest('[data-sheet-close]')) close();
  });
  document.addEventListener('keydown', onKey);

  root.appendChild(mask);
  const sheetEl = mask.querySelector('.sheet');
  onMount && onMount(sheetEl, close);
  return { el: sheetEl, close };
}

/* ---------------- 确认框 ---------------- */
export function confirmDialog({ title, message, confirmText = '确认', danger = false, onConfirm }) {
  const { close } = openSheet({
    title,
    body: `<p style="font-size:13.5px;line-height:1.7;color:var(--ink-2)">${message}</p>`,
    footer: `<button class="btn ghost" data-cancel>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(confirmText)}</button>`,
    onMount(el, c) {
      el.querySelector('[data-cancel]').onclick = c;
      el.querySelector('[data-ok]').onclick = () => { c(); onConfirm(); };
    },
  });
  return close;
}

/* ---------------- 表单构件 ---------------- */
export const field = ({ label, name, value = '', type = 'text', placeholder = '', hint = '', attrs = '', required = false }) => `
  <div class="field">
    <label>${esc(label)}${required ? ' <span style="color:var(--danger)">*</span>' : ''}</label>
    <input class="input" type="${type}" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${attrs}/>
    ${hint ? `<div class="hint">${hint}</div>` : ''}
  </div>`;

export const selectField = ({ label, name, value = '', options = [], hint = '' }) => `
  <div class="field">
    <label>${esc(label)}</label>
    <select class="select" name="${name}">
      ${options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const t = typeof o === 'string' ? o : o.label;
        return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`;
      }).join('')}
    </select>
    ${hint ? `<div class="hint">${hint}</div>` : ''}
  </div>`;

export const textareaField = ({ label, name, value = '', placeholder = '', hint = '', rows = 3 }) => `
  <div class="field">
    <label>${esc(label)}</label>
    <textarea class="textarea" name="${name}" rows="${rows}" placeholder="${esc(placeholder)}" style="min-height:${rows * 24 + 30}px">${esc(value)}</textarea>
    ${hint ? `<div class="hint">${hint}</div>` : ''}
  </div>`;

/** 从表单容器里取值 */
export function serialize(root) {
  const out = {};
  root.querySelectorAll('[name]').forEach((el) => {
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
  });
  return out;
}

/* ---------------- 小构件 ---------------- */
export const stageBadge = (stage) => {
  const s = STAGES[stage] || { label: stage, cls: 'b-plain' };
  return `<span class="badge ${s.cls}">${esc(s.label)}</span>`;
};

export const badge = (text, cls = 'b-plain') => `<span class="badge ${cls}">${esc(text)}</span>`;

export const kvRow = (k, v, muted = false) =>
  `<div class="kv"><div class="k">${esc(k)}</div><div class="v ${muted ? 'muted' : ''}">${muted ? esc(v) : v}</div></div>`;

export const cardHead = (title, sub = '', right = '') => `
  <div class="card-hd">
    <div><h3>${esc(title)}</h3>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
    ${right}
  </div>`;

export const sectionTitle = (text, count = '') =>
  `<div class="section-title">${esc(text)}${count ? `<span class="count">${esc(count)}</span>` : ''}</div>`;

export function statCard({ k, v, unit = '', d = '', dir = '' }) {
  return `<div class="stat">
    <div class="k">${esc(k)}</div>
    <div class="v num">${esc(v)}${unit ? `<small>${esc(unit)}</small>` : ''}</div>
    ${d ? `<div class="d ${dir}">${esc(d)}</div>` : ''}
  </div>`;
}

export const emptyState = (text, icon = 'i-doc') =>
  `<div class="empty"><svg viewBox="0 0 24 24"><use href="#${icon}"/></svg><p>${text}</p></div>`;

export const notice = (text, kind = 'info', icon = 'i-alert') =>
  `<div class="notice ${kind}"><svg viewBox="0 0 24 24"><use href="#${icon}"/></svg><div>${text}</div></div>`;

/** 事件委托小工具 */
export function on(root, selector, event, handler) {
  root.addEventListener(event, (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) handler(t, e);
  });
}

/** 触发器 id（用于把动作绑回具体数据） */
export const bind = (obj) => `data-ref="${esc(obj)}"`;
