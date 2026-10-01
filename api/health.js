/* ============================================================
   api/health.js · Vercel Serverless：代理健康检查
   ------------------------------------------------------------
   线上地址：GET https://<你的域名>/api/health
   前端「本地代理地址」填 https://<你的域名>/api 即可命中本函数，
   因为前端的请求路径固定是 ${proxyUrl}/health 与 ${proxyUrl}/proxy/:id。

   返回内容里永远只有"配了没配"，没有密钥原文。
   ============================================================ */
import { healthPayload, corsHeaders, checkAccess } from '../server/_core.mjs';

export default async function handler(req, res) {
  const origin = req.headers?.origin;
  const cors = corsHeaders(origin);

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') {
    res.status(405).json({ error: '请用 GET' });
    return;
  }

  const gate = checkAccess(req.headers || {}, process.env, { origin });
  if (!gate.ok) { res.status(gate.status).json(gate.body); return; }

  res.status(200).json(healthPayload(process.env));
}
