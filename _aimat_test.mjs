/* AI 资料模块的确定性校验。
   跑真函数，不跑浏览器：文件分类 / docx 解析 / 提示词 / 纪要解析 /
   外发脱敏 / 回填真实姓名 / 存为跟进记录。 */

const ls = new Map();
globalThis.localStorage = { getItem:(k)=>ls.has(k)?ls.get(k):null, setItem:(k,v)=>ls.set(k,String(v)), removeItem:(k)=>ls.delete(k), clear:()=>ls.clear() };
Object.defineProperty(globalThis,'navigator',{value:{userAgent:'node'},configurable:true});

const zlib = await import('node:zlib');
const store = await import('./js/store.js');
const am = await import('./js/aiMaterial.js');
const { redactPII } = await import('./js/outreach.js');
await store.init();

let fail = 0;
const ok = (cond, label, extra='') => {
  if (cond) console.log('OK   ' + label + (extra ? '  ' + extra : ''));
  else { fail++; console.log('FAIL ' + label + (extra ? '  ' + extra : '')); }
};

/* ============================================================
   1. 文件分类：支持的、不支持的都要有确定答案
   ============================================================ */
console.log('--- 1. 文件分类 ---');
for (const n of ['纪要.txt','a.md','b.srt','c.docx','d.json','e.csv']) {
  const c = am.classifyFile(n);
  ok(c.ok === true, `${n} → ${c.label} 可直接解析`);
}
for (const n of ['x.pdf','y.doc','录音.mp3','r.m4a','视频.mp4','无后缀']) {
  const c = am.classifyFile(n);
  ok(c.ok === false && !!c.how, `${n} → ${c.label} 给出替代路径`, '');
}
ok(am.extOf('A.B.TXT') === 'txt', 'extOf 大小写归一');

/* ============================================================
   2. docx 解析：真造一个 docx（deflate 压缩），走完整解压链路
   ============================================================ */
console.log('\n--- 2. docx 解析 ---');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 造一个最小 ZIP：只装一个 word/document.xml */
function makeZip(name, content, method = 8) {
  const data = Buffer.from(content, 'utf8');
  const comp = method === 8 ? zlib.deflateRawSync(data) : data;
  const nb = Buffer.from(name, 'utf8');
  const crc = crc32(data);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8); cd.writeUInt16LE(method, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14);
  cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nb.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(0, 42);

  const cdOff = lh.length + nb.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + nb.length, 12); eocd.writeUInt32LE(cdOff, 16); eocd.writeUInt16LE(0, 20);

  return Buffer.concat([lh, nb, comp, cd, nb, eocd]);
}

const DOC_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>客户：林嘉怡</w:t></w:r></w:p>
<w:p><w:r><w:t>今天谈到续费，客户说价格有点高。</w:t></w:r><w:r><w:tab/><w:t>想再看看。</w:t></w:r></w:p>
<w:p><w:r><w:t>最后约定周六下午到店试一节私教。</w:t></w:r></w:p>
</w:body></w:document>`;

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

for (const method of [8, 0]) {
  const ab = toArrayBuffer(makeZip('word/document.xml', DOC_XML, method));
  try {
    const txt = await am.docxToText(ab);
    const label = method === 8 ? 'deflate' : 'stored';
    ok(txt.includes('林嘉怡'), `docx(${label}) 取到姓名`);
    ok(txt.includes('周六下午到店试一节私教'), `docx(${label}) 取到尾段`);
    ok(txt.split('\n').length === 3, `docx(${label}) 段落一行一条，共 3 行`, JSON.stringify(txt.split('\n').length));
    ok(!txt.includes('<w:'), `docx(${label}) 标签已剥离`);
    ok(txt.includes('\t'), `docx(${label}) 制表符保留`);
  } catch (e) { fail++; console.log(`FAIL docx(method=${method}) 抛异常 ${e.message}`); }
}

/* 缺 document.xml 的 docx 要报错，不能静默返回空 */
try {
  await am.docxToText(toArrayBuffer(makeZip('word/header1.xml', '<a/>', 8)));
  fail++; console.log('FAIL 缺 document.xml 没报错');
} catch (e) { ok(/document\.xml/.test(e.message), '缺 document.xml 明确报错', e.message); }

/* 实体解码 */
ok(am.decodeEntities('a&amp;b&lt;c&gt;d&#20013;') === 'a&b<c>d中', 'XML 实体解码');
ok(am.xmlToText('<w:p><w:t>甲&amp;乙</w:t></w:p>') === '甲&乙', 'xmlToText 实体与段落');

/* ============================================================
   3. 提示词：章节齐、含脱敏称呼、不含真实姓名
   ============================================================ */
console.log('\n--- 3. 提炼提示词 ---');
const m1 = store.memberById('m01');
const prompt = am.buildExtractPrompt(DOC_TXT(), { member: m1, meetDate: '2026-09-28' });
for (const s of am.NOTE_SECTIONS) ok(prompt.includes('【' + s.tag + '】'), '提示词含章节【' + s.tag + '】');
ok(prompt.includes('【结果判定】'), '提示词含【结果判定】');
/* 提示词构建阶段保留真实数据（界面/本地一律真实），
   脱敏只在 redactPII 端口做，见第 4 节。这里只验指令部分用的称呼。 */
ok(prompt.includes(`客户一律称「该会员（${m1.gender}${m1.age} 岁`), '指令要求模型用「该会员」指代', '');
ok(prompt.includes('2026-09-28'), '提示词带入会面日期');
ok(prompt.includes('不得推测、不得补全'), '指令写明不得推测补全');

function DOC_TXT() {
  return [
    '顾问：嘉怡你先坐，最近练得怎么样？',
    '林嘉怡：还行，就是膝盖有点不舒服，深蹲不太敢加重量。',
    '顾问：那我们调整一下，先做闭链动作。今天主要是想跟你聊下年卡到期的事。',
    '林嘉怡：我知道，年卡是下个月 15 号到期对吧？',
    '顾问：对，还剩 18 天。现在续两年是 6880，比你现在的一年年卡划算。',
    '林嘉怡：有点贵，而且我担心教练会换人，之前那个教练挺好的。',
    '顾问：教练这块我可以跟店长确认，固定在王教练带。价格上我可以申请一个老会员价，6280。',
    '林嘉怡：6280 的话我可以考虑，但我这个月手头紧，要到下个月 10 号发工资。',
    '顾问：那这样，我先把 6280 的老会员价给你锁到 15 号，你 10 号之后来办都行。',
    '林嘉怡：行，那我下个月 10 号之后来找你办。',
    '顾问：好，另外膝盖的问题我让王教练给你出一版低冲击的训练计划，这周发你微信。',
    '林嘉怡：好的，谢谢。',
  ].join('\n');
}

/* ============================================================
   4. 外发端口脱敏：姓名没了、手机号打码，业务信息保留
   ============================================================ */
console.log('\n--- 4. 外发脱敏 ---');
const TXT = DOC_TXT();
const outbound = redactPII(am.buildExtractPrompt(TXT, { member: m1 }), store.get().members);
ok(!outbound.includes(m1.name), '外发文本里没有真实姓名');
ok(outbound.includes('该会员'), '外发文本用「该会员」指代');
const digits = String(m1.phone || '').replace(/[^0-9]/g, '');
if (digits.length >= 7) {
  ok(!outbound.includes(digits), '外发文本里没有完整手机号');
}
ok(outbound.includes('6280'), '金额保留（完成任务所必需）');
ok(outbound.includes('膝盖'), '身体反馈保留（完成任务所必需）');
ok(outbound.includes('不要出现任何真实姓名、手机号、身份证号、住址'), '指令明确禁止模型输出身份类信息');
ok(outbound.includes('只写转写记录里真实出现的内容'), '指令要求不编造');

/* ============================================================
   5. 纪要解析：正常输出 / 缺章节 / 动作时间拆分
   ============================================================ */
console.log('\n--- 5. 纪要解析 ---');
const MODEL_OUT = `【会面概要】
年卡到期续费面谈，客户因价格与教练稳定性犹豫，最终锁定老会员价 6280。

【会面过程】
- 顾问先关心客户膝盖不适，确认需要调整训练动作
- 说明年卡下月 15 号到期，还剩 18 天
- 报出两年卡原价 6880
- 客户提出价格偏高，且担心教练更换
- 顾问承诺固定王教练带训，并申请老会员价 6280
- 客户表示本月资金紧张，需等下月 10 号发工资

【会面结果】
- 老会员价 6280 锁定至 15 号
- 客户承诺下月 10 号后到店办理
- 顾问承诺本周出一版低冲击训练计划

【客户异议】
- 价格偏高，超出本月预算
- 担心原教练被更换

【跟进事项】
- 向店长确认固定王教练带训｜本周内
- 出一版低冲击训练计划并发微信｜本周内
- 下月 10 号后提醒客户到店办理续费｜下月 10 号

【结果判定】
推进`;

const note = am.parseMeetingNote(MODEL_OUT);
ok(note.ok, '完整输出解析成功', note.missing.length ? '缺 ' + note.missing.join('、') : '');
ok(note.summary.includes('6280'), '概要取到');
ok(note.process.length === 6, '会面过程 6 条', String(note.process.length));
ok(note.results.length === 3, '会面结果 3 条', String(note.results.length));
ok(note.objections.length === 2, '客户异议 2 条', String(note.objections.length));
ok(note.actions.length === 3, '跟进事项 3 条', String(note.actions.length));
ok(note.actions[0].action === '向店长确认固定王教练带训' && note.actions[0].when === '本周内', '动作与时间正确拆分', JSON.stringify(note.actions[0]));
ok(note.result === 'positive', '结果判定 → positive', note.verdictText);

/* 会面概要为空段落 + 过程/结果整段缺失 → 三节都该报缺 */
const bad = am.parseMeetingNote('【会面概要】\n【结果判定】\n中性');
ok(!bad.ok && bad.missing.length === 3, '缺章节时 ok=false 且报出缺哪几节', bad.missing.join('、'));
/* 只有概要为空、过程结果都在 → 只报概要一节 */
const bad2 = am.parseMeetingNote('【会面概要】\n\n【会面过程】\n- a\n【会面结果】\n- b');
ok(!bad2.ok && bad2.missing.join() === '会面概要', '只缺概要时只报概要', bad2.missing.join('、'));
ok(am.parseMeetingNote('【结果判定】\n拒绝').result === 'negative', '「拒绝」→ negative');
ok(am.parseMeetingNote('【结果判定】\n中性').result === 'neutral', '「中性」→ neutral');
ok(am.parseMeetingNote('没有任何章节').ok === false, '无章节输出判为不可归档');

/* 列表符号与全角/半角分隔符都要吃得下 */
const note2 = am.parseMeetingNote('【会面概要】\n概要文本\n\n【会面过程】\n• 第一条\n1. 第二条\n\n【会面结果】\n- 结果一\n\n【跟进事项】\n- 动作A | 周五');
ok(note2.ok && note2.process.length === 2, '兼容 • 与 1. 列表符号', String(note2.process.length));
ok(note2.actions[0].when === '周五', '半角 | 也能拆出时间', JSON.stringify(note2.actions[0]));

/* ============================================================
   6. 回填真实姓名
   ============================================================ */
console.log('\n--- 6. 回填真实姓名 ---');
const redactedNote = `【会面概要】\n该会员年卡下月到期，锁定老会员价 6280。\n【会面过程】\n- 该会员提出价格偏高\n【会面结果】\n- 该会员承诺下月到店\n【跟进事项】\n- 提醒该会员办理｜下月 10 号`;
const pn = am.parseMeetingNote(am.unredact(redactedNote, m1.name));
ok(pn.summary.includes(m1.name), '概要回填真实姓名');
ok(pn.process[0].includes(m1.name), '过程回填真实姓名');
ok(pn.actions[0].action.includes(m1.name), '跟进事项回填真实姓名');
ok(!pn.summary.includes('该会员'), '回填后不再有「该会员」占位');
ok(am.unredact('没有占位符', m1.name) === '没有占位符', '无占位符时原样返回');

/* ============================================================
   7. 存为跟进记录：走真实 store
   ============================================================ */
console.log('\n--- 7. 存为跟进记录 ---');
const before = store.followupsOf(m1.id).length;
const beforeMat = store.aiMaterialsOf(m1.id).length;

store.addFollowup({
  memberId: m1.id, channel: 'offline',
  summary: am.noteToPlainText(pn),
  feedback: pn.objections.join('；'),
  result: pn.result,
  nextAction: pn.actions.map((a) => `${a.action}（${a.when}）`).join('；'),
  nextDate: null,
  psych: { stage: 'p1', state: null, principles: [], microCommit: pn.results.join('；'), note: '', checks: [] },
  from: 'ai-material',
});
const savedMat = store.addAiMaterial({
  memberId: m1.id, fileName: '0928面谈.docx', fileSize: TXT.length,
  kind: 'docx', rawText: TXT, note: pn,
});

const after = store.followupsOf(m1.id);
ok(after.length === before + 1, '跟进记录 +1', `${before} → ${after.length}`);
ok(after[0].channel === 'offline', '渠道记为到店面谈');
ok(after[0].result === pn.result, '结果取自纪要判定', `${pn.result} / ${pn.verdictText}`);
ok(after[0].summary.includes(m1.name), '跟进正文含真实姓名（界面不脱敏）');
ok(after[0].nextAction.includes('下月 10 号'), '下一步含时间点');
ok(store.aiMaterialsOf(m1.id).length === beforeMat + 1, '资料归档 +1');
ok(store.aiMaterialById(savedMat.id)?.note?.summary === pn.summary, '归档可回读');

/* 删除资料不影响已存的跟进 */
store.deleteAiMaterial(savedMat.id);
ok(store.aiMaterialsOf(m1.id).length === beforeMat, '删除资料后归档数回落');
ok(store.followupsOf(m1.id).length === before + 1, '删除资料不影响已存跟进');

/* ============================================================
   8. 结果文本
   ============================================================ */
console.log('\n--- 8. 结果文本 ---');
const plain = am.noteToPlainText(pn);
ok(plain.includes('结果：'), '含结果段');
ok(plain.includes('跟进：'), '含跟进段');
ok(!/undefined|NaN|\[object Object\]/.test(plain), '无脏值');

console.log('\n' + (fail ? `共 ${fail} 项异常` : '全部通过'));
process.exit(fail ? 1 : 0);
