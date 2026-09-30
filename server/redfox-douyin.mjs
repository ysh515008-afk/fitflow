#!/usr/bin/env node
/* ============================================================
   server/redfox-douyin.mjs · 抖音账号维度取数 CLI（零依赖）
   ------------------------------------------------------------
   为什么有这个东西：
     「运营 → 线上营销」的界面暂时还没接内容源，但适配器已经写好了。
     这个脚本让适配器能立刻被真实调用、被真实验证，
     将来界面接上时，走的是同一份 buildRequest / parseList，不存在两套逻辑。

   它复用 js/integrations 里的适配器，不是另写一遍：
     · buildRequest 决定请求长什么样
     · parseList / normalize 决定字段怎么落到标准结构
     · 积分不足、端点未核对这类错误由适配器抛出，这里只负责翻译成人话

   用法：
     REDFOX_API_KEY=ak_xxx node server/redfox-douyin.mjs --account cdjjc028
     REDFOX_API_KEY=ak_xxx node server/redfox-douyin.mjs --account a,b --limit 20
     REDFOX_API_KEY=ak_xxx node server/redfox-douyin.mjs --probe
     REDFOX_API_KEY=ak_xxx node server/redfox-douyin.mjs --account xxx --json > out.json

   退出码：
     0 成功 ｜ 1 参数/环境问题 ｜ 2 鉴权失败 ｜ 3 积分不足 ｜ 4 上游错误
   ============================================================ */
import { meta as redfox } from '../js/integrations/redfox.js';
import { makeContentClient } from '../js/integrations/index.js';
import { ConnectorError } from '../js/integrations/contract.js';

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i > -1 ? argv[i + 1] : null;
};

const API_KEY = process.env.REDFOX_API_KEY || val('--api-key') || '';
const AS_JSON = has('--json');
const PROBE_ONLY = has('--probe');
const LIMIT = Number(val('--limit') || 0) || 50;
const accounts = (val('--account') || '').split(',').map((s) => s.trim()).filter(Boolean);

if (!API_KEY) {
  console.error('缺少 REDFOX_API_KEY。用法：REDFOX_API_KEY=ak_xxx node server/redfox-douyin.mjs --account <抖音号>');
  process.exit(1);
}
if (!PROBE_ONLY && !accounts.length) {
  console.error('请用 --account 指定抖音号（多个用逗号分隔）。中文昵称不唯一，官方接口不接受。');
  console.error('例：--account cdjjc028');
  process.exit(1);
}

/* ---------------- 直连传输层 ----------------
   Node 侧没有 CORS 限制，直接发给红狐，不必再起一个代理进程。
   浏览器侧走的是 server/proxy.mjs，两边共用同一个 buildRequest。 */
const transport = async (req) => {
  const url = redfox.baseUrl.replace(/\/$/, '') + req.path;
  let res;
  try {
    res = await fetch(url, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', [redfox.authSpec.headerName]: API_KEY },
      body: req.method === 'GET' ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(req.timeoutMs || 25000),
    });
  } catch (e) {
    const timeout = e.name === 'TimeoutError' || /timeout/i.test(e.message);
    throw new ConnectorError('network', timeout ? `请求超时（${req.timeoutMs}ms）` : `网络失败：${e.message}`);
  }
  const json = await res.json().catch(() => null);
  if (json === null) throw new ConnectorError('parse', `返回不是 JSON（HTTP ${res.status}）`);
  return json;
};

const client = makeContentClient('redfox', { apiKey: API_KEY, sourceTag: 'FitFlow CLI' }, { transport });

/* ---------------- 工具 ---------------- */
const num = (n) => (n == null ? '-' : Number(n).toLocaleString('zh-CN'));
const compact = (n) => {
  if (n == null) return '-';
  const v = Number(n);
  if (v >= 100000000) return (v / 100000000).toFixed(2) + ' 亿';
  if (v >= 10000) return (v / 10000).toFixed(1) + ' 万';
  return num(v);
};
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

function fail(e) {
  if (e instanceof ConnectorError) {
    const map = {
      insufficient_credits: 3,
      unauthorized: 2,
      endpoint_unverified: 4,
      bad_request: 4,
      network: 4,
      api: 4,
      parse: 4,
    };
    console.error(`\n✗ ${e.message}`);
    if (e.code === 'insufficient_credits') {
      console.error(`  充值入口：${e.detail?.rechargeUrl || 'https://redfox.hk/dashboard/recharge'}`);
      console.error('  链路本身是通的（鉴权通过、端点可达），只是余额为 0，接口拒绝执行。');
    }
    if (e.detail && e.code !== 'insufficient_credits') console.error(`  细节：${typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)}`);
    process.exit(map[e.code] ?? 4);
  }
  console.error('\n✗ 未预期错误：', e?.message || e);
  process.exit(4);
}

/* ---------------- probe：只回答"链路通不通、积分够不够" ---------------- */
async function runProbe() {
  const account = accounts[0] || 'douyin';
  const rows = await redfox.probe({ apiKey: API_KEY, account });

  if (AS_JSON) { console.log(JSON.stringify({ provider: redfox.id, probe: rows }, null, 2)); return; }

  console.log(`\n红狐端点自检（样本账号：${account}）`);
  console.log('─'.repeat(78));
  console.log('资源      路径                                     HTTP  code   耗时    结果');
  console.log('─'.repeat(78));
  for (const r of rows) {
    const verdict = r.ok ? '可用' : (r.code === 3201 ? '端点通，积分不足' : (r.msg || '失败').slice(0, 20));
    console.log(
      `${r.resource.padEnd(9)} ${r.path.padEnd(40)} ${String(r.http ?? '-').padEnd(5)} ${String(r.code ?? '-').padEnd(6)} ${String(r.ms + 'ms').padEnd(7)} ${verdict}`
    );
  }
  console.log('─'.repeat(78));
  const allOk = rows.every((r) => r.ok);
  const noCredit = rows.some((r) => r.code === 3201);
  if (allOk) console.log(`✓ 两个端点均可用。单次成本：account ${redfox.endpointSpec.account.creditCost} 积分、works ${redfox.endpointSpec.works.creditCost} 积分。`);
  else if (noCredit) console.log('⚠ 端点可达、鉴权通过，但积分余额不足，业务调用不会执行。');
  else console.log('✗ 存在失败端点，看上面的 code 与信息。');
  console.log('');
}

/* ---------------- 主流程 ---------------- */
async function run() {
  if (PROBE_ONLY) return runProbe();

  const out = { provider: redfox.id, platform: redfox.platform, fetchedAt: new Date().toISOString(), accounts: [] };

  for (const account of accounts) {
    if (!AS_JSON) console.log(`\n▸ 拉取账号：${account}`);
    /* 先取账号维度（含内嵌作品），再补一次作品列表拿更全的近期作品 */
    const acc = await client.fetchAccount(account);
    if (acc.notFound) {
      if (!AS_JSON) console.log('  未收录：红狐广域库没有这个账号。建议先用抖音号确认拼写，或稍后再试。');
      out.accounts.push({ account, notFound: true });
      continue;
    }
    const worksRes = await client.fetchWorks(account);
    /* 分页参数名还没核对（见 redfox.js endpointSpec.works.paginationVerified），
       所以 --limit 只是在这一页的结果里截断，不代表能翻页翻到底。 */
    const works = (worksRes.works.length ? worksRes.works : acc.works).slice(0, LIMIT);

    /* 账号维度以 account 接口为准；它没给的字段，用 works 的 author* 兜一层 */
    const merged = { ...(worksRes.account || {}), ...acc.account };

    const likes = works.map((w) => w.diggCount).filter((v) => v != null);
    const inter = works.map((w) => w.interactiveCount).filter((v) => v != null);
    const hotRate = works.length ? works.filter((w) => (w.diggCount || 0) >= 100000).length / works.length : null;
    const times = works.map((w) => w.createTime).filter(Boolean).sort();
    const spanDays = times.length > 1
      ? Math.max(1, Math.round((new Date(times[times.length - 1]) - new Date(times[0])) / 86400000))
      : null;

    const dims = {
      账号维度: {
        抖音号: merged.remoteId || account,
        昵称: merged.nickname || '-',
        粉丝数: merged.followerCount,
        作品总数: merged.awemeCount ?? acc.account?.awemeCount ?? null,
        累计获赞: merged.totalFavorited,
        红狐指数: merged.redfoxIndex,
        IP归属地: merged.region,
        数据抓取时间: merged.crawlTime,
        主页: merged.secUid ? `https://www.douyin.com/user/${merged.secUid}` : null,
      },
      作品表现: {
        取样条数: works.length,
        均赞: likes.length ? Math.round(likes.reduce((a, b) => a + b, 0) / likes.length) : null,
        中位赞: median(likes),
        均互动: inter.length ? Math.round(inter.reduce((a, b) => a + b, 0) / inter.length) : null,
        爆款率: hotRate,
        更新跨度天: spanDays,
        更新频率: spanDays ? `${(works.length / (spanDays / 7)).toFixed(1)} 条/周` : null,
        区间: times.length ? `${times[0]} → ${times[times.length - 1]}` : null,
      },
    };

    out.accounts.push({ account, dimensions: dims, works });

    if (!AS_JSON) {
      console.log('  ── 账号维度 ──');
      const d = dims.账号维度;
      console.log(`  ${d.昵称}（${d.抖音号}）`);
      console.log(`  粉丝 ${compact(d.粉丝数)} ｜ 获赞 ${compact(d.累计获赞)} ｜ 作品 ${num(d.作品总数)} ｜ 红狐指数 ${d.红狐指数 ?? '-'} ｜ ${d.IP归属地 || '-'}`);
      if (d.数据抓取时间) console.log(`  数据抓取时间：${d.数据抓取时间}（第三方数据，非实时）`);
      if (d.主页) console.log(`  主页：${d.主页}`);
      console.log('  ── 作品表现 ──');
      const w = dims.作品表现;
      console.log(`  取样 ${w.取样条数} 条 ｜ 均赞 ${compact(w.均赞)} ｜ 中位赞 ${compact(w.中位赞)} ｜ 均互动 ${compact(w.均互动)}`);
      console.log(`  爆款率(≥10万赞) ${w.爆款率 == null ? '-' : (w.爆款率 * 100).toFixed(0) + '%'} ｜ 更新 ${w.更新频率 || '-'} ｜ 区间 ${w.区间 || '-'}`);
      const top = [...works].sort((a, b) => (b.diggCount || 0) - (a.diggCount || 0)).slice(0, 3);
      if (top.length) {
        console.log('  ── 互动 TOP ' + top.length + ' ──');
        top.forEach((t, i) => {
          console.log(`  ${i + 1}. [${compact(t.diggCount)} 赞] ${(t.title || '(无文案)').slice(0, 40)}`);
          if (t.url) console.log(`     ${t.url}`);
        });
      }
    }
  }

  if (AS_JSON) console.log(JSON.stringify(out, null, 2));
  else {
    const cost = (accounts.length * (redfox.endpointSpec.account.creditCost + redfox.endpointSpec.works.creditCost)).toFixed(1);
    console.log(`\n本次约消耗 ${cost} 积分（account ${redfox.endpointSpec.account.creditCost} + works ${redfox.endpointSpec.works.creditCost}，每个账号）。`);
    console.log('提示：这个脚本只是把适配器跑通。要让它自动回填到「运营 → 线上营销」，需要接界面。\n');
  }
}

run().catch(fail);
