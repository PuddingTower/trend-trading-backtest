import { test, assert } from './harness.js';
import { AShareRules, FuturesRules, rulesFor, aShareCost } from '../src/markets/marketRules.js';
import { BacktestEngine, DIR } from '../src/core/backtestEngine.js';
import { resolveTradeSpec } from '../src/markets/instrumentSpec.js';

const ASPEC = { market: 'ashare', multiplier: 100, tick: 0.01, marginRate: 1, limitPct: 0.10,
  fee: { mode: 'rate', value: 0.00025, min: 5 }, stampTax: { mode: 'rate', value: 0.0005 }, transferFee: { mode: 'rate', value: 0.00001 } };
const FSPEC = { market: 'futures', multiplier: 10, tick: 1, marginRate: 0.09, limitPct: 0.08,
  fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 30 } };
const mk = (d, o, h, l, c, v = 1000) => ({ date: d, open: o, high: h, low: l, close: c, volume: v });

test('A股：默认禁止做空', () => {
  const r = new AShareRules(ASPEC);
  assert.eq(r.canOpen('long').ok, true);
  assert.eq(r.canOpen('short').ok, false);
  assert.eq(r.canOpen('short').reason.includes('两融'), true);
  assert.eq(new AShareRules({ ...ASPEC, allowShort: true }).canOpen('short').ok, true, '两融开关打开后允许');
});

test('A股：涨停封板时买不进，但平仓（卖出）可成', () => {
  const r = new AShareRules(ASPEC);
  const prevClose = 100, limitUp = 110;
  assert.eq(r.canFillAt('buy', limitUp, prevClose, { closing: false }).ok, false, '涨停开多不成交');
  assert.eq(r.canFillAt('sell', limitUp, prevClose, { closing: true }).ok, true, '涨停时多头可以走');
  assert.eq(r.canFillAt('buy', 105, prevClose, {}).ok, true, '未封板正常成交');
});

test('A股：封死的跌停板上，平仓卖出同样成交不了（旧口径给平仓开的后门已取消）', () => {
  const r = new AShareRules(ASPEC);
  assert.eq(r.canFillAt('sell', 90, 100, { closing: false }).ok, false, '开空方向卖不掉');
  assert.eq(r.canFillAt('sell', 90, 100, { closing: true }).ok, false, '平多方向一样卖不掉：排在你前面的人比你还急');
  assert.eq(r.canFillAt('buy', 90, 100, { closing: true }).ok, true, '跌停板上买单是稀缺方，空头买回立刻成交');
  assert.eq(r.canFillAt('sell', 110, 100, { closing: true }).ok, true, '涨停板上多头卖出有人接，照常放行');
  // 盘中破板（锚定价回到板幅之内）就不再算封死，否则任何擦到跌停的止损都会被无脑拒掉
  assert.eq(r.canFillAt('sell', 90, 100, { closing: true, sealRef: 90 }).ok, false, '锚定价钉在跌停 = 封死');
  assert.eq(r.canFillAt('sell', 95, 100, { closing: true, sealRef: 90 }).ok, true, '止损价 95 在跌停上方，是下行途中成交的，不该算板锁');
});

test('A股：创业板 20% 板幅比主板宽', () => {
  const gem = new AShareRules({ ...ASPEC, limitPct: 0.20 });
  assert.eq(gem.canFillAt('buy', 110, 100, {}).ok, true, '110 对创业板不是涨停');
  assert.eq(gem.canFillAt('buy', 120, 100, {}).ok, false);
});

test('A股：买入整手、卖出允许零股清仓', () => {
  const r = new AShareRules(ASPEC);
  assert.eq(r.normalizeQty(150), 100, '150 股买只能买 100');
  assert.eq(r.normalizeQty(99), 100, '不足一手按一手');
  assert.eq(r.normalizeQty(350, { sell: true }), 350, '卖出可带零股');
});

test('A股成本：佣金最低 5 元、印花税只收卖出', () => {
  // qty 的单位是「手」，1 手 = 100 股，所以名义 = price × 100 × 手数
  const small = aShareCost(ASPEC, 10, 1, { sell: false });      // 名义 1000 元，万2.5=0.25 → 抬到最低 5
  assert.near(small, 5 + 1000 * 0.00001, 0.01, '小额成交被最低佣金主导');
  const buy = aShareCost(ASPEC, 100, 1, { sell: false });
  const sell = aShareCost(ASPEC, 100, 1, { sell: true });
  assert.ok(sell > buy, '卖出多出印花税');
  assert.near(sell - buy, 10000 * 0.0005, 0.01, '印花税 = 名义 × 0.05%');
});

test('期货：双向都可开，板锁按品种比例', () => {
  const r = new FuturesRules(FSPEC);
  assert.eq(r.canOpen('short').ok, true);
  assert.eq(r.canFillAt('buy', 108, 100, {}).ok, false, '8% 涨停');
  assert.eq(r.canFillAt('buy', 105, 100, {}).ok, true);
});

test('引擎接入规则：涨停当天买不进 → 该笔被拒而不是假装成交', () => {
  const bars = [mk('d0', 98, 99, 97, 98), mk('d1', 99, 100, 98, 100), mk('d2', 110, 110.5, 109, 110)];
  const eng = new BacktestEngine(bars, ASPEC, { capital: 1e6, rules: new AShareRules(ASPEC) });
  const out = eng.run([null, { i: 1, dir: DIR.LONG }, null]);
  assert.eq(out.trades.length, 0, 'd2 开盘 110 = 前收 100 的涨停价，封板买不进');
  assert.eq(out.rejected.boardLock >= 1, true);
  assert.ok(out.rejects[0].reason.includes('涨停'));
});

test('引擎接入规则：T+1 挡住当日买入当日卖出', () => {
  // 同一天四根 60 分钟 bar：11:00 出信号 → 13:00 成交 → 14:00 打到止损，但当天不能卖，
  // 只能等到次日开盘。日线口径下 idx<=entryIdx 那条已经挡住了，这里测的是日内。
  const bars = [
    mk('2024-01-02 10:00', 100, 101, 99, 100), mk('2024-01-02 11:00', 100, 101, 99, 100),
    mk('2024-01-02 13:00', 100, 101, 99, 100), mk('2024-01-02 14:00', 100, 101, 88, 89),
    mk('2024-01-03 10:00', 87, 88, 86, 87)
  ];
  const spec = { ...ASPEC, limitPct: null };
  const eng = new BacktestEngine(bars, spec, { capital: 1e6, rules: new AShareRules(spec) });
  const out = eng.run([null, { i: 1, dir: DIR.LONG, stop: 92 }, null, null, null]);
  assert.ok(out.rejects.some(x => x.kind === 'tPlus1'), `当日止损应被 T+1 拦下，实际 ${JSON.stringify(out.rejects)}`);
  const t = out.trades[0];
  assert.eq(t.entryDate, '2024-01-02 13:00');
  assert.eq(t.exitDate, '2024-01-03 10:00', '只能等到次日');
  assert.ok(t.netPnL < 0, 'T+1 让当天本该止住的亏损多扛到次日，这笔亏损应更大');
});

test('rulesFor 按市场选对规则类', () => {
  assert.eq(rulesFor(resolveTradeSpec('600519').spec).name, 'ashare');
  assert.eq(rulesFor(resolveTradeSpec('RB0').spec).name, 'futures');
});

test('不传 rules 时引擎行为不变（老跑批不受影响）', () => {
  const bars = [mk('d0', 3000, 3010, 2990, 3000), mk('d1', 3000, 3010, 2990, 3000), mk('d2', 3100, 3110, 3090, 3100)];
  const out = new BacktestEngine(bars, FSPEC, { capital: 1e6 }).run([null, { i: 1, dir: DIR.LONG }, null]);
  assert.eq(out.trades.length, 1);
  assert.eq(out.trades[0].entryPrice, 3100);
});
