const lsStore = new Map();
globalThis.localStorage = { getItem:(k)=>lsStore.has(k)?lsStore.get(k):null, setItem:(k,v)=>lsStore.set(k,String(v)), removeItem:(k)=>lsStore.delete(k), clear:()=>lsStore.clear() };
Object.defineProperty(globalThis,'navigator',{value:{userAgent:'node'},configurable:true});
const mods = ['js/util.js','js/features.js','js/bizMetrics.js','js/opsBrief.js','js/douyin.js','js/store.js','js/data/seed.js','js/integrations/contract.js','js/integrations/laike.js','js/integrations/meituan.js','js/integrations/index.js','js/sheets.js','js/views/ops.js','js/views/analytics.js'];
let bad = 0;
for (const m of mods) { try { await import('./'+m); console.log('OK   '+m); } catch(e){ bad++; console.log('FAIL '+m+'  '+e.message.split('\n')[0]); } }

const { defaultFeatures, isFeatureOn } = await import('./js/features.js');
const f = defaultFeatures();
console.log('\nfeatures 默认档:', JSON.stringify(f));
console.log('社群管理默认:', isFeatureOn(f,'ops.community') ? '显示' : '隐藏');
console.log('未知模块放行:', isFeatureOn(f,'ops.notexist') ? '是（符合预期）' : '否（不符合预期）');

const bm = await import('./js/bizMetrics.js');
console.log('\ntoMetricNumber:', ['24,800','1.2万','318人','¥600','1.5%','—',''].map(v=>JSON.stringify(v)+'→'+bm.toMetricNumber(v)).join('  '));
console.log('normalizeReportDate:', ['2026-09-27','2026/9/27','9月27日','统计日期'].map(v=>JSON.stringify(v)+'→'+bm.normalizeReportDate(v)).join('  '));
console.log('列名匹配:', JSON.stringify(bm.guessMetricColumns(['统计日期','曝光人数','商品访问人数','私信开口人数','团购下单人数','核销人数','推广消耗'])));

const store = await import('./js/store.js');
store.init();
const st = store.get();
const ob = await import('./js/opsBrief.js');
const brief = ob.buildBrief(st);
console.log('\n简报日期', brief.date, '条数', brief.items.length);
brief.items.forEach(i => console.log('  ['+i.kind+'/'+i.level+'] '+i.id+'  '+i.text));
console.log('未读:', ob.unreadOf(brief, store.briefReadIds()).length);
process.exit(bad?1:0);
