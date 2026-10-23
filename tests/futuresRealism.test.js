/**
 * 期货强平的真实口径回归（M9 T3）。
 *
 * 这组测试盯的是"看起来能跑、其实把期货当股票/当连续竞价"的错：
 *   A. 分钟级每天只结算一次，且结算价不能拿收盘价冒充；
 *   B. 夜盘属于次日，平今按交易日而不是 bar 下标；
 *   C. 板幅基准是上一交易日结算价，不是昨收；
 *   D. A股现货没有杠杆，绝不能被"跌 25% 强平"；
 *   E. 开盘跳空穿维持线当根开盘强平；盘中跌破、收盘前恢复则撤单。
 */
import { test, assert } from './harness.js';
import { BacktestEngine, DIR } from '../src/core/backtestEngine.js';
import { PortfolioEngine } from '../src/core/portfolioEngine.js';
import { FuturesRules, AShareRules } from '../src/markets/marketRules.js';

const mk = (date, o, h, l, c, v = 100) => ({ date, open: o, high: h, low: l, close: c, volume: v });
const FSPEC = { market: 'futures', multiplier: 10, tick: 1, marginRate: 0.1, limitPct: 0.08,
                fee: { mode: 'fixed', value: 0 }, closeTodayFee: { mode: 'fixed', value: 0 } };

test('A. 分钟级逐日结算：每个交易日只结一次，结算价用当日成交量加权均价', () => {
  const bars = [
    mk('2026-01-05 09:00', 100, 101, 99, 100),
    mk('2026-01-05 10:00', 110, 112, 109, 111),
    mk('2026-01-05 14:00', 119, 121, 118, 120),
    mk('2026-01-06 09:00', 120, 121, 119, 120.5),
    mk('2026-01-06 14:00', 121, 122, 120, 121)
  ];
  const sig = bars.map((b, i) => (i === 0 ? { i, dir: DIR.LONG } : null));
  const res = new BacktestEngine(bars, FSPEC, { capital: 100000, lots: 1, slippageTicks: 0 }).run(sig);

  assert.eq(res.trades[0].entryIdx, 1, '信号在 09:00，成交在下一根 10:00 开盘');
  assert.eq(res.equityCurve[1].settled, false, '10:00 不是交易日最后一根，不能结算');
  assert.eq(res.equityCurve[2].settled, true, '14:00 是当日最后一根，必须结算');
  assert.eq(res.equityCurve[3].settled, false, '次日 09:00 不能结算');
  assert.eq(res.equityCurve[4].settled, true, '次日 14:00 才结算');

  // 9:00 bar 的典型价 100、10:00 110.6667、14:00 119.6667，成交量各 100 → 110.1111
  assert.near(res.equityCurve[2].settlePrice, (100 + 332 / 3 + 359 / 3) / 3, 1e-9,
    '结算价必须是成交量加权均价，不能直接用收盘价 120');
  assert.ok(Math.abs(res.equityCurve[2].settlePrice - 120) > 1, '收盘价与结算价的差异要真实存在，否则这条测试是空的');
  assert.ok(res.settlement.priceSource === 'vwap', '分钟级应标明结算价来源是 VWAP 近似');
});

test('B1. 夜盘归属次日：结算只发生在日盘最后一根', () => {
  const bars = [
    mk('2026-01-05 21:00', 100, 100, 100, 100),
    mk('2026-01-05 22:00', 100, 100, 100, 100),
    mk('2026-01-05 23:00', 100, 100, 100, 100),
    mk('2026-01-06 09:00', 100, 100, 100, 100),
    mk('2026-01-06 10:00', 100, 100, 100, 100),
    mk('2026-01-06 14:00', 100, 100, 100, 100),
    mk('2026-01-07 09:00', 100, 100, 100, 100)
  ];
  const sig = bars.map((b, i) => (i === 0 ? { i, dir: DIR.LONG } : null));
  const res = new BacktestEngine(bars, FSPEC, { capital: 100000, lots: 1, slippageTicks: 0 }).run(sig);
  const settled = res.equityCurve.map(p => !!p.settled);
  assert.eq(JSON.stringify(settled), JSON.stringify([false, false, false, false, false, true, false]),
    '周四夜盘三根 + 周五日盘三根属于同一个交易日，只有周五 14:00 结算');
});

test('B2. 平今按交易日：夜盘 22:00 开、次日 09:00 平仍然收平今费', () => {
  const spec = { ...FSPEC, closeTodayFee: { mode: 'fixed', value: 100 } };
  const bars = [
    mk('2026-01-05 21:00', 100, 100, 100, 100),
    mk('2026-01-05 22:00', 100, 100, 100, 100),
    mk('2026-01-05 23:00', 100, 100, 100, 100),
    mk('2026-01-06 09:00', 100, 100, 100, 100),
    mk('2026-01-06 14:00', 100, 100, 100, 100)
  ];
  const sig = [
    { i: 0, dir: DIR.LONG }, null, { i: 2, dir: DIR.FLAT }, null, null
  ];
  const res = new BacktestEngine(bars, spec, { capital: 100000, lots: 1, slippageTicks: 0 }).run(sig);
  assert.eq(res.trades.length, 1);
  assert.eq(res.trades[0].fee, 100, '夜盘与次日早盘属于同一交易日，平今费必须收；按 bar 下标会漏成 0');
});

test('C. 板幅基准用上一交易日结算价，不是昨收', () => {
  const bars = [
    mk('2026-01-05 09:00', 96, 96, 94, 95, 1),      // 典型价 95
    mk('2026-01-05 14:00', 110, 110, 100, 105, 1),  // 典型价 105，收盘 105；当日结算价 = 100
    mk('2026-01-06 09:00', 108, 108, 108, 108, 1),  // 封死在前结算价 100 的 +8% 板上
    mk('2026-01-06 14:00', 108, 108, 108, 108, 1)
  ];
  const sig = bars.map((b, i) => (i === 1 ? { i, dir: DIR.LONG } : null));
  const rules = new FuturesRules(FSPEC);
  const res = new BacktestEngine(bars, FSPEC, { capital: 100000, lots: 1, slippageTicks: 0, rules }).run(sig);
  assert.eq(res.trades.length, 0, '前结算 100 × 1.08 = 108，开盘买在 108 是涨停封死，不该成交');
  assert.ok(res.rejects.some(r => r.kind === 'boardLock' && r.idx === 2), '要留下板锁拒单记录');
  // 如果错误地用昨收 105 当基准，涨停价会是 113.4，108 就不会被封 —— 这条用例能区分两种口径。
});

test('D. A股现货：没有保证金结算，也不存在浮亏 25% 强平', () => {
  const ASPEC = { ...FSPEC, market: 'ashare', multiplier: 100, tick: 0.01, marginRate: 1,
                  fee: { mode: 'fixed', value: 0 }, closeTodayFee: { mode: 'fixed', value: 0 } };
  const bars = [
    mk('2024-01-02', 100, 100, 100, 100),
    mk('2024-01-03', 100, 100, 100, 100),
    mk('2024-01-04', 100, 100, 100, 100),
    mk('2024-01-05', 90, 90, 90, 90),
    mk('2024-01-08', 75, 75, 75, 75),
    mk('2024-01-09', 60, 60, 60, 60)
  ];
  const sig = bars.map((b, i) => (i === 1 ? { i, dir: DIR.LONG } : null));
  const res = new BacktestEngine(bars, ASPEC, {
    capital: 200000, lots: 10, slippageTicks: 0, settlement: { enabled: true }
  }).run(sig);
  assert.eq(res.settlement, null, 'A股现货不能套期货结算');
  assert.eq(res.marginNotices.length, 0, 'A股没有追保通知');
  assert.ok(!res.trades.some(t => t.exitReason === 'margin_call'), '跌 40% 也不能出现期货式强平');
  assert.eq(res.trades[0].exitReason, 'end_of_data', '只有回测收尾平仓');
});

test('E1. 开盘跳空直接穿维持线：当根开盘强平（不是再等下一根）', () => {
  const bars = [
    mk('2024-01-02', 100, 100, 100, 100),
    mk('2024-01-03', 100, 100, 100, 100),   // 信号
    mk('2024-01-04', 100, 100, 100, 100),   // 开盘成交，450 手占用 45000
    mk('2024-01-05', 80, 80, 80, 80),       // 跳空 20%，开盘权益已低于维持线
    mk('2024-01-08', 80, 80, 80, 80)
  ];
  const sig = bars.map((b, i) => (i === 1 ? { i, dir: DIR.LONG } : null));
  const res = new BacktestEngine(bars, FSPEC, { capital: 50000, lots: 450, slippageTicks: 0 }).run(sig);
  const t = res.trades.find(x => x.exitReason === 'margin_call');
  assert.ok(t, '必须强平');
  assert.eq(t.exitIdx, 3, '开盘就是 80，强平应在 d3 开盘，不能拖到 d4');
  assert.ok(res.forcedLiquidations.length === 1);
  assert.ok(res.forcedLiquidations[0].triggerPrice === 80);
});

test('E2. 盘中跌破、开盘已恢复：撤掉强平挂单，不误杀', () => {
  const bars = [
    mk('2024-01-02', 100, 100, 100, 100),
    mk('2024-01-03', 100, 100, 100, 100),   // 信号
    mk('2024-01-04', 100, 101, 70, 100),    // 盘中闪崩到 70，收盘回到 100
    mk('2024-01-05', 100, 100, 100, 100)    // 开盘权益已回到维持线上
  ];
  const sig = bars.map((b, i) => (i === 1 ? { i, dir: DIR.LONG } : null));
  const res = new BacktestEngine(bars, FSPEC, { capital: 50000, lots: 450, slippageTicks: 0 }).run(sig);
  assert.ok(!res.trades.some(t => t.exitReason === 'margin_call'), '开盘已恢复就不该强平');
  assert.ok(res.liquidationNotices.some(n => n.kind === 'liquidation_cancelled'), '撤单要留痕');
  assert.ok(res.liquidationNotices.some(n => n.kind === 'liquidation_pending'), '盘中跌破本身要留痕');
});

test('G. 成交价不许穿出当根区间/涨跌停板：强平单同样受约束', () => {
  // 买入：前结算 100，板幅 8% → 涨停 108；bar 开 107、高 108，5 tick 滑点不能成交在 112。
  const buyBars = [
    mk('2026-01-05 09:00', 96, 96, 94, 95, 1),
    mk('2026-01-05 14:00', 110, 110, 100, 105, 1),
    mk('2026-01-06 09:00', 107, 108, 106, 107, 1),
    mk('2026-01-06 14:00', 107, 107, 107, 107, 1)
  ];
  const buySig = buyBars.map((b, i) => (i === 1 ? { i, dir: DIR.LONG } : null));
  const buyRes = new BacktestEngine(buyBars, FSPEC, {
    capital: 100000, lots: 1, slippageTicks: 5, rules: new FuturesRules(FSPEC)
  }).run(buySig);
  assert.eq(buyRes.trades.length >= 1, true, '这笔应该成交（开盘 107 没有封在 108）');
  assert.eq(buyRes.trades[0].entryPrice, 108, '5 tick 滑点最多只能推到涨停价 108，不能成交在 112');

  // 强平：前结算 100 → 跌停 92；强平单 5 tick 滑点不能成交在 88。
  const liqBars = [
    mk('2024-01-02', 100, 100, 100, 100),
    mk('2024-01-03', 100, 100, 100, 100),
    mk('2024-01-04', 100, 100, 100, 100),
    mk('2024-01-05', 100, 101, 70, 100),   // 盘中穿维持线，收盘结算价仍是 100
    mk('2024-01-08', 93, 94, 92, 93)       // 前结算 100 → 跌停 92
  ];
  const liqSig = liqBars.map((b, i) => (i === 1 ? { i, dir: DIR.LONG } : null));
  const liqRes = new BacktestEngine(liqBars, { ...FSPEC, limitPct: 0.08 }, {
    capital: 50000, lots: 450, slippageTicks: 5, rules: new FuturesRules({ ...FSPEC, limitPct: 0.08 })
  }).run(liqSig);
  const liq = liqRes.trades.find(t => t.exitReason === 'margin_call');
  assert.ok(liq, '必须强平');
  assert.eq(liq.exitPrice, 92, '强平卖单不能穿出跌停价 92，也不能穿出当根最低 92');
});

test('F. 组合层：A股现货不参与保证金强平', () => {
  const dates = Array.from({ length: 40 }, (_, i) => `2024-0${1 + Math.floor(i / 28)}-${String(i % 28 + 1).padStart(2, '0')}`);
  const bars = dates.map((d, i) => {
    const p = i < 8 ? 10 : Math.max(6, 10 - (i - 8) * 0.2);
    return mk(d, p, p, p, p);
  });
  const spec = { market: 'ashare', multiplier: 100, tick: 0.01, marginRate: 1,
                 fee: { mode: 'fixed', value: 0 } };
  const strategy = { id: 'hold', params: {}, signals: (bs) => bs.map((b, i) => (i >= 3 ? { i, dir: 1 } : null)) };
  const res = new PortfolioEngine([{ symbol: 'A', name: 'A', bars, spec, rules: new AShareRules(spec), strategy, params: {} }],
    { capital: 100000, sizing: 'notional', notionalPct: 0.9, maxMarginPct: 1, maintenanceRatio: 0.75 }).run();
  assert.ok(res.trades.length >= 1, '应当开出一笔 A股');
  assert.ok(!res.trades.some(t => t.exitReason === 'margin_call'), 'A股全额资金，不存在维持线强平');
  assert.ok(!res.notices.some(n => n.kind === 'forced_liquidation' || n.kind === 'liquidation_pending'),
    `A股不该有强平通知：${JSON.stringify(res.notices)}`);
});
