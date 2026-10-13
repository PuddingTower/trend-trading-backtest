/**
 * 绩效指标。全部为纯函数，便于与 numpy 手算基线对账。
 *
 * 年化口径写死成参数 periodsPerYear（日线 252、周线 52、60分钟约 1000），
 * 不随数据频率自动猜 —— 猜错会让 Sharpe 差一个数量级，而数字看起来很正常。
 */

export function maxDrawdown(equity) {
  let peak = equity.length ? equity[0] : 0;
  let maxDD = 0, maxDDPct = 0;
  let ddStart = null, ddEnd = null, curStart = 0;
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) { peak = equity[i]; curStart = i; }
    const dd = peak - equity[i];
    const ddPct = peak > 0 ? dd / peak : 0;
    if (dd > maxDD) { maxDD = dd; maxDDPct = ddPct; ddStart = curStart; ddEnd = i; }
  }
  return { maxDD, maxDDPct, ddStart, ddEnd };
}

export function dailyReturns(equity) {
  const out = [];
  for (let i = 1; i < equity.length; i++) {
    out.push(equity[i - 1] !== 0 ? equity[i] / equity[i - 1] - 1 : 0);
  }
  return out;
}

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

export function computeMetrics({ equityCurve, trades, capital, periodsPerYear = 252, bars }) {
  const equity = equityCurve.map(p => p.equity);
  if (equity.length < 2) return { error: '权益序列过短' };
  const rets = dailyReturns(equity);
  const { maxDD, maxDDPct, ddStart, ddEnd } = maxDrawdown(equity);

  const totalReturn = equity[equity.length - 1] / capital - 1;
  // 权益被亏成非正数时，年化与 Sharpe 在数学上已无意义（负数开分数次幂 = NaN）。
  // 明确标 ruined 并把它们置 null，而不是让 '--' 冒充"业绩很差"—— 亏光是另一回事。
  const ruined = equity.some(v => v <= 0) || equity[equity.length - 1] <= 0;
  const years = rets.length / periodsPerYear;
  const annualReturn = ruined || years <= 0 ? null : Math.pow(equity[equity.length - 1] / capital, 1 / years) - 1;
  const vol = stdev(rets) * Math.sqrt(periodsPerYear);
  const downside = rets.filter(r => r < 0);
  const dvol = stdev(downside) * Math.sqrt(periodsPerYear);

  const wins = trades.filter(t => t.netPnL > 0);
  const losses = trades.filter(t => t.netPnL <= 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnL, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnL, 0));
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const winRate = trades.length ? wins.length / trades.length : 0;
  const exposure = equityCurve.filter(p => p.inPosition).length / equityCurve.length;

  const perTrade = trades.map(t => t.netPnL / capital);
  const expectancy = mean(perTrade);
  // annualReturn 为 null 时不能让它被隐式转成 0（null/x === 0），否则爆仓 run 会显示 Sharpe 0 像"业绩平庸"
  const sharpe = annualReturn === null ? null : (vol > 0 ? annualReturn / vol : 0);
  const sortino = annualReturn === null ? null : (dvol > 0 ? annualReturn / dvol : 0);
  const calmar = annualReturn === null ? null : (maxDDPct > 0 ? annualReturn / maxDDPct : 0);

  const byReason = {};
  for (const t of trades) {
    const k = `${t.entryReason}→${t.exitReason}`;
    byReason[k] = byReason[k] || { n: 0, pnl: 0 };
    byReason[k].n++; byReason[k].pnl += t.netPnL;
  }

  // 分年度：把趋势策略“只在某一年赚钱”这种情况暴露出来
  const byYear = {};
  if (bars) {
    for (let i = 1; i < equity.length; i++) {
      const y = String(bars[i].date).slice(0, 4);
      byYear[y] = byYear[y] || { start: equity[i - 1], end: equity[i] };
      byYear[y].end = equity[i];
    }
    for (const y of Object.keys(byYear)) {
      const v = byYear[y];
      v.ret = v.start ? v.end / v.start - 1 : 0;
    }
  }

  return {
    capital, finalEquity: equity[equity.length - 1],
    ruined,
    totalReturn, annualReturn, volatility: vol,
    sharpe, sortino, calmar,
    maxDD, maxDDPct, ddRange: ddStart !== null ? [ddStart, ddEnd] : null,
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate, profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    avgWin, avgLoss, payoffRatio: avgLoss > 0 ? avgWin / avgLoss : 0,
    expectancy, exposure,
    avgHoldingBars: trades.length ? trades.reduce((s, t) => s + t.holdingBars, 0) / trades.length : 0,
    bestTrade: trades.length ? Math.max(...trades.map(t => t.netPnL)) : 0,
    worstTrade: trades.length ? Math.min(...trades.map(t => t.netPnL)) : 0,
    totalFees: trades.reduce((s, t) => s + t.fee, 0),
    byReason, byYear,
    rejectedMargin: null
  };
}

/** 基准对比：策略 vs 买入持有。 */
export function benchmarkCompare(strategyEquity, benchEquity, capital) {
  const s = strategyEquity[strategyEquity.length - 1] / capital - 1;
  const b = benchEquity[benchEquity.length - 1] / capital - 1;
  const sDD = maxDrawdown(strategyEquity).maxDDPct;
  const bDD = maxDrawdown(benchEquity).maxDDPct;
  return { strategyReturn: s, benchReturn: b, alpha: s - b, strategyMaxDD: sDD, benchMaxDD: bDD };
}
