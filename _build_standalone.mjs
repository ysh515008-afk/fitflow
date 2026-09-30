/* ============================================================
   _build_standalone.mjs —— 生成自包含单文件 fitflow-standalone.html
   ------------------------------------------------------------
   为什么要它：智能体沙箱里起的 http://127.0.0.1:xxxx 用户面板跨不过网络边界，
   只有「本地文件路径」能送达。自包含单文件无任何相对/外链引用，file:// 也能跑。

   为什么要 nonce：try.html 现在带严格 CSP（script-src 'self'，不放开 unsafe-inline）。
   单文件把 app.js 内联成一个 <script>，那种内联脚本会被严格 CSP 拦掉。
   所以本脚本在构建时先生成一个随机 nonce，把它同时写进：
     ① CSP 的 script-src（script-src 'self' 'nonce-XXXX'）
     ② 内联 <script> 的 nonce 属性
   这样单文件在保留 CSP 的同时，只放行这一个自带 nonce 的脚本。

   用法：node _build_standalone.mjs
   ============================================================ */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const esbuild = require('/Users/aritya/.workbuddy/binaries/node/workspace/node_modules/esbuild');

const result = await esbuild.build({
  entryPoints: [path.join(ROOT, 'js/app.js')],
  bundle: true,
  format: 'iife',
  write: false,
  platform: 'browser',
  minify: true,
  logLevel: 'info',
});

/* 内联脚本里若出现字面量 </script> 会提前闭合标签；统一转义为 <\/script> */
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
let html = fs.readFileSync(path.join(ROOT, 'try.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

const nonce = randomBytes(16).toString('base64');

/* ① 把 CSP 里的 script-src 扩成带 nonce（保留原策略其余部分） */
let cspPatched = false;
html = html.replace(
  /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/,
  (full, a, content, b) => {
    cspPatched = true;
    const next = content.includes("script-src 'self'")
      ? content.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`)
      : content + `; script-src 'nonce-${nonce}'`;
    return a + next + b;
  },
);
if (!cspPatched) console.warn('WARN: 未找到 CSP meta，单文件将不带 CSP');

/* ② 外链样式表 → 内联 */
html = html.replace(/<link\s+rel="stylesheet"\s+href="\.\/styles\.css"\s*\/?>/, `<style>\n${css}\n</style>`);

/* ③ 模块脚本 → 带 nonce 的内联 IIFE（file:// 无需 module 上下文） */
html = html.replace(
  /<script\s+type="module"\s+src="\.\/js\/app\.js"><\/script>/,
  `<script nonce="${nonce}">\n${js}\n</script>`,
);

const leftovers = ['./js/app.js', './styles.css'].filter((s) => html.includes(s));
if (leftovers.length) console.error('WARN: 仍有相对引用未替换：', leftovers.join(', '));

const out = path.join(ROOT, 'fitflow-standalone.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`written ${out}\nbytes=${html.length}  jsBytes=${js.length}  nonce=${nonce}`);
