import { test, assert } from './harness.js';
import { ols, styleFactorReturns, styleExposure } from '../src/report/styleExposure.js';
import { makeRng } from '../src/core/rng.js';

function lcg(n, { mu = 0, sd = 0.01, seed = 7 } = {}) {
  let a = seed >>> 0;
  const next = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const out = [];
  for (let i = 0; i < n; i++) {
    let u = 0;
    for (let k = 0; k < 4; k++) u += next();
    out.push(mu + sd * (u - 2) * Math.sqrt(3));
  }
  return out;
}

test('ols：精确线性关系全量恢复', () => {
  // y = 1 + 2·x1 − 0.5·x2，零噪声
  const X = [[1, 0], [2, 1], [3, 0], [4, 2], [5, 1], [6, 3]];
  const y = X.map(([a, b]) => 1 + 2 * a - 0.5 * b);
  const r = ols(y, X);
  assert.ok(r.usable);
  assert.near(r.alpha, 1, 1e-9);
  assert.near(r.beta[0], 2, 1e-9);
  assert.near(r.beta[1], -0.5, 1e-9);
  assert.near(r.r2, 1, 1e-9);
  assert.ok(r.alphaT === null || Math.abs(r.alphaT) > 1e3, '零残差时 t 值应为 null（se=0）或巨大');
  assert.eq(ols([1, 2, 3], [[1], [2]]).usable, false, '样本不足拒绝');
});

test('ols：共线因子报奇异而不是给垃圾系数', () => {
  const x1 = [1, 2, 3, 4, 5, 6, 7, 8];
  const X = x1.map(v => [v, 2 * v]);    // x2 = 2·x1 完全共线
  const y = x1.map(v => v * 3 + 1);
  const r = ols(y, X);
  assert.eq(r.usable, false);
  assert.ok(r.note.includes('共线'));
});

test('styleFactorReturns：无未来函数（t 日排序用截至 t−1 的数据）', () => {
  // 6 个品种（三分位每组至少 2 个）：S5 一路暴涨、S0 阴跌。动量排序若在 t 日
  // 用了 t 日数据，就等于"已知 S5 明天继续涨"
  const days = 90;
  const barsList = [];
  for (let j = 0; j < 6; j++) {
    let p = 100;
    const bars = [];
    for (let t = 0; t < days; t++) {
      p *= 1 + (j === 5 ? 0.01 : j === 0 ? -0.008 : 0.0005);
      bars.push({ date: `d${String(t).padStart(3, '0')}`, close: p, volume: 1000 * (j + 1) });
    }
    barsList.push({ symbol: `S${j}`, bars });
  }
  const fr = styleFactorReturns(barsList, { momLookback: 20, volLookback: 10 });
  assert.ok(fr.usable);
  // 手算 mkt：第一天有效收益的等权均值（t=1 起）
  const rets = barsList.map(({ bars }) => bars[1].close / bars[0].close - 1);
  const expectMkt = rets.reduce((a, b) => a + b, 0) / 6;
  assert.near(fr.factors.mkt[1], expectMkt, 1e-12);
  // 动量因子在动量窗就绪后应为正（赢家组 S4 领跑）
  const lateMom = fr.factors.momentum.slice(40).filter(Number.isFinite);
  assert.ok(lateMom.length > 30);
  assert.ok(lateMom.reduce((a, b) => a + b, 0) / lateMom.length > 0, '持续上涨的池子里 WML 均值应为正');
  // 精确窗口手算：t=60 的排序用 close[40..59]（不含 60），收益用 ret[60]（59→60）。
  // 排序窗不含 t 日数据 = 无未来函数；因子收益当然含 t 日收益 —— 两件事别混。
  const momAt60 = barsList.map(({ bars }) => bars[59].close / bars[40].close - 1);
  const sorted = momAt60.map((v, j) => ({ j, v })).sort((a, b) => a.v - b.v);
  const ret60 = barsList.map(({ bars }) => bars[60].close / bars[59].close - 1);
  // 6 品种三分位 → 每组 2 个：WML = 高组(S5,S4)均值 − 低组(S0,S1)均值
  const high = [sorted[5].j, sorted[4].j], low = [sorted[0].j, sorted[1].j];
  const avg = (idx) => idx.reduce((s, j) => s + ret60[j], 0) / idx.length;
  const expectMom60 = avg(high) - avg(low);
  assert.near(fr.factors.momentum[60], expectMom60, 1e-12, 'WML = 排序窗(截至t−1)选出的高组收益 − 低组收益');
});

test('styleExposure：构造的收益被精确还原', () => {
  const rng = makeRng(9);
  const days = 200;
  // 构造因子序列：mkt 与 momentum 独立
  const mkt = lcg(days, { sd: 0.01, seed: 51 });
  const mom = lcg(days, { sd: 0.008, seed: 52 });
  const vol = lcg(days, { sd: 0.006, seed: 53 });
  const size = lcg(days, { sd: 0.006, seed: 54 });
  // 策略收益 = 0.02 + 1.3·mkt + 0.5·mom + 0（vol/size 不暴露） + 噪声
  const noise = lcg(days, { sd: 0.002, seed: 55 });
  const strat = mkt.map((m, t) => 0.02 + 1.3 * m + 0.5 * mom[t] + noise[t]);
  const factorReturns = {
    dates: Array.from({ length: days }, (_, t) => `d${t}`),
    factors: { mkt, momentum: mom, volatility: vol, size }
  };
  const r = styleExposure({ strategyReturns: strat, factorReturns });
  assert.ok(r.usable);
  assert.near(r.exposures[0].beta, 1.3, 0.05, `市场贝塔回归值 ${r.exposures[0].beta}`);
  assert.near(r.exposures[1].beta, 0.5, 0.05);
  assert.ok(Math.abs(r.exposures[2].beta) < 0.05, `没暴露的因子系数应≈0，实际 ${r.exposures[2].beta}`);
  assert.ok(r.exposures[0].tStat > 10, '1.3 倍贝塔在 200 期样本下必须显著');
  assert.near(r.r2, 1, 0.05);
  assert.ok(r.r2 > 0.9 && r.note && r.note.includes('风格'), 'R²>0.9 时要点破"风格暴露的马甲"');
});

test('styleExposure：微盘暴露诊断与样本不足拒绝', () => {
  const days = 120;
  const mkt = lcg(days, { sd: 0.01, seed: 61 });
  const size = lcg(days, { sd: 0.01, seed: 62 });
  const noise = lcg(days, { sd: 0.001, seed: 63 });
  // 策略 = −2.0·size + 噪声：size 因子是"大减小"，负系数 = 押小票（微盘赌徒）
  const strat = size.map((s, t) => -2.0 * s + noise[t]);
  const factorReturns = {
    dates: Array.from({ length: days }, (_, t) => `d${t}`),
    factors: { mkt, momentum: lcg(days, { sd: 0.001, seed: 64 }), volatility: lcg(days, { sd: 0.001, seed: 65 }), size }
  };
  const r = styleExposure({ strategyReturns: strat, factorReturns });
  const sizeRow = r.exposures.find(e => e.factor === 'size');
  assert.ok(sizeRow.beta < -1.8, `规模暴露应≈−2（押小票），实际 ${sizeRow.beta}`);
  assert.ok(Math.abs(sizeRow.tStat) > 10);
  assert.ok(sizeRow.interpretation && sizeRow.interpretation.includes('小票'), '负向/正向规模暴露都要给解读');

  const short = styleExposure({ strategyReturns: strat.slice(0, 10), factorReturns });
  assert.eq(short.usable, false);
});
