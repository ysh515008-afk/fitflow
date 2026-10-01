/* ============================================================
   integrations/index.js · 对接方注册表 + 统一客户端
   ------------------------------------------------------------
   注册表分两类，刻意不混在一起：
     PROVIDERS        经营系统：会员 / 预约 / 订单 → 落地到会员档案
     CONTENT_SOURCES  内容源：  账号 / 作品       → 落地到内容表现
   合并会让"业务系统对接"那张卡片把内容源也画进去，语义就错了。

   新增一个系统只需要：写一个同构的 adapter 文件，在这里注册一行。
   ============================================================ */
import { meta as santi } from './santi.js';
import { meta as qinniao } from './qinniao.js';
import { meta as redfox } from './redfox.js';
import { meta as laike } from './laike.js';
import { meta as meituan } from './meituan.js';
import {
  ConnectorError, normalize, requireVerified, normalizeApptStatus, mergeIntoMember,
  ACCOUNT_FIELDS, WORK_FIELDS, RANK_FIELDS,
} from './contract.js';

export const PROVIDERS = { santi, qinniao };
export const PROVIDER_LIST = [santi, qinniao];
export const getProvider = (id) => PROVIDERS[id] || null;

/* ---------------- 内容源（抖音 / 小红书这类平台数据） ---------------- */

export const CONTENT_SOURCES = { redfox };
export const CONTENT_SOURCE_LIST = [redfox];
export const getContentSource = (id) => CONTENT_SOURCES[id] || null;

/* ---------------- 交易后台数据源（抖音来客 / 美团经营宝） ----------------
   第三类注册表，和上面两类刻意分开。三者的落地目标完全不同：
     PROVIDERS        会员 / 预约 / 订单   → 落到会员档案
     CONTENT_SOURCES  账号 / 作品          → 落到内容表现
     BIZ_SOURCES      曝光 / 开口 / 核销   → 落到经营漏斗
   混进同一张表，界面上就会出现"同步会员"这种按钮挂在交易后台卡片上，
   语义直接错了。
   ------------------------------------------------------------------ */

export const BIZ_SOURCES = { laike, meituan };
export const BIZ_SOURCE_LIST = [laike, meituan];
export const getBizSource = (id) => BIZ_SOURCES[id] || null;

export function defaultBizSource(id) {
  const s = BIZ_SOURCES[id];
  if (!s) throw new Error('未知交易后台：' + id);
  return {
    id,
    name: s.name,
    vendor: s.vendor,
    kind: 'biz',
    /* 密钥没配、授权没到位就是 unauthorized，不假装已连接 */
    status: 'unauthorized',
    poiId: '',
    accountRole: '',
    proxyUrl: 'http://localhost:8787',
    /** 线上代理的访问口令（对应服务端环境变量 PROXY_ACCESS_TOKEN），本地代理留空 */
    proxyToken: '',
    endpointsVerified: {},
    lastImportAt: null,
    lastSyncAt: null,
    lastError: null,
    logs: [],
  };
}

export function defaultBizState() {
  return {
    laike: defaultBizSource('laike'),
    meituan: defaultBizSource('meituan'),
    /* 报表导入落地的经营记录：{ id, source, date, impression, visit, open, order, redeem, spend, at } */
    records: [],
  };
}

/** 内容源该用哪张字段表做"必填没拿到"的判断 */
const CONTENT_FIELDS = {
  account: ACCOUNT_FIELDS,
  works: WORK_FIELDS,
  worksFromAccount: WORK_FIELDS,
  searchAccount: ACCOUNT_FIELDS,
  searchWork: WORK_FIELDS,
  topAccounts: RANK_FIELDS,
};

/* ---------------- 默认连接配置 ---------------- */

export function defaultConnector(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error('未知对接方：' + id);
  return {
    id,
    name: p.name,
    vendor: p.vendor,
    status: 'unauthorized',      // unauthorized | pending | connected | error
    baseUrl: '',
    proxyUrl: 'http://localhost:8787',
    accountRole: '',
    systemVersion: '',
    scope: 'own',                // own | all
    /** 线上代理的访问口令（对应服务端环境变量 PROXY_ACCESS_TOKEN），本地代理留空 */
    proxyToken: '',
    writeBack: false,
    autoSync: false,
    lastSyncAt: null,
    lastError: null,
    mappingOverrides: {},        // 用户可在界面上改字段映射
    endpointsVerified: {},       // { members: false, ... }
    accounts: [],                // 绑定的操作员个人账号：[{ id, name, role, scope, boundAt }]
    activeAccountId: null,       // 当前在用的个人账号（决定"读谁的数据"）
    authUrl: '',                 // 手机端授权深链 / 通用链接（厂商提供；留空则走本地代理密钥）
    logs: [],
  };
}

export function defaultConnectors() {
  return { santi: defaultConnector('santi'), qinniao: defaultConnector('qinniao') };
}

/* ---------------- 内容源默认配置 ---------------- */

export function defaultContentSource(id) {
  const s = CONTENT_SOURCES[id];
  if (!s) throw new Error('未知内容源：' + id);
  return {
    id,
    name: s.name,
    vendor: s.vendor,
    platform: s.platform,
    kind: 'content',
    status: 'unauthorized',      // 密钥没配就是 unauthorized，不假装已连接
    baseUrl: s.baseUrl,
    proxyUrl: 'http://localhost:8787',
    /** 线上代理的访问口令（对应服务端环境变量 PROXY_ACCESS_TOKEN），本地代理留空 */
    proxyToken: '',
    /* 关注的账号清单：抖音号，不含昵称（昵称不唯一，官方脚本直接拒绝） */
    accounts: [],
    lastSyncAt: null,
    lastError: null,
    credit: { lastCost: null, exhausted: false, checkedAt: null },
    logs: [],
  };
}

/* ---------------- 客户端 ---------------- */

/**
 * 统一客户端：所有网络请求都经过本地代理进程（server/proxy.mjs）。
 * 好处：
 *   1. 浏览器拿不到密钥，key 只存在代理进程环境变量里
 *   2. 绕开浏览器跨域限制
 *   3. 签名算法（勤鸟等）在 Node 侧实现，前端保持干净
 */
export function makeClient(id, cfg, { allowUnverified = false } = {}) {
  const p = getProvider(id);
  if (!p) throw new ConnectorError('unknown_provider', '未知对接方：' + id);

  const base = (cfg.proxyUrl || 'http://localhost:8787').replace(/\/$/, '');
  /* 线上代理设了 PROXY_ACCESS_TOKEN 之后，不带这个头就是 401。
     它挡的是"别人拿到代理地址也用不了"，不是防本机使用者
     ——本机 localStorage 里本来就存着全部会员数据。 */
  const withToken = (extra = {}) => (cfg.proxyToken ? { 'X-Proxy-Token': cfg.proxyToken, ...extra } : extra);

  async function health() {
    try {
      const res = await fetch(`${base}/health`, { method: 'GET', headers: withToken() });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      return { ok: true, ...json, provider: json.providers?.[id] || null };
    } catch (e) {
      return {
        ok: false,
        error: new ConnectorError('network',
          `连不上代理 ${base}。本地：先运行 node server/proxy.mjs；线上：确认已部署 api/ 下的 Serverless 函数且地址以 /api 结尾。`, e.message),
      };
    }
  }

  async function call(resource, params = {}) {
    const spec = p.endpointSpec[resource];
    if (!spec) throw new ConnectorError('unknown_resource', `未定义资源：${resource}`);
    const verified = cfg.endpointsVerified?.[resource] ?? spec.verified;
    if (!verified && !allowUnverified) {
      throw new ConnectorError('endpoint_unverified',
        `「${p.name} · ${resource}」的接口路径尚未核对，为避免把猜测当事实，暂不发起请求。请先用官方文档核对并在「接口规格」里勾选。`);
    }
    const req = p.buildRequest(cfg, resource, params);
    let res;
    try {
      res = await fetch(`${base}/proxy/${id}`, {
        method: 'POST',
        headers: withToken({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          resource,
          method: req.method,
          path: req.path,
          query: req.query,
          body: req.body,
          signMode: p.authSpec.signMode,
        }),
      });
    } catch (e) {
      throw new ConnectorError('network', `代理请求失败：${e.message}`, e);
    }

    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError('unauthorized', `${p.name} 鉴权失败（${res.status}）。请检查代理进程里的密钥配置与账号权限。`);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch { /* ignore */ }
      throw new ConnectorError('http', `${p.name} 返回 HTTP ${res.status}${detail ? '：' + detail.slice(0, 200) : ''}`);
    }

    const json = await res.json().catch(() => null);
    if (json === null) throw new ConnectorError('parse', '返回内容不是合法 JSON');
    return { json, list: p.parseList(json) };
  }

  async function fetchMembers(params = {}) {
    const { list } = await call('members', params);
    const map = mergeMapping(p, cfg, 'members');
    return list.map((raw) => {
      const { data, missing } = normalize(raw, map);
      return { ...data, _missing: missing, _raw: raw };
    });
  }

  async function fetchAppointments(params = {}) {
    const { list } = await call('appointments', params);
    const map = mergeMapping(p, cfg, 'appointments');
    return list.map((raw) => {
      const { data } = normalize(raw, map);
      return { ...data, status: normalizeApptStatus(data.status) || null, _raw: raw };
    });
  }

  async function testConnection() {
    const h = await health();
    if (!h.ok) return { ok: false, error: h.error };
    const info = h.provider || {};
    if (!info.configured) {
      return {
        ok: false,
        error: new ConnectorError('unauthorized',
          `代理已启动，但 ${p.name} 的密钥尚未配置。请在代理进程环境变量里设置：${p.authSpec.envVars.join('、')}`),
      };
    }
    return { ok: true, info };
  }

  return { provider: p, health, call, fetchMembers, fetchAppointments, testConnection };
}

/* ============================================================
   内容源客户端
   ------------------------------------------------------------
   与 makeClient 刻意分开，理由有三条：
     1. 资源不同：内容源是 account / works，不是 members / appointments
     2. 落地目标不同：内容源不产生会员档案，不能走 mergeIntoMember
     3. 零回归风险：业务系统的同步链路一行都不用动
   两者共用 contract 的 normalize / ConnectorError，映射规则仍然是数据。
   ============================================================ */
export function makeContentClient(id, cfg = {}, { transport } = {}) {
  const s = CONTENT_SOURCES[id];
  if (!s) throw new ConnectorError('unknown_source', '未知内容源：' + id);

  const base = (cfg.proxyUrl || 'http://localhost:8787').replace(/\/$/, '');
  const withToken = (extra = {}) => (cfg.proxyToken ? { 'X-Proxy-Token': cfg.proxyToken, ...extra } : extra);

  /** 同 makeClient 的健康检查：判断"代理起了没 / 密钥配了没" */
  async function health() {
    try {
      const res = await fetch(`${base}/health`, { method: 'GET', headers: withToken() });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      return { ok: true, ...json, provider: json.providers?.[id] || null };
    } catch (e) {
      return {
        ok: false,
        error: new ConnectorError('network',
          `连不上代理 ${base}。本地：先运行 node server/proxy.mjs；线上：确认已部署 api/ 下的 Serverless 函数且地址以 /api 结尾。`, e.message),
      };
    }
  }

  /**
   * 发送一次内容请求。
   * transport 可注入：默认走本地代理（浏览器用），
   * Node 侧（CLI / 脚本）可以注入直连，避免多起一个进程。
   */
  async function call(resource, params = {}) {
    const spec = s.endpointSpec[resource];
    if (!spec) throw new ConnectorError('unknown_resource', `未定义资源：${resource}`);

    /* 允许界面把某项标成"已核对"来解除拦截，和经营系统那条链路保持一致。
       默认仍然拦，因为默认状态下路径可信度不够。 */
    const verified = cfg.endpointsVerified?.[resource] ?? spec.verified;
    if (!verified) {
      const why = spec.pathSource === 'official-directory'
        ? '路径来自红狐官网 API 目录，但没有实跑验证过'
        : spec.pathSource === 'official-doc'
          ? '路径来自官方文档，且该接口标注未上线'
          : '接口路径尚未核对';
      throw new ConnectorError('endpoint_unverified',
        `「${s.name} · ${resource}」${why}。为避免把猜测当事实，暂不发起请求。`);
    }

    const req = s.buildRequest(cfg, resource, params);
    const live = req.live !== false;
    if (!live) {
      throw new ConnectorError('endpoint_unverified',
        `「${s.name} · ${resource}」官方文档标注"即将上线"，当前调用不通。`);
    }

    if (transport) return { json: await transport(req, spec), req };

    let res;
    try {
      res = await fetch(`${base}/proxy/${id}`, {
        method: 'POST',
        headers: withToken({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          resource, method: req.method, path: req.path,
          query: req.query, body: req.body,
        }),
      });
    } catch (e) {
      throw new ConnectorError('network',
        `连不上代理 ${base}。本地：先运行 node server/proxy.mjs；线上：确认已部署 api/ 下的 Serverless 函数且地址以 /api 结尾。`, e.message);
    }

    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError('unauthorized',
        `${s.name} 鉴权失败（${res.status}）。检查代理进程里的 REDFOX_API_KEY。`);
    }
    const json = await res.json().catch(() => null);
    if (json === null) throw new ConnectorError('parse', '返回内容不是合法 JSON');
    return { json, req };
  }

  /** 账号维度（dyUser/query）。同时把内嵌作品一并归一化 */
  async function fetchAccount(uniqueName, extras = {}) {
    const { json } = await call('account', { accountIds: [uniqueName], ...extras });
    const list = s.parseList(json);
    if (!list.length) return { account: null, works: [], notFound: true };
    const raw = list[0];
    const acc = normalize(raw, s.mapping.account, ACCOUNT_FIELDS);
    /* 官方脚本用分页 total 覆盖作品总数，这里保持同样口径，不自己数 */
    const total = s.parseTotal(json);
    if (total != null) acc.data.awemeCount = total;

    const works = Array.isArray(raw.works)
      ? raw.works.map((w) => normalize(w, s.mapping.worksFromAccount, WORK_FIELDS))
      : [];
    return { account: { ...acc.data, _missing: acc.missing, _raw: raw }, works: works.map((w) => w.data), notFound: false };
  }

  /** 作品列表（listWorkByAccount），账号维度从 author* 降级提取 */
  async function fetchWorks(uniqueName, extras = {}) {
    const { json } = await call('works', { uniqueName, ...extras });
    const list = s.parseList(json);
    const total = s.parseTotal(json);
    const works = list.map((w) => normalize(w, s.mapping.works, WORK_FIELDS)).map((w) => w.data);
    const embedded = s.extractAccountFromWork(list[0]) || null;
    const acc = embedded ? normalize(embedded, s.mapping.accountFromWork, ACCOUNT_FIELDS) : null;
    return {
      account: acc ? { ...acc.data, _missing: acc.missing, awemeCount: total } : null,
      works,
      total,
      notFound: !list.length,
    };
  }

  /** 关键词搜账号（searchAccount）。用于发现对标账号。 */
  async function fetchSearchAccounts(keyword, extras = {}) {
    const { json } = await call('searchAccount', { keyword, ...extras });
    const list = s.parseList(json);
    return list.map((raw) => {
      const { data, missing } = normalize(raw, s.mapping.searchAccount, ACCOUNT_FIELDS);
      return { ...data, _missing: missing };
    });
  }

  /**
   * 关键词搜作品（searchWork）。用于门店热度的近似召回。
   * 注意：它返回的是"提到了这个关键词"的作品，不是"挂了门店 POI"的作品。
   * 这个区别必须由调用方记住，所以函数名里不出现 store / poi 这类词。
   */
  async function fetchSearchWorks(keyword, extras = {}) {
    const { json } = await call('searchWork', { keyword, ...extras });
    const list = s.parseList(json);
    return list.map((raw) => normalize(raw, s.mapping.searchWork, WORK_FIELDS).data);
  }

  /**
   * 抖音账号赛道榜（topAccounts）。
   * 返回的 rank 就是接口给的 accountRanking，原样透传。
   * 这里绝不按 score 重排：一旦我们自己排过，它就不再是官方榜位了。
   */
  async function fetchTopAccounts({ dateType = 'days', rankDate, category } = {}) {
    const { json } = await call('topAccounts', { dateType, rankDate, type: category });
    const list = s.parseList(json);
    return list.map((raw) => {
      const { data, missing } = normalize(raw, s.mapping.topAccounts, RANK_FIELDS);
      return { ...data, _missing: missing };
    });
  }

  /** 端点 + 积分自检，直接复用适配器里的 probe */
  async function probeStatus(account = (cfg.accounts || [])[0] || 'douyin') {
    return s.probe({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl || s.baseUrl, account });
  }

  return {
    source: s, health, call,
    fetchAccount, fetchWorks, fetchSearchAccounts, fetchSearchWorks, fetchTopAccounts,
    probeStatus,
  };
}

/** 合并用户在界面上的映射覆盖 */
export function mergeMapping(provider, cfg, resource) {
  const base = provider.mapping[resource] || [];
  const override = cfg.mappingOverrides?.[resource] || {};
  return base.map((row) => (override[row.target] ? { ...row, source: override[row.target] } : row));
}

/* ---------------- 兜底通道：表格导入 ---------------- */

/** 自动猜列名 → FitFlow 字段（猜不中就让用户在界面里手动选） */
const GUESS = {
  remoteId: ['会员id', '会员编号', 'memberid', '客户id', 'id', '卡号'],
  name: ['姓名', '会员姓名', '名字', '会员名称', 'name'],
  phone: ['手机', '电话', '手机号', '联系方式', 'mobile', 'phone'],
  gender: ['性别', 'sex', 'gender'],
  cardType: ['卡种', '会籍', '卡类型', '会员卡', 'cardname', '卡名称'],
  expireDate: ['到期', '有效期至', '失效日期', 'enddate', '截止日期'],
  joinDate: ['入会', '开卡', '办卡日期', '开始日期', 'startdate', '建档'],
  ptTotal: ['总课时', '课包总数', '购买课时'],
  ptLeft: ['剩余课时', '剩余次数', '余课', 'remain'],
  totalPaid: ['累计消费', '消费金额', '实收', '金额'],
  lastVisit: ['最近到场', '最后签到', '最近到店', 'lastvisit', '最后入场'],
  visits30: ['到店次数', '签到次数', '出勤次数'],
  advisorName: ['会籍', '顾问', '责任会籍', '所属会籍'],
};

export function guessMapping(headers) {
  const norm = headers.map((h) => String(h).toLowerCase().replace(/\s/g, ''));
  const out = {};
  Object.entries(GUESS).forEach(([field, aliases]) => {
    const idx = norm.findIndex((h) => aliases.some((a) => h.includes(a)));
    if (idx > -1) out[field] = headers[idx];
  });
  return out;
}

/** 用「表头→FitFlow 字段」的对应关系把表格行转成标准会员对象 */
export function rowsToMembers(rows, headers, colMap, providerId = 'santi') {
  const idx = {};
  Object.entries(colMap).forEach(([field, header]) => {
    const i = headers.indexOf(header);
    if (i > -1) idx[field] = i;
  });
  const transforms = { ...Object.fromEntries(Object.values(PROVIDERS).flatMap((p) => p.mapping.members.map((m) => [m.target, m.transform]))) };

  return rows.map((r) => {
    const raw = {};
    Object.entries(idx).forEach(([field, i]) => { raw[field] = r[i]; });
    const { data, missing } = normalize(raw, Object.keys(raw).map((k) => ({
      target: k, source: k, transform: transforms[k] || 'text',
    })));
    return { ...data, _missing: missing, origin: providerId };
  }).filter((m) => m.name || m.remoteId);
}

export { ConnectorError, requireVerified, mergeIntoMember, normalizeApptStatus };
export { MEMBER_FIELDS, APPT_FIELDS, ORDER_FIELDS, ACCOUNT_FIELDS, WORK_FIELDS, RANK_FIELDS } from './contract.js';
