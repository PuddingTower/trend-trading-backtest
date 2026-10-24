import { test, assert } from './harness.js';
import {
  quantile, cornishFisherZ, parametricVaR, historicalVaR, monteCarloVaR,
  varSuite, marginRisk, fullRiskReport
} from '../src/report/riskMetrics.js';

/** 测试专用确定性 LCG：不引入对 rng.js 种子语义的耦合，本地自洽。 */
function lcgSeries(n, { mu = 0, sd = 0.01, seed = 12345 } = {}) {
  let a = seed >>> 0;
  const next = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  // 两枚均匀均值的和近似正态（Irwin-Hall 12 项太重，4 项对矩检验已够）
  const out = [];
  for (let i = 0; i < n; i++) {
    let u = 0;
    for (let k = 0; k < 4; k++) u += next();
    out.push(mu + sd * (u - 2) * Math.sqrt(3));
  }
  return out;
}

test('quantile：线性插值与空序列', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.eq(quantile(xs, 0), 1);
  assert.eq(quantile(xs, 1), 10);
  assert.near(quantile(xs, 0.5), 5.5, 1e-12);
  assert.near(quantile(xs, 0.45), 5.05, 1e-12, '(9-1)*0.45=3.6 → 4+0.6*(5-4)=4.6？不：索引 3.6 → 4 与 5 之间');
  assert.eq(quantile([], 0.5), null);
  assert.eq(quantile([1, 2], 1.5), null);
});

test('cornishFisherZ：正态原样返回，厚尾在深尾放大', () => {
  const z = -2.326; // 99% 左尾
  assert.near(cornishFisherZ(z, 0, 3), z, 1e-12, '正态（偏度0、峰度3）不应修正');
  assert.ok(cornishFisherZ(z, 0, 5) < z, '超额峰度为正时，99% 深尾必须更负（厚尾多吃资本）');
  assert.ok(cornishFisherZ(2.326, 0.5, 3) > 2.326, '正偏度在右尾放大');
  // 浅尾方向：峰度让 95% 分位反而略向内收（与拉普拉斯分布的精确分位对照过）
  assert.ok(cornishFisherZ(-1.645, 0, 6) > -1.645);
});

test('parametricVaR：正态数据下 CF ≈ 解析值，正常数据给 null', () => {
  const rets = lcgSeries(600, { mu: 0.0005, sd: 0.012, seed: 777 });
  const r = parametricVaR(rets, { alpha: 0.95 });
  assert.ok(r.var !== null);
  // 正态解析：-(mu + sd*z95) ≈ -(-0.01915*0.012+0.0005)... z95=-1.645 → 0.0005+0.012*1.645=0.02024
  assert.near(r.var, 0.02024, 0.004, '正态数据下 CF 修正应接近解析 VaR（矩的抽样误差内）');
  assert.ok(r.cvar > r.var, 'CVaR（尾部期望）必须 ≥ VaR');
  const h10 = parametricVaR(rets, { alpha: 0.95, horizon: 10 });
  assert.near(h10.var, r.var * Math.sqrt(10), 0.01, '√h 缩放');
  assert.ok(h10.scalingNote, '多日缩放必须带口径说明');
  assert.eq(parametricVaR([0.01, 0.02]).var, null, '样本不足给 null');
});

test('parametricVaR：厚尾数据的 99% VaR 比正态假设更大', () => {
  // 95% 温和 + 5% 大跳跃：构造非零超额峰度
  const calm = lcgSeries(950, { mu: 0.0003, sd: 0.006, seed: 99 });
  const jumps = [];
  for (let i = 0; i < 50; i++) jumps.push(i % 2 === 0 ? -0.05 : 0.045);
  const fat = calm.concat(jumps).sort(() => 0); // 顺序无关，矩不依赖顺序
  const r = parametricVaR(fat, { alpha: 0.99 });
  assert.ok(r.kurt > 3.5, `构造的数据应当有超额峰度，实际 kurt=${r.kurt}`);
  const normalOnly = 0.0003 + 0.012 * 2.326; // 若按正态 σ≈1.2% 算
  assert.ok(r.var > normalOnly * 1.1, `厚尾 99% VaR(${r.var.toFixed(4)}) 应显著超过正态假设(${normalOnly.toFixed(4)})`);
});

test('historicalVaR：手算基线对账（10 个样本，95%）', () => {
  // 排序后 [-3,-2,-1,0,1,2,3,4,5,6]/100。q05 位置 (10-1)*0.05=0.45 → -3+0.45*1=-2.55（%）
  const xs = [-3, 6, -1, 4, 1, -2, 5, 0, 2, 3].map(v => v / 100);
  const r = historicalVaR(xs, { alpha: 0.95 });
  assert.near(r.var, 0.0255, 1e-12);
  // 尾部 = {≤ −2.55%} = {−3%} 一个点 → CVaR = 3%。CVaR 是条件均值，不是"第二个分位数"，
  // 样本少时它就等于最差点 —— 这正是历史模拟需要大样本的原因。
  assert.near(r.cvar, 0.03, 1e-12);
  assert.near(r.worst, 0.03, 1e-12, 'worst 是最差单期损失');
  assert.eq(historicalVaR([0.01, -0.02, 0.03]).var, null, '不足 10 个样本拒绝给数');
});

test('monteCarloVaR：同种子可复现、量级合理、厚尾比正态数据大', () => {
  const calm = lcgSeries(300, { mu: 0.0004, sd: 0.01, seed: 31 });
  const a = monteCarloVaR(calm, { alpha: 0.99, seed: 7, sims: 4000 });
  const b = monteCarloVaR(calm, { alpha: 0.99, seed: 7, sims: 4000 });
  assert.eq(a.var, b.var, '同种子必须逐位一致');
  assert.ok(a.var > 0.015 && a.var < 0.05, `99% 日 VaR 量级应在 1.5σ~5σ，实际 ${a.var}`);
  assert.ok(a.cvar > a.var, 'MC 的 CVaR ≥ VaR');

  const fat = calm.slice(0, 285).concat(Array.from({ length: 15 }, (_, i) => (i % 2 ? -0.06 : 0.05)));
  const c = monteCarloVaR(fat, { alpha: 0.99, seed: 7, sims: 4000 });
  assert.ok(c.var > a.var, '厚尾样本的 MC VaR 应更大');
  assert.eq(monteCarloVaR(calm.slice(0, 20)).var, null, '不足 30 个样本拒绝');
});

test('varSuite：三模态同台，99% ≥ 95%', () => {
  const rets = lcgSeries(400, { mu: 0.0003, sd: 0.011, seed: 555 });
  const s95 = varSuite(rets, { alpha: 0.95, sims: 3000, seed: 3 });
  const s99 = varSuite(rets, { alpha: 0.99, sims: 3000, seed: 3 });
  for (const mode of ['parametric', 'historical', 'monteCarlo']) {
    assert.ok(s95[mode].var !== null && s99[mode].var !== null, `${mode} 三模态都要出数`);
    assert.ok(s99[mode].var > s95[mode].var, `${mode}：99% 置信的 VaR 必须大于 95%`);
  }
});

test('marginRisk：追保天数、风险度分位、强平距离', () => {
  const curve = [
    { date: 'd1', equity: 100000, margin: 30000, inPosition: true },
    { date: 'd2', equity: 90000, margin: 50000, inPosition: true },   // 风险度 0.556
    { date: 'd3', equity: 45000, margin: 50000, inPosition: true },   // 权益 < 占用 → 追保；风险度 1.11
    { date: 'd4', equity: 40000, margin: 0, inPosition: false },      // 空仓日不计
  ];
  const r = marginRisk(curve, { maintRatio: 0.75, warnRatio: 1.0 });
  assert.ok(r.usable);
  assert.eq(r.marginCallDays, 1, '只有 d3 权益跌破占用');
  assert.near(r.maxRiskDeg, 50 / 45, 1e-9, '最大风险度 = 占用/权益 的最大值');
  // 持仓样本 = d1/d2/d3 三天，风险度 [0.3, 0.5556, 1.1111]；p95 插值 = 0.5556+0.9*0.5556
  assert.near(r.p95RiskDeg, 1.0556, 1e-3);
  // d3：强平距离 = (45000 - 50000*0.75)/45000 = (45000-37500)/45000 = 0.1667
  // d2：(90000-37500)/90000 = 0.5833 → 最小 0.1667
  assert.near(r.liquidationGapMin, 0.1667, 1e-3);
  assert.ok(r.note && r.note.includes('追保'), '发生追保必须直说');

  const noMargin = [{ date: 'd', equity: 100, margin: 0, inPosition: false }];
  assert.eq(marginRisk(noMargin).usable, false, '无杠杆曲线如实报不可用');
});

test('fullRiskReport：从权益曲线一次算全', () => {
  const eq = [{ equity: 100000, date: 'd0' }];
  let v = 100000;
  for (const r of lcgSeries(250, { mu: 0.0004, sd: 0.01, seed: 88 })) {
    v *= (1 + r);
    eq.push({ equity: v, date: `d${eq.length}`, margin: 0, inPosition: false });
  }
  const rep = fullRiskReport(eq, { sims: 2000, seed: 5 });
  assert.ok(rep.var95.parametric.var !== null);
  assert.ok(rep.var99.historical.var > rep.var95.historical.var);
  assert.ok(rep.var10d99.parametric.var > rep.var99.parametric.var, '10 日持有期 VaR > 1 日');
  assert.eq(rep.margin.usable, false, '无保证金数据时风险度如实报 N/A');
});
