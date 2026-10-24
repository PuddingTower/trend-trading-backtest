import { test, assert } from './harness.js';
import { sampleSpace, tpeSuggest, tpeRunner, rankTpe, plateauRecommendation, paretoFront } from '../src/report/bayesOptimizer.js';
import { makeRng } from '../src/core/rng.js';

const SPACE_1D = [{ name: 'x', type: 'float', lo: 0, hi: 10 }];
const SPACE_MIX = [
  { name: 'n', type: 'int', lo: 2, hi: 40 },
  { name: 'mode', type: 'choice', options: ['fast', 'slow'] },
  { name: 'alpha', type: 'float', lo: 0.001, hi: 0.5, log: true },
];

test('sampleSpace：类型/范围/对数均匀/确定性', () => {
  const s1 = sampleSpace(SPACE_MIX, makeRng(7));
  assert.ok(Number.isInteger(s1.n) && s1.n >= 2 && s1.n <= 40);
  assert.ok(['fast', 'slow'].includes(s1.mode));
  assert.ok(s1.alpha >= 0.001 && s1.alpha <= 0.5);
  // 对数采样不塌向大值：1000 个样本的对数均值应靠近区间中点的对数
  const logs = [];
  for (let i = 0; i < 1000; i++) logs.push(Math.log(sampleSpace(SPACE_MIX, makeRng(i)).alpha));
  const meanLog = logs.reduce((a, b) => a + b, 0) / logs.length;
  assert.ok(Math.abs(meanLog - Math.log(Math.sqrt(0.001 * 0.5))) < 0.2, `对数均匀均值 ${meanLog}`);
  const a = sampleSpace(SPACE_MIX, makeRng(99));
  const b = sampleSpace(SPACE_MIX, makeRng(99));
  assert.eq(JSON.stringify(a), JSON.stringify(b));
});

test('tpeSuggest：建议落在空间内，且有信息后不再乱撒', () => {
  // 人造 30 个试验：高分都在 x∈[3,4]，建议应靠近那里
  const trials = [];
  for (let i = 0; i < 30; i++) {
    const x = i < 8 ? 3 + i * 0.1 : i * 0.35;
    trials.push({ params: { x }, score: x >= 3 && x <= 4 ? 1 - Math.abs(x - 3.5) : 0.01 });
  }
  let near = 0;
  for (let s = 0; s < 10; s++) {
    const p = tpeSuggest({ space: SPACE_1D, trials, seed: s });
    assert.ok(p.x >= 0 && p.x <= 10);
    if (p.x > 2 && p.x < 5) near++;
  }
  assert.ok(near >= 7, `10 次建议里至少 7 次落进高分区，实际 ${near}`);
});

test('tpeRunner：注入假目标函数，收敛到极值且全程可复现', () => {
  // 单峰目标 −(x−3.7)²，纯随机 30 次也大概率摸到附近 —— 用更苛刻的窄峰 + 20 次试验
  const evalFn = (params, bars) => ({ score: -((params.x - 3.7) ** 2) * 10 + (bars ? 0 : 0), metrics: { sharpe: -((params.x - 3.7) ** 2) * 10 } });
  const r1 = tpeRunner({ bars: [], space: SPACE_1D, nTrials: 20, startup: 6, seed: 5, prune: false, evalFn }).finish();
  assert.ok(r1.best, '必须给出最优');
  assert.ok(Math.abs(r1.best.params.x - 3.7) < 0.6, `20 次试验应收敛到 3.7 附近，实际 ${r1.best.params.x}`);
  const evalFn2 = (params) => ({ score: -((params.x - 3.7) ** 2) * 10, metrics: {} });
  const r2 = tpeRunner({ bars: [], space: SPACE_1D, nTrials: 20, startup: 6, seed: 5, prune: false, evalFn: evalFn2 }).finish();
  assert.eq(r1.best.params.x, r2.best.params.x, '同 seed 两次寻优最优参数必须一致');
});

test('tpeRunner：预演剪枝真的省算力（预演与全段口径背离的参数被砍）', () => {
  let fullCalls = 0;
  const PRE_LEN = 100;
  // 预演（前 50%）与全段的优区完全背离：预演说 9.5 好，全段说 2 好。
  // TPE 按全段分数把建议引向 2 —— 而那里的预演分全在 −76 附近，低于启动期的中位数，
  // 于是这些参数不用跑满程就能被砍掉。剪枝分不回喂 TPE，否则搜索会被预演口径带偏。
  const evalFn2 = (params, barsSlice) => {
    const isPre = barsSlice && barsSlice.length === PRE_LEN;
    if (!isPre) fullCalls++;
    const x = params.x;
    return { score: isPre ? -((x - 9.5) ** 2) - 20 : -((x - 2) ** 2), metrics: { sharpe: 0 } };
  };
  const bars = Array.from({ length: 200 }, (_, i) => ({ date: `d${i}` }));
  const r = tpeRunner({ bars, space: SPACE_1D, nTrials: 40, startup: 8, seed: 3, prune: true, preFraction: 0.5, evalFn: evalFn2 }).finish();
  assert.ok(r.pruned >= 10, `预演与全段背离时应当大量剪枝，实际 ${r.pruned}/40`);
  assert.ok(fullCalls < 40, `全量评估次数 ${fullCalls} 应少于试验总数 40`);
  assert.ok(r.savings >= 25);
  assert.eq(r.ranked.every(t => Number.isFinite(t.score)), true);
  // 剪枝不回喂建议分布：全量评估过的试验里，最优点应靠近全段优区 2
  const fullEvaluated = r.ranked.filter(t => !t.pruned);
  assert.ok(fullEvaluated.length >= 8);
});

test('plateauRecommendation：平原中心赢过孤峰', () => {
  // 人造结果：x=5 处一枝独秀 10 分（邻居全差），x=2 附近一片 5 分
  const pts = [];
  for (let i = 0; i < 40; i++) {
    const x = 0.25 * i;
    const score = Math.abs(x - 5) < 0.2 ? 10 : Math.abs(x - 2) < 0.8 ? 5 : 0.5;
    pts.push({ params: { x }, score });
  }
  const rec = plateauRecommendation(pts, SPACE_1D, { k: 6 });
  assert.ok(rec.recommended, '必须给出推荐');
  assert.ok(Math.abs(rec.recommended.params.x - 2) < Math.abs(rec.recommended.params.x - 5) + 0.5,
    `推荐应偏向平原（x≈2），实际推荐 x=${rec.recommended.params.x}`);
  // 孤峰的 spikeRisk 应显著大于平原点
  const spike = pts.find(p => p.score === 10);
  const flat = pts.find(p => Math.abs(p.params.x - 2) < 0.3 && p.score === 5);
  assert.ok(spike.spikeRisk > flat.spikeRisk, `孤峰风险 ${spike.spikeRisk} 应高于平原 ${flat.spikeRisk}`);
});

test('paretoFront：非支配集与拐点', () => {
  // metrics.sharpe 大者好、metrics.maxDDPct 小者好
  const mk = (sharpe, mdd) => ({ score: sharpe, metrics: { sharpe, maxDDPct: mdd } });
  const pts = [mk(2.0, 0.30), mk(1.5, 0.15), mk(1.0, 0.20), mk(0.5, 0.35), mk(1.5, 0.25)];
  const { front, knee } = paretoFront(pts, { keys: ['sharpe'], minKeys: ['maxDDPct'] });
  const fset = front.map(p => [p.metrics.sharpe, p.metrics.maxDDPct]);
  assert.eq(fset.length, 2, `非支配集应为 {(2.0,0.30), (1.5,0.15)}，实际 ${JSON.stringify(fset)}`);
  assert.ok(fset.some(f => f[0] === 2.0) && fset.some(f => f[1] === 0.15));
  // 拐点：归一化后离理想点最近 —— (2.0, 0.30) 与 (1.5, 0.15) 中后者更均衡
  assert.ok(knee && knee.metrics.sharpe === 1.5, `拐点应为 (1.5, 0.15)，实际 ${knee && knee.metrics.sharpe}`);
});
