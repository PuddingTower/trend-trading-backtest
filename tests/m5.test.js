import { test, assert } from './harness.js';
import { OBJECTIVES, gridPlans, runOne, gridRunner, neighborhoodScore, walkForward } from '../src/report/optimizer.js';
import { allocateWeights, seriesVolatility, runPortfolio } from '../src/core/portfolio.js';
import { monthlyReturns, underwaterSeries, tradeDistribution, benchmarkSeries, reportToCsv, reportToHtml } from '../src/report/advanced.js';

const mk = (date, o, h, l, c, v = 1000) => ({ date, open: o, high: h, low: l, close: c, volume: v });
const SPEC = { multiplier: 10, tick: 1, marginRate: 0.1, fee: { mode: 'fixed', value: 4 }, market: 'futures' };

/** 确定性上涨序列：策略口径可手算，避免随机数据让断言飘。 */
function upSeries(n, start = 100, step = 1) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const p = start + i * step;
    bars.push(mk(`2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String(i % 28 + 1).padStart(2, '0')}`, p, p + 1, p - 1, p + 0.5));
  }
  return bars;
}
/** 只要 warm 根之后一路做多，参数 warm 影响入场早晚 —— 足够用来验证寻优框架。 */
const fakeStrategy = {
  id: 'fakeUp', name: '测试用趋势',
  params: { warm: 5 },
  signals(bars, p = {}) {
    const q = { ...this.params, ...p };
    return bars.map((b, i) => (i >= q.warm ? { i, dir: 1, reason: 'fake' } : null));
  }
};

// ---------- 网格 ----------
test('gridPlans：笛卡尔积、键名排序、基数合并与非法组合过滤', () => {
  const plans = gridPlans({ a: 0 }, { slow: [30, 20], fast: [5, 10] });
  assert.eq(plans.length, 4);
  // 键名先排序：否则同一份网格换个书写顺序，名次表整体错位，"上次的最佳参数"复现不出来。
  // 注意值保持书写顺序（[30,20] 就按 30、20 走）—— 用户写的网格次序不该被偷偷重排。
  assert.eq(JSON.stringify(plans[0]), JSON.stringify({ a: 0, fast: 5, slow: 30 }));
  const reordered = gridPlans({ a: 0 }, { fast: [5, 10], slow: [30, 20] });
  assert.eq(JSON.stringify(plans), JSON.stringify(reordered), '书写键的顺序不该影响展开结果');
  assert.eq(JSON.stringify(plans[plans.length - 1]), JSON.stringify({ a: 0, fast: 10, slow: 20 }));
  const filtered = gridPlans({ fast: 1, slow: 2 }, { fast: [1, 9], slow: [2] }, { validate: p => p.fast < p.slow });
  assert.eq(filtered.length, 1, 'fast>=slow 的组合应被剔除');
  assert.eq(gridPlans({ a: 1 }, {}).length, 1, '空网格也要返回基准参数那一组');
});

test('OBJECTIVES：亏光的 run 一律 -Infinity，不能排到中间冒充"成绩平庸"', () => {
  assert.eq(OBJECTIVES.sharpe.get({ ruined: true, sharpe: 1.2 }), -Infinity);
  assert.eq(OBJECTIVES.net.get({ ruined: true, finalEquity: 50000, capital: 100000 }), -Infinity);
  assert.eq(OBJECTIVES.sharpe.get({ ruined: false, sharpe: null }), -Infinity);
  assert.eq(OBJECTIVES.net.get({ ruined: false, finalEquity: 120000, capital: 100000 }), 20000);
});

test('runOne 与 gridRunner：同参数两次运行结果逐字节一致（确定性总闸）', () => {
  const bars = upSeries(60);
  const a = runOne({ bars, spec: SPEC, strategy: fakeStrategy, params: { warm: 5 }, engineOpts: { capital: 100000, lots: 1 } });
  const b = runOne({ bars, spec: SPEC, strategy: fakeStrategy, params: { warm: 5 }, engineOpts: { capital: 100000, lots: 1 } });
  assert.eq(JSON.stringify(a.trades), JSON.stringify(b.trades), '成交列表必须完全一致');
  assert.eq(JSON.stringify(a.equityCurve), JSON.stringify(b.equityCurve), '权益曲线必须完全一致');

  const runner = gridRunner({ bars, spec: SPEC, strategy: fakeStrategy, baseParams: {}, grids: { warm: [3, 6, 9] }, objective: 'net' });
  assert.eq(runner.total, 3);
  let got = 0;
  while (!runner.done()) got += runner.step(2).length;   // 分块跑，UI 靠这个交还主线程
  assert.eq(got, 3, '分块推进必须覆盖全部组合');
  // UI 的典型用法就是先把迭代器跑完再收尾：finish() 必须返回全部结果，
  // 只返回"剩下没跑的"会让界面显示成"一个参数都没跑出来"
  const ranked = runner.finish();
  assert.eq(ranked.length, 3, 'finish() 在分块跑完之后仍要给出全部结果');
  assert.ok(ranked[0].score >= ranked[1].score && ranked[1].score >= ranked[2].score, '必须按目标降序');
  assert.eq(ranked[0].rank, 1);
  assert.near(ranked[0].percentile, 1, 1e-9, '第一名分位为 1');
});

test('neighborhoodScore：最优参数每个维度 ±1 档都要落进邻域表', () => {
  const bars = upSeries(80);
  const grids = { warm: [4, 6, 8, 10] };
  const best = { warm: 6 };
  const nb = neighborhoodScore({ bars, spec: SPEC, strategy: fakeStrategy, best, grids, objective: 'net' });
  assert.eq(nb.variants.length, 2, '中间值应有左右各一档');
  assert.eq(nb.variants.map(v => v.value).sort((a, b) => a - b).join(','), '4,8');
  const edge = neighborhoodScore({ bars, spec: SPEC, strategy: fakeStrategy, best: { warm: 4 }, grids, objective: 'net' });
  assert.eq(edge.variants.length, 1, '贴在网格边缘只有一侧邻域');
});

// ---------- Walk-forward ----------
test('walkForward：数据不足要报错而不是硬跑', () => {
  const r = walkForward({ bars: upSeries(50), spec: SPEC, strategy: fakeStrategy, baseParams: {}, grids: { warm: [3] } });
  assert.ok(r.error && /不够/.test(r.error), `应给出数据不足说明，实际 ${JSON.stringify(r)}`);
});

test('walkForward：样本外用样本内选出的参数，段数与拼接曲线可核对', () => {
  const bars = upSeries(300);
  const r = walkForward({
    bars, spec: SPEC, strategy: fakeStrategy, baseParams: {},
    grids: { warm: [3, 30, 60] }, objective: 'net', isLen: 100, oosLen: 50, stepLen: 50,
    embargoBars: 0                    // 这一条测的是滚动结构，缝宽另测；0 = 显式退回旧口径
  });
  assert.ok(!r.error, r.error || '');
  // cursor 0,50,100,150,200 → 200+100+50=350 > 300，所以到 150 为止共 4 段
  assert.eq(r.windows.length, 4, `滚动窗口数应为 4，实际 ${r.windows.length}`);
  for (const w of r.windows) {
    assert.eq(w.oosStartIdx, w.isEndIdx + 1, '显式 0 缝宽时才允许紧接样本内之后，且不许重叠');
    assert.ok(w.best.warm !== undefined, '每段都要有选出的参数');
    assert.eq(Object.keys(w.best).length, 1);
  }
  assert.ok(r.combinedEquity.length > 100, '拼接曲线应覆盖全部样本外 bar');
  assert.eq(r.combinedEquity[0].equity, r.windows[0].oosMetrics.capital, '曲线起点等于初始资金');
  const last = r.combinedEquity[r.combinedEquity.length - 1];
  assert.ok(Number.isFinite(last.equity) && last.equity > 0);
  assert.eq(r.summary.segments, 4);
  assert.ok(Number.isFinite(r.summary.totalReturn));
  assert.ok(r.summary.efficiency === null || Number.isFinite(r.summary.efficiency));
  // 参数漂移：上涨行情里 warm 越小入场越早、赚得越多，所以各段应稳定选最小值 → 漂移 0 次
  assert.eq(r.drift.warm.changes, 0, `上涨段里参数不该乱跳，实际换了 ${r.drift.warm.changes} 次`);
});

test('walkForward：auto 净化间隔把样本外推离样本内尾端', () => {
  const bars = upSeries(300);
  const args = { bars, spec: SPEC, strategy: fakeStrategy, baseParams: {},
                 grids: { warm: [3, 30, 60] }, objective: 'net', isLen: 100, oosLen: 50, stepLen: 50 };
  const r = walkForward(args);                       // 默认 embargoBars:'auto'
  assert.ok(!r.error, r.error || '');
  assert.ok(r.windows.length > 0, '留得出间隔就还有窗口');
  for (const w of r.windows) {
    assert.ok(w.embargoBars >= 1, `auto 口径下缝宽至少 1 根，实际 ${w.embargoBars}`);
    assert.eq(w.oosStartIdx, w.isEndIdx + 1 + w.embargoBars, '样本外起点 = 样本内末根 + 1 + 缝宽');
    assert.ok(w.oosStartIdx > w.isEndIdx + 1, '不许再贴着样本内起步：跨缝持仓会偷渡进考卷');
    assert.ok(w.embargoBars <= (args.isLen >> 2), `缝宽不该吃掉样本内的一半以上，实际 ${w.embargoBars}`);
  }
  assert.ok(r.summary.minEmbargoBars >= 1, '缝宽要进报表，不能是个隐形设置');
  const zero = walkForward({ ...args, embargoBars: 0 });
  assert.ok(zero.windows.length > r.windows.length,
    `零间隙能塞下更多窗口：${zero.windows.length} vs ${r.windows.length}`);
  assert.eq(zero.windows[0].oosStartIdx, zero.windows[0].isEndIdx + 1);
});

test('walkForward：样本外权益按因子连乘，不是把各段金额相加', () => {
  const bars = upSeries(240);
  const r = walkForward({ bars, spec: SPEC, strategy: fakeStrategy, baseParams: {}, grids: { warm: [5] }, isLen: 100, oosLen: 40, stepLen: 40 });
  assert.ok(!r.error, r.error || '');
  let manual = r.windows[0].oosMetrics.capital;
  for (const w of r.windows) manual *= w.oosFactor;
  assert.near(r.summary.totalReturn + 1, manual / r.windows[0].oosMetrics.capital, 1e-6, '连乘口径必须一致');
});

// ---------- 组合 ----------
test('allocateWeights：等权 / 逆波动率 / 手动三种口径都归一', () => {
  const calm = upSeries(60, 100, 0.2);
  const wild = upSeries(60, 100, 4);
  const eq = allocateWeights([{ symbol: 'A' }, { symbol: 'B' }], 'equal');
  assert.eq(eq[0].weight, 0.5);
  const iv = allocateWeights([{ symbol: 'A', bars: calm }, { symbol: 'B', bars: wild }], 'inverseVol');
  assert.ok(iv[0].weight > iv[1].weight, '低波动的品种该分到更多资金');
  assert.near(iv[0].weight + iv[1].weight, 1, 1e-9, '权重必须归一');
  const mn = allocateWeights([{ symbol: 'A', weight: 3 }, { symbol: 'B', weight: 1 }], 'manual');
  assert.near(mn[0].weight, 0.75, 1e-9);
  const zero = allocateWeights([{ symbol: 'A', weight: 0 }, { symbol: 'B', weight: 0 }], 'manual');
  assert.near(zero[0].weight, 0.5, 1e-9, '全给 0 时退回等权，而不是除零算出 NaN');
  assert.ok(seriesVolatility(calm) > 0 && seriesVolatility(wild) > seriesVolatility(calm));
  assert.eq(seriesVolatility([]), null);
});

test('runPortfolio：分仓资金、按日期对齐合并、逐品种独立规则', () => {
  const a = upSeries(90, 100, 1);
  const b = upSeries(90, 500, 2);
  const res = runPortfolio({
    entries: [
      { symbol: 'A', name: '甲', bars: a, spec: SPEC, strategy: fakeStrategy, params: { warm: 3 } },
      { symbol: 'B', name: '乙', bars: b, spec: SPEC, strategy: fakeStrategy, params: { warm: 3 } }
    ], capital: 200000, weights: 'equal'
  });
  assert.ok(!res.error, res.error || '');
  assert.eq(res.allocation.length, 2);
  assert.near(res.allocation[0].capital, 100000, 1e-6, '等权各分一半');
  const last = res.combinedEquity[res.combinedEquity.length - 1];
  const sum = res.perSymbol[0].metrics.finalEquity + res.perSymbol[1].metrics.finalEquity;
  assert.near(last.equity, sum, 0.5, '合并权益末值应等于两品种权益末值之和');
  assert.ok(res.metrics.trades >= 2);
  assert.ok(res.note && /不共享保证金池/.test(res.note), '必须把局限写进返回值，让上层无法假装这是真实组合账本');
});

test('runPortfolio：日期不齐时按日期取并集，缺失日不动', () => {
  const a = upSeries(40, 100, 1);
  const b = a.slice(0, 20).concat(upSeries(20, 300, 1).map((x, i) => ({ ...x, date: a[20 + i].date })));
  b[25] = { ...b[25], date: '2024-99-99' };    // 人为插入一个只属于 b 的日期
  const res = runPortfolio({
    entries: [
      { symbol: 'A', bars: a, spec: SPEC, strategy: fakeStrategy, params: { warm: 3 } },
      { symbol: 'B', bars: b, spec: SPEC, strategy: fakeStrategy, params: { warm: 3 } }
    ], capital: 100000
  });
  const dates = res.combinedEquity.map(p => p.date);
  assert.eq(new Set(dates).size, dates.length, '合并后的日期不能重复');
  assert.ok(dates.includes('2024-99-99'), '只属于一个品种的日期也要进并集');
});

test('runPortfolio：合并保证金超上限时整体等比缩仓并如实报告', () => {
  const bars = upSeries(120, 100, 1);
  const mkEntry = (s) => ({ symbol: s, bars, spec: { ...SPEC, marginRate: 0.5 }, strategy: fakeStrategy, params: { warm: 2 }, engineOpts: { lots: 40 } });
  const capped = runPortfolio({ entries: [mkEntry('A'), mkEntry('B')], capital: 100000, maxMarginPct: 0.3 });
  assert.ok(capped.exposure.scaledDown, '应该触发缩仓');
  assert.ok(capped.exposure.appliedScale < 1);
  assert.ok(capped.exposure.peakMarginRatio <= 0.3 + 1e-6, `缩仓后占用应回到上限内，实际 ${(capped.exposure.peakMarginRatio * 100).toFixed(1)}%`);
});

test('runPortfolio：品种日期错位时不得把缺失日算成 0（实测曾报出 -81% 而真值是 +6%）', () => {
  // A 从 2024-01 起，B 从 2024-05 起（上市晚）。按日期并集累加时，B 在 1~4 月没有点，
  // 老实现那格贡献 0 → 合并权益在开头几个月凭空少掉一半，末值与总收益全错。
  const a = upSeries(120, 100, 0.5);
  const b = a.slice(60).map((x, i) => ({ ...x, date: `2024-0${Math.min(9, 5 + Math.floor(i / 28))}-${String(i % 28 + 1).padStart(2, '0')}` }));
  const mkEntry = (sym, bars) => ({ symbol: sym, name: sym, bars, spec: SPEC, strategy: fakeStrategy, params: { warm: 3 }, engineOpts: { lots: 2 } });
  const res = runPortfolio({ entries: [mkEntry('A', a), mkEntry('B', b)], capital: 200000, weights: 'equal' });
  assert.ok(!res.error, res.error || '');
  const lastA = res.perSymbol[0].metrics.finalEquity, lastB = res.perSymbol[1].metrics.finalEquity;
  const lastCombined = res.combinedEquity[res.combinedEquity.length - 1].equity;
  assert.near(lastCombined, lastA + lastB, 1, '末值必须等于两品种末值之和');
  const first = res.combinedEquity[0].equity;
  assert.near(first, 200000, 1, '起点必须是总资金：B 还没上市的那部分要算成闲置资金，不能算 0');
  const minEq = Math.min(...res.combinedEquity.map(p => p.equity));
  assert.ok(minEq > 100000, `合并曲线不许塌到半仓以下，实际最低 ${minEq.toFixed(0)}`);
  assert.near(res.metrics.totalReturn, lastCombined / 200000 - 1, 1e-6, '总收益必须与合并曲线一致');
});

test('runPortfolio：品种自带的 capital 不许盖掉组合的分仓资金', () => {
  // 实测踩过的坑：面板把默认资金 200000 塞进每个 entry.engineOpts，组合按权重算出的 333333
  // 被它覆盖 —— 于是"按权重分仓"只是表面功夫，而曲线的闲置填充又按分配额算，
  // 两条口径混在一起，末值与总收益全错（报出 -34%，且起点是 866666 这种拼凑数）。
  const a = upSeries(120, 100, 0.5);
  const b = upSeries(120, 300, 0.8);
  const mkE = (sym, bars) => ({ symbol: sym, bars, spec: SPEC, strategy: fakeStrategy, params: { warm: 3 }, engineOpts: { lots: 1, capital: 200000 } });
  const res = runPortfolio({ entries: [mkE('A', a), mkE('B', b)], capital: 400000, weights: 'equal' });
  assert.near(res.allocation[0].capital, 200000, 1e-6, '等权各 20 万');
  assert.eq(res.combinedEquity[0].equity, 400000, '起点必须正好是总资金');
  assert.near(res.combinedEquity[res.combinedEquity.length - 1].equity,
    res.perSymbol[0].metrics.finalEquity + res.perSymbol[1].metrics.finalEquity, 1, '末值必须等于两品种之和');
  assert.near(res.metrics.totalReturn, res.combinedEquity[res.combinedEquity.length - 1].equity / 400000 - 1, 1e-9);
});

// ---------- 报表 ----------
test('monthlyReturns：月内用月末/上月末权益，首个观测月没有基期所以给 null 而不是假 0%', () => {
  const curve = [];
  const push = (date, equity) => curve.push({ date, equity, idx: curve.length });
  push('2024-01-02', 100);        // 期初基线，1 月的收益才有得算
  push('2024-01-31', 110);
  push('2024-02-29', 121);
  push('2024-03-31', 99);
  push('2025-01-31', 130);
  const m = monthlyReturns(curve);
  const y24 = m.rows.find(r => r.year === '2024');
  assert.near(y24.months[0], 0.10, 1e-9, '1 月 +10%');
  assert.near(y24.months[1], 0.10, 1e-9, '2 月 +10%');
  assert.near(y24.months[2], -0.18181, 1e-4, '3 月回撤');
  assert.near(y24.total, 1.1 * 1.1 * 0.81818 - 1, 1e-4, '全年=各月复利');

  // 曲线第一个点正好是月末时，这个月没有基期：干脆不出现在表里，而不是报个假的 0%
  const noBase = monthlyReturns([{ date: '2024-01-31', equity: 110 }, { date: '2024-02-29', equity: 121 }]);
  const row24 = noBase.rows.find(r => r.year === '2024');
  assert.ok(row24.months[0] === undefined || row24.months[0] === null, '缺基期的月份不能算成 0%');
  assert.near(row24.months[1], 0.10, 1e-9, '2 月有 1 月末做基期，就该正常算出 +10%');
  assert.eq(noBase.years.join(','), '2024');
  assert.ok(monthlyReturns([]).note, '序列过短要给说明而不是抛错');
});

test('underwaterSeries：回撤百分比正确，并找出最长的水下区间', () => {
  const curve = [
    { date: 'd1', equity: 100 }, { date: 'd2', equity: 120 }, { date: 'd3', equity: 90 },
    { date: 'd4', equity: 95 }, { date: 'd5', equity: 130 }
  ];
  const u = underwaterSeries(curve);
  assert.eq(u.series.length, 5);
  assert.eq(u.series[0].drawdown, 0);
  assert.near(u.series[2].drawdown, 90 / 120 - 1, 1e-9, '相对历史高点算回撤');
  assert.eq(u.series[4].drawdown, 0, '创新高后回到水下 0');
  assert.near(u.maxDDPct, 1 - 90 / 120, 1e-9);
  assert.ok(u.worstUnderwater.days > 0 && u.worstUnderwater.from, '应给出水下时长与起止');
});

test('tradeDistribution：方向/出场原因/持仓时长分桶都算得出来', () => {
  const trades = [
    { dir: 'long', netPnL: 100, exitReason: 'stop', exitDate: '2024-01-05', holdingBars: 1 },
    { dir: 'long', netPnL: -50, exitReason: 'target', exitDate: '2024-02-05', holdingBars: 7 },
    { dir: 'short', netPnL: 30, exitReason: 'stop', exitDate: '2024-02-06', holdingBars: 45 }
  ];
  const d = tradeDistribution(trades);
  const long = d.byDirection.find(x => x.key === 'long');
  assert.eq(long.n, 2); assert.near(long.winRate, 0.5, 1e-9); assert.eq(long.pnl, 50);
  assert.eq(d.byExitReason.find(x => x.key === 'stop').n, 2);
  assert.ok(d.byHolding.some(x => x.key === '≤2'));
  assert.ok(d.byHolding.some(x => x.key === '21-60'));
  assert.eq(d.byMonth.length, 2, '按平仓月份聚成两个月');
});

test('benchmarkSeries：按共同日期对齐并归一到 1.0 起步', () => {
  const s = [{ date: '2024-01-31', equity: 100 }, { date: '2024-02-29', equity: 110 }, { date: '2024-03-31', equity: 88 }];
  const b = [{ date: '2024-01-31', equity: 3000 }, { date: '2024-02-29', equity: 3300 }, { date: '2024-03-31', equity: 3600 }];
  const r = benchmarkSeries(s, b);
  assert.eq(r.series[0].strategy, 1); assert.eq(r.series[0].bench, 1);
  assert.near(r.series[1].strategy, 1.1, 1e-9);
  assert.near(r.series[1].bench, 1.1, 1e-9);
  assert.near(r.series[2].bench, 1.2, 1e-9);
  assert.near(r.alpha, 0.88 - 1.2, 1e-9, '策略跑输基准时 alpha 为负');
  assert.ok(benchmarkSeries([], b).note, '缺基准要说明，不能画一条假曲线');
});

test('报表导出：CSV 与 HTML 都带上关键数字，且不引任何外部资源', () => {
  const metrics = { totalReturn: 0.2, annualReturn: 0.1, sharpe: 0.5, sortino: 0.6, calmar: 0.3, maxDDPct: 0.12, winRate: 0.4, payoffRatio: 1.8, profitFactor: 1.2, trades: 9, exposure: 0.7, totalFees: 123.4, capital: 100000, finalEquity: 120000, ruined: false };
  const csv = reportToCsv({ metrics, allocation: [{ symbol: 'rbm', weight: 0.5, capital: 50000, trades: 4, netPnL: 1000, sharpe: 0.4, maxDDPct: 0.1 }], trades: [{ dir: 'long', entryDate: '2024-01-02', entryPrice: 100, exitDate: '2024-01-09', exitPrice: 110, lots: 1, netPnL: 100, holdingBars: 5, exitReason: 'target' }] });
  assert.ok(/总收益率,20\.00%/.test(csv), csv.split('\n').slice(0, 4).join(' | '));
  assert.ok(/# 组合分配/.test(csv) && /rbm/.test(csv));
  assert.ok(/# 成交/.test(csv));

  const html = reportToHtml({ title: '测试报告', metrics, monthly: monthlyReturns([{ date: '2024-01-31', equity: 110 }, { date: '2024-02-29', equity: 121 }]), distribution: tradeDistribution([{ dir: 'long', netPnL: 1, exitReason: 'stop', exitDate: '2024-01-05', holdingBars: 1 }]), generatedAt: '2026-10-14' });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('测试报告') && html.includes('Sharpe'));
  assert.ok(!/src=["']https?:|@import|fonts\.googleapis/.test(html), '报告不该依赖 CDN/字体，本地打开就得能看');
  assert.ok(/红=盈利/.test(html), '配色约定必须写明，否则国内用户看反');
});

test('报表对缺失数据不崩（只有权益曲线两点的极端情况）', () => {
  const m = monthlyReturns([{ date: '2024-01-01', equity: 1 }]);
  assert.eq(m.rows.length, 0);
  const u = underwaterSeries([{ date: '2024-01-01', equity: 1 }]);
  assert.eq(u.series.length, 1);
  const d = tradeDistribution([]);
  assert.eq(d.byDirection.length, 0);
  assert.ok(reportToHtml({ metrics: {} }).includes('—'), '指标缺失时显示破折号而不是 undefined');
});
