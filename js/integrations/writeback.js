/* ============================================================
   integrations/writeback.js · 跨平台跟进回写桥
   ------------------------------------------------------------
   要解决的问题：
     FitFlow 里写好的跟进记录（含 AI 转写纪要），能不能直接落到
     三体 / 勤鸟的会员档案里，不用人工再抄一遍？

   先把边界说死，不靠猜：
     · 能不能写，只由一件事决定 —— 目标系统是否开放了「写」接口。
       开放了就能自动写；没开放，就没有第二条路能绕过去。
     · 本文件把「有没有这个接口」做成数据（WRITE_CAPABILITY），
       每一项都写清依据来源和核实状态，不写"应该可以""大概率能"。

   已核实的事实（2026-09-28，来源：三体官方技能包 santi v1.0.1 / 包版本 1.1.2）：
     · 网关域名 https://ai-gateway.styd.cn，app-id 10000
     · 业务端点 POST /api/gateway，body { method, timestamp, params }
     · 鉴权 POST /auth/key（32 位网关 Key）→ access_token
     · 跟进记录实体字段：follow_id / follow_time / follow_type / content / staff_name
     · 跟进只有读方法 member.follow-history，没有写方法
     · 全网关写方法只有 member.create 一个
   ============================================================ */
import { ConnectorError } from './contract.js';

/* ---------------- 写能力矩阵 ---------------- */
/**
 * 每一项必须回答三个问题：
 *   1. available：目标系统现在有没有这个写接口（布尔值，不是概率）
 *   2. basis：这个结论的依据是什么（官方文档 / 官方技能包 / 待厂商确认）
 *   3. method / path：接口开放后填这里，填了就能直接启用
 */
export const WRITE_CAPABILITY = {
  santi: {
    providerId: 'santi',
    name: '三体云动',
    gateway: {
      baseUrl: 'https://ai-gateway.styd.cn',
      appId: '10000',
      businessPath: '/api/gateway',
      keyLoginPath: '/auth/key',
      refreshPath: '/auth/refresh',
      switchShopPath: '/auth/switch/shop',
      verified: true,
      basis: '三体官方技能包 config/environment.json + references/execution.md，2026-09-28 核对',
    },
    /** 读：跟进历史。已核实可用。 */
    read: {
      followHistory: {
        available: true,
        method: 'member.follow-history',
        saasPath: 'GET /v1/agent/member/follow-history',
        verified: true,
        basis: '官方技能包 member/references/api.md 第 608-649 行',
      },
    },
    /** 写：新增跟进记录。官方网关当前版本未提供，这是事实不是推测。 */
    write: {
      followUpCreate: {
        available: false,
        method: null,
        verified: true,                 // 「核实过：确实没有」，不是「没查过」
        basis: '官方技能包 member/mcp.json 的方法白名单里，写方法只有 member.create；'
          + '跟进只有 member.follow-history（读）。已逐项列举全部域方法确认。',
        unblock: '向三体申请开放跟进写入方法，拿到 method 名与参数后填进 method 字段即可启用，无需改别的。',
      },
    },
    /** 实体字段：取自读接口实际返回，写入时按同一套命名对齐 */
    fields: {
      memberId: 'member_id',
      followTime: 'follow_time',
      followType: 'follow_type',
      content: 'content',
      staffName: 'staff_name',
      verified: true,
      basis: '官方技能包 member/references/api.md 响应字段说明',
    },
  },

  qinniao: {
    providerId: 'qinniao',
    name: '勤鸟',
    gateway: { baseUrl: '', appId: '', businessPath: '', verified: false, basis: '勤鸟开放平台需向商务申请，公开渠道无接口文档' },
    read: {
      followHistory: {
        available: false,
        method: null,
        verified: false,
        basis: '公开渠道查不到勤鸟开放接口文档，需联系勤鸟商务 / 客服开通后拿到开发文档',
        unblock: '向勤鸟申请开放平台，拿到文档后核对路径、鉴权与字段名',
      },
    },
    write: {
      followUpCreate: {
        available: false,
        method: null,
        verified: false,
        basis: '同上：文档未拿到，无法确认写能力是否存在',
        unblock: '向勤鸟申请开放平台并索取跟进写入接口文档',
      },
    },
    /** 勤鸟字段是占位命名，拿到文档后按 mapping 规则改写，不要直接照抄 */
    fields: {
      memberId: 'memberId',
      followTime: 'followTime',
      followType: 'followType',
      content: 'content',
      staffName: 'staffName',
      verified: false,
      basis: '占位命名，待勤鸟文档核对',
    },
  },
};

/** 某家能不能自动写跟进。返回确定结论 + 依据，交给界面直接显示。 */
export function writeCapable(providerId) {
  const c = WRITE_CAPABILITY[providerId];
  if (!c) return { ok: false, reason: '未知对接方', basis: '', unblock: '' };
  const w = c.write.followUpCreate;
  return {
    ok: w.available === true,
    verified: w.verified,
    reason: w.available ? '已开放写入接口' : '目标系统未开放跟进写入接口',
    basis: w.basis,
    unblock: w.unblock || '',
  };
}

/* ---------------- 字段映射 ---------------- */

/** FitFlow 跟进渠道 → 目标系统的跟进方式文案 */
const CHANNEL_MAP = {
  santi: { phone: '电话跟进', wechat: '微信跟进', visit: '到店面谈', sms: '短信跟进', other: '其他跟进' },
  qinniao: { phone: '电话跟进', wechat: '微信跟进', visit: '到店面谈', sms: '短信跟进', other: '其他跟进' },
};

const RESULT_TEXT = {
  positive: '正向：有明确推进',
  neutral: '中性：有回应但没定',
  no_reply: '未回复',
  negative: '负向：明确拒绝',
  pending: '已触达，结果待补',
};

/**
 * 跟进正文。目标系统只有一个 content 字段，
 * 所以把结构化的东西压成一段人能读的话 —— 抄进后台不会丢信息。
 *
 * @param {object} f       FitFlow 跟进记录
 * @param {object} opts    { withNext:boolean 是否带上「下一步」 }
 */
export function composeContent(f, opts = {}) {
  const { withNext = true } = opts;
  const lines = [];
  const head = `[FitFlow ${f.date || ''}]`;
  const r = RESULT_TEXT[f.result] || '';
  lines.push(r ? `${head} ${r}` : head);
  if (f.summary) lines.push(`沟通：${f.summary}`);
  if (f.feedback) lines.push(`客户反馈：${f.feedback}`);
  if (withNext) {
    if (f.nextAction) lines.push(`下一步：${f.nextAction}${f.nextDate ? `（约定 ${f.nextDate}）` : ''}`);
    else if (f.nextDate) lines.push(`下一步：约定 ${f.nextDate}`);
  }
  /* AI 转写纪要的心理存档不进正文：那是给内部看的分析，不是给会员档案的事实记录 */
  return lines.join('\n');
}

/**
 * 把一条 FitFlow 跟进转成目标系统的字段对象。
 *
 * 会员身份用什么定位：手机号优先，其次姓名。
 *   理由 —— 目标系统的会员 ID 只有读接口返回过才有，本地不一定存了；
 *   手机号是两家系统都有的天然关联键，导入与写入都认它。
 */
export function buildFollowupPayload(providerId, { member, followup, advisor = '', remoteId = null }) {
  const c = WRITE_CAPABILITY[providerId];
  if (!c) throw new ConnectorError('unknown_provider', `未知对接方：${providerId}`);
  const F = c.fields;
  const channel = CHANNEL_MAP[providerId] || CHANNEL_MAP.santi;

  const payload = {
    [F.memberId]: remoteId ?? member?.phone ?? '',
    [F.followTime]: `${followup.date || ''} ${followup.hhmm || ''}`.trim(),
    [F.followType]: channel[followup.channel] || channel.other,
    [F.content]: composeContent(followup),
    [F.staffName]: advisor || member?.owner || '',
  };
  return {
    payload,
    verified: F.verified,
    /* 定位键单独返回：调用方要拿它做「这条对应哪个会员」的校验 */
    identity: { phone: member?.phone || '', name: member?.name || '', remoteId },
  };
}

/* ---------------- 幂等 ---------------- */

/**
 * 幂等键。同一条跟进对同一家系统只应写一次。
 * 用「跟进记录 id + 目标系统」组成，跟进内容改了也不变 ——
 * 变更内容应走「更新」而不是再推一条，这里只防重复新增。
 */
export const idemKey = (providerId, followupId) => `${providerId}:followup:${followupId}`;

/** 这条跟进是否已经推过（查回写日志） */
export const alreadyPushed = (log, providerId, followupId) =>
  (log || []).some((x) => x.idemKey === idemKey(providerId, followupId) && x.status !== 'failed');

/* ---------------- 降级输出 ---------------- */

/**
 * 目标系统没有写接口时，走这条：生成一段可以直接粘进后台跟进框的文本。
 * 不是"自动填写"，是"把要填的东西准备好 + 一键复制"，人工按一下粘贴。
 */
export function renderPasteText(providerId, { member, followup, advisor = '' }) {
  const { payload } = buildFollowupPayload(providerId, { member, followup, advisor });
  const F = WRITE_CAPABILITY[providerId].fields;
  return [
    `会员：${member?.name || ''}（${member?.phone || ''}）`,
    `跟进时间：${payload[F.followTime]}`,
    `跟进方式：${payload[F.followType]}`,
    `跟进人：${payload[F.staffName]}`,
    '',
    payload[F.content],
  ].join('\n');
}

/** 批量导入用的表头。列顺序固定，别改 —— 导入模板是给后台对照用的。 */
export const CSV_COLUMNS = ['会员手机号', '会员姓名', '跟进时间', '跟进方式', '跟进内容', '跟进人'];

export function csvRow(providerId, { member, followup, advisor = '' }) {
  const { payload } = buildFollowupPayload(providerId, { member, followup, advisor });
  const F = WRITE_CAPABILITY[providerId].fields;
  const cell = (v) => {
    const s = String(v ?? '').replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  return [
    member?.phone || '',
    member?.name || '',
    payload[F.followTime],
    payload[F.followType],
    /* 表格里的正文压成一行：多行单元格虽然合法，但不少后台的导入器
       会把它当成两条记录，结果是跟进被拆散。人工粘贴才保留换行。 */
    String(payload[F.content] || '').replace(/\r?\n/g, '；'),
    payload[F.staffName],
  ].map(cell).join(',');
}

export function csvText(providerId, rows) {
  return [CSV_COLUMNS.join(','), ...rows.map((r) => csvRow(providerId, r))].join('\n');
}

/* ---------------- 回写日志 ---------------- */

/**
 * 一条回写留痕。写成功、写失败、只是复制了文本，都要记 ——
 * 「我到底有没有把这条跟进落到三体里」必须能事后查出来。
 *
 * @param {string} mode   api 接口写入 | paste 复制粘贴 | csv 导出导入
 * @param {string} status ok 成功 | failed 失败 | manual 人工待办（复制/导出后由人完成）
 */
export function logEntry({ providerId, memberId, followupId, mode, status, remoteId = null, message = '' }) {
  return {
    id: `wb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    providerId,
    memberId,
    followupId,
    idemKey: idemKey(providerId, followupId),
    mode,
    status,
    remoteId,
    message,
  };
}

/** 日志里挑出某条跟进的回写记录（最新的在前） */
export const logsOfFollowup = (log, followupId) =>
  (log || []).filter((x) => x.followupId === followupId)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));

/* ---------------- 三种通道的统一入口 ---------------- */
/**
 * 决定这条跟进走哪条路。结论由写能力矩阵给出，不做概率判断。
 *
 * @returns {{ mode:'api'|'paste'|'csv', blocked:boolean, reason:string, basis:string }}
 */
export function route(providerId) {
  const cap = writeCapable(providerId);
  if (cap.ok) return { mode: 'api', blocked: false, reason: cap.reason, basis: cap.basis };
  return {
    mode: 'paste',
    blocked: true,
    reason: cap.reason,
    basis: cap.basis,
    unblock: cap.unblock,
  };
}
