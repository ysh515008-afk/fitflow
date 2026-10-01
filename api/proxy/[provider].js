/* ============================================================
   api/proxy/[provider].js · Vercel Serverless：统一转发
   ------------------------------------------------------------
   线上地址：POST https://<你的域名>/api/proxy/santi
   请求体与本地代理完全一致（前端一行都不用改）：
     { resource, method, path, query, body, shopId }
     · resource  仅用于日志，转发不看它
     · path      上游路径，三体恒为 /api/gateway
     · body      原样转发给上游
     · shopId    三体多门店账号用它切店（可选）

   三体的网关 Key 只存在 Vercel 环境变量里，不进代码、不进日志、不进任何响应。
   ============================================================ */
import { proxyCall, corsHeaders, checkAccess, readPayload, runtimeGuard } from '../../server/_core.mjs';

export default async function handler(req, res) {
  const origin = req.headers?.origin;
  const cors = corsHeaders(origin);

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: '请用 POST' });
    return;
  }

  const gate = checkAccess(req.headers || {}, process.env, { origin });
  if (!gate.ok) { res.status(gate.status).json(gate.body); return; }

  /* 线上缺 PROXY_ACCESS_TOKEN / ALLOWED_ORIGINS 时关闭转发，不静默放行 */
  const guard = runtimeGuard(process.env);
  if (guard) { res.status(guard.status).json(guard.body); return; }

  const id = String(req.query?.provider || '').toLowerCase();
  if (!id) {
    res.status(400).json({ error: '缺少对接方 id' });
    return;
  }

  const payload = readPayload(req.body);
  if (payload === null) {
    res.status(400).json({ error: '请求体不是合法 JSON' });
    return;
  }

  try {
    const out = await proxyCall(id, payload, process.env);
    res.status(out.status).json(out.body);
  } catch (e) {
    res.status(500).json({ error: `代理内部错误：${e.message}` });
  }
}
