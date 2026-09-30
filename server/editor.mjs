#!/usr/bin/env node
/* ============================================================
   server/editor.mjs · 网页版可视化编辑器本地服务（零依赖）
   ------------------------------------------------------------
   制作者不用 Figma，在浏览器里直接改客户管理设计稿，改动即时
   呈现网页版视觉；保存时写回 customer-management.screen.json，
   并重新生成 figma/plugin/code.js，回 Figma 点「运行」即可刷新。

   启动：  node server/editor.mjs         （默认端口 8788）
   打开：  http://127.0.0.1:8788/editor.html

   接口：
     GET  /screen.json   返回 { screen, frame, tokens }（节点树 + 颜色 token）
     POST /save          请求体 = 编辑后的 { screen, frame }，写回并重新生成 code.js
     GET  /...           其余路径按静态文件从项目根提供（editor.html / js/ 等）
   ============================================================ */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { buildCodeJs, TOKENS } from '../figma/build_code.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = Number(process.env.PORT || 8788);
const SCREEN_PATH = join(ROOT, 'figma', 'customer-management.screen.json');
const CODE_PATH = join(ROOT, 'figma', 'plugin', 'code.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function readScreen() {
  const raw = readFileSync(SCREEN_PATH, 'utf8');
  return JSON.parse(raw);
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(); return; }

  /* 数据接口 */
  if (req.method === 'GET' && pathname === '/screen.json') {
    const screen = readScreen();
    return send(res, 200, JSON.stringify({ ...screen, tokens: TOKENS }));
  }

  if (req.method === 'POST' && pathname === '/save') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5_000_000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data || !data.frame) return send(res, 400, JSON.stringify({ ok: false, error: '缺少 frame 节点树' }));
        /* 写回 screen.json（保留 tokens 不入库） */
        const { tokens, ...screen } = data;
        writeFileSync(SCREEN_PATH, JSON.stringify(screen, null, 2) + '\n', 'utf8');
        /* 重新生成 code.js */
        const code = buildCodeJs(screen);
        writeFileSync(CODE_PATH, code, 'utf8');
        send(res, 200, JSON.stringify({ ok: true, bytes: code.length, screen: screen.screen }));
      } catch (e) {
        send(res, 500, JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  /* 静态文件（限制在项目根内，防目录穿越） */
  let fp = pathname === '/' ? '/editor.html' : pathname;
  let full = normalize(join(ROOT, fp));
  if (!full.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain');
  if (!existsSync(full) || !statSync(full).isFile()) return send(res, 404, 'not found: ' + fp, 'text/plain');
  const ext = extname(full).toLowerCase();
  send(res, 200, readFileSync(full), MIME[ext] || 'application/octet-stream');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`FitFlow 网页版可视化编辑器已启动：http://127.0.0.1:${PORT}/editor.html`);
  console.log(`数据源：${SCREEN_PATH}`);
});
