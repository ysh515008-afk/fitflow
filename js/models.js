/* ============================================================
   models.js · AI 话术「可调用模型」注册表与调用接口
   ------------------------------------------------------------
   定位：列出当前国内可直接调用的热门大模型，给出
         - 调用代价（免费额度 / 计费单价 / 成本档）
         - 接入难易程度（认证 / OpenAI 兼容 / 步骤数）
        并提供一个 OpenAI 兼容的 callModel() 调用接口。

   重要边界（与 FitFlow「不伪造 AI 结论」的总原则一致）：
   - 浏览器页面内的 fetch 受同源策略约束：目标接口未返回允许本页域名的
     CORS 响应头（Access-Control-Allow-Origin）时，浏览器按同源策略拦截
     响应读取，调用失败。callModel 失败时如实返回浏览器错误原文并给出
     确定性指引，不臆测原因、不静默假装成功。
   - API Key 只存在本机 localStorage，绝不离开浏览器。
   价格以 2026-09 各官网公示为准，波动频繁，仅作量级参考。
   ============================================================ */

/* 难度档位：1 极简 → 5 复杂 */
export const DIFF_META = {
  1: { label: '极简', cls: 'diff-1', desc: '注册即送大额免费额度，OpenAI 格式一行接入' },
  2: { label: '简单', cls: 'diff-2', desc: '账号 + API Key，标准 OpenAI 兼容' },
  3: { label: '中等', cls: 'diff-3', desc: '需在平台先创建接入点 / Endpoint 再调用' },
  4: { label: '偏难', cls: 'diff-4', desc: '需实名或企业认证，开通多一步审核' },
  5: { label: '复杂', cls: 'diff-5', desc: '多步骤、需工单或白名单' },
};

/* 成本档位：1 极低 → 5 高（元 / 百万 tokens 量级） */
export const COST_META = {
  1: { label: '极低', cls: 'cost-1' },
  2: { label: '低', cls: 'cost-2' },
  3: { label: '中', cls: 'cost-3' },
  4: { label: '偏高', cls: 'cost-4' },
  5: { label: '高', cls: 'cost-5' },
};

/* 当前国内可直接调用的热门模型（OpenAI 兼容 chat/completions）
   endpoint 为各厂商兼容 base；apiModel 为请求体里的 model 名。 */
export const MODELS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: '深度求索',
    flagship: 'DeepSeek V4 Pro / Flash',
    ctx: '1M',
    callable: true,
    recommended: true,
    endpoint: 'https://api.deepseek.com/v1',
    apiModel: 'deepseek-chat',
    webUrl: 'https://platform.deepseek.com/',
    free: '新用户 500 万免费 tokens，无需绑卡',
    input: 1, output: 4, costTier: 1,
    difficulty: 2,
    auth: '深度求索账号 + API Key，标准 OpenAI 兼容',
    strength: '文本推理性价比天花板，长上下文、中文话术友好',
    note: '价格为 Flash 量级；Pro/推理档输出约 13.5 元/百万。闲时半价。',
  },
  {
    id: 'qwen',
    name: '通义千问 Qwen',
    vendor: '阿里云百炼',
    flagship: 'Qwen3.7-Max',
    ctx: '256K+',
    callable: true,
    recommended: true,
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiModel: 'qwen-max',
    webUrl: 'https://dashscope.aliyun.com/',
    free: '单模型 100–200 万免费 tokens（90 天有效）',
    input: 12, output: 36, costTier: 3,
    difficulty: 2,
    auth: '阿里云账号 + DashScope API Key，OpenAI 兼容',
    strength: '生态最全，内置联网/代码解释器，代码与长文档强',
    note: 'Max 档 12/36 元/百万；Qwen-Plus / Turbo 更便宜。',
  },
  {
    id: 'doubao',
    name: '豆包 Doubao',
    vendor: '字节火山方舟',
    flagship: 'Doubao 2.1 Pro',
    ctx: '256K',
    callable: true,
    endpoint: 'https://ark.cn-beijing.volcesecengine.com/api/v3',
    apiModel: 'doubao-seed-2.1-pro',
    webUrl: 'https://www.volcengine.com/ark',
    free: '新用户大量免费 tokens（按模型）',
    input: 6, output: 30, costTier: 3,
    difficulty: 3,
    auth: '火山方舟控制台创建接入点（Endpoint ID）后调用',
    strength: '多模态（图/视频/语音）综合体验优，字节生态联动',
    note: '价格为 0–32K 档；长上下文按输入长度分档，最长可乘 4。',
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    vendor: '智谱 AI',
    flagship: 'GLM-5.3 / GLM-5.3-Flash',
    ctx: '1M',
    callable: true,
    recommended: true,
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    apiModel: 'glm-5-flash',
    webUrl: 'https://open.bigmodel.cn/',
    free: '新用户 2000 万 tokens 永久有效；Flash 系列常免',
    input: 8, output: 28, costTier: 2,
    difficulty: 1,
    auth: '智谱账号 + API Key，OpenAI 兼容，免费额度最大',
    strength: '中文优化、Agent 工作流友好，免费档可用',
    note: '5.3 旗舰 8/28；Flash 0.8/2.8，几乎零成本。',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    vendor: '月之暗面',
    flagship: 'Kimi K3',
    ctx: '1M',
    callable: true,
    endpoint: 'https://api.moonshot.cn/v1',
    apiModel: 'kimi-k3',
    webUrl: 'https://platform.moonshot.cn/',
    free: '长文阈值内免费，注册送额度',
    input: 20, output: 100, costTier: 4,
    difficulty: 2,
    auth: '月之暗面账号 + API Key，OpenAI 兼容',
    strength: '超长上下文、长文档解析是招牌',
    note: '输入便宜但输出贵（100 元/百万），长话术批量生成成本高。',
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    vendor: '腾讯云',
    flagship: 'Hunyuan Hy3',
    ctx: '256K',
    callable: true,
    endpoint: 'https://api.hunyuan.cloud.tencent.com/v1',
    apiModel: 'hunyuan-turbo',
    webUrl: 'https://cloud.tencent.com/product/hunyuan',
    free: 'Lite 版本永久免费；新用户赠送额度',
    input: 1, output: 4, costTier: 1,
    difficulty: 2,
    auth: '腾讯云账号 + API Key，OpenAI 兼容',
    strength: '微信 / 企业微信生态对接顺，轻量档零成本',
    note: 'Turbo 1/4 元/百万，性价比高；企业微信场景首选。',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    vendor: '稀宇科技',
    flagship: 'MiniMax-M3',
    ctx: '1M',
    callable: true,
    endpoint: 'https://api.minimax.io/v1',
    apiModel: 'MiniMax-M3',
    webUrl: 'https://www.minimax.io/',
    free: '每月 100 万免费 tokens',
    input: 2, output: 8, costTier: 1,
    difficulty: 2,
    auth: 'MiniMax 账号 + API Key，OpenAI 兼容',
    strength: '创意写作、长上下文 Agent 推理均衡',
    note: '约 2/8 元/百万，体量与 DeepSeek 接近。',
  },
  {
    id: 'ernie',
    name: '文心一言 ERNIE',
    vendor: '百度智能云千帆',
    flagship: 'ERNIE 5.1',
    ctx: '32K+',
    callable: true,
    endpoint: 'https://qianfan.baidubce.com/v2',
    apiModel: 'ernie-5.1',
    webUrl: 'https://console.bce.baidu.com/qianfan/',
    free: 'ERNIE-Speed 轻量版永久免费不限量',
    input: 4, output: 18, costTier: 3,
    difficulty: 4,
    auth: '百度账号 + 千帆平台，需实名；Speed 档免认证',
    strength: '中文语义、知识库问答、合规校验成熟',
    note: '5.1 约 4/18 元/百万；Speed 永久免费适合压测基线。',
  },
];

export const MODEL_BY_ID = Object.fromEntries(MODELS.map((m) => [m.id, m]));

/* 查询可调用模型：返回列表，可按 callable / 关键词过滤 */
export function queryModels({ callableOnly = false, q = '' } = {}) {
  let list = MODELS.slice();
  if (callableOnly) list = list.filter((m) => m.callable);
  if (q) {
    const kw = q.trim().toLowerCase();
    list = list.filter((m) =>
      (m.name + m.vendor + m.flagship).toLowerCase().includes(kw));
  }
  return list;
}

export function diffMeta(level) {
  return DIFF_META[level] || DIFF_META[2];
}
export function costMeta(tier) {
  return COST_META[tier] || COST_META[3];
}

/* ---- 本机密钥存取（只存 localStorage，不上传） ----
   密钥库同样加密存储（PIPL 第51条）：用 AES-GCM 加密整份密钥 JSON。
   为保持 saveKey/loadKey 同步语义（被 UI 与测试桩同步调用），
   解密在启动时由 initKeys() 异步完成，结果放进内存缓存 keyCache；
   saveKey/loadKey 读写缓存，persistKeys() 异步落盘加密。 */
const KEY_STORE = 'fitflow.modelkeys.v1';
const ENC_PREFIX = 'ffenc:';
let keyCache = {};

async function cryptoReady() {
  return Boolean(globalThis.crypto?.subtle);
}

async function loadKeysStore() {
  try {
    const raw = localStorage.getItem(KEY_STORE);
    if (!raw) { keyCache = {}; return; }
    let parsed;
    if (raw.startsWith(ENC_PREFIX)) {
      if (!globalThis.crypto?.subtle) {
        console.warn('密钥库已加密但当前环境无 Web Crypto，无法解密，已清空密钥缓存。请改用 https / localhost 打开。');
        keyCache = {};
        return;
      }
      parsed = JSON.parse(await modelsDecrypt(raw.slice(ENC_PREFIX.length)));
    } else {
      parsed = JSON.parse(raw); // 旧明文：迁移
    }
    keyCache = parsed && typeof parsed === 'object' ? parsed : {};
    if (!raw.startsWith(ENC_PREFIX)) await persistKeys(); // 把旧明文重写为加密
  } catch (e) {
    console.warn('读取密钥库失败', e);
    keyCache = {};
  }
}

/* 与 store.js 同款 AES-GCM，但这里独立实现，避免跨模块耦合 */
async function modelsEncrypt(str) {
  const key = await getModelKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(str));
  const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
  return b64(ct) + '.' + b64(iv);
}
async function modelsDecrypt(packed) {
  const [ ctB64, ivB64 ] = packed.split('.');
  const key = await getModelKey();
  const ct = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}
let _modelKeySlot = 'fitflow.k';
async function getModelKey() {
  let raw = localStorage.getItem(_modelKeySlot);
  if (!raw) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    raw = btoa(String.fromCharCode(...bytes));
    localStorage.setItem(_modelKeySlot, raw);
  }
  const buf = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', buf, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function persistKeys() {
  try {
    if (!(await cryptoReady())) { localStorage.setItem(KEY_STORE, JSON.stringify(keyCache)); return; }
    localStorage.setItem(KEY_STORE, ENC_PREFIX + await modelsEncrypt(JSON.stringify(keyCache)));
  } catch (e) { console.warn('密钥库加密落盘失败', e); }
}

export async function initKeys() { await loadKeysStore(); }

function readKeys() { return keyCache; }
export function loadKey(id) {
  const rec = readKeys()[id];
  return rec ? { key: rec.key || '', endpoint: rec.endpoint || '' } : { key: '', endpoint: '' };
}
export function saveKey(id, key, endpoint) {
  const all = readKeys();
  all[id] = { key: key || '', endpoint: endpoint || '' };
  void persistKeys();
}

/* 全局「总开关」：当前激活的模型 + 其密钥。
   所有功能（AI 任务包调用、云端润色、会面转写）都读这里，
   不在各自界面单独登记 key / endpoint。激活模型缺省为豆包。 */
export function activeModelConfig(ctx) {
  const id = ctx?.state?.settings?.ai?.activeModelId || 'doubao';
  const model = MODEL_BY_ID[id] || MODEL_BY_ID['doubao'];
  const rec = loadKey(model.id);
  return { id: model.id, model, key: rec.key || '', endpoint: rec.endpoint || '' };
}

/* 度量一次调用的预估花费（基于 prompt / 估算输出 tokens，粗略） */
export function estimateCost(model, promptChars, outTokens = 800) {
  const inTok = Math.ceil(promptChars / 1.6); // 中文约 1.6 字符/token
  const cost = (inTok / 1e6) * model.input + (outTokens / 1e6) * model.output;
  return { inTok, outTokens, yuan: cost };
}

/* ============================================================
   callModel —— OpenAI 兼容调用接口
   返回 { ok, text?, error? }
   ============================================================ */
export async function callModel(modelId, {
  prompt, system, apiKey, endpoint, temperature = 0.7, maxTokens = 1600, signal,
} = {}) {
  const m = MODEL_BY_ID[modelId];
  if (!m) return { ok: false, error: '未找到模型：' + modelId };
  if (!m.callable) return { ok: false, error: '该模型暂不支持在 FitFlow 内直接调用，请用网页版。' };

  const base = (endpoint || m.endpoint || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: '缺少调用地址（endpoint）。' };
  if (!apiKey) return { ok: false, error: '缺少 API Key。' };

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: m.apiModel,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || data?.error || ('HTTP ' + res.status);
      return { ok: false, error: msg };
    }
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text) return { ok: false, error: '模型返回为空，请重试或换模型。' };
    return { ok: true, text };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? '已取消调用。' : (e?.message || String(e));
    return { ok: false, error: msg + corsGuidance(msg) };
  }
}

/* CORS 拦截的确定性释义（不臆测、不模糊）
   浏览器对跨域 fetch 的放行与否，只由目标接口的 CORS 响应头决定：
   - 接口返回 Access-Control-Allow-Origin 允许本页域名 → 浏览器放行读取；
   - 未返回（或不允许本页域名）→ 浏览器按同源策略拦截响应读取。
   因此「是否被拦截」由目标接口的 CORS 响应头决定，是机制确定性结论，而非概率性臆测。
   错误信息里出现 CORS / 跨域 → 已确认是响应头缺失导致的拦截；
   出现 Failed to fetch / NetworkError → 由两种确定情形之一导致：
     ① 接口未返回 CORS 头被拦截；② 请求未送达（网络不可达 / DNS / 地址错 / 被扩展或防火墙拦）。 */
function corsGuidance(msg) {
  const resolve = '解决方式：① 经你自己的服务端 / 转发代理调用（由服务端设置 CORS 头或直接转发）；② 用「复制提示词 + 网页版」在厂商官网完成调用。API Key 只存本机，不经本页上传。';
  if (/CORS|跨域/i.test(msg)) {
    return '\n原因：目标接口未返回允许本页域名的 CORS 响应头（Access-Control-Allow-Origin），浏览器已按同源策略拦截本次响应读取。' + resolve;
  }
  if (/Failed to fetch|NetworkError/i.test(msg)) {
    return '\n本页跨域请求未完成（浏览器报：' + msg + '）。该错误由以下确定情形之一导致：目标接口未返回 CORS 头被同源策略拦截；或请求未送达（本地网络不可达 / DNS 失败 / 地址错误 / 被扩展或防火墙拦截）。' + resolve;
  }
  return '';
}
