/**
 * sources —— 行情适配器。三条通道按优先级降级，任何一条通了就返回：
 *
 *   1. 本地服务器 /api/kline  —— 首选。隔离 CORS 与上游接口变动（演进计划 §7 的对策）。
 *      仅在 origin 看起来确实可能跑着本地后端时才尝试（见 mightHaveLocalBackend），
 *      静态托管上整条跳过，避免每次取数都在控制台留一条 404。
 *   2. 浏览器直连 eastmoney   —— 备用。实测 push2his 会回显请求 Origin，
 *      所以 http://localhost 下能直连；file:// 下 Origin 为 null 会被拒，属预期。
 *   3. 新浪 JSONP             —— 遗留期货通道，file:// 也能跑。
 *      已知：新浪期货日线数据冻结在 2024-07-17（实测 RB0/M0/CU0 末根都是那天），
 *      所以它只作为对照/兜底，不再是主源。
 *
 * bars 一律归一化成 {date,open,high,low,close,volume}，按日期升序，并 pre-bake ma5/ma10/ma20。
 */

import { attachDefaultMAs, normalizeSinaRow, sortByDate } from './indicators.js';

const EM_HOST = 'https://push2his.eastmoney.com';
const KLTL = { daily: '101', weekly: '102', monthly: '103', '60m': '60', '30m': '30', '15m': '15', '5m': '5', '1m': '1' };
const FQT = { none: '0', qfq: '1', hfq: '2' };

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms))
]);

/**
 * 这台主机上有没有可能跑着本地后端？
 *
 * 静态托管（GitHub Pages 之类）上 /api/* 一定 404，而原来每次取数都先打一发再降级，
 * 控制台于是固定留两条红色 404 —— 功能没坏，但看着像坏了。这里按 origin 判断，一次请求都不发。
 *
 * 判据不能只写 localhost：`python start.py` 绑的是所有网卡，iPad 是通过
 * http://192.168.x.x:8080 访问的，那种情况下本地后端确实在，必须放行。
 */
export function mightHaveLocalBackend(loc = (typeof location !== 'undefined' ? location : null)) {
  if (!loc || !loc.hostname) return false;
  if (loc.protocol === 'file:') return false;
  const h = String(loc.hostname).replace(/^\[|\]$/g, '');
  if (h === '::1') return true;
  return (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(h))
    || h.endsWith('.local') || h.endsWith('.internal');
}

const LOCAL_BACKEND = mightHaveLocalBackend();

/** 通道 1：本地服务器代理 */
async function viaServer(params, timeoutMs = 12000) {
  const qs = new URLSearchParams(params).toString();
  const res = await withTimeout(fetch(`/api/kline?${qs}`), timeoutMs, '本地服务器');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `本地服务器返回 ${res.status}`);
  }
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || '代理返回失败');
  return json;
}

/** 通道 2：浏览器直连 eastmoney */
async function viaEastmoneyDirect(secid, period, adjust, count) {
  const qs = new URLSearchParams({
    secid, fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: KLTL[period] || '101', fqt: FQT[adjust] ?? '1'
  });
  if (count) { qs.set('end', '20500101'); qs.set('lmt', String(count)); }
  else { qs.set('beg', '19700101'); qs.set('end', '20500101'); }
  const res = await withTimeout(fetch(`${EM_HOST}/api/qt/stock/kline/get?${qs}`), 12000, 'eastmoney 直连');
  const json = await res.json();
  const d = json.data || {};
  // 字段序是 date,OPEN,CLOSE,HIGH,LOW,volume —— 不是 OHLC，写反会让高低点整体错位
  const bars = (d.klines || []).map(line => {
    const p = line.split(',');
    return {
      date: p[0], open: parseFloat(p[1]), high: parseFloat(p[3]),
      low: parseFloat(p[4]), close: parseFloat(p[2]), volume: parseFloat(p[5]) || 0
    };
  }).filter(b => Number.isFinite(b.open) && Number.isFinite(b.close));
  return { ok: true, source: 'eastmoney-direct', name: d.name, secid, period, adjust,
           count: bars.length, bars: sortByDate(bars) };
}

/** 通道 3：新浪期货 JSONP（保留旧的对外行为，但修好了解析） */
export function fetchSinaJSONP(symbol, period = 'daily', timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const cbName = 'sina_cb_' + Math.random().toString(36).slice(2, 8);
    const cleanSymbol = String(symbol).toUpperCase().trim();
    const svc = period === '60m'
      ? 'IndexService.getInnerFuturesMiniKLine60m'
      : 'IndexService.getInnerFuturesDailyKLine';
    const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20${cbName}=/${svc}?symbol=${cleanSymbol}`;
    const script = document.createElement('script');

    function cleanup() {
      clearTimeout(timer);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error('新浪在线同步超时')); }, timeoutMs);

    // 注意：cleanup 必须在赋值前声明可用（函数声明提升，改成 const arrow 会坏）
    window[cbName] = function (rawData) {
      cleanup();
      if (!Array.isArray(rawData) || rawData.length === 0) {
        reject(new Error(`未获取到 ${cleanSymbol} 行情`));
        return;
      }
      const bars = sortByDate(rawData.map(normalizeSinaRow).filter(Boolean));
      if (bars.length === 0) { reject(new Error('新浪数据解析后无有效条目')); return; }
      resolve({ ok: true, source: 'sina', name: null, secid: `sina.${cleanSymbol}`,
                period, adjust: 'none', count: bars.length, bars,
                warning: '新浪期货日线实测已冻结在 2024-07-17，仅作兜底对照' });
    };
    script.onerror = () => { cleanup(); reject(new Error('新浪请求受阻')); };
    script.src = url;
    document.body.appendChild(script);
  });
}

/**
 * 统一入口。
 * @returns {ok, source, bars, name, count, attempted:[{channel,error}]}
 */
export async function fetchBars({ market = 'futures', symbol, secid, period = 'daily',
                                  adjust = 'none', count = null, provider = 'eastmoney' } = {}) {
  const attempted = [];
  const targetSecid = secid || (market === 'ashare' ? symbol : symbol);

  if (provider === 'sina') {
    try {
      const out = await fetchSinaJSONP(symbol, period);
      return { ...out, bars: attachDefaultMAs(out.bars), attempted };
    } catch (e) {
      attempted.push({ channel: 'sina-jsonp', error: String(e.message || e) });
      return { ok: false, error: '新浪通道失败', attempted };
    }
  }

  // 1. 本地服务器（静态托管上直接跳过，不发那一发必定 404 的请求）
  if (LOCAL_BACKEND) {
    try {
      const params = { secid: targetSecid, market, symbol, period, adjust };
      if (count) params.count = count;
      const out = await viaServer(params);
      return { ...out, bars: attachDefaultMAs(sortByDate(out.bars || [])), attempted };
    } catch (e) {
      attempted.push({ channel: 'local-server', error: String(e.message || e) });
    }
  } else {
    attempted.push({ channel: 'local-server', error: '静态托管，无本地后端（已跳过，非故障）' });
  }

  // 2. 浏览器直连 eastmoney
  try {
    const out = await viaEastmoneyDirect(targetSecid, period, adjust, count);
    return { ...out, bars: attachDefaultMAs(out.bars), attempted };
  } catch (e) {
    attempted.push({ channel: 'eastmoney-direct', error: String(e.message || e) });
  }

  // 3. 期货再兜一层新浪
  if (market === 'futures') {
    try {
      const out = await fetchSinaJSONP(symbol, period);
      return { ...out, bars: attachDefaultMAs(out.bars), attempted,
               note: '已降级到新浪通道（数据可能滞后）' };
    } catch (e) {
      attempted.push({ channel: 'sina-jsonp', error: String(e.message || e) });
    }
  }

  return { ok: false, error: '三条行情通道全部失败', attempted };
}

/**
 * searchapi 的返回有两层结构：纯 JSON 是 QuotationCodeTable.Data，
 * JSONP 形态可能是 result.Data / result.pages。只认前者会让检索静默返回 0 条。
 */
export function suggestRows(data) {
  if (!data || typeof data !== 'object') return [];
  const table = data.QuotationCodeTable || {};
  if (Array.isArray(table.Data)) return table.Data;
  const result = data.result || {};
  if (result && typeof result === 'object') {
    for (const key of ['Data', 'pages', 'Results']) if (Array.isArray(result[key])) return result[key];
  }
  return Array.isArray(data.Data) ? data.Data : [];
}

const toCandidate = (r) => ({
  code: r.Code || r.code, name: r.Name || r.name, secid: r.QuoteID || r.secid,
  marketId: r.MktNum || r.marketId, kindRaw: r.SecurityTypeName || r.SecurityType,
  classify: r.Classify || r.classify
});

/**
 * 代码-名称检索（识图导入的名称↔代码交叉校验用）。
 *
 * 原来只能经本地服务器 /api/resolve，静态托管上等于没有这条能力。实测：
 *   fetch → searchapi 不回 Access-Control-Allow-Origin，直接 "Failed to fetch"；
 *   <script> + cb=NAME → 通，GitHub Pages 源上照样拿到完整 QuotationCodeTable。
 * JSONP 不受 CORS 约束，所以这里把它提到主通道，线上/本地/file:// 一致；
 * 本地服务器降为备用（上游哪天改口径时还有一条能换的路）。
 * 只认 cb 这一个参数名 —— 实测 callback / jsonp 两种写法都会 onerror。
 */
export function resolveSymbolJSONP(query, { count = 20, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!query || !String(query).trim()) return resolve([]);
    const cbName = 'em_suggest_' + Math.random().toString(36).slice(2, 8);
    const script = document.createElement('script');
    let timer = null;
    const finish = (val, err) => {
      clearTimeout(timer);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
      err ? reject(err) : resolve(val);
    };
    timer = setTimeout(() => finish(null, new Error(`代码表检索超时 ${timeoutMs}ms`)), timeoutMs);

    window[cbName] = (raw) => {
      let data = raw;
      if (typeof raw === 'string') { try { data = JSON.parse(raw); } catch (e) { return finish(null, new Error('代码表返回无法解析')); } }
      finish(suggestRows(data).map(toCandidate).filter(c => c.code));
    };
    script.onerror = () => finish(null, new Error('代码表请求受阻'));
    const qs = new URLSearchParams({ input: String(query).trim(), type: '14', count: String(count), cb: cbName });
    script.src = `https://searchapi.eastmoney.com/api/suggest/get?${qs}`;
    document.head.appendChild(script);
  });
}

export async function resolveSymbol(query) {
  try {
    return await resolveSymbolJSONP(query);
  } catch (e) {
    if (!LOCAL_BACKEND) return [];
    try {
      const res = await withTimeout(fetch(`/api/resolve?q=${encodeURIComponent(query)}`), 10000, 'resolve');
      const json = await res.json();
      return json.ok ? json.candidates || [] : [];
    } catch (_) { return []; }
  }
}
