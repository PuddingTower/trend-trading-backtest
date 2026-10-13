import { test, assert } from './harness.js';
import { calendarDayGap, annotateGaps, checkAdjustmentContinuity, checkRolloverGaps, tradingCalendarOf } from '../src/markets/dataQuality.js';
import { BacktestEngine, DIR } from '../src/core/backtestEngine.js';

const mk = (date, o, h, l, c, v = 1000) => ({ date, open: o, high: h, low: l, close: c, volume: v });
const SPEC = { multiplier: 10, tick: 1, marginRate: 0.1, fee: { mode: 'fixed', value: 4 }, market: 'futures' };

// ---------- 日历与缺口 ----------
test('calendarDayGap：自然日差正确，且不用 new Date(带空格的日期串)', () => {
  assert.eq(calendarDayGap('2024-02-09', '2024-02-17'), 8, '春节长假量级');
  assert.eq(calendarDayGap('2024-01-05', '2024-01-08'), 3);
  assert.eq(calendarDayGap('2024-03-01 09:30', '2024-03-05 14:00'), 4, '日内 bar 的带时分秒也要能吃');
  assert.eq(calendarDayGap('', '2024-01-01'), 0, '缺日期返回 0 而不是 NaN');
});

test('annotateGaps：有参照序列时能真指出停牌了哪几天', () => {
  const ref = [];
  for (let d = 1; d <= 20; d++) ref.push(mk(`2024-03-${String(d).padStart(2, '0')}`, 10, 10, 10, 10));
  // 本品种在 3-06 ~ 3-10 停牌 5 个交易日
  const bars = ref.filter(b => !['2024-03-06', '2024-03-07', '2024-03-08', '2024-03-09', '2024-03-10'].includes(b.date));
  const r = annotateGaps(bars, { refBars: ref, minSuspensionDays: 4 });
  assert.eq(r.calendarKnown, true);
  assert.eq(r.suspensions.length, 1, `应识别出一次停牌，实际 ${JSON.stringify(r.suspensions)}`);
  assert.eq(r.suspensions[0].days, 5);
  assert.eq(r.suspensions[0].resumeDate, '2024-03-11', '复牌日必须是被标出的那天');
  const resumed = r.bars.find(b => b.resumedAfterSuspension);
  assert.ok(resumed, '复牌那根 bar 必须带 resumedAfterSuspension 标记');
  assert.eq(resumed.suspendedDays, 5);
});

test('annotateGaps：没有参照时不许把长假谎报成停牌', () => {
  // 只有本品种自己的序列：国庆 8 天缺口和停牌 8 天在数据上长得一模一样
  const bars = [mk('2024-09-30', 10, 10, 10, 10), mk('2024-10-08', 10, 10, 10, 10), mk('2024-10-09', 10, 10, 10, 10)];
  const r = annotateGaps(bars, {});
  assert.eq(r.calendarKnown, false, '没有交易日历参照时必须如实报告');
  assert.eq(r.suspensions.length, 0, '拿不到参照就不能声称"这是停牌"');
  assert.eq(r.longGaps.length, 1, '长缺口本身要如实记下来，标为"无法与长假区分"');
  assert.ok(r.longGaps[0].naturalDays >= 8);
  assert.ok(r.bars[1].stalePrevClose === true, '缺口过长时前收盘价已不代表昨天的市场，板幅判定必须被跳过');
  assert.ok(!('suspendedDays' in r.bars[1]), '没参照就不许造出停牌天数这种数字');
});

test('tradingCalendarOf：有参照用参照，没参照退回自身日期', () => {
  const bars = [mk('2024-01-02', 1, 1, 1, 1), mk('2024-01-03', 1, 1, 1, 1)];
  const ref = [mk('2024-01-02', 1, 1, 1, 1), mk('2024-01-03', 1, 1, 1, 1), mk('2024-01-04', 1, 1, 1, 1)];
  assert.eq(tradingCalendarOf(bars, ref).dates.length, 3);
  assert.eq(tradingCalendarOf(bars, null).dates.length, 2);
  assert.eq(tradingCalendarOf(bars, null).calendarKnown, false);
});

// ---------- 复权连续性 ----------
test('checkAdjustmentContinuity：未复权的除权跳空必须被抓出来', () => {
  const bars = [
    mk('2024-05-06', 100, 101, 99, 100),
    mk('2024-05-07', 100.5, 101, 99, 100.5),
    mk('2024-05-08', 50, 51, 49, 50),                 // 10 送 10：价格腰斩
    mk('2024-05-09', 50.2, 51, 50, 50.5)
  ];
  const r = checkAdjustmentContinuity(bars, { limitPct: 0.10 });
  assert.eq(r.usable, false);
  assert.eq(r.issues.length, 1);
  assert.eq(r.issues[0].idx, 2);
  assert.eq(r.issues[0].kind, 'split_suspect', '腰斩级跳空要判成送转，不是普通异常波动');
  assert.near(r.issues[0].jump, 50 / 100.5 - 1, 1e-4, '跳空幅度按前收盘价算');
  assert.ok(/未复权/.test(r.note) && /前复权/.test(r.note), '提示要直接说清下一步该做什么');
});

test('checkAdjustmentContinuity：正常涨跌停范围内不报警，无板幅品种直接跳过', () => {
  const ok = [mk('2024-05-06', 100, 101, 99, 100), mk('2024-05-07', 109, 110, 108, 109)];
  assert.eq(checkAdjustmentContinuity(ok, { limitPct: 0.10 }).usable, true, '+9% 的隔夜跳空是合法行情');
  const idx = [mk('2024-05-06', 3000, 3010, 2990, 3000), mk('2024-05-07', 2500, 2510, 2490, 2500)];
  const r = checkAdjustmentContinuity(idx, { limitPct: null });
  assert.eq(r.usable, true, '指数没有涨跌停限制，不能拿板幅去判它');
  assert.eq(r.issues.length, 0);
});

test('checkRolloverGaps：主力换月当天的跳空单列，不与未复权混淆', () => {
  // 换月跳空幅度要真的超过给定的板幅参考值才会被记下来（3800 → 4200 = 10.5% > 8%）
  const bars = [mk('2024-06-28', 3800, 3810, 3790, 3800), mk('2024-06-29', 4200, 4210, 4190, 4200)];
  const g = checkRolloverGaps(bars, { limitPct: 0.08 });
  assert.eq(g.length, 1);
  assert.near(g[0].jump, 400 / 3800, 1e-4);
  // 幅度小于参考值就不该报，避免把正常波动当成换月
  assert.eq(checkRolloverGaps([mk('2024-06-28', 3800, 3810, 3790, 3800), mk('2024-06-29', 3900, 3910, 3890, 3900)], { limitPct: 0.08 }).length, 0);
});

// ---------- 引擎：停牌闸门 ----------
test('引擎：合成出来的停牌 bar 上不许成交，并记一条 reject', () => {
  const bars = [mk('2024-01-02', 100, 100, 100, 100), mk('2024-01-03', 100, 100, 100, 100), mk('2024-01-04', 100, 100, 100, 100)];
  bars[1].suspended = true;                              // 1-03 全天停牌
  const sigs = bars.map((b, i) => ({ i, dir: DIR.LONG }));
  const res = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 1 }).run(sigs);
  assert.ok(res.rejects.some(r => r.kind === 'suspended'), '停牌日必须拒单并留下记录');
  assert.ok(res.trades.every(t => t.entryIdx !== 1), '不许在停牌那根成交');
});

test('引擎：缺口过长（前收盘已失效）时跳过板锁判定，而不是拿旧价算涨跌停', () => {
  const bars = [
    mk('2024-01-02', 100, 100, 100, 100),
    mk('2024-01-03', 100, 100, 100, 100),
    mk('2024-02-20', 130, 131, 129, 130)               // 停牌一个多月后复牌
  ];
  bars[2].stalePrevClose = true;
  const rules = { canOpen: () => ({ ok: true }), canFillAt: () => ({ ok: false, reason: '不该被调用' }), tPlus1: false, cost: () => 0 };
  // 信号在 1-03（正常 bar）产生、成交落在复牌首根 2-20：只有那一根的板锁该被跳过
  const sigs = bars.map((b, i) => (i === 1 ? { i, dir: DIR.LONG } : null));
  const res = new BacktestEngine(bars, { ...SPEC, multiplier: 100 }, { capital: 1e6, lots: 100, rules }).run(sigs);
  assert.ok(res.trades.length >= 1, '板锁判定被跳过，复牌首单应当成交');
  assert.eq(res.trades[0].entryIdx, 2);
  assert.ok(!res.rejects.some(r => r.kind === 'boardLock'), '前收盘价失效时不得用板幅拒单');
});

// ---------- 引擎：逐日盯市 ----------
function trending(n = 40, start = 100, step = 1) {
  return Array.from({ length: n }, (_, i) => mk(`d${i}`, start + i * step, start + i * step + 1, start + i * step - 1, start + i * step + 0.5));
}

test('逐日盯市：不发生强平时，权益曲线必须与不盯市完全一致（结算不许造钱）', () => {
  const bars = trending(40);
  const sigs = bars.map((b, i) => ({ i, dir: DIR.LONG }));
  const plain = new BacktestEngine(bars, SPEC, { capital: 200000, lots: 2 }).run(sigs);
  const settled = new BacktestEngine(bars, SPEC, { capital: 200000, lots: 2, settlement: { enabled: true } }).run(sigs);
  assert.eq(settled.equityCurve.length, plain.equityCurve.length);
  const diff = Math.max(...settled.equityCurve.map((p, i) => Math.abs(p.equity - plain.equityCurve[i].equity)));
  assert.ok(diff < 1e-6, `权益逐根必须一模一样，实际最大偏差 ${diff}`);
  assert.eq(JSON.stringify(settled.trades.map(t => t.netPnL)), JSON.stringify(plain.trades.map(t => t.netPnL)), '成净盈亏不许因结算口径改变');
});

test('逐日盯市：保证金占用按结算价重算，现金跟着反向调整', () => {
  const bars = trending(20);
  const sigs = bars.map((b, i) => ({ i, dir: DIR.LONG }));
  const eng = new BacktestEngine(bars, SPEC, { capital: 200000, lots: 2, settlement: { enabled: true } });
  eng.run(sigs);
  const withMargin = eng.equityCurve.filter(p => p.inPosition && p.margin > 0);
  assert.ok(withMargin.length > 5);
  for (const p of withMargin) {
    if (p.settled) {
      // 当日无负债结算之后账面上不再有浮动盈亏 —— 那笔钱已划进现金，
      // 所以此刻恒等式是 cash + 占用 = 权益。
      assert.near(p.cash + p.margin, p.equity, 1e-6, `结算后 cash+占用 必须等于权益（第 ${p.idx} 根）`);
      assert.eq(p.floating, 0, '结算后不能再挂一份浮动盈亏，否则上层拿这三个字段算会重复计算');
      assert.ok(Number.isFinite(p.settledPnl), '本段划转的盈亏要单独留痕');
    } else {
      assert.near(p.cash + p.margin + p.floating, p.equity, 1e-6);
    }
  }
  assert.ok(withMargin.some(p => p.settled), '开了盯市应当至少有一根记录了结算状态');
  const rising = withMargin.slice(0, 6);
  assert.ok(rising[rising.length - 1].margin > rising[0].margin, '价格上涨时多头占用必须跟着涨，否则回撤被系统性低估');
});

test('逐日盯市：可用资金转负发追保通知，权益跌破维持线在次根开盘强平', () => {
  // 高杠杆 + 反向暴跌：占用按结算价重算后维持线一定会被击穿
  const bars = [];
  for (let i = 0; i < 6; i++) bars.push(mk(`d${i}`, 100, 101, 99, 100));
  for (let i = 0; i < 12; i++) { const p = 98 - i * 4; bars.push(mk(`r${i}`, p + 2, p + 3, p - 2, p)); }
  const sigs = bars.map((b, i) => (i === 1 ? { i, dir: DIR.LONG } : null));
  // 300 手 @100：占用 30000、可用 68800；价格跌到 ~76 时权益 28000 已低于维持线 21600×0.75 之后
  const eng = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 300, settlement: { enabled: true, maintenanceRatio: 0.75 } });
  const res = eng.run(sigs);
  assert.ok(res.marginNotices.length > 0, '应当留下追保/强平通知记录');
  assert.eq(res.marginNotices[0].kind, 'margin_call');
  assert.ok(res.trades.some(t => t.exitReason === 'margin_call'), '跌破维持线必须被强平');
  const call = res.trades.find(t => t.exitReason === 'margin_call');
  const noticeIdx = res.marginNotices[0].idx;
  assert.ok(call.exitIdx > noticeIdx, '强平在通知之后的那一根开盘执行，不能假设当根就能出掉');
  assert.ok(res.rejected.marginCalls >= 1);
});

test('逐日盯市：结算价口径写进返回值，不让使用者以为是真实结算价', () => {
  const bars = trending(10);
  const sigs = bars.map((b, i) => (i === 0 ? { i, dir: DIR.LONG } : null));
  const on = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 1, settlement: { enabled: true } }).run(sigs);
  const off = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 1 }).run(sigs);
  assert.ok(on.settlement && /收盘价代理/.test(on.settlement.note), '必须声明结算价是代理值');
  assert.eq(off.settlement, null, '没开就是没开，不能给一个默认对象让人以为在跑');
});

// ---------- 账目闭合：单品种引擎的硬验收 ----------
/** 造一段先涨后跌的走势，配合不同信号形态跑出多种出场路径。 */
function wave(n = 60, start = 100, up = 1.6, down = 1.1) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const p = i < n / 2 ? start + i * up : start + (n / 2) * up - (i - n / 2) * down;
    bars.push(mk(`w${i}`, p, p + 1.5, p - 1.5, p + 0.3));
  }
  return bars;
}

const cases = [
  ['裸信号（只有 end_of_data 收尾）', (bars) => bars.map((b, i) => (i % 12 === 5 ? { i, dir: DIR.LONG } : i % 12 === 11 ? { i, dir: DIR.FLAT } : null)), {}],
  ['带止损止盈', (bars) => bars.map((b, i) => (i % 10 === 3 ? { i, dir: DIR.LONG, stop: b.close * 0.97, target: b.close * 1.06 } : null)), {}],
  ['分批止盈 + 移动止损', (bars) => bars.map((b, i) => (i % 9 === 2 ? { i, dir: DIR.LONG, target: b.close * 1.03, takeProfitFraction: 0.5, trail: { pct: 0.02 } } : null)), {}],
  ['做空 + 金字塔加仓', (bars) => bars.map((b, i) => (i % 14 === 4 ? { i, dir: DIR.SHORT, stop: b.close * 1.04, adds: [{ kind: 'add', price: b.close * 0.985, qty: 2 }] } : null)), { pyramid: { maxAdds: 2, stepPct: 0.015, decay: 0.5 } }],
  ['逐日盯市结算', (bars) => bars.map((b, i) => (i % 8 === 2 ? { i, dir: DIR.LONG, stop: b.close * 0.955 } : null)), { settlement: { enabled: true, maintenanceRatio: 0.75 } }],
  ['按名义仓位（手数随权益变）', (bars) => bars.map((b, i) => (i % 10 === 4 ? { i, dir: DIR.LONG } : i % 10 === 9 ? { i, dir: DIR.FLAT } : null)), { sizing: 'notional', notionalPct: 0.4 }]
];

for (const [label, mkSignals, extra] of cases) {
  test(`BacktestEngine 账目闭合 · ${label}：期末权益 = 本金 + Σ净盈亏`, () => {
    const bars = wave();
    const eng = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 3, slippageTicks: 1, ...extra });
    const res = eng.run(mkSignals(bars));
    assert.ok(res.trades.length > 0, `${label}：一笔都没成交的话这条断言是空的`);
    const sumNet = res.trades.reduce((s, t) => s + t.netPnL, 0);
    assert.near(res.finalEquity, 100000 + sumNet, 0.3,
      `${label} 差 ${Math.round((res.finalEquity - 100000 - sumNet) * 100) / 100} —— 现金池漏记或重复记账`);
    // 曲线每一点都必须是自己三个字段之和：上层（组合、报表、水下曲线）全拿 equity 做二次计算
    for (const p of res.equityCurve) {
      assert.near(p.equity, p.cash + (p.margin || 0) + (p.floating || 0), 0.3,
        `${label} ${p.date} 这一点 cash+占用+浮动 ≠ 权益`);
    }
    const last = res.equityCurve[res.equityCurve.length - 1];
    assert.eq(last.inPosition, false, '收尾强平之后末点不该还有持仓');
    assert.near(last.equity, res.finalEquity, 1e-6, '末点权益必须就是期末权益（含收尾平仓费）');
  });
}
