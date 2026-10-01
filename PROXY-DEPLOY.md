# 三体服务端代理部署说明

> 目标：把「三体云动 AI 网关」的调用从本机 `localhost:8787` 搬到线上，让 Web 版在任何设备上都能同步会员数据，且**三体网关 Key 不出现在浏览器里**。

---

## 1. 为什么必须有服务端代理

三体网关 `https://ai-gateway.styd.cn` 有两个硬约束，决定了它不能由浏览器直连：

| 约束 | 机制 | 直连的结果 |
| --- | --- | --- |
| 跨域 | 浏览器按响应头 `Access-Control-Allow-Origin` 决定是否把响应交给 JS | 上游不返回该头 → 请求发出去了，响应被浏览器丢弃，控制台报 CORS 错误 |
| 密钥 | 网关 Key 换来的 `access_token` 等同于门店数据读权限 | 放前端代码 = 任何打开页面的人都能拿走，且无法回收 |

代理做的事只有一件：**在服务端持有 Key，用它换 Bearer Token，替前端转发请求**。

---

## 2. 代码已经写好了，目录如下

```
server/_core.mjs              代理核心（零依赖）：凭证装配 / 三体鉴权 / 访问控制 / 转发
server/proxy.mjs              本地进程版：node server/proxy.mjs（127.0.0.1:8787）
api/health.js                 Serverless：GET  /api/health
api/proxy/[provider].js       Serverless：POST /api/proxy/santi
vercel.json                   已加 functions 配置（1024MB / 30s）
```

本地与线上**共用 `server/_core.mjs` 这一份逻辑**，不存在两套实现走偏的问题。

路径设计成一致的，所以前端只需要换一个地址：

| 场景 | 前端「代理地址」填什么 |
| --- | --- |
| 本地 | `http://localhost:8787` |
| 线上 | `https://你的域名/api` |

前端内部拼的是 `${代理地址}/health` 与 `${代理地址}/proxy/santi`，两边完全对得上。

---

## 3. 部署（Vercel，约 3 分钟）

仓库已连 GitHub（`ysh515008-afk/fitflow`），推送即自动部署：

```bash
git push origin main
```

推送完成后，在 Vercel 后台做四件事：

### 3.1 设置环境变量
`Project → Settings → Environment Variables`，逐条添加（Production / Preview 都勾上）：

| 变量 | 值 | 不设的后果 |
| --- | --- | --- |
| `SANTI_GATEWAY_KEY` | 三体网关 Key（32 位，PC 端「员工账号管理」生成） | `/api/proxy/santi` 一律返回 401「密钥尚未配置」 |
| `PROXY_ACCESS_TOKEN` | 自定义一段随机字符串 | **转发通道关闭**：`/api/proxy/*` 一律 503（不是裸奔放行） |
| `ALLOWED_ORIGINS` | `https://你的.vercel.app域名`（多个用逗号分隔） | **转发通道关闭**：`/api/proxy/*` 一律 503 |
| `SANTI_APP_ID` | 通常不用填，默认 `10000` | — |

改完环境变量必须 **Redeploy** 一次才会生效（Vercel 不会自动重跑已完成的部署）。

这两项在**线上是强制的**：只要跑在 Vercel 上（`VERCEL=1`），缺任何一项，转发接口直接返回 503 `server_misconfigured` 并点名缺哪个变量，不会静默放行。健康检查 `/api/health` 仍返回 200，但会带 `"forwardingBlocked": true`，方便你先确认"函数起来了没"。本地 `node server/proxy.mjs` 不受此限制。

### 3.2 把函数区域改到香港
`Settings → Functions → Function Region` 选 `hkg1`（香港）。
默认区域是美国东部，从国内每次调用多一次跨太平洋往返，超时概率和延迟都由这个决定。

### 3.3 前端填地址与口令
工作台 → 对接方（三体）→ 接入信息：

- 代理地址：`https://你的域名/api`
- 代理访问口令：填 3.1 里设的 `PROXY_ACCESS_TOKEN`

### 3.4 验收（三条命令，逐条看结果）

```bash
# ① 先确认函数起来了
#   还没配 PROXY_ACCESS_TOKEN 时：下面这条直接通（健康检查只报配置状态，不含数据）
#   已配了口令之后：不带口令会是 401，用第 ③ 条那条带口令的即可
curl -s https://你的域名/api/health
# 期望：{"ok":true,...}；若看到 "forwardingBlocked":true，说明环境变量还没配齐

# ② 带口令再看一次：不带应该是 401
curl -s -o /dev/null -w '%{http_code}\n' https://你的域名/api/health
# 期望：401

# ③ 带口令 → 200，且 santi.configured 为 true、forwardingBlocked 为 false
curl -s -H 'X-Proxy-Token: 你的口令' https://你的域名/api/health
# 期望：{"ok":true,...,"providers":{"santi":{"configured":true,...}},"access":{"forwardingBlocked":false}}

# ④ 真实转发（把 keyword 换成一个真实会员手机号）
curl -s -X POST https://你的域名/api/proxy/santi \
  -H 'Content-Type: application/json' \
  -H 'X-Proxy-Token: 你的口令' \
  -d '{"resource":"followHistory","method":"POST","path":"/api/gateway",
       "body":{"method":"member.follow-history","timestamp":1700000000,"params":{"keyword":"13800138000"}}}'
# 期望：上游原始响应；判定成功的标准是 code=0 且响应里有 request_id
```

第 ④ 条失败时，代理会原样把上游的 `code` / `msg` 返回，不做转述。常见三个：

- HTTP 503 `server_misconfigured`：`PROXY_ACCESS_TOKEN` 或 `ALLOWED_ORIGINS` 没配，补齐后 Redeploy
- `code=60105`：网关 Key 无效或过期（默认有效期 90 天，到期要在三体 PC 端重新生成）
- HTTP 504：函数到 `ai-gateway.styd.cn` 的往返超过 15 秒，检查 Function Region 是否是 hkg1

---

## 4. 事实边界（这些不是风险提示，是当前实现的确定行为）

1. **Token 缓存是实例级的。** Vercel 每个 Serverless 实例各自缓存 `access_token`；冷启动或并发扩容时会各自重新登录一次。这是预期行为，不会报错。
2. **代理不改变三体的写能力。** 三体网关当前版本只有 `member.create` 一个写方法（需二次确认 `confirmation_token`），跟进记录只有 `member.follow-history`（读）。代理只是转发，不补写接口。
3. **多门店账号要带 `shopId`。** 请求体里加 `"shopId":"门店id"`，代理会先调 `/auth/switch/shop` 再转发；不带的账号读到的是默认门店数据。
4. **Key 90 天到期。** 到期后所有三体请求返回 60105，需要在三体 PC 端重新生成并更新 Vercel 环境变量。
5. **`vercel.app` 域名在国内的可访问性由网络环境决定**，本说明不对其做保证；若不可用，需要绑定自有域名（绑定后 `ALLOWED_ORIGINS` 要同步改）。
6. **小程序分支暂不能直接复用这个地址。** 小程序 `wx.request` 要求域名已 ICP 备案并加入 request 合法域名白名单，`vercel.app` 不满足。要共用就先绑一个已备案的自有域名。
7. **日志里没有密钥。** `DEBUG=1` 时打印转发路径与耗时，密钥只以 `前4****后2` 的形式出现。
8. **线上缺 `PROXY_ACCESS_TOKEN` 或 `ALLOWED_ORIGINS` 时转发关闭**，返回 503 并点名缺哪个变量；健康检查仍返回 200。这个判断只在线上（`VERCEL=1`）生效，本地进程不拦。

---

## 5. 本地代理同时升级了

本地 `node server/proxy.mjs` 现在和线上同一套代码，同样支持：

```bash
SANTI_GATEWAY_KEY=xxx \
PROXY_ACCESS_TOKEN=自定义口令 \
ALLOWED_ORIGINS=http://localhost:5173 \
node server/proxy.mjs
```

不设 `PROXY_ACCESS_TOKEN` 时行为与之前一致（本机可直接调），启动时会在控制台提示这一点。

自检脚本（不消耗任何线上额度、不发真实请求）：

```bash
node _proxy_core_test.mjs     # 21 项，覆盖凭证脱敏 / 访问控制 / CORS / 转发拦截分支
```
