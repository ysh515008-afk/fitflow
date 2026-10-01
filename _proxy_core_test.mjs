/* 代理核心自检（不消耗任何线上额度，不发起真实上游请求）
   跑法：node _proxy_core_test.mjs                                   */
import assert from 'node:assert/strict';
import {
  buildProviders, healthPayload, proxyCall, corsHeaders, checkAccess, readPayload, runtimeGuard,
} from './server/_core.mjs';

let pass = 0;
const ok = (name, fn) => {
  fn();
  pass += 1;
  console.log('  ✓', name);
};
const okAsync = async (name, fn) => {
  await fn();
  pass += 1;
  console.log('  ✓', name);
};

const clean = { ...process.env };
['SANTI_GATEWAY_KEY', 'REDFOX_API_KEY', 'PROXY_ACCESS_TOKEN', 'ALLOWED_ORIGINS', 'QINNIAO_APP_KEY']
  .forEach((k) => delete clean[k]);

console.log('\n[1] 凭证装配与脱敏');
{
  const p = buildProviders({ ...clean, SANTI_GATEWAY_KEY: '0123456789abcdef0123456789abcdef' });
  ok('三体未配 Key 时 configured=false', () => {
    assert.equal(buildProviders(clean).santi.configured, false);
  });
  ok('三体配了 Key 时 configured=true，默认 app-id 10000', () => {
    assert.equal(p.santi.configured, true);
    assert.equal(p.santi.appId, '10000');
    assert.equal(p.santi.baseUrl, 'https://ai-gateway.styd.cn');
  });
  ok('健康检查里只有密钥前后缀，没有原文', () => {
    const h = healthPayload({ ...clean, SANTI_GATEWAY_KEY: '0123456789abcdef0123456789abcdef' });
    assert.equal(h.providers.santi.configured, true);
    assert.equal(h.providers.santi.keyPreview, '0123****ef');
    assert.ok(!JSON.stringify(h).includes('0123456789abcdef'));
  });
}

console.log('\n[2] 访问控制');
{
  const envToken = { ...clean, PROXY_ACCESS_TOKEN: 'secret-tok' };
  ok('未设口令 → 放行，并如实标注 tokenRequired=false', () => {
    const g = checkAccess({}, clean, {});
    assert.equal(g.ok, true);
    assert.equal(g.tokenRequired, false);
  });
  ok('设了口令但不带 → 401', () => {
    const g = checkAccess({}, envToken, {});
    assert.equal(g.ok, false);
    assert.equal(g.status, 401);
  });
  ok('带正确 X-Proxy-Token → 放行', () => {
    assert.equal(checkAccess({ 'x-proxy-token': 'secret-tok' }, envToken, {}).ok, true);
  });
  ok('Bearer 形式也认（Authorization 大小写不敏感）', () => {
    assert.equal(checkAccess({ Authorization: 'Bearer secret-tok' }, envToken, {}).ok, true);
  });
  ok('错误口令 → 401', () => {
    assert.equal(checkAccess({ 'x-proxy-token': 'wrong' }, envToken, {}).status, 401);
  });
  ok('白名单外的来源 → 403', () => {
    const g = checkAccess({}, { ...clean, ALLOWED_ORIGINS: 'https://a.com' }, { origin: 'https://b.com' });
    assert.equal(g.status, 403);
  });
  ok('白名单内的来源 → 放行', () => {
    assert.equal(checkAccess({}, { ...clean, ALLOWED_ORIGINS: 'https://a.com' }, { origin: 'https://a.com' }).ok, true);
  });
}

console.log('\n[2b] 线上强制配置（缺了就关闭转发，不静默放行）');
{
  ok('本地进程（无 VERCEL）不做强制', () => {
    assert.equal(runtimeGuard(clean), null);
  });
  ok('线上缺 PROXY_ACCESS_TOKEN → 503 且点名缺哪个变量', () => {
    const g = runtimeGuard({ VERCEL: '1' });
    assert.equal(g.status, 503);
    assert.match(g.body.error, /PROXY_ACCESS_TOKEN/);
    assert.match(g.body.error, /ALLOWED_ORIGINS/);
  });
  ok('线上只缺口令 → 503 只点名口令', () => {
    const g = runtimeGuard({ VERCEL: '1', ALLOWED_ORIGINS: 'https://a.com' });
    assert.equal(g.status, 503);
    assert.match(g.body.error, /PROXY_ACCESS_TOKEN/);
    assert.ok(!g.body.error.includes('ALLOWED_ORIGINS'));
  });
  ok('线上配齐 → 放行', () => {
    assert.equal(runtimeGuard({ VERCEL: '1', PROXY_ACCESS_TOKEN: 't', ALLOWED_ORIGINS: 'https://a.com' }), null);
  });
  ok('健康检查照常返回，但标出 forwardingBlocked 与缺失项', () => {
    const h = healthPayload({ VERCEL: '1' });
    assert.equal(h.ok, true);
    assert.equal(h.access.forwardingBlocked, true);
    assert.deepEqual(h.access.missingRequired, ['PROXY_ACCESS_TOKEN', 'ALLOWED_ORIGINS']);
  });
}

console.log('\n[3] CORS 头');
{
  ok('未设白名单 → 回显来源（本地开发可用）', () => {
    assert.equal(corsHeaders('http://localhost:5173', clean)['Access-Control-Allow-Origin'], 'http://localhost:5173');
  });
  ok('白名单命中 → 回显该来源并带 Vary: Origin', () => {
    const h = corsHeaders('https://a.com', { ...clean, ALLOWED_ORIGINS: 'https://a.com,https://b.com' });
    assert.equal(h['Access-Control-Allow-Origin'], 'https://a.com');
    assert.equal(h.Vary, 'Origin');
  });
  ok('放行 X-Proxy-Token 头（否则浏览器预检失败）', () => {
    assert.match(corsHeaders('', clean)['Access-Control-Allow-Headers'], /X-Proxy-Token/);
  });
}

console.log('\n[4] 请求体解析');
{
  ok('字符串 JSON → 对象', () => assert.deepEqual(readPayload('{"a":1}'), { a: 1 }));
  ok('非法 JSON → null（调用方返回 400）', () => assert.equal(readPayload('{oops'), null));
  ok('空 → {}', () => assert.deepEqual(readPayload(undefined), {}));
}

console.log('\n[5] 转发（不发真实请求，只覆盖拦截分支）');
{
  await okAsync('未知对接方 → 404', async () => {
    const out = await proxyCall('nope', { path: '/x' }, clean);
    assert.equal(out.status, 404);
  });
  await okAsync('密钥未配置 → 401 且给出该配哪个变量', async () => {
    const out = await proxyCall('santi', { path: '/api/gateway', body: {} }, clean);
    assert.equal(out.status, 401);
    assert.match(out.body.error, /尚未配置/);
    assert.match(out.body.detail, /SANTI_GATEWAY_KEY/);
  });
  await okAsync('三体缺 path → 400（配了 Key 也不放行）', async () => {
    const out = await proxyCall('santi', { body: {} }, { ...clean, SANTI_GATEWAY_KEY: 'a'.repeat(32) });
    assert.equal(out.status, 400);
  });
  await okAsync('勤鸟未配服务地址 → 500 endpoint_unverified', async () => {
    const out = await proxyCall('qinniao', { path: '/x' }, { ...clean, QINNIAO_APP_KEY: 'k', QINNIAO_APP_SECRET: 's' });
    assert.equal(out.status, 500);
    assert.match(out.body.error, /endpoint_unverified/);
  });
  await okAsync('红狐配了 Key 但上游不可达 → 504 network（如实报，不包装成"可能"）', async () => {
    const out = await proxyCall('redfox', { path: '/story/api/dyUser/query', body: {} }, {
      ...clean, REDFOX_API_KEY: 'ak_test', REDFOX_BASE_URL: 'http://127.0.0.1:1', UPSTREAM_TIMEOUT_MS: 2000,
    });
    assert.equal(out.status, 504);
    assert.match(out.body.error, /network/);
  });
}

console.log(`\n全部通过：${pass} 项\n`);
