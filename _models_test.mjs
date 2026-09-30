import { MODELS, MODEL_BY_ID, queryModels, diffMeta, costMeta, callModel, estimateCost, saveKey, loadKey } from './js/models.js';

let fail = 0;
const must = (cond, msg) => { if (!cond) { fail++; console.log('FAIL ' + msg); } else console.log('OK   ' + msg); };

/* 1. 注册表完整性 */
must(MODELS.length >= 6, `模型数量 ${MODELS.length} ≥ 6`);
const req = ['id','name','vendor','flagship','ctx','callable','endpoint','apiModel','webUrl','free','input','output','costTier','difficulty','auth','strength','note'];
for (const m of MODELS) {
  for (const k of req) must(m[k] !== undefined && m[k] !== null && m[k] !== '', `${m.id}.${k} 有值`);
  must(typeof m.input === 'number' && m.input >= 0, `${m.id}.input 是数字`);
  must(typeof m.output === 'number' && m.output >= 0, `${m.id}.output 是数字`);
  must([1,2,3,4,5].includes(m.difficulty), `${m.id}.difficulty ∈ 1..5`);
  must([1,2,3,4,5].includes(m.costTier), `${m.id}.costTier ∈ 1..5`);
  must(m.endpoint.startsWith('https://'), `${m.id}.endpoint 是 https`);
}

/* 2. id 唯一 */
const ids = new Set(MODELS.map(m=>m.id));
must(ids.size === MODELS.length, 'id 不重复');

/* 3. 查询接口 */
must(queryModels({callableOnly:true}).every(m=>m.callable), 'callableOnly 过滤生效');
must(queryModels({q:'deep'}).some(m=>m.id==='deepseek'), '按关键词查询生效');
must(MODEL_BY_ID.deepseek && MODEL_BY_ID.deepseek.name==='DeepSeek', 'MODEL_BY_ID 可取');

/* 4. 元数据映射 */
must(!!diffMeta(1).label && !!diffMeta(5).label, 'diffMeta 有标签');
must(!!costMeta(1).label && !!costMeta(5).label, 'costMeta 有标签');
must(diffMeta(9).label, 'diffMeta 越界回退');

/* 5. 代价估算（纯函数，不联网） */
const est = estimateCost(MODEL_BY_ID.deepseek, 2000, 800);
must(est.inTok > 0 && est.yuan > 0, `estimateCost 返回正数 ≈¥${est.yuan.toFixed(5)}`);

/* 6. callModel 容错：无 key / 无 endpoint 直接报错，不抛异常 */
const r1 = await callModel('deepseek', { prompt:'hi' });
must(r1.ok === false && typeof r1.error === 'string', `缺 key 优雅报错：${r1.error}`);
const r2 = await callModel('nope', { prompt:'x', apiKey:'k' });
must(r2.ok === false, '未知模型报错');

/* 7. 本机密钥存取（localStorage 桩） */
globalThis.localStorage = { _m:{}, getItem(k){return this._m[k]??null;}, setItem(k,v){this._m[k]=String(v);}, removeItem(k){delete this._m[k];} };
saveKey('deepseek','sk-test','https://x');
const loaded = loadKey('deepseek');
must(loaded.key==='sk-test' && loaded.endpoint==='https://x', '密钥存取往返');

console.log('\n' + (fail ? `共 ${fail} 项异常` : '全部通过 ✓'));
process.exit(fail?1:0);
