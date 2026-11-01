import { test, assert } from './harness.js';
import { TradingEngine } from '../src/app/tradingEngine.js';

const ASHARE = {
  market: 'ashare', name: '测试股', multiplier: 100, tick: 0.01, marginRate: 1,
  limitPct: 0.10, fee: { mode: 'rate', value: 0.00025, min: 5 },
  stampTax: { mode: 'rate', value: 0.0005 }, transferFee: { mode: 'rate', value: 0.00001 }
};
const FUTURES = {
  market: 'futures', name: '螺纹钢', multiplier: 10, tick: 1, marginRate: 0.1,
  limitPct: 0.08, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 }
};
const day = (d) => ({ date: d, open: 10, high: 10, low: 10, close: 10, volume: 1 });

function ashareEngine(capital = 10000) {
  const e = new TradingEngine({ id: 'ashare' });
  e.useSpec(ASHARE);
  e.reset(capital);
  return e;
}

test('A股手动盘：默认不可做空', () => {
  const e = ashareEngine();
  assert.eq(e.allowShort, false);
  assert.eq(e.tPlus1, true);
  assert.throws(() => e.openShort('600519', 10, 1, '2024-01-02', 0), '仅做多');
});

test('A股手动盘：全额资金 + 佣金最低 5 元 + 过户费', () => {
  const e = ashareEngine();
  e.setBarContext(day('2024-01-02'), day('2024-01-01'));
  e.openLong('600519', 10, 1, '2024-01-02', 0);
  assert.eq(e.multiplier, 100);
  assert.near(e.position.margin, 1000, 1e-9, '1 手 = 100 股，全额占用');
  assert.near(e.position.openFee, 5.01, 1e-9, '佣金最低 5 + 过户费 0.01');
  assert.near(e.cash, 10000 - 1000 - 5.01, 1e-9);
  assert.eq(e.marginState(10), null, 'A股没有保证金强平');
});

test('A股手动盘：卖出计印花税，平仓后权益 = 本金 - 双边费用', () => {
  const e = ashareEngine();
  e.setBarContext(day('2024-01-02'), day('2024-01-01'));
  e.openLong('600519', 10, 1, '2024-01-02', 0);
  e.setBarContext(day('2024-01-03'), day('2024-01-02'));
  const { trade } = e.closePosition(10, '2024-01-03', 1);
  assert.near(trade.fee, 5.01 + 5.51, 1e-9, '开仓 5.01 + 卖出 5.51（含印花税 0.5）');
  assert.near(trade.netPnL, -5.51, 1e-9);
  assert.near(e.cash, 9989.48, 1e-9);
});

test('A股手动盘：T+1 当日买入不能当日卖出', () => {
  const e = ashareEngine();
  e.setBarContext(day('2024-01-02'), null);
  e.openLong('600519', 10, 1, '2024-01-02', 0);
  assert.throws(() => e.closePosition(10.5, '2024-01-02', 0), 'T+1');
  const deferred = e.requestExit(10.5, '2024-01-02', 0, 'stop', '止损');
  assert.eq(deferred.deferred, true);
  assert.ok(e.pendingExit, '挂成待成交');
  assert.eq(e.position.lots, 1, '仓位还在');

  e.setBarContext({ ...day('2024-01-03'), open: 10.5, close: 10.5 }, day('2024-01-02'));
  const filled = e.resolvePendingExit({ ...day('2024-01-03'), open: 10.5 }, 1);
  assert.ok(filled, '下一交易日开盘成交');
  assert.near(filled.exitPrice, 10.5, 1e-9);
  assert.eq(e.position, null);
});

test('A股手动盘：涨停封板买不进，跌停封板卖不出', () => {
  const e = ashareEngine(100000);
  const prev = { ...day('2024-01-02'), close: 10 };
  e.setBarContext({ ...day('2024-01-03'), close: 11 }, prev);
  assert.throws(() => e.openLong('600519', 11, 1, '2024-01-03', 1), '涨停');

  e.setBarContext({ ...day('2024-01-03'), close: 10.99 }, prev);
  e.openLong('600519', 10.99, 1, '2024-01-03', 1);

  e.setBarContext({ ...day('2024-01-04'), close: 9 }, { ...day('2024-01-03'), close: 10.99 });
  assert.throws(() => e.closePosition(9, '2024-01-04', 2), '跌停');
  const deferred = e.requestExit(9, '2024-01-04', 2, 'stop', '止损');
  assert.eq(deferred.deferred, true);
});

test('A股手动盘：60m 的板幅按前一交易日收盘，不按上一根小时线', () => {
  const e = ashareEngine(100000);
  e.setBarContext({ ...day('2024-01-03 10:30'), close: 9.95 }, { ...day('2024-01-03 09:30'), close: 10 }, 9);
  assert.throws(() => e.openLong('600519', 9.95, 1, '2024-01-03 10:30', 1), '涨停',
    '前一日收 9 → 涨停 9.90；用上一根 10 会误算成 11');
  e.setBarContext({ ...day('2024-01-03 10:30'), close: 9.95 }, { ...day('2024-01-03 09:30'), close: 10 }, 9.5);
  e.openLong('600519', 9.95, 1, '2024-01-03 10:30', 1);
});

test('A股手动盘：指数只能看图，不可直接下单', () => {
  const e = new TradingEngine({ id: 'ashare' });
  e.useSpec({ ...ASHARE, tradable: false });
  e.reset(100000);
  e.setBarContext(day('2024-01-02'), null);
  assert.throws(() => e.openLong('000300', 4000, 1, '2024-01-02', 0), '不可直接交易');
});

test('期货手动盘：保证金 / 双向 / 无 T+1（原口径不回退）', () => {
  const e = new TradingEngine({ id: 'futures' });
  e.useSpec(FUTURES);
  e.reset(100000);
  assert.eq(e.allowShort, true);
  e.setBarContext({ ...day('2024-01-02'), close: 4000 }, null);
  e.openLong('RB0', 4000, 2, '2024-01-02', 0);
  assert.near(e.position.margin, 8000, 1e-9, '4000 × 10 × 2 × 10%');
  assert.near(e.cash, 100000 - 8000 - 8, 1e-9, '手续费按界面 4 元/手');
  const { trade } = e.closePosition(4010, '2024-01-02', 0);
  assert.near(trade.netPnL, 200 - 8, 1e-9);
  assert.near(e.cash, 100184, 1e-9);
});
