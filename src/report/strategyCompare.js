/**
 * 多策略横向对比。
 *
 * 只回答「同一段行情、同一套成本与手数，这几个策略谁更稳、彼此互补吗」。
 * 不回答「哪个策略的调优上限更高」—— 这里每个策略跑的都是自己的默认参数，
 * 调参是寻优那一页的事。把默认参数对比当成策略优劣结论，就是拿没调过的枪比射击。
 *
 * 返回的等权组合是「各策略日收益的等权平均」，不含撮合、保证金与交易约束，
 * 只用来观察策略之间的互补性；它不是可以照着下单的组合（那要走 PortfolioEngine）。
 *
 * 纯函数、不碰 DOM：可离线单测，也能搬进 Worker。
 */

import { getStrategy } from '../strategy/library.js';
import { runOne } from './optimizer.js';
import { buyHold } from '../core/backtestEngine.js';
import { computeMetrics } from './metrics.js';

export const MAX_COMPARE = 6;

/** 曲线配色：与图表 theme 的深色底兼容，最多 6 条。 */
export const COMPARE_COLORS = ['#60a5fa', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#facc15'];
export const BENCH_COLOR = '#848c9e';

const pct = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (v * 100).toFixed(d) + '%';
const num = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : Number(v).toFixed(d);

/** 日收益序列。第一根记 0（没有前值可比），组合从第二根开始复利。 */
export function dailyReturnsOf(equity) {
  return equity.map((v, i) => (i === 0 || !equity[i - 1]) ? 0 : v / equity[i - 1] - 1);
}

/** Pearson 相关系数。某条序列完全不动（策略从没开过仓）时无定义，返回 null 而不是 0。 */
export function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    cov += x * y; va += x * x; vb += y * y;
  }
  const den = Math.sqrt(va * vb);
  if (!(den > 0)) return null;
  // 浮点误差会让对角线出现 1.0000000000000002，夹回定义域
  return Math.max(-1, Math.min(1, cov / den));
}

/** 等权组合：每根 bar 把各策略日收益平均，再复利。返回权益数组（长度 = 对齐根数）。 */
export function equalWeightEquity(dailyReturns, capital) {
  if (!dailyReturns.length) return [];
  const n = Math.min(...dailyReturns.map(a => a.length));
  const out = new Array(n);
  out[0] = capital;
  for (let i = 1; i < n; i++) {
    const avg = dailyReturns.reduce((s, arr) => s + arr[i], 0) / dailyReturns.length;
    out[i] = out[i - 1] * (1 + avg);
  }
  return out;
}

/**
 * @param {object} p
 * @param {Array} p.bars 同一段 K 线（所有策略必须共用，才能比）
 * @param {object} p.spec 品种规格（合约乘数/tick/成本）
 * @param {Array<string|{id:string, params?:object}>} p.entries 策略 id 或 {id, params}
 * @param {object} p.engineOpts 资金/手数/滑点/规则，原样传给 BacktestEngine
 * @param {boolean} p.includeBenchmark 是否加入买入持有基准
 * @param {number} p.benchmarkLots 基准手数（默认 1）
 */
export function compareStrategies({
  bars, spec, entries, engineOpts = {}, periodsPerYear = 252,
  includeBenchmark = true, benchmarkLots = 1
}) {
  if (!Array.isArray(bars) || bars.length < 3) return { error: 'K 线不足：至少需要 3 根才能比较' };
  const list = (Array.isArray(entries) ? entries : [])
    .map(e => (typeof e === 'string' ? { id: e } : e))
    .filter(e => e && e.id);
  if (list.length < 2) return { error: '至少选两个策略才能对比' };
  if (list.length > MAX_COMPARE) return { error: `一次最多对比 ${MAX_COMPARE} 个策略` };
  if (!spec) return { error: '缺少品种规格，无法计算保证金与成本' };

  const seen = new Set();
  const picked = [];
  for (const e of list) {
    const strategy = getStrategy(e.id);
    if (!strategy) return { error: `未知策略：${e.id}` };
    if (seen.has(strategy.id)) return { error: `策略「${strategy.name}」被选了两次；重复对比只会得到两条一模一样的曲线` };
    seen.add(strategy.id);
    picked.push({ strategy, params: { ...strategy.params, ...(e.params || {}) } });
  }

  const n = bars.length;
  const runs = picked.map(({ strategy, params }) => {
    const r = runOne({ bars, spec, strategy, params, engineOpts, periodsPerYear });
    if (!r.equityCurve || r.equityCurve.length !== n) {
      throw new Error(`「${strategy.name}」的权益曲线长度与 K 线不一致，无法按同一时间轴对齐`);
    }
    const equity = r.equityCurve.map(p => p.equity);
    const capital = r.metrics.capital;
    return {
      id: strategy.id, name: strategy.name, params,
      metrics: r.metrics, trades: r.trades,
      equity, dailyReturns: dailyReturnsOf(equity),
      normalized: equity.map(v => v / capital * 100)
    };
  });

  const capital = runs[0].metrics.capital;
  const dates = bars.map(b => b.date);

  let benchmark = null;
  if (includeBenchmark) {
    const curve = buyHold(bars, spec, capital, benchmarkLots);
    const equity = curve.map(p => p.equity);
    const metrics = computeMetrics({ equityCurve: curve, trades: [], capital, periodsPerYear, bars });
    benchmark = {
      id: '__benchmark', name: `买入持有 ${benchmarkLots} 手`, metrics,
      equity, dailyReturns: dailyReturnsOf(equity),
      normalized: equity.map(v => v / capital * 100)
    };
  }

  const series = benchmark ? runs.concat([benchmark]) : runs.slice();
  const labels = series.map(s => s.name);
  const matrix = series.map(a => series.map(b => pearson(a.dailyReturns, b.dailyReturns)));

  const portfolioEquity = equalWeightEquity(runs.map(r => r.dailyReturns), capital);
  const portfolioCurve = portfolioEquity.map((equity, i) => ({ idx: i, date: dates[i], equity, inPosition: false }));
  const portfolioMetrics = computeMetrics({ equityCurve: portfolioCurve, trades: [], capital, periodsPerYear, bars });

  return {
    range: {
      from: String(dates[0]), to: String(dates[n - 1]), bars: n,
      capital, periodsPerYear, benchmarkLots
    },
    runs,
    benchmark,
    portfolio: {
      metrics: portfolioMetrics,
      equity: portfolioEquity,
      normalized: portfolioEquity.map(v => v / capital * 100),
      of: runs.length,
      note: '等权组合 = 各策略日收益的等权平均（每日再平衡），不含撮合、保证金与交易约束，只用于看互补性。'
    },
    correlation: { labels, matrix, hasBenchmark: !!benchmark }
  };
}

const csvCell = (v) => {
  const s = String(v === null || v === undefined ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** 对比结果 → CSV（指标表 + 相关性矩阵）。UI 只负责下载。 */
export function compareToCsv(result) {
  if (!result || result.error) return '';
  const { range, runs, benchmark, portfolio, correlation } = result;
  const lines = [
    `# 策略对比 · ${range.from} → ${range.to} · ${range.bars} 根 · 本金 ${range.capital}`,
    '策略,参数,期末权益,总收益,年化,最大回撤,Sharpe,Calmar,胜率,盈亏比,交易数,手续费'
  ];
  // stats=false：基准/组合没有成交，胜率与盈亏比不是「0」，而是无意义
  const row = (name, params, m, stats = true) => [
    csvCell(name), csvCell(params ? JSON.stringify(params) : ''), num(m.finalEquity, 0),
    pct(m.totalReturn), pct(m.annualReturn), pct(m.maxDDPct), num(m.sharpe, 2), num(m.calmar, 2),
    stats ? pct(m.winRate, 1) : '—', stats ? num(m.payoffRatio, 2) : '—', m.trades || '—', num(m.totalFees, 0)
  ].join(',');
  for (const r of runs) lines.push(row(r.name, r.params, r.metrics, r.metrics.trades > 0));
  if (benchmark) lines.push(row(benchmark.name, null, benchmark.metrics, false));
  lines.push(row(`等权组合（${portfolio.of} 个策略）`, null, portfolio.metrics, false));
  lines.push('', '# 日收益相关性（同一时间轴，首根不计）');
  lines.push(['', ...correlation.labels.map(csvCell)].join(','));
  correlation.labels.forEach((label, i) => {
    lines.push([csvCell(label), ...correlation.matrix[i].map(v => v === null ? '—' : v.toFixed(3))].join(','));
  });
  lines.push('', `# ${portfolio.note}`);
  return lines.join('\n');
}
