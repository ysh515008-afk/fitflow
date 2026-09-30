/* ============================================================
   integrations/santi.js · 三体云动 对接适配器
   ------------------------------------------------------------
   已核实（2026-09-28，来源：三体官方技能包 santi v1.0.1 / 包版本 1.1.2，
   文件 config/environment.json、references/execution.md、member/mcp.json、
   member/references/api.md；核对方式：逐条比对官方白名单）：
     · 网关域名   https://ai-gateway.styd.cn，app-id 10000
     · 网关 Key   PC 端「员工账号管理」生成，32 位小写十六进制，默认 90 天有效
     · 登录       POST /auth/key      body { key }        → access_token / refresh_token
     · 刷新       POST /auth/refresh  body { refresh_token }
     · 切换门店   POST /auth/switch/shop body { shop_id } （多门店账号必须先切店）
     · 业务调用   POST /api/gateway
                  header Authorization: Bearer <access_token> / app-id / X-Request-ID
                  body { method, timestamp, params }
     · 响应结构   双层 data：{ code, msg, data:{ code, data:{...} }, request_id }
                  code=0 且有 request_id 才算真实响应
     · 方法白名单 member.* / schedule.* / order.* / stat.* / report.* /
                  dashboard.* / staff.list / excel.* / kb.query / shop.list
     · 写方法     全网关只有 member.create 一个（创建会员，需二次确认 confirmation_token）
     · 跟进记录   只有 member.follow-history（读），没有写方法
   仍未核实（保持 verified:false）：
     · 各资源的远端字段名（member.follow-history 的字段已核实，见 mapping.followHistory）
   ============================================================ */
import { ConnectorError } from './contract.js';

/**
 * 三体的业务接口不走独立路径，统一 POST /api/gateway，
 * 具体资源由 body 里的 method 决定。因此每一项都带 gatewayMethod。
 */
export const endpointSpec = {
  members: { method: 'POST', path: '/api/gateway', gatewayMethod: 'member.detail', verified: false, note: '会员档案（按手机号或姓名查，命中多条返回 40002）' },
  memberships: { method: 'POST', path: '/api/gateway', gatewayMethod: 'member.member-card', verified: false, note: '会员卡 / 会籍' },
  depositCards: { method: 'POST', path: '/api/gateway', gatewayMethod: 'member.deposit-card', verified: false, note: '储值卡' },
  packageCourses: { method: 'POST', path: '/api/gateway', gatewayMethod: 'member.package-course', verified: false, note: '课程包' },
  personalCourses: { method: 'POST', path: '/api/gateway', gatewayMethod: 'member.personal-course', verified: false, note: '私教课与剩余课时' },
  smallCourses: { method: 'POST', path: '/api/gateway', gatewayMethod: 'member.small-course', verified: false, note: '小班课' },
  experienceCards: { method: 'POST', path: '/api/gateway', gatewayMethod: 'member.experience-card', verified: false, note: '体验卡' },
  appointments: { method: 'POST', path: '/api/gateway', gatewayMethod: 'member.reserve', verified: false, note: '预约记录' },
  checkins: { method: 'POST', path: '/api/gateway', gatewayMethod: 'member.entrance', verified: false, note: '入场 / 到店记录' },
  myMembers: { method: 'POST', path: '/api/gateway', gatewayMethod: 'member.my-members', verified: false, note: '我的会员（分页）' },
  followHistory: { method: 'POST', path: '/api/gateway', gatewayMethod: 'member.follow-history', verified: true, note: '跟进历史（只读）。参数 keyword=手机号或姓名' },
  memberExpiring: { method: 'POST', path: '/api/gateway', gatewayMethod: 'member.member-expiring', verified: false, note: '即将到期商品' },
  birthdayList: { method: 'POST', path: '/api/gateway', gatewayMethod: 'member.birthday-list', verified: false, note: '生日会员' },
  underage: { method: 'POST', path: '/api/gateway', gatewayMethod: 'member.member-underage', verified: false, note: '未成年子女' },
  shops: { method: 'POST', path: '/api/gateway', gatewayMethod: 'shop.list', verified: true, note: '门店列表（切换门店前必须先取）' },
  staff: { method: 'POST', path: '/api/gateway', gatewayMethod: 'staff.list', verified: false, note: '员工列表' },
};

/**
 * 写能力。结论是核实过的：三体网关当前版本没有跟进写入方法。
 * 一旦官方开放，把 method 填上、available 改 true，其余代码不用动。
 */
export const writeSpec = {
  followUpCreate: {
    available: false,
    method: null,
    path: '/api/gateway',
    verified: true,
    basis: '官方技能包 member/mcp.json 的方法白名单内，写方法仅有 member.create；跟进只有 member.follow-history（读）',
    unblock: '向三体申请开放跟进写入方法，拿到 method 名与参数后填入 method 字段即可启用',
  },
  memberCreate: {
    available: true,
    method: 'member.create',
    path: '/api/gateway',
    verified: true,
    note: '创建会员需要二次确认：首次调用只返回 confirmation_token，带 confirmed=true 再调一次才真正创建',
  },
};

export const authSpec = {
  mode: 'gateway-key-bearer',
  /** 网关 Key 不在请求头里直接传，而是先换 access_token，业务请求带 Bearer */
  loginPath: '/auth/key',
  businessPath: '/api/gateway',
  appId: '10000',
  baseUrl: 'https://ai-gateway.styd.cn',
  secretIn: 'proxy',                // Key 只放在本地代理进程的环境变量里
  envVars: ['SANTI_GATEWAY_KEY'],   // 可选覆盖：SANTI_BASE_URL、SANTI_APP_ID
  note: '网关 Key 在 PC 端员工账号管理中生成，32 位，90 天有效。请勿写进前端代码或截图外发。',
};

/** 字段映射：左边是FitFlow 字段，右边是远端字段路径（待核对，先用可读命名占位） */
export const mapping = {
  members: [
    { target: 'remoteId', source: 'memberId', transform: 'text' },
    { target: 'name', source: 'memberName', transform: 'text' },
    { target: 'phone', source: 'mobile', transform: 'phone' },
    { target: 'gender', source: 'genderName', transform: 'text' },
    { target: 'birthday', source: 'birthday', transform: 'date' },
    { target: 'cardType', source: 'cardName', transform: 'text' },
    { target: 'cardStatus', source: 'cardStatusName', transform: 'text' },
    { target: 'expireDate', source: 'cardExpireDate', transform: 'date' },
    { target: 'joinDate', source: 'joinDate', transform: 'date' },
    { target: 'lastRenewDate', source: 'lastRenewDate', transform: 'date' },
    { target: 'ptTotal', source: 'ptTotalCount', transform: 'int' },
    { target: 'ptLeft', source: 'ptRemainCount', transform: 'int' },
    { target: 'totalPaid', source: 'consumeAmount', transform: 'money' },
    { target: 'lastVisit', source: 'lastCheckinTime', transform: 'datetime' },
    { target: 'visits30', source: 'checkinCount30', transform: 'int' },
    { target: 'advisorName', source: 'advisorName', transform: 'text' },
    { target: 'storeName', source: 'storeName', transform: 'text' },
    /* 系统标签和会籍手工打的 tags 是两个字段，远端只写这一个 */
    { target: 'sysTags', source: 'tagNames', transform: 'tags' },
  ],
  /**
   * 会籍课包。卡课续费状态标签的原料。
   * 注意 remainCount / status / renewOfRemoteId 三项：少了任何一项，
   * "剩几节课"和"这是不是一次续费"就只能靠到期日猜。
   */
  memberships: [
    { target: 'remoteId', source: 'membershipId', transform: 'text' },
    { target: 'memberRemoteId', source: 'memberId', transform: 'text' },
    { target: 'cardNo', source: 'cardNo', transform: 'text' },
    { target: 'name', source: 'cardName', transform: 'text' },
    { target: 'status', source: 'statusName', transform: 'text' },
    { target: 'startDate', source: 'startDate', transform: 'date' },
    { target: 'endDate', source: 'endDate', transform: 'date' },
    { target: 'totalCount', source: 'totalCount', transform: 'int' },
    { target: 'remainCount', source: 'remainCount', transform: 'int' },
    { target: 'paidPrice', source: 'paidAmount', transform: 'money' },
    { target: 'listPrice', source: 'listAmount', transform: 'money' },
    { target: 'renewOfRemoteId', source: 'renewFromMembershipId', transform: 'text' },
  ],
  /** 入场记录。运动频率标签的原料，也是沉默天数唯一的可靠来源。 */
  checkins: [
    { target: 'remoteId', source: 'checkinId', transform: 'text' },
    { target: 'memberRemoteId', source: 'memberId', transform: 'text' },
    { target: 'checkinAt', source: 'checkinTime', transform: 'datetime' },
    { target: 'device', source: 'deviceName', transform: 'text' },
    { target: 'durationMin', source: 'stayMinutes', transform: 'int' },
  ],
  appointments: [
    { target: 'remoteId', source: 'appointmentId', transform: 'text' },
    { target: 'memberRemoteId', source: 'memberId', transform: 'text' },
    { target: 'date', source: 'appointmentDate', transform: 'date' },
    { target: 'time', source: 'appointmentTime', transform: 'text' },
    { target: 'type', source: 'courseTypeName', transform: 'text' },
    { target: 'coach', source: 'coachName', transform: 'text' },
    { target: 'status', source: 'statusName', transform: 'text' },
  ],
  orders: [
    { target: 'remoteId', source: 'orderId', transform: 'text' },
    { target: 'memberRemoteId', source: 'memberId', transform: 'text' },
    { target: 'paidAt', source: 'payTime', transform: 'datetime' },
    { target: 'amount', source: 'payAmount', transform: 'money' },
    { target: 'item', source: 'itemName', transform: 'text' },
    { target: 'payMethod', source: 'payTypeName', transform: 'text' },
    { target: 'refunded', source: 'refundStatus', transform: 'bool' },
  ],
  /**
   * 跟进历史。字段是官方 api.md 里写明返回的，不是猜的：
   *   follow_id / follow_time / follow_type / content / staff_name
   * 读回来的记录用来做「FitFlow 这条跟进在不在三体里」的比对，
   * 也是将来开放写接口时字段命名的依据。
   */
  followHistory: [
    { target: 'remoteId', source: 'follow_id', transform: 'text' },
    { target: 'date', source: 'follow_time', transform: 'datetime' },
    { target: 'channel', source: 'follow_type', transform: 'text' },
    { target: 'summary', source: 'content', transform: 'text' },
    { target: 'advisorName', source: 'staff_name', transform: 'text' },
  ],
};

/** 生成请求描述（真正的鉴权与转发由本地代理完成，前端不持有密钥） */
export function buildRequest(cfg, resource, params = {}) {
  const spec = endpointSpec[resource];
  if (!spec) throw new ConnectorError('unknown_resource', `三体未定义资源：${resource}`);

  /* 三体所有业务调用都打 /api/gateway，资源靠 body 里的 method 区分 */
  if (spec.gatewayMethod) {
    return {
      provider: 'santi',
      method: 'POST',
      path: spec.path,
      query: {},
      body: { method: spec.gatewayMethod, timestamp: Math.floor(Date.now() / 1000), params },
      verified: spec.verified,
      timeoutMs: cfg.timeoutMs || 15000,
    };
  }

  return {
    provider: 'santi',
    method: spec.method,
    path: spec.path,
    query: spec.method === 'GET' ? params : {},
    body: spec.method === 'GET' ? null : params,
    verified: spec.verified,
    timeoutMs: cfg.timeoutMs || 15000,
  };
}

/** 从各家五花八门的返回结构里把列表扒出来（三体是双层 data） */
export function parseList(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  const cands = [
    json?.data?.data?.list, json?.data?.data?.records, json?.data?.data?.rows, json?.data?.data?.items,
    json?.data?.list, json?.data?.records, json?.data?.rows, json?.data?.items,
    json?.result?.list, json?.result?.records, json?.result, json?.data,
  ];
  for (const c of cands) if (Array.isArray(c)) return c;
  return [];
}

/** 三体的真实响应判断：code=0 且有 request_id 才算拿到了后端数据 */
export function isVerifiedResponse(json) {
  return Boolean(json) && json.code === 0 && Boolean(json.request_id);
}

/** 取业务数据本体（剥掉两层 data） */
export function unwrapData(json) {
  return json?.data?.data ?? json?.data ?? null;
}

export const meta = {
  id: 'santi',
  name: '三体云动',
  short: '三体',
  vendor: '三体云动',
  logoText: '三',
  logoFrom: '#2F6FB0',
  logoTo: '#1E4E80',
  knownScope: ['会员', '会籍 / 储值卡 / 课程包', '预约', '入场', '跟进历史（只读）', '经营报表', '订单', 'Excel 导出', '门店与员工'],
  authLabel: '网关 Key（PC 端员工账号管理生成，换取 Bearer Token）',
  fallback: '导出会员/会籍表格 → 在本工作台「导入」里粘贴',
  endpointSpec, authSpec, writeSpec, mapping, buildRequest, parseList,
  isVerifiedResponse, unwrapData,
  /** 写能力一句话结论，界面直接显示，不做模糊表述 */
  writeSummary: {
    canWriteFollowup: false,
    text: '三体官方网关当前只开放「创建会员」一个写接口，跟进记录仅有只读查询，没有写入方法。',
  },
};
