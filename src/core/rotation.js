/**
 * 动量轮动（Clenow / Antonacci 那一路）。
 *
 * 单品种信号函数表达不了"在整池里排第几"，所以这一层不假装能：
 * 它在日期轴上定期给全池排名，然后把结果写成**每个品种各自的信号序列**，
 * 撮合仍然交给 PortfolioEngine / BacktestEngine —— 一份成交逻辑，两种驱动。
 *
 * 排名用「风险调整后动量」（区间收益 / 区间波动），而不是裸涨幅：
 * 裸动量会把"每天涨停每天跌停"的品种排到前面，而实盘拿不住那种曲线。
 *
 * 时间轴约定：在第 R 个调仓日的**收盘后**排名，信号落在该日这根 bar 上，
 * 引擎在这根之后的下一根成交 —— 与全项目"信号在 i、成交在 i+1"一致，不偷看当天之后的行情。
 */

import { atr } from '../analysis/common.js';

const dayOf = (d) => String(d).slice(0, 10);

/** 每个 bar 上的动量分数：lookback 区间收益 ÷ 最近 volLen 区间的年化波动。拿不到数据给 null。 */
export function momentumSeries(bars, { lookback = 126, volLen = 63, periodsPerYear = 252 } = {}) {
  const n = (bars || []).length;
  const out = new Array(n).fill(null);
  if (n <= Math.max(lookback, volLen)) return out;
  const closes = bars.map(b => b.close);
  const rets = new Array(n).fill(null);
  for (let i = 1; i < n; i++) rets[i] = closes[i - 1] > 0 ? closes[i] / closes[i - 1] - 1 : null;
  for (let i = lookback; i < n; i++) {
    const base = closes[i - lookback];
    if (!(base > 0)) continue;
    const mom = closes[i] / base - 1;
    const from = Math.max(1, i - volLen + 1);
    const win = [];
    for (let k = from; k <= i; k++) if (Number.isFinite(rets[k])) win.push(rets[k]);
    if (win.length < Math.min(volLen, 20)) continue;          // 波动样本不足就不给分，别用半个样本冒充
    const mu = win.reduce((a, b) => a + b, 0) / win.length;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - mu) ** 2, 0) / (win.length - 1));
    const vol = sd * Math.sqrt(periodsPerYear);
    out[i] = vol > 0 ? mom / vol : null;
  }
  return out;
}

/** 裸动量（供报表显示"这段时间涨了多少"）。 */
export function rawMomentum(bars, lookback = 126) {
  const n = (bars || []).length;
  const out = new Array(n).fill(null);
  for (let i = lookback; i < n; i++) {
    const base = bars[i - lookback].close;
    if (base > 0) out[i] = bars[i].close / base - 1;
  }
  return out;
}

/**
 * 给一池品种排名。items 是 [{symbol, score, stale}]，score 为 null 的不参与。
 * 排名并列时按 symbol 字典序定 —— 并列就随机意味着同一份数据两次跑出不同组合。
 */
export function rankUniverse(items) {
  const usable = (items || []).filter(x => x && Number.isFinite(x.score));
  usable.sort((a, b) => (b.score - a.score) || String(a.symbol).localeCompare(String(b.symbol)));
  const skipped = (items || []).filter(x => x && !Number.isFinite(x.score)).map(x => x.symbol);
  return { ranked: usable, skipped };
}

/**
 * 生成每个品种的轮动信号。
 * @param {Array} entries [{symbol, bars, periodKey?}] —— bars 必须按日期升序
 * @param {Object} o {lookback, volLen, topK, rebalanceEvery, minHistory, longOnly, staleDays, periodsPerYear}
 * @returns {{signals:Array[], rebalances:Array[], calendar:string[], note:string}}
 *   signals[k] 与 entries[k].bars 等长，可直接喂给 PortfolioEngine。
 */
export function rotationSignals(entries, o = {}) {
  const opts = { lookback: 126, volLen: 63, topK: 2, rebalanceEvery: 21, minHistory: 0,
                 longOnly: true, staleDays: 7, periodsPerYear: 252, allowShortBottom: false, ...o };
  const list = (entries || []).filter(e => e && Array.isArray(e.bars) && e.bars.length > 2);
  if (!list.length) return { signals: [], rebalances: [], calendar: [], error: '没有可轮动的品种（每个品种至少 3 根 bar）' };

  const calendar = [...new Set(list.flatMap(e => e.bars.map(b => dayOf(b.date))))].sort();
  const perEntry = list.map(e => ({
    symbol: e.symbol,
    bars: e.bars,
    idxOf: new Map(e.bars.map((b, i) => [dayOf(b.date), i])),
    score: momentumSeries(e.bars, { lookback: opts.lookback, volLen: opts.volLen, periodsPerYear: opts.periodsPerYear }),
    mom: rawMomentum(e.bars, opts.lookback),
    atrValue: atr(e.bars, 14),
    signals: new Array(e.bars.length).fill(null)
  }));
  const warmup = Math.max(opts.lookback, opts.volLen) + 1;

  const rebalances = [];
  // 第一次调仓必须等到"分数算得出来"之后；nextRebalance 从那一刻起按周期推进。
  let nextRebalance = Math.max(warmup + 1, opts.minHistory > 0 ? opts.minHistory : 0);
  for (let d = 0; d < calendar.length; d++) {
    const date = calendar[d];
    if (d !== nextRebalance) continue;
    nextRebalance = d + opts.rebalanceEvery;

    const items = [];
    for (const pe of perEntry) {
      const k = pe.idxOf.get(date);
      if (k === undefined) { items.push({ symbol: pe.symbol, score: null, reason: '当日无 bar' }); continue; }
      // 分数必须来自"这一天或之前最近的一根"，且不能太久没更新：
      // 停牌三周的品种拿三周前的动量参与排名，等于用一个过期的名次占住一个仓位。
      let sk = k, stale = 0;
      while (sk > 0 && !Number.isFinite(pe.score[sk])) { sk--; stale++; }
      if (!Number.isFinite(pe.score[sk])) { items.push({ symbol: pe.symbol, score: null, reason: '历史不足' }); continue; }
      if (stale > opts.staleDays) { items.push({ symbol: pe.symbol, score: null, reason: `数据已 ${stale} 根未更新` }); continue; }
      items.push({ symbol: pe.symbol, score: pe.score[sk], mom: pe.mom[sk], idx: k, stale, refDate: dayOf(pe.bars[sk].date) });
    }
    const { ranked, skipped } = rankUniverse(items);
    const keep = ranked.slice(0, Math.max(1, opts.topK));
    const bottom = ranked.slice(-Math.max(1, opts.topK));
    const keepSet = new Set(keep.map(x => x.symbol));
    const bottomSet = opts.longOnly ? new Set() : new Set(bottom.map(x => x.symbol));
    for (const it of items) {
      const pe = perEntry.find(x => x.symbol === it.symbol);
      if (!pe || pe.idxOf.get(date) === undefined) continue;
      const k = pe.idxOf.get(date);
      const dir = keepSet.has(it.symbol) ? 1 : (bottomSet.has(it.symbol) && it.idx >= 0 ? -1 : 0);
      pe.signals[k] = { i: k, dir, reason: `轮调 ${date}：第${ranked.indexOf(it) + 1}名${Number.isFinite(it.score) ? `（分数 ${it.score.toFixed(2)}）` : ''}` };
    }
    rebalances.push({ date, ranked: ranked.map((x, i) => ({ rank: i + 1, symbol: x.symbol, score: Math.round(x.score * 1e4) / 1e4, mom: x.mom === undefined ? null : Math.round(x.mom * 1e4) / 1e4, refDate: x.refDate, held: keepSet.has(x.symbol) })),
                      kept: keep.map(x => x.symbol), skipped });
  }

  return {
    signals: perEntry.map(x => x.signals),
    symbols: perEntry.map(x => x.symbol),
    rebalances, calendar,
    meta: { lookback: opts.lookback, volLen: opts.volLen, topK: opts.topK, rebalanceEvery: opts.rebalanceEvery, longOnly: opts.longOnly, warmup },
    note: `排名口径：${opts.lookback} 根区间收益 ÷ ${opts.volLen} 根年化波动（风险调整后动量），每 ${opts.rebalanceEvery} 个交易日调一次，持有前 ${opts.topK} 名。`
      + (opts.longOnly ? ' 只做多：跌出前 K 名就平掉，不反手做空。' : ' 多退空补：前 K 名做多、末 K 名做空。')
      + ' 信号落在调仓日那根 bar，成交在其下一根 —— 不含未来信息。'
  };
}

/**
 * 轮动池的当前快照（给扫描器用）：最近一次调仓的名次、哪些被留在池里、还有几天再调。
 */
export function rotationSnapshot(rotation, { atDay = null } = {}) {
  const rb = (rotation.rebalances || []);
  const list = atDay ? rb.filter(x => x.date <= atDay) : rb;
  const last = list[list.length - 1] || null;
  if (!last) return { date: null, rows: [], kept: [], skipped: [], daysToNext: null, note: '还没有调仓记录（数据太短或暖机未完成）' };
  const idx = rotation.calendar.indexOf(last.date);
  const nextDate = rotation.calendar[idx + (rotation.meta?.rebalanceEvery || 21)];
  return {
    date: last.date,
    rows: last.ranked,
    kept: last.kept,
    skipped: last.skipped || [],
    daysToNext: nextDate ? rotation.calendar.indexOf(nextDate) - idx : null,
    note: rotation.note
  };
}
