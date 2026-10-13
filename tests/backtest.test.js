import { test, assert, skip } from './harness.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BacktestEngine, DIR } from '../src/core/backtestEngine.js';
import { computeMetrics, maxDrawdown } from '../src/report/metrics.js';
import { STRATEGIES } from '../src/strategy/library.js';
import { ema, sma, rsi, macd, atr, priorExtreme, crosses } from '../src/strategy/indicators.js';

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(DIRNAME, '..', 'fixtures');
/** 夹具不入库（可由 tools/fetch_fixtures.py 重抓），所以缺时相关用例跳过而不是报错。 */
const HAS_FIXTURES = fs.existsSync(path.join(FIX, 'index.json'));
const SPEC = { multiplier: 10, tick: 1, marginRate: 0.1, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 } };
const mk = (date, o, h, l, c, v = 1000) => ({ date, open: o, high: h, low: l, close: c, volume: v });

// ---------- 确定性 ----------
test('确定性：同一输入跑两次，逐字段完全一致', () => {
  if (!HAS_FIXTURES) skip('未抓取 fixtures/（跑 python tools/fetch_fixtures.py 后可用）');
  const bars = JSON.parse(fs.readFileSync(path.join(FIX, 'futures_rbm_daily_none.json'), 'utf8')).bars;
  const sig = STRATEGIES[0].signals(bars, {});
  const run = () => new BacktestEngine(bars, SPEC, { capital: 200000, slippageTicks: 1 }).run(sig);
  const a = run(), b = run();
  assert.eq(JSON.stringify(a.trades), JSON.stringify(b.trades), '交易列表必须逐字节一致');
  assert.eq(JSON.stringify(a.equityCurve), JSON.stringify(b.equityCurve), '权益曲线必须逐字节一致');
  assert.eq(a.trades.length > 20, true, '夹具应有足量交易，否则这条确定性测试没意义');
});

test('确定性：策略信号与品种无关的全局状态不存在（连续调用稳定）', () => {
  if (!HAS_FIXTURES) skip('未抓取 fixtures/（跑 python tools/fetch_fixtures.py 后可用）');
  const bars = JSON.parse(fs.readFileSync(path.join(FIX, 'futures_egm_daily_none.json'), 'utf8')).bars;
  for (const st of STRATEGIES) {
    const s1 = JSON.stringify(st.signals(bars, {}));
    const s2 = JSON.stringify(st.signals(bars, {}));
    assert.eq(s1, s2, `${st.name} 两次调用结果不同，说明有隐藏状态`);
  }
});

// ---------- 反未来函数 ----------
test('次根开盘成交：信号 bar 的收盘价绝不影响该笔成交价', () => {
  const bars = [
    mk('d0', 100, 101, 99, 100), mk('d1', 100, 101, 99, 100),
    mk('d2', 150, 151, 149, 150), mk('d3', 160, 161, 159, 160)   // d1 收盘出信号
  ];
  const sig = [null, { i: 1, dir: DIR.LONG }, { i: 2, dir: DIR.FLAT }, null];
  const out = new BacktestEngine(bars, SPEC, { capital: 1e6, slippageTicks: 0 }).run(sig);
  assert.eq(out.trades.length, 1);
  const t = out.trades[0];
  assert.eq(t.entryPrice, 150, '成交价应是 d2 的开盘 150，不是信号 bar d1 的收盘 100');
  assert.eq(t.entryIdx, 2);
  assert.eq(t.exitPrice, 160, '平仓信号在 d2 → d3 开盘成交');
});

test('不提供「当根成交」旋钮：传 entryBarOffset=0 也必须次根开盘成交', () => {
  const bars = [mk('d0', 100, 101, 99, 100), mk('d1', 100, 101, 99, 100), mk('d2', 120, 121, 119, 120), mk('d3', 130, 131, 129, 130)];
  const sig = [null, { i: 1, dir: DIR.LONG }, null, null];
  const withKnob = new BacktestEngine(bars, SPEC, { capital: 1e6, slippageTicks: 0, entryBarOffset: 0 }).run(sig);
  assert.eq(withKnob.trades[0].entryPrice, 120, '那个旋钮已删除，传了也不生效 —— 当根成交等于用未来信息');
});

test('信号 bar 当根不得被止损平掉（避免同一根进出）', () => {
  const bars = [mk('d0', 100, 101, 99, 100), mk('d1', 100, 101, 99, 100), mk('d2', 100, 60, 59, 61)];
  const sig = [null, { i: 1, dir: DIR.LONG, stop: 999 }, null];
  const out = new BacktestEngine(bars, SPEC, { capital: 1e6, slippageTicks: 0 }).run(sig);
  assert.ok(out.trades[0].exitIdx >= 2, '止损最早只能在成交后的下一根生效');
});

test('跳空穿透止损按开盘成交，不按止损价（不美化亏损）', () => {
  const bars = [
    mk('d0', 100, 101, 99, 100), mk('d1', 100, 101, 99, 100),
    mk('d2', 100, 101, 99, 100), mk('d3', 70, 71, 69, 70)     // 大幅低开，穿过 95 的止损
  ];
  const sig = [null, { i: 1, dir: DIR.LONG, stop: 95 }, null, null];
  const out = new BacktestEngine(bars, SPEC, { capital: 1e6, slippageTicks: 0 }).run(sig);
  const t = out.trades[0];
  assert.eq(t.exitPrice, 70, '应按 d3 开盘 70 成交，而不是按止损价 95 —— 后者会少记 25 点的亏损');
  assert.eq(t.exitReason, 'gap_stop');
});

test('同一根内止损与止盈都可能触发时，先算止损（悲观优先）', () => {
  const bars = [
    mk('d0', 100, 101, 99, 100),
    mk('d1', 100, 101, 99, 100),
    mk('d2', 100, 101, 99, 100),
    mk('d3', 100, 130, 80, 110)     // 同时穿越 stop=85 与 target=120
  ];
  const sig = [null, { i: 1, dir: DIR.LONG, stop: 85, target: 120 }, null, null];
  const out = new BacktestEngine(bars, SPEC, { capital: 1e6, slippageTicks: 0 }).run(sig);
  assert.eq(out.trades[0].entryIdx, 2, '成交在 d2');
  assert.eq(out.trades[0].exitReason, 'stop', '不能挑对自己有利的那个成交');
  assert.eq(out.trades[0].exitPrice, 85);
});

// ---------- 手算对账 ----------
test('手算对账：一笔完整多单的盈亏/手续费/权益', () => {
  const bars = [
    mk('d0', 3000, 3010, 2990, 3000),
    mk('d1', 3000, 3010, 2990, 3000),   // 信号
    mk('d2', 3100, 3150, 3080, 3120),   // 开盘 3100 成交
    mk('d3', 3200, 3250, 3180, 3220),   // 开盘 3200 平
    mk('d4', 3200, 3210, 3190, 3200)
  ];
  const sig = [null, { i: 1, dir: DIR.LONG }, { i: 2, dir: DIR.FLAT }, null, null];
  const eng = new BacktestEngine(bars, SPEC, { capital: 200000, lots: 2, slippageTicks: 0 });
  const out = eng.run(sig);
  assert.eq(out.trades.length, 1);
  const t = out.trades[0];
  assert.eq(t.entryPrice, 3100);
  assert.eq(t.exitPrice, 3200);
  assert.eq(t.gross, (3200 - 3100) * 10 * 2);           // 2000
  assert.eq(t.fee, 3 * 2 + 3 * 2);                       // 开 6 + 平 6
  assert.eq(t.netPnL, 2000 - 12);
  // 权益：开仓占用保证金 3100*10*2*0.1=62000，平仓后返还 + 净盈亏
  const atEnd = out.equityCurve[out.equityCurve.length - 1].equity;
  assert.eq(atEnd, 200000 + 2000 - 12);
});

test('平今仓费：同一根开平按 closeTodayFee 计', () => {
  const spec = { ...SPEC, closeTodayFee: { mode: 'fixed', value: 30 } };
  const bars = [mk('d0', 3000, 3010, 2990, 3000), mk('d1', 3000, 3010, 2990, 3000), mk('d2', 3100, 3150, 3080, 3120)];
  const sig = [null, { i: 1, dir: DIR.LONG }, null];
  const out = new BacktestEngine(bars, spec, { capital: 200000, lots: 1, slippageTicks: 0 }).run(sig);
  const t = out.trades[0];
  assert.eq(t.exitIdx, t.entryIdx, '末根强平与开仓同日');
  assert.eq(t.fee, 3 + 30, '开仓 3 元 + 平今 30 元');
});

test('滑点方向永远不利：多头买高卖低，空头卖低买高', () => {
  const bars = [mk('d0', 100, 101, 99, 100), mk('d1', 100, 101, 99, 100), mk('d2', 3000, 3010, 2990, 3000), mk('d3', 3000, 3010, 2990, 3000)];
  const long = new BacktestEngine(bars, SPEC, { capital: 1e9, slippageTicks: 2 }).run([null, { i: 1, dir: DIR.LONG }, null, null]).trades[0];
  assert.eq(long.entryPrice, 3002, '买入应加 2 tick');
  const short = new BacktestEngine(bars, SPEC, { capital: 1e9, slippageTicks: 2 }).run([null, { i: 1, dir: DIR.SHORT }, null, null]).trades[0];
  assert.eq(short.entryPrice, 2998, '卖出开仓应减 2 tick');
});

test('资金不足时拒单而不是强行开仓', () => {
  const bars = [mk('d0', 5000, 5010, 4990, 5000), mk('d1', 5000, 5010, 4990, 5000), mk('d2', 5000, 5010, 4990, 5000)];
  const out = new BacktestEngine(bars, SPEC, { capital: 1000, lots: 1 }).run([null, { i: 1, dir: DIR.LONG }, null]);
  assert.eq(out.trades.length, 0);
  assert.eq(out.rejected.margin, 1);
});

test('禁止做空时空头信号被丢弃（A股口径的开关位）', () => {
  const bars = [mk('d0', 100, 101, 99, 100), mk('d1', 100, 101, 99, 100), mk('d2', 90, 91, 89, 90), mk('d3', 80, 81, 79, 80)];
  const out = new BacktestEngine(bars, SPEC, { capital: 1e6, allowShort: false }).run([null, { i: 1, dir: DIR.SHORT }, null, null]);
  assert.eq(out.trades.length, 0);
  assert.eq(out.rejected.shortDisabled, 1);
});

// ---------- 指标 ----------
test('EMA/SMA：暖机期为 null，首值为窗口简单均值', () => {
  const xs = [1, 2, 3, 4, 5, 6];
  assert.eq(sma(xs, 3)[1], null);
  assert.eq(sma(xs, 3)[2], 2);
  assert.eq(ema(xs, 3)[1], null);
  assert.eq(ema(xs, 3)[2], 2, 'EMA 首值=前3根均值');
  const k = 2 / 4;
  assert.near(ema(xs, 3)[3], 4 * k + 2 * (1 - k), 1e-9);
});

test('priorExtreme 不含当前 bar（否则突破判定自欺）', () => {
  const bars = [mk('a', 1, 10, 1, 5), mk('b', 1, 20, 1, 5), mk('c', 1, 5, 1, 5)];
  const hh = priorExtreme(bars, 2, 'high');
  assert.eq(hh[1], null, '不足回看期必须 null');
  assert.eq(hh[2], 20, 'c 的前2根最高是 b 的 20，不含 c 自己');
});

test('RSI 边界：全涨=100，全跌<1', () => {
  const up = rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 14);
  assert.eq(up[14], 100);
  const dn = rsi([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 14);
  assert.ok(dn[14] < 1, `全跌应趋近 0，实际 ${dn[14]}`);
});

test('MACD 柱 = 2*(DIF-DEA)（国内软件惯例，不是 DIF-DEA）', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10);
  const { dif, dea, hist } = macd(closes, {});
  const i = dif.findIndex(v => v !== null);
  const j = dif.findIndex((v, k) => v !== null && dea[k] !== null);
  assert.near(hist[j], (dif[j] - dea[j]) * 2, 1e-9);
  assert.eq(dif[i - 1], null);
});

test('crosses：只在真正穿越的那一根给 true', () => {
  const a = [1, 3, 4, 1], b = [2, 2, 2, 2];
  const { up, dn } = crosses(a, b);
  assert.eq(up[1], true, '由下方穿到上方');
  assert.eq(up[2], false, '持续在上不算新的上穿');
  assert.eq(dn[2], false, '还在上方不算下穿');
  assert.eq(dn[3], true, '跌回下方');
});

test('ATR 与 analysis 层同源（同一实现不重复造）', () => {
  const bars = [mk('a', 10, 12, 8, 11), mk('b', 11, 13, 9, 12), mk('c', 12, 15, 11, 14)];
  const a = atr(bars, 2);
  assert.eq(a[0], null);
  assert.near(a[1], ((12 - 8) + Math.max(4, 2, 1)) / 2, 1e-9);
});

// ---------- 报表 ----------
test('最大回撤与手算一致', () => {
  const eq = [100, 120, 90, 95, 60, 80];
  const { maxDD, maxDDPct } = maxDrawdown(eq);
  assert.eq(maxDD, 60, '峰值 120 → 谷值 60');
  assert.near(maxDDPct, 0.5, 1e-9);
});

test('指标：胜率/盈亏比/Sharpe 与手算一致', () => {
  const bars = Array.from({ length: 253 }, (_, i) => mk(`d${i}`, 100, 101, 99, 100));
  const trades = [
    { netPnL: 300, fee: 10, holdingBars: 5, entryReason: 'x', exitReason: 'y', dir: 'long' },
    { netPnL: -100, fee: 10, holdingBars: 3, entryReason: 'x', exitReason: 'y', dir: 'long' },
    { netPnL: 200, fee: 10, holdingBars: 4, entryReason: 'x', exitReason: 'y', dir: 'long' },
    { netPnL: -100, fee: 10, holdingBars: 2, entryReason: 'x', exitReason: 'y', dir: 'long' }
  ];
  const curve = bars.map((b, i) => ({ idx: i, date: b.date, equity: 100000 + (i > 0 ? 100 : 0), inPosition: i % 2 === 0, cash: 100000, floating: 0, dir: 1 }));
  const m = computeMetrics({ equityCurve: curve, trades, capital: 100000, periodsPerYear: 252, bars });
  assert.eq(m.winRate, 0.5);
  assert.eq(m.avgWin, 250, '(300+200)/2');
  assert.eq(m.avgLoss, 100);
  assert.eq(m.profitFactor, 2.5, '500/200');
  assert.near(m.exposure, 127 / 253, 1e-9, '253 根里 127 根持仓');
  assert.eq(m.totalFees, 40);
});

// ---------- 真实夹具健全性 ----------
test('夹具数据本身没有 OHLC 关系违例（字段序错会在这里暴露）', () => {
  if (!HAS_FIXTURES) skip('未抓取 fixtures/（跑 python tools/fetch_fixtures.py 后可用）');
  const files = fs.readdirSync(FIX).filter(f => f.endsWith('.json') && f !== 'index.json');
  assert.ok(files.length >= 10, `夹具太少：${files.length}`);
  for (const f of files) {
    const { bars, meta } = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
    const bad = bars.filter(b => !(b.high >= Math.max(b.open, b.close, b.low) && b.low <= Math.min(b.open, b.close, b.high)));
    assert.eq(bad.length, 0, `${meta.name} 有 ${bad.length} 根 OHLC 关系不成立`);
    for (let i = 1; i < bars.length; i++) assert.ok(bars[i].date > bars[i - 1].date, `${f} 日期非升序/有重复`);
    if (meta.market === 'ashare' && meta.adjust === 'hfq') {
      assert.ok(Math.min(...bars.map(b => b.close)) > 0, `${meta.name} 后复权出现非正价格`);
    }
  }
});

test('逐日盯市强平：权益跌破维持线必须在下一根开盘平掉，而不是让权益亏成负数', () => {
  // 5 万本金开 9 手（保证金 4.5 万，几乎满仓），单日 -7.5%（在 8% 涨跌停之内）
  const bars = [
    mk('d0', 5000, 5010, 4990, 5000),
    mk('d1', 5000, 5010, 4990, 5000),        // 信号
    mk('d2', 5000, 5010, 4990, 5000),        // 开盘成交，保证金 5000*10*0.1*9 = 45000
    mk('d3', 4625, 4650, 4620, 4625),        // -7.5% → 亏 33750，权益 16250 < 维持线 22500
    mk('d4', 4600, 4610, 4590, 4600)         // 应在本根开盘被强平
  ];
  const eng = new BacktestEngine(bars, SPEC, { capital: 50000, lots: 9, slippageTicks: 0 });
  const out = eng.run([null, { i: 1, dir: DIR.LONG }, null, null, null]);
  assert.ok(out.trades.length >= 1, '应有一笔已了结交易');
  const t = out.trades[0];
  assert.eq(t.exitReason, 'margin_call', `实际出场原因：${out.trades.map(x => x.exitReason).join(',')}`);
  assert.eq(t.exitIdx, 4, '跌破只发生在 d3 收盘盯市后，强平在 d4 开盘 —— 不能用 d3 的价格提前平掉');
  const minEquity = Math.min(...out.equityCurve.map(p => p.equity));
  assert.ok(minEquity > 0, `强平后权益不该转负，实际最低 ${minEquity.toFixed(0)}`);
});

test('爆仓要标 ruined，而不是让年化/Sharpe 静默变 NaN 冒充"业绩差"', () => {
  const bars = Array.from({ length: 300 }, (_, i) => mk(`d${i}`, 100, 101, 99, 100));
  const curve = bars.map((b, i) => ({ idx: i, date: b.date, equity: i < 150 ? 100000 - i * 800 : -20000, inPosition: false, cash: 0, floating: 0, dir: 0 }));
  const m = computeMetrics({ equityCurve: curve, trades: [], capital: 100000, periodsPerYear: 252, bars });
  assert.eq(m.ruined, true);
  assert.eq(m.annualReturn, null, '负权益开分数次幂是 NaN，必须显式 null');
  assert.eq(Number.isFinite(m.sharpe), false);
});

test('真实数据上跑全部策略不抛错，且每笔交易 exitIdx > entryIdx', () => {
  if (!HAS_FIXTURES) skip('未抓取 fixtures/（跑 python tools/fetch_fixtures.py 后可用）');
  for (const f of fs.readdirSync(FIX).filter(x => x.endsWith('.json') && x !== 'index.json').slice(0, 6)) {
    const { bars, meta } = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
    const spec = meta.market === 'futures' ? SPEC : { multiplier: 100, tick: 0.01, marginRate: 1, fee: { mode: 'rate', value: 0.00025 } };
    for (const st of STRATEGIES) {
      const out = new BacktestEngine(bars, spec, { capital: 500000, slippageTicks: 1 }).run(st.signals(bars, {}));
      for (const t of out.trades) {
        assert.ok(t.exitIdx > t.entryIdx, `${st.name}/${meta.name} 出现时间倒挂的交易`);
        assert.ok(Number.isFinite(t.netPnL), `${st.name}/${meta.name} 净盈亏非有限值`);
      }
      assert.eq(out.equityCurve.length, bars.length);
    }
  }
});


