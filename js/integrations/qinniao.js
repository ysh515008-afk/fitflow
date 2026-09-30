/* ============================================================
   integrations/qinniao.js · 勤鸟（Rocket Bird）对接适配器
   ------------------------------------------------------------
   已知信息（来自勤鸟官网与公开资料）：
     · 厂商：重庆勤鸟圈科技有限公司，官网 rocketbird.cn
     · 产品：勤鸟健身房 SaaS 管理系统（会员 CRM / 会籍设定 / 团操课 /
       场地管理 / 合同管理 / 聚合支付 / 数据看板 / 营销触达）
     · 硬件：指静脉、刷掌、人脸、RFID 手环、智能体测仪、智能闸机
     · 官网明确说明「只需做简单的 API 数据对接」即可与第三方平台打通
   尚未确认（因此以下全部标 verified:false，禁止在未核对前调用）：
     · 开放平台是否对普通门店开放、如何申请（一般需联系勤鸟商务/客服开通）
     · 请求路径、鉴权方式（appKey/appSecret 还是 access_token）
     · 签名算法与请求/返回字段命名
   ⚠️ 本文件中的路径与字段名是「契约占位」，不是官方数据。
      请用勤鸟提供的开发文档逐项核对后，把 verified 改成 true。
   ============================================================ */
import { ConnectorError } from './contract.js';

export const endpointSpec = {
  members: { method: 'POST', path: '/openapi/v1/member/page', verified: false, note: '会员档案分页查询' },
  cards: { method: 'POST', path: '/openapi/v1/member/card/list', verified: false, note: '会员卡 / 会籍（卡种、有效期）' },
  contracts: { method: 'POST', path: '/openapi/v1/contract/list', verified: false, note: '合同 / 卡项明细' },
  ptPackages: { method: 'POST', path: '/openapi/v1/pt/package/list', verified: false, note: '私教课包与剩余课时' },
  appointments: { method: 'POST', path: '/openapi/v1/course/appointment/list', verified: false, note: '团课 / 私教预约' },
  checkins: { method: 'POST', path: '/openapi/v1/checkin/record/list', verified: false, note: '门禁 / 签到核销记录' },
  orders: { method: 'POST', path: '/openapi/v1/order/list', verified: false, note: '订单与收款流水' },
  refunds: { method: 'POST', path: '/openapi/v1/refund/list', verified: false, note: '退款记录' },
  staff: { method: 'POST', path: '/openapi/v1/staff/list', verified: false, note: '员工（会籍/教练）列表，用于归属映射' },
  stores: { method: 'POST', path: '/openapi/v1/store/list', verified: false, note: '门店列表，用于多店场景' },
};

export const authSpec = {
  mode: 'appkey-secret',
  /**
   * 签名在本地代理进程里完成（Node crypto），前端不接触 appSecret。
   * signMode 提供两种常见写法，必须以勤鸟文档为准：
   *   A: md5_upper(secret + 按 key 排序的 kv 串 + secret)
   *   B: md5_upper(appKey + timestamp + nonce + secret)
   */
  signMode: 'A',
  headerNames: {
    appKey: 'appKey',            // ← 待核对
    timestamp: 'timestamp',
    nonce: 'nonce',
    sign: 'sign',
    token: 'accessToken',        // 若走 OAuth 模式则改用该 header
  },
  envVars: ['QINNIAO_BASE_URL', 'QINNIAO_APP_KEY', 'QINNIAO_APP_SECRET', 'QINNIAO_SIGN_MODE', 'QINNIAO_TOKEN'],
  note: 'appSecret 只放在本地代理进程的环境变量里，绝不写进浏览器代码。',
};

/**
 * 写能力。勤鸟的公开渠道没有接口文档，因此这里不是「确认没有」，
 * 而是「还没拿到文档，无法确认」—— verified 保持 false。
 * 拿到文档后逐项核对：有写接口就填 method 并置 available=true。
 */
export const writeSpec = {
  followUpCreate: {
    available: false,
    method: null,
    path: '',
    verified: false,
    basis: '公开渠道查不到勤鸟开放平台文档，需联系勤鸟商务 / 客服开通后索取',
    unblock: '向勤鸟申请开放平台，拿到文档后核对跟进写入接口的方法名、参数与字段名',
  },
};

export const mapping = {
  members: [
    { target: 'remoteId', source: 'memberId', transform: 'text' },          // 常见别名：id / memberNo / customerId
    { target: 'name', source: 'memberName', transform: 'text' },
    { target: 'phone', source: 'mobile', transform: 'phone' },
    { target: 'gender', source: 'sex', transform: 'text' },
    { target: 'birthday', source: 'birthday', transform: 'date' },
    { target: 'cardType', source: 'cardName', transform: 'text' },
    { target: 'cardStatus', source: 'cardStatus', transform: 'text' },
    { target: 'expireDate', source: 'cardEndDate', transform: 'date' },
    { target: 'joinDate', source: 'createTime', transform: 'date' },
    { target: 'lastRenewDate', source: 'lastRenewTime', transform: 'date' },
    { target: 'ptTotal', source: 'ptTotalTimes', transform: 'int' },
    { target: 'ptLeft', source: 'ptRemainTimes', transform: 'int' },
    { target: 'totalPaid', source: 'totalConsumeAmount', transform: 'money' },
    { target: 'lastVisit', source: 'lastCheckinTime', transform: 'datetime' },
    { target: 'visits30', source: 'checkinTimes30', transform: 'int' },
    { target: 'advisorName', source: 'advisorName', transform: 'text' },
    { target: 'storeName', source: 'storeName', transform: 'text' },
    { target: 'sysTags', source: 'tagNames', transform: 'tags' },
  ],
  /**
   * 会员卡 / 会籍。原来只映射了 5 个字段，"剩几节课""卡有没有激活"
   * "这是不是一次续费"全都答不上来，卡课续费标签就只能是空的。
   */
  cards: [
    { target: 'remoteId', source: 'cardId', transform: 'text' },
    { target: 'memberRemoteId', source: 'memberId', transform: 'text' },
    { target: 'cardNo', source: 'cardNo', transform: 'text' },
    { target: 'name', source: 'cardName', transform: 'text' },
    { target: 'status', source: 'cardStatus', transform: 'text' },
    { target: 'startDate', source: 'startDate', transform: 'date' },
    { target: 'endDate', source: 'endDate', transform: 'date' },
    { target: 'totalCount', source: 'totalTimes', transform: 'int' },
    { target: 'remainCount', source: 'remainTimes', transform: 'int' },
    { target: 'paidPrice', source: 'actualAmount', transform: 'money' },
    { target: 'listPrice', source: 'saleAmount', transform: 'money' },
    { target: 'renewOfRemoteId', source: 'renewCardId', transform: 'text' },
  ],
  /** 私教课包。勤鸟把它和会籍分开，课时标签的原料在这里。 */
  ptPackages: [
    { target: 'remoteId', source: 'packageId', transform: 'text' },
    { target: 'memberRemoteId', source: 'memberId', transform: 'text' },
    { target: 'name', source: 'packageName', transform: 'text' },
    { target: 'status', source: 'status', transform: 'text' },
    { target: 'endDate', source: 'expireDate', transform: 'date' },
    { target: 'totalCount', source: 'totalTimes', transform: 'int' },
    { target: 'remainCount', source: 'remainTimes', transform: 'int' },
    { target: 'paidPrice', source: 'actualAmount', transform: 'money' },
  ],
  appointments: [
    { target: 'remoteId', source: 'appointmentId', transform: 'text' },
    { target: 'memberRemoteId', source: 'memberId', transform: 'text' },
    { target: 'date', source: 'courseDate', transform: 'date' },
    { target: 'time', source: 'courseTime', transform: 'text' },
    { target: 'type', source: 'courseName', transform: 'text' },
    { target: 'coach', source: 'coachName', transform: 'text' },
    { target: 'status', source: 'status', transform: 'text' },
  ],
  checkins: [
    { target: 'remoteId', source: 'checkinId', transform: 'text' },
    { target: 'memberRemoteId', source: 'memberId', transform: 'text' },
    { target: 'lastVisit', source: 'checkinTime', transform: 'datetime' },
    { target: 'device', source: 'deviceType', transform: 'text' },          // 指静脉 / 刷掌 / 人脸 / 手环
  ],
  orders: [
    { target: 'remoteId', source: 'orderId', transform: 'text' },
    { target: 'memberRemoteId', source: 'memberId', transform: 'text' },
    { target: 'paidAt', source: 'payTime', transform: 'datetime' },
    { target: 'amount', source: 'payAmount', transform: 'money' },
    { target: 'item', source: 'productName', transform: 'text' },
    { target: 'payMethod', source: 'payWay', transform: 'text' },
    { target: 'refunded', source: 'refundFlag', transform: 'bool' },
  ],
};

export function buildRequest(cfg, resource, params = {}) {
  const spec = endpointSpec[resource];
  if (!spec) throw new ConnectorError('unknown_resource', `勤鸟未定义资源：${resource}`);
  return {
    provider: 'qinniao',
    method: spec.method,
    path: spec.path,
    query: spec.method === 'GET' ? params : {},
    body: spec.method === 'GET' ? null : params,
    verified: spec.verified,
    timeoutMs: cfg.timeoutMs || 15000,
  };
}

export function parseList(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  const cands = [
    json?.data?.records, json?.data?.list, json?.data?.rows, json?.data?.content,
    json?.result?.records, json?.result?.list, json?.rows, json?.records,
    json?.list, json?.data, json?.result,
  ];
  for (const c of cands) if (Array.isArray(c)) return c;
  return [];
}

/** 勤鸟硬件的签到方式，映射到人可读来源 */
export const CHECKIN_DEVICES = ['指静脉', '刷掌', '人脸识别', 'RFID 手环', '二维码', '前台核销'];

export const meta = {
  id: 'qinniao',
  name: '勤鸟',
  short: '勤鸟',
  vendor: '勤鸟（重庆勤鸟圈科技 · rocketbird.cn）',
  logoText: '勤',
  logoFrom: '#1AA36B',
  logoTo: '#0A6E46',
  knownScope: ['会员 CRM', '会籍设定', '合同管理', '团操课', '场地管理', '聚合支付', '智能门禁签到', '数据看板', '营销触达'],
  authLabel: 'appKey + appSecret（需向勤鸟开通开放平台）',
  fallback: '在勤鸟后台导出会员/合同 Excel → 在本工作台「导入」里粘贴',
  endpointSpec, authSpec, writeSpec, mapping, buildRequest, parseList,
  /** 写能力一句话结论 */
  writeSummary: {
    canWriteFollowup: false,
    verified: false,
    text: '勤鸟开放平台需向商务申请开通，公开渠道无接口文档，写能力尚未确认。',
  },
};
