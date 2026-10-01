/* ============================================================
   server/_core.mjs · 对接代理核心（零依赖，Node 18+）
   ------------------------------------------------------------
   同一份逻辑跑在两个地方：
     · 本地进程   server/proxy.mjs（node server/proxy.mjs，127.0.0.1:8787）
     · 线上函数   Vercel Serverless（api/health.js、api/proxy/[provider].js）
   核心只做四件事，不做 HTTP 监听，方便两边复用：
     1. 读环境变量，组装各对接方的凭证（密钥永远只在服务端进程里）
     2. 三体：网关 Key → Bearer Token（含 refresh 与门店切换）
     3. 按对接方构造鉴权头并转发请求
     4. 访问控制：来源白名单 + 访问口令（线上裸奔等于把三体会员手机号公开）

   环境变量（Vercel 后台 Project Settings → Environment Variables）：
     SANTI_GATEWAY_KEY    三体网关 Key（32 位，PC 端员工账号管理生成，90 天有效）
     SANTI_APP_ID         默认 10000
     SANTI_BASE_URL       默认 https://ai-gateway.styd.cn
     QINNIAO_APP_KEY / QINNIAO_APP_SECRET / QINNIAO_TOKEN / QINNIAO_BASE_URL
     REDFOX_API_KEY       红狐（ak_xxx）
     PROXY_ACCESS_TOKEN   线上建议必须设置：调用方要带 X-Proxy-Token 才能用
     ALLOWED_ORIGINS      逗号分隔的来源白名单，不设则回显请求 Origin
     UPSTREAM_TIMEOUT_MS  上游超时，默认 15000
     DEBUG                设为 1 打印转发日志（密钥不打印）
   ============================================================ */
import { createHash, randomUUID } from 'node:crypto';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const md5Upper = (s) => createHash('md5').update(s, 'utf8').digest('hex').toUpperCase();

/** 指纹只用于判断"凭证是否被换过"，不存密钥原文 */
const fingerprint = (...parts) => md5Upper(parts.join('|')).slice(0, 12);

const log = (...a) => { if (process.env.DEBUG === '1') console.log('[proxy]', ...a); };

/** 日志与响应里都不出现密钥原文 */
const mask = (s) => (s ? s.slice(0, 4) + '****' + s.slice(-2) : '(未配置)');

/* ---------------- 凭证装配 ---------------- */

export function buildProviders(env = process.env) {
  return {
    /* 三体：官方 AI 网关。
       协议（来源：三体官方技能包 santi v1.0.1，已逐条比对白名单）：
         POST /auth/key          body { key }            → access_token / refresh_token
         POST /auth/refresh      body { refresh_token }  → 新 access_token
         POST /auth/switch/shop  body { shop_id }        → 多门店账号切店（可能返回新 token）
         POST /api/gateway       header Authorization: Bearer <token> / app-id / X-Request-ID
                                 body { method, timestamp, params } */
    santi: {
      label: '三体云动',
      kind: 'gateway',
      baseUrl: env.SANTI_BASE_URL || 'https://ai-gateway.styd.cn',
      configured: Boolean(env.SANTI_GATEWAY_KEY),
      appId: env.SANTI_APP_ID || '10000',
      gatewayKey: env.SANTI_GATEWAY_KEY || '',
      businessPath: '/api/gateway',
      keyLoginPath: '/auth/key',
      refreshPath: '/auth/refresh',
      switchShopPath: '/auth/switch/shop',
      envHint: '设置 SANTI_GATEWAY_KEY（32 位，管理员在 PC 端「员工账号管理」生成，默认 90 天有效）',
    },

    qinniao: {
      label: '勤鸟',
      kind: 'gym',
      baseUrl: env.QINNIAO_BASE_URL || '',
      configured: Boolean(env.QINNIAO_APP_KEY && (env.QINNIAO_APP_SECRET || env.QINNIAO_TOKEN)),
      appKey: env.QINNIAO_APP_KEY || '',
      appSecret: env.QINNIAO_APP_SECRET || '',
      token: env.QINNIAO_TOKEN || '',
      /** A: md5Upper(secret + 排序 kv 串 + secret) ｜ B: md5Upper(appKey + timestamp + nonce + secret) */
      signMode: env.QINNIAO_SIGN_MODE || 'A',
      headers: {
        appKey: env.QINNIAO_H_APPKEY || 'appKey',
        timestamp: env.QINNIAO_H_TS || 'timestamp',
        nonce: env.QINNIAO_H_NONCE || 'nonce',
        sign: env.QINNIAO_H_SIGN || 'sign',
        token: env.QINNIAO_H_TOKEN || 'accessToken',
      },
      envHint: '设置 QINNIAO_APP_KEY 与 QINNIAO_APP_SECRET（或 QINNIAO_TOKEN），并配置 QINNIAO_BASE_URL',
    },

    /* 红狐：内容源（抖音 / 小红书），鉴权就是一个固定 header。 */
    redfox: {
      label: '红狐数据',
      kind: 'content',
      baseUrl: env.REDFOX_BASE_URL || 'https://redfox.hk',
      configured: Boolean(env.REDFOX_API_KEY),
      apiKey: env.REDFOX_API_KEY || '',
      authHeader: env.REDFOX_AUTH_HEADER || 'X-API-KEY',
      envHint: '设置 REDFOX_API_KEY（redfox.hk 个人中心获取，格式 ak_xxx）',
    },
  };
}

const secretOf = (id, p) => {
  if (id === 'santi') return p.gatewayKey;
  if (id === 'qinniao') return p.appKey;
  if (id === 'redfox') return p.apiKey;
  return '';
};

function describeAuth(id, p) {
  if (id === 'santi') return `gateway-key → bearer(app-id ${p.appId})`;
  if (id === 'qinniao') return p.token ? 'access-token' : `appkey-secret(signMode ${p.signMode})`;
  if (id === 'redfox') return `api-key(${p.authHeader})`;
  return 'unknown';
}

/* ---------------- 三体：Token 缓存与换取 ----------------
   Serverless 里每个实例有独立内存，缓存只在实例存活期内有效；
   冷启动或多实例并发时会各自登录一次，这是预期行为，不是故障。 */

const TOKEN_CACHE = new Map();   // id → { fp, access, refresh, accessExp, refreshExp, shopId }

function cacheEntry(id, p) {
  const fp = fingerprint(id, p.gatewayKey, p.appId, p.baseUrl);
  const hit = TOKEN_CACHE.get(id);
  if (hit && hit.fp === fp) return hit;
  /* 凭证变了，旧 token 立刻作废 */
  if (hit) log(`${id} 凭证已变更，丢弃旧 token`);
  const fresh = { fp, access: '', refresh: '', accessExp: 0, refreshExp: 0, shopId: '' };
  TOKEN_CACHE.set(id, fresh);
  return fresh;
}

async function postJson(url, body, extraHeaders = {}, env = process.env) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': randomUUID(), ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(num(env.UPSTREAM_TIMEOUT_MS, 15000)),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 上游返回非 JSON */ }
  return { status: r.status, ok: r.ok, json, text };
}

/**
 * 换取一个可用的 access_token。顺序固定，失败原因如实往外抛：
 *   1. 缓存未过期 → 直接复用
 *   2. refresh_token 仍有效 → /auth/refresh
 *   3. 都不行 → 用网关 Key 重新 /auth/key
 */
export async function santiAccessToken(p, env = process.env) {
  const now = Date.now();
  const c = cacheEntry('santi', p);

  if (c.access && now < c.accessExp - 60_000) return c.access;

  if (c.refresh && now < c.refreshExp - 60_000) {
    const r = await postJson(p.baseUrl + p.refreshPath, { refresh_token: c.refresh }, {}, env);
    const d = r.ok && r.json?.code === 0 ? (r.json.data || {}) : null;
    if (d?.access_token) {
      c.access = d.access_token;
      c.refresh = d.refresh_token || c.refresh;
      c.accessExp = now + Number(d.expires_in || 7200) * 1000;
      c.shopId = '';                       // 换 token 后门店上下文丢失，需要重新切店
      log('santi token refreshed');
      return c.access;
    }
    log(`santi refresh 失败：HTTP ${r.status} code=${r.json?.code}`);
  }

  if (!p.gatewayKey) throw new Error('未配置 SANTI_GATEWAY_KEY');

  const r = await postJson(p.baseUrl + p.keyLoginPath, { key: p.gatewayKey }, {}, env);
  if (!r.ok) throw new Error(`网关 Key 登录失败：HTTP ${r.status}`);
  if (!r.json || r.json.code !== 0) {
    /* 60105 = Key 无效或过期，是网关明确定义的错误码，原样报出去，不猜测 */
    throw new Error(`网关 Key 登录失败：code=${r.json?.code} msg=${r.json?.msg || ''}`);
  }
  const d = r.json.data || {};
  if (!d.access_token) throw new Error('网关 Key 登录响应里没有 access_token');

  c.access = d.access_token;
  c.refresh = d.refresh_token || '';
  c.accessExp = now + Number(d.expires_in || 7200) * 1000;
  /* 响应没给 refresh 有效期时按 7 天保守处理，到期后走 Key 重登 */
  c.refreshExp = d.refresh_expires_in ? now + Number(d.refresh_expires_in) * 1000 : now + 7 * 24 * 3600 * 1000;
  c.shopId = '';
  log('santi logged in by gateway key');
  return c.access;
}

/**
 * 多门店账号必须先切店，否则读到的是默认门店的数据。
 * 切换成功后把 shopId 记进缓存，同门店后续请求不重复切。
 */
export async function santiSwitchShop(p, shopId, env = process.env) {
  const c = cacheEntry('santi', p);
  if (String(shopId) === String(c.shopId)) return c.access;

  const token = await santiAccessToken(p, env);
  const r = await postJson(p.baseUrl + p.switchShopPath, { shop_id: shopId }, {
    Authorization: `Bearer ${token}`,
    'app-id': p.appId,
  }, env);
  if (!r.ok) throw new Error(`切换门店失败：HTTP ${r.status}`);
  if (!r.json || r.json.code !== 0) {
    throw new Error(`切换门店失败：code=${r.json?.code} msg=${r.json?.msg || ''}`);
  }
  const d = r.json.data || {};
  if (d.access_token) {
    c.access = d.access_token;
    c.accessExp = Date.now() + Number(d.expires_in || 7200) * 1000;
  }
  c.shopId = String(shopId);
  log(`santi switched shop → ${shopId}`);
  return c.access;
}

/* ---------------- 鉴权头 ---------------- */

function sortedKv(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

export function authHeaders(id, p, { body, query }) {
  const ts = String(Date.now());
  const nonce = randomUUID().replace(/-/g, '').slice(0, 16);

  if (id === 'santi') throw new Error('三体鉴权请走 santiAccessToken');

  if (id === 'qinniao') {
    const h = { 'Content-Type': 'application/json' };
    if (p.token) {
      h[p.headers.token] = p.token;
      return h;
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
    return { 'Content-Type': 'application/json', [p.authHeader]: p.apiKey };
  }

  throw new Error('未知对接方：' + id);
}

/* ---------------- 访问控制 ---------------- */

function originList(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 来源白名单：浏览器请求一定带 Origin，非浏览器（curl / 服务端）不带。
 *   设了白名单且不含 '*'：不在名单内的来源直接 403
 *   没设白名单：回显 Origin，等价于允许任意来源（/health 里会如实标出来）
 */
export function corsHeaders(origin, env = process.env) {
  const list = originList(env);
  let allowOrigin = '*';
  if (list.length && !list.includes('*')) {
    allowOrigin = origin && list.includes(origin) ? origin : list[0];
  } else if (origin) {
    allowOrigin = origin;
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Token, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
  };
}

/**
 * 线上运行时的强制配置检查（只对 Vercel 生效，本地进程不拦）。
 * 线上缺 PROXY_ACCESS_TOKEN 或缺 ALLOWED_ORIGINS 时，转发通道直接关掉并给出 503：
 * 静默放行等于把三体会员姓名与手机号公开，比报错严重得多。
 * 健康检查不拦，这样部署完能立刻确认"函数起来了没"。
 */
export function runtimeGuard(env = process.env) {
  if (!env.VERCEL) return null;
  const missing = [];
  if (!env.PROXY_ACCESS_TOKEN) missing.push('PROXY_ACCESS_TOKEN');
  if (!originList(env).length) missing.push('ALLOWED_ORIGINS');
  if (!missing.length) return null;
  return {
    status: 503,
    body: {
      error: `server_misconfigured: 线上代理缺少必配环境变量：${missing.join('、')}`,
      detail: 'Vercel 后台 → Settings → Environment Variables 补齐后 Redeploy。补齐前所有转发请求一律拒绝，密钥不会因此泄露。',
    },
  };
}

/**
 * 访问口令。线上不设 PROXY_ACCESS_TOKEN 等于把代理裸奔出去：
 * 任何拿到地址的人都能用你的三体网关 Key 拉会员手机号。
 * 口令用 X-Proxy-Token 传，不用 Authorization——Authorization 是代理与上游三体之间用的。
 */
export function checkAccess(headers = {}, env = process.env, { origin } = {}) {
  const list = originList(env);
  if (list.length && !list.includes('*') && origin && !list.includes(origin)) {
    return {
      ok: false,
      status: 403,
      body: { error: 'forbidden: 来源不在 ALLOWED_ORIGINS 白名单内', origin },
    };
  }

  const need = env.PROXY_ACCESS_TOKEN || '';
  if (!need) return { ok: true, tokenRequired: false };

  const raw = headers['x-proxy-token'] || headers['X-Proxy-Token'] || '';
  const bearer = String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  const got = (raw || bearer || '').trim();
  if (!got) {
    return { ok: false, status: 401, body: { error: 'unauthorized: 缺少 X-Proxy-Token' } };
  }
  if (got !== need) {
    return { ok: false, status: 401, body: { error: 'unauthorized: X-Proxy-Token 不正确' } };
  }
  return { ok: true, tokenRequired: true };
}

/* ---------------- 健康检查 ---------------- */

export function healthPayload(env = process.env) {
  const providers = {};
  Object.entries(buildProviders(env)).forEach(([id, p]) => {
    providers[id] = {
      label: p.label,
      kind: p.kind || 'gym',
      configured: p.configured,
      baseUrlSet: Boolean(p.baseUrl),
      authMode: describeAuth(id, p),
      keyPreview: mask(secretOf(id, p)),
    };
  });
  const list = originList(env);
  const guard = runtimeGuard(env);
  return {
    ok: true,
    service: 'fitflow-proxy',
    mode: env.VERCEL ? 'serverless' : 'local',
    access: {
      tokenRequired: Boolean(env.PROXY_ACCESS_TOKEN),
      originGuard: list.length ? (list.includes('*') ? 'any' : 'allowlist') : 'reflect',
      /* 线上缺了必配变量时，健康检查照常返回，转发通道关闭 */
      missingRequired: guard ? (guard.body.error.match(/：(.+)$/)?.[1] || '').split('、') : [],
      forwardingBlocked: Boolean(guard),
    },
    providers,
    hint: '未配置的对接方请在进程环境变量里注入密钥（Vercel：Project Settings → Environment Variables）。',
  };
}

/* ---------------- 转发 ---------------- */

export function buildQuery(query) {
  const qs = new URLSearchParams();
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) qs.append(k, String(v));
  });
  const s = qs.toString();
  return s ? '?' + s : '';
}

/**
 * 一次转发。返回 { status, body }，HTTP 层由调用方（本地 http 服务 / Serverless）负责。
 * payload：{ resource, method, path, query, body, shopId }
 */
export async function proxyCall(id, payload = {}, env = process.env) {
  const key = String(id || '').toLowerCase();
  const p = buildProviders(env)[key];
  if (!p) return { status: 404, body: { error: `未知对接方：${id}` } };
  if (!p.configured) {
    return {
      status: 401,
      body: { error: `unauthorized: ${p.label} 的密钥尚未配置`, detail: p.envHint },
    };
  }
  if (!p.baseUrl) {
    return {
      status: 500,
      body: { error: `endpoint_unverified: 未配置 ${p.label} 的服务地址`, detail: `设置 ${key.toUpperCase()}_BASE_URL` },
    };
  }

  const { resource, method = 'POST', path, query = {}, body = {}, shopId } = payload;
  if (!path) return { status: 400, body: { error: '缺少 path' } };

  const target = p.baseUrl.replace(/\/$/, '') + path + buildQuery(query);

  let headers;
  try {
    if (key === 'santi') {
      const token = shopId ? await santiSwitchShop(p, shopId, env) : await santiAccessToken(p, env);
      headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'app-id': p.appId,
        'X-Request-ID': randomUUID(),
      };
    } else {
      headers = authHeaders(key, p, { body, query });
    }
  } catch (e) {
    if (key === 'santi') {
      return {
        status: 401,
        body: {
          error: `unauthorized: ${p.label} 鉴权失败：${e.message}`,
          detail: '确认 SANTI_GATEWAY_KEY 是 32 位网关 Key（PC 端员工账号管理生成）且未过期；默认有效期 90 天。',
        },
      };
    }
    return { status: 500, body: { error: e.message } };
  }

  const t0 = Date.now();
  log(`${key}.${resource} → ${method} ${target}`);

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(num(env.UPSTREAM_TIMEOUT_MS, 15000)),
    });
    const text = await upstream.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 上游返回非 JSON */ }
    log(`${key}.${resource} ← ${upstream.status} (${Date.now() - t0}ms)`);
    return { status: upstream.status, body: json ?? { raw: text.slice(0, 2000) } };
  } catch (e) {
    const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError' || /timeout/i.test(e.message);
    log(`${key}.${resource} ✗ ${e.message}`);
    return {
      status: 504,
      body: {
        error: isTimeout ? `network: ${p.label} 响应超时（${num(env.UPSTREAM_TIMEOUT_MS, 15000)}ms）` : `network: ${e.message}`,
        detail: '检查网络、服务地址与门店出口 IP 白名单（部分厂商要求加白）。',
      },
    };
  }
}

/** 供 Serverless 使用：把 req.body 统一成对象（Vercel 会预解析，其它运行时给字符串） */
export function readPayload(reqBody) {
  if (!reqBody) return {};
  if (typeof reqBody === 'string') {
    try { return JSON.parse(reqBody); } catch { return null; }
  }
  return reqBody;
}
