/**
 * 周期口径的唯一入口。
 *
 * 为什么单独一个文件：主图取数（futures_replay_trader.html）和自选池批量拉取
 * （ui/watchlistPanel.js）以前各自调 fetchBars，于是新增一个周期就要记得改两处。
 * 上一版就是这么坏的 —— 4小时 直接发给 fetchBars 会被 `KLTL[period] || '101'`
 * 静默兜成**日线**，再按 4h 的缓存键存进去，组合回测拿到的是日线却标着 4 小时。
 * 所有"这个周期该向上游要什么、拿回来怎么合"的判断都收在这里。
 */

import { fetchBars } from './sources.js';
import { BarStore, barKey, cacheBars } from './barStore.js';
import { aggregate, aggregateIntraday, INTRADAY_GROUP } from './dominant.js';
import { attachDefaultMAs } from './indicators.js';

/** 上游没有对应 klt 的周期 → 从哪个更细的真实周期现算。 */
export const AGG_BASE = { '4h': '60m', weekly: 'daily', monthly: 'daily' };

/** 年化因子：夏普等按 bar 数折算年度波动要用，口径必须和实际周期对上。 */
export const PERIODS_PER_YEAR = { daily: 252, weekly: 52, monthly: 12, '60m': 1000, '4h': 250 };

export const PERIOD_LABEL = { daily: '日线', weekly: '周线', monthly: '月线', '4h': '4小时', '60m': '60分钟' };

export const periodLabel = (p) => PERIOD_LABEL[p] || p;
export const periodsPerYear = (p) => PERIODS_PER_YEAR[p] || 252;

/** 相邻 bar 的最小中位间隔（天），低于这个值就说明"这不是这个周期"。 */
const MIN_MEDIAN_GAP_DAYS = { weekly: 4, monthly: 20 };

/**
 * 校验拿回来的序列真的是所请求的周期。
 * 新浪以前把"取周线"静默降级成日线服务并返回 ok:true，于是 1361 根日线被按 weekly
 * 的键写进 IndexedDB，之后每次开周线都"秒开"那份坏数据 —— 光在上游加拒绝还不够，
 * 已经被污染的缓存得能在读取时自己认出来。
 */
export function periodSpacingOk(bars, period) {
  const need = MIN_MEDIAN_GAP_DAYS[period];
  if (need === undefined) return true;             // daily/60m/4h 不在这条判据里
  if (!Array.isArray(bars) || bars.length < 20) return true;  // 太短判不出来，别误伤
  const day = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); 
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
  const gaps = [];
  for (let i = 1; i < bars.length; i++) {
    const g = (day(bars[i].date) - day(bars[i - 1].date)) / 86400000;
    if (Number.isFinite(g) && g > 0) gaps.push(g);
  }
  if (gaps.length < 10) return true;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] >= need;
}

/**
 * 取某个周期的真实 bar。上游没有的口径一律从更细的真实周期现算，绝不拿别的周期顶替。
 * 周/月线相反：上游 klt=102/103 是有的，先问上游，取不到才用日线自己合。
 *
 * @returns {ok, bars, source, count, caveat?}
 */
export async function resolveBars({ market, symbol, secid, sinaSymbol = null,
                                    period = 'daily', adjust = 'none', forceOnline = false }) {
  const ask = (p) => fetchBars({ market, symbol, secid, period: p, adjust, sinaSymbol });
  const base = AGG_BASE[period];
  if (!base) return ask(period);

  if (period !== '4h') {
    const direct = await ask(period);
    if (direct && direct.ok && direct.bars && direct.bars.length) {
      // 间隔对不上就说明上游给的是别的周期的东西，丢掉，改走本地聚合
      if (periodSpacingOk(direct.bars, period)) return direct;
      direct.spacingRejected = true;
    }
  }

  const baseKey = barKey(market, symbol, base, adjust);
  let src = forceOnline ? null : (await BarStore.getCache(baseKey))?.data;
  if (src && !periodSpacingOk(src, base)) src = null;   // 坏缓存视同没有，重新向上游要
  if (!src || !src.length) {
    const r = await ask(base);
    if (!r || !r.ok || !r.bars || !r.bars.length) return r || { ok: false, error: `${base} 也无数据` };
    src = r.bars;
    await cacheBars(baseKey, src, { market, symbol, period: base, adjust, count: src.length });
  }
  const fromDaily = base === 'daily';
  const agg = attachDefaultMAs(fromDaily ? aggregate(src, period)
                                         : aggregateIntraday(src, INTRADAY_GROUP[period]));
  // 底料没有时间戳时（历史上新浪 60m 被截成纯日期就是这种），"每交易日连续 N 根"
  // 并不等于真正的时段划分。与其默默标成 4小时，不如把口径缺陷随数据一起交出去。
  const hasClock = src.some(b => /\d{2}:\d{2}/.test(String(b.date)));
  return {
    ok: true, source: fromDaily ? 'local-aggregate' : 'local-aggregate-60m',
    bars: agg, count: agg.length,
    caveat: (!fromDaily && !hasClock)
      ? `底料 ${base} 序列没有时间戳（只有日期），只能按"每交易日连续 ${INTRADAY_GROUP[period]} 根"合并，不是真正的 ${period} 时段划分`
      : null
  };
}
