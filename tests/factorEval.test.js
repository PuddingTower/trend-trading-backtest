import { test, assert } from './harness.js';
import {
  buildFactorPanel, forwardReturns, icSeries, icStats, icDecay, layeredBacktest, factorReport
} from '../src/report/factorEval.js';
import { makeRng } from '../src/core/rng.js';

/** 构造一个"因子就是真理"的世界：6 个品种，因子值固定为 j，未来收益 = 0.01×因子 + 噪声。 */
function truthWorld({ n = 6, days = 80, noise = 0, seed = 7, transform = null } = {}) {
  const rng = makeRng(seed);
  const barsList = [];
  for (let j = 0; j < n; j++) {
    const bars = [];
    let p = 100;
    for (let t = 0; t < days; t++) {
      const ret = 0.01 * j / n + (noise ? (rng() - 0.5) * noise : 0);
      p *= 1 + ret;
      bars.push({ date: `d${String(t).padStart(3, '0')}`, close: p });
    }
    barsList.push({ symbol: `S${j}`, bars });
  }
  const factorFn = (bars, i) => {
    const j = Number(bars[0] && 0) || 0;   // 占位：下面用 symbol 侧信息
    void j;
    return bars._factor;
  };
  // 直接把因子写进 bars：_factor 字段随品种固定
  barsList.forEach((b, j) => { b.bars.forEach(bar => { bar._factor = transform ? transform(j) : j; }); });
  const fn = (bars, i) => bars[i]._factor;
  return { barsList, factorFn: fn };
}

test('buildFactorPanel：对齐与缺值', () => {
  const { barsList, factorFn } = truthWorld({ days: 10 });
  barsList[1].bars = barsList[1].bars.slice(3);        // S1 缺前 3 天
  const panel = buildFactorPanel(barsList, factorFn);
  assert.eq(panel.dates.length, 10);
  assert.eq(panel.symbols.length, 6);
  assert.eq(panel.values[0][1], null, 'S1 缺的日子因子值为 null');
  assert.eq(panel.values[3][1], 1);
  assert.eq(panel.close[0][0], 100);
});

test('forwardReturns：h 期收益与末尾 null', () => {
  const close = [[100, 200], [101, 198], [103, 210], [102, 205]];
  const fwd = forwardReturns(close, 2);
  assert.near(fwd[0][0], 103 / 100 - 1, 1e-12);
  assert.near(fwd[0][1], 210 / 200 - 1, 1e-12);
  assert.near(fwd[1][0], 102 / 101 - 1, 1e-12, 'T=4、h=2 时 t=1 仍有完整前窗');
  assert.eq(fwd[2][0], null, 't+h 越界的行必须为 null');
  assert.eq(fwd[3][0], null);
});

test('完美信号：IC=1、RankIC=1、分层单调、多空为正', () => {
  const { barsList, factorFn } = truthWorld({ n: 6, days: 40, noise: 0 });
  const panel = buildFactorPanel(barsList, factorFn);
  const ic = icStats(icSeries(panel, { horizon: 1, method: 'pearson' }));
  const ric = icStats(icSeries(panel, { horizon: 1, method: 'rank' }));
  assert.ok(ic.mean !== null && Math.abs(ic.mean - 1) < 1e-9, `无噪声时 IC 应为 1，实际 ${ic.mean}`);
  assert.ok(Math.abs(ric.mean - 1) < 1e-9);
  assert.eq(ic.positivePct, 1);

  const lb = layeredBacktest(panel, { quantiles: 2, horizon: 1 });
  assert.ok(lb.usable >= 3);
  assert.ok(lb.layers[1].totalReturn > lb.layers[0].totalReturn, '高层收益必须高于低层');
  assert.ok(lb.longShort.totalSpread > 0);
  // 手算第一层首期收益：截面 6 个，Q=2 → 每层 3 个；低层 = j=0,1,2 的均值收益
  const expectLow = (0 + 0.01 / 6 + 0.02 / 6) / 3;   // ret = 0.01×j/n, n=6
  assert.near(lb.layers[0].nav[1], 1 + expectLow, 1e-9);
});

test('反向信号：IC≈−1，分层反转', () => {
  const { barsList, factorFn } = truthWorld({ n: 6, days: 40, noise: 0, transform: (j) => -j });
  const panel = buildFactorPanel(barsList, factorFn);
  const ic = icStats(icSeries(panel, { horizon: 1, method: 'pearson' }));
  assert.ok(ic.mean < -0.999);
  const lb = layeredBacktest(panel, { quantiles: 2, horizon: 1 });
  assert.ok(lb.layers[1].totalReturn < lb.layers[0].totalReturn, '因子反向时层级收益必须反转');
});

test('RankIC 对单调变换不变，Pearson 不然', () => {
  const { barsList, factorFn } = truthWorld({ n: 8, days: 60, noise: 0.004, seed: 11 });
  const panelA = buildFactorPanel(barsList, factorFn);
  const panelB = buildFactorPanel(barsList, (bars, i) => Math.exp(bars[i]._factor) * 1000 + 7);
  const ra = icStats(icSeries(panelA, { horizon: 1, method: 'rank' }));
  const rb = icStats(icSeries(panelB, { horizon: 1, method: 'rank' }));
  assert.near(ra.mean, rb.mean, 1e-9, 'RankIC 是名次相关，单调变换必须不变');
  const pa = icStats(icSeries(panelA, { horizon: 1, method: 'pearson' }));
  const pb = icStats(icSeries(panelB, { horizon: 1, method: 'pearson' }));
  assert.ok(Math.abs(pa.mean - pb.mean) > 1e-6, 'Pearson IC 会被指数变换改变');
});

test('IC 衰减：AR 信号的 IC 随期数衰减', () => {
  // 未来收益挂钩"当期因子"，因子本身 AR(1)：ρ=0.6 → IC(h) ∝ ρ^h 递减
  const rng = makeRng(21);
  const n = 8, days = 120;
  const factors = [];   // factors[t][j]
  for (let t = 0; t < days; t++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      const prev = t > 0 ? factors[t - 1][j] : j;
      row.push(0.6 * prev + (rng() - 0.5) * 0.4);
    }
    factors.push(row);
  }
  const barsList = [];
  for (let j = 0; j < n; j++) {
    const bars = [];
    let p = 100;
    for (let t = 0; t < days; t++) {
      p *= 1 + 0.01 * factors[t][j];
      bars.push({ date: `d${t}`, close: p, _factor: factors[t][j] });
    }
    barsList.push({ symbol: `S${j}`, bars });
  }
  const panel = buildFactorPanel(barsList, (bars, i) => bars[i]._factor);
  const decay = icDecay(panel, { horizons: [1, 3, 6, 10] });
  const means = decay.map(d => Math.abs(d.mean));
  for (let i = 1; i < means.length; i++) {
    assert.ok(means[i] < means[i - 1], `衰减必须单调：h=${decay[i].horizon} 的 |IC| ${means[i]} 应小于 h=${decay[i - 1].horizon} 的 ${means[i - 1]}`);
  }
});

test('噪声世界：IC 显著为正但不到 1，分层保持单调', () => {
  const { barsList, factorFn } = truthWorld({ n: 10, days: 150, noise: 0.004, seed: 33 });
  const panel = buildFactorPanel(barsList, factorFn);
  const rep = factorReport(panel, { horizon: 1, quantiles: 3 });
  assert.ok(rep.rank.mean > 0.3 && rep.rank.mean < 1, `含噪 IC 应在 (0.3, 1)，实际 ${rep.rank.mean}`);
  assert.ok(rep.rank.tStat > 2, `ICIR 乘 √T 应显著，实际 t=${rep.rank.tStat}`);
  const rets = rep.layers.layers.map(l => l.totalReturn);
  for (let i = 1; i < rets.length; i++) {
    assert.ok(rets[i] >= rets[i - 1] - 0.001, '含噪下分层收益也应基本单调');
  }
});

test('截面太小如实跳过并计数', () => {
  const { barsList, factorFn } = truthWorld({ n: 3, days: 30, noise: 0 });
  const panel = buildFactorPanel(barsList, factorFn);
  const s = icSeries(panel, { horizon: 1, minNames: 4 });   // 截面只有 3 个 < 4
  assert.eq(s.series.length, 0);
  assert.eq(s.skipped, 30, '全部截面都该被跳过并计数');
  const lb = layeredBacktest(panel, { quantiles: 3, minNames: 4 });
  assert.eq(lb.usable, 0);
  assert.ok(lb.note.includes('不足'));
});
