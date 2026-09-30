/* 预览生成：围绕「AI 接口总开关」重构，渲染所有层级交互，生成自包含 preview-aiportal.html
   （内联 SVG sprite，链接 styles.css）。同时充当渲染冒烟：undefined / NaN / [object Object] / 横线 判失败。
   层级：
     0 顶栏星星 UI（含 AI 接口总开关入口按钮，静态示意）
     1 AI 接口总开关详情页（模型下拉 + Key + Endpoint + 保存 + 打开豆包 + 模型市场）
     2 三处功能模块的调用卡片（AI 任务包 / 会面转写 / 云端润色）现均读中央配置
     3 模型市场（总开关内嵌的可调用模型清单） */

import { readFileSync, writeFileSync } from 'node:fs';

const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });

const store = await import('./js/store.js');
const sheets = await import('./js/sheets.js');
const aiMat = await import('./js/aiMaterial.js');
const models = await import('./js/models.js');

await store.init();
await models.initKeys();
/* 预填一个演示密钥，展示总开关「已配置」态（演示值，非真实） */
models.saveKey('deepseek', 'sk-DEMO-ONLY-0000', '');

const base = store.get();
const ctx = { state: { ...base, settings: { ...base.settings, ai: { activeModelId: 'deepseek' } } }, refresh() {} };

/* ---------- 渲染各层级 ---------- */
const portal = sheets.aiPortalBody(ctx);                       /* 层级 1：总开关详情页 */
const callSec = sheets.renderModelCallSection(ctx);            /* 层级 2a：AI 任务包调用卡片 */
const callBar = aiMat.renderModelCallBar(ctx);                 /* 层级 2b：会面转写调用条 */
const market = sheets.renderModelMarket();                    /* 层级 3：模型市场 */

/* 层级 0：顶栏星星 UI 静态示意（renderHeader 依赖 DOM，此处复刻 hd-actions 结构，标注入口位置） */
const hdrDemo = `
<div class="hd-demo">
  <div class="hd-mark-flat">F</div>
  <button class="bubble on"><svg viewBox="0 0 24 24"><use href="#i-spark"/></svg></button>
  <div class="hd-panel on">
    <div class="hd-row">
      <div class="logo-mark">F</div>
      <div class="hd-main">
        <div class="hd-title"><span class="wordmark">FitFlow</span></div>
        <div class="hd-sub"><span>客户与会籍</span><span>·</span><span>${store.get().settings.store}</span></div>
      </div>
      <div class="hd-actions">
        <button class="icon-btn" title="AI 任务包"><svg viewBox="0 0 24 24"><use href="#i-spark"/></svg></button>
        <button class="icon-btn accent" title="立即运行智能体"><svg viewBox="0 0 24 24"><use href="#i-sync"/></svg></button>
        <button class="icon-btn hi" title="AI 接口总开关" style="outline:2px solid var(--brand-2)"><svg viewBox="0 0 24 24"><use href="#i-plug"/></svg></button>
        <button class="icon-btn" title="个人设置"><svg viewBox="0 0 24 24"><use href="#i-settings"/></svg></button>
      </div>
    </div>
  </div>
</div>`;

const html = readFileSync('./index.html', 'utf8');
const sprite = html.match(/<svg width="0"[\s\S]*?<\/svg>/)[0];

const doc = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>FitFlow · AI 接口总开关 交互预览</title>
<link rel="stylesheet" href="./styles.css">
<style>
  body{background:#f4f6f5;margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:980px;margin:0 auto;padding:22px 18px 80px}
  .pv-h1{font-size:20px;margin:0 0 4px;color:#0A6E46}
  .pv-sub{color:#6B7B74;font-size:13px;margin:0 0 18px;line-height:1.6}
  .pv-sec{background:#fff;border:1px solid #e4eae7;border-radius:14px;padding:16px;margin:14px 0;box-shadow:0 1px 3px rgba(16,40,30,.05)}
  .pv-h2{font-size:15px;margin:0 0 4px}
  .pv-p{color:#6B7B74;font-size:12.5px;margin:0 0 12px;line-height:1.7}
  .pv-lvl{display:inline-block;font-size:11px;font-weight:700;color:#0A6E46;background:#E6F4EC;border:1px solid #CFE9DB;border-radius:6px;padding:1px 7px;margin-right:8px}
  .pv-tip{font-size:12px;color:#0A6E46;background:#E6F4EC;border:1px solid #CFE9DB;border-radius:8px;padding:8px 10px;margin-bottom:12px;line-height:1.7}
  .sheet-frame{background:#fff;border:1px solid #e4eae7;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(16,40,30,.05)}
  /* 顶栏示意 */
  .hd-demo{display:flex;align-items:center;gap:14px;background:#0A2A1C;padding:12px 16px;border-radius:12px}
  .hd-mark-flat{width:34px;height:34px;border-radius:9px;background:#0A6E46;color:#fff;display:grid;place-items:center;font-weight:800}
  .hd-demo .bubble{width:34px;height:34px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#eafff4;display:grid;place-items:center}
  .hd-demo .hd-panel{display:flex;align-items:center;gap:14px;flex:1}
  .hd-demo .logo-mark{width:30px;height:30px;border-radius:8px;background:#0A6E46;color:#fff;display:grid;place-items:center;font-weight:800;font-size:14px}
  .hd-demo .hd-main{flex:1;color:#eafff4}
  .hd-demo .hd-title .wordmark{font-weight:800;color:#fff}
  .hd-demo .hd-sub{font-size:12px;color:#9fd3bd;display:flex;gap:6px}
  .hd-demo .hd-actions{display:flex;gap:8px}
  .hd-demo .icon-btn{width:34px;height:34px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#eafff4;display:grid;place-items:center}
  .hd-demo .icon-btn.hi{color:#0A6E46;background:#fff}
  .hd-demo svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8}
</style></head>
<body><div class="wrap">
  <h1 class="pv-h1">FitFlow · AI 接口总开关 · 交互预览</h1>
  <p class="pv-sub">所有 AI 功能（任务包调用 / 会面转写 / 云端润色）统一读「AI 接口」总开关的激活模型与密钥，不再在各界面单独登记。点击下方各层级查看。</p>

  <div class="pv-sec">
    <h2 class="pv-h2"><span class="pv-lvl">层级 0</span>顶栏星星 UI · 入口位置</h2>
    <p class="pv-p">点顶栏星标展开下拉面板，在「立即运行智能体（刷新）」与「个人设置」之间新增了<b>AI 接口总开关</b>按钮（插头图标，已高亮）。点击进入总开关详情页。</p>
    ${hdrDemo}
  </div>

  <div class="pv-sec">
    <h2 class="pv-h2"><span class="pv-lvl">层级 1</span>AI 接口总开关详情页</h2>
    <p class="pv-p">唯一登记入口：切换激活模型、填 API Key（仅存本机）、自定义 Endpoint（留空用默认）、保存、一键打开豆包。下方内嵌模型市场。</p>
    <div class="sheet-frame">${portal}</div>
  </div>

  <div class="pv-sec">
    <h2 class="pv-h2"><span class="pv-lvl">层级 2a</span>AI 任务包 · 调用卡片</h2>
    <p class="pv-p">原「选模型 + 填 Key」区块已移除，改为只读中央配置、直接调用当前接口，并引导去总开关。</p>
    <div class="sheet-frame">${callSec}</div>
  </div>

  <div class="pv-sec">
    <h2 class="pv-h2"><span class="pv-lvl">层级 2b</span>会面转写 · 调用条</h2>
    <p class="pv-p">会面转写不再内嵌模型下拉与 Key，统一读总开关配置。</p>
    <div class="sheet-frame">${callBar}</div>
  </div>

  <div class="pv-sec">
    <h2 class="pv-h2"><span class="pv-lvl">层级 2c</span>云端润色（触达台）</h2>
    <p class="pv-p">触达台「用大模型润色」走 <code>polishOnline()</code>，现已从旧的 <code>settings.ai.{endpoint,apiKey}</code> 改为 <code>activeModelConfig(ctx)</code>：<code>fetch(base + '/chat/completions')</code> + <code>Bearer ${'{key}'}</code> + <code>model.apiModel</code>。未配置时如实返回「未配置调用地址 / API Key」，不填推测值。该层复用层级 1 的总开关，无独立登记界面。</p>
  </div>

  <div class="pv-sec">
    <h2 class="pv-h2"><span class="pv-lvl">层级 3</span>模型市场（总开关内嵌）</h2>
    <p class="pv-p">总开关详情页内复用模型市场，列出全部国内可直连模型、单价、接入难易：</p>
    ${market}
  </div>
</div>
${sprite}
</body></html>`;

writeFileSync('./preview-aiportal.html', doc, 'utf8');

/* ---------- 冒烟校验 ---------- */
const t = doc.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
let fail = 0;
for (const [name, re] of [['undefined', /undefined/], ['NaN', /NaN/], ['[object Object]', /\[object Object\]/]]) {
  if (re.test(t)) { fail++; console.log('FAIL 出现 ' + name); }
}
if (/[\u2014]/.test(t)) { fail++; console.log('FAIL 用户可见文案出现 em-dash（——）'); }
const must = (c, m) => { if (!c) { fail++; console.log('FAIL ' + m); } else console.log('OK   ' + m); };
must(/AI 接口总开关/.test(doc), '含总开关标题');
must(/激活模型/.test(doc) && /API Key/.test(doc), '总开关含模型下拉与 Key 输入');
must(/打开豆包/.test(doc), '总开关含打开豆包入口');
must(/去 AI 接口总开关/.test(doc), '功能卡片含「去总开关」引导');
must(/调用模型/.test(callSec), 'AI 任务包卡片含调用按钮');
must(/当前接口/.test(callSec), 'AI 任务包卡片显示当前接口');
must(/i-plug/.test(doc), '顶栏示意含插头图标');
must(/调用代价/.test(doc) && /接入难易程度/.test(doc), '模型市场含代价与难易标题');
console.log(fail ? `\\n预览生成失败：${fail} 项` : '\\n预览生成成功 → preview-aiportal.html');
process.exit(fail ? 1 : 0);
