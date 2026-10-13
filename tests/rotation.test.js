import { test, assert } from './harness.js';
import { momentumSeries, rawMomentum, rankUniverse, rotationSignals, rotationSnapshot } from '../src/core/rotation.js';
import { PortfolioEngine } from '../src/core/portfolioEngine.js';
import { rulesFor } from '../src/markets/marketRules.js';

const mk = (date, o, h, l, c, v = 1000) => ({ date, open: o, high: h, low: l, close: c, volume: v });
const date = (i) => {
  const d = new Date(Date.UTC(2023, 0, 2));
  let add = 0, count = 0;
  while (count < i) { add++; const w = new Date(d.getTime() + add * 86400000).getUTCDay(); if (w !== 0 && w !== 6) count++; }
  return new Date(d.getTime() + add * 86400000).toISOString().slice(0, 10);
};
const SPEC = { market: 'futures', multiplier: 10, tick: 1, marginRate: 0.1, fee: { mode: 'fixed', value: 4 } };

/** 稳定上行（低波动）/ 同收益但剧烈震荡 / 下行。用来验证"风险调整后"真的在调整。 */
function smooth(n, start, step) {
  return Array.from({ length: n }, (_, i) => { const p = start * Math.pow(1 + step, i); return mk(date(i), p, p * 1.004, p * 0.996, p); });
}
function choppy(n, start, step) {
  return Array.from({ length: n }, (_, i) => {
    const p = start * Math.pow(1 + step, i) * (1 + (i % 2 ? 0.05 : -0.048));
    return mk(date(i), p, p * 1.02, p * 0.98, p);
  });
}

const POOL = (n = 260) => [
  { symbol: 'AAA', bars: smooth(n, 100, 0.004) },
  { symbol: 'BBB', bars: smooth(n, 100, 0.001) },
  { symbol: 'CCC', bars: choppy(n, 100, 0.004) },        // 和 AAA 同样收益，但每天大起大落
  { symbol: 'DDD', bars: smooth(n, 100, -0.003) }
];

test('动量分数：暖机期为 null；同收益下波动大的排名更低', () => {
  const sA = momentumSeries(smooth(200, 100, 0.004), { lookback: 60, volLen: 30 });
  const sC = momentumSeries(choppy(200, 100, 0.004), { lookback: 60, volLen: 30 });
  assert.eq(sA.slice(0, 60).every(v => v === null), true, '不足 lookback 不给分');
  assert.ok(Number.isFinite(sA[199]) && Number.isFinite(sC[199]));
  assert.ok(sA[199] > sC[199], `平滑上行必须排在剧烈震荡之前（${sA[199].toFixed(2)} vs ${sC[199].toFixed(2)}）`);
  const down = momentumSeries(smooth(200, 100, -0.003), { lookback: 60, volLen: 30 });
  assert.ok(down[199] < 0, '下行的分数必须为负');
  const raw = rawMomentum(smooth(200, 100, 0.004), 60);
  assert.ok(raw[199] > 0.25 && raw[199] < 0.3, `60 根 ×0.4% 复利应≈27%，实际 ${raw[199]}`);
  assert.eq(raw[59], null, '不足 lookback 不给分');
});

test('rankUniverse：没分的品种被剔除并说明原因，并列按代码序稳定排名', () => {
  const r = rankUniverse([{ symbol: 'B', score: 1.5 }, { symbol: 'A', score: 1.5 }, { symbol: 'C', score: null }, { symbol: 'D', score: 3 }]);
  assert.eq(r.ranked.map(x => x.symbol).join(','), 'D,A,B', `并列时按代码序（A 在 B 前）应得 D,A,B，实际 ${r.ranked.map(x => x.symbol).join(',')}`);
  assert.eq(r.skipped.join(','), 'C', '无分品种要列出来，不能静默少一个');
  assert.eq(rankUniverse([]).ranked.length, 0);
});

test('轮动信号：每次调仓恰好持有 topK 个，下跌那个从不入选', () => {
  const pool = POOL();
  const rot = rotationSignals(pool, { lookback: 60, volLen: 30, topK: 2, rebalanceEvery: 15, longOnly: true });
  assert.ok(!rot.error, rot.error || '');
  assert.eq(rot.signals.length, pool.length, '每个品种一条信号序列');
  rot.signals.forEach((s, i) => assert.eq(s.length, pool[i].bars.length, '信号必须与 bar 等长'));
  assert.ok(rot.rebalances.length >= 5, `调仓次数太少：${rot.rebalances.length}`);
  for (const rb of rot.rebalances) {
    assert.eq(rb.kept.length, 2, `${rb.date} 应恰好持有 2 个`);
    assert.ok(!rb.kept.includes('DDD'), '一路下跌的品种被持有说明排名算错了');
    assert.ok(rb.kept.includes('AAA'), `稳定最强的应常在榜，实际 ${rb.kept.join(',')}`);
  }
  const dirs = new Set();
  rot.signals.forEach(s => s.filter(Boolean).forEach(x => dirs.add(x.dir)));
  assert.eq(dirs.has(-1), false, 'longOnly 时不许出现做空信号');
  assert.eq(dirs.has(0), true, '跌出前 K 名必须给出平仓(0)信号');
  assert.ok(/风险调整后动量/.test(rot.note));
});

test('轮动不看未来：截断数据后，前段每根信号逐位一致', () => {
  const pool = POOL();
  const full = rotationSignals(pool, { lookback: 60, volLen: 30, topK: 2, rebalanceEvery: 15 });
  const cut = 190;
  const trimmed = rotationSignals(pool.map(e => ({ symbol: e.symbol, bars: e.bars.slice(0, cut) })),
    { lookback: 60, volLen: 30, topK: 2, rebalanceEvery: 15 });
  for (let k = 0; k < pool.length; k++) {
    for (let i = 70; i < cut; i++) {
      const a = full.signals[k][i], b = trimmed.signals[k][i];
      assert.eq(JSON.stringify(a && { dir: a.dir }), JSON.stringify(b && { dir: b.dir }),
        `第 ${k} 个品种第 ${i} 根的信号被之后的行情改写了`);
    }
  }
  assert.ok(trimmed.rebalances.length >= 3, '截断版也该有调仓，否则上面的比较是空的');
});

test('轮动：停牌太久的品种退出排名，而不是拿过期分数占仓位', () => {
  const pool = POOL();
  // AAA 从第 180 根起停止交易（停牌/退市），之后 BBB/CCC 才该补上来
  pool[0].bars = pool[0].bars.slice(0, 180);
  const rot = rotationSignals(pool, { lookback: 60, volLen: 30, topK: 2, rebalanceEvery: 15, staleDays: 5 });
  const last = rot.rebalances[rot.rebalances.length - 1];
  assert.ok(last.skipped.includes('AAA'), `末期 AAA 应被跳过，实际 skipped=${last.skipped.join(',')} kept=${last.kept.join(',')}`);
  assert.ok(!last.kept.includes('AAA'), '已无最新数据的品种不许继续持有');
});

test('轮动可复现：同一份数据跑两次结果逐字节相同', () => {
  const a = JSON.stringify(rotationSignals(POOL(), { lookback: 60, volLen: 30, topK: 2, rebalanceEvery: 15 }));
  const b = JSON.stringify(rotationSignals(POOL(), { lookback: 60, volLen: 30, topK: 2, rebalanceEvery: 15 }));
  assert.eq(a, b, '并列名次的随机性会让组合回测无法复现');
});

test('轮动接上组合引擎：多空两端都能表达，账仍然闭合', () => {
  const pool = POOL();
  const rot = rotationSignals(pool, { lookback: 60, volLen: 30, topK: 2, rebalanceEvery: 15, longOnly: false });
  const entries = pool.map((e, i) => ({
    symbol: e.symbol, name: e.symbol, bars: e.bars, spec: SPEC, rules: rulesFor(SPEC),
    strategy: { id: 'rot', params: {}, signals: () => rot.signals[i] }, params: {}, periodsPerYear: 252
  }));
  const res = new PortfolioEngine(entries, { capital: 500000, sizing: 'notional', notionalPct: 0.25, maxMarginPct: 0.9, settlement: true }).run();
  assert.ok(!res.error, res.error || '');
  assert.ok(res.trades.length >= 2, `轮动应该换来换去，实际成交 ${res.trades.length} 笔`);
  const sum = res.trades.reduce((s, t) => s + t.netPnL, 0);
  assert.near(res.finalEquity, 500000 + sum, 0.5, '轮动组合的账必须闭合');
  const held = new Set(res.trades.map(t => t.symbol));
  assert.ok(held.has('AAA'), '最强的品种应当被持有过');
});

test('rotationSnapshot：给出最近一次名次、留池名单和下次调仓间隔', () => {
  const rot = rotationSignals(POOL(), { lookback: 60, volLen: 30, topK: 2, rebalanceEvery: 15 });
  const snap = rotationSnapshot(rot);
  assert.ok(snap.date, '应能拿到最近一次调仓日');
  assert.eq(snap.rows.length, 4, '四个品种都该在榜上（有分的）');
  assert.eq(snap.rows[0].rank, 1);
  assert.eq(snap.kept.length, 2);
  assert.ok(snap.rows.filter(r => r.held).length === 2, 'held 标记要与 kept 一致');
  assert.eq(rotationSnapshot({ rebalances: [], calendar: [] }).rows.length, 0, '空数据要给出明确说明');
});
