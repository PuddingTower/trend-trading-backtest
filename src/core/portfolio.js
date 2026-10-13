/**
 * 组合多品种回测（计划 M5）。
 *
 * 每个品种跑各自的规则与成本（A股 T+1/印花税 与 期货平今仓/乘数 完全不同），
 * 再把权益按**日期**对齐合并 —— 不是按 bar 下标对齐：不同品种的停牌日、夜盘品种
 * 与日盘品种的自然日差异会让下标错位，按日期对齐才安全。
 *
 * 局限（必须写清楚，不然使用者会以为这是真实组合账本）：
 *   各品种拿到的是自己那一份资金，**不共享保证金池**，也没有跨品种的逐日盯市互抵。
 *   这里做的是「资金按比例分仓 + 总保证金占用上限」的近似，
 *   真实组合需要一个统一账本在多笔持仓间分配可用资金，那是另一件事。
 */

import { runOne } from '../report/optimizer.js';
import { computeMetrics } from '../report/metrics.js';

/** 品种自身的收益波动，用来做逆波动率加权。 */
export function seriesVolatility(bars, periodsPerYear = 252) {
  if (!bars || bars.length < 3) return null;
  const rets = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].close > 0) rets.push(bars[i].close / bars[i - 1].close - 1);
  }
  if (rets.length < 2) return null;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, x) => a + (x - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v * periodsPerYear);
}

/**
 * 资金分配。
 *   equal      —— 等权
 *   inverseVol —— 逆波动率加权（风险平价的一阶近似）：波动大的品种少给钱
 *   manual     —— 用 entry.weight 指定的比例
 * 逆波动率归一化后，单品种权重仍可能极大（只有一只品种时=100%），所以调用方要配上限。
 */
export function allocateWeights(entries, mode = 'equal', periodsPerYear = 252) {
  const list = entries || [];
  if (!list.length) return [];
  if (mode === 'manual') {
    const sum = list.reduce((s, e) => s + (Number(e.weight) || 0), 0);
    if (sum <= 0) return list.map(e => ({ ...e, weight: 1 / list.length }));
    return list.map(e => ({ ...e, weight: (Number(e.weight) || 0) / sum }));
  }
  if (mode === 'inverseVol') {
    const vols = list.map(e => {
      const v = seriesVolatility(e.bars, periodsPerYear);
      return v && Number.isFinite(v) && v > 0 ? v : null;
    });
    const inv = vols.map(v => (v === null ? 0 : 1 / v));
    const sum = inv.reduce((a, b) => a + b, 0);
    if (sum <= 0) return list.map(e => ({ ...e, weight: 1 / list.length }));
    return list.map((e, i) => ({ ...e, weight: inv[i] / sum, vol: vols[i] }));
  }
  return list.map(e => ({ ...e, weight: 1 / list.length }));
}

/**
 * 跑组合。
 * @param {Array} entries [{symbol,name,bars,spec,rules,strategy,params,engineOpts,weight}]
 * @param {number} capital 总资金
 * @param {string} weights equal | inverseVol | manual
 * @param {number} maxMarginPct 合并保证金占用上限（0~1）。超限时**整体等比缩仓**再重跑，
 *        并把实际缩放比例回报出去 —— 静默超限等于给出一个开不出来的组合。
 */
export function runPortfolio({ entries, capital = 1000000, weights = 'equal', maxMarginPct = null,
                               periodsPerYear = 252, objectiveParams = {} }) {
  const valid = (entries || []).filter(e => e && Array.isArray(e.bars) && e.bars.length > 2 && e.strategy);
  if (!valid.length) return { error: '没有可用品种（每个品种都需要 >2 根 bar 和一个策略）' };

  const allocated = allocateWeights(valid, weights, periodsPerYear);

  // scale 只作用在「仓位相对资金的规模」上：lots 或 notionalPct。
  // 曾经连资金一起等比缩 —— 那等于没缩：保证金 = 价×乘数×保证金率×手数，
  // 分子分母同时乘 scale，占用比例一动不动。
  const runOnce = (alloc, scale) => alloc.map(a => {
    const cap = Math.max(1000, capital * a.weight);
    // capital 必须放在展开的最后：品种自带的 engineOpts 里往往也有 capital（面板的默认值），
    // 放在前面会被它覆盖掉 —— 结果是「按权重分仓」只是表面功夫，各品种实际跑在自己的资金上，
    // 而合并曲线又把闲置资金按分配额计入，两条口径混在一条曲线上，末值和总收益全是错的。
    const opts = { ...objectiveParams, ...(a.engineOpts || {}), capital: cap };
    if (scale < 1) {
      if (Number.isFinite(Number(opts.lots)) && Number(opts.lots) > 0) {
        opts.lots = Math.max(1, Math.floor(Number(opts.lots) * scale));
      }
      if (Number.isFinite(Number(opts.notionalPct)) && Number(opts.notionalPct) > 0) {
        opts.notionalPct = Math.max(0.001, Number(opts.notionalPct) * scale);
      }
    }
    const r = runOne({
      bars: a.bars, spec: a.spec, strategy: a.strategy, params: a.params,
      engineOpts: opts,
      periodsPerYear: a.periodsPerYear || periodsPerYear
    });
    return { ...a, scale, allocCapital: cap, ...r };
  });

  let runs = runOnce(allocated, 1);
  let combined = combineEquity(runs);
  let peakMarginRatio = peakRatio(combined);
  let appliedScale = 1, lotScale = 1;
  // 迭代到满足为止：手数是整数、手续费有最低额，占用比例对 scale 不是严格线性。
  for (let guard = 0; guard < 8 && maxMarginPct && maxMarginPct > 0 && peakMarginRatio > maxMarginPct; guard++) {
    const next = Math.max(0.01, lotScale * (maxMarginPct / peakMarginRatio) * 0.99);
    if (next >= lotScale) break;
    lotScale = next;
    const candidate = runOnce(allocated, lotScale);
    const candCombined = combineEquity(candidate);
    const r = peakRatio(candCombined);
    if (r >= peakMarginRatio) break;            // 整数手数的台阶：再缩反而更高，停在上一档
    runs = candidate;
    combined = candCombined;
    appliedScale = lotScale;
    peakMarginRatio = r;
  }

  const metrics = computeMetrics({
    equityCurve: combined, trades: runs.flatMap(r => r.trades),
    capital, periodsPerYear, bars: null
  });

  return {
    allocation: runs.map(r => ({ symbol: r.symbol, name: r.name, weight: r.weight, vol: r.vol,
                                 capital: r.allocCapital, trades: r.trades.length,
                                 netPnL: r.metrics.finalEquity - r.metrics.capital,
                                 sharpe: r.metrics.sharpe, maxDDPct: r.metrics.maxDDPct, ruined: r.metrics.ruined })),
    perSymbol: runs.map(r => ({ symbol: r.symbol, name: r.name, metrics: r.metrics, equityCurve: r.equityCurve, trades: r.trades })),
    combinedEquity: combined,
    metrics,
    exposure: { peakMarginRatio, maxMarginPct: maxMarginPct ?? null, appliedScale, scaledDown: appliedScale < 1 },
    note: '各品种分仓独立核算，不共享保证金池、无跨品种盯市互抵（见文件头「局限」）。'
  };
}

/**
 * 合并权益：按日期取并集，**逐品种向前填充**。
 *
 * 这里原来直接累加"该日期存在的点"，于是任何一个品种当天没有 bar（上市晚、停牌、
 * 夜盘与日盘的日期差异、末尾几天只有一边有数据）就贡献 0 —— 组合权益会突然塌掉一块。
 * 实测四品种组合因此报出 -81%，而按正确口径算是 +6%。这类错不会报错，只会让报表难看，
 * 是最难被发现的那一种。
 *
 * 规则：
 *   - 日期早于品种第一个 bar → 贡献它的分仓资金（这笔钱当时就是闲着的）
 *   - 日期落在品种曲线中间但没有 bar → 沿用上一日权益（停牌就是没成交，权益不动）
 */
function combineEquity(runs) {
  const allDates = new Set();
  for (const r of runs) for (const p of r.equityCurve) allDates.add(String(p.date).slice(0, 10));
  const dates = [...allDates].sort();

  const series = runs.map(r => {
    const map = new Map();
    for (const p of r.equityCurve) map.set(String(p.date).slice(0, 10), p);
    return { map, firstDate: dates.find(d => map.has(d)) || null, last: null, idle: r.allocCapital };
  });

  const out = [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    let equity = 0, margin = 0, inPosition = false;
    for (const s of series) {
      const p = s.map.get(d);
      if (p) s.last = p;
      const use = p || s.last;
      if (!use || (s.firstDate && d < s.firstDate)) { equity += s.idle; continue; }
      equity += use.equity;
      margin += use.margin || 0;
      if (use.inPosition) inPosition = true;
    }
    out.push({ idx: i, date: d, equity, margin, inPosition });
  }
  return out;
}

/** 峰值保证金占用 = 合并曲线上 max(保证金合计 / 合并权益)。 */
function peakRatio(combined) {
  let peak = 0;
  for (const p of combined) if (p.equity > 0) peak = Math.max(peak, (p.margin || 0) / p.equity);
  return peak;
}
