/* ============================================================
   consent.js · 个人信息处理同意与隐私告知
   ------------------------------------------------------------
   合规定位（PIPL）：
   - 把会员个人信息 / 健康数据发往第三方模型前，必须取得「单独同意」
     并履行告知义务（处理目的、方式、范围、接收方）—— 第 23 / 28 / 29 条
   - 首次使用须告知个人信息处理规则 —— 第 17 条
   - 提供撤回同意、删除数据的便捷通道 —— 第 44-47 条
   本模块只管「同意状态与告知 UI」，不碰业务数据本身。
   ============================================================ */
import { openSheet, confirmDialog, toast } from './components.js';
import { clearAll } from './store.js';

const CONSENT_KEY = 'fitflow.consent';

function readConsents() {
  try { return JSON.parse(localStorage.getItem(CONSENT_KEY) || '{}'); } catch { return {}; }
}
function writeConsents(obj) {
  try { localStorage.setItem(CONSENT_KEY, JSON.stringify(obj)); } catch {}
}

/** 是否已对某类处理取得同意 */
export const hasConsent = (type) => Boolean(readConsents()[type]);
/** 同意时间戳（用于设置页展示、审计） */
export const consentAt = (type) => readConsents()[type]?.at || null;
export function grantConsent(type) {
  const o = readConsents();
  o[type] = { at: new Date().toISOString() };
  writeConsents(o);
}
export function revokeConsent(type) {
  const o = readConsents();
  delete o[type];
  writeConsents(o);
}

/**
 * 在真正把数据发往第三方前调用。
 * 已同意 → 直接 resolve(true)；未同意 → 弹告知 + 勾选框，勾选后才能确认。
 * 关闭 / 取消 → resolve(false)，调用方据此中止外发。
 * @returns {Promise<boolean>}
 */
export function ensureConsent(type, {
  title = '确认外发会员个人信息',
  body = '',
  confirmText = '我已确认，继续发送',
  cancelText = '取消',
  danger = false,
} = {}) {
  if (hasConsent(type)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (ok) grantConsent(type);
      close();
      resolve(ok);
    };
    const sheet = openSheet({
      title,
      size: 'tall',
      subtitle: '依据《个人信息保护法》第 23 / 28 / 29 条，向第三方提供个人信息须取得你的单独同意',
      body: `
        <div class="consent-body">${body}</div>
        <label class="sw-row consent-chk" style="margin-top:14px">
          <input type="checkbox" id="consentChk"/>
          <span>我已就该会员的个人信息处理取得其单独同意，理解并将按上述说明把数据发往第三方模型。</span>
        </label>`,
      footer: `<button class="btn ghost" data-cancel>${cancelText}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok disabled>${confirmText}</button>`,
      onMount(el, closeFn) {
        const chk = el.querySelector('#consentChk');
        const okBtn = el.querySelector('[data-ok]');
        chk.addEventListener('change', () => { okBtn.disabled = !chk.checked; });
        el.querySelector('[data-cancel]').onclick = () => finish(false);
        okBtn.onclick = () => finish(true);
      },
      onClose() { finish(false); },
    });
    void sheet;
  });
}

/** 首屏首次运行：隐私告知 + 整体同意（PIPL 第 17 条） */
export function maybeFirstRunPrivacy() {
  if (hasConsent('privacy')) return;
  ensureConsent('privacy', {
    title: '隐私与数据处理说明',
    confirmText: '我已阅读并同意，开始使用',
    body: privacyBodyHTML(),
  });
}

/** 设置页「隐私与数据处理说明」入口：完整告知 + 同意状态 + 撤回 / 清除 */
export function openPrivacySheet() {
  const render = () => {
    const at = (t) => (consentAt(t) ? `<span class="badge b-green">已同意 ${consentAt(t).slice(0, 10)}</span>` : '<span class="badge b-plain">未同意</span>');
    return `
      <div class="consent-body">${privacyBodyHTML()}</div>
      <div class="section-title">当前同意状态</div>
      <div class="card tight">
        ${kv('AI 直接调用模型（含会员档案）', at('aiSend'))}
        ${kv('复制 / 打开豆包', at('aiExport'))}
        ${kv('云端润色触达话术', at('cloudPolish'))}
        ${kv('隐私告知与整体同意', at('privacy'))}
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn ghost" data-revoke="aiSend">撤回 AI 调用同意</button>
        <button class="btn ghost" data-revoke="aiExport">撤回豆包同意</button>
        <button class="btn ghost" data-revoke="cloudPolish">撤回润色同意</button>
      </div>
      <div class="hint" style="margin-top:10px">撤回后，再次外发会员数据前会重新要求你确认。</div>
      <div class="section-title">数据清除</div>
      <button class="btn danger" data-wipe>清除本地全部数据（不可恢复）</button>
    `;
  };
  const sheet = openSheet({
    title: '隐私与数据处理说明',
    size: 'tall',
    body: render(),
    footer: `<button class="btn primary" data-sheet-close>关闭</button>`,
    onMount(el, close) {
      el.querySelectorAll('[data-revoke]').forEach((b) => {
        b.onclick = () => {
          revokeConsent(b.dataset.revoke);
          el.querySelector('.sheet-bd').innerHTML = render();
          toast('已撤回该同意');
        };
      });
      const wipe = el.querySelector('[data-wipe]');
      if (wipe) wipe.onclick = () => confirmDialog({
        title: '清除本地全部数据',
        message: '将删除本机浏览器中全部会员、跟进、预约等数据，且不可恢复。建议先导出备份。确认吗？',
        confirmText: '清除', danger: true,
        onConfirm() { clearAll(); close(); toast('已清除本地全部数据'); },
      });
    },
  });
  void sheet;
}

/* 隐私告知正文（多处复用） */
function privacyBodyHTML() {
  return `
    <p class="privacy-p">FitFlow 是一款<strong>纯本地</strong>的健身房经营工具。我们对你的会员个人信息与健康数据采取以下处理方式：</p>
    <ul class="privacy-list">
      <li><b>本地存储（已加密）</b>：会员档案、跟进、到店 / 身体记录等全部存于你当前浏览器，并以 AES-GCM 加密落盘，<strong>不会自动上传任何服务器</strong>。</li>
      <li><b>第三方模型</b>：当你主动点击「调用模型」「云端润色」或把提示词粘贴到网页版模型时，相关会员信息才会发往你选择的大模型厂商。默认推荐豆包等国内可直连模型，数据由国内厂商处理、不出境；若你自行填写境外 Endpoint，数据将出境至境外接收方。</li>
      <li><b>公开内容源</b>：抖音数据分析来自红狐（redfox.hk），仅取公开内容，<strong>不含任何会员个人信息</strong>。</li>
      <li><b>你的权利</b>：你随时可在本页撤回同意、清除全部本地数据；会员数据删除后不可恢复。</li>
    </ul>
    <p class="privacy-p muted">请仅在个人设备、且已就会员个人信息处理取得会员本人同意的情况下使用本工具。把会员数据发往第三方模型前，本工具会再次要求你单独确认。</p>
  `;
}

function kv(k, v) {
  return `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
}
