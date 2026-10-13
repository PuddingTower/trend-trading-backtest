import { test, assert } from './harness.js';
import { percentile, simulatePaths, parameterHeatmap, costStress } from '../src/report/monteCarlo.js';
import { getStrategy } from '../src/strategy/library.js';
import { rulesFor } from '../src/markets/marketRules.js';

const mk = (date, o, h, l, c, v = 1000) => ({ date, open: o, high: h, low: l, close: c, volume: v });
const FSPEC = { market: 'futures', multiplier: 10, tick: 1, marginRate: 0.1, fee: { mode: 'fixed', value: 4 } };

/** 造一段有趋势也有回调的序列，够 donchianBreak 出几笔。日期必须单调，否则板锁/缺口判定会被无意义的乱序干扰。 */
function barsOf(n = 260) {
  const out = [];
  let p = 3500;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 26) * 14 + (i > 150 ? 6 : -2);
    p = Math.max(2000, p + drift + ((i % 7) - 3) * 4);
    const d = new Date(Date.UTC(2023, 0, 1));
    d.setUTCDate(d.getUTCDate() + i);
    out.push(mk(d.toISOString().slice(0, 10), p, p + 22, p - 20, p + 4));
  }
  return out;
}

// ---------- 分位数 ----------
test('percentile：线性插值，空数组返回 null 而不是 0', () => {
  assert.eq(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.eq(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.eq(percentile([1, 2, 3, 4, 5], 1), 5);
  assert.eq(percentile([10, 20], 0.5), 15, '两点之间要能插值');
  assert.eq(percentile([], 0.5), null, '空样本不许冒充 0 —— 0 会被读成"回撤为 0"');
  assert.eq(percentile([7], 0.95), 7);
});

// ---------- 蒙特卡洛重放 ----------
test('蒙特卡洛：同种子逐值可复现，换种子结果不同', () => {
  const trades = Array.from({ length: 30 }, (_, i) => ({ netPnL: ((i * 37) % 53) - 24 }));
  const a = simulatePaths(trades, { seed: 777, runs: 120 });
  const b = simulatePaths(trades, { seed: 777, runs: 120 });
  const c = simulatePaths(trades, { seed: 778, runs: 120 });
  assert.eq(a.drawdown.p50, b.drawdown.p50, '同种子必须给出同一个数，否则截图里的结果别人复算不了');
  assert.eq(a.ruin.risk, b.ruin.risk);
  assert.ok(a.drawdown.p95 !== c.drawdown.p95 || a.endEquity.p5 !== c.endEquity.p5, '换种子还一模一样，说明随机没生效');
});

test('蒙特卡洛：重排顺序不许改变期末权益（求和与顺序无关，这条不成立就是算错了）', () => {
  const trades = Array.from({ length: 25 }, (_, i) => ({ netPnL: i % 3 === 0 ? -1200 : 1800 }));
  const r = simulatePaths(trades, { mode: 'sequence', runs: 200, seed: 42, capital: 100000 });
  const sum = trades.reduce((s, t) => s + t.netPnL, 0);
  assert.eq(r.endEquity.p5, 100000 + sum, 'sequence 模式的分位下界');
  assert.eq(r.endEquity.p95, 100000 + sum, 'sequence 模式的分位上界 —— 期末值必须是一个数');
  assert.near(r.actual.endEquity, 100000 + sum, 1e-6);
});

test('蒙特卡洛：回撤分布给出 P5/P50/P95，且分位单调', () => {
  const trades = Array.from({ length: 40 }, (_, i) => ({ netPnL: Math.sin(i / 3) * 3000 - 200 }));
  const r = simulatePaths(trades, { runs: 300, seed: 7 });
  assert.ok(r.drawdown.p5 <= r.drawdown.p50 && r.drawdown.p50 <= r.drawdown.p95,
    `分位必须单调：${r.drawdown.p5}/${r.drawdown.p50}/${r.drawdown.p95}`);
  assert.ok(r.drawdown.p95 >= r.actual.maxDD * 0.5, 'P95 至少不该比实际回撤还小得多');
  assert.ok(r.ruin.risk >= 0 && r.ruin.risk <= 1);
  assert.ok(r.bands && r.bands.steps.length > 2, '要给出分位带，UI 才有东西可画');
  assert.eq(r.bands.p5.length, r.bands.p95.length);
  for (let i = 0; i < r.bands.p5.length; i++) {
    assert.ok(r.bands.p5[i] <= r.bands.p95[i] + 1e-9, `第 ${i} 列 P5 不能高于 P95`);
  }
});

test('蒙特卡洛：连续亏损的品种，破产概率显著高于稳定盈利的品种', () => {
  const bad = Array.from({ length: 30 }, () => ({ netPnL: -4000 }));
  const good = Array.from({ length: 30 }, (_, i) => ({ netPnL: 2000 + (i % 5) * 300 }));
  const rb = simulatePaths(bad, { runs: 100, seed: 3, capital: 100000, ruinPct: 0.5 });
  const rg = simulatePaths(good, { runs: 100, seed: 3, capital: 100000, ruinPct: 0.5 });
  assert.eq(rb.ruin.risk, 1, '每笔亏 4000、30 笔，任何顺序都会腰斩');
  assert.eq(rg.ruin.risk, 0, '只赚不亏的序列不该有破产概率');
});

test('蒙特卡洛：样本太少就拒绝出数，而不是给一条假的分布', () => {
  const r = simulatePaths([{ netPnL: 100 }, { netPnL: -50 }], { runs: 50 });
  assert.ok(r.error && /笔/.test(r.error), `应拒绝，实际 ${JSON.stringify(r)}`);
  assert.ok(simulatePaths([], { runs: 50 }).error);
  assert.ok(simulatePaths(null, { runs: 50 }).error, 'null 输入不许抛异常');
});

test('蒙特卡洛：「实际所处分位」是 0~1 的概率，不是数列上的一个值', () => {
  // 曾经写成 percentile(sorted, frac)，于是界面上出现"分位 85620%"这种数 ——
  // 它必须是个比例，因为读法就是"历史那条排在 P 几"。
  const trades = Array.from({ length: 24 }, (_, i) => ({ netPnL: i % 4 === 0 ? -5000 : 3000 }));
  const r = simulatePaths(trades, { runs: 200, seed: 21 });
  const a = r.drawdown.actualPctile;
  assert.ok(Number.isFinite(a), `必须是数字，实际 ${a}`);
  assert.ok(a >= 0 && a <= 1, `必须在 [0,1]，实际 ${a}`);
  assert.eq(r.ruin.risk >= 0 && r.ruin.risk <= 1, true);
});

test('蒙特卡洛：bootstrap 与 noise 模式都能跑，且期末值会因抽样而变', () => {
  const trades = Array.from({ length: 20 }, (_, i) => ({ netPnL: i % 2 ? 2500 : -1500 }));
  const bs = simulatePaths(trades, { mode: 'bootstrap', runs: 150, seed: 11 });
  const nz = simulatePaths(trades, { mode: 'noise', runs: 150, seed: 11, noisePct: 0.3 });
  assert.ok(!bs.error && !nz.error);
  assert.ok(bs.endEquity.p5 < bs.endEquity.p95, '有放回抽样会丢样本，期末值必须散开');
  assert.ok(nz.endEquity.p5 < nz.endEquity.p95, '乘性扰动同样要散开');
  assert.eq(nz.trades, 20);
});

// ---------- 参数热图 ----------
const row = (params, score) => ({ params, score, rank: 0, metrics: { sharpe: score / 10 } });
test('参数热图：二维摊平、取边缘最优、能认出孤峰', () => {
  const rows = [];
  for (const e of [20, 30, 40]) for (const s of [5, 10, 15]) rows.push(row({ entry: e, stop: s }, e === 30 && s === 10 ? 100 : 20));
  const h = parameterHeatmap(rows, {});
  assert.eq(h.xDim, 'entry'); assert.eq(h.yDim, 'stop');
  assert.eq(h.xVals.length, 3); assert.eq(h.yVals.length, 3);
  assert.eq(h.cells.length, 3, 'cells 第一维是 y');
  assert.eq(h.best.score, 100);
  assert.eq(h.best.x, 30); assert.eq(h.best.y, 10);
  assert.ok(h.plateau.ratio < 0.5, `尖峰周围全是 20，应判孤峰，实际 ${JSON.stringify(h.plateau)}`);
  assert.ok(/边缘最优/.test(h.note), '必须注明这是边缘最优');
});

test('参数热图：邻格大面积存活时判成高原；只有一个维度时明确拒绝', () => {
  const flat = [];
  for (const a of [1, 2, 3]) for (const b of [1, 2, 3]) flat.push(row({ x: a, y: b }, 90 + a + b));
  const h = parameterHeatmap(flat, { xDim: 'y', yDim: 'x' });
  assert.ok(h.plateau.ratio >= 0.5, `一片高原不该被判孤峰：${JSON.stringify(h.plateau)}`);
  assert.eq(h.xDim, 'y', '指定维度要被采纳');
  const one = parameterHeatmap([row({ only: 1 }, 5), row({ only: 2 }, 6)], {});
  assert.ok(one.error && /只有一个参数维度/.test(one.error), one.error);
  assert.ok(parameterHeatmap([], {}).error);
});

test('参数热图：没扫到的格子如实算空洞，不当成 0 分', () => {
  const rows = [row({ a: 1, b: 1 }, 10), row({ a: 2, b: 2 }, 20)];
  const h = parameterHeatmap(rows, {});
  assert.eq(h.emptyCells, 2, '2×2 里有 2 格无样本');
  assert.eq(h.cells[0][1].score, null, '空格必须是 null，不能是 0（0 会被画成"很差"）');
});

test('参数热图：默认挑"变化最多"的两维，而不是参数表头两列', () => {
  // 真实寻优结果里 params 是「全部默认参数 + 被扫的几维」，头两个键往往是没进网格的固定参数，
  // 拿它们当行列会摊出一个 1×1 的假热图。
  const rows = [];
  for (const b of [20, 40, 55]) for (const a of [0, 20, 25]) rows.push(row({ maLen: 100, riseLook: 21, breakout: b, adxMin: a }, b + a));
  const h = parameterHeatmap(rows, {});
  const sweptPair = [h.xDim, h.yDim].sort().join(',');
  assert.eq(sweptPair, 'adxMin,breakout', `行列必须落在被扫过的两维上，实际 ${h.xDim}/${h.yDim}`);
  assert.eq(h.xVals.length, 3); assert.eq(h.yVals.length, 3);
  assert.eq(h.fixedDims.join(','), 'maLen,riseLook', '没变化的维度要能被识别出来');
  assert.eq(h.flat, false);
  // 只有一维在变 → 明确报错，不画 1×1
  const oneDim = [row({ a: 1, b: 9 }, 1), row({ a: 2, b: 9 }, 2), row({ a: 3, b: 9 }, 3)];
  assert.ok(parameterHeatmap(oneDim, {}).error, '只有一个维度在变，摊不成矩阵');
});

test('参数热图：各格成绩完全相同时如实说"这两维没起作用"', () => {
  const rows = [];
  for (const b of [20, 40]) for (const a of [0, 20]) rows.push(row({ breakout: b, adxMin: a }, 7.5));
  const h = parameterHeatmap(rows, {});
  assert.eq(h.flat, true);
  assert.ok(/完全相同/.test(h.note), h.note);
});

// ---------- 成本敏感性 ----------
test('成本敏感性：零成本那一档的净盈亏必须 ≥ 基准档，费用放大只会更差', () => {
  const bars = barsOf();
  const strategy = getStrategy('donchianBreak');
  const rules = rulesFor(FSPEC);
  const r = costStress({
    bars, spec: FSPEC, strategy, params: { ...strategy.params },
    engineOpts: { capital: 200000, sizing: 'notional', notionalPct: 0.3, slippageTicks: 1, allowShort: true, rules },
    periodsPerYear: 252
  });
  const byLabel = Object.fromEntries(r.rows.map(x => [x.label, x]));
  assert.ok(r.rows.length >= 5, `场景要跑全，实际 ${r.rows.map(x => x.label).join('/')}`);
  assert.ok(byLabel['零成本（看毛利）'].trades > 0, '连一笔都没有的话这条断言是空的');
  assert.near(byLabel['零成本（看毛利）'].fees, 0, 1e-6, 'feeMult=0 时手续费必须真的是 0（rules 没换就会漏扣）');
  assert.eq(byLabel['零成本（看毛利）'].slipTicks, 0, 'slipTicks:0 必须真的把滑点关掉（写错字段名时这档会悄悄等于基准，整张表看不出问题）');
  assert.ok(byLabel['零成本（看毛利）'].netPnL > byLabel['成本 ×1（基准）'].netPnL,
    '零成本必须严格好于付了成本的版本');
  assert.ok(byLabel['滑点 ×2'].netPnL < byLabel['成本 ×1（基准）'].netPnL, '滑点加倍必须严格更差');
  assert.ok(byLabel['滑点 ×4'].netPnL < byLabel['滑点 ×2'].netPnL, '再加倍还要更差');
  assert.ok(byLabel['双打（费 ×2 + 滑 ×2）'].netPnL <= byLabel['滑点 ×2'].netPnL + 1e-6);
  assert.ok(r.ladder && r.ladder.note, '要给出盈亏平衡滑点的扫描结论');
});

test('成本敏感性：基准档就是面板里那套参数，不额外加戏', () => {
  const bars = barsOf(180);
  const strategy = getStrategy('maCross');
  const a = costStress({ bars, spec: FSPEC, strategy, params: { ...strategy.params },
                        engineOpts: { capital: 100000, lots: 2, slippageTicks: 1 },
                        scenarios: [{ label: '基准', feeMult: 1, slipTicks: null }] });
  const b = costStress({ bars, spec: FSPEC, strategy, params: { ...strategy.params },
                        engineOpts: { capital: 100000, lots: 2, slippageTicks: 1 },
                        scenarios: [{ label: '同值', feeMult: 1, slipTicks: 1 }] });
  assert.eq(a.baseSlip, 1);
  assert.eq(a.rows[0].netPnL, b.rows[0].netPnL, 'slipTicks:null 必须等价于沿用面板里的滑点');
});
