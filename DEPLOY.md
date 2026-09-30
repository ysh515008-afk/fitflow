# FitFlow 部署上架指南（GitHub + Vercel）

> 当前进度：本地 git 仓库已初始化并完成首次提交（105 个文件）。
> 剩下面几步需要**你的账号授权**，我无法代劳（涉及你的 GitHub / Vercel 账号凭证）。
> 照下面顺序做即可，每步都标了「你在哪操作」。

---

## 第 0 步：先确认你的 git 身份（改回真实信息）

现在仓库里用的是占位身份（`FitFlow Dev / dev@fitflow.local`）。注册好 GitHub 后，回来告诉我你的：

- **用户名**（GitHub 的 `@xxx`）
- **邮箱**（GitHub 账户邮箱，用于 commit 展示）

我会帮你把本地提交的作者改成真实身份再推送。

---

## 第 1 步：注册 GitHub 账号（你在浏览器操作）

1. 打开 https://github.com/signup
2. 填用户名、邮箱、密码，完成邮箱验证
3. 记下你的**用户名**，后面要用

---

## 第 2 步：生成 Personal Access Token（你在浏览器操作）

这个 token 就是「让命令行能替你推代码」的钥匙。

1. 登录 GitHub → 右上角头像 → **Settings**
2. 左侧栏最底部 → **Developer settings**
3. 左侧 **Personal access tokens** → **Tokens (classic)**
4. 点 **Generate new token** → **Generate new token (classic)**
5. 填：
   - **Note**：随便写，比如 `fitflow-deploy`
   - **Expiration**：建议选 `90 days`（到期可再生成）
   - **勾选权限**：只勾 **`repo`** 这一项（会连带勾选下面所有子项，够了）
6. 拉到底点 **Generate token**
7. **立刻复制**那串 `ghp_xxxx...`（离开页面就看不到了）

> ⚠️ 安全：这串 token 不要贴到任何公开地方。你可以私聊发给我，我会写进本机 git 配置（不写进仓库、不进版本控制）。

---

## 第 3 步：创建远程仓库 + 推送（我来做，等你给我用户名 + token）

等你把 **用户名** 和 **token** 给我，我会执行：

```bash
# 1. 改回真实身份
git config user.name "你的用户名"
git config user.email "你的邮箱"

# 2. 建远程仓库（用你的用户名）
#    我会用 gh 或直接 git remote add，仓库设成 Public

# 3. 推送到 main 分支
git push -u origin main
```

---

## 第 4 步：连接 Vercel 自动部署（你在浏览器操作 + 我来辅助）

Vercel 有两条路，推荐**从 GitHub 仓库导入**（你选的「连 GitHub 自动部署」）：

### 方式 A：Vercel 网页导入（最稳，推荐）

1. 打开 https://vercel.com/signup
2. 用 **GitHub 账号**登录（点 "Continue with GitHub"，授权即可）
3. 进入 Dashboard → **Add New** → **Project**
4. 在 "Import Git Repository" 里找到你的 `fitflow` 仓库 → **Import**
5. 配置页：
   - **Framework Preset**：选 **Other**（这是纯静态站，没有框架）
   - **Build Command**：留空（不需要构建）
   - **Output Directory**：填 `.`（即项目根目录，因为我们直接部署静态文件）
   - 其实我已经在项目里放好了 `vercel.json`，Vercel 会自动读它，**一般不用手动填**
6. 点 **Deploy**
7. 部署完成后 Vercel 给你一个 `https://xxx.vercel.app` 的链接，就是上线地址

**关键点**：因为选了「从 GitHub 导入」，以后你只要 `git push` 新代码，Vercel 会**自动重新部署**，不用再手动操作。

### 方式 B：命令行 `npx vercel`（备选）

如果你更喜欢命令行，我可以帮你跑（npx 已就绪，不用 sudo）：

```bash
npx vercel login   # 会弹出浏览器让你授权
npx vercel         # 首次部署，一路回车
npx vercel --prod  # 正式上线
```

但命令行方式不如「GitHub 导入」那样能自动同步，所以**优先方式 A**。

---

## 部署后的两个必知事项

### 1. 数据存储的说明
FitFlow **所有数据都只存在浏览器 localStorage**，不上传任何服务器。
这意味着：
- 每个用户/设备的数据是独立的，换设备不会同步
- Vercel 上部署的只是一个「静态外壳」，没有任何后端/数据库
- 这正是你项目的设计（隐私优先），但**如果未来要多端同步，需要额外加后端**，这不在本次范围内

### 2. Service Worker 的缓存
`sw.js` 会把应用静态资源缓存下来，让用户离线也能打开。
但注意：**改了代码后，老用户浏览器里的缓存要等 SW 更新机制刷新**（我写的 SW 用了版本号 `fitflow-v1`，改大版本号能强制刷新）。

---

## 需要你给我的信息汇总

为了让我继续推进，请提供：

| 项 | 用途 | 必填 |
|---|---|---|
| GitHub 用户名 | 建远程仓库、改 commit 身份 | ✅ |
| GitHub 邮箱 | commit 作者信息 | ✅ |
| Personal Access Token（`ghp_...`） | 推送代码的凭证 | ✅ |

拿到这三个，我就能一条命令把代码推上去，然后你在 Vercel 点几下就上线了。
