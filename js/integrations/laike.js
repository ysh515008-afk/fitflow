/* ============================================================
   integrations/laike.js · 抖音来客（抖音生活服务商家后台）
   ------------------------------------------------------------
   这是「交易后台数据源」，既不是经营系统（会员），也不是内容源（账号作品）。
   它产出的是门店自己在这个平台上的经营漏斗：
     曝光 → 访问 → 开口 → 下单 → 核销

   接入可行性结论（2026-09 按官方文档核对）：

   1. **两条路都能走，而且单店走得通。**
      · 技术服务商：开放平台控制台 → 第三方生活服务商家应用（给多个商家服务）
      · 自研商家：抖音来客 PC 端 → 店铺管理 → 服务应用授权 → 商家自研服务
        → 入驻/绑定开发者 → 开放平台把行业角色认证成「生活服务商家」
        → 创建「生活服务商家应用」→ 解决方案里勾「门店管理」等能力
      所以「单店不能自助接入」这个说法不成立，来客账户本身就能绑定开发者身份。
      但要注意：**应用审核通过 ≠ 能力已开通**，能力要单独在「解决方案」里申请，
      没开通就调会报错 2190004。
      连锁多级账号场景下，要用总部账户做对接，门店账号取不到全量数据。

   2. **接口能给到的是交易与履约，不是流量。**
      翻开放能力概览（2025-11-13 版）能看到，所有解决方案都是交易类：
      团购核销、商品发布与查询、订单查询、账单结算、三方码、门店关联匹配、
      线索查询、会员绑定。**没有曝光 / 页面访问 / 私信开口 / 投放消耗 这类
      流量漏斗能力。** 这几项只在来客后台能看到，只能靠后台导出。
      这和本文件早先把它们写进「接口能给到的」是矛盾的，那处已修正。

   3. 同行的曝光 / 开口 / 转化：**拿不到，且不是接口没开。**
      开放平台只把数据授权给商家自己，服务商也只能拿自己签约商家的数据。
      这是平台的数据边界。任何声称能拿到同行开口数据的第三方，都在编。

   4. 实时数据：**没有。** 官方口径是「T+1 时效内即可满足相关数据获取」。

   所以这一版的形态是：
     · endpointSpec 里没有核对过的路径仍是**占位**，标 pathSource: 'placeholder'。
       我不编造看起来很像真的官方路径，因为那会让人以为核对过了。
       已经核对到的（路径前缀、鉴权头、授权入口、SLA）写实测值。
     · 真正现在就能用的是 **后台导出报表粘贴导入**，
       走 bizMetrics.js 的口径层落地成结构化记录。这条路不依赖任何授权。
   ============================================================ */
import { ConnectorError } from './contract.js';

/** 来客接口的公共约定。核对自「OpenAPI接口调用约定」与各接口文档页 */
export const apiConvention = {
  host: 'open.douyin.com',
  /** 生活服务的路径前缀是 goodlife，不是 life */
  pathPrefix: '/goodlife/v1',
  headers: {
    'access-token': { required: true, desc: '调用凭证，由 /oauth/client_token/ 生成（client_token，不是用户 access_token）' },
    'content-type': { required: true, desc: '固定 application/json' },
    'Rpc-Transit-Life-Account': { required: false, desc: '来客商户根账户 ID，多门店场景用它定位到具体商户' },
  },
  tokenUrl: 'https://open.douyin.com/oauth/client_token/',
  /** 响应体固定三段：data 传数据，extra 带附属信息，base_resp 三方可忽略 */
  responseShape: 'data / extra / base_resp；data.error_code === 0 表示成功',
  credentials: {
    clientKey: { desc: '即 APPID。自研商家在控制台 → 我的应用 → 生活服务商家应用 → 基础信息查' },
    clientSecret: { desc: '即 AppSecret。同上页面，不要走群聊/邮件/工单传递' },
    accountId: { desc: '来客账户 ID。商家从 PC 来客右上角，或来客 App → 我 → 置顶个人信息获取' },
  },
  sla: '最大 QPS 50，PCT99 承诺 1000ms',
  freshness: 'T+1',
};

/** 解决方案枚举。选错解决方案，下面的能力一个都开不了 */
export const SOLUTIONS = {
  1: '到店餐饮', 4: '到综行业', 5: '随心团', 8: '酒店新预售券', 9: '酒店日历房',
  10: '景区日历票', 11: '景区团购', 14: '度假预售券', 15: '度假日历品',
};
/** 运动健身归在到综行业，不是餐饮 */
export const SOLUTION_FOR_FITNESS = 4;

export const endpointSpec = {
  /**
   * 门店关联与匹配。这是接任何来客接口的前置：先用它把外部门店 ID
   * 和抖音 POI 建立映射，后面所有按门店取数才成立。
   * 路径前缀 /goodlife/v1 已核对（见买单门店列表查询、商品线上数据查询两页），
   * 但本资源的完整路径仍需在自研/服务商文档里确认。
   */
  shopBind: {
    method: 'POST',
    path: '/goodlife/v1/poi/bind/query',
    verified: false,
    pathSource: 'placeholder',
    pathNote: '占位路径。前缀 /goodlife/v1 已按官方文档核对（买单门店列表查询用的是 /goodlife/v1/homed/poi/payment/query/），但本资源的尾段需自查后替换。',
    note: '门店关联与匹配：建立外部门店 ID 与抖音 POI 的映射',
    businessSolution: SOLUTION_FOR_FITNESS,
    bodySpec: { required: ['out_shop_id'] },
  },
  /** 核销能力。这是来客开放得最彻底的一块，也是第三方 SaaS 用得最多的 */
  verify: {
    method: 'POST',
    path: '/goodlife/v1/verify/query',
    verified: false,
    pathSource: 'placeholder',
    pathNote: '占位路径，未核对。核销是来客正式开放的能力，路径需在对应解决方案文档里查。',
    note: '团购核销与退款：券码校验、核销、撤销、对账',
    businessSolution: SOLUTION_FOR_FITNESS,
    bodySpec: { required: ['verify_token'] },
  },
  orderStat: {
    method: 'POST',
    path: '/goodlife/v1/order/query',
    verified: false,
    pathSource: 'placeholder',
    pathNote: '占位路径，未核对。订单查询按解决方案分别授权（到综 / 到店餐饮 等各自一条）。',
    note: '订单查询：订单列表、状态、金额、核销情况',
    businessSolution: SOLUTION_FOR_FITNESS,
    bodySpec: { required: ['account_id', 'dateRange'] },
  },
  /** 线索查询。开放能力清单里唯一和「意向客户」沾边的能力 */
  leadQuery: {
    method: 'POST',
    path: '/goodlife/v1/lead/query',
    verified: false,
    pathSource: 'placeholder',
    pathNote: '占位路径，未核对。「线索管理解决方案 · 线索查询」是公开清单里存在的能力，但字段口径（能不能覆盖后台的「私信开口」）需自查确认。',
    note: '线索查询：留资线索，最接近后台口径里的「开口」',
    businessSolution: SOLUTION_FOR_FITNESS,
    bodySpec: { required: ['dateRange'] },
  },
};

export const authSpec = {
  mode: 'oauth2-client',
  headerName: 'access-token',
  /** 这两个 Header 必须同时带，只带 access-token 多门店场景会定位不到商户 */
  extraHeaders: { 'content-type': 'application/json', 'Rpc-Transit-Life-Account': '<account_id>' },
  secretIn: 'proxy',
  envVars: ['LAIKE_CLIENT_KEY', 'LAIKE_CLIENT_SECRET', 'LAIKE_ACCOUNT_ID'],
  note: '先申请权限（控制台 → 应用详情 → 解决方案 → 开通能力），再由商家授权（来客 → 店铺管理 → 第三方应用授权）。client_token 由本地代理进程换取，前端只拿 account_id。',
  /** 授权链接由服务商/自研方拼装，商家点开就授权，24 小时内有效 */
  authUrl: {
    base: 'https://auth.dylk.com/auth-isv/',
    params: ['client_key', 'timestamp', 'solution_key', 'permission_keys', 'charset', 'sign'],
    validity: '24 小时',
    note: 'sign 参与签名计算。微信内被拦时补 new_host=1 可跳新域名。',
  },
  knownPitfall: '应用审核通过不等于能力开通。调不通先看错误码 2190004，那是能力未审核通过。',
};

/** 报表导入用的列说明。这一版真正可用的链路就是它。 */
export const reportSpec = {
  where: '来客后台 → 数据 → 经营概览 / 私信数据，选按日导出',
  requiredAny: ['曝光人数', '页面访问', '开口人数'],
  rows: [
    { label: '日期列', hint: '如「统计日期」。有这一列才能导入多天；没有就按今天记一条' },
    { label: '曝光人数', hint: '接口里取不到，只能从后台导。没导这一列也行，缺的那一环会显示「未获取」，不会补 0' },
    { label: '页面访问', hint: '有的版本叫「商品访问人数」' },
    { label: '开口人数', hint: '私信会话人数。接口侧的线索查询能否覆盖它待确认，所以优先从后台导这一列' },
    { label: '下单人数 / 核销人数', hint: '能同一张表导出就一起导，下单到核销的落差用来盯「买了不来」' },
  ],
  tip: '导出后不用改列名，FitFlow 按别名自动匹配。识别不到的列会在导入预览里列出来，告诉你是哪几列没吃进去。',
};

export const meta = {
  id: 'laike',
  name: '抖音来客',
  short: '来客',
  vendor: '抖音生活服务',
  platform: '抖音',
  kind: 'biz',
  logoText: '来',
  logoFrom: '#2F2F35',
  logoTo: '#141418',

  availability: 'partner-required',
  availabilityLabel: '需商家授权',
  verdict: '单店也能自助接入（来客后台绑定开发者身份，走商家自研服务），不用总部账户。但接口开放的是交易与履约能力，曝光 / 访问 / 开口这些流量数据在开放能力清单里没有，只能从后台导出。',

  /** 这是「接口能给到的」，不是「后台能看到的」。两者不能混，混了会让人以为能直接取流量 */
  knownScope: ['门店关联与匹配', '团购核销与退款', '商品发布与查询', '订单查询', '账单与结算', '三方码', '线索查询', '会员绑定'],

  notAvailable: [
    '曝光 / 页面访问 / 私信开口 / 投放消耗：开放能力清单里没有对应的数据类解决方案，这几项只能从来客后台导出报表',
    '同行的曝光 / 开口 / 转化：开放平台只授权给商家自己，服务商也只能拿自己签约商家的数据',
    '实时数据：官方口径是 T+1，没有秒级数据',
    '评论内容文本：只有数量，没有评论文本，做不了语义分析',
    '连锁门店账号取全量：多级账号场景需用总部账户做对接，门店账号拿不到全量数据',
  ],

  /** 现在就能用的路，写在界面上，避免用户以为"没接通就什么都做不了" */
  fallback: '来客后台导出经营报表 → 粘贴导入（不依赖任何授权，今天就能用）',

  /** 公共约定与解决方案表挂到 meta 上，界面直接读，不用再 import 一次 */
  convention: apiConvention,
  solutions: SOLUTIONS,
  solutionForFitness: SOLUTION_FOR_FITNESS,

  endpointSpec,
  authSpec,
  reportSpec,

  buildRequest(cfg, resource, params = {}) {
    const spec = endpointSpec[resource];
    if (!spec) throw new ConnectorError('unknown_resource', `抖音来客未定义资源：${resource}`);
    const query = { ...(spec.method === 'GET' ? params : {}) };
    if (cfg.poiId || cfg.baseUrl) { /* 值由本地代理补齐，前端只传业务参数 */ }
    return {
      provider: 'laike',
      method: spec.method,
      host: apiConvention.host,
      path: spec.path,
      query,
      body: spec.method === 'GET' ? null : params,
      verified: spec.verified,
      timeoutMs: cfg.timeoutMs || 20000,
    };
  },

  /** 列表在哪个层级，各平台写法不一，这里沿用容错扒取的策略 */
  parseList(json) {
    if (!json) return [];
    if (Array.isArray(json)) return json;
    const cands = [
      json?.data?.list, json?.data?.records, json?.data?.items, json?.data?.rows,
      json?.list, json?.records, json?.items, json?.data,
    ];
    for (const c of cands) if (Array.isArray(c)) return c;
    return [];
  },
};
