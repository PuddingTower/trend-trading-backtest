import { test, assert } from './harness.js';
import { atrRiskSize, notionalSize, annualizedVol, volTargetSize, kellyFraction, correlationMatrix, riskParityWeights, diversificationScore } from '../src/core/sizing.js';

test('atrRiskSize：权益×风险比例 / (ATR×倍数×乘数)，算不满 1 手就给 0', () => {
  // 权益 20 万、单笔风险 1% = 2000 元；ATR 50、止损 2ATR=100 点、乘数 10 → 每手风险 1000 元 → 2 手
  assert.eq(atrRiskSize({ equity: 200000, atrValue: 50, atrMult: 2, multiplier: 10, riskPct: 0.01 }), 2);
  assert.eq(atrRiskSize({ equity: 200000, atrValue: 50, atrMult: 2, multiplier: 10, riskPct: 0.02 }), 4, '风险翻倍手数翻倍');
  assert.eq(atrRiskSize({ equity: 5000, atrValue: 50, atrMult: 2, multiplier: 10, riskPct: 0.01 }), 0,
    '5000 元账户开这手要冒 20% 风险，必须给 0 而不是凑 1 手');
  assert.eq(atrRiskSize({ equity: 200000, atrValue: 50, atrMult: 2, multiplier: 10, riskPct: 0.01, maxLots: 1 }), 1, '上限要生效');
  assert.eq(atrRiskSize({ equity: 0, atrValue: 50, multiplier: 10 }), 0);
  assert.eq(atrRiskSize({ equity: 1e6, atrValue: 0, multiplier: 10 }), 0, 'ATR 缺失时不许瞎给仓位');
});

test('notionalSize 与 volTargetSize：两种资金口径', () => {
  // 保证金占用 = 价×乘数×保证金率；权益 20 万、25% 敞口 → 5 万 / (3800×10×0.1=3800) = 13 手
  assert.eq(notionalSize({ equity: 200000, price: 3800, multiplier: 10, marginRate: 0.1, pct: 0.25 }), 13);
  assert.eq(notionalSize({ equity: 200000, price: 3800, multiplier: 10, marginRate: 0.1, pct: 0.25, maxLots: 5 }), 5);
  assert.eq(notionalSize({ equity: 1000, price: 3800, multiplier: 10, marginRate: 0.1, pct: 0.25 }), 0);

  // 权益 100 万、目标波动 10%、品种年化波动 20% → 名义 50 万 / (100×100) = 50 手
  assert.eq(volTargetSize({ equity: 1e6, price: 100, multiplier: 100, vol: 0.20, targetVolPct: 0.10 }), 50);
  assert.eq(volTargetSize({ equity: 1e6, price: 100, multiplier: 100, vol: null }), 0, '波动率算不出就不给仓位');
});

test('annualizedVol：样本不足返回 null，波动大小关系正确', () => {
  const calm = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 7) * 0.2);
  const wild = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 2.5) * 6);
  assert.ok(annualizedVol(wild) > annualizedVol(calm));
  assert.eq(annualizedVol([1, 2, 3, 4]), null, '样本 <21 给 null，而不是给个看着正常的假数');
  assert.eq(annualizedVol([]), null);
});

test('kellyFraction：期望为负时给 0 并说明，全 Kelly 与半 Kelly 分开返回', () => {
  const good = kellyFraction({ winRate: 0.45, payoffRatio: 2.2 });
  assert.near(good.fullValue, 0.45 - 0.55 / 2.2, 1e-9);
  assert.near(good.half, good.fullValue / 2, 1e-9, '半 Kelly 是一半');
  const bad = kellyFraction({ winRate: 0.3, payoffRatio: 1.0 });
  assert.ok(bad.fullValue < 0);
  assert.eq(bad.half, 0, '期望为负时仓位必须是 0，不能给负仓位当"做空建议"');
  assert.ok(/期望为负/.test(bad.note));
  assert.eq(kellyFraction({ winRate: 0.5, payoffRatio: 0 }).half, 0, '盈亏比拿不到时不猜');
  assert.eq(kellyFraction({ winRate: NaN, payoffRatio: 2 }).half, 0);
});

test('correlationMatrix：完全同向为 1、反向为 -1、对称且对角为 1', () => {
  const a = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112];
  const b = a.map(x => x * 2);
  // 反向序列必须按"收益率取反"构造。用 220-x 这种线性镜像，收益率并非精确相反
  // （比值变换不是线性变换），相关性只会接近 -1 而不是等于 -1。
  const c = [100];
  for (let i = 1; a.length > i; i++) c.push(c[i - 1] * (1 - (a[i] / a[i - 1] - 1)));
  const d = [100, 103, 101, 106, 102, 108, 104, 110, 105, 112, 107, 114, 109];
  const { matrix, usable } = correlationMatrix([a, b, c, d]);
  assert.eq(usable, true);
  assert.eq(matrix.length, 4);
  assert.eq(matrix[0][0], 1);
  assert.near(matrix[0][1], 1, 1e-6, '完全同向相关性=1');
  assert.near(matrix[0][2], -1, 1e-6, '完全反向=-1');
  assert.near(matrix[0][3], matrix[3][0], 1e-9, '矩阵必须对称');
  assert.ok(matrix[0][3] < 0.6 && matrix[0][3] > -0.6, '锯齿序列不该给出极端相关');
  assert.eq(correlationMatrix([[1, 2], [3, 4]]).usable, false, '样本太少要如实说不可用');
});

test('riskParityWeights：低波动拿到更高权重且归一', () => {
  const w = riskParityWeights([0.10, 0.40, 0.20]);
  assert.near(w.reduce((a, b) => a + b, 0), 1, 1e-9);
  assert.ok(w[0] > w[2] && w[2] > w[1], '波动最小的拿最多');
  assert.near(w[0] / w[1], 4, 1e-9, '权重与波动成反比');
  assert.eq(riskParityWeights([0, 0]).reduce((a, b) => a + b, 0), 1, '全 0 波动退回等权而不是 NaN');
  assert.near(riskParityWeights([null, 0.2])[0], 0, '算不出波动的品种权重记 0，由上层提示而不是悄悄给一半');
});

test('diversificationScore：把平均相关性翻译成人能读的结论', () => {
  const high = [[1, 0.95], [0.95, 1]];
  const low = [[1, 0.1], [0.1, 1]];
  assert.ok(/一个头寸/.test(diversificationScore(high).note));
  assert.ok(diversificationScore(low).score > diversificationScore(high).score, '分散度分数方向要正确');
  assert.eq(diversificationScore([[1]]).score, null, '单品种谈不上分散');
});
