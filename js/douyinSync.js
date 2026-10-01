/* ============================================================
   douyinSync.js · 抖音取数编排
   ------------------------------------------------------------
   为什么单独一个文件：
     · views 不该做 IO 编排（它只负责画）
     · store 不该知道网络（它只管存）
     · douyin.js 是纯计算，不引网络
   编排放这里，三方都不被污染。这也让 CLI 能复用同一套逻辑。

   同步策略上的两个判断：
     1. 先探代理和密钥，再发业务请求。否则浏览器会先吃一个
        连不上 localhost 的报错，而真实原因其实是代理没起。
     2. 作品列表失败不算整体失败。账号维度已经拿到手，
        少一部分派生指标总比整次同步白跑要好，但要落一条日志说清楚。
   ============================================================ */
import { makeContentClient } from './integrations/index.js';
import { saveDouyinSnapshot, logDouyinError, saveBenchmarks, saveTopBoard } from './store.js';
import { pickBenchmarks } from './douyin.js';

const DEFAULT_PROXY = 'http://localhost:8787';

function buildClient(proxyUrl, endpointsVerified, uniqueName, proxyToken) {
  return makeContentClient('redfox', {
    proxyUrl: proxyUrl || DEFAULT_PROXY,
    /* 线上代理的访问口令（PROXY_ACCESS_TOKEN），本地代理留空 */
    proxyToken: proxyToken || '',
    endpointsVerified: endpointsVerified || {},
    accounts: uniqueName ? [uniqueName] : [],
  });
}

/**
 * 同步一次抖音账号。
 * 返回 { ok, step, error, account, works, calls }。
 * 每条失败路径都会写一条同步日志，界面上要能看出"试过了但没成功"。
 */
export async function syncDouyinAccount({ uniqueName, proxyUrl, proxyToken, endpointsVerified, monitor }) {
  const m = monitor || {};
  const client = buildClient(proxyUrl, endpointsVerified, uniqueName, proxyToken);

  const h = await client.health();
  if (!h.ok) {
    logDouyinError(`连不上代理 ${proxyUrl || DEFAULT_PROXY}。本地先运行 node server/proxy.mjs；线上确认 https://域名/api 已部署`);
    return { ok: false, step: 'proxy', error: h.error };
  }
  if (!h.provider?.configured) {
    logDouyinError('代理已启动，但 REDFOX_API_KEY 还没配置');
    return {
      ok: false, step: 'key',
      error: new Error('代理已启动，但 REDFOX_API_KEY 未配置。启动代理时用环境变量注入。'),
    };
  }

  let account = null;
  let works = [];
  const calls = [];

  if (m.account !== false) {
    try {
      const r = await client.fetchAccount(uniqueName);
      calls.push('account');
      if (r.notFound) {
        logDouyinError(`红狐查不到抖音号 ${uniqueName}，核对一下是不是写错了`);
        return { ok: false, step: 'account', notFound: true, error: new Error('红狐没有返回这个账号，确认抖音号是否正确') };
      }
      account = r.account;
    } catch (e) {
      logDouyinError(`账号维度取数失败：${e.message}`);
      return { ok: false, step: 'account', error: e };
    }
  }

  if (m.works !== false) {
    try {
      const r = await client.fetchWorks(uniqueName);
      calls.push('works');
      works = r.works || [];
      /* works 接口把账号信息塞在 author* 里，这是降级通道：
         账号维度没开或失败时，至少还能从作品里捞回粉丝数 */
      if (!account && r.account) account = r.account;
    } catch (e) {
      logDouyinError(`作品列表取数失败，本次只保留账号维度：${e.message}`);
    }
  }

  if (!account && !works.length) {
    logDouyinError('这次没取到任何数据，账号维度与作品列表都是空的');
    return { ok: false, step: 'empty', error: new Error('没取到数据') };
  }

  saveDouyinSnapshot({ account, works, isSample: false, source: 'redfox' });
  return { ok: true, account, works, calls };
}

/**
 * 搜对标账号。
 * 它和账号同步分开调，因为对标要多花一次搜索调用的钱，
 * 由 monitor.benchmark 单独控制，不该绑定在每次同步上。
 */
export async function syncDouyinBenchmarks({ keyword, proxyUrl, proxyToken, endpointsVerified, mine }) {
  if (!keyword) return { ok: false, error: new Error('关键词必填') };
  const client = buildClient(proxyUrl, endpointsVerified, null, proxyToken);

  try {
    const list = await client.fetchSearchAccounts(keyword);
    saveBenchmarks(list, { keyword, isSample: false });
    return { ok: true, list, picked: pickBenchmarks(list, mine) };
  } catch (e) {
    logDouyinError(`对标账号搜索失败（关键词「${keyword}」）：${e.message}`);
    return { ok: false, error: e };
  }
}

/**
 * 取官方赛道榜。
 * 榜位由接口给，我们只负责原样存和显示 —— 不重排、不按自己口径再算一遍。
 */
export async function syncDouyinBoard({ dateType, rankDate, category, proxyUrl, proxyToken, endpointsVerified }) {
  if (!rankDate) return { ok: false, error: new Error('榜单日期必填') };
  if (!category) return { ok: false, error: new Error('赛道必填') };

  const client = buildClient(proxyUrl, endpointsVerified, null, proxyToken);
  try {
    const items = await client.fetchTopAccounts({ dateType, rankDate, category });
    if (!items.length) {
      logDouyinError(`「${category}」${rankDate} 这一期返回空榜，换个日期试试（官方日榜每晚 8 点才更新昨日数据）`);
      return { ok: false, empty: true, error: new Error('这一期是空榜') };
    }
    saveTopBoard({ items, dateType, rankDate, category, isSample: false });
    return { ok: true, items };
  } catch (e) {
    logDouyinError(`赛道榜取数失败（${category} · ${rankDate}）：${e.message}`);
    return { ok: false, error: e };
  }
}

/**
 * 门店热度的关键词近似召回。
 * 刻意不叫 syncPoi：它拿回来的不是 POI 数据，名字里不能出现门店定位这种词，
 * 否则半年后没人记得这个区别。
 */
export async function searchWorksByKeyword({ keyword, proxyUrl, proxyToken, endpointsVerified }) {
  if (!keyword) return { ok: false, error: new Error('关键词必填') };
  const client = buildClient(proxyUrl, endpointsVerified, null, proxyToken);
  try {
    const list = await client.fetchSearchWorks(keyword);
    return { ok: true, list };
  } catch (e) {
    logDouyinError(`关键词搜作品失败（关键词「${keyword}」）：${e.message}`);
    return { ok: false, error: e };
  }
}
