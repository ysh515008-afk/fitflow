/* 集成检查：AI 资料在会员档案里的入口是否真的接通 */
const ls=new Map();
globalThis.localStorage={getItem:k=>ls.has(k)?ls.get(k):null,setItem:(k,v)=>ls.set(k,String(v)),removeItem:k=>ls.delete(k),clear:()=>ls.clear()};
Object.defineProperty(globalThis,'navigator',{value:{userAgent:'node'},configurable:true});
globalThis.location={hash:'',href:'http://localhost/'};
globalThis.window={addEventListener(){},matchMedia(){return {matches:false,addEventListener(){}};}};
globalThis.document={addEventListener(){},getElementById(){return null;},querySelector(){return null;},querySelectorAll(){return [];},
  createElement(){return {style:{},classList:{add(){},remove(){},toggle(){}},setAttribute(){},appendChild(){}};}};

const store=await import('./js/store.js');
await store.init();
const s=store.get();
const am=await import('./js/aiMaterial.js');
const {redactPII}=await import('./js/outreach.js');
const fs=await import('node:fs');

let bad=0;
const ok=function(c,l,e){ if(c) console.log('OK   '+l+(e?'  '+e:'')); else { bad++; console.log('FAIL '+l+(e?'  '+e:'')); } };

console.log('=== 1. 入口接线 ===');
const sheetsSrc=fs.readFileSync('js/sheets.js','utf8');
ok(/\['aimat'/.test(sheetsSrc), '会员档案 tabs 里有 aimat 标签');
ok(/tab === 'aimat'/.test(sheetsSrc), '有 aimat 面板分支');
ok(/openAiMaterialSheet/.test(sheetsSrc), 'sheets.js 引了 openAiMaterialSheet');
ok(/data-act="aimat-open"/.test(sheetsSrc), 'hero 有 AI 资料按钮');
ok(/aimat-open/.test(sheetsSrc) && /openAiMaterialSheet\(id/.test(sheetsSrc), 'aimat-open 动作已绑定');
ok(/from '\.\/aiMaterial\.js'/.test(sheetsSrc), 'import 路径正确');

console.log('\n=== 2. 持久化 ===');
const storeSrc=fs.readFileSync('js/store.js','utf8');
ok(/aiMaterials: raw\.aiMaterials \|\| \[\]/.test(storeSrc), 'migrate 有 aiMaterials 兜底');
ok(/export function addAiMaterial/.test(storeSrc), 'store 有 addAiMaterial');
ok(/export const aiMaterialsOf/.test(storeSrc), 'store 有 aiMaterialsOf');
ok(/export function deleteAiMaterial/.test(storeSrc), 'store 有 deleteAiMaterial');

console.log('\n=== 3. 落库后能持久化回读（走真实加密存储）===');
const TXT='顾问：今天聊了续费。客户：价格我再考虑下，下个月发工资来办。';
const m1=store.memberById('m01');
const note=am.parseMeetingNote(am.unredact(`【会面概要】\n续费面谈，客户要等下月发工资。\n【会面过程】\n- 报出老会员价 6280\n【会面结果】\n- 价格锁定至 15 号\n【客户异议】\n- 本月资金紧张\n【跟进事项】\n- 下月 10 号提醒办理｜下月 10 号\n【结果判定】\n推进`, m1.name));
const rec=store.addAiMaterial({memberId:m1.id,fileName:'0928面谈.txt',fileSize:TXT.length,kind:'text',rawText:TXT,note});
ok(rec && rec.id, 'addAiMaterial 返回记录', rec.id);
const back=store.aiMaterialById(rec.id);
ok(back && back.note && !back.note.summary.includes('该会员'), '回读不含「该会员」占位', back.note.summary);
ok(back.rawText===TXT, '原文完整回读');

/* 回填只替换占位符，不会凭空往正文里塞姓名：
   外发时是「该会员」，回来必须换回真名；原文没占位符的就原样保留。 */
const withHolder=`【会面概要】\n该会员年卡下月到期，锁定老会员价 6280。\n【会面过程】\n- 该会员提出价格偏高\n【会面结果】\n- 该会员承诺下月到店办\n【跟进事项】\n- 提醒该会员办理｜下月 10 号`;
const note2=am.parseMeetingNote(am.unredact(withHolder, m1.name));
ok(note2.summary.includes(m1.name), '含占位符时回填真实姓名', note2.summary);
ok(!JSON.stringify(note2).includes('该会员'), '回填后全文无占位残留');
const noHolder=am.parseMeetingNote(am.unredact('【会面概要】\n续费面谈，客户要等下月发工资。\n【会面过程】\n- 报出老会员价 6280\n【会面结果】\n- 价格锁定至 15 号', m1.name));
ok(!noHolder.summary.includes(m1.name), '无占位符时不凭空插入姓名', noHolder.summary);

/* 加密落盘验证：localStorage 里必须是 ffenc: 前缀，不能是明文 */
await store.init();
const raw=ls.get('fitflow.v1');
ok(!!raw, 'localStorage 有写入');
ok(String(raw).startsWith('ffenc:'), '存储已加密（ffenc: 前缀）', String(raw).slice(0,12)+'…');
ok(!String(raw).includes(m1.name), '密文里搜不到会员姓名');
ok(!String(raw).includes(TXT.slice(0,10)), '密文里搜不到转写原文');

console.log('\n=== 4. 移除后的清理 ===');
store.deleteAiMaterial(rec.id);
ok(store.aiMaterialById(rec.id)===null, '删除后查不到');
ok(store.aiMaterialsOf(m1.id).length===0, '名下资料清空');

console.log('\n=== 5. 文件类型表自洽 ===');
const allExt=am.FILE_SUPPORT.flatMap(function(g){return g.ext;});
ok(new Set(allExt).size===allExt.length, '后缀无重复定义', allExt.length+' 个');
ok(am.ACCEPT_ATTR.split(',').length===allExt.length, 'accept 属性覆盖全部后缀', am.ACCEPT_ATTR.split(',').length+'');
for(const g of am.FILE_SUPPORT){
  ok(g.ok===true || (typeof g.how==='string'&&g.how.length>10), g.label+' 有明确处置说明');
}

console.log('\n'+(bad?('共 '+bad+' 项异常'):'全部通过'));
process.exit(bad?1:0);
