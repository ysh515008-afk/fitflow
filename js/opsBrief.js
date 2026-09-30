/* ============================================================
   opsBrief.js · 当日线上运营简报
   ------------------------------------------------------------
   它回答两个问题，一条一句话：
     1. 今天线上运营发生了什么（总结）
     2. 有哪一件现在就该动（建议）

   三条设计约束，每一条都是为了让它别变成噪音：

   · **id 必须稳定。** 简报每天重算，但已读状态是按 id 记的。
     如果 id 每次生成都变，已读就会失效，同一条消息会反复跳出来。
     所以 id 用的是"类型 + 数据来源"这种确定性拼法，不含时间戳和随机数。

   · **拿不到数据就说不知道，不编。**
     没有快照、没有导入经营报表的时候，对应那条直接不出现，
     而不是写"今日曝光 0"。0 和"没有"是两件事。

   · **建议要有依据和动作。** 只说"开口率偏低"没有用，
     要写清是拿哪两个数比出来的，以及下一步动什么。
     借用了 douyin.js 的建议引擎，不另起一套判断口径。
   ============================================================ */
import { today, daysBetween, sum } from './util.js';
import { buildAdvice, diffMetrics, fmtCount } from './douyin.js';
import { BIZ_METRIC_FIELDS, sumBizRecords, metricDayCount, bizFunnel } from './bizMetrics.js';
import { isFeatureOn } from './features.js';

const isNum = (v) => typeof v === 'number' && isFinite(v);
const pct = (v) => (isNum(v) ? (v * 100).toFixed(1) + '%' : '未获取');

/** 建议类的阈值集中在这里，方便按实际数据回调 */
export const BRIEF_THRESHOLDS = {
  /** 线索进入后超过多少分钟没首响，就该出现在提醒里 */
  leadSlowMin: 30,
  /** 一条内容发布满多少小时还没带来线索，才提醒（刚发出去就催是噪音） */
  contentQuietHours: 6,
  /** 门店热度手工登记超过多少天提醒重记一次。
      当前未启用：门店热度区已不显示需要手工登记的类目，那条提醒随之停用，
      阈值先留着，等类目恢复显示时直接复用。 */
  storeHeatStaleDays: 30,
  /** 曝光足够大而开口为 0，才算异常（曝光太小的时候 0 开口很正常） */
  openZeroMinImpression: 500,
};

/**
 * 生成当日简报。
 * 返回 { date, generatedAt, items }，items 里每条的 id 在同一天内是稳定的。
 */
export function buildBrief(state) {
  const t = today();
  const items = [];
  const P = BRIEF_THRESHOLDS;

  /* 可选配模块收起之后，就不该再播报它的数据。
     否则会出现"导航里找不到这一栏，提醒里却在报它的数"，
     点进去还落不到地方。这里把数据源直接滤空，
     下面的判断块一行都不用改。 */
  const on = (id) => isFeatureOn(state.features, id);

  /* ---------------- 1. 内容台账：今天发了什么 ---------------- */
  const todayPosts = on('ops.ledger')
    ? (state.campaigns || []).filter((c) => c.publishedAt === t)
    : [];
  if (todayPosts.length) {
    const views = sum(todayPosts, (c) => c.views);
    const leads = sum(todayPosts, (c) => c.dmLeads + c.formLeads);
    const best = [...todayPosts].sort((a, b) => (b.dmLeads + b.formLeads) - (a.dmLeads + a.formLeads))[0];
    items.push({
      id: 'summary:content',
      kind: 'summary',
      level: leads > 0 ? 'good' : 'info',
      text: `今天发了 ${todayPosts.length} 条内容，合计播放 ${fmtCount(views)}，带来 ${leads} 条线索。`,
      detail: leads > 0
        ? `线索主要来自「${best.title}」（${best.dmLeads + best.formLeads} 条）。把这条的选题记下来，它比平均表现好，值得做成系列。`
        : '有播放没线索，通常是结尾没给下一步动作。内容里明确一句"想体验的私信我"，比让用户自己找入口有效。',
      source: '内容台账',
      action: leads > 0 ? '看这条内容' : '给今天的内容补一个引导动作',
    });
  }

  /* ---------------- 2. 抖音账号：最近一次同步的状态 ---------------- */
  const snap = state.douyin?.snapshot;
  const metrics = snap?.metrics;
  if (metrics) {
    const fans = isNum(metrics.followerCount) ? `粉丝 ${fmtCount(metrics.followerCount)}` : '粉丝未获取';
    const posts = isNum(metrics.weeklyPosts) ? `周更约 ${metrics.weeklyPosts} 条` : '更新频率算不出';
    const eng = isNum(metrics.engRate) ? `互动率 ${pct(metrics.engRate)}` : '互动率算不出';
    const stale = snap.at ? Math.abs(daysBetween(t, String(snap.at).slice(0, 10)) || 0) : null;
    items.push({
      id: 'summary:douyin',
      kind: 'summary',
      level: 'info',
      text: `抖音账号最近一次同步（${snap.at || '时间未知'}）：${fans}，${posts}，${eng}。`,
      detail: stale != null && stale >= 3
        ? `已经 ${stale} 天没同步过了，下面的环比是基于 ${state.douyin?.prevMetrics ? '上一次' : '没有'}对比算的。数据太旧时建议先同步一次再看判断。`
        : '这份数据来自上一次同步的快照。指标定义和口径在「抖音账号」那一栏里逐项写着。',
      source: '抖音账号',
      action: stale != null && stale >= 3 ? '去同步一次' : '看完整指标',
    });
  }

  /* ---------------- 3. 交易后台：今天导入的平台经营数字 ---------------- */
  /* 同一个 bizToday 在第 7 段也要用，所以开关收在这里，两段一起生效 */
  const bizToday = on('ops.biz')
    ? (state.biz?.records || []).filter((r) => r.date === t)
    : [];
  if (bizToday.length) {
    const s = sumBizRecords(bizToday);
    const srcNames = [...new Set(bizToday.map((r) => r.source))]
      .map((id) => (id === 'laike' ? '来客' : id === 'meituan' ? '经营宝' : id)).join(' + ');
    const parts = [];
    if (isNum(s.impression)) parts.push(`曝光 ${fmtCount(s.impression)}`);
    if (isNum(s.open)) parts.push(`开口 ${fmtCount(s.open)}`);
    if (isNum(s.order)) parts.push(`下单 ${fmtCount(s.order)}`);
    if (isNum(s.redeem)) parts.push(`核销 ${fmtCount(s.redeem)}`);
    items.push({
      id: 'summary:biz',
      kind: 'summary',
      level: 'info',
      text: `平台经营（${srcNames}）：${parts.length ? parts.join('，') : '导入的记录里没有可用指标'}。`,
      detail: '这些是后台报表导进来的数字，不是接口实时读的。口径换算在「交易后台」那一栏里逐环写着。',
      source: '交易后台',
      action: '看经营漏斗',
    });
  }

  /* ---------------- 4. 线索池：今天的进出 ---------------- */
  const todayLeads = (state.leads || []).filter((l) => l.createdAt === t);
  if (todayLeads.length) {
    const won = todayLeads.filter((l) => l.status === 'won').length;
    const noResp = todayLeads.filter((l) => l.firstResponseMin == null).length;
    items.push({
      id: 'summary:lead',
      kind: 'summary',
      level: noResp > 0 ? 'warn' : won > 0 ? 'good' : 'info',
      text: `今天进来 ${todayLeads.length} 条线索，已成交 ${won} 条，还有 ${noResp} 条没有首响记录。`,
      detail: noResp > 0
        ? '首响是线索质量之外最可控的一环。超过 30 分钟没回，转化率会明显下台阶，先把这几条处理掉再说别的。'
        : '今天的线索都碰过了，保持这个节奏。',
      source: '线索池',
      action: noResp > 0 ? '去处理未首响的线索' : '看线索详情',
    });
  }

  /* ---------------- 5. 抖音账号的优化建议（复用同一个引擎） ---------------- */
  const diff = (state.douyin?.prevMetrics && metrics)
    ? diffMetrics(metrics, state.douyin.prevMetrics)
    : {};
  const advice = buildAdvice(metrics, diff);
  advice.items.slice(0, 2).forEach((a) => {
    items.push({
      id: `advice:dy-${a.id}`,
      kind: 'advice',
      level: a.level === 'good' ? 'good' : a.level === 'warn' ? 'warn' : 'info',
      text: a.title,
      detail: `${a.detail} 下一步：${a.action}`,
      source: '抖音账号',
      action: '看这条建议的依据',
    });
  });

  /* ---------------- 6. 首响超时：线上线索最该立刻处理的一件事 ---------------- */
  const slow = (state.leads || []).filter((l) => l.status === 'new' || l.status === 'contacted');
  const overdue = slow.filter((l) => isNum(l.firstResponseMin)
    ? l.firstResponseMin > P.leadSlowMin
    : (daysBetween(l.createdAt, t) || 0) > 0);
  if (overdue.length) {
    items.push({
      id: 'advice:lead-slow',
      kind: 'advice',
      level: 'warn',
      text: `${overdue.length} 条线上线索还压着没处理，最久的来自 ${overdue[0].source}。`,
      detail: `判据：状态还是「未触达 / 已触达待推进」，且要么首响超过 ${P.leadSlowMin} 分钟，要么已经过了当天。`
        + `依次联系：${overdue.slice(0, 3).map((l) => l.name).join('、')}${overdue.length > 3 ? ' 等' : ''}。`,
      source: '线索池',
      action: '按顺序打过去',
    });
  }

  /* ---------------- 7. 交易后台：开口为 0 与核销落差 ---------------- */
  if (bizToday.length) {
    const agg = sumBizRecords(bizToday);
    const impDays = metricDayCount(bizToday, 'impression');
    const openDays = metricDayCount(bizToday, 'open');

    if (isNum(agg.impression) && isNum(agg.open) && agg.open === 0 && agg.impression >= P.openZeroMinImpression) {
      items.push({
        id: 'advice:biz-open-zero',
        kind: 'advice',
        level: 'warn',
        text: `曝光 ${fmtCount(agg.impression)} 但开口 0，断点在曝光→开口的承接环节（承接页 / 钩子 / 话术），不是流量不足。`,
        detail: '曝光已经足够大，没人开口说明进店之后没有让人问的动机。检查三处：团购挂载的价格有没有竞争力、'
          + '店铺页的第一张图是不是能一眼看懂卖什么、有没有留一个低门槛的咨询理由（比如"免费体测"）。',
        source: '交易后台',
        action: '去改店铺页与团购挂载',
      });
    } else if (isNum(agg.impression) && isNum(agg.open) && agg.open > 0) {
      const f = bizFunnel(agg);
      const openRate = f.find((x) => x.key === 'open')?.rate;
      if (isNum(openRate) && openRate < 0.01) {
        items.push({
          id: 'advice:biz-open-low',
          kind: 'advice',
          level: 'info',
          text: `曝光到开口只有 ${pct(openRate)}，低于 1%。`,
          detail: `按 ${impDays ? impDays + ' 天' : '导入的这几天'}合计算：曝光 ${fmtCount(agg.impression)}，访问 `
            + `${fmtCount(agg.visit)}，开口 ${fmtCount(agg.open)}。开口环节每提升 0.5 个百分点，`
            + '按现在的曝光量折算就是几十条意向咨询，比加投放便宜。',
          source: '交易后台',
          action: '看漏斗哪一环掉的',
        });
      }
    }

    if (isNum(agg.order) && isNum(agg.redeem) && orderIsMeaningful(agg)) {
      const gap = agg.order - agg.redeem;
      const gapRate = agg.order > 0 ? gap / agg.order : null;
      if (isNum(gapRate) && gapRate > 0.2) {
        items.push({
          id: 'advice:biz-redeem-gap',
          kind: 'advice',
          level: 'warn',
          text: `下单 ${fmtCount(agg.order)}、核销 ${fmtCount(agg.redeem)}，${fmtCount(gap)} 人买了没来。`,
          detail: `未核销占比 ${pct(gapRate)}，超过 20%。这批人已经在平台上付过钱，是最容易约到店的一群。`
            + '按订单日期把前 20 个拉出来，逐个发一条"这边给你留了时段"，比再投一轮拉新划算。',
          source: '交易后台',
          action: '导出未核销名单去约到店',
        });
      }
    }

    if (openDays === 0 && impDays > 0) {
      items.push({
        id: 'advice:biz-need-open',
        kind: 'advice',
        level: 'info',
        text: '导入的报表里没有「开口 / 咨询」这一列，漏斗算不到最值钱的那一环。',
        detail: '来客在「私信数据」里、经营宝在「互动数据」里，导出时把这一列带上。'
          + '没有它就只能看到曝光和下单，中间为什么断掉无从判断。',
        source: '交易后台',
        action: '重新导出带开口列的表',
      });
    }
  }

  /* ---------------- 8. 门店热度登记过期 ----------------
     停用：门店热度区已经不再显示需要手工登记的类目（见 js/views/ops.js 的
     storeHeatView）。再提醒"去重新登记"，指向的是一个界面上看不见的区域，
     属于自相矛盾。等那几项重新显示时，把这段连同 BRIEF_THRESHOLDS
     里的 storeHeatStaleDays 一起放回来即可。 */
  // const updatedAt = on('ops.store') ? state.douyin?.storeHeat?.updatedAt : null;
  // if (updatedAt) {
  //   const age = Math.abs(daysBetween(t, updatedAt) || 0);
  //   if (age >= P.storeHeatStaleDays) {
  //     items.push({
  //       id: 'advice:store-heat-stale',
  //       kind: 'advice',
  //       level: 'info',
  //       text: `门店热度的手工登记已经 ${age} 天没更新了。`,
  //       detail: '评论区顾虑和绿标白标这两项没有接口，只能手工记。隔太久再记，记的是印象不是事实。'
  //         + '抽 10 条评论重记一次，十分钟够了。',
  //       source: '门店热度',
  //       action: '重新登记一次',
  //     });
  //   }
  // }

  /* ---------------- 空态：什么都不编，说清为什么会空 ----------------
     清单按当前开着的模块现算。收起一个模块之后还把它列在"我会汇总这几样"里，
     就是在承诺一件它不会再做的事。 */
  if (!items.length) {
    const covers = [];
    if (on('ops.ledger')) covers.push('今天发的内容');
    covers.push('抖音账号最近一次同步的状态');
    if (on('ops.biz')) covers.push('交易后台导入的曝光与开口');
    covers.push('今天进来的线索处理情况');

    items.push({
      id: 'placeholder:empty',
      kind: 'summary',
      level: 'info',
      placeholder: true,
      text: '今天还没有可总结的线上数据。',
      detail: `这条提醒会自动汇总这几样：${covers.join('、')}，以及从这些数里能得出的动作建议。`
        + '任意一样有了数据，这里就会开始有内容。',
      source: '运营',
      action: on('ops.ledger') ? '先去绑定抖音账号或登记一条内容' : '先去绑定抖音账号',
    });
  }

  return { date: t, generatedAt: nowStamp(), items };
}

/** 环比在 douyin.js 里算，这里不做第二套口径 */
function nowStamp() {
  const x = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

/** 下单量太小时不判核销落差，几条订单的波动说明不了问题 */
function orderIsMeaningful(agg) {
  return isNum(agg.order) && agg.order >= 10;
}

/** 未读消息：有 id、没被标过已读、且不是占位说明 */
export function unreadOf(brief, readIds = []) {
  const read = new Set(readIds || []);
  return (brief?.items || []).filter((x) => !x.placeholder && !read.has(x.id));
}

/**
 * 今天已经读过哪些 id。
 * 跨天自动失效：昨天的已读不该继续压住今天的新提醒，
 * 否则换个日子进来会看到"提醒已读完"，而今天的事一件都没播报。
 */
export function readIdsOf(state) {
  return (state?.opsBrief?.date === today() ? state.opsBrief.readIds : []) || [];
}

/** 今天真正算数的提醒条数（不含占位说明），用于判断"全部读完" */
export function briefTotal(brief) {
  return (brief?.items || []).filter((x) => !x.placeholder).length;
}

export const LEVEL_META = {
  warn: { cls: 'b-warn', label: '要处理', color: 'var(--warn)' },
  info: { cls: 'b-info', label: '可优化', color: 'var(--info)' },
  good: { cls: 'b-green', label: '好信号', color: 'var(--brand)' },
};

/** 简报里引用的指标名，导出给视图做表头用 */
export { BIZ_METRIC_FIELDS };
