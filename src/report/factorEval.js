/**
 * 因子评估（Alphalens 同款口径，架构白皮书 §2.5 的研究端能力）：
 * IC / RankIC 时序、IC 衰减、分位数分层回测。
 *
 * 回测引擎回答"策略赚不赚钱"；因子评估回答更早的问题——"这个信号本身有没有预测力"。
 * 一个策略净值好看可能只是运气，而 IC 均值 0.05、ICIR > 0.5 的信号才是真正的原料。
 *
 * 口径（与 Alphalens 对齐的地方都注明了）：
 *   IC      —— 因子值与**未来 h 期收益**的截面 Pearson 相关
 *   RankIC  —— 截面 Spearman（单调变换不变，抗离群因子值）
 *   分层     —— 每期按因子排序切 Q 层，层内等权，每 h 期再平衡；多空 = 首层 − 末层
 *   行业/市值分层 IC —— 无免费行业分类历史数据，是已知边界，不做假实现
 */

/** 因子面板：barsList = [{symbol, bars}]，factorFn(bars, i) → 因子值（无效返回 null）。 */
export function buildFactorPanel(barsList, factorFn) {
  const symbols = (barsList || []).map(b => b.symbol);
  // 日期轴取所有序列的并集（升序）—— 停牌缺行的品种该日值为 null
  const dateSet = new Set();
  for (const { bars } of barsList || []) for (const b of bars || []) dateSet.add(b.date);
  const dates = [...dateSet].sort();
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const values = dates.map(() => symbols.map(() => null));
  const close = dates.map(() => symbols.map(() => null));
  (barsList || []).forEach(({ symbol, bars }, j) => {
    for (let i = 0; i < (bars || []).length; i++) {
      const t = dateIdx.get(bars[i].date);
      if (t === undefined) continue;
      const f = factorFn(bars, i);
      values[t][j] = Number.isFinite(f) ? f : null;
      close[t][j] = Number.isFinite(bars[i].close) ? bars[i].close : null;
    }
  });
  return { dates, symbols, values, close };
}

/** 前向收益矩阵：fwd[t][j] = close[t+h]/close[t] − 1；末 h 行为 null。 */
export function forwardReturns(close, horizon = 1) {
  const T = close.length, N = close[0]?.length ?? 0;
  const fwd = close.map(row => row.map(() => null));
  for (let t = 0; t + horizon < T; t++) {
    for (let j = 0; j < N; j++) {
      const c0 = close[t][j], c1 = close[t + horizon][j];
      if (Number.isFinite(c0) && Number.isFinite(c1) && c0 > 0) fwd[t][j] = c1 / c0 - 1;
    }
  }
  return fwd;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Spearman：先转名次（平均名次处理并列）再 Pearson。 */
function spearman(xs, ys) {
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  return pearson(rank(xs), rank(ys));
}

/**
 * IC 时序。每期要求至少 minNames 个"因子值与未来收益都存在"的品种，
 * 否则该期跳过并计数 —— 缺数据多的截面相关系数是噪声，掺进去只会稀释均值。
 */
export function icSeries(panel, { horizon = 1, method = 'rank', minNames = 4 } = {}) {
  const { dates, values, close } = panel;
  const fwd = forwardReturns(close, horizon);
  const corr = method === 'pearson' ? pearson : spearman;
  const out = [];
  let skipped = 0;
  for (let t = 0; t < dates.length; t++) {
    const f = [], r = [];
    for (let j = 0; j < values[t].length; j++) {
      if (Number.isFinite(values[t][j]) && Number.isFinite(fwd[t]?.[j])) { f.push(values[t][j]); r.push(fwd[t][j]); }
    }
    if (f.length < minNames) { skipped++; continue; }
    const ic = corr(f, r);
    if (ic !== null) out.push({ date: dates[t], ic, n: f.length });
    else skipped++;
  }
  return { series: out, skipped };
}

/** IC 统计：均值 / ICIR / t 值 / 正占比。ICIR > 0.5 且 t > 2 才值得往下走。 */
export function icStats(ics) {
  const xs = (ics.series || ics || []).map(x => (Number.isFinite(x.ic) ? x.ic : x)).filter(Number.isFinite);
  const n = xs.length;
  if (n < 3) return { n, mean: null, ir: null, tStat: null, positivePct: null, note: 'IC 样本不足' };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  return {
    n, mean, ir: sd > 0 ? mean / sd : null,
    tStat: sd > 0 ? mean / sd * Math.sqrt(n) : null,
    positivePct: xs.filter(v => v > 0).length / n,
    note: Math.abs(mean) < 0.02 ? 'IC 均值低于 0.02，基本没有预测力' : null
  };
}

/**
 * IC 衰减：h=1..horizons 的均值 IC。衰减曲线的形状告诉你这是"快信号"还是"慢信号"，
 * 也直接给出调仓频率的答案 —— IC 衰减到一半的周期就是再平衡的合理周期。
 */
export function icDecay(panel, { horizons = [1, 2, 3, 5, 10], method = 'rank' } = {}) {
  const out = [];
  for (const h of horizons) {
    const s = icSeries(panel, { horizon: h, method });
    out.push({ horizon: h, ...icStats(s), series: s.series });
  }
  return out;
}

/**
 * 分位数分层回测。每期按因子升序切 quantiles 层，层内等权，每 horizon 期再平衡。
 * 多空 = 最高层收益 − 最低层收益（研究口径，不含成本与容量）。
 * 返回每层的 NAV 序列与统计，以及多空曲线。
 */
export function layeredBacktest(panel, { quantiles = 5, horizon = 1, minNames = 4 } = {}) {
  const { dates, values, close } = panel;
  const fwd = forwardReturns(close, horizon);
  const Q = Math.max(2, Math.round(quantiles));
  const navs = Array.from({ length: Q }, () => [1]);
  const lsCurve = [0];                      // 多空累计（算术累加的研究口径）
  let usable = 0;
  for (let t = 0; t + horizon < dates.length; t += horizon) {
    // 该期有效截面
    const rows = [];
    for (let j = 0; j < values[t].length; j++) {
      if (Number.isFinite(values[t][j]) && Number.isFinite(fwd[t]?.[j])) rows.push({ j, f: values[t][j], r: fwd[t][j] });
    }
    if (rows.length < minNames) continue;
    usable++;
    rows.sort((a, b) => a.f - b.f);
    const per = Math.max(1, Math.floor(rows.length / Q));
    for (let q = 0; q < Q; q++) {
      const lo = q * per;
      const hi = q === Q - 1 ? rows.length : (q + 1) * per;   // 余数全塞进最高层
      const members = rows.slice(lo, hi);
      const layerRet = members.reduce((s, m) => s + m.r, 0) / members.length;
      navs[q].push(navs[q][navs[q].length - 1] * (1 + layerRet));
    }
    const top = rows.slice(rows.length - per).reduce((s, m) => s + m.r, 0) / per;
    const bot = rows.slice(0, per).reduce((s, m) => s + m.r, 0) / per;
    lsCurve.push(lsCurve[lsCurve.length - 1] + (top - bot));
  }
  if (usable < 3) return { usable: 0, note: '有效截面不足 3 期，分层回测没有意义' };
  const rets = (nav) => { const r = []; for (let i = 1; i < nav.length; i++) r.push(nav[i] / nav[i - 1] - 1); return r; };
  const sharpeOf = (r) => {
    if (r.length < 2) return null;
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, v) => a + (v - m) ** 2, 0) / (r.length - 1));
    return sd > 0 ? m / sd * Math.sqrt(252 / horizon) : null;
  };
  const layers = navs.map((nav, q) => ({
    q, nav,
    totalReturn: nav[nav.length - 1] - 1,
    sharpe: sharpeOf(rets(nav))
  }));
  const lsRets = [];
  for (let i = 1; i < lsCurve.length; i++) lsRets.push(lsCurve[i] - lsCurve[i - 1]);
  return {
    usable, quantiles: Q, horizon,
    layers,
    longShort: { curve: lsCurve, totalSpread: lsCurve[lsCurve.length - 1], sharpe: sharpeOf(lsRets) },
    monotonNote: null
  };
}

/** 便捷封装：一次给齐 IC/RankIC/衰减/分层的汇总报告。 */
export function factorReport(panel, { horizon = 1, quantiles = 5 } = {}) {
  const ic = icSeries(panel, { horizon, method: 'pearson' });
  const rankIc = icSeries(panel, { horizon, method: 'rank' });
  return {
    pearson: icStats(ic),
    rank: icStats(rankIc),
    decay: icDecay(panel, { horizons: [1, 2, 3, 5, 10] }).map(({ horizon: h, mean, ir }) => ({ horizon: h, meanIC: mean, ir })),
    layers: layeredBacktest(panel, { quantiles, horizon }),
    skippedCrossSections: ic.skipped
  };
}
