/* 离线校验模型界面的「渲染产物」：不依赖浏览器，直接检查纯渲染函数输出。
   浏览器 headless 在本机对 ES module 的捕获时序不稳，改走这条确定性路径。 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const sheets = await import('./js/sheets.js');
const { MODELS } = await import('./js/models.js');

let fail = 0;
const must = (c, m) => { if (!c) { fail++; console.log('FAIL ' + m); } else console.log('OK   ' + m); };
const dirty = (h) => /undefined|NaN|\[object Object\]/.test(h.replace(/<[^>]+>/g, ' '));

/* 1) 模型市场：全部模型 + 代价 + 难度 都在 */
const html = sheets.renderModelMarket();
must(MODELS.every((m) => html.includes(m.name)), '模型市场含全部 ' + MODELS.length + ' 个模型名');
must(html.includes('调用代价') && html.includes('接入难易程度'), '含「调用代价」「接入难易程度」标题');
must(html.includes('成本') && html.includes('免费额度'), '含成本档徽章与免费额度');
must(html.includes('diff-meter') && html.includes('dm-seg'), '含难度刻度条（5 段）');
must(MODELS.every((m) => html.includes('¥' + m.input) && html.includes('¥' + m.output)), '每个模型都标了输入/输出单价');
must(!dirty(html), '模型市场无 undefined/NaN/[object Object] 脏值');

/* 2) AI 话术里的「选模型直接调用」区块：统一读中央「AI 接口」总开关，不再内嵌输入 */
const ctxSec = { state: { settings: { ai: { activeModelId: 'deepseek' } } } };
const sec = sheets.renderModelCallSection(ctxSec);
must(sec.includes('ai-master-card'), '含中央配置卡片（无内嵌模型/密钥输入）');
must(sec.includes('data-call') && sec.includes('data-ai-portal'), '含「调用模型」「去 AI 接口总开关」按钮');
must(sec.includes('DeepSeek'), '激活 deepseek 时显示 DeepSeek 为当前接口');
must(!sec.includes('id="aiModel"') && !sec.includes('id="aiKey"'), '已移除分散的模型下拉与 API Key 输入');
must(!dirty(sec), '调用区块无脏值');

/* 3) 激活非法模型时优雅回退到豆包，不残留 undefined */
const ctxBad = { state: { settings: { ai: { activeModelId: 'not-a-model' } } } };
const sec2 = sheets.renderModelCallSection(ctxBad);
must(!/undefined/.test(sec2), '非法激活模型不残留 undefined');
must(sec2.includes('豆包'), '非法激活模型回退到豆包');

console.log('\n' + (fail ? `共 ${fail} 项异常` : '全部通过 ✓'));
process.exit(fail ? 1 : 0);
