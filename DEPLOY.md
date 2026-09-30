# FitFlow 部署上架指南（GitHub + Vercel）

> ✅ **GitHub 上传已完成**：代码已推送到 https://github.com/ysh515008-afk/fitflow （Public，main 分支，115 个文件）。
> 剩下只有 **Vercel 部署** 一步，需要你用浏览器登录 Vercel 并导入仓库（自动部署）。

---

## Vercel 部署（最后一步，约 3 分钟）

### 方式 A：网页导入（推荐，自动部署）

1. 打开 https://vercel.com/signup
2. 点 **Continue with GitHub**，用你的 GitHub 账号（`ysh515008-afk`）授权登录
3. 进入 Dashboard → **Add New** → **Project**
4. 在 "Import Git Repository" 列表里找到 **`ysh515008-afk/fitflow`** → 点 **Import**
5. 配置页**基本不用改**（项目里已放好 `vercel.json`，Vercel 会自动读）：
   - **Framework Preset**：会自动识别或选 **Other**（纯静态站）
   - **Build Command**：留空
   - **Output Directory**：`.`（项目根目录）
6. 点 **Deploy**
7. 等几十秒，Vercel 给你一个 `https://fitflow-xxx.vercel.app` 链接 → **这就是上线地址**

**自动部署**：因为选了「从 GitHub 导入」，以后你本地 `git push` 新代码，Vercel 会**自动重新部署**，无需再手动操作。

### 方式 B：命令行（需要你本地装 Vercel CLI）

```bash
npm i -g vercel      # 一次性安装
vercel login         # 浏览器授权
vercel --prod        # 正式部署
```

> 注意：本智能体沙箱里 `npx vercel` 被网络代理拦截（`CODEBUDDY_BROKER_DENY`），装不了 CLI，所以**推荐用方式 A 网页导入**，效果一样且能自动同步。

---

## 部署后两个必知事项

### 1. 数据存储
FitFlow **所有数据只存浏览器 localStorage**，不上传服务器。Vercel 上的是纯静态外壳，无后端/数据库。每个设备数据独立，换设备不同步。这是隐私优先的设计；若未来要多端同步，需额外加后端（不在本次范围）。

### 2. Service Worker 缓存
`sw.js` 缓存应用静态资源支持离线。改代码后老用户要等 SW 版本号更新才刷新（当前 `fitflow-v1`，改大版本号可强制刷新）。

---

## 上线后建议

- 访问 Vercel 给的链接，手机浏览器「添加到主屏幕」即可像 App 一样用（PWA 已配好图标和 manifest）
- 如果后面想上真正的 iOS TestFlight，仍需**付费 Apple 开发者账号（$99/年）+ Xcode**，这是独立于 GitHub/Vercel 的另一条线
