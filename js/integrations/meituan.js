/* ============================================================
   integrations/meituan.js · 美团经营宝（到店商家后台）
   ------------------------------------------------------------
   接入可行性结论（2026-09 按官方文档核对，推翻了本文件早先的
   「无公开接口」判断，那段是错的，留在这里当记录）：

   1. **有真实的流量数据接口，而且字段正好对得上我们的漏斗。**
      美团技术服务合作中心 · 生活服务 · 服务零售 · 经营数据API
      POST https://api-open-cater.meituan.com/ddzh/merchantdata/poitraffic
      返回 viewUv / shopUv / buyUv / consumeUv / bookUv / pageTime，
      分别对应曝光 / 商详页访问 / 下单 / 核销 / 预约客资 / 停留时长。
      健身在美团侧归属「服务零售」（businessId=58），不是餐饮，
      所以走的不是团购核销那条业务线。

   2. **但门槛比抖音来客高一档，单店基本走不通。**
      要拿数据得先入驻合作中心，可选身份是三方服务商 / 连锁品牌 / 个人开发者。
      连锁品牌入驻要求用**品牌总部的营业资质**申请，且执照要与签约的
      营业执照一致，并且**必须先联系业务经理确认合作协议**，不是自助申请。
      自研还要求申请主体是连锁企业（餐饮类明写「同一品牌门店数 ≥ 30 家
      且日均外卖订单数 ≥ 1000 单」，服务零售的口径需与业务经理确认）。
      一家单店健身工作室，卡在第一步。

   3. **时效比抖音还慢一天。** 查询窗口「不得超过 30 天，且 endDate 最晚为
      两天前」，也就是 T+2 才有数，不是 T+1。

   4. 同行的曝光 / 咨询：拿不到，只授权给商家自己。

   所以这一版的形态和来客保持一致：
     · 有官方文档可核对的端点标 verified: true，并写明文档出处；
       没有核对到的仍然是占位，标 pathSource: 'placeholder'，不冒充核对过。
     · 真正现在就能用的是 **经营宝后台导出报表粘贴导入**，
       走 bizMetrics.js 的同一套口径，两个平台的数据能并排比较。
       note：后台看板的字段名与接口字段名不同（看板叫「曝光量」「访客数」），
       bizMetrics 的别名表两边都覆盖了，粘哪份都能认。
   ============================================================ */
import { ConnectorError } from './contract.js';

export const endpointSpec = {
  /**
   * 唯一一个按官方文档核对过的端点。
   * 出处：developer.meituan.com/docs/api/ddzh-merchantdata-poitraffic
   */
  poiTraffic: {
    method: 'POST',
    host: 'api-open-cater.meituan.com',
    path: '/ddzh/merchantdata/poitraffic',
    contentType: 'application/x-www-form-urlencoded;charset=utf-8',
    verified: true,
    pathSource: 'official-doc',
    docRef: '美团技术服务合作中心 > 生活服务 > 服务零售 > 经营数据API > 获取门店流量数据',
    note: '门店流量数据：曝光 / 商详页访问 / 下单 / 核销 / 预约客资 / 停留时长',
    businessId: 58,
    /** 业务参数。公共参数（developerId / sign / timestamp / appAuthToken）由本地代理补齐 */
    params: {
      platform: { required: true, desc: 'MT 美团 / DP 大众点评 / ALL 两者合计' },
      startDate: { required: true, desc: 'yyyy-MM-dd' },
      endDate: { required: true, desc: 'yyyy-MM-dd，且不得晚于两天前' },
    },
    /** 响应字段到FitFlow 口径的对应。这张表是这一版最有价值的东西，别丢 */
    responseMap: {
      viewUv: '曝光人数',
      shopUv: '商详页访问人数',
      buyUv: '下单人数',
      consumeUv: '到店核销人数',
      bookUv: '预约人数（客资数）',
      pageTime: '页面停留时长（秒）',
    },
    limits: [
      '单次查询时间跨度不得超过 30 天',
      'endDate 最晚只能是两天前（数据 T+2，比来客的 T+1 更慢）',
      '需要业务授权：门店绑定授权，或商家用经营宝 App 扫码授权（App ≥ 9.40.100）',
    ],
  },

  /**
   * 评价相关。合作中心的业务清单里「到店餐饮评价（美团评价）」是独立的业务线
   * （businessId=53，即到店餐饮评价），说明评价数据确实在开放范围内，
   * 但具体端点和字段我没在公开文档里核到，所以保持占位。
   */
  reviewStat: {
    method: 'POST',
    host: 'api-open-cater.meituan.com',
    path: '/ddzh/merchantdata/review',
    verified: false,
    pathSource: 'placeholder',
    pathNote: '占位路径，未核对。评价业务在合作中心是独立业务线（businessId=53），端点需在你的资质下自查后替换。',
    note: '门店评价数量与评分',
    params: { startDate: { required: true }, endDate: { required: true } },
  },
};

export const authSpec = {
  mode: 'appkey-sign',
  headerName: 'appAuthToken',
  extraHeaders: {},
  secretIn: 'proxy',
  /** 公共参数里 sign 由 appSecret 生成，整段签名在本地代理完成，前端不持有密钥 */
  publicParams: ['developerId', 'businessId', 'charset', 'sign', 'timestamp', 'version'],
  envVars: ['MEITUAN_APP_KEY', 'MEITUAN_APP_SECRET', 'MEITUAN_POI_ID'],
  note: '需要先入驻美团技术服务合作中心（三方服务商 / 连锁品牌）。连锁品牌要求品牌总部资质 + 业务经理签约。签名在本地代理进程完成，前端不持有任何密钥。',
  /** 授权方式两条，扫码那条对商家最省事 */
  authFlows: [
    { name: '门店绑定授权', how: '开发者中心 → 常用工具 → 门店绑定授权，把授权链接发给商家，商家登录后完成' },
    { name: '经营宝 App 扫码授权', how: '商家用经营宝 App（≥ 9.40.100）扫一扫完成，免登录', urlPattern: 'https://open-erp.meituan.com/storemap?developerId=…&businessId=…&ePoiId=…' },
  ],
  /** 这条限制很实际，写出来免得以后排查半天 */
  quotaNote: '一个门店最多同时授权给 5 个应用。',
};

export const reportSpec = {
  where: '经营宝 → 数据中心 → 流量 / 交易看板，选按日导出（有的版本叫「下载明细」）',
  requiredAny: ['曝光人数', '访问人数', '咨询人数'],
  rows: [
    { label: '日期列', hint: '如「日期」或「统计日期」。有它才能一次导多天' },
    { label: '曝光人数', hint: '接口侧叫 viewUv，看板里可能叫「曝光量」，别名已经覆盖' },
    { label: '访问人数', hint: '接口侧叫 shopUv（商详页访问人数），看板里也叫「访客数」' },
    { label: '预约 / 客资人数', hint: '接口侧叫 bookUv。这是最接近「意向线索」的一列，优先导它' },
    { label: '下单人数 / 核销人数', hint: '交易看板里导出，和流量看板分开导也没关系，日期对得上就能合并' },
  ],
  tip: '流量看板和交易看板通常要分两次导出。先导流量那份，再导交易那份，FitFlow 按日期合并，同一天不会重复计数。',
};

export const meta = {
  id: 'meituan',
  name: '美团经营宝',
  short: '经营宝',
  vendor: '美团到店',
  platform: '美团',
  kind: 'biz',
  logoText: '美',
  logoFrom: '#FFC300',
  logoTo: '#E8A400',

  availability: 'brand-required',
  availabilityLabel: '需品牌资质',
  verdict: '接口是真实存在的（服务零售 → 经营数据API，曝光 / 访问 / 下单 / 核销 / 客资都能取），但门槛比来客高：要用品牌总部资质申请、需业务经理签约，单店走不通。数据 T+2。',

  knownScope: ['曝光人数', '商详页访问', '预约客资数', '团购下单', '到店核销', '页面停留时长', '门店评价'],

  notAvailable: [
    '单店自助接入：连锁品牌入驻要求品牌总部资质，且需先与业务经理签约，没有自助申请通道',
    '同行的曝光 / 咨询数据：只授权给商家自己',
    '实时数据：接口查询窗口要求 endDate 最晚为两天前，数据本身就是 T+2',
    '超过 30 天的单次查询：一次最多取 30 天，拉长周期得分段取',
    '私信 / 咨询会话明细：公开文档里没有对应接口，只有 bookUv 这一个汇总数（客资数）',
  ],

  fallback: '经营宝数据中心导出流量 / 交易看板 → 粘贴导入（两条看板分两次导，按日期自动合并）',

  endpointSpec,
  authSpec,
  reportSpec,

  buildRequest(cfg, resource, params = {}) {
    const spec = endpointSpec[resource];
    if (!spec) throw new ConnectorError('unknown_resource', `美团经营宝未定义资源：${resource}`);
    return {
      provider: 'meituan',
      method: spec.method,
      host: spec.host,
      path: spec.path,
      contentType: spec.contentType,
      /** 业务参数放 query，公共参数（developerId / sign / timestamp / appAuthToken）由代理补 */
      query: params,
      body: spec.method === 'GET' ? null : params,
      verified: spec.verified,
      timeoutMs: cfg.timeoutMs || 20000,
    };
  },

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
