#!/usr/bin/env node
/* ============================================================
   server/proxy.mjs · 对接代理（零依赖）
   ------------------------------------------------------------
   为什么需要它：
     1. 浏览器直连三体 / 勤鸟 / 红狐都会被 CORS 拦掉
     2. appSecret、API Key 这类密钥绝对不能出现在前端代码里
     3. 勤鸟等厂商的签名算法在 Node 侧实现更安全、也更好改

   启动（按需注入，没配的会保持"待授权"状态）：
     SANTI_GATEWAY_KEY=xxx  QINNIAO_APP_KEY=xxx  QINNIAO_APP_SECRET=xxx \
     REDFOX_API_KEY=ak_xxx \
       node server/proxy.mjs

   自检：
     curl http://localhost:8787/health

   调用（前端就是这么调的）：
     curl -X POST http://localhost:8787/proxy/redfox \
       -H 'Content-Type: application/json' \
       -d '{"resource":"account","method":"POST","path":"/story/api/dyUser/query","body":{"source":"FitFlow ","accountIds":["xxx"]}}'
   ============================================================ */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);
const DEBUG = process.env.DEBUG === '1';

/* ---------------- 各对接方的凭证与鉴权 ---------------- */

const PROVIDERS = {
  /* 三体：官方 AI 网关。
     协议已核实（官方技能包 santi v1.0.1）：
       POST /auth/key     body { key }             → access_token / refresh_token
       POST /auth/refresh body { refresh_token }   → 新 access_token
       POST /api/gateway  body { method, timestamp, params }
                          header Authorization: Bearer <token> / app-id / X-Request-ID
     网关 Key 只在本进程里，前端永远拿不到，也不出现在任何响应里。 */
  santi: {
    label: '三体云动',
    kind: 'gateway',
    baseUrl: process.env.SANTI_BASE_URL || 'https://ai-gateway.styd.cn',
    configured: Boolean(process.env.SANTI_GATEWAY_KEY),
    appId: process.env.SANTI_APP_ID || '10000',
    gatewayKey: process.env.SANTI_GATEWAY_KEY || '',
    businessPath: '/api/gateway',
    keyLoginPath: '/auth/key',
    refreshPath: '/auth/refresh',
    /** 进程内缓存：{ access, refresh, accessExp, refreshExp }，时间戳为毫秒 */
    token: null,
    envHint: '启动时设置 SANTI_GATEWAY_KEY（32 位，由管理员在 PC 端「员工账号管理」生成）',
  },
  qinniao: {
    label: '勤鸟',
    baseUrl: process.env.QINNIAO_BASE_URL || '',
    configured: Boolean(process.env.QINNIAO_APP_KEY && (process.env.QINNIAO_APP_SECRET || process.env.QINNIAO_TOKEN)),
    appKey: process.env.QINNIAO_APP_KEY || '',
    appSecret: process.env.QINNIAO_APP_SECRET || '',
    token: process.env.QINNIAO_TOKEN || '',
    /** A: md5Upper(secret + 排序 kv 串 + secret) ｜ B: md5Upper(appKey + timestamp + nonce + secret) */
    signMode: process.env.QINNIAO_SIGN_MODE || 'A',
    headers: {
      appKey: process.env.QINNIAO_H_APPKEY || 'appKey',
      timestamp: process.env.QINNIAO_H_TS || 'timestamp',
      nonce: process.env.QINNIAO_H_NONCE || 'nonce',
      sign: process.env.QINNIAO_H_SIGN || 'sign',
      token: process.env.QINNIAO_H_TOKEN || 'accessToken',
    },
  },
  /* 内容源：抖音 / 小红书。地址固定，不需要门店网关，鉴权就是一个 header。 */
  redfox: {
    label: '红狐数据',
    kind: 'content',
    baseUrl: process.env.REDFOX_BASE_URL || 'https://redfox.hk',
    configured: Boolean(process.env.REDFOX_API_KEY),
    apiKey: process.env.REDFOX_API_KEY || '',
    authHeader: process.env.REDFOX_AUTH_HEADER || 'X-API-KEY',   // 已实测确认
    envHint: '启动时设置 REDFOX_API_KEY（redfox.hk 个人中心获取，格式 ak_xxx）',
  },
};

/* ---------------- 工具 ---------------- */

const md5Upper = (s) => createHash('md5').update(s, 'utf8').digest('hex').toUpperCase();

/** 把参数按 key 升序拼成 k=v&k2=v2（勤鸟常见签名串） */
function sortedKv(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

function buildQuery(query) {
  const qs = new URLSearchParams();
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) qs.append(k, String(v));
  });
  const s = qs.toString();
  return s ? '?' + s : '';
}

const log = (...a) => { if (DEBUG) console.log('[proxy]', ...a); };
/** 日志里永远不打印密钥原文 */
const mask = (s) => (s ? s.slice(0, 4) + '****' + s.slice(-2) : '(未配置)');

/** 这个对接方用的是哪个密钥字段 */
const secretOf = (id, p) => {
  if (id === 'santi') return p.gatewayKey;
  if (id === 'qinniao') return p.appKey;
  if (id === 'redfox') return p.apiKey;
  return '';
};

/** 给人看的鉴权方式描述 */
function describeAuth(id, p) {
  if (id === 'santi') return `gateway-key → bearer(app-id ${p.appId})`;
  if (id === 'qinniao') return p.token ? 'access-token' : `appkey-secret(signMode ${p.signMode})`;
  if (id === 'redfox') return `api-key(${p.authHeader})`;
  return 'unknown';
}

/* ---------------- 三体：网关 Key → Bearer Token ---------------- */

/**
 * 拿到一个可用的 access_token。顺序固定：
 *   1. 缓存里没过期就直接复用
 *   2. 过期但 refresh_token 还有效 → /auth/refresh
 *   3. refresh 也过期或失败 → 用网关 Key 重新 /auth/key
 *
 * 失败原因如实往外抛，不包装成"可能是网络问题"这种含糊说法。
 */
async function santiAccessToken(p) {
  const now = Date.now();
  if (p.token && p.token.access && now < p.token.accessExp - 60_000) return p.token.access;

  if (p.token?.refresh && now < (p.token.refreshExp || 0) - 60_000) {
    try {
      const r = await fetch(p.baseUrl + p.refreshPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-ID': randomUUID() },
        body: JSON.stringify({ refresh_token: p.token.refresh }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.code === 0) {
        const d = j.data || {};
        if (d.access_token) {
          p.token = {
            access: d.access_token,
            refresh: d.refresh_token || p.token.refresh,
            accessExp: now + Number(d.expires_in || 7200) * 1000,
            refreshExp: p.token.refreshExp,
          };
          log('santi token refreshed');
          return p.token.access;
        }
      }
      log(`santi refresh 失败：HTTP ${r.status} code=${j?.code}`);
    } catch (e) {
      log(`santi refresh 异常：${e.message}`);
    }
  }

  /* 重新用网关 Key 登录 */
  if (!p.gatewayKey) throw new Error('未配置 SANTI_GATEWAY_KEY');
  const r = await fetch(p.baseUrl + p.keyLoginPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': randomUUID() },
    body: JSON.stringify({ key: p.gatewayKey }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`网关 Key 登录失败：HTTP ${r.status}`);
  if (!j || j.code !== 0) {
    /* 60105 = Key 无效或过期，是网关明确定义的错误码，原样报出去 */
    throw new Error(`网关 Key 登录失败：code=${j?.code} msg=${j?.msg || ''}`);
  }
  const d = j.data || {};
  if (!d.access_token) throw new Error('网关 Key 登录响应里没有 access_token');
  p.token = {
    access: d.access_token,
    refresh: d.refresh_token || '',
    accessExp: now + Number(d.expires_in || 7200) * 1000,
    /* 响应没给 refresh 有效期时按 7 天保守处理，到期后走 Key 重登 */
    refreshExp: d.refresh_expires_in
      ? now + Number(d.refresh_expires_in) * 1000
      : now + 7 * 24 * 3600 * 1000,
  };
  log('santi logged in by gateway key');
  return p.token.access;
}

/* ---------------- 鉴权头构造 ---------------- */

function authHeaders(id, p, { body, query }) {
  const ts = String(Date.now());
  const nonce = randomUUID().replace(/-/g, '').slice(0, 16);

  if (id === 'santi') {
    /* 三体不走这里：Bearer Token 由 santiAccessToken 异步换取（可能触发登录或刷新） */
    throw new Error('三体鉴权请走 santiAccessToken');
  }

  if (id === 'qinniao') {
    const h = { 'Content-Type': 'application/json' };
    if (p.token) {
      h[p.headers.token] = p.token;
      return h;                       // 若走 OAuth / accessToken 模式
    }
    h[p.headers.appKey] = p.appKey;
    h[p.headers.timestamp] = ts;
    h[p.headers.nonce] = nonce;
    h[p.headers.sign] = p.signMode === 'B'
      ? md5Upper(p.appKey + ts + nonce + p.appSecret)
      : md5Upper(p.appSecret + sortedKv({ ...(query || {}), ...(body || {}) }) + p.appSecret);
    return h;
  }

  if (id === 'redfox') {
    /* 红狐只需要一个固定 header，没有签名、没有时间戳。
       密钥只在本进程环境变量里，前端永远拿不到。 */
    return { 'Content-Type': 'application/json', [p.authHeader]: p.apiKey };
  }

  throw new Error('未知对接方：' + id);
}

/* ---------------- HTTP 服务 ---------------- */

function send(res, status, payload) {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
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
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') return send(res, 204, null);

  /* ---- 健康检查：前端用它判断"代理起了没 / 密钥配了没" ---- */
  if (url.pathname === '/health') {
    return send(res, 200, {
      ok: true,
      service: 'fitflow-proxy',
      providers: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, {
        label: p.label,
        kind: p.kind || 'gym',
        configured: p.configured,
        baseUrlSet: Boolean(p.baseUrl),
        authMode: describeAuth(id, p),
        keyPreview: mask(secretOf(id, p)),
      }])),
      hint: '未配置的对接方请在启动本进程时通过环境变量注入密钥。',
    });
  }

  /* ---- 转发 ---- */
  const m = url.pathname.match(/^\/proxy\/([a-z0-9_-]+)$/i);
  if (!m) return send(res, 404, { error: '未定义的路径，可用：GET /health 或 POST /proxy/:provider' });
  if (req.method !== 'POST') return send(res, 405, { error: '请用 POST' });

  const id = m[1].toLowerCase();
  const p = PROVIDERS[id];
  if (!p) return send(res, 404, { error: `未知对接方：${id}` });
  if (!p.configured) {
    return send(res, 401, {
      error: `unauthorized: ${p.label} 的密钥尚未配置`,
      detail: p.envHint || `启动时设置：${(p.authSpec?.envVars || []).join('、')}`,
    });
  }
  if (!p.baseUrl) {
    return send(res, 500, {
      error: `endpoint_unverified: 未配置 ${p.label} 的服务地址`,
      detail: `设置 ${id.toUpperCase()}_BASE_URL`,
    });
  }

  let payload;
  try { payload = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }

  const { resource, method = 'POST', path, query = {}, body = {} } = payload;
  if (!path) return send(res, 400, { error: '缺少 path' });

  const target = p.baseUrl.replace(/\/$/, '') + path + buildQuery(query);

  let headers;
  if (id === 'santi') {
    try {
      const token = await santiAccessToken(p);
      headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'app-id': p.appId,
        'X-Request-ID': randomUUID(),
      };
    } catch (e) {
      return send(res, 401, {
        error: `unauthorized: ${p.label} 鉴权失败：${e.message}`,
        detail: '确认 SANTI_GATEWAY_KEY 是 32 位网关 Key（PC 端员工账号管理生成）且未过期；默认有效期 90 天。',
      });
    }
  } else {
    try { headers = authHeaders(id, p, { body, query }); } catch (e) { return send(res, 500, { error: e.message }); }
  }

  const t0 = Date.now();
  log(`${id}.${resource} → ${method} ${target}`);

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    const text = await upstream.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 上游可能返回非 JSON */ }
    log(`${id}.${resource} ← ${upstream.status} (${Date.now() - t0}ms)`);

    return send(res, upstream.status, json ?? { raw: text.slice(0, 2000) });
  } catch (e) {
    const isTimeout = e.name === 'TimeoutError' || /timeout/i.test(e.message);
    log(`${id}.${resource} ✗ ${e.message}`);
    return send(res, 504, {
      error: isTimeout ? `network: ${p.label} 响应超时（${TIMEOUT}ms）` : `network: ${e.message}`,
      detail: '检查网络、服务地址与门店出口 IP 白名单（部分厂商要求加白）。',
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nFitFlow 对接代理已启动： http://127.0.0.1:${PORT}`);
  console.log('  健康检查      GET  /health');
  console.log('  转发          POST /proxy/:provider');
  console.log('');
  const line = (id, p) => {
    const kind = p.kind === 'content' ? '[内容]' : '[经营]';
    console.log(`  ${kind} ${p.label.padEnd(6, ' ')} ${p.configured ? '密钥已配置' : '未配置（保持"待授权"状态）'}   ${p.baseUrl || '(未设置)'}`);
  };
  Object.entries(PROVIDERS).filter(([, p]) => p.kind !== 'content').forEach(([id, p]) => line(id, p));
  Object.entries(PROVIDERS).filter(([, p]) => p.kind === 'content').forEach(([id, p]) => line(id, p));
  console.log('\n  提醒：接口路径与字段名必须先用官方文档核对，核对前不要打开同步开关。\n');
});

process.on('SIGINT', () => { console.log('\n已停止代理。'); process.exit(0); });
