#!/usr/bin/env node
/* ============================================================
   server/proxy.mjs · 对接代理（本地进程版，零依赖）
   ------------------------------------------------------------
   与线上部署共用同一份逻辑：server/_core.mjs
     本地   本文件：node server/proxy.mjs（127.0.0.1:8787）
     线上   Vercel Serverless：api/health.js、api/proxy/[provider].js
   两边路径一致，前端「代理地址」填
     http://localhost:8787        走本地
     https://<你的域名>/api       走线上
   除此之外前端不用改任何代码。

   为什么需要它：
     1. 浏览器直连三体 / 勤鸟 / 红狐都会被 CORS 拦掉
     2. appSecret、API Key 这类密钥绝对不能出现在前端代码里
     3. 勤鸟等厂商的签名算法在 Node 侧实现更安全、也更好改

   启动（按需注入，没配的会保持"待授权"状态）：
     SANTI_GATEWAY_KEY=xxx  QINNIAO_APP_KEY=xxx  QINNIAO_APP_SECRET=xxx \
     REDFOX_API_KEY=ak_xxx \
       node server/proxy.mjs

   线上必配（否则等于把三体会员数据公开）：
     PROXY_ACCESS_TOKEN=自定义口令   调用方要带 X-Proxy-Token
     ALLOWED_ORIGINS=https://你的域名

   自检：
     curl http://localhost:8787/health

   调用（前端就是这么调的）：
     curl -X POST http://localhost:8787/proxy/santi \
       -H 'Content-Type: application/json' \
       -d '{"resource":"followHistory","method":"POST","path":"/api/gateway",
            "body":{"method":"member.follow-history","timestamp":1700000000,"params":{"keyword":"13800138000"}}}'
   ============================================================ */
import { createServer } from 'node:http';
import {
  buildProviders, healthPayload, proxyCall, corsHeaders, checkAccess, readPayload,
} from './_core.mjs';

const PORT = Number(process.env.PORT || 8787);

/* 兼容旧环境变量 CORS_ORIGIN：没设 ALLOWED_ORIGINS 时沿用 */
if (!process.env.ALLOWED_ORIGINS && process.env.CORS_ORIGIN) {
  process.env.ALLOWED_ORIGINS = process.env.CORS_ORIGIN;
}

function send(res, status, payload, cors) {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...cors,
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      const parsed = readPayload(raw);
      if (parsed === null) return reject(new Error('请求体不是合法 JSON'));
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  /* 访问控制：本地默认不设口令；设了 PROXY_ACCESS_TOKEN 就必须带 X-Proxy-Token */
  const gate = checkAccess(req.headers, process.env, { origin });
  if (!gate.ok) return send(res, gate.status, gate.body, cors);

  /* ---- 健康检查：前端用它判断"代理起了没 / 密钥配了没" ---- */
  if (url.pathname === '/health') {
    if (req.method !== 'GET') return send(res, 405, { error: '请用 GET' }, cors);
    return send(res, 200, healthPayload(process.env), cors);
  }

  /* ---- 转发 ---- */
  const m = url.pathname.match(/^\/proxy\/([a-z0-9_-]+)$/i);
  if (!m) return send(res, 404, { error: '未定义的路径，可用：GET /health 或 POST /proxy/:provider' }, cors);
  if (req.method !== 'POST') return send(res, 405, { error: '请用 POST' }, cors);

  let payload;
  try { payload = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }, cors); }

  const out = await proxyCall(m[1], payload, process.env);
  return send(res, out.status, out.body, cors);
});

server.listen(PORT, '127.0.0.1', () => {
  const providers = buildProviders(process.env);
  console.log(`\nFitFlow 对接代理已启动： http://127.0.0.1:${PORT}`);
  console.log('  健康检查      GET  /health');
  console.log('  转发          POST /proxy/:provider');
  console.log('  线上同款      https://<你的域名>/api/health');
  console.log('');
  const line = (id, p) => {
    const kind = p.kind === 'content' ? '[内容]' : '[经营]';
    console.log(`  ${kind} ${p.label.padEnd(6, ' ')} ${p.configured ? '密钥已配置' : '未配置（保持"待授权"状态）'}   ${p.baseUrl || '(未设置)'}`);
  };
  Object.entries(providers).filter(([, p]) => p.kind !== 'content').forEach(([id, p]) => line(id, p));
  Object.entries(providers).filter(([, p]) => p.kind === 'content').forEach(([id, p]) => line(id, p));

  if (!process.env.PROXY_ACCESS_TOKEN) {
    console.log('\n  提醒：未设置 PROXY_ACCESS_TOKEN，任何能访问本机 8787 端口的程序都能调用本代理。');
  }
  console.log('  提醒：接口路径与字段名必须先用官方文档核对，核对前不要打开同步开关。\n');
});

process.on('SIGINT', () => { console.log('\n已停止代理。'); process.exit(0); });
