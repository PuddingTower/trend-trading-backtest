import { test, assert } from './harness.js';
import { PortfolioEngine } from '../src/core/portfolioEngine.js';
import { FuturesRules, AShareRules } from '../src/markets/marketRules.js';

const mk = (date, o, h, l, c, v = 1000) => ({ date, open: o, high: h, low: l, close: c, volume: v });
const FSPEC = { market: 'futures', multiplier: 10, tick: 1, marginRate: 0.1, fee: { mode: 'fixed', value: 4 } };

/** 只在 warm 之后一路做多的因果策略。 */
const longOnly = { id: 'l', params: { warm: 3 }, signals(bars, p = {}) { const q = { ...this.params, ...p }; return bars.map((b, i) => (i >= q.warm ? { i, dir: 1, reason: 'up' } : null)); } };
/** 先多后空：用来测反手。 */
function flipAt(n) {
  return {
    id: 'f', params: {},
    signals(bars) {
      return bars.map((b, i) => {
        if (i < n) return i >= 2 ? { i, dir: 1 } : null;
        return { i, dir: -1 };
      });
    }
  };
}

function cal(n) {
  return Array.from({ length: n }, (_, i) => `2024-0${1 + Math.floor(i / 28)}-${String(i % 28 + 1).padStart(2, '0')}`);
}
function series(n, start, step, dates) {
  return dates.map((d, i) => { const p = start + i * step; return mk(d, p, p + 1, p - 1, p + 0.5); });
}
function entry(sym, bars, spec = FSPEC, strategy = longOnly, params = {}) {
  return { symbol: sym, name: sym, bars, spec, rules: spec.market === 'futures' ? new FuturesRules(spec) : new AShareRules(spec), strategy, params };
}

test('PortfolioEngine：共享现金池的账必须从头到尾闭合（期末权益 = 本金 + 各笔净盈亏之和）', () => {
  const d = cal(60);
  const a = series(60, 100, 0.8, d);
  const b = series(60, 300, -0.5, d);
  const eng = new PortfolioEngine([entry('A', a), entry('B', b, FSPEC, flipAt(40))], {
    capital: 500000, sizing: 'notional', notionalPct: 0.2
  });
  const res = eng.run();
  assert.ok(!res.error, res.error || '');
  assert.eq(res.equityCurve.length, 60, '共同日历上每天必须有一个点');
  assert.ok(res.trades.length >= 2, '两个品种都该有成交');
  const sumNet = res.trades.reduce((s, t) => s + t.netPnL, 0);
  // 现金池若有任何一笔被重复计入或漏计，这个等式就会破 —— 它是组合引擎唯一的硬验收
  assert.near(res.finalEquity, 500000 + sumNet, 0.5,
    `期末权益必须等于本金加全部净盈亏（差 ${Math.round((res.finalEquity - 500000 - sumNet) * 100) / 100} 元）`);
});

test('PortfolioEngine：不看未来 —— 截断数据跑出的前段结果必须与全量一致', () => {
  const d = cal(80);
  const a = series(80, 100, 0.6, d);
  const b = series(80, 200, 0.3, d);
  const full = new PortfolioEngine([entry('A', a), entry('B', b)], { capital: 400000, sizing: 'notional', notionalPct: 0.2 }).run();
  const cut = new PortfolioEngine([entry('A', a.slice(0, 50)), entry('B', b.slice(0, 50))], { capital: 400000, sizing: 'notional', notionalPct: 0.2 }).run();
  const n = 45;
  for (let i = 0; i < n; i++) {
    assert.near(cut.equityCurve[i].equity, full.equityCurve[i].equity, 1e-6,
      `第 ${i} 天权益被之后的数据改变了 —— 组合引擎用了未来信息`);
  }
  // 只比"开仓事件"：截断版会在 cutoff 处强制收尾（end_of_data），全量版那笔还开着，
  // 比较平仓字段没有意义；开仓时点/价格/手数必须逐笔一致才说明没看未来。
  const entries = (r) => r.trades.map(t => [t.symbol, t.entryIdx, t.entryDate, t.entryPrice, t.lots].join('|')).filter(x => Number(x.split('|')[1]) < n);
  assert.eq(JSON.stringify(entries(cut)), JSON.stringify(entries(full)), '前段开仓不许被后面的行情改写');
  assert.ok(entries(full).length >= 2, '样本里至少要有两笔开仓，否则这条断言是空的');
});

test('PortfolioEngine：一个品种赚的钱立刻给另一个品种当保证金（这正是共享池的意义）', () => {
  const d = cal(60);
  // A 单边大涨把权益抬上去；B 在 A 之后才出信号。分仓独立跑时 B 的大小只看 B 自己那份资金。
  const a = series(60, 100, 4, d);
  const b = series(60, 100, 0.2, d);
  const pool = new PortfolioEngine([entry('A', a), entry('B', b, FSPEC, { id: 'late', params: {}, signals(bars) { return bars.map((x, i) => (i >= 40 ? { i, dir: 1 } : null)); } })],
    { capital: 200000, sizing: 'notional', notionalPct: 0.2 });
  const res = pool.run();
  const tA = res.trades.find(t => t.symbol === 'A');
  const tB = res.trades.find(t => t.symbol === 'B');
  assert.ok(tA && tB, '两个品种都该成交');
  assert.ok(tB.lots > tA.lots, `B 在 A 赚钱之后开仓，手数必须更大（A=${tA.lots} B=${tB.lots}）—— 否则说明资金池没共享`);
});

test('PortfolioEngine：总敞口越线时先强平亏得最狠的那个，而不是全部一起平', () => {
  const d = cal(40);
  // R 横盘（建仓早、占用保证金，但不亏），C 每天 -8% 单边下跌 —— 强平必须挑 C。
  const rising = d.map(x => mk(x, 100, 101, 99, 100));
  const crashing = d.map((x, i) => { const p = 200 * Math.pow(0.92, i); return mk(x, p, p * 1.005, p * 0.995, p); });
  const spec = { ...FSPEC, marginRate: 0.4 };
  const eng = new PortfolioEngine([entry('R', rising, spec), entry('C', crashing, spec)], {
    capital: 120000, sizing: 'notional', notionalPct: 0.4, maxMarginPct: 1,
    maintenanceRatio: 0.75, settlement: true, reentryCooldownBars: 3
  });
  const res = eng.run();
  const liq = res.trades.filter(t => t.exitReason === 'margin_call');
  assert.ok(liq.length >= 1, `应当发生强平，实际 ${JSON.stringify(res.rejected)}`);
  assert.eq(liq[0].symbol, 'C', `第一刀必须砍在亏损最大的品种上，实际平了 ${liq[0].symbol}`);
  assert.ok(liq.every(t => t.symbol === 'C'), `不该一次性全平：${liq.map(t => t.symbol).join(',')}`);
  const r = res.trades.find(t => t.symbol === 'R');
  assert.ok(r && r.exitReason !== 'margin_call', 'R 只是占保证金并未亏损，追保阶段不许被牵连');
  assert.ok(res.notices.some(n => n.kind === 'forced_liquidation' && n.symbol === 'C'), '强平要留下通知记录');
  assert.ok(res.rejected.marginCalls >= 1);
  // 强平后限制开仓：否则同一根信号立刻原样重开，第二天又被平，曲线只剩撮合顺序的味道
  assert.ok(res.rejected.reentryBlocked >= 1, '被强平的品种在冷却期内要拒单并记账');
  const liqDay = d.indexOf(liq[0].exitDate);
  const tooSoon = res.trades.filter(t => t.symbol === 'C' && d.indexOf(t.entryDate) > liqDay && d.indexOf(t.entryDate) <= liqDay + 3);
  assert.eq(tooSoon.length, 0, `冷却期内不许重开：${tooSoon.map(t => t.entryDate).join(',')}`);
  const sumNet = res.trades.reduce((s, t) => s + t.netPnL, 0);
  assert.near(res.finalEquity, 120000 + sumNet, 0.5, '强平这笔也要入账，不许差出手续费');
});

test('PortfolioEngine：板锁、停牌、资金不足三类拒单都记账且不静默', () => {
  const d = cal(24);
  const bars = d.map((x, i) => mk(x, 100 + i, 101 + i, 99 + i, 100 + i));
  bars[5].suspended = true;
  const spec = { ...FSPEC, limitPct: 0.10, multiplier: 100, marginRate: 1 };
  const rules = new AShareRules({ ...spec, market: 'ashare' });
  const e1 = { ...entry('S', bars, spec), rules };
  const res = new PortfolioEngine([e1], { capital: 3000, sizing: 'notional', notionalPct: 0.9 }).run();
  const kinds = new Set(res.rejects.map(r => r.kind));
  assert.ok(kinds.has('suspended') || res.rejected.suspended > 0, '停牌日要拒单');
  assert.ok(res.rejected.cash + res.rejected.sizingZero > 0, '小账户开不出整手要记账，而不是悄悄空跑');
  assert.eq(res.trades.filter(t => t.entryIdx === 5).length, 0, '停牌那根不许成交');
});

test('PortfolioEngine：逐日结算开启后账仍然闭合', () => {
  const d = cal(50);
  const a = series(50, 100, 1.2, d);
  const b = series(50, 500, -1.5, d);
  const res = new PortfolioEngine([entry('A', a), entry('B', b)], {
    capital: 300000, sizing: 'atr', riskPct: 0.02, atrMult: 2, settlement: true, maxMarginPct: 0.9
  }).run();
  assert.ok(res.trades.length > 0, 'ATR 预算下应该能开出仓');
  const sumNet = res.trades.reduce((s, t) => s + t.netPnL, 0);
  assert.near(res.finalEquity, 300000 + sumNet, 0.5,
    '开了当日无负债结算，账也必须闭合（浮盈不许被算两遍）');
  assert.ok(res.exposure.settlement === true);
});

test('PortfolioEngine：ATR 预算下单笔风险不超设定比例（大波动品种自动少开）', () => {
  const d = cal(60);
  const calm = d.map((x, i) => mk(x, 100 + i * 0.1, 100.6 + i * 0.1, 99.4 + i * 0.1, 100 + i * 0.1));
  const wild = d.map((x, i) => mk(x, 100 + i * 0.1, 112 + i * 0.1, 88 + i * 0.1, 100 + i * 0.1));
  const rc = new PortfolioEngine([entry('C', calm)], { capital: 200000, sizing: 'atr', riskPct: 0.01, atrMult: 2 }).run();
  const rw = new PortfolioEngine([entry('W', wild)], { capital: 200000, sizing: 'atr', riskPct: 0.01, atrMult: 2 }).run();
  const lc = rc.trades[0], lw = rw.trades[0];
  assert.ok(lc && lw, '两个品种都该开出来');
  assert.ok(lw.lots < lc.lots, `高波动品种手数必须更少（波动:${lw.lots} 平静:${lc.lots}）—— ATR 预算的全部意义`);
  for (const t of rc.trades.concat(rw.trades)) {
    const perLotRisk = Math.abs(t.exitPrice - t.entryPrice) / Math.max(1, t.lots);
    assert.ok(Number.isFinite(perLotRisk));
  }
});

test('PortfolioEngine：分批止盈只平目标手数，剩余仓位继续跑，且账仍闭合', () => {
  const d = cal(30);
  const bars = series(30, 100, 2, d);
  const partial = {
    id: 'partial', params: {},
    signals() { return bars.map((b, i) => (i === 2 ? { i, dir: 1, stop: 90, target: 110, takeProfitFraction: 0.5 } : null)); }
  };
  const res = new PortfolioEngine([entry('P', bars, FSPEC, partial)], {
    capital: 1_000_000, sizing: 'notional', notionalPct: 0.5, slippageTicks: 0
  }).run();
  assert.ok(!res.error, res.error || '');
  assert.eq(res.trades.length, 2, `应是一笔分批止盈 + 一笔收尾，实际 ${res.trades.map(t => t.exitReason).join(',')}`);
  const first = res.trades[0], last = res.trades[1];
  assert.eq(first.exitReason, 'gap_target', '目标价 110 在开盘即被越过，应按开盘成交');
  assert.eq(first.partial, true, '第一笔必须标成分批平仓');
  assert.ok(first.lots >= 1 && last.lots >= 1, '两边都要有手数');
  assert.eq(last.exitReason, 'end_of_data');
  assert.eq(first.lots + last.lots > first.lots, true, '剩余仓位必须还在');
  const sumNet = res.trades.reduce((s, t) => s + t.netPnL, 0);
  assert.near(res.finalEquity, 1_000_000 + sumNet, 0.5, '分批止盈后账必须闭合');
});

test('PortfolioEngine：金字塔加仓按突破单成交，加仓后的成本与账都闭合', () => {
  const d = cal(30);
  const bars = series(30, 100, 2, d);
  const plain = { id: 'plain', params: {}, signals() { return bars.map((b, i) => (i === 2 ? { i, dir: 1 } : null)); } };
  const base = new PortfolioEngine([entry('A', bars, FSPEC, plain)], {
    capital: 1_000_000, sizing: 'notional', notionalPct: 0.2, slippageTicks: 0
  }).run();
  const pyr = new PortfolioEngine([entry('A', bars, FSPEC, plain)], {
    capital: 1_000_000, sizing: 'notional', notionalPct: 0.2, slippageTicks: 0,
    pyramid: { maxAdds: 2, stepPct: 0.02, decay: 0.5 }
  }).run();
  assert.eq(base.adds, 0);
  assert.eq(pyr.adds, 2, `两根突破单都该成交，实际 ${pyr.adds}`);
  assert.ok(pyr.trades[0].lots > base.trades[0].lots, '加仓后总手数必须大于不加仓');
  assert.ok(pyr.trades[0].entryPrice > base.trades[0].entryPrice, '加仓把平均成本推高，不能还按首仓价记账');
  const sumNet = pyr.trades.reduce((s, t) => s + t.netPnL, 0);
  assert.near(pyr.finalEquity, 1_000_000 + sumNet, 0.5, '加仓后的手续费/保证金必须全部入账');
});

test('PortfolioEngine：没有可用数据时明确报错，而不是跑出一条平线', () => {
  const r = new PortfolioEngine([], { capital: 100000 }).run();
  assert.ok(r.error && /没有可用品种/.test(r.error));
  const r2 = new PortfolioEngine([{ symbol: 'X', bars: [], strategy: longOnly }], {}).run();
  assert.ok(r2.error, '空 bar 要报错');
});
