/**
 * 统计套件的数值验收。
 *
 * 参考值全部用 Python 独立算出（bisection 反解 Φ⁻¹、手写中心矩），不拿这份 JS 实现给自己打分
 * —— 否则公式抄错、两边一起错，测试照样绿。（第一版参考里我自己把 MinTRL 的 √inner 当成 inner
 *   写错过一遍，正是靠两边分开算才发现。）
 * 精度上限：Φ 用 A-S 7.1.26（|误差|1.5e-7），所以 Φ⁻¹ 的误差约 3e-6，PSR/MinTRL 的断言按这个尺度给容差。
 */
import { test, assert } from './harness.js';
import { makeRng } from '../src/core/rng.js';
import { erf, normCdf, normUpperTail, normInv, returnMoments, perPeriodSharpe,
  annualizeSharpe, psr, minBacktestLength, expectedMaxSharpe, deflatedSharpe,
  returnsFromEquity } from '../src/validation/statTests.js';

const NEAR = (a, b, tol) => Math.abs(a - b) <= tol;

test('normCdf / erf 对齐 Python 参考值', () => {
  assert.ok(Math.abs(erf(0)) < 1e-7, `erf(0) 应≈0，实际 ${erf(0)}`);
  assert.ok(NEAR(erf(1), 0.8427007929497149, 2e-7), `erf(1) 实际 ${erf(1)}`);
  assert.ok(NEAR(normCdf(0), 0.5, 1e-7));
  assert.ok(NEAR(normCdf(1.959963984540054), 0.975, 2e-7), `Φ(1.96) 实际 ${normCdf(1.959963984540054)}`);
  assert.ok(NEAR(normCdf(-1.2815515655446004), 0.10, 2e-7));
  // 尾部必须走 Mills 展开：A-S 的绝对误差 1.5e-7 与 Q(5)=2.9e-7 同量级，1-Φ 会直接算成 0
  assert.ok(normUpperTail(5) > 2.8e-7 && normUpperTail(5) < 3.05e-7, `Q(5) 实际 ${normUpperTail(5)}`);
  assert.ok(normCdf(8) > 0.99999999 && normCdf(8) < 1, 'Φ(8) 要接近 1 但不许饱和成 1，否则 p 值假精确');
});

test('normInv 对齐参考值并双向自洽', () => {
  // 容差是按实测误差给的，不是理论值：Φ 用 A-S 7.1.26（|误差|≈1.4e-7，实测过），
  // 反解时要把这个误差除以尾部概率密度 —— p 越小放大越多。
  // 实测：p∈[0.01,0.99] 中心区 ~1e-6；p=1e-3 处 ~2e-5。对 DSR/MinTRL 用的 z（1.6~2.5）影响在 1e-7 量级。
  assert.ok(NEAR(normInv(0.975), 1.9599639845400545, 3e-6), `实际 ${normInv(0.975)}`);
  assert.ok(NEAR(normInv(0.95), 1.6448536269514715, 3e-6), `实际 ${normInv(0.95)}`);
  assert.ok(NEAR(normInv(0.01), -2.3263478740410894, 3e-6), `实际 ${normInv(0.01)}`);
  assert.ok(NEAR(normInv(0.001), -3.090232306167822, 5e-5), `实际 ${normInv(0.001)}`);
  assert.ok(NEAR(normInv(1e-6), -4.753424308822698, 5e-4), `实际 ${normInv(1e-6)}`);
  assert.ok(Math.abs(normInv(0.5)) < 3e-6);
  for (const p of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
    assert.ok(NEAR(normCdf(normInv(p)), p, 2e-7), `Φ(Φ⁻¹(${p})) 不自洽`);
  }
  assert.eq(normInv(0), -Infinity, 'p=0 要给 -Inf，而不是编一个大数');
  assert.ok(Number.isNaN(normInv(1.5)), '越界概率返回 NaN');
});

test('returnMoments 对齐 Python 手算：sd 用样本(n-1)，skew/kurt 用总体中心矩且 kurt 非超额', () => {
  const xs = [1, -2, 0.5, 3, -1.5, 2.5, -0.5, 4, -3, 0];
  const m = returnMoments(xs);
  assert.ok(NEAR(m.mean, 0.4, 1e-12));
  assert.ok(NEAR(m.sd, 2.2705848487901865, 1e-12), `样本 sd 实际 ${m.sd}`);
  assert.ok(NEAR(m.skew, 0.12936641824511225, 1e-9), `skew 实际 ${m.skew}`);
  assert.ok(NEAR(m.kurt, 1.9218285523186682, 1e-9), `kurt(非超额) 实际 ${m.kurt}`);
  assert.ok(m.kurt < 3, '这组数据比正态平坦，非超额峰度该低于 3');
  assert.eq(perPeriodSharpe(xs), m.mean / m.sd, '单期夏普 = mean ÷ 样本 sd');
  assert.ok(NEAR(annualizeSharpe(0.05, 252), 0.05 * Math.sqrt(252), 1e-12), '年化 = ×√周期数');
  assert.eq(returnMoments([1, 2]).sd, null, '样本 <3 要如实报 null，不硬算');
});

test('PSR / MinTRL 对齐 Python 参考值', () => {
  assert.ok(NEAR(psr({ sr: 0.05, T: 250, skew: 0, kurt: 3, srStar: 0 }), 0.784796107435966, 5e-6),
    `PSR 实际 ${psr({ sr: 0.05, T: 250, skew: 0, kurt: 3, srStar: 0 })}`);
  assert.ok(NEAR(minBacktestLength({ sr: 0.05, skew: 0, kurt: 3, alpha: 0.95 }), 1084.5701533652118, 1e-2),
    `MinTRL 实际 ${minBacktestLength({ sr: 0.05, skew: 0, kurt: 3, alpha: 0.95 })}`);
  assert.ok(minBacktestLength({ sr: -0.05 }) === null, '负夏普没有"最短回测"可言');
  assert.ok(psr({ sr: 0.05, T: 2 }) === null, 'T<=2 不许算');
  assert.ok(psr({ sr: 0.5, T: 500, skew: 2, kurt: 0.2 }) === null, '修正项翻负时返回 null，不给假概率');
  // 口径搞错的后果要钉在这里：把年化 0.8 当单期 SR 代进去，PSR 会假到接近 1
  assert.ok(psr({ sr: 0.8, T: 250, skew: 0, kurt: 3, srStar: 0 }) > 0.9999,
    '这就是必须喂单期夏普的原因');
});

test('E[max SR] 闭式与真值/蒙特卡洛的偏差方向要写清楚', () => {
  const exact2 = 0.5641895835477563;            // 2 个标准正态最大者的期望 = 1/√π
  const f2 = expectedMaxSharpe({ srMean: 0, srStd: 1, nTrials: 2 });
  assert.ok(f2 < exact2, 'N=2 时闭式偏低（已知偏差，别拿它给"只试了两组"的结果撑腰）');
  assert.ok(Math.abs(f2 / exact2 - 1) < 0.10, `N=2 偏差应在 10% 内，实际 ${f2 / exact2 - 1}`);
  const f10 = expectedMaxSharpe({ srMean: 0, srStd: 1, nTrials: 10 });
  assert.ok(Math.abs(f10 / 1.5381 - 1) < 0.04, `N=10 应在 4% 内（Python MC=1.5381），实际 ${f10}`);
  const f50 = expectedMaxSharpe({ srMean: 0, srStd: 1, nTrials: 50 });
  assert.ok(Math.abs(f50 / 2.249 - 1) < 0.03, `N=50 应在 3% 内（MC=2.249），实际 ${f50}`);
  assert.ok(f50 > f10 && f10 > f2, '期望最大值要随试验次数单调上升');
});

test('DSR 的两种情形：一个鹤立鸡群 → 自信；大家同一水平里挑冠军 → 不该自信', () => {
  // 情形一：199 个平庸 config（SR 在 0.04~0.06 之间均匀铺开）+ 1 个真的好的（0.50），T=500
  const trials = [];
  for (let i = 0; i < 199; i++) trials.push({ sr: 0.04 + i * 0.0001, skew: 0, kurt: 3, T: 500 });
  trials.push({ sr: 0.50, skew: 0, kurt: 3, T: 500 });
  const d = deflatedSharpe(trials);
  assert.ok(d && d.dsr > 0.99, `鹤立鸡群时 DSR 该接近 1，实际 ${d && d.dsr}`);
  assert.ok(d.sr0Star < 0.5, `基准应仍低于实测最优：${d.sr0Star}`);
  // 情形二：200 个 config 全体在同一水平上散布（-0.1..0.5），最优 0.4955 —— 冠军只是抽样的产物
  const flat = [];
  const rng = makeRng(11);
  for (let i = 0; i < 200; i++) flat.push({ sr: -0.1 + rng() * 0.6, skew: 0, kurt: 3, T: 250 });
  const f = deflatedSharpe(flat);
  assert.ok(f.dsr < 0.1, `同水平竞争里挑出的冠军不该被判为真，实际 DSR=${f.dsr}`);
  // 拉长样本只是把 z 推得更极端，方向取决于最优值在基准哪一侧：
  // 高于挑选基准 → DSR 升；低于基准 → DSR 压向 0。后者正是这批扁平竞争该有的结论：
  // 数据越多，越能证明那个冠军只是抽样的产物。
  const flatLong = flat.map(t => ({ ...t, T: 2500 }));
  assert.ok(deflatedSharpe(flatLong).dsr < f.dsr, 'best 低于基准时，样本越长越该确信它不是真的');
  const standLong = trials.map(t => ({ ...t, T: 2000 }));
  assert.ok(deflatedSharpe(standLong).dsr >= d.dsr, 'best 高于基准时，样本越长 DSR 越高');
  // 有效试验数被上报得更多时，DSR 必须下降
  assert.ok(deflatedSharpe(trials, { nTrials: 5000 }).dsr < d.dsr, 'nTrials 变大 DSR 要变小');
  assert.eq(deflatedSharpe([trials[0]]), null, '只有一条试验估不出 σ_SR，要拒绝而不是给 1');
  const best = Math.max(...flat.map(t => t.sr));
  const undef = psr({ sr: best, T: 250, skew: 0, kurt: 3, srStar: 0 });
  assert.ok(f.dsr < undef, `DSR(${f.dsr}) 必须低于未扣挑选偏差的 PSR(${undef})`);
});

test('纯噪声里挑冠军：DSR 必须把未扣偏差的自信压下来', () => {
  const rng = makeRng(20261015);
  const T = 500;
  const trials = [];
  for (let i = 0; i < 200; i++) {
    const r = [];
    for (let t = 0; t < T; t++) r.push((rng() + rng() + rng() + rng() + rng() + rng() - 3) / 1.2 * 0.01);
    const m = returnMoments(r);
    trials.push({ sr: m.mean / m.sd, skew: m.skew, kurt: m.kurt, T });
  }
  const best = trials.reduce((a, b) => (b.sr > a.sr ? b : a), trials[0]);
  const undeflated = psr({ sr: best.sr, T, skew: best.skew, kurt: best.kurt, srStar: 0 });
  const d = deflatedSharpe(trials);
  assert.eq(d.nTrials, 200);
  assert.ok(d.dsr < undeflated, `200 次真·零期望试验里的冠军，DSR(${d.dsr}) 该低于 PSR(${undeflated})`);
  assert.ok(d.dsr < 0.9, `纯噪声不该被判成"真的更好"，实际 ${d.dsr}`);
  assert.ok(Math.abs(best.sr * Math.sqrt(T)) < 4.5, `噪声里最大 z 值应有限，实际 ${best.sr * Math.sqrt(T)}`);
});

test('returnsFromEquity：真实爆仓(-100%)要保留，除不了零的那种才跳', () => {
  const curve = [{ equity: 100 }, { equity: 110 }, { equity: 99 }, { equity: 0 }, { equity: 100 }];
  const r = returnsFromEquity(curve);
  assert.eq(r.length, 3, `100→110、110→99、99→0 三条；0→100 除零跳过。实际 ${r.length}`);
  assert.ok(NEAR(r[0], 0.1, 1e-12) && NEAR(r[1], -0.1, 1e-12), `实际 ${r}`);
  assert.ok(NEAR(r[2], -1, 1e-12), `归零就是 -100%，不能当没发生过：${r[2]}`);
  assert.eq(returnsFromEquity([]).length, 0);
});
