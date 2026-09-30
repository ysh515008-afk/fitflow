/* ============================================================
   aiMaterial.js · AI 转写跟进（会面转写文档 → 提炼会面纪要）
   ------------------------------------------------------------
   场景：约客户到店面谈，全程用录音转写工具（如讯飞听见 / 千文等）录下来，
   导出一份转写文档。回到 FitFlow，把这份文档直接上传到该会员名下，
   由 AI 提炼成结构化的「会面纪要」：会面过程、会面结果、客户异议、跟进事项。

   三条硬边界：
   1. 文件解析全在本机浏览器完成，上传动作不产生任何网络请求。
   2. 只有点「提炼会面纪要」且取得单独同意后，才向第三方模型外发文本；
      外发前一律过 redactPII（姓名→该会员、手机号打码）。
   3. 模型返回后，把「该会员」回填成真实姓名，界面与存档始终显示真实信息。
   ============================================================ */

import { aiMaterialsOf, addAiMaterial, deleteAiMaterial, memberById, addFollowup } from './store.js';
import { MODELS, MODEL_BY_ID, callModel, loadKey, saveKey, estimateCost, activeModelConfig } from './models.js';
import { openSheet, toast, confirmDialog, emptyState, notice, badge } from './components.js';
import { esc, today, fmtDate } from './util.js';
import { redactPII } from './outreach.js';
import { ensureConsent } from './consent.js';

/* ============================================================
   一、文件类型：支持什么、不支持什么，逐档写死
   ============================================================ */

/**
 * 每种后缀的处置方式。ok=true 表示本机可直接取出文本；
 * ok=false 的档位给出确定的替代路径，不留「可能可以」的模糊说法。
 */
export const FILE_SUPPORT = [
  {
    kind: 'text', ok: true,
    ext: ['txt', 'md', 'markdown', 'text', 'log', 'csv', 'tsv', 'json', 'srt', 'vtt', 'lrc', 'xml', 'html', 'htm'],
    label: '纯文本 / 转写稿',
    how: '按 UTF-8 直接读取，无需任何转换',
  },
  {
    kind: 'docx', ok: true,
    ext: ['docx'],
    label: 'Word 文档',
    how: '内置解析：解压 docx 后取 word/document.xml 的正文段落',
  },
  {
    kind: 'pdf', ok: false,
    ext: ['pdf'],
    label: 'PDF',
    how: 'PDF 的文本层需要字体解码与版面还原，本机不内置该能力。请在转写工具里导出 txt / docx 再上传，或把转写稿直接粘贴进来',
  },
  {
    kind: 'doc', ok: false,
    ext: ['doc'],
    label: 'Word 97-2003 旧格式',
    how: '.doc 是二进制封闭格式，本机不解析。请用 Word 另存为 .docx 或 .txt 后上传',
  },
  {
    kind: 'audio', ok: false,
    ext: ['mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac', 'amr', 'mp4', 'mov', 'webm', 'mkv'],
    label: '录音 / 视频',
    how: '音频转文字需要语音识别（ASR）服务，FitFlow 本机不做转写。请先用录音转写工具导出文档再上传，或把转写稿直接粘贴进来',
  },
];

const EXT_KIND = new Map();
for (const g of FILE_SUPPORT) for (const e of g.ext) EXT_KIND.set(e, g);

/** 取后缀（不含点，小写）。文件名没有后缀就返回空串。 */
export function extOf(name) {
  const i = String(name || '').lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
}

/** 判定一个文件能不能在本机取出文本。返回 { kind, ok, label, how }。 */
export function classifyFile(fileName) {
  return EXT_KIND.get(extOf(fileName)) || {
    kind: 'unknown', ok: false, label: '未识别的文件类型',
    how: '本机只处理纯文本类与 .docx。请导出为 txt / docx 后重新选择',
  };
}

export const ACCEPT_ATTR = FILE_SUPPORT.flatMap((g) => g.ext.map((e) => '.' + e)).join(',');

/* ============================================================
   二、文件 → 纯文本
   ============================================================ */

/** 纯文本类：按 UTF-8 读。读到 BOM 会自动被 TextDecoder 吃掉。 */
function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('读取文件失败：' + (file.name || '')));
    r.readAsText(file, 'utf-8');
  });
}

/**
 * .docx 是 ZIP 容器，正文在 word/document.xml。
 * 这里写一个最小 ZIP 读取器：定位中央目录 → 找到 word/document.xml 的
 * 本地头偏移 → 按压缩方法取出字节 → 抽 <w:t> 文本。
 * 不引第三方库，全程同步 DataView 操作。
 */
export async function docxToText(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const SIG_EOCD = 0x06054b50;
  const SIG_CEN = 0x02014b50;
  const SIG_LOC = 0x04034b50;

  /* 目录结束标记在文件尾部，从后往前找（尾部最多 64KB 注释区） */
  let eocd = -1;
  const scanFrom = Math.max(0, arrayBuffer.byteLength - 22 - 65535);
  for (let i = arrayBuffer.byteLength - 22; i >= scanFrom; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这个文件不是有效的 .docx（找不到 ZIP 目录结束标记）。请确认它是在 Word 里正常保存的 .docx');

  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  let entry = null;

  for (let i = 0; i < count; i++) {
    if (off + 46 > arrayBuffer.byteLength) break;
    if (dv.getUint32(off, true) !== SIG_CEN) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(arrayBuffer, off + 46, nameLen));
    if (name === 'word/document.xml') { entry = { method, compSize, localOff }; break; }
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (!entry) throw new Error('这个 .docx 里没有 word/document.xml，正文无法定位');

  if (entry.localOff + 30 > arrayBuffer.byteLength) throw new Error('这个 .docx 的本地文件头越界，文件可能已损坏');
  if (dv.getUint32(entry.localOff, true) !== SIG_LOC) throw new Error('这个 .docx 的本地文件头签名不对，文件可能已损坏');

  const lNameLen = dv.getUint16(entry.localOff + 26, true);
  const lExtraLen = dv.getUint16(entry.localOff + 28, true);
  const dataOff = entry.localOff + 30 + lNameLen + lExtraLen;
  /* compSize 为 0 说明用了数据描述符（流式写出），此时一路读到文件尾，
     解压器遇到流结束会自行停下 */
  const len = entry.compSize > 0 ? entry.compSize : Math.max(0, arrayBuffer.byteLength - dataOff);
  const raw = new Uint8Array(arrayBuffer, dataOff, len);

  let bytes;
  if (entry.method === 0) bytes = raw;                              // 未压缩
  else if (entry.method === 8) bytes = await inflateRaw(raw);       // deflate
  else throw new Error('这个 .docx 用了不支持的压缩方式（method=' + entry.method + '），请用 Word 重新保存一次');

  return xmlToText(new TextDecoder('utf-8').decode(bytes));
}

/** deflate-raw 解压。浏览器原生 DecompressionStream，无第三方依赖。 */
async function inflateRaw(u8) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前浏览器不支持 DecompressionStream，无法解析 .docx。请改用 txt，或换用较新版本的浏览器');
  }
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 从 word/document.xml 抽正文：段落换行、制表符、<w:t> 文本。
 * 一个 <w:p> 收敛成一行 —— 转写稿通常是几百个短段落，
 * 段间留空行会把文本体积翻倍，白耗模型的输入 token。
 */
export function xmlToText(xml) {
  return String(xml)
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (_, t) => decodeEntities(t))
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeChr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeChr(parseInt(n, 10)))
    .replace(/&amp;/g, '&');
}
const safeChr = (n) => (Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

/**
 * 统一入口：文件 → 文本。
 * 返回 { ok, text, kind, label, error, hint }
 */
export async function fileToText(file) {
  const cls = classifyFile(file.name);
  if (!cls.ok) {
    /* 中英文之间补空格：直接拼会得到「解析PDF」这种挤在一起的文案 */
    return { ok: false, kind: cls.kind, label: cls.label, error: `暂不支持直接解析 ${cls.label}`, hint: cls.how };
  }
  try {
    if (cls.kind === 'docx') {
      const text = await docxToText(await file.arrayBuffer());
      if (!text.trim()) return { ok: false, kind: 'docx', label: cls.label, error: '这个 .docx 里没有取到正文', hint: '如果正文是图片或文本框，请另存为 txt 后上传' };
      return { ok: true, text, kind: 'docx', label: cls.label };
    }
    const text = await readAsText(file);
    if (!text.trim()) return { ok: false, kind: 'text', label: cls.label, error: '这个文件是空的', hint: '请确认转写工具已导出正文内容' };
    return { ok: true, text, kind: cls.kind, label: cls.label };
  } catch (e) {
    return { ok: false, kind: cls.kind, label: cls.label, error: e?.message || String(e), hint: cls.how };
  }
}

/* ============================================================
   三、提炼提示词（纯函数，可在 Node 里直接校验）
   ============================================================ */

export const NOTE_SECTIONS = [
  { key: 'summary', tag: '会面概要', desc: '一句话说清这次面谈是什么事，不超过 60 字' },
  { key: 'process', tag: '会面过程', desc: '按发生顺序列出关键环节，每条一行，以「- 」开头' },
  { key: 'results', tag: '会面结果', desc: '这次达成的共识、明确的结论、客户做出的承诺，每条一行，以「- 」开头' },
  { key: 'objections', tag: '客户异议', desc: '客户提出的顾虑、拒绝理由、未解决的分歧；没有就写「无」' },
  { key: 'actions', tag: '跟进事项', desc: '接下来要做的动作，格式「动作｜时间」，例：出续费方案报价｜本周五前' },
];

/**
 * 构造提炼提示词。
 * 注意：传入的 transcript 应当是**已脱敏**文本（外发端口负责）。
 * 模型被告知用「该会员」指代客户，回来后由 unredact 回填真实姓名。
 */
export function buildExtractPrompt(transcript, { member, meetDate } = {}) {
  const who = member ? `该会员（${member.gender || ''}${member.age ? member.age + ' 岁' : ''}，会籍 ${member.cardType || '未办卡'}）` : '该会员';
  const maxChars = 24000;
  const clipped = transcript.length > maxChars;
  const body = clipped ? transcript.slice(0, maxChars) : transcript;

  const schema = NOTE_SECTIONS.map((s) => `【${s.tag}】\n${s.desc}`).join('\n\n');

  return `你是一名健身门店的会籍顾问助理。下面是一段门店与客户当面谈的转写记录，请把它提炼成一份可直接归档的会面纪要。

# 输出格式（严格照抄，不要加其他章节，不要写开场白和结尾）
${schema}

【结果判定】
只输出这三个词中的一个：推进 / 中性 / 拒绝
（推进 = 客户有明确正向动作或承诺；中性 = 有交流但没定；拒绝 = 明确拒绝或终止）

# 提炼要求
1. 只写转写记录里真实出现的内容。记录里没有的，一律不写，不得推测、不得补全。
2. 客户一律称「${who}」，不要出现任何真实姓名、手机号、身份证号、住址。
3. 数字、金额、日期、卡种、课时一律照原文保留，不要换算、不要四舍五入。
4. 「会面过程」按时间顺序，每条不超过 40 字，最多 8 条。
5. 「跟进事项」的动作要具体到能直接执行，时间写原文提到的时间点；原文没提时间就写「待定」。
6. 转写记录里的口语、重复、语气词全部剔除，保留事实。

# 会面日期
${meetDate || today()}

# 转写记录（共 ${transcript.length} 字${clipped ? `，本次送入前 ${maxChars} 字` : ''}）
${body}`;
}

/* ============================================================
   四、解析模型返回的纪要
   ============================================================ */

const TAG_ALIAS = {
  会面概要: 'summary', 概要: 'summary',
  会面过程: 'process', 过程: 'process',
  会面结果: 'results', 结果: 'results',
  客户异议: 'objections', 异议: 'objections',
  跟进事项: 'actions', 跟进: 'actions',
  结果判定: 'verdict', 判定: 'verdict',
};

const VERDICT_MAP = { 推进: 'positive', 中性: 'neutral', 拒绝: 'negative' };

/** 去掉行首的 - • * 、数字序号等列表符号 */
const stripBullet = (line) => String(line).replace(/^\s*[-•*·]\s*/, '').replace(/^\s*\d+[.、)]\s*/, '').trim();

/**
 * 解析模型输出。返回
 * { ok, summary, process[], results[], objections[], actions[{action,when}], result, verdictText, missing[] }
 * ok=false 时 missing 列出缺了哪些必填章节。
 */
export function parseMeetingNote(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const bucket = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*【\s*([^】]{1,12})\s*\】\s*(.*)$/);
    if (m) { cur = TAG_ALIAS[m[1]] || null; if (cur) { bucket[cur] = []; if (m[2].trim()) bucket[cur].push(m[2].trim()); } continue; }
    if (cur && line.trim()) bucket[cur].push(line.trim());
  }

  const lines = (k) => (bucket[k] || []).map(stripBullet).filter(Boolean);
  const actions = lines('actions').map((l) => {
    const i = l.indexOf('｜') >= 0 ? l.indexOf('｜') : l.indexOf('|');
    return i >= 0 ? { action: l.slice(0, i).trim(), when: l.slice(i + 1).trim() } : { action: l, when: '待定' };
  });

  const verdictText = ((bucket.verdict || []).join('') || '').replace(/[^\u4e00-\u9fa5]/g, '');
  const result = VERDICT_MAP[verdictText] || (verdictText.includes('推进') ? 'positive' : verdictText.includes('拒绝') ? 'negative' : 'neutral');
  const summary = (bucket.summary || []).join('').trim();

  const missing = [];
  if (!summary) missing.push('会面概要');
  if (!lines('process').length) missing.push('会面过程');
  if (!lines('results').length) missing.push('会面结果');

  return {
    ok: missing.length === 0,
    missing,
    summary,
    process: lines('process'),
    results: lines('results'),
    objections: lines('objections'),
    actions,
    result,
    verdictText: verdictText || '未判定',
  };
}

/** 把「该会员」回填成真实姓名（外发脱敏的逆向处理，只作用在本地文本上） */
export function unredact(text, memberName) {
  if (!text || !memberName) return text;
  return String(text).split('该会员').join(memberName);
}

/** 纪要 → 跟进记录正文（给人看的纯文本，用于存档与列表预览） */
export function noteToPlainText(note) {
  const lines = [];
  if (note.summary) lines.push(note.summary);
  if (note.results.length) { lines.push(''); lines.push('结果：' + note.results.join('；')); }
  if (note.objections.length) lines.push('异议：' + note.objections.join('；'));
  if (note.actions.length) lines.push('跟进：' + note.actions.map((a) => `${a.action}（${a.when}）`).join('；'));
  return lines.join('\n').trim();
}

/* ============================================================
   五、外发调用 + 同意文案
   ============================================================ */

function extractConsentBody(member, fileLabel, chars) {
  return `
    <div class="kv"><span>接收方</span><span>你在下方选择的第三方大模型厂商（${esc(MODELS.filter((m) => m.callable).map((m) => m.vendor).filter((v, i, a) => a.indexOf(v) === i).join('、'))}）</span></div>
    <div class="kv"><span>外发内容</span><span>${esc(fileLabel)}的正文文本，约 ${chars} 字</span></div>
    <div class="kv"><span>涉及个人信息</span><span>${member ? '会员的谈话内容、消费意向、身体反馈' : '谈话内容'}</span></div>
    <div class="kv"><span>脱敏措施</span><span>姓名替换为「该会员」，手机号打码为前 3 + **** + 后 4。年龄、卡种、到店轨迹、身体反馈为完成任务所必需，予以保留</span></div>
    <div class="kv"><span>用途</span><span>仅用于生成这一次会面的纪要，不用于训练、不用于其他用途</span></div>
    <div class="kv"><span>存储</span><span>返回结果与原文只写入本机浏览器，不外传</span></div>
    <div class="hint" style="margin-top:8px">部分模型厂商的服务节点在境外，构成个人信息出境。继续即表示你已就单独同意事项向该会员履行了告知义务。</div>`;
}

/**
 * 提炼一次：取得同意 → 端口脱敏 → 调用模型 → 回填真实姓名 → 返回纪要。
 * el 是抽屉根节点，用来读模型 / Key / Endpoint / 状态位。
 */
export async function runExtract(el, { ctx, member, rawText, fileLabel, onDone }) {
  const status = el.querySelector('#amStatus');
  /* 模型与密钥统一来自「AI 接口」总开关，不在本界面单独登记 */
  const cfg = activeModelConfig(ctx);
  const m = cfg.model;
  const apiKey = cfg.key;
  const endpoint = cfg.endpoint;
  const setStatus = (cls, txt) => { status.className = 'model-status ' + cls; status.textContent = txt; };

  if (!apiKey) { setStatus('is-err', '请先在「AI 接口」总开关里配置当前模型的密钥。'); return; }

  const ok = await ensureConsent('aiSend', {
    title: '确认外发会面转写文本',
    danger: true,
    body: extractConsentBody(member, fileLabel, rawText.length),
  });
  if (!ok) { setStatus('is-err', '已取消发送：未获得向第三方提供会面内容的单独同意。'); return; }

  /* 数据交换端口脱敏：姓名与手机号在真正 fetch 之前处理掉 */
  const outbound = redactPII(buildExtractPrompt(rawText, { member, meetDate: today() }), member ? [member] : []);

  const btn = el.querySelector('[data-extract]');
  /* 长跑按钮：同时置 disabled 与 is-loading（is-loading 出旋转圈并隐藏原图标），
     两者必须成对开关，否则中途取消会留下永远转圈的按钮。 */
  if (btn) { btn.disabled = true; btn.classList.add('is-loading'); }
  setStatus('is-loading', `正在调用 ${m.name} 提炼纪要 …（约 5–30 秒；跨域请求需目标接口返回 CORS 头，否则浏览器会拦截响应）`);

  try {
    const r = await callModel(m.id, { prompt: outbound, apiKey, endpoint, temperature: 0.3, maxTokens: 2000 });
    if (!r.ok) { setStatus('is-err', '✗ ' + r.error); return; }
    /* 回填真实姓名：外发时是脱敏文本，回来后界面与存档都显示真实信息 */
    const parsed = parseMeetingNote(unredact(r.text, member?.name));
    if (!parsed.ok) {
      setStatus('is-err', `✗ 模型返回的内容缺少「${parsed.missing.join('、')}」章节，无法归档。可再点一次提炼，或把下方原文复制出去手工整理。`);
      return;
    }
    const est = estimateCost(m, outbound.length, 900);
    setStatus('is-ok', `✓ ${m.name} 已返回。预估本次约 ¥${est.yuan.toFixed(4)}（约 ${est.inTok} 输入 token）。核对下方内容后可存为跟进记录。`);
    onDone && onDone(parsed, r.text);
  } catch (e) {
    setStatus('is-err', '✗ ' + (e?.message || String(e)));
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); }
  }
}

/* ============================================================
   六、界面：AI 转写跟进抽屉
   ============================================================ */

function noteHtml(note) {
  const block = (title, rows, cls) => rows && rows.length
    ? `<div class="am-block">
         <div class="am-bt">${esc(title)}</div>
         <ul class="am-list">${rows.map((x) => `<li class="${cls || ''}">${esc(x)}</li>`).join('')}</ul>
       </div>`
    : '';
  return `
    <div class="am-note">
      <div class="am-summary">${esc(note.summary)}</div>
      <div class="am-verdict">${badge('结果判定：' + note.verdictText, note.result === 'positive' ? 'b-green' : note.result === 'negative' ? 'b-danger' : 'b-plain')}</div>
      ${block('会面过程', note.process)}
      ${block('会面结果', note.results)}
      ${block('客户异议', note.objections)}
      ${note.actions.length ? `<div class="am-block">
        <div class="am-bt">跟进事项</div>
        <ul class="am-list">${note.actions.map((a) => `<li><span>${esc(a.action)}</span><span class="am-when">${esc(a.when)}</span></li>`).join('')}</ul>
      </div>` : ''}
    </div>`;
}

/**
 * AI 转写跟进抽屉。
 * 三步：① 上传 / 粘贴转写稿 → ② 提炼会面纪要 → ③ 存为跟进记录
 */
export function openAiMaterialSheet(memberId, ctx) {
  const m = memberById(memberId);
  if (!m) return toast('找不到这位会员', 'warn');

  let rawText = '';
  let fileLabel = '转写稿';
  let note = null;          // 当前提炼结果
  let rawOut = '';          // 模型原始返回
  let saved = null;         // 已入库的资料记录

  openSheet({
    title: 'AI 转写跟进',
    subtitle: `${esc(m.name)} · 上传会面转写文档，提炼成可归档的会面纪要`,
    size: 'tall',
    body: `<div id="amRoot"></div>`,
    footer: `<button class="btn ghost" data-sheet-close>关闭</button>`,
    onMount(el, close) {
      const root = el.querySelector('#amRoot');

      const paint = () => {
        root.innerHTML = `
          ${notice('上传的文档只在<strong>本机浏览器</strong>内解析，上传动作本身不联网。只有点「提炼会面纪要」并确认后，文本才会发给你选定的模型厂商；发出前姓名替换为「该会员」、手机号打码，返回后自动回填真实姓名。', 'info', 'i-shield')}

          <div class="section-title">① 上传会面转写文档</div>
          <div class="am-drop" id="amDrop">
            <svg viewBox="0 0 24 24"><use href="#i-upload"/></svg>
            <div class="am-dt">把转写文档拖到这里，或点此选择文件</div>
            <div class="am-ds">录音转写工具导出的 txt / md / srt / docx 都可直接上传</div>
            <input type="file" id="amFile" accept="${ACCEPT_ATTR}" hidden/>
          </div>
          <div id="amFileInfo"></div>

          <div class="section-title">或直接粘贴转写稿</div>
          <div class="paste-zone">
            <textarea id="amPaste" rows="5" placeholder="把录音转写工具里的文字整段粘贴到这里">${esc(rawText)}</textarea>
          </div>
          <div class="hint" id="amChars">当前 ${rawText.length} 字</div>

          ${rawText ? `
            <div class="section-title">② 提炼会面纪要</div>
            ${renderModelCallBar(ctx)}
          ` : ''}

          <div id="amNoteBox">${note ? `
            <div class="section-title">③ 核对并归档</div>
            ${noteHtml(note)}
            <div class="btn-row" style="margin-top:10px">
              <button class="btn primary" data-save-note><svg viewBox="0 0 24 24"><use href="#i-check"/></svg>存为跟进记录</button>
              <button class="btn ghost" data-reextract>重新提炼</button>
            </div>
            <details class="am-raw"><summary>查看模型原始返回</summary><pre>${esc(rawOut)}</pre></details>
          ` : ''}</div>

          <div class="section-title">支持的文件类型</div>
          <div class="am-types">${FILE_SUPPORT.map((g) => `
            <div class="am-type ${g.ok ? 'ok' : 'no'}">
              <div class="am-th"><span>${esc(g.label)}</span>${badge(g.ok ? '可直接上传' : '需先转换', g.ok ? 'b-green' : 'b-warn')}</div>
              <div class="am-te">${esc(g.ext.map((e) => '.' + e).join(' '))}</div>
              <div class="am-ti">${esc(g.how)}</div>
            </div>`).join('')}</div>

          <div class="section-title">历史转写 ${aiMaterialsOf(memberId).length}</div>
          ${historyHtml(memberId, saved)}`;
      };

      const setText = (t, label) => {
        rawText = String(t || '').trim();
        fileLabel = label || '转写稿';
        note = null; rawOut = '';
        paint();
        bind();
      };

      function bind() {
        const drop = root.querySelector('#amDrop');
        const input = root.querySelector('#amFile');
        if (drop && input) {
          drop.onclick = () => input.click();
          input.onchange = async () => {
            const f = input.files?.[0];
            if (!f) return;
            const r = await fileToText(f);
            if (!r.ok) {
              root.querySelector('#amFileInfo').innerHTML =
                `<div class="notice warn" style="margin-top:8px"><svg viewBox="0 0 24 24"><use href="#i-alert"/></svg><div><strong>${esc(r.error)}</strong><br/>${esc(r.hint)}</div></div>`;
              return;
            }
            setText(r.text, f.name);
            const info = root.querySelector('#amFileInfo');
            if (info) info.innerHTML = `<div class="notice info" style="margin-top:8px"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg><div>已读取 <strong>${esc(f.name)}</strong>（${r.label}，${r.text.length} 字）</div></div>`;
          };
          ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
          ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
          drop.addEventListener('drop', async (e) => {
            const f = e.dataTransfer?.files?.[0];
            if (!f) return;
            const r = await fileToText(f);
            if (!r.ok) { toast(r.error + '｜' + r.hint, 'warn'); return; }
            setText(r.text, f.name);
          });
        }

        const paste = root.querySelector('#amPaste');
        if (paste) {
          paste.oninput = () => {
            rawText = paste.value.trim();
            const c = root.querySelector('#amChars');
            if (c) c.textContent = `当前 ${rawText.length} 字`;
          };
          paste.onblur = () => { if (paste.value.trim() !== rawText) setText(paste.value, '粘贴的转写稿'); };
        }

        const usePaste = root.querySelector('[data-use-paste]');
        if (usePaste) usePaste.onclick = () => setText(root.querySelector('#amPaste').value, '粘贴的转写稿');

        const ex = root.querySelector('[data-extract]');
        if (ex) ex.onclick = () => runExtract(el, {
          ctx, member: m, rawText, fileLabel,
          onDone: (parsed, raw) => { note = parsed; rawOut = raw; paint(); bind(); },
        });

        const mkt = root.querySelector('[data-ai-portal]');
        if (mkt) mkt.onclick = () => import('./sheets.js').then((mod) => mod.openAiPortal(ctx));

        const sv = root.querySelector('[data-save-note]');
        if (sv) sv.onclick = () => {
          if (!note) return;
          /* nextDate 留空：纪要里的跟进事项带的是自然语言时间点（"下月 10 号"），
             没有解析成日期的规则就不要硬猜，写进 nextAction 由人自己定日期。 */
          /* channel 必须落在 store 的 CHANNELS 枚举内。
             早先这里写 'offline'，枚举里没有这一项，档案时间轴那句
             `CHANNELS[x.channel]?.label || x.channel` 会把英文原词直接显示出来。
             AI 转写跟进的场景就是客户到店面谈，枚举里对应的是 visit。 */
          addFollowup({
            memberId: m.id,
            channel: 'visit',
            summary: noteToPlainText(note),
            feedback: note.objections.join('；'),
            result: note.result,
            nextAction: note.actions.map((a) => `${a.action}（${a.when}）`).join('；'),
            nextDate: null,
            psych: { stage: 'p1', state: null, principles: [], microCommit: note.results.join('；'), note: '', checks: [] },
            from: 'ai-material',
          });
          saved = addAiMaterial({
            memberId: m.id, fileName: fileLabel, fileSize: rawText.length,
            kind: extOf(fileLabel) === 'docx' ? 'docx' : 'text',
            rawText, note,
          });
          toast('已存为跟进记录，原文与纪要归档在本会员名下');
          paint(); bind();
          ctx.refresh();
        };

        const re = root.querySelector('[data-reextract]');
        if (re) re.onclick = () => { note = null; rawOut = ''; paint(); bind(); };

        root.querySelectorAll('[data-del-mat]').forEach((b) => {
          b.onclick = () => confirmDialog({
            title: '删除这份资料',
            message: '原文与提炼出的纪要会一起删除，已存入跟进记录的内容不受影响。',
            confirmText: '删除', danger: true,
            onConfirm: () => { deleteAiMaterial(b.dataset.delMat); toast('已删除'); paint(); bind(); ctx.refresh(); },
          });
        });
      }

      paint();
      bind();
    },
  });
}

/* 「② 选模型直接调用」的精简版：只展示当前总开关接口 + 提炼按钮，
   模型切换与密钥统一在「AI 接口」总开关里设置，这里不再内嵌下拉与密钥输入。 */
export function renderModelCallBar(ctx) {
  const cfg = ctx ? activeModelConfig(ctx) : { model: MODEL_BY_ID['doubao'], key: '', endpoint: '' };
  const m = cfg.model;
  return `
    <div class="model-call">
      <div class="ai-master-card">
        <div class="ai-mc-row"><span class="ai-mc-label">当前接口</span><b>${esc(m.name)}</b><span class="muted">· ${esc(m.vendor)}</span></div>
        <div class="hint">模型切换与密钥统一在「AI 接口」总开关里设置，这里直接调用当前接口。</div>
        <div class="model-call-bar">
          <button class="btn primary" data-extract><svg viewBox="0 0 24 24"><use href="#i-spark"/></svg>提炼会面纪要</button>
          <button class="btn ghost" data-ai-portal>去 AI 接口总开关</button>
        </div>
        <div id="amStatus" class="model-status"></div>
      </div>
      <div class="hint">浏览器页面内的 fetch 受同源策略约束：目标接口未返回允许本页域名的 CORS 响应头（Access-Control-Allow-Origin）时，响应会被浏览器拦截而读取失败。若调用失败，请把原文复制到豆包网页版里跑，再把结果粘回「历史资料」对应的文本框。密钥只存本机 localStorage，绝不上传。</div>
    </div>`;
}

function historyHtml(memberId, justSaved) {
  const list = aiMaterialsOf(memberId);
  if (!list.length) return emptyState('还没有上传过会面资料', 'i-doc');
  return `<div class="list">${list.map((x) => `
    <div class="list-item am-hist${justSaved?.id === x.id ? ' is-new' : ''}">
      <div class="li-body">
        <div class="li-top">
          <span class="li-name">${esc(x.fileName || '粘贴的转写稿')}</span>
          ${x.note ? badge('已提炼', 'b-green') : badge('仅存档', 'b-plain')}
        </div>
        <div class="li-meta">
          <span>${esc(fmtDate(String(x.createdAt).slice(0, 10), 'ymd'))}</span>
          <span>${x.rawText.length} 字</span>
          ${x.note ? `<span>${esc(x.note.verdictText || '')}</span>` : ''}
        </div>
        ${x.note ? `<div class="small muted" style="margin-top:4px;line-height:1.55">${esc(x.note.summary)}</div>` : ''}
      </div>
      <button class="btn ghost sm" data-del-mat="${x.id}">删除</button>
    </div>`).join('')}</div>`;
}
