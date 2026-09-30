/* ============================================================
   integrations/redfox.js · 红狐数据（抖音 / 小红书）内容源适配器
   ------------------------------------------------------------
   这是「内容数据源」，不是「健身房经营系统」。
   它产出的是账号与作品表现，不产出会员档案，所以：
     · 不注册进 PROVIDERS，不参与"业务系统对接"那张卡片
     · 用独立的 CONTENT_SOURCES 注册表与 makeContentClient 客户端
     · 复用同一套 contract（映射是数据、拿不到就 null、不猜）

   端点核对状态（2026-09-27 实测）：
     · 路径与鉴权：已核对。account / works 两个端点均返回 HTTP 200 + JSON，
       鉴权通过（否则不会计价），当前被"积分余额不足"挡住。
     · 请求体字段：
         works        → 已核对（来自红狐官方脚本 douyin_works_fetcher.py）
         account      → 依据官方脚本推断，尚未实跑成功，标 bodyVerified:false
         searchAccount / searchWork → 字段名未核对，标 bodyVerified:false
         workDetail   → 已核对（官方文档给了 videoId），但该页标注"即将上线"
     · 返回体字段：
         works   → 已核对（官方脚本逐字段解析）
         account → 字段名来自官方诊断脚本与样例数据，逻辑同构
         workDetail → 已核对（官方文档列了完整字段清单）
     · 路径来源分三级，界面要分得清，不能把"官方目录写着"冒充成"已实测"：
         tested             → 实跑过
         official-directory → 红狐官网 API 目录列出，未实跑
         official-doc       → 官方文档页给出，可能标注未上线

   单次计价：account 0.6 积分，works 0.4 积分，三个搜索类 0.6 积分（均由接口实测返回）
   ============================================================ */
import { ConnectorError } from './contract.js';

const HTTP_TIMEOUT = 20000;

/** 红狐平台统一成功码 */
export const SUCCESS_CODE = 2000;

/** 积分不足的错误码 */
export const CODE_INSUFFICIENT_CREDITS = 3201;

export const endpointSpec = {
  account: {
    method: 'POST',
    path: '/story/api/dyUser/query',
    verified: true,          // 路径 + 鉴权已实测
    bodyVerified: false,     // 请求体未实跑成功，标注清楚
    creditCost: 0.6,
    note: '抖音账号维度（粉丝、获赞、作品总数、红狐指数、地区）',
    bodySpec: {
      required: ['source'],
      oneOf: ['accountIds', 'accountNames'],
      note: 'accountIds 传抖音号数组，accountNames 传昵称数组。抖音号优先，昵称不唯一。',
    },
  },
  works: {
    method: 'POST',
    path: '/story/api/dy/data/listWorkByAccount',
    verified: true,
    bodyVerified: true,
    creditCost: 0.4,
    note: '按账号拉近期作品列表（≤50 条/页），账号信息嵌在每条作品的 author* 字段里',
    /** 分页参数名未核对（官方说明支持分页但没给字段名），
        所以现在一次调用最多拿到一页，上层不要假设能翻页翻到底。 */
    paginationVerified: false,
    bodySpec: {
      required: ['uniqueName', 'source'],
      note: 'uniqueName 传抖音号。中文昵称不唯一，官方脚本直接拒绝。',
    },
  },

  /* ---------------- 以下三个用于「线上营销」的账号监控与门店热度 ----------------
     路径全部取自红狐官网 API 目录（官方发布，不是猜的），但没有实跑成功过，
     因为账号积分余额为 0。所以 verified 一律为 false，并额外标出路径来源。
     诚实标注的用意：路径可信度高，但不能冒充"已实测"，界面上要说得清。 */
  searchAccount: {
    method: 'POST',
    path: '/story/api/dy/data/searchAccount',
    verified: false,
    pathSource: 'official-directory',
    pathNote: '路径见红狐官网 API 目录「搜索关键词获取抖音账号（广域库）」，未实跑验证',
    bodyVerified: false,
    bodyNote: '请求体字段名未核对，先按 keyword + source 构造',
    creditCost: 0.6,
    note: '按关键词搜抖音账号，用于发现对标账号',
    bodySpec: { required: ['keyword', 'source'] },
  },
  searchWork: {
    method: 'POST',
    path: '/story/api/dy/data/searchWork',
    verified: false,
    pathSource: 'official-directory',
    pathNote: '路径见红狐官网 API 目录「搜索关键词获取抖音作品（广域库）」，未实跑验证',
    bodyVerified: false,
    bodyNote: '请求体字段名未核对，先按 keyword + source 构造',
    creditCost: 0.6,
    note: '按关键词搜抖音作品，用于门店热度的近似召回',
    bodySpec: { required: ['keyword', 'source'] },
  },
  workDetail: {
    method: 'POST',
    path: '/story/api/dy/data/workDetail',
    verified: false,
    pathSource: 'official-doc',
    pathNote: '路径与请求体见官方文档页，但该页标注「即将上线」，当前不可用',
    live: false,
    bodyVerified: true,
    creditCost: 0.6,
    note: '作品详情。官方字段清单里只有 commentCount，没有评论内容，所以它解决不了"评论区讨论"',
    bodySpec: { required: ['videoId'], note: 'videoId 对应 aweme_id，已从官方文档核实' },
  },

  /**
   * 抖音账号赛道榜（官方榜位）
   * ------------------------------------------------------------
   * 这是红狐目前唯一返回「官方榜位」的接口：响应里的 accountRanking 就是平台给的排名，
   * 不是我们自己算的。但它有两个必须先说清的边界：
   *   1. type 是赛道维度，不是地区维度。没有城市参数，「重庆榜」拿不到。
   *   2. 口径是内容维度（总粉丝 + 涨粉 + 点赞/评论/分享增量加权），
   *      不含曝光、转化、开口。那三个指标只有商家自己的后台才有。
   * 请求体与响应字段均取自官方 API 文档页（含请求示例与响应示例），
   * 但账号积分余额为 0，还没实跑成功，所以 verified 仍为 false。
   */
  topAccounts: {
    method: 'POST',
    path: '/story/api/dyData/query',
    verified: false,
    pathSource: 'official-doc',
    pathNote: '路径、请求体、响应字段均见官方 API 文档页（douyin/20060017），含完整示例，但未实跑验证',
    bodyVerified: true,
    creditCost: 0.6,
    note: '赛道榜日/周/月 TOP50，返回官方榜位与综合评分。无地域筛选',
    bodySpec: {
      required: ['dateType', 'rankDate', 'type'],
      note: 'dateType: days|weeks|months；rankDate: yyyy-MM-dd（日榜传所需日，周榜传周一，月榜传月一号）；type: 赛道名',
    },
  },
};

export const authSpec = {
  mode: 'api-key',
  headerName: 'X-API-KEY',         // 实测确认
  extraHeaders: {},
  secretIn: 'proxy',               // 浏览器端零密钥；取数走 server/proxy.mjs 或 Node CLI
  envVars: ['REDFOX_API_KEY'],
  baseUrl: 'https://redfox.hk',    // 云服务固定地址，不需要门店网关
  note: '密钥格式 ak_xxx，在 redfox.hk 个人中心获取。只读接口，不写回任何数据。',
};

/* ============================================================
   字段映射
   ------------------------------------------------------------
   注意：红狐两个接口的作品字段名并不一致！
     · works  接口用 content / publishTime / likeCount / opusUrl
     · account 接口内嵌 works 用 title / createTime / diggCount / workUrl
   所以这里必须维护四张表，不能合并。合并就会静默丢字段。
   ============================================================ */
export const mapping = {
  /** account 接口：data[] 里的账号维度 */
  account: [
    { target: 'remoteId', source: 'accountId', transform: 'text' },
    { target: 'nickname', source: 'nickname', transform: 'text' },
    { target: 'secUid', source: 'secUid', transform: 'text' },
    { target: 'avatarUrl', source: 'avatarUrl', transform: 'text' },
    { target: 'signature', source: 'signature', transform: 'text' },
    { target: 'followerCount', source: 'followerCount', transform: 'int' },
    { target: 'awemeCount', source: 'awemeCount', transform: 'int' },
    { target: 'totalFavorited', source: 'totalFavorited', transform: 'int' },
    { target: 'redfoxIndex', source: 'redfoxIndex', transform: 'float' },
    { target: 'region', source: 'ipLocation', transform: 'text' },
    { target: 'crawlTime', source: 'crawlTime', transform: 'datetime' },
  ],

  /** account 接口内嵌的作品 */
  worksFromAccount: [
    { target: 'remoteId', source: 'awemeId', transform: 'text' },
    { target: 'title', source: 'title', transform: 'text' },
    { target: 'createTime', source: 'createTime', transform: 'datetime' },
    { target: 'diggCount', source: 'diggCount', transform: 'int' },
    { target: 'commentCount', source: 'commentCount', transform: 'int' },
    { target: 'shareCount', source: 'shareCount', transform: 'int' },
    { target: 'collectCount', source: 'collectCount', transform: 'int' },
    { target: 'playCount', source: 'playCount', transform: 'int' },
    { target: 'interactiveCount', source: 'interactiveCount', transform: 'int' },
    { target: 'url', source: 'workUrl', transform: 'text' },
    { target: 'coverUrl', source: 'coverUrl', transform: 'text' },
  ],

  /** works 接口：data.list[] 里的作品 */
  works: [
    { target: 'remoteId', source: 'videoId', transform: 'text' },
    { target: 'title', source: 'content', transform: 'text' },
    { target: 'createTime', source: 'publishTime', transform: 'datetime' },
    { target: 'diggCount', source: 'likeCount', transform: 'int' },
    { target: 'commentCount', source: 'commentCount', transform: 'int' },
    { target: 'shareCount', source: 'shareCount', transform: 'int' },
    { target: 'collectCount', source: 'collectCount', transform: 'int' },
    { target: 'playCount', source: 'playCount', transform: 'int' },
    { target: 'interactiveCount', source: 'interactiveCount', transform: 'int' },
    { target: 'url', source: 'opusUrl', transform: 'text' },
    { target: 'coverUrl', source: 'coverUrl', transform: 'text' },
  ],

  /** works 接口把账号信息塞在每条作品的 author* 里，这是降级取账号维度的通道 */
  accountFromWork: [
    { target: 'remoteId', source: 'authorUniqueId', transform: 'text' },
    { target: 'nickname', source: 'authorName', transform: 'text' },
    { target: 'secUid', source: 'authorSecUid', transform: 'text' },
    { target: 'avatarUrl', source: 'authorAvatarUrl', transform: 'text' },
    { target: 'followerCount', source: 'authorFansCount', transform: 'int' },
  ],

  /** 关键词搜账号。字段名未核对，先按账号维度的命名复用，
     跑通后如果对不上，改这一张表就行，不用动业务层。 */
  searchAccount: [
    { target: 'remoteId', source: 'accountId', transform: 'text' },
    { target: 'nickname', source: 'nickname', transform: 'text' },
    { target: 'secUid', source: 'secUid', transform: 'text' },
    { target: 'avatarUrl', source: 'avatarUrl', transform: 'text' },
    { target: 'signature', source: 'signature', transform: 'text' },
    { target: 'followerCount', source: 'followerCount', transform: 'int' },
    { target: 'awemeCount', source: 'awemeCount', transform: 'int' },
    { target: 'totalFavorited', source: 'totalFavorited', transform: 'int' },
    { target: 'redfoxIndex', source: 'redfoxIndex', transform: 'float' },
    { target: 'region', source: 'ipLocation', transform: 'text' },
  ],

  /** 关键词搜作品。字段名未核对，先按 works 的命名复用。
     额外取 authorName / authorUniqueId，因为门店热度要按账号聚合。 */
  searchWork: [
    { target: 'remoteId', source: 'videoId', transform: 'text' },
    { target: 'title', source: 'content', transform: 'text' },
    { target: 'createTime', source: 'publishTime', transform: 'datetime' },
    { target: 'diggCount', source: 'likeCount', transform: 'int' },
    { target: 'commentCount', source: 'commentCount', transform: 'int' },
    { target: 'shareCount', source: 'shareCount', transform: 'int' },
    { target: 'collectCount', source: 'collectCount', transform: 'int' },
    { target: 'playCount', source: 'playCount', transform: 'int' },
    { target: 'url', source: 'opusUrl', transform: 'text' },
    { target: 'coverUrl', source: 'coverUrl', transform: 'text' },
    { target: 'authorName', source: 'authorName', transform: 'text' },
    { target: 'authorUniqueId', source: 'authorUniqueId', transform: 'text' },
  ],

  /**
   * 赛道榜。字段名全部取自官方 API 文档页的响应字段表。
   * 粉丝数与三个增量在文档里都是字符串（如 "179.79w"），
   * 所以用 cnNum 而不是 int：直接 int 会得到 179，差三个数量级。
   */
  topAccounts: [
    { target: 'rank', source: 'accountRanking', transform: 'int' },
    { target: 'nickname', source: 'accountName', transform: 'text' },
    { target: 'url', source: 'accountLink', transform: 'text' },
    { target: 'category', source: 'category', transform: 'text' },
    { target: 'score', source: 'comprehensiveScore', transform: 'float' },
    { target: 'followerCount', source: 'fansCount', transform: 'cnNum' },
    { target: 'fansGrowth', source: 'fansGrowth', transform: 'cnNum' },
    { target: 'likedGrowth', source: 'likedGrowth', transform: 'cnNum' },
    { target: 'commentsGrowth', source: 'commentsGrowth', transform: 'cnNum' },
    { target: 'sharedGrowth', source: 'sharedGrowth', transform: 'cnNum' },
    { target: 'rankDate', source: 'rankDate', transform: 'text' },
    { target: 'rankPeriod', source: 'rankPeriod', transform: 'text' },
  ],
};

/** 关键词搜索类资源的字段表（业务层取值时用） */
export const SEARCH_MAPPING = {
  searchAccount: mapping.searchAccount,
  searchWork: mapping.searchWork,
};

/** 哪些资源产出什么，供上层选择调用哪个 */
export const RESOURCE_LAYERS = {
  account: { label: '账号维度', fields: 'ACCOUNT_FIELDS', cost: 0.6 },
  works: { label: '作品列表', fields: 'WORK_FIELDS', cost: 0.4 },
};

/* ============================================================
   请求构造
   ============================================================ */
export function buildRequest(cfg, resource, params = {}) {
  const spec = endpointSpec[resource];
  if (!spec) throw new ConnectorError('unknown_resource', `红狐未定义资源：${resource}`);

  const source = params.source || cfg.sourceTag || 'FitFlow';
  let body;

  if (resource === 'account') {
    const ids = params.accountIds || (params.account ? [params.account] : []);
    if (!ids.length) {
      throw new ConnectorError('bad_request', 'account 资源需要 accountIds（抖音号数组）');
    }
    body = { source, accountIds: ids };

  } else if (resource === 'works') {
    const name = params.uniqueName || params.account;
    if (!name) throw new ConnectorError('bad_request', 'works 资源需要 uniqueName（抖音号）');
    body = { uniqueName: name, source };

  } else if (resource === 'searchAccount' || resource === 'searchWork') {
    const keyword = params.keyword;
    if (!keyword) throw new ConnectorError('bad_request', `${resource} 资源需要 keyword`);
    body = { keyword, source };

  } else if (resource === 'workDetail') {
    const videoId = params.videoId;
    if (!videoId) throw new ConnectorError('bad_request', 'workDetail 资源需要 videoId');
    body = { videoId };

  } else if (resource === 'topAccounts') {
    const { dateType = 'days', rankDate, type } = params;
    if (!rankDate) throw new ConnectorError('bad_request', 'topAccounts 资源需要 rankDate（yyyy-MM-dd）');
    if (!type) throw new ConnectorError('bad_request', 'topAccounts 资源需要 type（赛道名）');
    body = { dateType, rankDate, type };

  } else {
    throw new ConnectorError('unknown_resource', `红狐未定义资源：${resource}`);
  }

  return {
    provider: 'redfox',
    method: spec.method,
    path: spec.path,
    query: {},
    body,
    verified: spec.verified,
    bodyVerified: spec.bodyVerified,
    live: spec.live !== false,
    pathSource: spec.pathSource || 'tested',
    creditCost: spec.creditCost,
    timeoutMs: cfg.timeoutMs || HTTP_TIMEOUT,
  };
}

/* ============================================================
   返回体解析
   ------------------------------------------------------------
   红狐统一信封：{ code, msg, data }，code === 2000 为成功。
   这里把业务错误码翻译成人能看懂的话，避免上层拿到 null 后瞎猜。
   ============================================================ */
export function readEnvelope(json) {
  if (!json || typeof json !== 'object') {
    throw new ConnectorError('parse', '返回体不是 JSON 对象，无法解析');
  }
  const code = json.code;
  const msg = json.msg || '';

  if (code === SUCCESS_CODE) return { code, msg, data: json.data };

  if (code === CODE_INSUFFICIENT_CREDITS) {
    /* 平台自己的 msg 已经带了具体数字（本次调用多少积分、剩余多少），
       直接用它，不要再套一层"积分不足"，否则同一句话说两遍。 */
    throw new ConnectorError(
      'insufficient_credits',
      msg || '红狐积分余额不足，业务调用被拒绝执行。',
      { code, rechargeUrl: 'https://redfox.hk/dashboard/recharge' }
    );
  }
  throw new ConnectorError('api', `红狐返回错误(code=${code})：${msg}`, { code, msg });
}

/**
 * 从成功信封里把列表扒出来。
 * account → data 本身是数组
 * works   → data.list 是数组，data.total 是总数
 */
export function parseList(json) {
  const { data } = readEnvelope(json);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.list)) return data.list;
  return [];
}

/** works 接口的 data.total（作品总数），拿不到返回 null */
export function parseTotal(json) {
  const data = json?.data;
  const t = data && (data.total ?? data.totalCount);
  return t == null ? null : Number(t);
}

/** 从一条作品里提取作者的账号维度（works 接口的降级通道） */
export function extractAccountFromWork(work) {
  if (!work || typeof work !== 'object') return null;
  const out = {};
  let hit = 0;
  mapping.accountFromWork.forEach(({ target, source }) => {
    const v = work[source];
    if (v !== undefined && v !== null && v !== '') { out[target] = v; hit += 1; }
  });
  /* 一个 author* 字段都没命中，说明结构变了，返回 null 而不是空对象 */
  return hit ? out : null;
}

/* ============================================================
   端点与积分自检
   ------------------------------------------------------------
   这个函数不带业务语义，只回答三个问题：
     1. 端点通不通（HTTP）
     2. 鉴权过不过
     3. 积分够不够
   在"UI 先不接"的阶段，用它和 CLI 判断链路状态最省事。
   ============================================================ */
export async function probe({ apiKey, baseUrl = authSpec.baseUrl, account = 'douyin' } = {}) {
  const rows = [];
  for (const [resource, spec] of Object.entries(endpointSpec)) {
    const started = Date.now();
    try {
      const body = resource === 'account'
        ? { source: 'FitFlow 自检', accountIds: [account] }
        : { uniqueName: account, source: 'FitFlow 自检' };
      const res = await fetch(baseUrl.replace(/\/$/, '') + spec.path, {
        method: spec.method,
        headers: { 'Content-Type': 'application/json', [authSpec.headerName]: apiKey || '' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT),
      });
      const json = await res.json().catch(() => null);
      const ms = Date.now() - started;
      rows.push({
        resource,
        path: spec.path,
        http: res.status,
        code: json?.code ?? null,
        msg: json?.msg || '',
        ok: json?.code === SUCCESS_CODE,
        credits: spec.creditCost,
        ms,
      });
    } catch (e) {
      rows.push({
        resource, path: spec.path, http: null, code: null,
        msg: e.name === 'TimeoutError' ? '请求超时' : e.message,
        ok: false, credits: spec.creditCost, ms: Date.now() - started,
      });
    }
  }
  return rows;
}

export const meta = {
  id: 'redfox',
  name: '红狐数据',
  short: '红狐',
  vendor: 'redfox.hk',
  platform: '抖音',
  kind: 'content',                 // 关键：content，不是 gym
  logoText: '狐',
  logoFrom: '#C2472F',
  logoTo: '#8C2C20',
  knownScope: [
    '抖音账号维度', '抖音作品列表', '抖音关键词搜账号', '抖音关键词搜作品',
    '抖音账号赛道榜（含官方榜位）', '小红书搜索', '小红书爆款笔记库',
  ],
  /** 已知拿不到的东西，写在这里，免得以后有人以为漏做了。
      下面几条都是逐字段核对过官方 API 目录、官方文档页与返回结构之后写的，不是推测。 */
  notAvailable: [
    '小红书账号维度（粉丝 / 笔记表现）—— 红狐当前没有该接口',
    '抖音播放量（官方脚本注明可能为 null，按缺数据处理）',
    '门店定位（POI）维度 —— 全 API 目录无位置参数，也无门店 / 团购 / 商品类接口。门店热度只能用关键词近似召回',
    '评论区内容 —— 「获取抖音作品内容详情」的官方字段清单里只有 commentCount，没有评论列表，算不出讨论关联度',
    '绿标 / 白标带货标识 —— 属于抖音本地生活后台概念，红狐不暴露',
    '账号赛道榜的地域筛选 —— topAccounts 的 type 只接受赛道名，没有城市参数，「重庆榜」拿不到',
    '曝光 / 转化 / 开口 —— 这三个是商家后台私有的经营指标。红狐赛道榜给的是内容维度（粉丝 + 涨粉 + 点赞/评论/分享增量加权）。任何第三方平台都拿不到同行的曝光与开口，这是平台的数据边界，不是接口没开',
    '抖音官方本地生活商家榜 —— 只在抖音 App 内展示，没有公开 API。抖音来客开放平台只对商家自己的店开放（需企业认证 + 服务应用授权，且门店账号不支持对接，必须用总部账户）',
  ],
  /** 门店热度监控每一项的可得性，界面直接读这张表，不在视图里偷偷降级 */
  storeHeatNote: '四项里只有「账号排名」是本地算的，「门店定位视频」是关键词近似，另外两项要手工登记。逐项依据见 js/douyin.js 的 STORE_HEAT_ITEMS。',
  authLabel: 'API Key（redfox.hk 个人中心获取）',
  creditNote: '按调用计价：account 0.6 积分 / works 0.4 积分，余额为 0 时接口拒绝执行',
  fallback: '在「运营 → 线上营销」手动登记内容表现',
  baseUrl: authSpec.baseUrl,
  endpointSpec, authSpec, mapping, SEARCH_MAPPING,
  buildRequest, parseList, parseTotal, extractAccountFromWork, probe,
};
