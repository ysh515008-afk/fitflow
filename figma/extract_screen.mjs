/* ============================================================
   figma/extract_screen.mjs
   ------------------------------------------------------------
   从真实代码 / 数据层抽取「客户管理」界面，生成 figma 插件可重建的
   customer-management.screen.json。运行：node figma/extract_screen.mjs

   机制：store.init() 用空 localStorage 垫片加载示例数据（buildSeed + migrate），
   之后所有口径计算与节点树构建都走 js/views/customer-management.screen-spec.js，
   数字全部由 state 实时算出来 —— 不再有任何写死的样本值。
   ============================================================ */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// —— 最小浏览器全局垫片：仅让 app 数据层在 Node 里能加载，不触碰 UI ——
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.window = globalThis;
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {} }),
  addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], body: { contains: () => false },
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

const __dirname = dirname(fileURLToPath(import.meta.url));

const store = await import('../js/store.js');
const { buildCustomerManagementScreen } = await import('../js/views/customer-management.screen-spec.js');

await store.init();
const state = store.getState();
if (!state) throw new Error('store.init() 未产出 state，提取中止');

const screen = buildCustomerManagementScreen(state);
const outPath = join(__dirname, 'customer-management.screen.json');
writeFileSync(outPath, JSON.stringify(screen, null, 2) + '\n', 'utf8');

const cols = screen.frame.children[2].children.length;
console.log(`screen.json 已生成：${outPath}`);
console.log(`会员池 ${state.members.length} 人 · 四栏已生成 · 顶层节点数 ${cols}`);
