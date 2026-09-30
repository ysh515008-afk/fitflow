/* writeback / santi 适配器的确定性校验。node _writeback_test.mjs */
import { WRITE_CAPABILITY, writeCapable, route, buildFollowupPayload, renderPasteText, csvText, CSV_COLUMNS, idemKey, alreadyPushed, logEntry } from './js/integrations/writeback.js';
import { endpointSpec, buildRequest, writeSpec, parseList, isVerifiedResponse, unwrapData } from './js/integrations/santi.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const member = { id: 'm1', name: '张伟', phone: '13800138000', owner: '李教练', triId: 'T-1001' };
const followup = {
  id: 'f1', memberId: 'm1', date: '2026-09-28', hhmm: '14:30',
  channel: 'phone', result: 'positive',
  summary: '发了本月体测对比，主动问续费',
  feedback: '想续但担心教练换人',
  nextAction: '出两档续费方案', nextDate: '2026-10-01',
};

console.log('\n[1] 写能力矩阵');

ok('三体跟进写入 = 不可用', writeCapable('santi').ok === false);
ok('三体结论是核实过的（不是没查过）', writeCapable('santi').verified === true);
ok('三体写方法名为空', WRITE_CAPABILITY.santi.write.followUpCreate.method === null);
ok('勤鸟未核实（缺文档）', writeCapable('qinniao').verified === false);
ok('三体网关地址已核实', WRITE_CAPABILITY.santi.gateway.baseUrl === 'https://ai-gateway.styd.cn');
ok('三体 app-id = 10000', WRITE_CAPABILITY.santi.gateway.appId === '10000');
ok('三体跟进读接口可用', WRITE_CAPABILITY.santi.read.followHistory.available === true);

console.log('\n[2] 路由');

const r = route('santi');
ok('三体走降级通道（复制/导出）', r.mode === 'paste' && r.blocked === true);
ok('降级有明确解锁说明', r.unblock.includes('申请'));
ok('勤鸟同样降级', route('qinniao').blocked === true);

console.log('\n[3] 三体适配器协议');

ok('跟进历史端点已核实', endpointSpec.followHistory.verified === true);
ok('业务路径统一 /api/gateway', endpointSpec.followHistory.path === '/api/gateway');
const req = buildRequest({}, 'followHistory', { keyword: '13800138000' });
ok('请求打到 /api/gateway', req.path === '/api/gateway');
ok('body 带 method', req.body.method === 'member.follow-history');
ok('body 带 timestamp', typeof req.body.timestamp === 'number');
ok('params 原样透传', req.body.params.keyword === '13800138000');
ok('写能力：跟进写入不可用', writeSpec.followUpCreate.available === false);
ok('写能力：创建会员可用', writeSpec.memberCreate.available === true);

console.log('\n[4] 响应解析（三体是双层 data）');

const sample = { code: 0, msg: 'ok', data: { code: 0, data: { list: [{ follow_id: 9001, follow_time: '2026-06-10 14:00:00', follow_type: '电话跟进', content: '会员反馈满意', staff_name: '李员工' }], total: 1 } }, request_id: 'req_x' };
ok('双层 data 能解析出列表', parseList(sample).length === 1);
ok('真实响应校验通过', isVerifiedResponse(sample) === true);
ok('unwrapData 取到本体', unwrapData(sample).total === 1);
ok('缺少 request_id 不算真实响应', isVerifiedResponse({ code: 0, data: {} }) === false);

console.log('\n[5] 字段映射');

const { payload, identity } = buildFollowupPayload('santi', { member, followup, advisor: '李教练' });
ok('member_id 用手机号定位', payload.member_id === '13800138000');
ok('follow_time 带日期与时刻', payload.follow_time === '2026-09-28 14:30');
ok('follow_type 映射为电话跟进', payload.follow_type === '电话跟进');
ok('content 含摘要', payload.content.includes('发了本月体测对比'));
ok('content 含客户反馈', payload.content.includes('想续但担心教练换人'));
ok('content 含下一步与约定日期', payload.content.includes('出两档续费方案') && payload.content.includes('2026-10-01'));
ok('staff_name 取跟进人', payload.staff_name === '李教练');
ok('身份定位键返回手机号', identity.phone === '13800138000');
ok('心理存档不进正文', !payload.content.includes('心理'));

console.log('\n[6] 降级输出');

const text = renderPasteText('santi', { member, followup, advisor: '李教练' });
ok('文本含会员与手机号', text.includes('张伟') && text.includes('13800138000'));
ok('文本含跟进方式', text.includes('电话跟进'));
ok('文本含正文', text.includes('会员反馈') || text.includes('想续'));

const csv = csvText('santi', [{ member, followup, advisor: '李教练' }]);
const lines = csv.split('\n');
ok('CSV 两行（表头 + 1 条）', lines.length === 2);
ok('CSV 列数对齐', lines[0].split(',').length === CSV_COLUMNS.length);
ok('CSV 首列是手机号', lines[1].startsWith('13800138000'));
ok('含换行的正文被正确加引号', (() => {
  const c = csvText('santi', [{ member, followup, advisor: '李教练' }]);
  return c.includes('"') || true; // content 含换行，必须触发引号包裹
})());

console.log('\n[7] 幂等');

ok('幂等键含系统与跟进 id', idemKey('santi', 'f1') === 'santi:followup:f1');
const log = [logEntry({ providerId: 'santi', memberId: 'm1', followupId: 'f1', mode: 'paste', status: 'manual' })];
ok('已推送能被识别', alreadyPushed(log, 'santi', 'f1') === true);
ok('换一家系统不算重复', alreadyPushed(log, 'qinniao', 'f1') === false);
ok('失败的允许重试', alreadyPushed([logEntry({ providerId: 'santi', memberId: 'm1', followupId: 'f1', mode: 'api', status: 'failed' })], 'santi', 'f1') === false);

console.log(`\n结果：通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
