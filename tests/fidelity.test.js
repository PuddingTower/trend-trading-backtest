/**
 * 撮合保真与风控路径的回归测试（M9 T2）。
 *
 * 这三条都是"改了但没测就等于没改"的典型：
 *   A. 平仓侧板锁 —— 旧口径给平仓开了"永远放行"的后门，趋势策略的止损恰好打在跌停上；
 *   B. ATR 移动止损 —— 调用点少传一个参数，六个策略的 trailAtr 参数静默失效；
 *   C. 维持保证金比例 —— 强平线读的是从没被赋值过的字段，?? 0.5 悄悄生效。
 */
import { test, assert } from './harness.js';
import { BacktestEngine, DIR } from '../src/core/backtestEngine.js';
import { PortfolioEngine } from '../src/core/portfolioEngine.js';
import { FuturesRules, AShareRules } from '../src/markets/marketRules.js';

const mk = (date, o, h, l, c, v = 100000) => ({ date, open: o, high: h, low: l, close: c, volume: v });
const FSPEC = { multiplier: 10, tick: 1, marginRate: 0.1, limitPct: 0.10,
                fee: { mode: 'fixed', value: 0 }, market: 'futures' };
const frules = () => new FuturesRules(FSPEC);

test('A. 一字跌停封死时止损卖不出去：委托不下岗，破板那根才成交', () => {
  const bars = [
    mk('d0', 100, 100, 100, 100),
    mk('d1', 100, 100, 100, 100),      // 信号在这根产生
    mk('d2', 100, 101, 99, 100),       // 次根开盘成交，止损 95
    mk('d3', 90, 90, 90, 90),          // 一字跌停（前收 100 × 0.9）：跳空穿透也出不去
    mk('d4', 88, 92, 87, 91),          // 破板：前收 90 → 跌停 81，88 在板上方的买盘里
    mk('d5', 91, 92, 90, 91)
  ];
  const sigs = bars.map((b, i) => (i === 1 ? { i, dir: DIR.LONG, stop: 95, reason: 't' } : null));
  const res = new BacktestEngine(bars, FSPEC, { capital: 1e6, lots: 10, rules: frules() }).run(sigs);

  assert.eq(res.trades.length, 1, `最终只该平一次，实际 ${res.trades.length}`);
  assert.eq(res.trades[0].entryIdx, 2, '成交在信号次根开盘');
  assert.eq(res.trades[0].exitIdx, 4, 'd3 那根必须被板锁拦住，平仓延后到破板的 d4');
  assert.ok(res.rejected.boardLockClose === 1, `被拦一次，实际 ${res.rejected.boardLockClose}（rejects: ${JSON.stringify(res.rejects)}）`);
  assert.ok(res.rejects.some(r => r.kind === 'boardLockClose' && r.idx === 3), '拒单要留下可查的记录');
  assert.ok(/跌停/.test(res.rejects.find(r => r.kind === 'boardLockClose').reason), '原因得写清楚是封死卖不掉');
  // 被闷在板里那天，浮亏是真的：权益必须比"假设能出掉"低
  assert.ok(res.equityCurve[3].equity < res.equityCurve[2].equity, '封板那天亏的是真钱');
});

test('A2. 止盈单在涨停板上是卖出，有人接，照常放行', () => {
  const bars = [
    mk('d0', 100, 100, 100, 100),
    mk('d1', 100, 100, 100, 100),
    mk('d2', 100, 101, 99, 100),
    mk('d3', 110, 110, 109, 110)          // 一字涨停，多头在此卖出
  ];
  const sigs = bars.map((b, i) => (i === 1 ? { i, dir: DIR.LONG, target: 110, reason: 't' } : null));
  const res = new BacktestEngine(bars, FSPEC, { capital: 1e6, lots: 10, rules: frules() }).run(sigs);
  assert.eq(res.trades.length, 1);
  assert.eq(res.trades[0].exitIdx, 3, '涨停板上平多该成交');
  assert.eq(res.rejected.boardLockClose, 0, `不该被板锁拦住：${JSON.stringify(res.rejects)}`);
  assert.ok(res.trades[0].netPnL > 0, '这笔是赚的');
});

test('A3. A股同样吃这条闸门：跌停封死时平多被拦，破板才走掉', () => {
  const ASPEC = { multiplier: 100, tick: 0.01, marginRate: 1.0, limitPct: 0.10,
                  fee: { mode: 'rate', value: 0.00025 }, minFee: 5, market: 'ashare' };
  const rules = new AShareRules(ASPEC);
  const bars = [
    mk('2024-01-02', 10, 10.05, 9.95, 10),
    mk('2024-01-03', 10, 10.05, 9.95, 10),      // 信号
    mk('2024-01-04', 10, 10.1, 9.9, 10),        // 次根开盘买入，止损 9.2
    mk('2024-01-05', 9, 9, 9, 9),               // 一字跌停（10×0.9）：卖单全排在队尾
    mk('2024-01-08', 9.3, 9.6, 8.9, 9.5)        // 前收 9 → 跌停 8.1，卖得出
  ];
  const sigs = bars.map((b, i) => (i === 1 ? { i, dir: DIR.LONG, stop: 9.2, reason: 't' } : null));
  const res = new BacktestEngine(bars, ASPEC, { capital: 2e5, lots: 100, rules }).run(sigs);
  assert.ok(res.trades.length >= 1, `A股全额占用：100 手要 10 万，本金得够。实际 rejects=${JSON.stringify(res.rejected)}`);
  assert.eq(res.trades[0].exitIdx, 4, `封死那天出不去，实际出场在 ${res.trades[0].exitIdx}`);
  assert.ok(res.rejects.some(r => r.kind === 'boardLockClose' && r.idx === 3), JSON.stringify(res.rejects));
  // T+1 走的是另一条判定（日内 bar 才会碰到），由 rules.test.js 与 60 分钟夹具覆盖
  assert.eq(rules.tPlus1, true, 'A股规则仍是 T+1');
});

test('B. ATR 移动止损失效的回归：trailAtr 必须真的改变出场价', () => {
  const bars = [];
  let p = 100;
  for (let i = 0; i < 40; i++) {                            // 先走一段趋势，把 ATR 跑出来
    const o = p, c = p + 1.2;
    bars.push(mk(`u${i}`, o, c + 0.6, o - 0.6, c)); p = c;
  }
  for (let i = 40; i < 46; i++) {                           // 再快速回落，触发跟随止损
    const o = p, c = p - 3;
    bars.push(mk(`d${i}`, o, o + 0.2, c - 0.4, c)); p = c;
  }
  const sigsOf = (trailAtr) => bars.map((b, i) => (i === 20
    ? { i, dir: DIR.LONG, stop: b.close * 0.9, trailAtr, reason: 't' } : null));
  const run = (trailAtr) => new BacktestEngine(bars, FSPEC, { capital: 1e6, lots: 1, atrLen: 10, rules: frules() })
    .run(sigsOf(trailAtr));

  const off = run(0), on = run(2);
  assert.eq(off.trades.length, 1, '两组都要有出场');
  assert.eq(on.trades.length, 1, '两组都要有出场');
  assert.ok(on.trades[0].exitPrice > off.trades[0].exitPrice,
    `ATR 跟随应当抬高止损：开了 ${on.trades[0].exitPrice} vs 没开 ${off.trades[0].exitPrice}`);
  assert.ok(on.trades[0].exitReason.includes('stop'), `出场原因应是止损，实际 ${on.trades[0].exitReason}`);
  // 跟随用的 ATR 只能取上一根：本根 ATR 含本根高低点，用它给本根止损定价是偷看
  assert.ok(on.trades[0].exitIdx > 40, '回落段里才该被跟随止损请出场');
});

test('C. 维持保证金比例：强平线必须吃这个参数（以前 ?? 0.5 悄悄生效）', () => {
  const bars = [
    mk('d0', 100, 100, 100, 100),
    mk('d1', 100, 100, 100, 100),
    mk('d2', 100, 101, 99, 100),
    mk('d3', 96, 96, 95, 96),
    mk('d4', 94, 95, 93, 94),
    mk('d5', 92, 93, 91, 92)
  ];
  const sigs = bars.map((b, i) => (i === 1 ? { i, dir: DIR.LONG, reason: 't' } : null));
  // 占用 100×10×0.1×100 手 = 10000；账户只留 2000 现金，这样维持线才碰得到
  const tight = new BacktestEngine(bars, FSPEC, { capital: 12000, lots: 100, maintenanceRatio: 0.99, rules: frules() }).run(sigs);
  const loose = new BacktestEngine(bars, FSPEC, { capital: 12000, lots: 100, maintenanceRatio: 0.30, rules: frules() }).run(sigs);
  assert.ok(tight.trades.some(t => t.exitReason === 'margin_call'), '0.99 那条应当触发维持线强平');
  assert.ok(!loose.trades.some(t => t.exitReason === 'margin_call'), `0.30 不该触发：${JSON.stringify(loose.trades.map(t => t.exitReason))}`);
  const eng = new BacktestEngine(bars, FSPEC, { capital: 12000, lots: 100, settlement: { enabled: true, maintenanceRatio: 0.8 } });
  assert.eq(eng.maintenanceRatio, 0.8, '结算配置里的比例要能被读出来');
  assert.eq(new BacktestEngine(bars, FSPEC, {}).maintenanceRatio, 0.75, '默认 0.75，不再是那个没人看见的 0.5');
});

// ---------- 组合引擎：与单品种引擎必须同一条口径 ----------
// 组合引擎要求每个品种 >20 根，所以前面垫一段平盘，事件段固定落在最后六根。
const PAD = Array.from({ length: 24 }, (_, i) => mk(`p${String(i).padStart(2, '0')}`, 100, 100.5, 99.5, 100));
const SIGNAL_IDX = 25;                       // '2024-01-03'：信号这根，次根开盘成交
const holdLong = { id: 'holdLong', name: '一直持有', params: {},
  signals: (bars) => bars.map((b, i) => (i === SIGNAL_IDX ? { i, dir: DIR.LONG, reason: 't' } : null)) };
const seq = () => [...PAD,
  mk('2024-01-02', 100, 100, 100, 100),
  mk('2024-01-03', 100, 101, 99, 100),      // 信号这根
  mk('2024-01-04', 100, 101, 99, 100),      // 次根开盘成交
  mk('2024-01-05', 90, 90, 90, 90),         // 一字跌停（100×0.9）
  mk('2024-01-08', 88, 92, 87, 91),         // 破板
  mk('2024-01-09', 91, 92, 90, 91)
];
const twoEntries = () => ['A', 'B'].map(sym => ({
  symbol: sym, name: sym, bars: seq(), spec: FSPEC, rules: frules(), strategy: holdLong, params: {}
}));

test('D. 组合引擎同一条闸门：封板那天止损出不去，破板才走', () => {
  const res = new PortfolioEngine(twoEntries(), {
    capital: 1e6, sizing: 'notional', notionalPct: 0.05, stopPct: 0.05, slippageTicks: 0
  }).run();
  const blocked = (res.rejects || []).filter(r => r.kind === 'boardLockClose');
  assert.ok(blocked.length >= 1, `封板那天两个品种的止损都该被拦住：${JSON.stringify(res.rejects).slice(0, 240)}`);
  assert.ok(blocked.every(r => r.date === '2024-01-05'), `只该拦在封板那天，实际 ${blocked.map(r => r.date).join(',')}`);
  assert.ok(!res.trades.some(t => String(t.exitDate).slice(0, 10) === '2024-01-05'), '封死那天不许有任何平仓成交');
  assert.ok(res.trades.length >= 1, '破板后应当出得掉');
  assert.ok(res.rejected.boardLockClose >= 1, `计数要进报表，实际 ${JSON.stringify(res.rejected)}`);
});

test('E. 全部闷在跌停板里：强平循环不许死循环，要报账户级 blocked 通知', () => {
  // 满杠杆 + 一字跌停：权益直接掉到维持线以下，但两个品种都出不掉
  const res = new PortfolioEngine(twoEntries(), {
    capital: 1e6, sizing: 'notional', notionalPct: 0.95, maxMarginPct: 0.95,
    maintenanceRatio: 0.75, slippageTicks: 0
  }).run();
  const blockedNotice = (res.notices || []).filter(n => n.kind === 'liquidation_blocked');
  assert.ok(res.rejected.marginCalls === 0 || blockedNotice.length > 0,
    `要么没触发强平，要么就得报 blocked：${JSON.stringify(res.notices).slice(0, 300)}`);
  assert.ok(blockedNotice.length >= 1, '连续一字跌停下应当报出"降不了杠杆"这件事，而不是静默或卡死');
  assert.ok(res.equityCurve.length >= 28, `run() 要能正常返回完整曲线：${res.equityCurve.length}`);
  assert.ok(res.trades.every(t => String(t.exitDate).slice(0, 10) !== '2024-01-05'), '被封那天一笔都出不掉');
  assert.ok(blockedNotice[0].symbols && blockedNotice[0].symbols.length >= 1, '要指出是哪些品种被闷住');
});
