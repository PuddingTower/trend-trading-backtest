import { test, assert } from './harness.js';
import { ORDER_KIND, ratchetStop, levelFrom, makeBracket, fillPrice, evalExitOrders, evalAddOrders, pyramidScales } from '../src/core/orders.js';
import { BacktestEngine, DIR } from '../src/core/backtestEngine.js';
import { AShareRules } from '../src/markets/marketRules.js';

const mk = (date, o, h, l, c, v = 1000) => ({ date, open: o, high: h, low: l, close: c, volume: v });
const SPEC = { multiplier: 10, tick: 1, marginRate: 0.1, fee: { mode: 'fixed', value: 4 } };

// ---------- orders 纯函数 ----------
test('ratchetStop：止损只朝有利方向收紧，绝不放松', () => {
  assert.eq(ratchetStop(90, 95, 1), 95, '多头止损抬高');
  assert.eq(ratchetStop(95, 90, 1), 95, '多头不许降低');
  assert.eq(ratchetStop(null, 95, 1), 95);
  assert.eq(ratchetStop(110, 105, -1), 105, '空头止损压低');
  assert.eq(ratchetStop(105, 110, -1), 105, '空头不许抬高');
  assert.eq(ratchetStop(90, null, 1), 90, '没有候选位时保持原状');
});

test('levelFrom：价位 / 百分比 / ATR 倍数三种给法归一成同一个价', () => {
  assert.eq(levelFrom({ price: 95 }, 100, 5, 1, 'stop'), 95);
  assert.eq(levelFrom({ pct: 0.05 }, 100, 5, 1, 'stop'), 95, '多头止损在下方');
  assert.eq(levelFrom({ pct: 0.05 }, 100, 5, 1, 'target'), 105, '多头止盈在上方');
  assert.eq(levelFrom({ pct: 0.05 }, 100, 5, -1, 'stop'), 105, '空头止损在上方');
  assert.eq(levelFrom({ atrMult: 2 }, 100, 5, 1, 'stop'), 90);
  assert.eq(levelFrom({}, 100, 5, 1, 'stop'), null, '什么都没给就返回 null，不许编一个价');
});

test('makeBracket：盈亏比推止盈、缺止损要拒绝、方向不能反', () => {
  const b = makeBracket({ entryPrice: 100, dir: 1, stopPct: 0.05, rr: 2.5 });
  assert.ok(b.ok, '正常括号单应成立');
  assert.eq(b.risk, 5);
  assert.eq(b.orders.find(o => o.kind === ORDER_KIND.STOP).price, 95);
  assert.eq(b.orders.find(o => o.kind === ORDER_KIND.TARGET).price, 112.5, '风险 5 × rr 2.5');

  const noStop = makeBracket({ entryPrice: 100, dir: 1, targetPct: 0.1 });
  assert.eq(noStop.ok, false, '没有止损的括号单不叫括号单');
  assert.ok(noStop.reason);

  const wrongSide = makeBracket({ entryPrice: 100, dir: 1, stopPct: 0.05, targetPrice: 96 });
  assert.eq(wrongSide.ok, false, '多头止盈不能挂在开仓价下方');

  const short = makeBracket({ entryPrice: 100, dir: -1, stopAtr: 2, atr: 3, targetAtr: 4, atrValue: 3 });
  assert.ok(short.ok);
  assert.eq(short.orders.find(o => o.kind === ORDER_KIND.STOP).price, 106, '空头止损在上方 2ATR');

  const trail = makeBracket({ entryPrice: 100, dir: 1, stopPct: 0.05, trailPct: 0.03 });
  assert.ok(trail.trail && trail.trail.pct === 0.03, 'trail 配置要带回去给引擎');

  // Number(null) 与 Number('') 都是 0，不卡正数就会凭空造出一条 0% 的移动止损
  const noTrail = makeBracket({ entryPrice: 100, dir: 1, stopPct: 0.05, trailPct: null, trailAtr: undefined });
  assert.eq(noTrail.trail, null, '没要求移动止损时不能返回一个 trail 对象');
  const emptyTrail = makeBracket({ entryPrice: 100, dir: 1, stopPct: 0.05, trailPct: 0 });
  assert.eq(emptyTrail.trail, null, '0% 回撤等于不移动，不该当成开启');
});

test('fillPrice：跳空越过按开盘成交，盘中触碰按委托价成交', () => {
  const stop = { kind: ORDER_KIND.STOP, price: 95 };
  assert.eq(fillPrice(stop, mk('d', 90, 92, 88, 91), 1).price, 90, '低开穿止损 → 开盘价');
  assert.eq(fillPrice(stop, mk('d', 90, 92, 88, 91), 1).gap, true);
  assert.eq(fillPrice(stop, mk('d', 100, 101, 94, 99), 1).price, 95, '盘中触及 → 委托价');
  assert.eq(fillPrice(stop, mk('d', 100, 101, 96, 99), 1).hit, false, '没碰到就不该成交');

  const tgt = { kind: ORDER_KIND.TARGET, price: 110 };
  assert.eq(fillPrice(tgt, mk('d', 115, 118, 114, 116), 1).price, 115, '高开穿止盈 → 开盘价');
  assert.eq(fillPrice(tgt, mk('d', 100, 111, 99, 110.5), 1).price, 110);

  const shStop = { kind: ORDER_KIND.STOP, price: 106 };
  assert.eq(fillPrice(shStop, mk('d', 99, 100, 98, 99), -1).hit, false, '空头止损在上方，下跌不该触发');
  assert.eq(fillPrice(shStop, mk('d', 100, 108, 99, 107), -1).price, 106);
});

test('evalExitOrders：同一根内止损优先于止盈（悲观优先）', () => {
  const orders = [
    { kind: ORDER_KIND.TARGET, price: 110, qtyLots: 1 },
    { kind: ORDER_KIND.STOP, price: 95, qtyLots: 1 }
  ];
  const bar = mk('d', 100, 112, 94, 105);     // 两头都穿
  const r = evalExitOrders(orders, bar, 1);
  assert.eq(r.reason, 'stop', '先算止损');
  assert.eq(r.hits.length, 1);
  assert.eq(r.hits[0].price, 95);
});

test('evalExitOrders：多档止损全成交，并按对持仓不利的顺序排', () => {
  const orders = [
    { kind: ORDER_KIND.STOP, price: 98, qtyLots: 1 },
    { kind: ORDER_KIND.STOP, price: 94, qtyLots: 1 },
    { kind: ORDER_KIND.TARGET, price: 120, qtyLots: 1 }
  ];
  const r = evalExitOrders(orders, mk('d', 100, 101, 92, 93), 1);
  assert.eq(r.hits.length, 2, '两档都该成交');
  assert.eq(r.hits[0].price, 94, '多头先算更低的那一档');
  assert.eq(r.hits[1].price, 98);
});

test('evalAddOrders 与 pyramidScales：突破加仓方向与规模递减', () => {
  const adds = [{ kind: ORDER_KIND.ADD, price: 110, qtyLots: 2 }];
  assert.eq(evalAddOrders(adds, mk('d', 100, 109, 99, 108), 1).length, 0, '没突破不加仓');
  assert.eq(evalAddOrders(adds, mk('d', 100, 111, 100, 110.5), 1).length, 1);
  const used = [{ kind: ORDER_KIND.ADD, price: 110, qtyLots: 0 }];
  assert.eq(evalAddOrders(used, mk('d', 100, 111, 100, 110.5), 1).length, 0,
    '已成交的加仓单 qtyLots=0，下一根不许再触发，否则会天天加仓');
  assert.eq(pyramidScales(3, 0.6).map(x => x.toFixed(3)).join(','), '0.600,0.360,0.216', '加仓必须小于首仓且逐次递减');
  assert.eq(pyramidScales(0).length, 0);
});

// ---------- 引擎接入 ----------
function risingThenFall(n = 8) {
  const bars = [];
  for (let i = 0; i < n; i++) { const p = 100 + i * 3; bars.push(mk(`u${i}`, p, p + 1, p - 1, p + 0.5)); }
  for (let i = 0; i < 6; i++) { const p = 122 - i * 4; bars.push(mk(`d${i}`, p + 2, p + 3, p - 2, p)); }
  return bars;
}

test('引擎·移动止损真的会随行情收紧并在新的价位出场（不是只在开仓时取一次）', () => {
  const bars = risingThenFall();
  const sigs = bars.map((b, i) => ({ i, dir: DIR.LONG, trail: b.close - 2 }));   // 每根抬高候选位
  const eng = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 1 });
  const res = eng.run(sigs);
  assert.ok(res.trades.length >= 1, '应该出场');
  const t = res.trades[0];
  assert.ok(['stop', 'gap_stop'].includes(t.exitReason), `应由止损出场，实际 ${t.exitReason}`);
  // 若 trail 不更新，止损会停在第一根的 98 附近；跟着走的话出场价明显更高
  assert.ok(t.exitPrice > 105, `出场价应高于初始 trail，实际 ${t.exitPrice}`);
});

test('引擎·分批止盈：到目标只平一半，剩下带着止损继续跑', () => {
  const bars = [
    mk('b0', 100, 100, 100, 100),
    mk('b1', 100, 101, 99, 100),
    mk('b2', 110, 116, 109, 115),        // 冲破止盈 110
    mk('b3', 115, 116, 114, 115),
    mk('b4', 90, 91, 84, 85)             // 再砸穿止损 95
  ];
  const sigs = bars.map((b, i) => (i === 0 ? { i, dir: DIR.LONG, stop: 95, target: 110, takeProfitFraction: 0.5 } : null));
  const eng = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 4 });
  const res = eng.run(sigs);
  assert.eq(res.trades.length, 2, `应分两笔平仓，实际 ${res.trades.length}`);
  assert.eq(res.trades[0].lots, 2, '第一笔只平一半');
  assert.eq(res.trades[0].partial, true);
  assert.ok(res.trades[0].exitReason === 'target' || res.trades[0].exitReason === 'gap_target',
    `应由止盈出场，实际 ${res.trades[0].exitReason}`);
  assert.eq(res.trades[1].lots, 2, '剩下的一半后来被止损');
  assert.ok(['stop', 'gap_stop'].includes(res.trades[1].exitReason));
});

test('引擎·条件单是一次性的：目标单部分成交后不得在下一根重复触发', () => {
  // 分批止盈的正确剧本：目标只平一半 → 那张目标单消耗掉 → 剩下的一半后来被止损带走。
  // 若目标单不消耗，b3 开盘仍在目标价之上会再平一次，「止盈一半」就悄悄变成「全部止盈」，
  // 而两笔都写着 target，从报表上看不出是被重复触发出场的。
  const bars = [
    mk('b0', 100, 100, 100, 100),
    mk('b1', 100, 101, 99, 100),
    mk('b2', 110, 116, 109, 115),
    mk('b3', 115, 116, 114, 115),
    mk('b4', 90, 91, 84, 85)
  ];
  const sigs = bars.map((b, i) => (i === 0 ? { i, dir: DIR.LONG, stop: 95, target: 110, takeProfitFraction: 0.5 } : null));
  const res = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 4 }).run(sigs);
  assert.eq(res.trades.length, 2);
  assert.ok(!['target', 'gap_target'].includes(res.trades[1].exitReason),
    `第二笔不该再由止盈出场，实际 ${res.trades[1].exitReason}`);
  assert.ok(['stop', 'gap_stop'].includes(res.trades[1].exitReason), '剩下的一半应由止损出场');
});

test('引擎·括号单：sig.orders 由 makeBracket 给出，止损止盈都来自同一张单', () => {
  const bars = [
    mk('b0', 100, 100, 100, 100),
    mk('b1', 101, 102, 100, 101),        // 信号在第 0 根 → 本根开盘 101 成交，与括号单的 entryPrice 对齐
    mk('b2', 105, 106, 104, 105),
    mk('b3', 108, 113, 107, 112)         // 盘中触及止盈 111.1
  ];
  const bracket = makeBracket({ entryPrice: 101, dir: 1, stopPct: 0.05, rr: 2 });
  assert.ok(bracket.ok);
  const sigs = bars.map((b, i) => (i === 0 ? { i, dir: DIR.LONG, orders: bracket.orders } : null));
  const res = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 1 }).run(sigs);
  assert.eq(res.trades.length, 1);
  assert.eq(res.trades[0].exitReason, 'target');
  // 止盈价 111.1 落在 tick=1 的网格外，成交价必须吸附到最小变动单位（111），
  // 交易所不会让你按非网格价成交
  assert.eq(res.trades[0].exitPrice, 111);
});

test('引擎·金字塔加仓：突破推高手数、平均成本上移、规模递减', () => {
  const bars = [
    mk('b0', 100, 100, 100, 100),
    mk('b1', 100, 101, 99, 100),
    mk('b2', 105, 106, 104, 105),      // +5% 突破 → 第 1 次加仓
    mk('b3', 110, 111, 109, 110),      // +10% 突破 → 第 2 次加仓
    mk('b4', 112, 113, 111, 112)
  ];
  const sigs = bars.map((b, i) => (i === 0 ? { i, dir: DIR.LONG } : null));
  const eng = new BacktestEngine(bars, SPEC, {
    capital: 200000, lots: 3, pyramid: { maxAdds: 2, stepPct: 0.05, decay: 0.5 }
  });
  const res = eng.run(sigs);
  assert.eq(eng.adds, 2, `应加仓两次，实际 ${eng.adds}`);
  const t = res.trades[0];
  assert.eq(t.lots, 3 + 1 + 1, '3 手 + decay 0.5 递减的两笔各 1 手');
  assert.ok(t.entryPrice > 100 && t.entryPrice < 106, `平均成本应被抬高，实际 ${t.entryPrice}`);
});

test('引擎·加仓受板锁拦阻：A股涨停那天加不进去，且留下 reject 记录', () => {
  const bars = [
    mk('2024-01-02', 100, 100, 100, 100),
    mk('2024-01-03', 100, 101, 99, 100),
    mk('2024-01-04', 108, 110, 108, 110),       // 收在涨停价
    mk('2024-01-05', 121, 121, 120, 121)        // 一字涨停，加仓单被触发但买不进
  ];
  const rules = new AShareRules({ limitPct: 0.10, tick: 0.01, multiplier: 100, market: 'ashare' });
  const sigs = bars.map((b, i) => (i === 0 ? { i, dir: DIR.LONG } : null));
  const eng = new BacktestEngine(bars, { ...SPEC, marginRate: 1, multiplier: 100 }, {
    capital: 5_000_000, lots: 100, rules, pyramid: { maxAdds: 2, stepPct: 0.05, decay: 0.5 }
  });
  const res = eng.run(sigs);
  assert.ok(res.rejects.some(r => r.kind === 'boardLock'), '涨停加仓应被板锁拒绝并记账');
  assert.ok((eng.adds || 0) < 2, '不该把加仓当成全部成交');
});

test('levelPct：图上胶囊按当前线价读，拖到哪显示哪（空头翻号）', async () => {
  const { levelPct } = await import('../src/core/orders.js');
  assert.near(levelPct(91, 100, 1), -9, 1e-9, '多头止损在下方 → 负');
  assert.near(levelPct(109, 100, -1), -9, 1e-9, '空头止损在上方，价格差是正的但盈亏是负的');
  assert.near(levelPct(95, 100, 1), -5, 1e-9, '从 -9% 拖到 95 → 读数要跟着变成 -5%');
  assert.near(levelPct(112, 100, 1), 12, 1e-9, '止盈在多头方向是正数');
  assert.eq(levelPct(95, 0, 1), null, '参照价为 0 不能算出 Infinity 糊到图上');
  assert.eq(levelPct(undefined, 100, 1), null);
});
