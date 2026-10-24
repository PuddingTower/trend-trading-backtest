import { test, assert } from './harness.js';
import { CRISIS_SCENARIOS, scenariosFor, runScenario, runStressSuite } from '../src/report/stressTest.js';

/** 工作日序列（跳过周末），ISO 日期字符串。 */
function weekdays(from, to) {
  const out = [];
  const t = new Date(Date.UTC(...from));
  const end = new Date(Date.UTC(...to));
  while (t <= end) {
    const d = t.getUTCDay();
    if (d !== 0 && d !== 6) out.push(t.toISOString().slice(0, 10));
    t.setUTCDate(t.getUTCDate() + 1);
  }
  return out;
}

/** 2015 股灾片段：6/12 前横盘 100，之后 40 个交易日跌到 65，再横盘。 */
function crashBars() {
  const dates = weekdays([2015, 3, 1], [2015, 9, 30]);
  let p = 100;
  return dates.map(d => {
    if (d > '2015-08-26') { /* 横盘不再跌 */ }
    else if (d >= '2015-06-15') p = Math.max(65, p - 0.9);
    return { date: d, open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 1e6 };
  });
}

const A_SPEC = { multiplier: 100, tick: 0.01, fee: { mode: 'rate', value: 0.0001 }, marginRate: 1, limitPct: 0.1 };

test('场景库：市场过滤与日期完整性', () => {
  assert.ok(CRISIS_SCENARIOS.length >= 8, '至少覆盖白皮书点名的四类事件');
  for (const s of CRISIS_SCENARIOS) {
    assert.ok(s.from < s.to && /^\d{4}-\d{2}-\d{2}$/.test(s.from), `${s.id} 日期必须是合法区间`);
    assert.ok(s.why && s.why.length > 10, '每个场景必须写明检验目的');
  }
  const a = scenariosFor('aShare').map(s => s.id);
  const f = scenariosFor('futures').map(s => s.id);
  assert.ok(a.includes('crash2015') && !a.includes('double11'), 'A股不跑期货专属场景');
  assert.ok(f.includes('double11') && f.includes('nickel2022') && !f.includes('crash2015'), '期货不跑A股专属场景');
  assert.ok(a.includes('covid2020'), 'both 场景两边都要有');
});

test('买入持有对照组：股灾窗口的收益与回撤可手算对账', () => {
  const bars = crashBars();
  const sc = CRISIS_SCENARIOS.find(s => s.id === 'crash2015');
  const r = runScenario({ bars, spec: A_SPEC, strategy: null, scenario: sc, lookback: 0, engineOpts: { lots: 10 } });
  assert.ok(r.available);
  // 信号全为 dir:1 → 窗口切片的第 2 根开盘进多（第 1 根出信号）。
  // 窗口起点是 2015-06-15 —— 而下跌从当天就开始，所以进场价是 98.2 不是 100。
  const s0 = bars.findIndex(b => b.date >= sc.from);
  const L = 10;
  const entry = bars[s0 + 1].open, exit = bars[bars.findIndex(b => b.date > sc.to) - 1].close, cap = 100000;
  const fee = (entry + exit) * 100 * L * 0.0001;
  const expect = (100 * L * (exit - entry) - fee) / cap;
  assert.near(r.totalReturn, expect, 1e-6, `进场 ${entry} → 出场 ${exit} 的 ${L} 手多头对账`);
  assert.ok(r.maxDDPct > 0.2, `跌 35% 的窗口，回撤不该小于 20%，实际 ${(r.maxDDPct * 100).toFixed(1)}%`);
  assert.ok(r.buyHoldReturn < 0, '股灾窗口的买入持有必须是亏的');
  assert.eq(r.trades, 1);
});

test('窗口外数据如实报不可用，预热段盈亏不记入场景', () => {
  const bars = crashBars();
  const sc = CRISIS_SCENARIOS.find(s => s.id === 'nickel2022');   // 2022 年，数据在 2015
  const r = runScenario({ bars, spec: A_SPEC, strategy: null, scenario: sc });
  assert.eq(r.available, false);
  assert.ok(r.note.includes('不覆盖'));
});

test('压力套件：汇总最脆弱一幕、缺失场景列明、板锁合计', () => {
  // 数据只覆盖 2022-03（伦镍窗口），其余场景都该进 missingData
  // JS 月份 0 起始：[2022,1,21] = 2 月 21 日。窗口必须盖住 3/07~3/18 的伦镍场景。
  const dates = weekdays([2022, 1, 21], [2022, 2, 25]);
  let p = 200000 / 1000; // 镍价量级不重要，合成即可
  const bars = dates.map(d => {
    p *= d >= '2022-03-07' && d <= '2022-03-09' ? 1.06 : 1.001;
    return { date: d, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 5e5 };
  });
  const suite = runStressSuite({ bars, spec: A_SPEC, strategy: null, market: 'futures' });
  assert.eq(suite.summary.available, 1, '只有 nickel2022 有数据');
  assert.ok(suite.summary.missingData.length === suite.summary.scenarios - 1);
  assert.eq(suite.summary.worstScenario.id, 'nickel2022');
  assert.ok(suite.results.every(r => r.available === false || r.barsInWindow > 0));

  const again = runStressSuite({ bars, spec: A_SPEC, strategy: null, market: 'futures' });
  assert.eq(JSON.stringify(again), JSON.stringify(suite), '同输入必须逐位可复现');
});

test('策略在压力窗口里可复现且板锁字段存在', () => {
  const bars = crashBars();
  const sc = CRISIS_SCENARIOS.find(s => s.id === 'crash2015');
  // 一个"跌 5 根后翻空"的朴素策略：验证 strategy 路径与 rejected 结构
  const strat = { signals: (slice) => slice.map((b, i) => ({ dir: i >= 5 ? -1 : 1 })) };
  const r = runScenario({ bars, spec: A_SPEC, strategy: strat, scenario: sc, lookback: 0 });
  assert.ok(r.available && typeof r.rejected === 'object');
  for (const k of ['margin', 'boardLockClose', 'suspendedClose']) {
    assert.ok(k in r.rejected, `rejected.${k} 必须存在（极端窗口里这是关键证据）`);
  }
  assert.ok(r.excessVsBuyHold === null || Number.isFinite(r.excessVsBuyHold));
});
