import { test, assert } from './harness.js';
import {
  invertMatrix, matMul, sampleCovariance, correlationFromCov, alignReturns,
  ledoitWolfShrinkage, projectBoxSimplex, minVarianceWeights, meanVarianceWeights,
  ercWeights, cvarParityWeights, blackLitterman, hrpWeights
} from '../src/core/portfolioOpt.js';

/** 测试专用确定性收益序列。 */
function lcgReturns(n, { mu = 0, sd = 0.01, seed = 7 } = {}) {
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

test('invertMatrix：2×2 手算基线、A·A⁻¹=I、奇异返回 null', () => {
  const A = [[4, 2], [1, 3]];
  const inv = invertMatrix(A);
  assert.near(inv[0][0], 0.3, 1e-12);
  assert.near(inv[0][1], -0.2, 1e-12);
  assert.near(inv[1][0], -0.1, 1e-12);
  assert.near(inv[1][1], 0.4, 1e-12);
  const I = matMul(A, inv);
  assert.near(I[0][0], 1, 1e-12); assert.near(I[0][1], 0, 1e-12);
  assert.near(I[1][0], 0, 1e-12); assert.near(I[1][1], 1, 1e-12);
  assert.eq(invertMatrix([[1, 2], [2, 4]]), null, '奇异矩阵如实报 null');
});

test('alignReturns + sampleCovariance：对齐与口径', () => {
  const R = alignReturns([
    [100, 102, 101, 105, 107],
    [50, 51, 50.5, 53, 54],
  ]);
  assert.eq(R.length, 4);
  assert.near(R[0][0], 0.02, 1e-12);
  assert.near(R[0][1], 0.02, 1e-12, '按最短序列截齐，两列同期收益');
  const cov = sampleCovariance(R);
  assert.eq(cov.length, 2);
  assert.ok(cov[0][0] > 0 && cov[1][1] > 0);
  const corr = correlationFromCov(cov);
  assert.near(corr[0][0], 1, 1e-12);
  assert.ok(Math.abs(corr[0][1]) <= 1 + 1e-12);
});

test('ledoitWolfShrinkage：强度在 [0,1]，小样本噪声大时收缩更强', () => {
  // 大样本独立数据：样本协方差已可信 → 收缩强度应很小
  const big = lcgReturns(500, { sd: 0.01, seed: 11 }).map(x => [x]);
  const lwBig = ledoitWolfShrinkage(big);
  assert.ok(lwBig.intensity >= 0 && lwBig.intensity <= 1);
  // 小样本多资产：噪声主导 → 强度应明显更大
  const small = Array.from({ length: 15 }, () => lcgReturns(15, { sd: 0.02, seed: 12 }));
  const lwSmall = ledoitWolfShrinkage(small);
  assert.ok(lwSmall.intensity > lwBig.intensity, `小样本强度 ${lwSmall.intensity} 应大于大样本 ${lwBig.intensity}`);
  // 收缩后对角仍为正、可用
  assert.ok(lwSmall.cov.every((row, i) => row[i] > 0));
});

test('projectBoxSimplex：和为 1 且尊重上限', () => {
  assert.near(projectBoxSimplex([0.6, 0.6, 0.6]).reduce((a, b) => a + b, 0), 1, 1e-9);
  const clipped = projectBoxSimplex([0.9, 0.05, 0.05], { max: 0.5 });
  assert.ok(clipped[0] <= 0.5 + 1e-12);
  assert.near(clipped.reduce((a, b) => a + b, 0), 1, 1e-9);
});

test('minVarianceWeights：零相关双资产有解析解，上限要生效', () => {
  // σ1²=0.01, σ2²=0.04 → w1 = 0.04/0.05 = 0.8
  const cov = [[0.01, 0], [0, 0.04]];
  const r = minVarianceWeights(cov);
  assert.near(r.weights[0], 0.8, 1e-6);
  assert.near(r.weights[1], 0.2, 1e-6);
  // 上限 0.6 → 顶格
  const capped = minVarianceWeights(cov, { maxWeight: 0.6 });
  assert.near(capped.weights[0], 0.6, 1e-9);
  assert.near(capped.weights[1], 0.4, 1e-9);
  // 比网格扫描更优（或相等）—— 求解器不能输给暴力
  let bestGrid = Infinity;
  for (let w = 0; w <= 1.0001; w += 0.001) {
    const v = 0.01 * w * w + 0.04 * (1 - w) * (1 - w);
    if (v < bestGrid) bestGrid = v;
  }
  assert.ok(r.portVar <= bestGrid + 1e-10);
});

test('meanVarianceWeights：λ→0 押高收益，λ→∞ 退化最小方差', () => {
  const cov = [[0.01, 0], [0, 0.04]];
  const mu = [0.02, 0.015];
  const greedy = meanVarianceWeights(mu, cov, { riskAversion: 0.01 });
  assert.ok(greedy.weights[0] > 0.95, `λ→0 应几乎全押 μ 高的资产，实际 ${greedy.weights[0]}`);
  const riskless = meanVarianceWeights([0, 0], cov, { riskAversion: 1e6 });
  assert.near(riskless.weights[0], 0.8, 1e-4, 'μ=0 时只剩风险项 → 与最小方差一致');
});

test('ercWeights：零相关时解析解（w∝1/σ），相关时贡献仍相等', () => {
  const cov0 = [[0.01, 0, 0], [0, 0.04, 0], [0, 0, 0.09]];
  const r0 = ercWeights(cov0);
  // 零相关：RC_i = w_i²σ_i² 相等 → w_i ∝ 1/σ_i = [10, 5, 3.33]
  assert.near(r0.weights[0], 10 / 18.3333, 1e-3);
  assert.near(r0.weights[1], 5 / 18.3333, 1e-3);
  assert.near(r0.weights[2], 3.3333 / 18.3333, 1e-3);
  assert.ok(r0.rcSpread < 1e-9, `零相关下贡献差应≈0，实际 ${r0.rcSpread}`);
  // 有相关性的矩阵：贡献仍要拉平
  const corr = [[0.01, 0.005], [0.005, 0.04]];
  const r1 = ercWeights(corr);
  assert.ok(r1.rcSpread < 1e-6, `相关性非零时贡献差 ${r1.rcSpread} 也要小`);
});

test('cvarParityWeights：对称资产给对称权重，高波动资产权重更低', () => {
  const base = lcgReturns(400, { sd: 0.01, seed: 21 });
  const same = base.map(x => [x, x]);                          // 两个完全相同的资产
  const rSame = cvarParityWeights(same, { iters: 2000 });
  assert.near(rSame.weights[0], 0.5, 1e-9, '边际贡献相同的资产必须平分');
  const vols = base.map((x, i) => [x, lcgReturns(400, { sd: 0.02, seed: 22 })[i]]);
  const r2 = cvarParityWeights(vols, { iters: 2000 });
  assert.ok(r2.weights[0] > 0.55, `低波资产权重应过半，实际 ${r2.weights[0]}`);
  assert.eq(r2.weights.reduce((a, b) => a + b, 0) > 0.99, true);
  assert.eq(cvarParityWeights([[0.01, 0.02], [0.02, 0.01]]).weights, null, '样本不足拒绝');
});

test('blackLitterman：无观点=均衡收益，强观点向 Q 收敛', () => {
  const cov = [[0.04, 0.008], [0.008, 0.09]];
  const wm = [0.6, 0.4];
  const noView = blackLitterman({ cov, wMarket: wm, delta: 2.5 });
  assert.near(noView.expRet[0], 2.5 * (0.04 * 0.6 + 0.008 * 0.4), 1e-12, 'Π = δΣw_mkt');
  assert.ok(noView.note.includes('无观点'));
  // 均衡隐含收益 ≈ 6.8%。给一个 100% 置信的看多观点"资产1 收益 10%" → 后验贴住 Q
  const strong = blackLitterman({ cov, wMarket: wm, delta: 2.5,
    views: { P: [[1, 0]], Q: [0.10], omega: [[1e-10]] } });
  assert.ok(Math.abs(strong.expRet[0] - 0.10) < 1e-4, `强观点应贴住 Q，实际 ${strong.expRet[0]}`);
  assert.ok(strong.expRet[0] > noView.expRet[0], '看多观点抬升后验收益');
  // 默认 Ω（τ·PΣPᵀ）路径：软观点的后验应在均衡与强观点之间
  const soft = blackLitterman({ cov, wMarket: wm, delta: 2.5, views: { P: [[1, 0]], Q: [0.10] } });
  assert.ok(soft.expRet[0] > noView.expRet[0] && soft.expRet[0] < strong.expRet[0],
    `软观点后验 ${soft.expRet[0]} 应在 ${noView.expRet[0]} 与 ${strong.expRet[0]} 之间`);
});

test('hrpWeights：相同资产平分，4 资产两两成簇、份额均衡', () => {
  const same = lcgReturns(200, { sd: 0.01, seed: 31 }).map(x => [x, x * 1.0]);
  const rSame = hrpWeights(same);
  assert.near(rSame.weights[0], 0.5, 1e-9);
  assert.near(rSame.weights[1], 0.5, 1e-9);
  // 4 资产：A/B 高相关（近似同一资产），C/D 互相独立、与 A/B 也独立。
  // seriation 后相关对相邻 → 第一次二分把 [A,B] 与 [C,D] 分开，两簇份额应≈对半。
  const a = lcgReturns(300, { sd: 0.01, seed: 41 });
  const noise = lcgReturns(300, { sd: 0.001, seed: 42 });
  const bSeries = a.map((x, i) => x + noise[i]);
  const c = lcgReturns(300, { sd: 0.01, seed: 43 });
  const d = lcgReturns(300, { sd: 0.01, seed: 44 });
  const R = a.map((x, i) => [x, bSeries[i], c[i], d[i]]);
  const r = hrpWeights(R);
  const abShare = r.weights[0] + r.weights[1];
  const cdShare = r.weights[2] + r.weights[3];
  assert.ok(Math.abs(abShare - cdShare) < 0.1, `两簇份额应接近：相关对 ${abShare.toFixed(3)} vs 独立对 ${cdShare.toFixed(3)}`);
  assert.ok(Math.abs(r.weights[0] - r.weights[1]) < 0.03, '相关对内部近似平分');
  assert.ok(Math.abs(r.weights[2] - r.weights[3]) < 0.03);
  assert.near(r.weights.reduce((x, y) => x + y, 0), 1, 1e-9);
  assert.eq(hrpWeights([[0.01, 0.02], [0.015, 0.01]]).weights, null, '样本不足拒绝');
});
