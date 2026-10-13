/**
 * 市场扫描器（"今晚哪些品种值得看"）。
 *
 * 闭源软件里最被反复使用的一屏就是这个：一池品种 + 若干列判据 + 排序 + 过滤，
 * 点一行直接进看图/复盘。趋势交易的瓶颈从来不是"找不到买点"，而是
 * "在三百个品种里找到那三个正在启动的" —— 所以这一步必须在工具里，而不是在人脑里。
 *
 * 全部纯函数：吃 [{symbol,name,bars}]，吐一张表。UI 只负责排序和渲染。
 * 判据本身复用 strategy/library 里的 trendTemplate —— 扫描器和策略必须是同一套口径，
 * 否则会出现"扫描器说符合模板，回测里却找不到一笔信号"这种对不上的事。
 */

import { trendTemplate, pivotBreak } from '../strategy/library.js';
import { adx, sma, roc, fieldSma, priorRange, atr } from '../strategy/indicators.js';
import { momentumSeries } from '../core/rotation.js';
import { calendarDayGap } from './dataQuality.js';

const dayOf = (d) => String(d || '').slice(0, 10);
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);

const DEFAULTS = {
  rangeLook: 250, pivotLook: 25, pivotVolMul: 1.2, adxLen: 14, volShort: 5, volLong: 60,
  momLookbacks: [63, 126, 250], minBars: 60, useRs: false
};

/**
 * 单个品种的体检快照。
 * @param {{symbol:string,name?:string,bars:Array,indexBars?:Array}} entry
 *   indexBars 是该品种的基准指数（算 RS 用）；没有就如实标 rsAvailable=false。
 */
export function scanSymbol(entry, opts = {}) {
  const q = { ...DEFAULTS, ...opts };
  const bars = (entry && entry.bars) || [];
  const row = {
    symbol: entry ? String(entry.symbol || '') : '', name: (entry && entry.name) || '',
    bars: bars.length, lastDate: dayOf(bars[bars.length - 1]?.date), ok: false, error: null,
    close: null, ma50: null, ma150: null, ma200: null,
    distHigh: null, aboveLow: null, adx: null, plusMinus: null, atrPct: null,
    mom: {}, score: null, volRatio: null, template: null, breakout: null, gapDays: null
  };
  if (bars.length < q.minBars) { row.error = `只有 ${bars.length} 根，至少需要 ${q.minBars} 根`; return row; }
  const last = bars[bars.length - 1];
  row.close = last.close;
  row.gapDays = bars.length > 1 ? calendarDayGap(dayOf(bars[bars.length - 2].date), row.lastDate) : 0;

  const closes = bars.map(b => b.close);
  const tpl = trendTemplate(bars, { maFast: 50, maMid: 150, maSlow: 200, rangeLook: q.rangeLook,
                                    useRs: q.useRs, rsBars: entry.indexBars });
  row.template = tpl;
  row.ok = true;
  if (tpl.values) {
    row.ma50 = r4(tpl.values.ma50); row.ma150 = r4(tpl.values.ma150); row.ma200 = r4(tpl.values.ma200);
    row.distHigh = tpl.values.hi ? r4(tpl.values.close / tpl.values.hi - 1) : null;
    row.aboveLow = tpl.values.lo ? r4(tpl.values.close / tpl.values.lo - 1) : null;
  }
  row.breakout = pivotBreak(bars, { pivotLook: q.pivotLook, volLen: q.volLong, volMul: q.pivotVolMul });
  row.breakout.level = r4(row.breakout.level);

  const ax = adx(bars, q.adxLen);
  row.adx = r4(ax.adx[ax.adx.length - 1]);
  row.plusMinus = (ax.plus[ax.plus.length - 1] !== null && ax.minus[ax.minus.length - 1] !== null)
    ? r4(ax.plus[ax.plus.length - 1] - ax.minus[ax.minus.length - 1]) : null;

  const a = atr(bars, 14);
  const av = a[a.length - 1];
  row.atrPct = (av && last.close > 0) ? r4(av / last.close) : null;

  q.momLookbacks.forEach((lb, i) => {
    const r = roc(closes, lb);
    row.mom[`m${i === 0 ? '3m' : i === 1 ? '6m' : '12m'}`] = r[r.length - 1] === undefined ? null : r4(r[r.length - 1]);
  });
  const ms = momentumSeries(bars, { lookback: q.momLookbacks[1] || 126, volLen: 63 });
  row.score = r4(ms[ms.length - 1]);

  const vs = fieldSma(bars, 'volume', q.volShort)[bars.length - 1];
  const vl = fieldSma(bars, 'volume', q.volLong)[bars.length - 1];
  row.volRatio = (Number.isFinite(vs) && Number.isFinite(vl) && vl > 0) ? r4(vs / vl) : null;
  // 均线带：给 UI 一个"离多头排列还差多远"的连续量，而不是只有过/没过
  const m200 = sma(closes, 200)[closes.length - 1];
  row.spread200 = (m200 && last.close > 0) ? r4(last.close / m200 - 1) : null;
  return row;
}

/**
 * 扫一池。
 * 每个品种独立成行，失败的行保留 error 而不是消失 —— 用户勾了 12 个只看到 8 行，
 * 那 4 个是被跳过了还是根本没进表，必须一眼能分辨。
 */
export function scanUniverse(items, opts = {}) {
  const list = items || [];
  if (!list.length) return { rows: [], errors: [], note: '池子是空的：先在「自选池」里加品种' };
  const rows = list.map(it => scanSymbol(it, opts));
  const bad = rows.filter(r => r.error);
  const good = rows.filter(r => !r.error);
  return {
    rows, errors: bad.map(r => ({ symbol: r.symbol, error: r.error })),
    asOf: good.length ? good.map(r => r.lastDate).sort().pop() : null,
    note: `共 ${list.length} 个品种，${good.length} 个可判定，${bad.length} 个数据不足。`
      + '判据与「Minervini 趋势模板」策略同源，扫描器说符合的，策略里也应当找得到买点。'
  };
}

/** 过滤：只留模板成立 / 正在突破 / 接近新高 / ADX 达标。 */
export function filterRows(rows, f = {}) {
  const o = { templateOnly: false, breakoutOnly: false, nearHighPct: null, adxMin: null, minBars: 0, ...f };
  return (rows || []).filter(r => {
    if (r.error) return false;
    if (o.templateOnly && !(r.template && r.template.ok)) return false;
    if (o.breakoutOnly && !(r.breakout && r.breakout.broke && r.breakout.volOk)) return false;
    if (Number.isFinite(o.nearHighPct) && !(r.distHigh !== null && r.distHigh >= -Math.abs(o.nearHighPct))) return false;
    if (Number.isFinite(o.adxMin) && !(Number.isFinite(r.adx) && r.adx >= o.adxMin)) return false;
    if (r.bars < o.minBars) return false;
    return true;
  });
}

const getter = (key) => (r) => {
  if (key === 'passed') return r.template ? r.template.passed : null;
  if (key.startsWith('m') && key.endsWith('m')) return r.mom ? r.mom[key] : null;
  return r[key];
};

/** 排序：null 永远排在最后（数据缺失不该被当成"最小"或"最大"）。 */
export function sortRows(rows, key = 'score', dir = 'desc') {
  const get = getter(key);
  const sign = dir === 'asc' ? 1 : -1;
  return (rows || []).slice().sort((a, b) => {
    const x = get(a), y = get(b);
    const nx = x === null || x === undefined || Number.isNaN(x);
    const ny = y === null || y === undefined || Number.isNaN(y);
    if (nx && ny) return String(a.symbol).localeCompare(String(b.symbol));
    if (nx) return 1;
    if (ny) return -1;
    if (typeof x === 'string') return sign * String(x).localeCompare(String(y));
    return sign * (x - y) || String(a.symbol).localeCompare(String(b.symbol));
  });
}

/** 汇总表：这池里有多少个处于多头排列、多少个今天突破，用来给扫描一个"市场温度"。 */
export function scanSummary(rows) {
  const list = (rows || []).filter(r => !r.error);
  const cnt = (fn) => list.filter(fn).length;
  return {
    total: list.length,
    templateOk: cnt(r => r.template && r.template.ok),
    breakoutToday: cnt(r => r.breakout && r.breakout.broke && r.breakout.volOk),
    nearHigh: cnt(r => r.distHigh !== null && r.distHigh >= -0.05),
    strongAdx: cnt(r => Number.isFinite(r.adx) && r.adx >= 25),
    rising: cnt(r => Number.isFinite(r.mom && r.mom.m6m) && r.mom.m6m > 0),
    note: list.length
      ? (cnt(r => r.template && r.template.ok) / list.length > 0.5
        ? '池子过半品种处于多头排列 —— 趋势环境整体偏多，突破的胜率也更站得住。'
        : '多数品种还没进多头排列 —— 这时候的突破更可能是孤立行情，仓位别按"趋势确立"给。')
      : '没有可判定的品种。'
  };
}
