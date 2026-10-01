/* ============================================================
   connectorConsole.js · 业务系统对接控制台
   三体 / 勤鸟 共用一套界面：概览、接口规格、字段映射、日志、对接代码
   以及兜底通道（表格导入）与设置抽屉
   ============================================================ */
import {
  setConnector, setPrimaryConnector, setEndpointVerified, setMappingOverride,
  addConnectorLog, applySyncedMembers, resetDemo, exportJSON, importJSON, clearAll,
  addConnectorAccount, setActiveAccount, removeConnectorAccount, setConnectorAuthUrl,
  memberById, bumpWorkload,
} from './store.js';
import {
  PROVIDER_LIST, getProvider, makeClient, defaultConnector,
  guessMapping, rowsToMembers, MEMBER_FIELDS,
} from './integrations/index.js';
import { openSheet, confirmDialog, toast, field, selectField, textareaField, serialize, badge, kvRow, emptyState, notice } from './components.js';
import { esc, parseTable, downloadFile, today } from './util.js';
import { openPrivacySheet } from './consent.js';

const STATUS_TEXT = {
  connected: { label: '已连接', cls: 'b-green' },
  pending: { label: '待授权', cls: 'b-warn' },
  unauthorized: { label: '未授权', cls: 'b-plain' },
  error: { label: '异常', cls: 'b-danger' },
};

/* ============================================================
   对接控制台
   ============================================================ */
export function openConnectorSheet(id, ctx) {
  const p = getProvider(id);
  if (!p) return toast('未知对接方', 'warn');

  openSheet({
    title: `${p.name} 对接`,
    subtitle: `${esc(p.vendor)}`,
    size: 'tall',
    body: `<div id="ccBody"></div>`,
    onMount(el, close) {
      const body = el.querySelector('#ccBody');
      let tab = 'overview';
      const paint = () => {
        body.innerHTML = panel(id, tab, ctx);
        if (tab === 'code') bindCodeCopy(body);
        if (tab === 'mapping') bindMapping(body, id, ctx, paint);
      };
      paint();

      el.addEventListener('click', async (e) => {
        const t = e.target.closest('[data-ctab]');
        if (t) { tab = t.dataset.ctab; paint(); el.querySelector('.sheet-bd').scrollTop = 0; return; }

        if (e.target.closest('[data-act="edit-config"]')) return openConnectorForm(id, ctx, paint);
        if (e.target.closest('[data-act="auth-entry"]')) return openAuthSheet(id, ctx);
        if (e.target.closest('[data-act="account-entry"]')) return openAccountSheet(id, ctx);
        const ep = e.target.closest('[data-check-ep]');
        if (ep) {
          const key = ep.dataset.checkEp;
          const cur = ctx.state.connectors[id].endpointsVerified?.[key] ?? p.endpointSpec[key].verified;
          setEndpointVerified(id, key, !cur);
          const allDone = Object.entries(p.endpointSpec)
            .every(([k, s]) => (k === key ? !cur : (ctx.state.connectors[id].endpointsVerified?.[k] ?? s.verified)));
          if (allDone && ctx.state.connectors[id].status !== 'connected') setConnector(id, { status: 'pending' });
          toast(!cur ? '已标记核对完成' : '已取消核对');
          paint();
          ctx.refresh();
          return;
        }
        /* 工作量：主动与外部平台接口交互（测试连接 / 立即同步）= 一次观察量 */
        if (e.target.closest('[data-act="test"]')) { bumpWorkload('obs'); return runTest(id, ctx, body, paint); }
        if (e.target.closest('[data-act="sync"]')) { bumpWorkload('obs'); return runSync(id, ctx, body, paint); }
        if (e.target.closest('[data-act="import"]')) return openImportSheet(ctx, id, paint);
        if (e.target.closest('[data-act="primary"]')) { setPrimaryConnector(id); toast(`${p.name} 已设为主用系统`); paint(); ctx.refresh(); return; }
        if (e.target.closest('[data-act="reset-conn"]')) {
          return confirmDialog({
            title: '重置对接配置', message: '会清空这家系统的基础地址、已核对的端点与字段映射覆盖。同步记录保留。',
            confirmText: '重置', danger: true,
            onConfirm() { setConnector(id, { ...defaultConnector(id), logs: ctx.state.connectors[id].logs }); toast('已重置'); paint(); ctx.refresh(); },
          });
        }
      });
    },
  });
}

function panel(id, tab, ctx) {
  const p = getProvider(id);
  const c = ctx.state.connectors[id];
  const st = STATUS_TEXT[c.status] || STATUS_TEXT.unauthorized;
  const specs = Object.entries(p.endpointSpec);
  const readyCount = specs.filter(([k, e]) => c.endpointsVerified?.[k] ?? e.verified).length;

  const tabs = [
    ['overview', '概览'],
    ['spec', `接口规格 ${readyCount}/${specs.length}`],
    ['mapping', '字段映射'],
    ['logs', `日志 ${c.logs.length}`],
    ['code', '对接代码'],
  ];

  const head = `
  <div class="conn">
    <div class="conn-hd">
      <div class="conn-logo" style="background:linear-gradient(145deg,${p.logoFrom},${p.logoTo})">${esc(p.logoText)}</div>
      <div style="flex:1;min-width:0">
        <div class="nm">${esc(p.name)}${ctx.state.connectors.primary === id ? ' <span class="badge b-green" style="margin-left:4px">主用</span>' : ''}</div>
        <div class="vd">${esc(p.vendor)}</div>
      </div>
      <span class="badge ${st.cls}">${st.label}</span>
    </div>
  </div>
  <div class="tabs-mini">${tabs.map(([k, l]) => `<button data-ctab="${k}" class="${tab === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;

  let body = '';

  /* ---------------- 概览 ---------------- */
  if (tab === 'overview') {
    const activeAcc = c.accounts?.find((a) => a.id === c.activeAccountId);
    body = `
      ${c.status !== 'connected' ? notice(
        c.status === 'unauthorized'
          ? `<strong>未授权。</strong>${id === 'qinniao' ? '勤鸟开放平台需要向其商务或客服申请开通，公开渠道拿不到接口文档。适配器代码已经写好，等你拿到文档核对端点后再启用。' : '网关 Key 还没有配置到本地代理进程里，接口调用会被拒绝。'}`
          : `<strong>待授权。</strong>当前会员资料来自「导出表格导入」的兜底通道，不是实时接口返回值。`,
        c.status === 'unauthorized' ? 'danger' : 'warn') : notice('已连接。数据来自接口实时读取。', 'green', 'i-sync')}

      <div class="section-title">两份入口</div>
      <div class="card tight">
        <div class="between" style="padding:9px 0;border-bottom:1px solid var(--line-2)">
          <div style="min-width:0">
            <div class="small" style="font-weight:700">① 系统接口授权</div>
            <div class="small muted" style="margin-top:2px">让 FitFlow 获得调用 ${esc(p.name)} 接口的资格（密钥 / 手机端授权）</div>
          </div>
          <button class="btn ghost sm" data-act="auth-entry">去授权</button>
        </div>
        <div class="between" style="padding:9px 0">
          <div style="min-width:0">
            <div class="small" style="font-weight:700">② 账号登陆${c.accounts?.length ? `（${c.accounts.length} 个）` : ''}</div>
            <div class="small muted" style="margin-top:2px">${activeAcc ? `当前：${esc(activeAcc.name)}` : '尚未登陆个人账号'}${c.status === 'connected' || c.status === 'pending' ? ' · 可随时切换' : ' · 需先授权'}</div>
          </div>
          <button class="btn ghost sm" data-act="account-entry">${activeAcc ? '切换账号' : '去登陆'}</button>
        </div>
      </div>

      <div class="section-title">接入配置</div>
      <div class="card tight">
        ${kvRow('服务地址', c.baseUrl ? esc(c.baseUrl) : '未填写', !c.baseUrl)}
        ${kvRow('代理地址', `<span class="mono">${esc(c.proxyUrl || 'http://localhost:8787')}</span>`)}
        ${kvRow('访问口令', c.proxyToken ? '已设置' : '未设置', !c.proxyToken)}
        ${kvRow('系统版本', c.systemVersion ? esc(c.systemVersion) : '未填写', !c.systemVersion)}
        ${kvRow('账号角色', c.accountRole ? esc(c.accountRole) : '未填写', !c.accountRole)}
        ${kvRow('同步范围', c.scope === 'all' ? '全店会员' : '仅本人负责的会员')}
        ${kvRow('鉴权方式', esc(p.authLabel))}
        ${kvRow('密钥位置', `<span class="small muted">本地代理进程环境变量：${esc(p.authSpec.envVars.join('、'))}</span>`)}
        ${kvRow('自动同步', c.autoSync ? '已开启' : '关闭（待端点核对完成后开启）')}
        ${kvRow('写回对方系统', '关闭', true)}
      </div>
      <div class="hint" style="margin:-4px 2px 12px">第一版只做「对方系统 → FitFlow 」的单向读取。写回会改动门店真实会籍数据，必须单独核对权限后再开。</div>

      <div class="section-title">已知能力范围</div>
      <div class="card tight"><div class="tag-row">${p.knownScope.map((x) => badge(x, 'b-plain')).join('')}</div></div>
      <div class="card tight">
        <div class="small" style="line-height:1.7">${esc(c.note || '')}</div>
      </div>

      <div class="section-title">操作</div>
      <div class="btn-row">
        <button class="btn primary" data-act="edit-config">填写接入信息</button>
        <button class="btn ghost" data-act="test">测试连接</button>
        <button class="btn ghost" data-act="sync">立即同步会员</button>
        ${ctx.state.connectors.primary !== id ? `<button class="btn ghost" data-act="primary">设为主用系统</button>` : ''}
        <button class="btn ghost" data-act="import">兜底通道：导入表格</button>
        <button class="btn danger" data-act="reset-conn">重置配置</button>
      </div>
      <div id="testOut" style="margin-top:12px"></div>
      <div class="hint" style="margin-top:10px">调用顺序建议：填写接入信息 → 用官方文档核对端点 → 测试连接 → 立即同步。端点没核对前，同步按钮会拒绝发起请求。</div>`;
  }

  /* ---------------- 接口规格 ---------------- */
  if (tab === 'spec') {
    body = `
      ${notice('每个端点都需要你用官方开发文档核对：路径、请求方式、鉴权 header、字段命名。核对一项勾一项。<strong>没勾的端点不会发起请求</strong>，这样就不会把猜测当事实。', 'warn', 'i-doc')}
      <div class="section-title">端点清单</div>
      <div class="card tight">
        ${specs.map(([key, e]) => {
          const ok = c.endpointsVerified?.[key] ?? e.verified;
          return `<div class="spec-row">
            <button class="check ${ok ? 'on' : ''}" data-check-ep="${key}" aria-label="标记已核对">
              <svg viewBox="0 0 24 24"><use href="#i-check"/></svg>
            </button>
            <div style="flex:1;min-width:0">
              <div class="t">${esc(e.note || key)}</div>
              <div class="m">${esc(e.method)} ${esc(e.path)}</div>
            </div>
            ${ok ? badge('已核对', 'b-green') : badge('待核对', 'b-warn')}
          </div>`;
        }).join('')}
      </div>
      <div class="hint">勾选状态保存在本机。全部核对完之后，「立即同步」才会真正发请求。</div>`;
  }

  /* ---------------- 字段映射 ---------------- */
  if (tab === 'mapping') {
    const groups = Object.entries(p.mapping);
    body = `
      ${notice('左边是本工作台的字段，右边是对方系统里的字段路径。路径必须用真实返回报文核对，改完点保存。FitFlow 内部字段（跟进、备注、目标、顾虑）永远不被远端覆盖。', 'info', 'i-doc')}
      ${groups.map(([resource, rows]) => `
        <div class="section-title">${esc(resourceLabel(resource))}</div>
        <div class="card tight">
          ${rows.map((r) => {
            const override = c.mappingOverrides?.[resource]?.[r.target];
            const meta = MEMBER_FIELDS.find((f) => f.key === r.target);
            return `<div class="map-row">
              <div>
                <div class="k">${esc(meta?.label || r.target)}</div>
                ${meta?.note ? `<div class="small muted" style="margin-top:2px">${esc(meta.note)}</div>` : ''}
              </div>
              <div class="s">${esc(override || r.source)}${override ? ' <span style="color:var(--brand)">已改</span>' : ''}</div>
              <button class="btn sm ghost" data-map-edit="${resource}:${r.target}">改</button>
            </div>`;
          }).join('')}
        </div>`).join('')}
      <div class="hint">类型转换：日期统一成 YYYY-MM-DD，金额取数字，状态词按别名表归一。识别不了的一律返回空，由界面显示「未获取」。</div>`;
  }

  /* ---------------- 日志 ---------------- */
  if (tab === 'logs') {
    body = c.logs.length ? `<div class="timeline">${c.logs.map((l) => `
      <div class="tl-item ${l.ok ? (l.type === 'error' ? 'warn' : 'on') : 'warn'}">
        <div class="tl-date">${esc(l.at)} · ${esc(logTypeLabel(l.type))}${l.records ? ` · ${l.records} 条` : ''}</div>
        <div class="tl-body">${esc(l.message)}</div>
        ${l.scope ? `<div class="tl-body" style="color:var(--ink-3)">范围：${esc(l.scope)}</div>` : ''}
      </div>`).join('')}</div>`
      : emptyState('还没有同步记录', 'i-sync');
  }

  /* ---------------- 对接代码 ---------------- */
  if (tab === 'code') {
    const envs = p.authSpec.envVars.map((k) => `${k}=你的值`).join(' \\\n  ');
    const curl = `curl -X POST http://localhost:8787/proxy/${id} \\
  -H 'Content-Type: application/json' \\
  -d '{"resource":"members","method":"POST","path":"${Object.values(p.endpointSpec)[0].path}","body":{"pageNo":1,"pageSize":50}}'
# 线上：地址换成 https://你的域名/api/proxy/${id}，并加一行 -H 'X-Proxy-Token: 你的口令'`;
    const snippet = providerSnippet(id);
    body = `
      ${notice('对接分成三层：浏览器里的适配器负责字段映射，本地代理进程负责签名与转发，密钥只存在代理进程的环境变量里。<strong>前端代码里不会出现任何密钥。</strong>', 'info', 'i-spark')}

      <div class="section-title">1. 启动本地代理</div>
      <div class="prompt-box">
        <pre id="code-env">${esc(`# 在项目根目录执行\n${envs} \\\n  node server/proxy.mjs\n\n# 自检\ncurl http://localhost:8787/health`)}</pre>
        <div class="pb-actions"><button data-copy="#code-env"><svg viewBox="0 0 24 24"><use href="#i-copy"/></svg>复制</button></div>
      </div>

      <div class="section-title">2. 线上部署（Serverless）</div>
      <div class="prompt-box">
        <pre id="code-deploy">${esc(`# 仓库里已有：api/health.js、api/proxy/[provider].js
# git push 后 Vercel 自动部署，无需改前端

# Vercel 后台 → Settings → Environment Variables
${p.authSpec.envVars.map((k) => `${k}=你的值`).join('\n')}
PROXY_ACCESS_TOKEN=自定义口令
ALLOWED_ORIGINS=https://你的域名

# 前端「代理地址」填：https://你的域名/api
# 自检：
curl -H 'X-Proxy-Token: 你的口令' https://你的域名/api/health`)}</pre>
        <div class="pb-actions"><button data-copy="#code-deploy"><svg viewBox="0 0 24 24"><use href="#i-copy"/></svg>复制</button></div>
      </div>

      <div class="section-title">3. 代理转发测试</div>
      <div class="prompt-box">
        <pre id="code-curl">${esc(curl)}</pre>
        <div class="pb-actions"><button data-copy="#code-curl"><svg viewBox="0 0 24 24"><use href="#i-copy"/></svg>复制</button></div>
      </div>

      <div class="section-title">4. 适配器文件</div>
      <div class="prompt-box">
        <pre id="code-file">${esc(snippet)}</pre>
        <div class="pb-actions"><button data-copy="#code-file"><svg viewBox="0 0 24 24"><use href="#i-copy"/></svg>复制</button></div>
      </div>

      <div class="section-title">5. 核对清单</div>
      <div class="card tight">
        ${['确认开放平台如何申请、账号需要什么角色',
          '确认请求路径与请求方式（GET / POST）',
          '确认鉴权 header 名称与签名算法',
          '确认分页参数名与单页上限',
          '确认返回报文结构（列表所在层级）',
          '确认字段命名，逐条改字段映射',
          '确认是否限制出口 IP，需要就加白名单',
          '以上全部核对完，再把端点标记为已核对']
          .map((x, i) => `<div class="between" style="padding:7px 0;border-bottom:1px solid var(--line-2)">
            <span class="small">${esc(x)}</span>
            <span class="small muted num">${i + 1}</span>
          </div>`).join('')}
      </div>`;
  }

  return head + body;
}

const resourceLabel = (r) => ({
  members: '会员档案', cards: '会员卡 / 会籍', contracts: '合同', ptPackages: '私教课包',
  appointments: '预约', checkins: '入场签到', orders: '订单与收款', refunds: '退款', staff: '员工', stores: '门店',
}[r] || r);

const logTypeLabel = (t) => ({ sync: '接口同步', import: '表格导入', error: '失败', note: '备注' }[t] || t);

function providerSnippet(id) {
  return id === 'santi'
    ? `// js/integrations/santi.js（已写入项目）\n`
      + `// 鉴权：网关 Key（员工账号管理生成）\n`
      + `// 环境变量：SANTI_BASE_URL、SANTI_GATEWAY_KEY\n`
      + `// 端点与 header 名称全部标了 verified:false，核对后逐项打开`
    : `// js/integrations/qinniao.js（已写入项目）\n`
      + `// 鉴权：appKey + appSecret，签名在代理进程完成\n`
      + `// 两种签名模式：A = md5Upper(secret + 排序kv + secret)\n`
      + `//              B = md5Upper(appKey + timestamp + nonce + secret)\n`
      + `// 环境变量：QINNIAO_BASE_URL、QINNIAO_APP_KEY、QINNIAO_APP_SECRET、QINNIAO_SIGN_MODE\n`
      + `// 端点与字段名全部标了 verified:false，必须用勤鸟开发文档核对`;
}

function bindCodeCopy(root) {
  root.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.onclick = () => {
      const el = root.querySelector(btn.dataset.copy);
      if (!el) return;
      const txt = el.textContent;
      (navigator.clipboard?.writeText(txt) ?? Promise.reject()).then(
        () => toast('已复制'),
        () => toast('复制失败，请手动选中', 'warn')
      );
    };
  });
}

function bindMapping(root, id, ctx, paint) {
  root.querySelectorAll('[data-map-edit]').forEach((btn) => {
    btn.onclick = () => {
      const [resource, target] = btn.dataset.mapEdit.split(':');
      const p = getProvider(id);
      const row = p.mapping[resource].find((r) => r.target === target);
      const cur = ctx.state.connectors[id].mappingOverrides?.[resource]?.[target] || row.source;
      openSheet({
        title: '修改字段映射',
        subtitle: `${esc(resourceLabel(resource))} · ${esc(MEMBER_FIELDS.find((f) => f.key === target)?.label || target)}`,
        body: field({ label: '对方系统的字段路径', name: 'source', value: cur, placeholder: '如 data.memberList.mobile', hint: '支持 a.b.c 或 a.0.b 形式。必须用真实返回报文核对。' })
          + `<div class="hint">当前默认值：<span class="mono">${esc(row.source)}</span></div>`,
        footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存</button>`,
        onMount(el, close) {
          el.querySelector('[data-save]').onclick = () => {
            const v = el.querySelector('[name="source"]').value.trim();
            if (!v) return toast('不能为空', 'warn');
            setMappingOverride(id, resource, target, v);
            toast('映射已更新');
            close();
            paint();
            ctx.refresh();
          };
        },
      });
    };
  });
}

/* ============================================================
   接入信息表单
   ============================================================ */
function openConnectorForm(id, ctx, onSaved) {
  const p = getProvider(id);
  const c = ctx.state.connectors[id];
  openSheet({
    title: `${p.name} 接入信息`,
    subtitle: '密钥填在代理进程的环境变量里（线上在 Vercel 后台），不要填在这里',
    size: 'tall',
    body: `
      ${notice(`本表单只保存接入信息，不接收密钥。密钥通过环境变量注入代理进程（本地：启动命令；线上：Vercel 后台 Environment Variables）：<span class="mono">${esc(p.authSpec.envVars.join('、'))}</span>`, 'warn', 'i-alert')}
      ${field({ label: '服务地址 baseUrl', name: 'baseUrl', value: c.baseUrl, placeholder: '如 https://open.example.com', hint: `${esc(p.name)} 开放网关的根地址，由对方提供` })}
      ${field({ label: '代理地址', name: 'proxyUrl', value: c.proxyUrl || 'http://localhost:8787', hint: '本地：http://localhost:8787；线上：https://你的域名/api（线上部署见 DEPLOY.md）' })}
      ${field({
        label: '代理访问口令',
        name: 'proxyToken',
        type: 'password',
        value: c.proxyToken || '',
        placeholder: '线上代理必填，本地代理留空',
        hint: '对应服务端环境变量 PROXY_ACCESS_TOKEN。线上不设口令等于把三体会员数据公开，任何人拿到地址都能调。',
      })}
      ${field({ label: '系统版本', name: 'systemVersion', value: c.systemVersion, placeholder: id === 'santi' ? '如 三体云动 Pro' : '如 勤鸟 SaaS 门店版' })}
      ${field({ label: '账号角色', name: 'accountRole', value: c.accountRole, placeholder: '如 销售员工（本人）/ 门店管理员' })}
      ${selectField({ label: '读取范围', name: 'scope', value: c.scope, options: [
        { value: 'own', label: '仅本人负责的会员（推荐）' },
        { value: 'all', label: '全店会员（需要管理员权限）' },
      ], hint: '范围越大越容易被权限拦，第一版建议先只读本人负责的会员。' })}
      ${selectField({ label: '当前授权状态', name: 'status', value: c.status, options: [
        { value: 'unauthorized', label: '未授权（还没申请或没拿到密钥）' },
        { value: 'pending', label: '待授权（正在走流程 / 用导入兜底）' },
        { value: 'connected', label: '已连接（端点已核对且密钥可用）' },
        { value: 'error', label: '异常' },
      ], hint: '状态请如实选择。没接通就不要选「已连接」。' })}
      <div class="field">
        <label>开关</label>
        <div class="chips">
          <button type="button" class="chip ${c.autoSync ? 'on' : ''}" data-tg="autoSync">自动同步（每天一次）</button>
          <button type="button" class="chip ${c.writeBack ? 'on' : ''}" data-tg="writeBack">允许写回对方系统</button>
        </div>
        <div class="hint">写回会改动门店真实会籍数据，端点与权限没核对完之前请不要开。</div>
      </div>
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存</button>`,
    onMount(el, close) {
      const flags = { autoSync: c.autoSync, writeBack: c.writeBack };
      el.querySelectorAll('[data-tg]').forEach((b) => {
        b.onclick = () => {
          const k = b.dataset.tg;
          flags[k] = !flags[k];
          b.classList.toggle('on', flags[k]);
        };
      });
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        setConnector(id, {
          baseUrl: f.baseUrl, proxyUrl: f.proxyUrl, proxyToken: f.proxyToken, systemVersion: f.systemVersion,
          accountRole: f.accountRole, scope: f.scope, status: f.status,
          autoSync: flags.autoSync, writeBack: flags.writeBack,
        });
        toast('接入信息已保存');
        close();
        onSaved && onSaved();
        ctx.refresh();
      };
    },
  });
}

/* ============================================================
   入口一 · 系统接口授权
   授权是「系统级」的：让 FitFlow 拿到调用接口的资格（网关 Key 或 OAuth）。
   与「账号登陆」是两件事——授权只决定能不能读，账号决定读谁的数据。
   若厂商支持隐藏式授权（唤起手机端 App 完成授权后自动跳回），
   把它的授权深链填进来，即可「自动跳转授权」。
   ============================================================ */
function openAuthSheet(id, ctx) {
  const p = getProvider(id);
  const c = ctx.state.connectors[id];
  openSheet({
    title: `${p.name} · 系统接口授权`,
    subtitle: '授权让 FitFlow 能读取这家系统的数据',
    size: 'tall',
    body: `
      ${notice('授权是「系统级」的：让 FitFlow 拿到调用 ' + esc(p.name) + ' 接口的资格（网关 Key 或 OAuth）。它和「账号登陆」是两件事：授权只决定能不能读，个人账号决定读谁的数据。', 'info', 'i-key')}
      <div class="section-title">当前授权状态</div>
      <div class="card tight">
        ${kvRow('接口授权', STATUS_TEXT[c.status] ? `<span class="badge ${STATUS_TEXT[c.status].cls}">${STATUS_TEXT[c.status].label}</span>` : esc(c.status))}
        ${kvRow('授权方式', c.authUrl ? '手机端 App 授权（自动跳转）' : '本地代理密钥（网关 Key）')}
      </div>

      <div class="section-title">方式一 · 本地代理密钥</div>
      <div class="card tight">
        <div class="small" style="line-height:1.75">密钥留在本地代理进程的环境变量里：<span class="mono">${esc(p.authSpec.envVars.join('、'))}</span>。填好服务地址与版本后点「填写接入信息」保存，再回概览「测试连接」。</div>
        <div class="btn-row" style="margin-top:10px"><button class="btn primary sm" data-act="edit-config">填写接入信息</button></div>
      </div>

      <div class="section-title">方式二 · 手机端授权（自动跳转）</div>
      <div class="card tight">
        <div class="small muted" style="line-height:1.7;margin-bottom:8px">如果 ${esc(p.name)} 支持隐藏式授权（唤起手机端 App 完成授权后自动跳回），把它的授权深链 / 通用链接填在下面。之后点「用手机端 App 授权」会直接跳转，无需再碰密钥。</div>
        ${field({ label: '授权深链 / 通用链接', name: 'authUrl', value: c.authUrl || '', placeholder: id === 'santi' ? 'santi://oauth/authorize?app=fitflow' : 'qinniao://oauth/authorize?app=fitflow' })}
        <div class="btn-row" style="margin-top:4px">
          <button class="btn primary sm" data-auth-jump>用手机端 App 授权（自动跳转）</button>
        </div>
        <div class="hint">深链格式由 ${esc(p.name)} 开放平台规定，需按官方文档填写；本地演示可先填占位串验证跳转机制。</div>
      </div>`,
    onMount(el, close) {
      const edit = el.querySelector('[data-act="edit-config"]');
      if (edit) edit.onclick = () => openConnectorForm(id, ctx, () => { close(); openAuthSheet(id, ctx); });
      const jump = el.querySelector('[data-auth-jump]');
      if (jump) jump.onclick = () => {
        const url = el.querySelector('[name="authUrl"]').value.trim();
        if (!url) return toast('先填写授权深链', 'warn');
        setConnectorAuthUrl(id, url);
        toast('正在跳转手机端授权…');
        /* 自动跳转授权：交给系统唤起厂商 App / 通用链接完成授权后跳回 */
        try { window.location.href = url; } catch { /* 当前环境无法跳转时静默 */ }
      };
    },
  });
}

/* ============================================================
   入口二 · 账号登陆（操作员个人账号）
   系统接口已授权后，可随时切换个人账号，不影响授权本身。
   未授权时不允许登陆 / 切换，先走入口一。
   ============================================================ */
function openAccountSheet(id, ctx) {
  const p = getProvider(id);
  const c = ctx.state.connectors[id];
  const canLogin = c.status === 'connected' || c.status === 'pending';
  openSheet({
    title: `${p.name} · 账号登陆`,
    subtitle: canLogin ? '系统接口已授权，可随时切换个人账号' : '需先完成系统接口授权',
    size: 'tall',
    body: `
      ${canLogin
        ? notice('系统接口已授权。下面是在这家系统里登陆的个人操作员账号，决定「读谁的数据」。可随时切换，不影响接口授权本身。', 'green', 'i-users')
        : notice(`系统接口尚未授权（当前：${STATUS_TEXT[c.status]?.label || c.status}）。请先在「系统接口授权」入口完成授权，才能登陆或切换个人账号。`, 'warn', 'i-key')}

      <div class="section-title">已登陆账号</div>
      ${canLogin
        ? (c.accounts && c.accounts.length
            ? `<div class="card tight">${c.accounts.map((a) => `
              <div class="between" style="padding:10px 0;border-bottom:1px solid var(--line-2)">
                <div style="min-width:0">
                  <div class="small" style="font-weight:650">${esc(a.name)}${c.activeAccountId === a.id ? ' <span class="badge b-green">当前</span>' : ''}</div>
                  <div class="small muted" style="margin-top:2px">${esc(a.role || '操作员')}｜${a.scope === 'all' ? '全店' : '本人负责'}</div>
                </div>
                <div class="btn-row" style="flex:0 0 auto">
                  ${c.activeAccountId === a.id ? '' : `<button class="btn ghost sm" data-acc-switch="${a.id}">切换</button>`}
                  <button class="btn danger sm" data-acc-del="${a.id}">移除</button>
                </div>
              </div>`).join('')}</div>`
            : `<div class="card tight"><div class="small muted">还没有登陆任何个人账号。点下面「添加账号」绑定一位操作员。</div></div>`)
        : ''}
      ${canLogin
        ? `<div class="btn-row" style="margin-top:10px"><button class="btn primary sm" data-acc-add>添加账号</button></div>`
        : `<div class="btn-row" style="margin-top:10px"><button class="btn primary sm" data-auth-entry>去授权</button></div>`}`,
    onMount(el, close) {
      const add = el.querySelector('[data-acc-add]');
      if (add) add.onclick = () => openAccountForm(id, ctx, () => { close(); openAccountSheet(id, ctx); });
      const goAuth = el.querySelector('[data-auth-entry]');
      if (goAuth) goAuth.onclick = () => { close(); openAuthSheet(id, ctx); };
      el.addEventListener('click', (e) => {
        const sw = e.target.closest('[data-acc-switch]');
        if (sw) { setActiveAccount(id, sw.dataset.accSwitch); toast('已切换到该账号'); close(); openAccountSheet(id, ctx); return; }
        const del = e.target.closest('[data-acc-del]');
        if (del) { removeConnectorAccount(id, del.dataset.accDel); toast('已移除账号'); close(); openAccountSheet(id, ctx); }
      });
    },
  });
}

function openAccountForm(id, ctx, onSaved) {
  const p = getProvider(id);
  openSheet({
    title: `添加 ${p.name} 操作员账号`,
    subtitle: '绑定一位个人账号，用于指定数据读取范围',
    body: `
      ${field({ label: '账号名 / 员工名', name: 'name', placeholder: '如 王导 / 工号 A1023', required: true })}
      ${field({ label: '角色', name: 'role', placeholder: '如 销售员工 / 门店管理员' })}
      ${selectField({ label: '读取范围', name: 'scope', value: 'own', options: [
        { value: 'own', label: '仅本人负责的会员' },
        { value: 'all', label: '全店会员（需管理员）' },
      ] })}
      <div class="hint">同一系统可绑定多位操作员，随时切换。账号权限以 ${esc(p.name)} 侧为准。</div>
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>添加</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        if (!f.name) return toast('请填写账号名', 'warn');
        addConnectorAccount(id, { name: f.name, role: f.role, scope: f.scope });
        toast('账号已添加');
        close();
        onSaved && onSaved();
        ctx.refresh();
      };
    },
  });
}

/* ============================================================
   测试连接 / 立即同步
   ============================================================ */
async function runTest(id, ctx, body, paint) {
  const out = body.querySelector('#testOut');
  const p = getProvider(id);
  const c = ctx.state.connectors[id];
  out.innerHTML = `
    <div class="card tight">
      <div class="skeleton w60" style="margin-bottom:8px"></div>
      <div class="skeleton w40"></div>
      <div class="hint" style="margin-top:8px">正在向代理 ${esc(c.proxyUrl || 'http://localhost:8787')} 发起健康检查</div>
    </div>`;

  const client = makeClient(id, c);
  const res = await client.testConnection();

  if (res.ok) {
    const info = res.info;
    out.innerHTML = notice(
      `代理已连通。${esc(p.name)} 密钥状态：<strong>已配置</strong>（${esc(info.authMode || '')}${info.keyPreview ? '，' + esc(info.keyPreview) : ''}）。` +
      (info.baseUrlSet ? '' : '<br/>但服务地址还没填写，请在「填写接入信息」里补上。'),
      'green', 'i-check');
    setConnector(id, { status: info.baseUrlSet ? 'pending' : c.status, lastError: null });
    addConnectorLog(id, { type: 'sync', scope: '健康检查', records: 0, ok: true, message: '代理连通性检查通过，密钥已就绪' });
  } else {
    const err = res.error;
    out.innerHTML = notice(
      `<strong>${esc(err.code === 'network' ? '连不上本地代理' : err.code === 'unauthorized' ? '密钥未配置' : '检查失败')}</strong><br/>${esc(err.message)}`,
      'danger', 'i-alert');
    addConnectorLog(id, { type: 'error', scope: '健康检查', records: 0, ok: false, message: err.message });
    if (err.code === 'network' || err.code === 'unauthorized') setConnector(id, { status: c.status === 'connected' ? 'error' : c.status });
  }
  ctx.refresh();
}

async function runSync(id, ctx, body, paint) {
  const out = body.querySelector('#testOut');
  const p = getProvider(id);
  const c = ctx.state.connectors[id];
  out.innerHTML = `
    <div class="card tight">
      <div class="skeleton w60" style="margin-bottom:8px"></div>
      <div class="skeleton w40"></div>
      <div class="hint" style="margin-top:8px">正在读取 ${esc(p.name)} 的会员列表</div>
    </div>`;

  try {
    const client = makeClient(id, c, { allowUnverified: false });
    const list = await client.fetchMembers({ pageNo: 1, pageSize: 100 });
    const r = applySyncedMembers(list, id);
    setConnector(id, { status: 'connected', lastSyncAt: today(), lastError: null });
    addConnectorLog(id, {
      type: 'sync', scope: c.scope === 'all' ? '全店会员' : '本人负责会员',
      records: list.length, ok: true,
      message: `接口同步完成：新增 ${r.created} 人，更新 ${r.updated} 人，跳过 ${r.skipped} 条（缺少会员 ID 或姓名）`,
    });
    out.innerHTML = notice(`同步完成：新增 <strong>${r.created}</strong> 人，更新 <strong>${r.updated}</strong> 人，跳过 ${r.skipped} 条。`, 'green', 'i-check');
    ctx.refresh();
  } catch (err) {
    out.innerHTML = notice(
      `<strong>同步未执行</strong><br/>${esc(err.message)}` +
      (err.code === 'endpoint_unverified' ? '<br/><br/>这是预期行为：端点没核对之前，FitFlow 不会替你猜接口。可以先用「兜底通道：导入表格」顶上。' : ''),
      'danger', 'i-alert');
    addConnectorLog(id, { type: 'error', scope: '会员', records: 0, ok: false, message: err.message });
    ctx.refresh();
  }
}

/* ============================================================
   兜底通道：表格导入
   ============================================================ */
export function openImportSheet(ctx, presetProvider, onDone) {
  const providerId = presetProvider || ctx.state.connectors.primary || 'santi';
  let step = 'paste';
  let parsed = null;
  let colMap = {};
  let target = { create: 0, update: 0, skip: 0 };

  openSheet({
    title: '导入数据表',
    subtitle: '三体 / 勤鸟后台导出的会员表，直接粘贴进来即可',
    size: 'tall',
    body: `<div id="impBody"></div>`,
    footer: `<button class="btn ghost" data-sheet-close>关闭</button><button class="btn primary" data-imp-next>解析表格</button>`,
    onMount(el, close) {
      const body = el.querySelector('#impBody');
      const nextBtn = el.querySelector('[data-imp-next]');
      const paint = () => {
        body.innerHTML = importStep(step, parsed, colMap, providerId, target, ctx);
        nextBtn.textContent = step === 'paste' ? '解析表格' : step === 'map' ? '开始导入' : '完成';
      };
      paint();

      nextBtn.onclick = () => {
        if (step === 'paste') {
          const txt = body.querySelector('#impText').value;
          parsed = parseTable(txt);
          if (!parsed.headers.length) return toast('没读到内容，检查一下粘贴的表格', 'warn');
          colMap = guessMapping(parsed.headers);
          step = 'map';
          paint();
          return;
        }
        if (step === 'map') {
          const rows = rowsToMembers(parsed.rows, parsed.headers, colMap, providerId);
          if (!rows.length) return toast('没有可导入的行，检查字段对应关系', 'warn');
          target = applySyncedMembers(rows, providerId);
          addConnectorLog(providerId, {
            type: 'import', scope: '导出表格导入', records: rows.length, ok: true,
            message: `兜底通道导入：新增 ${target.create} 人，更新 ${target.update} 人，跳过 ${target.skip} 条`,
          });
          step = 'done';
          paint();
          ctx.refresh();
          return;
        }
        close();
        onDone && onDone();
      };

      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-imp-again]')) {
          step = 'paste';
          parsed = null;
          colMap = {};
          paint();
        }
      });

      /* 字段对应关系用 change 委托 */
      body.addEventListener('change', (e) => {
        const s = e.target.closest('[data-col-for]');
        if (!s) return;
        const field0 = s.dataset.colFor;
        if (s.value) colMap[field0] = s.value;
        else delete colMap[field0];
      });
    },
  });
}

function importStep(step, parsed, colMap, providerId, target, ctx) {
  if (step === 'paste') {
    return `
      ${notice('从三体或勤鸟后台导出会员表（Excel 另存为 CSV，或直接从表格里复制），粘贴到下面。FitFlow 会自动识别分隔符、处理引号，并猜列名。', 'info', 'i-doc')}
      <div class="field">
        <label>粘贴表格内容<span style="color:var(--danger)"> *</span></label>
        <textarea class="textarea" id="impText" rows="12" style="min-height:230px;font-family:var(--mono);font-size:11.5px"
          placeholder="姓名\t手机号\t卡种\t到期日期\t剩余课时&#10;林嘉怡\t13800132211\t年卡\t2026-10-18\t12"></textarea>
        <div class="hint">第一行必须是表头。支持 Tab 分隔（从 Excel 直接复制）和逗号分隔（CSV）。</div>
      </div>
      <div class="card tight">
        <div class="small" style="font-weight:650;margin-bottom:6px">导出位置参考</div>
        <div class="small muted" style="line-height:1.7">
          三体：会员列表 → 导出<br/>
          勤鸟：会员 CRM / 合同管理 → 导出报表<br/>
          导出后遮掉不需要的列也行，FitFlow 只读它认识的字段。
        </div>
      </div>`;
  }

  if (step === 'map') {
    const fields = Object.keys(colMap).length;
    return `
      ${notice(`读到 <strong>${parsed.rows.length}</strong> 行、<strong>${parsed.headers.length}</strong> 列，自动匹配上 ${fields} 个字段。核对一下对应关系，不对的手动改。`, fields >= 5 ? 'green' : 'warn', 'i-check')}
      <div class="card tight">
        ${MEMBER_FIELDS.map((f) => `
          <div class="between" style="padding:7px 0;border-bottom:1px solid var(--line-2)">
            <div style="min-width:0">
              <div class="small" style="font-weight:650">${esc(f.label)}${f.required ? ' *' : ''}</div>
              ${f.note ? `<div class="small muted">${esc(f.note)}</div>` : ''}
            </div>
            <select class="select" data-col-for="${f.key}" style="max-width:168px">
              <option value="">不导入</option>
              ${parsed.headers.map((h) => `<option value="${esc(h)}" ${colMap[f.key] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}
            </select>
          </div>`).join('')}
      </div>
      <div class="err" id="impWarn"></div>
      <div class="card tight">
        <div class="small" style="font-weight:650;margin-bottom:6px">前 3 行预览</div>
        <div class="tbl-scroll">
          <table class="tbl">
            <thead><tr>${parsed.headers.slice(0, 6).map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
            <tbody>${parsed.rows.slice(0, 3).map((r) => `<tr>${parsed.headers.slice(0, 6).map((_, i) => `<td>${esc(r[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`;
  }

  return `
    ${notice(`导入完成：新增 <strong>${target.create}</strong> 人，更新 <strong>${target.update}</strong> 人，跳过 <strong>${target.skip}</strong> 条。`, target.create + target.update ? 'green' : 'warn', 'i-check')}
    <div class="card tight">
      <div class="small" style="line-height:1.7">
        匹配规则：<br/>
        1. 优先用会员 ID 精确匹配<br/>
        2. 没有 ID 时用手机号匹配<br/>
        3. 只有远端给了值的字段才会被写入，本地的跟进记录、目标、顾虑、备注永远不被覆盖<br/>
        4. 导入的数据会标记来源为「${esc(getProvider(providerId).name)} 同步」，同步时间记在当前
      </div>
    </div>
    <div class="btn-row">
      <button class="btn ghost" data-imp-again>再导入一次</button>
    </div>`;
}

/* ============================================================
   设置
   ============================================================ */
/* 主体色彩。两套，不多给第三套 —— 颜色选项一旦变多，
   每加一个组件就要为新主题再验一遍对比度，迟早会漏。 */
const THEME_OPTIONS = [
  { id: 'brand', label: '品牌绿' },
  { id: 'mono', label: '黑白基础版' },
];

export function openSettingsSheet(ctx) {
  const s = ctx.state.settings;
  const curTheme = THEME_OPTIONS.some((t) => t.id === s.theme) ? s.theme : 'brand';
  openSheet({
    title: '设置',
    size: 'tall',
    body: `
      ${field({ label: '你的名字 / 花名', name: 'advisor', value: s.advisor, hint: '会出现在预约的负责人、默认归属里' })}
      ${field({ label: '门店名称', name: 'store', value: s.store })}
      ${selectField({ label: '你的岗位', name: 'role', value: s.role, options: ['销售顾问', '会籍主管', '店长', '教练', '其他'] })}
      ${field({ label: '入行时间', name: 'onboardAt', value: s.onboardAt, type: 'date', hint: '用来估算你处在学习框架的哪个阶段' })}

      <div class="section-title">外观</div>
      <div class="card tight">
        <div class="small muted" style="line-height:1.6;margin-bottom:10px">
          主体色彩只有两套。黑白基础版把品牌色和全部语义色压成黑灰阶，
          紧急度改由明度分档承担：黑是要动作 / 已流失，深灰是需干预，浅灰是中性。去掉颜色，信息量不减。
        </div>
        <div class="chips">
          ${THEME_OPTIONS.map((t) => `
            <button class="chip ${curTheme === t.id ? 'on' : ''}" data-theme-pick="${t.id}">
              <span class="sw ${t.id}"></span>${esc(t.label)}
            </button>`).join('')}
        </div>
      </div>

      <div class="section-title">数据</div>
      <div class="card tight">
        ${kvRow('会员档案', `${ctx.state.members.length} 人`)}
        ${kvRow('跟进记录', `${ctx.state.followups.length} 条`)}
        ${kvRow('预约', `${ctx.state.appointments.length} 条`)}
        ${kvRow('存放位置', '<span class="small muted">本机浏览器本地存储（已加密），不上传任何服务器</span>')}
        ${kvRow('最近保存', (s.updatedAt || '').slice(0, 16).replace('T', ' '))}
      </div>
      <div class="btn-row">
        <button class="btn ghost" data-act="export"><svg viewBox="0 0 24 24"><use href="#i-download"/></svg>导出备份</button>
        <button class="btn ghost" data-act="import"><svg viewBox="0 0 24 24"><use href="#i-upload"/></svg>导入</button>
      </div>
      <div class="section-title">隐私与合规</div>
      <div class="card tight">
        <div class="small muted" style="line-height:1.6;margin-bottom:10px">
          会员个人信息与健康数据已加密存于本机。向第三方模型发送数据前会要求你单独确认，并可随时撤回同意、清除全部本地数据。
        </div>
        <button class="btn ghost" data-act="privacy"><svg viewBox="0 0 24 24"><use href="#i-key"/></svg>隐私与数据处理说明</button>
      </div>
      <div class="section-title">危险操作</div>
      <div class="btn-row">
        <button class="btn ghost" data-act="reset-demo">恢复示例数据</button>
        <button class="btn danger" data-act="wipe">清空全部数据</button>
      </div>
      <div class="hint" style="margin-top:8px">清空后不可恢复，建议先导出备份。</div>
    `,
    footer: `<button class="btn ghost" data-sheet-close>取消</button><button class="btn primary" data-save>保存设置</button>`,
    onMount(el, close) {
      el.addEventListener('click', (e) => {
        /* 主题点了立刻生效：抽屉本身也在 DOM 里，不用关掉就能看见效果 */
        const th = e.target.closest('[data-theme-pick]');
        if (th) {
          el.querySelectorAll('[data-theme-pick]').forEach((b) => b.classList.toggle('on', b === th));
          ctx.saveSettings({ theme: th.dataset.themePick });
          return;
        }

        const a = e.target.closest('[data-act]');
        if (!a) return;
        if (a.dataset.act === 'privacy') return openPrivacySheet();
        if (a.dataset.act === 'export') return ctx.exportData();
        if (a.dataset.act === 'import') return ctx.openImport();
        if (a.dataset.act === 'reset-demo') {
          return confirmDialog({
            title: '恢复示例数据', message: '当前所有会员与记录会被替换成示例数据。确认吗？',
            confirmText: '恢复', danger: true,
            onConfirm() { resetDemo(); close(); toast('已恢复示例数据'); },
          });
        }
        if (a.dataset.act === 'wipe') {
          return confirmDialog({
            title: '清空全部数据',
            message: '会员、跟进、预约、社群、线索、学习进度全部清空，<strong>不可恢复</strong>。建议先导出备份。',
            confirmText: '确认清空', danger: true,
            onConfirm() { clearAll(); close(); toast('已清空，现在是干净的工作台'); },
          });
        }
      });
      el.querySelector('[data-save]').onclick = () => {
        const f = serialize(el);
        ctx.saveSettings({ advisor: f.advisor, store: f.store, role: f.role, onboardAt: f.onboardAt });
        toast('设置已保存');
        close();
      };
    },
  });
}
