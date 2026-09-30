/* ============================================================
   js/screenRenderer.js · 网页版渲染器（screen.json → HTML）
   ------------------------------------------------------------
   与 figma/plugin/code.js 的 buildNode 保持同一套节点语义：
   - type: 'text' | 'rect' | 'frame'
   - frame: layout 'H'|'V'、gap、pad、w/h、fill/stroke、radius、clip
   - text: text、size、weight、fill、lineHeight
   - 颜色一律用 design-tokens.json 里的 token 名（brand/ink/surface/...），
     渲染时经 COLORS 表解析成真实色值；未知 token 原样透传（当作已是色值）。

   浏览器与 Node 双端可运行（不依赖 DOM）。供 editor.html 预览，
   与 Figma 插件共用同一份 customer-management.screen.json 节点树。
   ============================================================ */

export const COLORS = {
  brand: '#0E8F5B', 'brand-2': '#0A6E46', 'brand-tint': '#E6F4EC', 'brand-tint-2': '#CFE9DB',
  ink: '#0F1A17', 'ink-2': '#39463F', 'ink-3': '#55635C', 'ink-4': '#6A7871',
  surface: '#FFFFFF', 'surface-2': '#F7FAF8', 'surface-3': '#F1F5F2',
  line: '#E2E9E4', 'line-2': '#EFF4F0',
  warn: '#9A5B00', 'warn-tint': '#FCF2E1', danger: '#B93B2C', 'danger-tint': '#FBECE9',
};

/* 权重档位 → CSS font-weight */
const WEIGHT = { 400: 400, 500: 500, 600: 600, 650: 600, 700: 700, 750: 700 };

function resolveColor(c) {
  if (!c || c === 'transparent') return null;
  return COLORS[c] ?? c; // token 命中取色值；否则原样（已含 # 的色值）
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* 文本节点 → 单行 span/div */
function renderText(n, path) {
  const color = resolveColor(n.fill);
  const size = n.size || 13;
  const weight = WEIGHT[n.weight] || 400;
  const lh = n.lineHeight ? `line-height:${n.lineHeight}px;` : '';
  const style = `font-size:${size}px;font-weight:${weight};${color ? `color:${color};` : ''}${lh}`;
  return `<span class="sn" data-path="${path}" data-type="text" style="${style}">${esc(n.text)}</span>`;
}

/* rect 节点 → div（用于进度条、色块） */
function renderRect(n, path) {
  const fill = resolveColor(n.fill);
  const style = [
    `width:${n.w || 100}px`, `height:${n.h || 20}px`,
    fill ? `background:${fill};` : '',
    n.radius ? `border-radius:${n.radius}px;` : '',
  ].join('');
  return `<div class="sn" data-path="${path}" data-type="rect" style="${style}"></div>`;
}

/* frame 节点 → 容器 div，递归渲染子节点 */
function renderFrame(n, path) {
  const fill = resolveColor(n.fill);
  const stroke = resolveColor(n.stroke);
  const isCol = n.layout === 'H';
  const style = [
    n.w ? `width:${n.w}px;` : '',
    fill ? `background:${fill};` : '',
    stroke ? `border:1px solid ${stroke};` : '',
    n.radius ? `border-radius:${n.radius}px;` : '',
    isCol || n.layout ? `display:flex;flex-direction:${isCol ? 'row' : 'column'};` : '',
    n.gap ? `gap:${n.gap}px;` : '',
    n.pad ? `padding:${n.pad}px;` : '',
    n.clip ? 'overflow:hidden;' : '',
  ].join('');
  const children = (n.children || [])
    .map((c, i) => renderNode(c, `${path}.${i}`)).join('');
  return `<div class="sn" data-path="${path}" data-type="frame" data-name="${esc(n.name || '')}" style="${style}">${children}</div>`;
}

/* 分发 */
export function renderNode(n, path = 'frame') {
  if (!n) return '';
  if (n.type === 'text') return renderText(n, path);
  if (n.type === 'rect') return renderRect(n, path);
  return renderFrame(n, path);
}

/* 顶层入口：把 screen.json 整体渲染成一个页面容器 */
export function renderScreen(screen) {
  const frame = screen && screen.frame;
  if (!frame) return '<div class="sn-empty">（空设计稿）</div>';
  return renderNode(frame, 'frame');
}
