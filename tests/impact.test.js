import { test, assert } from './harness.js';
import { sqrtImpactPrice, participationCapLots, dailyVolSeries } from '../src/core/impact.js';
import { BacktestEngine } from '../src/core/backtestEngine.js';

const SPEC = { multiplier: 10, tick: 1, fee: { mode: 'rate', value: 0.0001 }, marginRate: 0.1, limitPct: 0.08 };

test('sqrtImpactPrice：平方根律的数值与边界', () => {
  // ΔP = 100 × 0.02 × √0.1 = 0.632
  assert.near(sqrtImpactPrice({ price: 100, dailyVol: 0.02, participation: 0.1 }), 0.6325, 1e-3);
  // 参与率 4 倍 → 冲击 √4 = 2 倍（平方根律的核心性质）
  const small = sqrtImpactPrice({ price: 100, dailyVol: 0.02, participation: 0.01 });
  const big = sqrtImpactPrice({ price: 100, dailyVol: 0.02, participation: 0.04 });
  assert.near(big / small, 2, 1e-9);
  // η 线性缩放
  assert.near(sqrtImpactPrice({ price: 100, dailyVol: 0.02, participation: 0.1, eta: 2 }),
              2 * 0.6325, 1e-3);
  // 非法输入给 0，不抛错
  assert.eq(sqrtImpactPrice({ price: 100, dailyVol: 0, participation: 0.1 }), 0);
  assert.eq(sqrtImpactPrice({ price: -5, dailyVol: 0.02, participation: 0.1 }), 0);
});

test('participationCapLots：单位换算与无量拒绝', () => {
  // 期货：volume 与手数同单位。1 万手 × 10% = 1000 手
  assert.eq(participationCapLots({ barVolume: 10000, qtyPerLot: 1, maxParticipation: 0.1 }), 1000);
  // A股：volume 是股。100 万股 × 10% ÷ 100 股/手 = 1000 手
  assert.eq(participationCapLots({ barVolume: 1e6, qtyPerLot: 100, maxParticipation: 0.1 }), 1000);
  assert.eq(participationCapLots({ barVolume: 0, qtyPerLot: 1, maxParticipation: 0.1 }), 0, '无量 bar 不许成交');
  assert.eq(participationCapLots({ barVolume: 500, qtyPerLot: 100, maxParticipation: 0.1 }), 0, '不足一手也是 0');
});

test('dailyVolSeries：不含当根（无未来函数），前缀为 null', () => {
  const bars = [];
  for (let i = 0; i < 40; i++) bars.push({ date: `d${i}`, close: 100 + (i % 2 ? 3 : -3) });
  const v = dailyVolSeries(bars, 20);
  // 窗口 = 截至 i−1 的 20 个收益 → 最早 i=21 才有完整窗口
  for (let i = 0; i <= 20; i++) assert.eq(v[i], null, `第 ${i} 根不足一个窗口，必须 null`);
  assert.ok(v[21] > 0);
  // 把第 21 根的收盘改成天价：它自己的波动率不变（窗口只看到前一根为止）
  const bars2 = bars.map((b, i) => i === 21 ? { ...b, close: 1e6 } : b);
  const v2 = dailyVolSeries(bars2, 20);
  assert.eq(v2[21], v[21], 'vol[i] 用到 bars[i].close 就是未来函数');
  assert.ok(v2[22] > v[22], '天价会进入下一根的窗口（这是应该的）');
  // 恒价 → 波动为 0 → null（没有波动就没有冲击可言）
  const flat = Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, close: 100 }));
  assert.eq(dailyVolSeries(flat, 20)[25], null);
});

/** 30 根震荡 bar（vol≈3%），随后横盘；volume 可控。 */
function makeBars({ volume = 10000, n = 30 } = {}) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const c = 100 + (i % 2 ? 3 : -3);
    bars.push({ date: `2020-01-${String(i + 1).padStart(2, '0')}`, open: c, high: c + 1, low: c - 1, close: c, volume });
  }
  return bars;
}

test('引擎接入：冲击让大单成交更差，eta=0 时与旧路径逐位一致', () => {
  const bars = makeBars({ volume: 1000000, n: 40 });
  // 信号在第 10 根发出、第 11 根成交 —— volLookback=5 时波动率已就绪
  const signals = bars.map((_, i) => ({ dir: i === 10 ? 1 : 0 }));
  const base = new BacktestEngine(bars, SPEC, { lots: 500 }).run(signals);
  const zero = new BacktestEngine(bars, SPEC, { lots: 500, impact: { eta: 0 } }).run(signals);
  assert.eq(JSON.stringify(zero.trades), JSON.stringify(base.trades), 'eta=0 必须等价于关闭');

  const impacted = new BacktestEngine(bars, SPEC, { lots: 500, impact: { eta: 1, delta: 0.5, maxParticipation: 0.2, volLookback: 5 } }).run(signals);
  const e0 = base.trades[0].entryPrice, e1 = impacted.trades[0].entryPrice;
  assert.ok(e1 > e0, `多头大单的成交价必须更差：冲击前 ${e0}，冲击后 ${e1}`);
  // 参与率 = 500/1e6 = 0.0005 → √=0.0224；vol≈6% → 冲击 ≈ 100×0.06×0.0224 ≈ 0.13
  assert.ok(e1 - e0 < 0.5, '1e6 成交量里的 500 手是小单，冲击不应夸张');
  assert.ok(impacted.trades[0].netPnL < base.trades[0].netPnL, '多单入场更贵，同出场时净盈亏更差');
});

test('引擎接入：参与率上限砍手数，无量 bar 拒单', () => {
  const bars = makeBars({ volume: 2000, n: 40 });
  const signals = bars.map((_, i) => ({ dir: i === 10 ? 1 : 0 }));
  // 要 500 手，参与率 10% → 2000×0.1 = 200 手封顶
  const r = new BacktestEngine(bars, SPEC, { lots: 500, impact: { eta: 1, maxParticipation: 0.1, volLookback: 5 } }).run(signals);
  assert.eq(r.trades[0].lots, 200, '手数必须被砍到参与率上限');
  assert.ok(r.rejected.participationCapped >= 1, '被砍要留痕');

  const dry = makeBars({ volume: 0, n: 40 });
  const r2 = new BacktestEngine(dry, SPEC, { lots: 5, impact: { eta: 1, maxParticipation: 0.1 } }).run(dry.map((_, i) => ({ dir: i === 10 ? 1 : 0 })));
  assert.eq(r2.trades.length, 0, '无量 bar 不许开仓');
  assert.ok(r2.rejected.noLiquidity >= 1);
});

test('引擎接入：A股股数口径（qtyPerLot=100）', () => {
  const bars = makeBars({ volume: 1e6, n: 40 });   // A股日线 volume 是股
  const stockSpec = { multiplier: 100, tick: 0.01, fee: { mode: 'rate', value: 0.00025 }, marginRate: 1, limitPct: 0.1 };
  const signals = bars.map((_, i) => ({ dir: i === 10 ? 1 : 0 }));
  const cap = 2e7;
  const r = new BacktestEngine(bars, stockSpec, { capital: cap, lots: 200, qtyPerLot: 100, impact: { eta: 1, maxParticipation: 0.05, volLookback: 5 } }).run(signals);
  // 上限 = 1e6 股 × 5% ÷ 100 股/手 = 500 手 → 200 手不被砍
  assert.eq(r.trades[0].lots, 200);
  // 参与率 = 200手×100股/1e6股 = 2% → √0.02 = 0.1414，冲击 = 价×vol×0.1414 ≈ 100×0.06×0.14 ≈ 0.85 元
  const e0 = new BacktestEngine(bars, stockSpec, { capital: cap, lots: 200 }).run(signals).trades[0].entryPrice;
  assert.ok(r.trades[0].entryPrice > e0, '冲击要生效');
  // 要 10000 手时被砍到 500
  const r2 = new BacktestEngine(bars, stockSpec, { capital: cap, lots: 10000, qtyPerLot: 100, impact: { eta: 1, maxParticipation: 0.05, volLookback: 5 } }).run(signals);
  assert.eq(r2.trades[0].lots, 500);
});
