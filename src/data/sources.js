/**
 * sources —— 行情适配器。四条通道按优先级降级，任何一条通了就返回：
 *
 *   1. 本地服务器 /api/kline  —— 首选。隔离 CORS 与上游接口变动（演进计划 §7 的对策）。
 *      仅在 origin 看起来确实可能跑着本地后端时才尝试（见 mightHaveLocalBackend），
 *      静态托管上整条跳过，避免每次取数都在控制台留一条 404。
 *   2. 浏览器直连 eastmoney   —— 备用。实测 push2his 会回显请求 Origin，
 *      所以 http://localhost 下能直连；file:// 下 Origin 为 null 会被拒，属预期。
 *      但 push2his 会整段拒连（按 IP/频率翻脸，A股与期货 secid 一起挂），这时只能靠 3、4。
 *   3. 浏览器直连 腾讯 ifzq   —— A股/指数/ETF 兜底，实测带 Access-Control-Allow-Origin: *，
 *      静态托管也能跑。只有日/周/月线，复权基准与东财不同（见 viaTencentDirect）。
 *   4. 新浪 JSONP             —— 期货兜底通道，file:// 也能跑，日线带交易所结算价。
 *      注意：日线服务名是 InnerFuturesNewService.getDailyKLine；旧的 IndexService 名字
 *      早已失效（返回 Invalid service name），别再把它当成"新浪数据冻结"。
 *      它仍只作对照/兜底：主源是东财，字段更全、主连拼接口径也更稳定。
 *      A股 走不了这条：新浪的 A股 历史接口没有 CORS、也不接受 callback，浏览器直连必被挡。
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
async function viaEastmoneyDirect(secid, period, adjust, count, end) {
  // 未知周期不能悄悄退回 klt=101：那样请求 4 小时会给一屏日线，回测跑完都不知道数据是假的
  const klt = KLTL[period];
  if (!klt) throw new Error(`eastmoney 没有 ${period} 这个周期`);
  const qs = new URLSearchParams({
    secid, fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt, fqt: FQT[adjust] ?? '1'
  });
  if (count) { qs.set('end', end || '20500101'); qs.set('lmt', String(count)); }
  else { qs.set('beg', '19700101'); qs.set('end', end || '20500101'); }
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

/**
 * 通道 3：腾讯 ifzq —— A股/指数/ETF 的浏览器直连兜底。
 *
 * 为什么要有它：东财 push2his 会整段拒连（实测 curl 三次全 HTTP 000、本地代理 502、
 * 浏览器 Failed to fetch），而新浪的 A股 历史接口不带 Access-Control-Allow-Origin、
 * 也不接受 callback（实测加了 callback 仍返回裸 JSON），在线版（静态托管、无本地后端）
 * 于是只能干等。腾讯这个域实测回显 `Access-Control-Allow-Origin: *`，浏览器直连可用。
 *
 * 三处实测口径，别改回去：
 *   · 列序是 date,open,CLOSE,high,low,volume —— 和第 2 通道东财同形，第 3 列不是 high。
 *     写反就是整根K线上下颠倒（本项目在 60m 合成上出过一次），所以有一道几何校验兜着。
 *   · 单次上限 640 根：请求 1000 只回 640，请求 5000 直接返回非对象。长历史按 end 往前翻。
 *   · 复权基准与东财不同：不复权逐点相同（000300 实测差 0.0），后复权是每个品种一个常数倍
 *     （000001 ×1.207、600519 ×1.121），日收益差 ≤0.033pp。绝对价会进仓位与占用，
 *     所以复权序列带 basis='tx'，由缓存键把它和东财序列隔开；不复权与指数不需要隔。
 */
const TX_HOST = 'https://web.ifzq.gtimg.cn';
const TX_KLT = { daily: 'day', weekly: 'week', monthly: 'month' };
const TX_FQ = { none: '', qfq: 'qfq', hfq: 'hfq' };
const TX_PAGE = 640;
const TX_MAX_PAGES = 16;

/** 东财 secid `0.000001` / `1.600519` → 腾讯 `sz000001` / `sh600519`；已是腾讯写法则原样返回。 */
export function tencentCodeOf(secid) {
  const s = String(secid || '').trim().toLowerCase();
  const m = /^([01])\.(\d{6})$/.exec(s);
  if (m) return `${m[1] === '1' ? 'sh' : 'sz'}${m[2]}`;
  return /^[a-z]{2}\d{6}$/.test(s) ? s : '';
}

/** 腾讯K线行 → bar。列序 [date, open, close, high, low, volume, …]，多余字段丢掉。 */
export function txRowsToBars(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!Array.isArray(r) || r.length < 5) continue;
    const bar = { date: String(r[0]), open: parseFloat(r[1]), close: parseFloat(r[2]),
                  high: parseFloat(r[3]), low: parseFloat(r[4]), volume: parseFloat(r[5]) || 0 };
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/.test(bar.date)) continue;
    if (![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) continue;
    out.push(bar);
  }
  return sortByDate(out);
}

/**
 * 几何校验：high ≥ max(open,close) 且 low ≤ min(open,close)。
 * 列序哪天再变（比如上游改成 OHLC），几乎每根都会越界 —— 那就拒绝出图，
 * 而不是把颠倒的K线画出去、让均线与突破全错却没有任何提示。
 */
export function assertTxGeometry(bars) {
  if (!Array.isArray(bars) || bars.length < 20) return;
  let bad = 0;
  for (const b of bars) {
    const hi = Math.max(b.open, b.close), lo = Math.min(b.open, b.close);
    if (!(b.high >= hi - 1e-6 && b.low <= lo + 1e-6)) bad++;
  }
  if (bad > bars.length * 0.01) {
    throw new Error(`腾讯K线高低点几何校验不通过（${bad}/${bars.length} 根越界），列序可能已变，拒绝出图`);
  }
}

/** 前一交易日锚点：只按 UTC 做日期减法，避免本地时区把 end 参数错移一天。 */
function prevCalendarDay(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - 86400000).toISOString().slice(0, 10);
}

async function txFetchPage(code, klt, fq, end, timeoutMs) {
  const url = `${TX_HOST}/appstock/app/fqkline/get?param=${code},${klt},,${end || ''},${TX_PAGE},${fq}`;
  const res = await withTimeout(fetch(url), timeoutMs, '腾讯直连');
  if (!res.ok) throw new Error(`腾讯直连返回 ${res.status}`);
  const json = await res.json();
  const d = json && json.data && json.data[code];
  if (!d || typeof d !== 'object') throw new Error(`腾讯返回里没有 ${code} 的数据`);
  // 指数没有复权概念，问它要 hfq 仍回 day —— 两个键名都认，但认不到必须说清楚
  const key = [`${fq}${klt}`, klt].find(k => Array.isArray(d[k]) && d[k].length);
  if (!key) throw new Error(`腾讯返回缺少 ${klt}${fq || ''} 序列（键：${Object.keys(d).join(',')}）`);
  return d[key];
}

/** 复权基准标记：不复权与指数两边逐点相同，不需要隔开；前/后复权是另一把尺子。 */
export function tencentBasisOf(adjust) {
  return (adjust === 'qfq' || adjust === 'hfq') ? 'tx' : '';
}

/** 本机当天（YYYY-MM-DD）。用本地日历而不是 UTC，否则晚上 8 点后取数会把"今天"算成昨天。 */
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function viaTencentDirect({ secid, period, adjust, count, end }, timeoutMs = 12000) {
  const code = tencentCodeOf(secid);
  if (!code) throw new Error(`腾讯通道解析不出 ${secid} 的市场前缀代码`);
  const klt = TX_KLT[period];
  if (!klt) throw new Error(`腾讯通道没有 ${period} 这个周期（只有 daily/weekly/monthly），拒绝用日线顶替`);
  if (!(adjust in TX_FQ)) throw new Error(`腾讯通道不认识复权口径 ${adjust}`);
  const fq = TX_FQ[adjust];

  // 腾讯复权序列"当日那根"用的是还没换新的因子表：实测 2026-11-06 末根隐含因子 155.81，
  // 前一根 199.11，凭空多出 −21.7% 的假跳空（深市主板涨跌停只有 ±10%，不可能是行情）。
  // 给它显式 end 就只回到上一根已收盘的，所以复权口径一律把游标压到昨天；不复权没这个问题。
  let cursor = end || (fq ? prevCalendarDay(localToday()) : '');
  const rows = [];
  const seam = new Map();          // 页间接缝：同一日期在相邻两页里的收盘价必须一致
  let pages = 0, exhausted = false;
  while (pages < TX_MAX_PAGES) {
    const page = await txFetchPage(code, klt, fq, cursor, pages === 0 ? timeoutMs : 12000);
    pages++;
    if (!page.length) { exhausted = true; break; }
    for (const r of page) {
      const d = String(r[0]), close = parseFloat(r[2]);
      if (!seam.has(d)) seam.set(d, close);
      else if (Math.abs(seam.get(d) - close) > Math.abs(close) * 0.005) {
        throw new Error(`腾讯翻页接缝对不上（${d} 两次分别给 ${seam.get(d)} 与 ${close}），两页基准不一致，拒绝拼接`);
      }
    }
    rows.push(...page);
    if (page.length < TX_PAGE) { exhausted = true; break; }
    if (count && rows.length >= count) break;
    // 下一页把这一页最早那根再带一次：没有重叠就没有接缝可查，翻错的基准就只能靠肉眼发现
    cursor = page.reduce((min, r) => (String(r[0]) < min ? String(r[0]) : min), String(page[0][0]));
    if (!cursor) break;
  }

  const unique = new Map();
  for (const r of rows) { const d = String(r[0]); if (!unique.has(d)) unique.set(d, r); }
  const bars = txRowsToBars([...unique.values()]);
  if (!bars.length) throw new Error(`腾讯返回的 ${code} 序列解析后没有有效K线`);
  assertTxGeometry(bars);

  const basis = tencentBasisOf(adjust);
  const parts = [];
  if (basis) parts.push(`${adjust === 'hfq' ? '后' : '前'}复权按腾讯基准（与东财同口径差一个品种一个常数倍，日收益差 ≤0.033pp，绝对价位不可与东财序列混用；缓存已按基准分开）`);
  if (fq && !end) parts.push('不含当日未换因子那根（腾讯复权因子表当日滞后，实测会凭空造出 −21.7% 假跳空）');
  if (!exhausted) parts.push(`只翻了 ${pages} 页，更早的历史没取到，当前最早 ${bars[0].date}`);
  return { ok: true, source: 'tencent', name: null, secid, period, adjust, basis,
           count: bars.length, bars, pages, exhausted, depth: depthOf(bars), note: parts.join('｜') };
}

/** 通道 4：新浪期货 JSONP（保留旧的对外行为，但修好了解析） */
export function fetchSinaJSONP(symbol, period = 'daily', timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const cbName = 'sina_cb_' + Math.random().toString(36).slice(2, 8);
    const cleanSymbol = String(symbol).toUpperCase().trim();
    // 新浪只有这两个服务。以前非 60m 一律落到日线服务，于是"取周线"会拿到**日线**
    // 还带 ok:true —— 上层据此跳过本地聚合，再把日线按 weekly 键写进 IndexedDB，
    // 之后每次开周线都"秒开"那份被污染的数据。没有的服务必须明确拒绝，不能拿别的周期顶替。
    //
    // 日线服务名：InnerFuturesNewService.getDailyKLine 是现行接口（数据到当前交易日）；
    // 旧的 IndexService.getInnerFuturesDailyKLine 已失效/冻结，不要再拿它当"新浪只有旧数据"。
    const SINA_SERVICES = { daily: 'InnerFuturesNewService.getDailyKLine',
                            '60m': 'IndexService.getInnerFuturesMiniKLine60m' };
    const svc = SINA_SERVICES[period];
    if (!svc) {
      reject(new Error(`新浪通道没有 ${period} 这个周期（只有 daily / 60m），拒绝用日线顶替`));
      return;
    }
    const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20${cbName}=/${svc}?symbol=${cleanSymbol}`;
    const script = document.createElement('script');

    // 新浪这个接口发的是 `var cb=(数据)` —— 赋值，不是 `cb(数据)` 那种调用。
    // 原来只把 window[cbName] 挂成函数等它被回调，于是脚本 200 加载完、赋值把函数覆盖掉、
    // 一次都不会触发，整条通道固定 8 秒超时。实测 RB0 的返回首尾：
    //   /*<script>location.href='//sina.com';</script>*/\nvar t=([["2009-03-27",...]]);
    // 两种形态都吃：onload 后先看有没有被当函数调用过，没有就读回那个全局变量。
    let calledWith = null;
    window[cbName] = (raw) => { calledWith = raw; };

    function settle() {
      const rawData = calledWith !== null ? calledWith : window[cbName];
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
      clearTimeout(timer);
      if (!Array.isArray(rawData) || rawData.length === 0) {
        reject(new Error(`未获取到 ${cleanSymbol} 行情`));
        return;
      }
      const bars = sortByDate(rawData.map(normalizeSinaRow).filter(Boolean));
      if (bars.length === 0) { reject(new Error('新浪数据解析后无有效条目')); return; }
      const withSettle = period === 'daily' ? bars.filter(b => b.settlement > 0).length : 0;
      resolve({ ok: true, source: 'sina', name: null, secid: `sina.${cleanSymbol}`,
                period, adjust: 'none', count: bars.length, bars,
                settlementBars: withSettle,
                note: period === 'daily'
                  ? (withSettle ? `日线含交易所结算价 ${withSettle}/${bars.length} 根` : '日线未返回结算价，逐日盯市将回退收盘价')
                  : '60 分钟线不带结算价' });
    }

    const timer = setTimeout(() => {
      if (script.parentNode) script.parentNode.removeChild(script);
      delete window[cbName];
      reject(new Error('新浪在线同步超时'));
    }, timeoutMs);

    script.onload = settle;
    script.onerror = () => {
      clearTimeout(timer);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
      reject(new Error('新浪请求受阻'));
    };
    script.src = url;
    document.body.appendChild(script);
  });
}

/** 新浪期货代码：东财主连写法 rbm / RB0 都归一到 RB0；具体合约 rb2701 → RB2701。 */
export function sinaSymbolOf(symbol) {
  const s = String(symbol || '').toUpperCase().trim();
  const m = /^([A-Z]+)M$/.exec(s);
  return m ? `${m[1]}0` : s;
}

/**
 * 用新浪日线的交易所结算价补全东财序列。
 *
 * 东财 kline 不带结算价，逐日盯市只能拿收盘价代理；新浪日线的 s 字段就是结算价。
 * 两边的主连都不是"某一份合约"而是拼接口径，所以只按日期合并结算价、不拿新浪的价格覆盖 OHLC。
 * 失败就原样返回：补不上是缺一份更好的近似，不是让整次同步失败。
 *
 * @returns {Promise<{merged:number, matched:number, error?:string}>}
 */
export async function enrichSettlementFromSina(bars, symbol, { timeoutMs = 5000 } = {}) {
  if (!bars || !bars.length || typeof document === 'undefined') return { merged: 0, matched: 0 };
  try {
    const out = await fetchSinaJSONP(sinaSymbolOf(symbol), 'daily', timeoutMs);
    const byDate = new Map();
    for (const b of out.bars || []) {
      if (b.settlement > 0) byDate.set(String(b.date).slice(0, 10), b.settlement);
    }
    let merged = 0;
    for (const b of bars) {
      const v = byDate.get(String(b.date).slice(0, 10));
      if (v > 0) { b.settlement = v; merged++; }
    }
    return { merged, matched: byDate.size };
  } catch (e) {
    return { merged: 0, matched: 0, error: String(e.message || e) };
  }
}

/**
 * 统一入口。分钟线在这里会自动往前回填；4 小时由 data/periods.js 的 resolveBars
 * 从 60m 合成，**不在这里兜底** —— 把 4h 直接喂给上游只会被 KLTL 兜成日线，
 * 那正是上一轮"4 小时缓存里其实是日线"的来源。
 *
 * withSettlement 只对期货日线生效：东财 kline 不带结算价，用新浪日线的 s 字段按日期补；
 * sinaSymbol 是新浪的 <品种>0 代码（东财是 <品种>m），由 symbolMeta 给出。
 *
 * @returns {ok, source, bars, name, count, attempted:[{channel,error}]}
 */
export async function fetchBars({ market = 'futures', symbol, secid, period = 'daily',
                                  adjust = 'none', count = null, provider = 'eastmoney',
                                  sinaSymbol = null, withSettlement = false, end = null } = {}) {
  const targetSecid = secid || symbol;
  const sinaTarget = sinaSymbol || sinaSymbolOf(symbol);
  const out = await fetchBarsOnce({ market, symbol, secid: targetSecid, period, adjust, provider,
                                    count, end, sinaSymbol: sinaTarget });
  if (out.ok && out.bars && out.bars.length && withSettlement
      && market === 'futures' && period === 'daily' && adjust === 'none' && out.source !== 'sina') {
    const en = await enrichSettlementFromSina(out.bars, sinaTarget);
    if (en.merged) {
      out.settlementBars = en.merged;
      out.note = `已用新浪日线补全 ${en.merged} 根交易所结算价（仅补 s 字段，不改 OHLC）`;
    }
  }
  // 回填路上的一页（count 非空）不再递归回填；日线/周线本来就没有深度问题
  if (!out.ok || !out.bars || !out.bars.length || count || !/^\d+m$/.test(period)) return out;
  const merged = await backfillIntraday({ market, symbol, secid: targetSecid, period, adjust,
                                          bars: out.bars, sinaSymbol: sinaTarget });
  return { ...out, bars: attachDefaultMAs(merged.bars), count: merged.bars.length,
           depth: depthOf(merged.bars), pages: merged.pages, exhausted: merged.exhausted };
}

/** 通道按序降级，一次取数，不做合成也不回填。 */
async function fetchBarsOnce({ market, symbol, secid, period, adjust, provider, count, end, sinaSymbol }) {
  const attempted = [];
  const targetSecid = secid || symbol;
  const sinaTarget = sinaSymbol || sinaSymbolOf(symbol);

  if (provider === 'sina') {
    try {
      const out = await fetchSinaJSONP(sinaTarget, period);
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
      if (end) params.end = end;
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
    const out = await viaEastmoneyDirect(targetSecid, period, adjust, count, end);
    return { ...out, bars: attachDefaultMAs(out.bars), attempted };
  } catch (e) {
    attempted.push({ channel: 'eastmoney-direct', error: String(e.message || e) });
  }

  // 3. A股/指数/ETF 再兜一层腾讯 ifzq。东财 push2his 整段拒连时，在线版只有这条路能出图；
  //    分钟线它没有（mkline 301 到 web3 后直接 reset），所以宁缺不顶，绝不拿日线冒充 60m。
  if (market !== 'futures') {
    try {
      const out = await viaTencentDirect({ secid: targetSecid, period, adjust, count, end });
      return { ...out, bars: attachDefaultMAs(out.bars), attempted };
    } catch (e) {
      attempted.push({ channel: 'tencent-direct', error: String(e.message || e) });
    }
  }

  // 4. 期货再兜一层新浪。东财不可用时才走这里；新浪日线带交易所结算价，
  //    历史可回到 2009（RB0），比东财主连拼接的 2015 还长。
  if (market === 'futures') {
    try {
      const out = await fetchSinaJSONP(sinaTarget, period);
      return { ...out, bars: attachDefaultMAs(out.bars), attempted,
               note: '已降级到新浪通道（东财不可用；日线带交易所结算价）' };
    } catch (e) {
      attempted.push({ channel: 'sina-jsonp', error: String(e.message || e) });
    }
  }

  return { ok: false, error: '三条行情通道全部失败', attempted };
}

/** 分钟线一次往前翻多少根。期货 60 分钟一天约 6~7 根，500 根够跨两个多月。 */
const BACKFILL_PAGE = 500;
const BACKFILL_MAX_PAGES = 6;

/**
 * 分钟线往前回填 —— 想解决的问题是「60 分钟只给一个月，根本没法回测」。
 *
 * 为什么要单独一条路：带 beg 的那次请求，上游按「全部可得」返回，实测期货 60 分钟只有约一个月。
 * 但 run_local_server.py 里记着另一条实测：不带 beg 时 lmt 才被尊重，带上 beg 就被忽略、返回全部历史。
 * 两条都是量出来的，说明 end+lmt 走的是另一条取数分支，有可能够到更深的位置。这里就拿 end 当游标
 * 一段一段往前挪，能挖多深挖多深；第一页翻不出新 bar 就停手，不空转。
 *
 * 上限刻意压得很低（6 页）：这不保证更多数据，只保证「上游要是放开了，我们不改代码就能吃到」。
 *
 * @returns {{bars:Array, pages:number, exhausted:boolean}}
 */
export async function backfillIntraday({ market = 'futures', symbol, secid, period = '60m',
                                         adjust = 'none', sinaSymbol = null, bars = [],
                                         targetBars = 2000, maxPages = BACKFILL_MAX_PAGES } = {}) {
  if (!/^\d+m$/.test(period)) return { bars, pages: 0, exhausted: true };
  let out = bars.slice();
  const seen = new Set(out.map(b => b.date));
  let pages = 0, exhausted = false;
  while (out.length < targetBars && pages < maxPages) {
    const endDay = String(out[0].date || '').slice(0, 10).replace(/-/g, '');
    if (!/^\d{8}$/.test(endDay)) break;
    let page;
    try {
      page = await fetchBarsOnce({ market, symbol, secid, period, adjust,
                                   count: BACKFILL_PAGE, end: endDay, sinaSymbol });
    } catch (e) {
      break;
    }
    pages++;
    const rows = (page && page.ok && page.bars) ? page.bars : [];
    const fresh = rows.filter(b => b && b.date && !seen.has(b.date));
    if (!fresh.length) { exhausted = true; break; }   // 翻不出新 bar：上游就到这儿了
    for (const b of fresh) seen.add(b.date);
    out = sortByDate(out.concat(fresh));
  }
  return { bars: out, pages, exhausted };
}

/** 序列实际覆盖到哪儿 —— 界面上要把它讲出来，不然用户以为是自己哪里没设对。 */
export function depthOf(bars) {
  if (!bars || !bars.length) return { first: null, last: null, count: 0 };
  return { first: bars[0].date, last: bars[bars.length - 1].date, count: bars.length };
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
