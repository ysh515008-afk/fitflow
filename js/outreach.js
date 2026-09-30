/* ============================================================
   outreach.js · 运动综合 + 客户触达台
   ------------------------------------------------------------
   两块东西：

   1. motionOf(m) —— 把"这位会员练得怎么样"变成两个能解释的标签。
      口径全写在一张可遍历的表里（MOTION_TIERS），不给黑盒分数。
      没数据的会员说"无运动记录"，不补 0 冒充"停练"。

   2. 触达台 —— 点「去处理」之后落地的地方：话术 + 拨号 + 微信。
      话术默认本地规则生成（离线可用、零等待），
      配了云端模型就用大模型润色，没配就老实退回本地并标清来源。

   移动端约束（安卓 / iOS 都要过）：
     · 拨号用 <a href="tel:">，两端都能唤起。纯 JS 跳转在 iOS 上
       只在用户手势里才认，所以不做"自动拨号"，一律点按钮。
     · 微信没有能预填文字的 URL Scheme。主路径是"复制 + 唤起微信"，
       唤不起就明确说已复制，不假装消息发出去了。
     · 剪贴板在非 HTTPS 下 navigator.clipboard 不可用，走 execCommand 兜底。
     · 输入控件字号不小于 16px，否则 iOS 会自动放大整个页面。
   ============================================================ */
import { cardsOfMember, memberById, logReach, pendingReachOf, updateFollowup, reachTime, bumpWorkload } from './store.js';
import { CARD_TYPES } from './data/membership.js';
import { esc, today, daysBetween, copyText, fmtDate, d } from './util.js';
import { openSheet, toast, notice, textareaField, field } from './components.js';
import { ensureConsent } from './consent.js';
import { activeModelConfig } from './models.js';

/* ============================================================
   一、运动综合
   ============================================================ */

/**
 * 分档表。按「近 30 天到店次数」切，再用「最近到店」修正。
 * 为什么不用百分制：到店次数本来就是一个能被会员本人验证的数字，
 * 换算成 87 分这种，他问一句"凭什么是 87"就答不上来。
 */
export const MOTION_TIERS = [
  { id: 'high', min: 12, label: '高频稳定', cls: 'b-green', note: '每周 3 次以上。习惯已经长在身上，谈续费、请他转介绍都最省力' },
  { id: 'regular', min: 8, label: '规律', cls: 'b-green', note: '每周 2 次上下，节奏稳。适合深化关系，别用催的' },
  { id: 'normal', min: 4, label: '正常', cls: 'b-info', note: '每周 1 次上下。还有提升空间，可以聊频次安排' },
  { id: 'low', min: 1, label: '偏低', cls: 'b-warn', note: '一个月来不了几次，习惯还没立住，重点在降门槛不在加量' },
  { id: 'zero', min: 0, label: '停练', cls: 'b-danger', note: '近 30 天没有到店记录。微信已经很难拉回来，换电话' },
];

/** 修正规则：次数看着不少，但最近很久没来，说明正在掉队。 */
export const MOTION_OVERRIDES = [
  { ifSilentOver: 30, force: 'zero', flag: '已掉队 30 天以上' },
  { ifSilentOver: 21, force: 'low', flag: '近期在掉队' },
  { ifSilentOver: 14, flag: '刚出现空档' },
];

/**
 * 算一位会员的运动综合。
 * @returns {{known:boolean, tier:object, freq:number, perWeek:number,
 *            silentDays:number|null, flags:string[], why:string, monthAvg:string}}
 */
export function motionOf(m) {
  const freq = Number(m?.visits30) || 0;
  const silentDays = m?.lastVisit ? -daysBetween(today(), m.lastVisit) : null;

  /* 没有任何到店线索的时候，说"无记录"，不要说"停练"。
     这两件事对销售的含义完全相反：一个是数据没接进来，一个是人真的要走了。 */
  if (!m?.lastVisit && !freq) {
    return {
      known: false,
      tier: { id: 'unknown', label: '无运动记录', cls: 'b-plain', note: '还没有任何到店数据。三体或勤鸟接通后会自动补上，也可以手工填最近到店日期' },
      freq: 0, perWeek: 0, silentDays: null, flags: [],
      why: '没有到店记录可比对',
      monthAvg: '无记录',
    };
  }

  let tier = MOTION_TIERS.find((t) => freq >= t.min) || MOTION_TIERS[MOTION_TIERS.length - 1];
  const flags = [];

  if (silentDays != null) {
    for (const o of MOTION_OVERRIDES) {
      if (silentDays >= o.ifSilentOver) {
        if (o.force) {
          const forced = MOTION_TIERS.find((t) => t.id === o.force);
          if (forced && MOTION_TIERS.indexOf(forced) > MOTION_TIERS.indexOf(tier)) tier = forced;
        }
        if (o.flag) flags.push(o.flag);
        break;
      }
    }
  }

  const perWeek = Math.round((freq / 30) * 7 * 10) / 10;
  const silentLabel = silentDays == null ? null
    : silentDays <= 0 ? '今天到店'
    : silentDays === 1 ? '昨天到店'
    : `最近 ${silentDays} 天前到店`;
  const why = silentLabel == null
    ? `近 30 天到店 ${freq} 次`
    : `近 30 天到店 ${freq} 次，折算每周 ${perWeek} 次，${silentLabel}`;

  return {
    known: true, tier, freq, perWeek, silentDays, flags, why,
    /* "月均 9 次/月" 是重复的：月均和 /月 说的是同一件事。
       统一写成"近 30 天 N 次"，跟卡片上另一处口径完全一致。 */
    monthAvg: `近 30 天 ${freq} 次`,
  };
}

/** 任务卡上那两个标签的 HTML。运动综合 + 近 30 天频率。 */
export function motionTags(m, opts = {}) {
  const mo = motionOf(m);
  const compact = opts.compact;
  /* 没有任何到店线索时只出一个标签。
     "运动综合 · 无运动记录" 后面再跟一句 "近 30 天 无记录" 是同义反复，
     只会把名字那一行挤满，而这一行是要一眼扫过决定先打给谁的。 */
  const freq = mo.known ? `<span class="src" title="${esc(mo.why)}">${esc(mo.monthAvg)}</span>` : '';
  return `<span class="badge ${mo.tier.cls}" title="${esc(mo.tier.note)}">运动综合 · ${esc(mo.tier.label)}</span>`
    + freq
    + (compact ? '' : mo.flags.map((f) => `<span class="src warn">${esc(f)}</span>`).join(''));
}

/* ============================================================
   二、卡 / 课到期提醒
   ============================================================ */

/** 卡和课里最急的那一条，做成名字后面的徽标。没有就返回 null。 */
export function dueWatch(m) {
  const cards = cardsOfMember(m.id);
  /* 优先课时 / 次数：归零是瞬间的事，到期还有缓冲 */
  const cnt = cards
    .filter((c) => ['pt', 'group', 'count'].includes(c.typeId) && c.remainCount != null)
    .sort((a, b) => a.remainCount - b.remainCount)[0];
  if (cnt && cnt.remainCount <= 3) {
    return {
      key: 'count', level: cnt.remainCount <= 1 ? 1 : 2,
      label: cnt.remainCount <= 0 ? `${cnt.name} 已用完` : `${cnt.name} 剩 ${cnt.remainCount}${CARD_TYPES[cnt.typeId]?.unit || '次'}`,
      cardId: cnt.id,
    };
  }

  if (m.expireDate) {
    const left = daysBetween(today(), m.expireDate);
    if (left < 0) return { key: 'expired', level: 1, label: `会籍已过期 ${-left} 天` };
    if (left <= 7) return { key: 'urgent', level: 1, label: `会籍 ${left} 天后到期` };
    if (left <= 30) return { key: 'soon', level: 2, label: `会籍 ${left} 天后到期` };
  }

  const pending = cards.find((c) => c.status === 'pending');
  if (pending) return { key: 'pending', level: 2, label: `${pending.name} 未开卡`, cardId: pending.id };

  if (cnt && cnt.remainCount <= 6) {
    return { key: 'count-near', level: 3, label: `剩 ${cnt.remainCount}${CARD_TYPES[cnt.typeId]?.unit || '次'}`, cardId: cnt.id };
  }
  return null;
}

/**
 * 未到店天数徽标。
 * 7 天以下不显示 —— 每个人身上都挂一个就等于没有。
 * 阈值和 store.churnBuckets 的 7 / 21 两档保持一致，
 * 列表里的徽标和筛选出来的名单必须是同一把尺子。
 */
export function silentBadge(m) {
  if (!m?.lastVisit) return '';
  const days = -daysBetween(today(), m.lastVisit);
  if (days < 0 || days < 7) return '';
  return `<span class="badge ${days >= 21 ? 'b-danger' : 'b-warn'}">${days} 天未到店</span>`;
}

/** 到期徽标的 HTML。level 1 红、2 橙、3 灰。 */
export function dueBadge(m) {
  const d = dueWatch(m);
  if (!d) return '';
  const cls = d.level === 1 ? 'b-danger' : d.level === 2 ? 'b-warn' : 'b-plain';
  return `<span class="badge ${cls}">${esc(d.label)}</span>`;
}

/* ============================================================
   三、本地话术生成
   ============================================================ */

/**
 * 备注信号词。
 * 备注是我方视角的流水记录，直接抄进消息会很生硬，
 * 所以只做关键词触发：命中哪个信号，就用对应的那一句话去承接。
 */
export const NOTE_SIGNALS = [
  { id: 'injury', re: /(膝|腰|肩|颈|踝|肘|腕|伤|痛|拉伤|劳损|康复|体态)/, label: '有伤或体态问题', line: '强度按你身体能接受的来，不硬上' },
  { id: 'time', re: /(加班|忙|没时间|时间紧|晚班|早班|排不开|出差)/, label: '时间不好凑', line: '时间不用凑整，来 40 分钟也算数' },
  { id: 'budget', re: /(贵|预算|价格|优惠|划算|便宜|钱)/, label: '在意价格', line: '先不聊方案，把你手上这张用到位再说' },
  { id: 'family', re: /(孩子|娃|接送|家里|老人)/, label: '有家庭要顾', line: '按你接送完的空档来排，不用迁就我' },
  { id: 'dist', re: /(远|路上|通勤|堵|地铁|停车)/, label: '路上花时间', line: '挑不堵的时段来，路上能省二十分钟' },
  { id: 'goal', re: /(减|瘦|增肌|塑形|体测|体重|力量|围度|马甲线)/, label: '有明确目标', line: '该复盘一次了，数据比感觉准' },
  { id: 'sleep', re: /(睡|熬夜|累|疲|精神)/, label: '作息有问题', line: '先把来的次数稳住，其他慢慢调' },
];

/** 从备注里认出命中的信号 */
export function noteSignals(note) {
  const text = String(note || '');
  if (!text) return [];
  return NOTE_SIGNALS.filter((s) => s.re.test(text));
}

/**
 * 话术库。每条是一个可遍历的数据项：
 *   when  什么时候用它
 *   build 生成正文
 * 称呼统一走 m.name + 门店 + 顾问，正文里不出现"亲爱的会员"这类群发腔。
 */
export const SCRIPTS = [
  {
    id: 'first',
    label: '新客首次触达',
    when: '还没消费或只在体验阶段',
    build: (m, c) => {
      const need = (m.intents || [])[0] || (m.goals || [])[0] || '你上次提到的需求';
      return `${m.name}，我是${c.store}的${c.advisor}。\n`
        + `你上次问的「${need}」，我这边理了一份适合刚开始练的安排。\n`
        + `不用先谈卡，你过来练一次，练完你自己判断值不值。\n`
        + `这周哪天方便？`;
    },
  },
  {
    id: 'activate',
    label: '催开卡（已售未激活）',
    when: '卡已售出但还没激活',
    build: (m, c) => {
      const cards = cardsOfMember(m.id);
      const p = cards.find((x) => x.status === 'pending');
      const nm = p?.name || '你上次办的卡';
      return `${m.name}，我是${c.store}的${c.advisor}。\n`
        + `「${nm}」还没开卡，它在你手上放着，时间是不走的。\n`
        + `第一次不用你自己摸索，我带你走一遍流程，三十分钟就够。\n`
        + `这周什么时候方便？我提前把器械留出来。`;
    },
  },
  {
    id: 'pt',
    label: '课时将尽（谈续课包）',
    when: '课时或次数剩 3 以内',
    build: (m, c, x) => {
      const cards = cardsOfMember(m.id);
      const cnt = cards
        .filter((cc) => ['pt', 'group', 'count'].includes(cc.typeId) && cc.remainCount != null)
        .sort((a, b) => a.remainCount - b.remainCount)[0];
      const unit = CARD_TYPES[cnt?.typeId]?.unit || '次';
      return `${m.name}，我是${c.store}的${c.advisor}。\n`
        + `你「${cnt?.name || '课时'}」还剩 ${cnt?.remainCount ?? 0}${unit}${x.pace}。\n`
        + `我不是现在就让你续，是想提前把后面的训练计划对一下，别练到断档。\n`
        + `${x.noteLine}你这周训练完留五分钟？`;
    },
  },
  {
    id: 'renew7',
    label: '7 天内到期',
    when: '会籍 7 天内到期',
    build: (m, c, x) => {
      const left = daysBetween(today(), m.expireDate);
      return `${m.name}，我是${c.store}的${c.advisor}。\n`
        + `${x.motionLine}\n`
        + `你那张${m.cardType || '卡'}还剩 ${left} 天，这个阶段我在店里基本都在。\n`
        + `这周你来的那次，花两分钟把后面的安排定一下就行。\n`
        + `${x.noteLine}你一般哪天来？`;
    },
  },
  {
    id: 'renew30',
    label: '30 天内到期（提前铺）',
    when: '会籍 30 天内到期',
    build: (m, c, x) => {
      const left = daysBetween(today(), m.expireDate);
      return `${m.name}，我是${c.store}的${c.advisor}。\n`
        + `${x.motionLine}\n`
        + `距离到期还有 ${left} 天，现在还没到要决定的时候，我只是想先跟你对一下下半年的节奏。\n`
        + `${x.noteLine}你这周来的时候我们聊十分钟？`;
    },
  },
  {
    id: 'recover',
    label: '已过期（回流）',
    when: '会籍已经过期',
    build: (m, c, x) => {
      const over = -daysBetween(today(), m.expireDate);
      return `${m.name}，我是${c.store}的${c.advisor}。\n`
        + `你那张卡到期 ${over} 天了，我一直没催你。\n`
        + `就想问一句真实的：是时间排不开，还是练着没找到感觉？\n`
        + `${x.noteLine}你说一句我就知道该怎么帮你，不用回长。`;
    },
  },
  {
    id: 'wake30',
    label: '30 天以上没来',
    when: '沉默超过 30 天，微信已经低效',
    build: (m, c, x) => {
      const days = x.mo.silentDays;
      return `${m.name}，我是${c.store}的${c.advisor}。\n`
        + `翻记录看到你上次来是 ${days} 天前了。\n`
        + `我不催你练，就是想确认下你还练不练，别让卡白放着。\n`
        + `${x.noteLine}方便的时候回我一句就行。`;
    },
  },
  {
    id: 'care14',
    label: '14 天没来（习惯断裂点）',
    when: '沉默 14 到 30 天',
    build: (m, c, x) => {
      const days = x.mo.silentDays;
      return `${m.name}，我是${c.store}的${c.advisor}。\n`
        + `看你最近 ${days} 天没过来了。\n`
        + `这个阶段最容易断，不用一次补回来，先来一次把节奏接上就好。\n`
        + `${x.noteLine}这周哪天你有空？我按你的时间来。`;
    },
  },
  {
    id: 'referral',
    label: '稳定会员（请转介绍）',
    when: '运动综合在高频稳定档',
    build: (m, c, x) => `${m.name}，我是${c.store}的${c.advisor}。\n`
      + `你这一个月来了 ${x.mo.freq} 次，这个稳定性在门店能排前面。\n`
      + `有件小事想请你帮个忙：身边有想开始练的朋友，把我的微信推给他就行，第一次体验我来安排。\n`
      + `你自己后面的训练计划我也顺手帮你调一版。`,
  },
];

export const SCRIPT_BY_ID = SCRIPTS.reduce((a, s) => ({ ...a, [s.id]: s }), {});

/** 按会员当前状态挑一条最合适的 */
export function pickScript(m, ctx) {
  const c = cardsOfMember(m.id);
  const e = m.expireDate ? { left: daysBetween(today(), m.expireDate) } : null;
  const mo = motionOf(m);
  const silent = mo.silentDays;

  if (!m.totalPaid || m.stage === 'lead' || m.stage === 'trial') return 'first';
  if (c.some((x) => x.status === 'pending')) return 'activate';
  const cnt = c
    .filter((x) => ['pt', 'group', 'count'].includes(x.typeId) && x.remainCount != null)
    .sort((a, b) => a.remainCount - b.remainCount)[0];
  if (cnt && cnt.remainCount <= 3) return 'pt';
  if (e && e.left < 0) return 'recover';
  if (e && e.left <= 7) return 'renew7';
  if (e && e.left <= 30) return 'renew30';
  if (silent != null && silent >= 30) return 'wake30';
  if (silent != null && silent >= 14) return 'care14';
  if (mo.tier.id === 'high' || mo.tier.id === 'regular') return 'referral';
  return 'care14';
}

/** 换一版：在候选顺序里往后挪，保证每次都给出不一样的东西 */
export function scriptOrder(m, ctx) {
  const base = pickScript(m, ctx);
  const rest = ['care14', 'referral', 'wake30', 'renew30'];
  return [base, ...rest.filter((x) => x !== base)];
}

/**
 * 生成一条可以直接发出去的正文。
 * @param {object} m 会员
 * @param {object} ctx
 * @param {string} scriptId
 */
export function draftMessage(m, ctx, scriptId) {
  const s = ctx.state.settings || {};
  const mo = motionOf(m);
  const signals = noteSignals(m.note);
  const script = SCRIPT_BY_ID[scriptId] || SCRIPT_BY_ID[pickScript(m, ctx)];

  const pace = mo.freq >= 8 ? `，按你现在一周 ${mo.perWeek} 次的节奏，两周就完了` : '';
  const noteLine = signals.length ? `你之前提过的「${signals[0].label}」我记着，${signals[0].line}。\n` : '';
  const motionLine = mo.known
    ? `看你近 30 天来了 ${mo.freq} 次${mo.tier.id === 'high' || mo.tier.id === 'regular' ? '，节奏保持得不错' : ''}。`
    : '';

  const body = script.build(m, {
    store: s.store || '店里',
    advisor: s.advisor || '',
  }, { mo, pace, noteLine, motionLine, signals });

  /* 末尾签名只在正文里没出现顾问名字的时候补，避免重复两遍 */
  const sig = s.advisor && !body.includes(s.advisor) ? `\n\n${s.advisor}｜${s.store || ''}` : '';

  return {
    scriptId: script.id,
    label: script.label,
    text: body + sig,
    basis: [
      mo.known ? `近 30 天到店 ${mo.freq} 次（${mo.tier.label}）` : '没有到店数据',
      ...signals.map((x) => `备注提到「${x.label}」`),
      m.expireDate ? `会籍 ${fmtDate(m.expireDate, 'ymd')} 到期` : null,
    ].filter(Boolean),
  };
}

/* ============================================================
   四、云端润色（可选）
   ============================================================ */

/** 配没配云端模型。界面上据此决定按钮是能点还是给出提示。 */
export function cloudReady(ctx) {
  const ai = ctx.state.settings?.ai;
  return Boolean(ai?.endpoint && ai?.apiKey);
}

/**
 * 调用云端模型润色话术。
 * 约定走 OpenAI 兼容的 /chat/completions 形状，用户自己填 endpoint 和 key。
 * 没配、超时、报错一律返回 ok:false，让界面退回本地稿，绝不静默替换。
 */
/* ============================================================
   数据交换端口脱敏（唯一出口）
   ------------------------------------------------------------
   架构约定：脱敏只发生在「FitFlow → 外部模型」这个数据交换端口，
   即真正 fetch 外发前一刻。用户界面与提示词预览始终保持真实数据。

   redactPII(text, members)：
   - 用 members 列表里每个会员的姓名做替换（姓名 → 「该会员」，按长度降序避免漏替换）；
   - 手机号打码（保留前 3 后 4，中间 ****）。
   脱敏定位是「去标识化」：只隐去能直接指向特定自然人的直接标识符（姓名、手机号），
   年龄、性别、卡种、到店轨迹、身体反馈、训练目标、顾虑、消费等业务属性予以保留，
   供模型结合行动轨迹 / 卡种使用 / 身体反馈给出情感连接与业务跟进。
   返回脱敏后的纯文本，供 fetch body 使用。
   ============================================================ */
export function redactPII(text, members = []) {
  if (!text) return text;
  let t = text;
  const list = Array.isArray(members) ? members : (members ? [members] : []);
  /* 姓名按长度降序替换：必须先把更长的姓名换掉，
     否则「林嘉」会先于「林嘉怡」命中，把「林嘉怡」替换成「该会员怡」残留一个「怡」字泄露。
     所以先对名单做一次稳定降序排序再逐个替换。 */
  const byNameDesc = [...list]
    .filter((m) => m && m.name)
    .sort((a, b) => (b.name.length - a.name.length) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  for (const m of byNameDesc) {
    t = t.split(m.name).join('该会员');
  }
  for (const m of list) {
    const digits = String(m?.phone || '').replace(/[^0-9]/g, '');
    if (digits.length >= 7) t = t.split(digits).join(digits.slice(0, 3) + '****' + digits.slice(-4));
  }
  return t;
}

/* 兼容旧调用：单会员脱敏 = redactPII 的单参数形式 */
export function redactMemberFromText(text, member) {
  return redactPII(text, member ? [member] : []);
}

export async function polishOnline(text, ctx, member) {
  /* 统一走「AI 接口」总开关的激活模型与密钥，不在触达台单独登记 */
  const { model, key, endpoint } = activeModelConfig(ctx);
  const base = (endpoint || model.endpoint || '').replace(/\/+$/, '');
  if (!base) return { ok: false, reason: 'unconfigured', message: '未配置调用地址，请到「AI 接口」总开关设置' };
  if (!key) return { ok: false, reason: 'unconfigured', message: '未配置 API Key，请到「AI 接口」总开关设置' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: model.apiModel,
        temperature: 0.6,
        messages: [
          {
            role: 'system',
            content: '你是健身房的会籍顾问。把给定的话术改得更像本人随口发的微信：'
              + '去掉书面语和群发腔，保留全部事实数字，不加任何原文没有的承诺、报价和效果保证。'
              + '不加表情。只输出改后的正文，不要解释。',
          },
          { role: 'user', content: redactPII(text, member) },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: 'http', message: `接口返回 ${res.status}` };
    const data = await res.json();
    const out = data?.choices?.[0]?.message?.content;
    if (!out || !out.trim()) return { ok: false, reason: 'empty' };
    return { ok: true, text: out.trim() };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'network', message: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
   五、补结果
   ============================================================ */

/**
 * 触达结果的选项。
 * 每一项都对应"这次到底发生了什么"的一个真实答案，
 * 不给「已联系」这种模糊选项 —— 那正是要避免的假数据。
 */
export const REACH_OUTCOMES = [
  { id: 'talked_win', result: 'positive', outcome: 'talked', label: '接通了，有推进' },
  { id: 'talked_flat', result: 'neutral', outcome: 'talked', label: '接通了，没定' },
  { id: 'missed', result: 'no_reply', outcome: 'missed', label: '没接 / 挂断' },
  { id: 'rejected', result: 'negative', outcome: 'rejected', label: '明确拒绝' },
];

/**
 * 给一条待补的触达记录补上结果。
 *
 * 只做一件事：把"发起过联系"升级成"这次到底怎么样"。
 * 原始 summary（几点拨的、拨的哪个号）保留不动 —— 那是当时确凿发生的事，
 * 不该被后来的判断覆盖掉。
 */
export function openReachResultSheet(ctx, followupId, onSaved) {
  const f = (ctx.state.followups || []).find((x) => x.id === followupId);
  if (!f) return toast('找不到那条记录', 'warn');
  const m = memberById(f.memberId);
  let picked = null;

  openSheet({
    title: '补这次的结果',
    subtitle: `${esc(m?.name || '')} · ${esc(f.date)} ${esc(reachTime(f))} · ${f.reach?.channel === 'phone' ? '电话' : '微信'}`,
    body: `
      ${notice('这条记录现在只写着「发起过一次联系」。补上真实结果，下次跟进才知道该从哪儿接。', 'info', 'i-phone')}
      <div class="field">
        <label>这通电话的结果</label>
        <div class="chips" data-rs="outcome">
          ${REACH_OUTCOMES.map((o) => `<button class="chip" data-val="${o.id}">${esc(o.label)}</button>`).join('')}
        </div>
        <div class="hint" id="rsHint">先选一个，下面的空随意填。</div>
      </div>
      ${textareaField({ label: '他说了什么（尽量原话）', name: 'feedback', rows: 3, placeholder: '例：说考虑一下，月底发工资再说' })}
      ${textareaField({ label: '下一步要做的具体动作', name: 'nextAction', rows: 2, placeholder: '例：月底前发两档方案，不要问「要不要续」' })}
      ${field({ label: '下次跟进日期', name: 'nextDate', value: d(3), type: 'date', hint: '不填就不会进今日队列' })}
    `,
    footer: `<button class="btn ghost" data-sheet-close>先不补</button><button class="btn primary" data-save>保存结果</button>`,
    onMount(el, close) {
      const chips = el.querySelectorAll('[data-rs="outcome"] .chip');
      chips.forEach((c) => c.addEventListener('click', () => {
        chips.forEach((x) => x.classList.toggle('on', x === c));
        picked = REACH_OUTCOMES.find((o) => o.id === c.dataset.val) || null;
        el.querySelector('#rsHint').textContent = picked ? '已选：' + picked.label : '先选一个，下面的空随意填。';
      }));

      el.querySelector('[data-save]').onclick = () => {
        if (!picked) return toast('先选一个结果', 'warn');
        const box = el.querySelector('.sheet-bd');
        const v = {};
        box.querySelectorAll('[name]').forEach((n) => { v[n.name] = n.value.trim(); });
        updateFollowup(f.id, {
          result: picked.result,
          feedback: v.feedback || '',
          nextAction: v.nextAction || '',
          nextDate: v.nextDate || null,
          reach: { ...(f.reach || {}), outcome: picked.outcome, filledAt: new Date().toISOString() },
        });
        toast('已补：' + picked.label);
        close();
        onSaved && onSaved();
        ctx.refresh();
      };
    },
  });
}

/* ============================================================
   六、客户触达台
   ============================================================ */

/** 手机号洗成 tel: 能用的形状，顺手挡掉明显不是号码的内容 */
export function telHref(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  return digits.length >= 6 ? `tel:${digits}` : null;
}

/**
 * 唤起微信。
 * 没有官方 Scheme 能预填文字，所以这里只负责"把微信拉起来"，
 * 文字已经提前复制好了。唤不起就返回 false，让界面如实提示。
 */
function openWechat() {
  try {
    const before = Date.now();
    location.href = 'weixin://';
    /* 页面没被切走就说明没唤起成功。这个判断不完美，但比假装成功好。 */
    return new Promise((resolve) => {
      setTimeout(() => resolve(document.visibilityState === 'hidden' || Date.now() - before > 1200), 900);
    });
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * 触达台。点「去处理」落在这里。
 * 一屏之内把"说什么是、怎么发出去"做完，不用来回跳。
 */
export function openContactSheet(ctx, memberId, opts = {}) {
  const m0 = memberById(memberId);
  if (!m0) return toast('找不到这位会员', 'warn');
  /* 抽屉活着的时候会员档案可能被别处改过（备注、跟进），
     每次生成话术前重新取一次，不要用打开那一刻的快照。 */
  const fresh = () => memberById(memberId) || m0;
  const m = fresh();

  const mo = motionOf(m);
  const due = dueWatch(m);
  const signals = noteSignals(m.note);
  const order = scriptOrder(m, ctx);
  /* 上次拨出去还没补结果的，开抽屉就先摆出来。
     隔了几小时再回来，人已经忘了自己打过这一通。 */
  const pending = pendingReachOf(m.id);
  let idx = Math.max(0, order.indexOf(opts.scriptId || pickScript(m, ctx)));
  let draft = draftMessage(m, ctx, order[idx]);
  let edited = false;

  openSheet({
    title: '客户触达台',
    subtitle: `${esc(m.name)}｜${esc(mo.tier.label)}｜${esc(mo.monthAvg)}`,
    size: 'tall',
    body: `
      ${pending.length ? `
        <div class="card tight" style="margin-bottom:11px;border-color:var(--warn-tint);background:var(--warn-tint)">
          <div class="between">
            <div class="small" style="font-weight:700;color:var(--warn)">上一次联系还没补结果</div>
            <span class="src warn">${esc(pending[0].date)} ${esc(reachTime(pending[0]))}</span>
          </div>
          <div class="small" style="margin-top:5px;line-height:1.6;color:var(--warn)">
            ${esc(pending[0].summary)}。补一句结果，下次跟进才有依据；不补的话，这条会一直挂着算「未闭环」。
          </div>
          <div class="btn-row" style="margin-top:9px">
            <button class="btn ghost sm" data-ct="fill-result" data-fid="${esc(pending[0].id)}">补这次的结果</button>
          </div>
        </div>` : ''}

      <!-- 会员摘要：决定要不要打这通电话的依据全在这一条里 -->
      <div class="card tight" style="border-color:var(--brand-tint-2);background:var(--brand-tint)">
        <div class="between">
          <div style="min-width:0">
            <div class="li-top">
              <span class="li-name" style="color:var(--brand-2)">${esc(m.name)}</span>
              ${due ? `<span class="badge ${due.level === 1 ? 'b-danger' : due.level === 2 ? 'b-warn' : 'b-plain'}">${esc(due.label)}</span>` : ''}
            </div>
            <div class="li-meta" style="color:var(--brand-2)">
              <span class="mono">${esc(m.phone || '没留手机号')}</span>
              <span>${esc(m.cardType || '未办卡')}</span>
            </div>
          </div>
        </div>
        <div class="divider" style="margin:9px 0"></div>
        <div class="tag-row">
          <span class="badge ${mo.tier.cls}">运动综合 · ${esc(mo.tier.label)}</span>
          <span class="src">${esc(mo.monthAvg)}</span>
          ${mo.silentDays != null ? `<span class="src">${mo.silentDays <= 0 ? '今天到店' : mo.silentDays === 1 ? '昨天到店' : `最近 ${mo.silentDays} 天前到店`}</span>` : ''}
          ${mo.flags.map((f) => `<span class="src warn">${esc(f)}</span>`).join('')}
        </div>
        <div class="small" style="margin-top:7px;line-height:1.6;color:var(--brand-2)">${esc(mo.tier.note)}</div>
      </div>

      <!-- 话术 -->
      <div class="section-title">要发的消息<span class="count" id="ctLabel">${esc(draft.label)}</span></div>
      <textarea class="textarea" id="ctText" rows="9" style="font-size:16px;line-height:1.72">${esc(draft.text)}</textarea>
      <div class="tag-row" style="margin-top:8px" id="ctBasis">
        ${draft.basis.map((b) => `<span class="src">${esc(b)}</span>`).join('')}
      </div>
      <div class="hint" style="margin-top:8px">
        这条是本地按规则拼的，改一改再发。内容只用了上面这几个事实，没添别的东西。
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost sm" data-ct="reroll">换一版</button>
        <button class="btn ghost sm" data-ct="copy">复制</button>
        <button class="btn ghost sm" data-ct="polish">${cloudReady(ctx) ? '云端润色（脱敏）' : '云端润色（未配置）'}</button>
        <button class="btn ghost sm" data-ct="reset">还原</button>
      </div>

      <!-- 备注：直接改，不用回会员详情页 -->
      <div class="section-title">我的备注<span class="count">自动保存</span></div>
      <textarea class="textarea" id="ctNote" rows="3" placeholder="记一句你会记得的事，比如「膝盖有旧伤，别安排深蹲」"
        style="font-size:16px">${esc(m.note || '')}</textarea>
      <div class="tag-row" id="ctSig" style="margin-top:7px">${signals.map((s) => `<span class="src qn">识别到「${esc(s.label)}」</span>`).join('')}</div>

      <!-- 其余出口 -->
      <div class="btn-row" style="margin-top:14px">
        <button class="btn ghost sm" data-ct="follow">记一条跟进</button>
        <button class="btn ghost sm" data-ct="profile">看完整档案</button>
      </div>
    `,
    footer: `
      <div class="ct-actions">
        ${telHref(m.phone)
          ? `<button class="btn primary" data-ct="tel" data-tel="${esc(telHref(m.phone))}"><svg viewBox="0 0 24 24"><use href="#i-phone"/></svg>拨打 ${esc(m.phone)}</button>`
          : `<button class="btn" disabled title="这位会员没留手机号">没有手机号</button>`}
        <button class="btn ghost" data-ct="wechat"><svg viewBox="0 0 24 24"><use href="#i-chat"/></svg>复制并开微信</button>
      </div>`,
    onMount(el, close) {
      const ta = el.querySelector('#ctText');
      const noteTa = el.querySelector('#ctNote');

      const refreshBasis = () => {
        el.querySelector('#ctLabel').textContent = draft.label;
        el.querySelector('#ctBasis').innerHTML = draft.basis.map((b) => `<span class="src">${esc(b)}</span>`).join('');
      };

      ta.addEventListener('input', () => { edited = true; draft.text = ta.value; });

      /* 备注防抖存盘。三个细节都不能做反：
           1. 静默写入。打字途中重渲染会把光标弹回开头，安卓上还会把软键盘收掉。
           2. 写完立刻重算信号。用户刚写下"膝盖有旧伤"，得当场看到被认出来，
              否则他会怀疑这东西到底有没有用。
           3. 换一版时用最新档案，否则刚写的备注不会进新话术。 */
      let noteTimer;
      const sigBox = el.querySelector('#ctSig');
      noteTa.addEventListener('input', () => {
        clearTimeout(noteTimer);
        noteTimer = setTimeout(() => {
          ctx.setMemberNote(m.id, noteTa.value.trim(), { silent: true });
          if (sigBox) {
            sigBox.innerHTML = noteSignals(noteTa.value)
              .map((s) => `<span class="src qn">识别到「${esc(s.label)}」</span>`).join('');
          }
        }, 600);
      });

      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-ct]');
        if (!b) return;
        const a = b.dataset.ct;

        if (a === 'reroll') {
          if (ta.value.trim() !== draft.text.trim() && edited
            && !confirm('当前这段是你改过的，换一版会覆盖掉。继续吗？')) return;
          idx = (idx + 1) % order.length;
          draft = draftMessage(fresh(), ctx, order[idx]);
          ta.value = draft.text;
          edited = false;
          refreshBasis();
          toast('换了一版，' + draft.label);
          return;
        }

        if (a === 'reset') {
          draft = draftMessage(fresh(), ctx, order[idx]);
          ta.value = draft.text;
          edited = false;
          refreshBasis();
          toast('已还原成规则生成的版本');
          return;
        }

        if (a === 'copy') {
          const ok = await copyText(ta.value);
          toast(ok ? '已复制，去微信粘贴就行' : '复制失败，长按上面的文字手动选', ok ? 'ok' : 'warn');
          return;
        }

        if (a === 'polish') {
          if (!cloudReady(ctx)) {
            toast('还没配云端模型。到设置里填接口和密钥后，这里就能润色', 'warn');
            return;
          }
          /* 云端润色会把话术（可能含会员姓名、课程 / 健康信息）发往配置的模型接口，须单独同意 */
          const ai = ctx.state.settings?.ai || {};
          const ok = await ensureConsent('cloudPolish', {
            title: '确认云端润色（外发话术）',
            danger: true,
            body: `
              <p>你即将把这段触达话术发送到你配置的模型接口（<b>${esc(ai.endpoint || '未填写')}</b>）进行润色。</p>
              <p>发送前已自动隐去会员<strong>姓名与手机号</strong>，仅保留话术内容本身。请确认已就该会员取得单独同意，并理解数据将发往该第三方模型处理。</p>
              <p class="muted">若接口位于境外或厂商可能将内容用于训练，请确认你已接受相应风险与合规要求。</p>
            `,
          });
          /* 原标签可能是「云端润色（脱敏）」或「云端润色（未配置）」，收尾一律还原成原样，
             不能用固定字符串覆盖，否则取消一次就丢了后缀。 */
          const origLabel = b.textContent;
          if (!ok) { return; }
          b.disabled = true; b.classList.add('is-loading'); b.textContent = '润色中';
          const r = await polishOnline(ta.value, ctx, m);
          b.disabled = false; b.classList.remove('is-loading'); b.textContent = origLabel;
          if (!r.ok) {
            toast(r.reason === 'timeout' ? '云端超时，先用手上这版' : '云端没成功，先用手上这版', 'warn');
            return;
          }
          ta.value = r.text;
          draft.text = r.text;
          edited = true;
          /* 工作量：用 AI 生成 / 润色一次话术 = 一次观察量 */
          bumpWorkload('obs');
          toast('润色完了（已脱敏发送），记得自己再看一遍再发');
          return;
        }

        if (a === 'wechat') {
          /* 顺序不能反：先复制再唤起，因为跳走后当前页面就拿不到剪贴板权限了 */
          const ok = await copyText(ta.value);
          if (!ok) {
            toast('复制失败，先长按选中文字复制，再打开微信', 'warn');
            return;
          }
          /* 工作量：复制话术并跳转微信 = 一次操作量 */
          bumpWorkload('ops');
          const jumped = await openWechat();
          toast(jumped ? '已复制，去微信里粘贴发送' : '已复制。微信没自动打开，自己切过去粘贴就行');
          return;
        }

        if (a === 'tel') {
          /* 顺序不能反：先落记录，再交给系统电话。
             跳走之后这个页面收不到任何回调，
             现在能确定的只有"此刻对这个号码发起过一次联系"这一件事。
             结果留空，等打完回来补。 */
          const rec = logReach(m.id, { channel: 'phone', phone: m.phone, note: ta.value });
          toast('已记「拨出 · 结果待补」，打完回来补一句');
          location.href = b.dataset.tel;
          ctx.refresh();
          return;
        }

        if (a === 'fill-result') { openReachResultSheet(ctx, b.dataset.fid, () => ctx.refresh()); return; }
        if (a === 'follow') { close(); ctx.openFollowupForm(m.id, () => ctx.refresh()); return; }
        if (a === 'profile') { close(); ctx.openMember(m.id); return; }
      });
    },
  });
}
