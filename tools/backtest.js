/**
 * 离线回测跑批：读 fixtures/ 真实数据，跑策略库，打印绩效。
 *   node tools/backtest.js                 全品种 × 全策略
 *   node tools/backtest.js --only rbm,600519
 *   node tools/backtest.js --strategy donchianBreak
 *   node tools/backtest.js --grid          跑参数网格，看参数敏感性
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BacktestEngine } from '../src/core/backtestEngine.js';
import { STRATEGIES, getStrategy } from '../src/strategy/library.js';
import { computeMetrics, benchmarkCompare, maxDrawdown } from '../src/report/metrics.js';
import { FUTURES_SPECS } from '../src/markets/contractSpecs.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(DIR, '..', 'fixtures');
const CAPITAL = 200000;

/** 主连代码 → 品种规格。 */
function specFor(symbol) {
  const v = String(symbol).toLowerCase().replace(/m$/, '').toUpperCase();
  const s = FUTURES_SPECS[v];
  if (s) return { ...s, marginRate: s.marginRate ?? 0.1 };
  // A股/ETF：1 手=100 股，无保证金，佣金万2.5 最低 5 元 + 卖出印花税
  return {
    multiplier: 100, tick: 0.01, marginRate: 1.0,
    fee: { mode: 'rate', value: 0.00025 }, closeTodayFee: { mode: 'rate', value: 0.00025 }
  };
}

function loadFixtures(filter) {
  const idx = JSON.parse(fs.readFileSync(path.join(FIX, 'index.json'), 'utf8'));
  return Object.entries(idx)
    .filter(([fn]) => !filter || filter.some(f => fn.includes(f)))
    .map(([fn, meta]) => ({
      fn, meta,
      bars: JSON.parse(fs.readFileSync(path.join(FIX, fn), 'utf8')).bars
    }));
}

function runOne(bars, spec, strat, params, opts = {}) {
  const signals = strat.signals(bars, params);
  const eng = new BacktestEngine(bars, spec, {
    capital: CAPITAL, lots: opts.lots ?? 1,
    slippageTicks: opts.slippageTicks ?? 1,
    allowShort: opts.allowShort ?? true,
    sizing: opts.sizing ?? 'notional', notionalPct: opts.notionalPct ?? 0.25
  });
  const out = eng.run(signals);
  const m = computeMetrics({ equityCurve: out.equityCurve, trades: out.trades, capital: CAPITAL, periodsPerYear: 252, bars });
  m.rejectedMargin = out.rejected.margin;
  return { ...out, metrics: m };
}

const pct = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v)) ? '--' : (v * 100).toFixed(d) + '%';
const num = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v)) ? '--' : v.toFixed(d);

function table(rows, cols, headers = cols) {
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map(r => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(headers));
  console.log('─'.repeat(widths.reduce((a, b) => a + b + 2, 0)));
  rows.forEach(r => console.log(line(r)));
}

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const flags = new Set(args.filter(a => a.startsWith('--') && !a.includes(' ')).map(a => a.replace(/^--/, '')));

const only = getArg('--only');
const filter = only ? only.split(',') : null;
const fixtures = loadFixtures(filter);
if (fixtures.length === 0) { console.error('fixtures 为空，先跑 python tools/fetch_fixtures.py'); process.exit(1); }

const strategies = getArg('--strategy') ? [getStrategy(getArg('--strategy'))].filter(Boolean) : STRATEGIES;

console.log(`\n真实数据回测：${fixtures.length} 个品种 × ${strategies.length} 个策略，` +
  `初始资金 ${CAPITAL.toLocaleString()}，1 手，滑点 1 tick，信号次根开盘成交\n`);

if (flags.has('grid')) {
  // 参数敏感性：同一策略在相邻参数上成绩差多少，差得越多越可能是过拟合
  const GRID = {
    maCross: [{ fast: 5, slow: 20 }, { fast: 10, slow: 30 }, { fast: 20, slow: 60 }, { fast: 50, slow: 200 }],
    donchianBreak: [{ entry: 10, exit: 5 }, { entry: 20, exit: 10 }, { entry: 55, exit: 20 }, { entry: 100, exit: 40 }],
    dualThrust: [{ k1: 0.3, k2: 0.3 }, { k1: 0.5, k2: 0.65 }, { k1: 0.7, k2: 0.7 }, { k1: 1.0, k2: 1.0 }],
    macdTrend: [{ fast: 8, slow: 17, signal: 6 }, { fast: 12, slow: 26, signal: 9 }, { fast: 19, slow: 39, signal: 9 }],
    hhLlStructure: [{ swingPct: 0.02 }, { swingPct: 0.04 }, { swingPct: 0.08 }],
    rsiReversion: [{ low: 20, high: 80 }, { low: 30, high: 70 }, { low: 40, high: 60 }]
  };
  for (const st of strategies) {
    console.log(`\n══ ${st.name} 参数敏感性（rbm/egm/mm/600519）══`);
    const rows = [];
    for (const p of GRID[st.id] || []) {
      for (const fx of fixtures.filter(f => ['rbm', 'egm', 'mm', '600519'].some(s => f.fn.includes('_' + s + '_')))) {
        const r = runOne(fx.bars, specFor(fx.meta.symbol), st, p);
        rows.push([JSON.stringify(p), fx.meta.name, pct(r.metrics.totalReturn), pct(r.metrics.annualReturn),
          pct(r.metrics.maxDDPct), num(r.metrics.sharpe), r.metrics.trades, pct(r.metrics.winRate)]);
      }
    }
    table(rows, [0, 1, 2, 3, 4, 5, 6, 7], ['参数', '品种', '总收益', '年化', '最大回撤', 'Sharpe', '笔数', '胜率']);
  }
  process.exit(0);
}

const summaryRows = [];
const detail = [];
for (const st of strategies) {
  for (const fx of fixtures) {
    const spec = specFor(fx.meta.symbol);
    let r;
    try { r = runOne(fx.bars, spec, st, {}); }
    catch (e) { detail.push({ strat: st.name, sym: fx.meta.name, error: e.message }); continue; }
    const m = r.metrics;
    const bench = { equity: fx.bars.map(b => ({ equity: b.close / fx.bars[0].open })) };
    const bhReturn = fx.bars[fx.bars.length - 1].close / fx.bars[0].open - 1;
    summaryRows.push([
      st.name, fx.meta.name, pct(m.totalReturn), pct(bhReturn), pct(m.totalReturn - bhReturn),
      pct(m.annualReturn), pct(m.maxDDPct), num(m.sharpe), num(m.calmar),
      m.trades, pct(m.winRate), num(m.profitFactor, 1), pct(m.exposure, 0), m.rejectedMargin
    ]);
    detail.push({ strat: st.id, stratName: st.name, sym: fx.meta.symbol, name: fx.meta.name, metrics: m, trades: r.trades.slice(0, 3) });
  }
}

table(summaryRows,
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  ['策略', '品种', '总收益', '持有涨幅', '超额', '年化', '最大回撤', 'Sharpe', 'Calmar', '笔数', '胜率', '盈亏比', '持仓占比', '资金不足拒单']);

if (flags.has('json')) {
  fs.writeFileSync(path.join(DIR, 'backtest_result.json'), JSON.stringify(detail, null, 1));
  console.log('\n明细已写 tools/backtest_result.json');
}

// 汇总：每个策略在多少品种上跑赢了买入持有
console.log('\n══ 策略横向汇总 ══');
const byStrat = {};
for (const row of summaryRows) {
  const s = row[0];
  byStrat[s] = byStrat[s] || { n: 0, beat: 0, pos: 0, sharpe: [], dd: [] };
  byStrat[s].n++;
  if (parseFloat(row[2]) > parseFloat(row[3])) byStrat[s].beat++;
  if (parseFloat(row[2]) > 0) byStrat[s].pos++;
  byStrat[s].sharpe.push(parseFloat(row[7]));
  byStrat[s].dd.push(parseFloat(row[6]));
}
table(Object.entries(byStrat).map(([s, v]) => [
  s, v.n, `${v.beat}/${v.n}`, `${v.pos}/${v.n}`,
  num(mean(v.sharpe)), num(Math.max(...v.dd)) + '%', num(Math.min(...v.dd)) + '%'
]), [0, 1, 2, 3, 4, 5, 6], ['策略', '品种数', '跑赢持有', '正收益', '平均Sharpe', '最大回撤(最差)', '最小回撤']);

function mean(xs) { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; }
