import { test, assert } from './harness.js';
import { compareStrategies, compareToCsv, equalWeightEquity, dailyReturnsOf, pearson, MAX_COMPARE } from '../src/report/strategyCompare.js';
import { runOne } from '../src/report/optimizer.js';
import { getStrategy } from '../src/strategy/library.js';
import { buyHold } from '../src/core/backtestEngine.js';

const SPEC = { multiplier: 10, tick: 1, marginRate: 0.1, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 } };

/** 300 根确定性的趋势 + 回调数据：不依赖 fixtures，任何机器跑出的结果都一样。 */
function makeBars(n = 300) {
  const bars = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 18) >= 0 ? 0.9 : -0.55;
    const open = price;
    const close = Math.max(5, price + drift + Math.sin(i * 1.7) * 0.25);
    const high = Math.max(open, close) + 0.35;
    const low = Math.min(open, close) - 0.35;
    const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000);
    bars.push({ date: d.toISOString().slice(0, 10), open, high, low, close, volume: 1000 + (i % 7) * 120 });
    price = close;
  }
  return bars;
}

const BARS = makeBars();
const OPTS = { capital: 200000, lots: 1, slippageTicks: 1, allowShort: true };
const IDS = ['maCross', 'donchianBreak', 'macdTrend'];

test('策略对比：每个策略与单独 runOne 跑出的结果逐项一致', () => {
  const r = compareStrategies({ bars: BARS, spec: SPEC, entries: IDS, engineOpts: OPTS });
  assert.ok(!r.error, r.error);
  assert.eq(r.runs.length, 3);
  for (let k = 0; k < r.runs.length; k++) {
    const st = getStrategy(IDS[k]);
    const solo = runOne({ bars: BARS, spec: SPEC, strategy: st, params: { ...st.params }, engineOpts: OPTS });
    const row = r.runs[k];
    assert.eq(row.trades.length, solo.trades.length, `${st.name} 交易数`);
    assert.near(row.metrics.finalEquity, solo.metrics.finalEquity, 1e-6, `${st.name} 期末权益`);
    assert.near(row.metrics.sharpe, solo.metrics.sharpe, 1e-9, `${st.name} Sharpe`);
    assert.eq(row.equity.length, BARS.length, `${st.name} 权益曲线长度`);
    assert.near(row.normalized[0], 100, 1e-9, `${st.name} 归一化起点`);
  }
});

test('策略对比：参数覆盖真的进了引擎（不是只改了标签）', () => {
  const r = compareStrategies({
    bars: BARS, spec: SPEC,
    entries: [{ id: 'maCross', params: { fast: 5, slow: 25 } }, 'donchianBreak'],
    engineOpts: OPTS
  });
  assert.ok(!r.error, r.error);
  const st = getStrategy('maCross');
  const solo = runOne({ bars: BARS, spec: SPEC, strategy: st, params: { ...st.params, fast: 5, slow: 25 }, engineOpts: OPTS });
  assert.near(r.runs[0].metrics.finalEquity, solo.metrics.finalEquity, 1e-6);
  assert.eq(r.runs[0].params.fast, 5);
  assert.eq(r.runs[0].params.slow, 25);
});

test('相关性矩阵：对称、对角线为 1 或 null、值域 [-1,1]', () => {
  const r = compareStrategies({ bars: BARS, spec: SPEC, entries: IDS, engineOpts: OPTS });
  const { labels, matrix, hasBenchmark } = r.correlation;
  assert.eq(hasBenchmark, true);
  assert.eq(labels.length, 4);
  for (let i = 0; i < labels.length; i++) {
    for (let j = 0; j < labels.length; j++) {
      const v = matrix[i][j];
      if (v === null) continue;
      assert.ok(v >= -1 && v <= 1, `相关系数越界：${v}`);
    }
    if (matrix[i][i] !== null) assert.near(matrix[i][i], 1, 1e-12, `对角线 ${labels[i]}`);
    for (let j = 0; j < labels.length; j++) {
      if (matrix[i][j] === null) assert.eq(matrix[j][i], null, '一侧为 null，对称位置也应为 null');
      else assert.near(matrix[i][j], matrix[j][i], 1e-12, `对称性 ${labels[i]}×${labels[j]}`);
    }
  }
});

test('相关性：完全同向的两条收益序列 = 1，反向 = -1，不动的序列给 null', () => {
  const a = [0, 0.01, -0.02, 0.03, 0.005];
  assert.near(pearson(a, a.map(x => x * 2)), 1, 1e-12);
  assert.near(pearson(a, a.map(x => -x)), -1, 1e-12);
  assert.eq(pearson(a, [0, 0, 0, 0, 0]), null);
  assert.eq(pearson([0, 0.01], [0, 0.02]), null, '样本不足 3 个点不硬算');
});

test('等权组合：可以按「日收益平均 → 复利」手工复算', () => {
  const r = compareStrategies({ bars: BARS, spec: SPEC, entries: IDS, engineOpts: OPTS });
  const rets = r.runs.map(x => dailyReturnsOf(x.equity));
  const manual = equalWeightEquity(rets, r.range.capital);
  assert.eq(manual.length, BARS.length);
  for (let i = 0; i < manual.length; i++) {
    assert.near(r.portfolio.equity[i], manual[i], 1e-9, `第 ${i} 根组合权益`);
  }
  assert.near(r.portfolio.equity[0], r.range.capital, 1e-9);
  assert.eq(r.portfolio.of, 3);
});

test('买入持有基准：与 buyHold 的末值一致，且进入相关性矩阵', () => {
  const r = compareStrategies({ bars: BARS, spec: SPEC, entries: IDS, engineOpts: OPTS, benchmarkLots: 2 });
  const bench = r.benchmark;
  assert.ok(bench, '应带基准');
  const manual = buyHold(BARS, SPEC, r.range.capital, 2);
  assert.near(bench.equity[bench.equity.length - 1], manual[manual.length - 1].equity, 1e-9);
  assert.near(bench.metrics.finalEquity, r.range.capital + (BARS[BARS.length - 1].close - BARS[0].open) * SPEC.multiplier * 2, 1e-6);
  assert.ok(r.correlation.labels.includes(bench.name));
});

test('策略对比：不足两个、重复、未知策略、超过上限都明确拒绝', () => {
  const one = compareStrategies({ bars: BARS, spec: SPEC, entries: ['maCross'], engineOpts: OPTS });
  assert.ok(one.error && one.error.includes('至少'), '一个策略应拒绝');
  const dup = compareStrategies({ bars: BARS, spec: SPEC, entries: ['maCross', 'maCross'], engineOpts: OPTS });
  assert.ok(dup.error && dup.error.includes('两次'), '重复策略应拒绝');
  const unknown = compareStrategies({ bars: BARS, spec: SPEC, entries: ['maCross', 'noSuchStrategy'], engineOpts: OPTS });
  assert.ok(unknown.error && unknown.error.includes('未知策略'), '未知策略应拒绝');
  const many = compareStrategies({
    bars: BARS, spec: SPEC,
    entries: ['maCross', 'donchianBreak', 'macdTrend', 'dualThrust', 'hhLlStructure', 'rsiReversion', 'minerviniTemplate'],
    engineOpts: OPTS
  });
  assert.ok(many.error && many.error.includes(String(MAX_COMPARE)), '超过上限应拒绝');
  const short = compareStrategies({ bars: BARS.slice(0, 2), spec: SPEC, entries: ['maCross', 'donchianBreak'], engineOpts: OPTS });
  assert.ok(short.error && short.error.includes('K 线不足'), 'K线不足应拒绝');
});

test('策略对比：同参数跑两次，权益曲线逐字节一致（确定性）', () => {
  const a = compareStrategies({ bars: BARS, spec: SPEC, entries: IDS, engineOpts: OPTS });
  const b = compareStrategies({ bars: BARS, spec: SPEC, entries: IDS, engineOpts: OPTS });
  assert.eq(JSON.stringify(a.runs.map(x => x.equity)), JSON.stringify(b.runs.map(x => x.equity)));
  assert.eq(JSON.stringify(a.correlation.matrix), JSON.stringify(b.correlation.matrix));
});

test('CSV：含指标表与相关性矩阵，参数里的逗号与引号被正确转义', () => {
  const r = compareStrategies({ bars: BARS, spec: SPEC, entries: IDS, engineOpts: OPTS });
  const csv = compareToCsv(r);
  assert.ok(csv.includes('策略,参数,期末权益'), '缺指标表头');
  assert.ok(csv.includes('双均线交叉'));
  assert.ok(csv.includes('日收益相关性'));
  assert.ok(csv.includes('""fast""'), '参数 JSON 的双引号应被双写转义');
  assert.ok(csv.includes('等权组合'));
  assert.eq(compareToCsv({ error: 'x' }), '', '失败结果不导出空壳');
});
