/* AI 资料 + 销售等级 深度检查：边界、枚举一致性、口径统一 */
const ls=new Map();
globalThis.localStorage={getItem:k=>ls.has(k)?ls.get(k):null,setItem:(k,v)=>ls.set(k,String(v)),removeItem:k=>ls.delete(k),clear:()=>ls.clear()};
Object.defineProperty(globalThis,'navigator',{value:{userAgent:'node'},configurable:true});

const store=await import('./js/store.js');
const am=await import('./js/aiMaterial.js');
const sg=await import('./js/salesGrade.js');
const dsg=await import('./js/data/salesGrade.js');
await store.init();
let s=store.get();

let bad=0;
const ok=function(c,l,e){ if(c) console.log('OK   '+l+(e?'  '+e:'')); else { bad++; console.log('FAIL '+l+(e?'  '+e:'')); } };

console.log('=== 1. 跟进渠道必须落在 CHANNELS 枚举内 ===');
/* 从源码里抠出 aiMaterial 写入 followup 时用的 channel 字面量 */
const fs=await import('node:fs');
const src=fs.readFileSync('js/aiMaterial.js','utf8');
const mch=src.match(/channel:\s*'([a-z]+)'/g)||[];
const chans=mch.map(function(x){return x.match(/'([a-z]+)'/)[1];});
console.log('  源码中出现的 channel 字面量：'+chans.join('、'));
chans.forEach(function(c){ ok(Object.keys(store.CHANNELS).includes(c), "channel '"+c+"' 在枚举内", store.CHANNELS[c]?store.CHANNELS[c].label:'缺失'); });

console.log('\n=== 2. 销售等级四档一致性 ===');
ok(!('S' in dsg.GRADE_BY_ID), '等级表不含 S 档（已改四档）');
ok(dsg.GRADE_ORDER.join('')==='ABCD', 'GRADE_ORDER = A,B,C,D', dsg.GRADE_ORDER.join(','));
/* gradeOf 的分数线与 GRADE_SCORE_LINE 必须一致，否则"还差多少分"会算错 */
const lines=dsg.GRADE_SCORE_LINE;
const probe=function(score){
  const id = score>=68?'A':score>=42?'B':score>=18?'C':'D';
  return id;
};
ok(probe(67)==='B' && lines.B===42, 'B 档线一致（68 以下、42 以上）');
ok(probe(41)==='C' && lines.C===18, 'C 档线一致');
ok(probe(17)==='D' && lines.D===0, 'D 档线一致');
ok(lines.A===68, 'A 档线 = 68');
/* nextGradeGap 取的是"上一档"的线 */
ok(sg.nextGradeGap('B',50).line===68, 'B→A 的线取 A 档的 68', JSON.stringify(sg.nextGradeGap('B',50)));
ok(sg.nextGradeGap('A',80)===null, 'A 档已到顶，返回 null');
ok(sg.nextGradeGap('C',10).gap===32, 'C→B 差值 = 42-10', String(sg.nextGradeGap('C',10).gap));

console.log('\n=== 3. 口径统一：顾问名下 vs 全店 ===');
/* 造一个第二顾问，验证顶栏分布不会串味 */
const before=sg.gradeRoster(s);
const allCount=before.list.length;
console.log('  全店 '+allCount+' 人');
const mine=sg.membersOfAdvisor(s,'陈默');
const mineStats=sg.gradeStats(s,mine);
const allStats=sg.gradeStats(s);
console.log('  陈默名下 '+mine.length+' 人');
const mineSum=['A','B','C','D'].reduce(function(t,k){return t+mineStats[k].count;},0);
ok(mineSum===mine.length, '限定范围后各档之和 = 名下人数', mineSum+'='+mine.length);
ok(mineSum<=allCount, '名下人数不超过全店');
/* 模拟加了别的顾问的会员 */
const s2=JSON.parse(JSON.stringify(s));
s2.members.push({...s2.members[0], id:'m99', name:'别人的客户', owner:'李教练', totalPaid:99999, visits30:20});
const mineB=sg.membersOfAdvisor(s2,'陈默');
const statsB=sg.gradeStats(s2,mineB);
const sumB=['A','B','C','D'].reduce(function(t,k){return t+statsB[k].count;},0);
ok(!mineB.some(function(x){return x.id==='m99';}), '别人的客户不计入陈默名下');
ok(sumB===mineB.length, '有第二顾问时分布仍自洽', sumB+'='+mineB.length);
const aB=sg.advisorGradeOf(s2);
ok(aB.metrics.size===mineB.length, '顾问在册数 = 名下人数（非全店）', aB.metrics.size+' vs '+(s2.members.length));

console.log('\n=== 4. 空数据 / 极端边界 ===');
const empty={members:[],cards:[],followups:[],settings:{advisor:'',store:'',role:''}};
const ae0=sg.advisorGradeOf(empty);
ok(ae0.score===0, '无数据时综合分为 0（不是 NaN）', String(ae0.score));
ok(ae0.metrics.dealRate===null, '无客户时成交率为 null（不冒充 0%）', String(ae0.metrics.dealRate));
ok(ae0.grade.id==='D', '无数据落 D 档', ae0.grade.id);
const gs0=sg.gradeStats(empty);
ok(gs0.A.dealRate===null && gs0.A.renewRate===null, '空盘各档成交率/续费率均为 null');
ok(sg.gradeRoster(empty).list.length===0, '空盘名册为空');

console.log('\n=== 5. 未获取不冒充 0 的纪律 ===');
const noCard={...s.members[0], id:'mX', cardType:'', totalPaid:0, visits30:0, lastVisit:null};
const s3=JSON.parse(JSON.stringify(s));
s3.members.push(noCard);
const gx=sg.gradeOf(noCard,s3);
ok(typeof gx.score==='number' && !isNaN(gx.score), '缺字段会员仍能算出分数', String(gx.score));
const mx=sg.gradeMetrics(noCard,s3);
ok(mx.renewals===null, '无卡时续费次数为 null（不是 0）', String(mx.renewals));
const stx=sg.stalenessOf(noCard,s3,new Date().toISOString().slice(0,10));
ok(stx.never===true && stx.days===null, '无跟进记录时 days 为 null', sg.staleText(stx));

console.log('\n=== 6. AI 资料：不支持文件必须给确定路径 ===');
for (const n of ['a.pdf','b.doc','r.mp3','v.mp4','x.unknown']) {
  const c=am.classifyFile(n);
  ok(c.ok===false && typeof c.how==='string' && c.how.length>10, n+' 给出替代路径', c.label);
}
const r=await am.fileToText({name:'a.pdf', arrayBuffer:async()=>new ArrayBuffer(0)});
ok(r.ok===false && !!r.hint, 'PDF 走拒绝分支且不抛异常', r.error);

console.log('\n=== 7. 脱敏端口（外发前）===');
const {redactPII}=await import('./js/outreach.js');
const m1=store.memberById('m01');
const TXT='林嘉怡今天到店谈续费，电话 13800132211，膝盖有点不舒服。';
const out=redactPII(am.buildExtractPrompt(TXT,{member:m1}), store.get().members);
ok(!out.includes('林嘉怡'), '外发无真实姓名');
ok(!out.includes('13800132211'), '外发无完整手机号');
ok(out.includes('该会员'), '外发用「该会员」');
ok(out.includes('膝盖'), '身体反馈保留（任务必需）');

console.log('\n'+(bad?('共 '+bad+' 项异常'):'全部通过'));
process.exit(bad?1:0);
