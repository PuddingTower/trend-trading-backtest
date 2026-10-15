/**
 * 前视探针自身的测试 + 现有策略/引擎的因果性门禁。
 *
 * 关键设计一：**探针必须自己证明能抓到鬼**。每组门禁都配一条故意种下的泄漏，断言探针报红。
 *   没有这一条，探针可能只是永远绿灯的摆设 —— 第一轮跑就靠这条抓出了探针自己的盲区。
 * 关键设计二：突变未来要用**改写**（rewriteBarsAfter）而不是整体放大（shockBarsAfter）：
 *   波动率、收益这类比率型依赖对同比例放大是不变的，只拿放大去测，探针会假装什么都没发生。
 */
import { test, assert } from './harness.js';
import { makeRng } from '../src/core/rng.js';
import { STRATEGIES, trendTemplate } from '../src/strategy/library.js';
import { BacktestEngine } from '../src/core/backtestEngine.js';
import { PortfolioEngine } from '../src/core/portfolioEngine.js';
import { annualizedVol } from '../src/core/sizing.js';
import { signalPrefixProbe, futureInvarianceProbe, shockBarsAfter, rewriteBarsAfter,
         auditStrategies } from '../src/validation/leakProbe.js';
import { checkPriceValidity } from '../src/markets/dataQuality.js';

const SPEC = { multiplier: 10, tick: 1, marginRate: 0.1, fee: { mode: 'fixed', value: 4 }, market: 'futures' };
const r2 = (v) => Math.round(v * 100) / 100;
const dayOf = (i) => new Date(Date.UTC(2020, 0, 2 + i)).toISOString().slice(0, 10);

/** 确定性伪随机游走：有波动有趋势段，够喂 MA200/区间 250 那些长窗口策略。 */
function walkBars(n, seed = 7, start = 3000) {
  const rng = makeRng(seed), bars = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const shock = (rng() + rng() + rng() + rng() + rng() + rng() - 3) / 1.2;
    const c = p * (1 + 0.0004 + 0.012 * shock);
    const o = p, h = Math.max(o, c) * (1 + 0.004 * rng()), l = Math.min(o, c) * (1 - 0.004 * rng());
    bars.push({ date: dayOf(i), open: r2(o), high: r2(h), low: r2(l), close: r2(c),
                volume: Math.round(50000 + 40000 * rng()) });
    p = c;
  }
  return bars;
}
const BARS = walkBars(1200);
const CUT = dayOf(600);

// ---------- 探针自检：种一条泄漏，必须被抓住 ----------
test('探针自检：读未来一根的策略，前缀一致性必须报红', () => {
  const peekNext = {
    id: 'peekNext', name: '种来的泄漏', params: {},
    signals(bars) {
      return bars.map((b, i) => {
        const nxt = bars[Math.min(i + 1, bars.length - 1)];       // 典型前视：偷看下一根
        return nxt.close > b.close ? { i, dir: 1, reason: 'peek' } : null;
      });
    }
  };
  const r = signalPrefixProbe(peekNext, BARS, {}, { count: 12 });
  assert.ok(!r.ok, `应当抓到泄漏，实际 note=${r.note}`);
  assert.ok(r.leaks.length > 0, '要给出具体不一致的下标');
});

test('探针自检：信号字段里掺了全序列末尾窗口，必须报红', () => {
  const wholeSeries = {
    id: 'wholeSeries', name: '全序列归一', params: {},
    signals(bars) {
      const vol = annualizedVol(bars.slice(-120).map(b => b.close)) || 0.01;   // 原 portfolioEngine 就是这个形状
      return bars.map((b, i) => (i > 200 ? { i, dir: 1, stop: r2(b.close * (1 - vol)), reason: 'tail' } : null));
    }
  };
  const r = signalPrefixProbe(wholeSeries, BARS, {}, { count: 12 });
  assert.ok(!r.ok, `全序列末尾窗口应当被抓，实际 note=${r.note}`);
});

test('探针自检：干净策略必须报绿（否则门禁会把好策略一起毙掉）', () => {
  const causal = {
    id: 'causalMa', name: '干净双均线', params: { fast: 10, slow: 40 },
    signals(bars, p = {}) {
      const q = { ...this.params, ...p };
      const closes = bars.map(b => b.close);
      const ma = (n, i) => (i + 1 >= n ? r2(closes.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n) : null);
      return bars.map((b, i) => {
        const f = ma(q.fast, i), s = ma(q.slow, i);
        if (f === null || s === null) return null;
        return { i, dir: f > s ? 1 : 0, stop: r2(b.close * 0.97), reason: 'causal' };
      });
    }
  };
  const r = signalPrefixProbe(causal, BARS, {}, { count: 16 });
  assert.ok(r.ok, `干净策略不该报红：${r.note}`);
});

test('探针自检：引擎级"用全序列算一次再复用"要靠改写未来才抓得到', () => {
  const cleanRun = (bs) => new BacktestEngine(bs, SPEC, { capital: 100000, sizing: 'fixed', lots: 1 })
    .run(STRATEGIES[0].signals(bs, STRATEGIES[0].params));
  // 故意种泄漏：每根权益都乘一个取自**整条序列**末尾的波动率
  const leakyRun = (bs) => {
    const res = cleanRun(bs);
    const v = annualizedVol(bs.map(b => b.close).slice(-120)) || 0;
    return { ...res, equityCurve: res.equityCurve.map(p => ({ ...p, equity: r2(p.equity * (1 + v)) })) };
  };
  const rewritten = rewriteBarsAfter(BARS, CUT);
  const shocked = shockBarsAfter(BARS, CUT, 3);

  assert.ok(!futureInvarianceProbe({ run: leakyRun, base: BARS, mutated: rewritten, cutDate: CUT }).ok,
    '改写未来之后波动率就变了，种出来的引擎级泄漏应当报红');
  // 记下探针的边界：整体放大不改变收益，比率型依赖对它免疫。写进断言免得后人误以为探针万能。
  assert.ok(futureInvarianceProbe({ run: leakyRun, base: BARS, mutated: shocked, cutDate: CUT }).ok,
    '放大法对比率型依赖免疫 —— 这正是必须用 rewriteBarsAfter 的理由');
  const ok = futureInvarianceProbe({ run: cleanRun, base: BARS, mutated: rewritten, cutDate: CUT });
  assert.ok(ok.ok, `干净路径应当报绿：${ok.note}`);
  assert.ok(ok.checkedEquity > 100 && ok.checkedTrades > 0, `应真的比过东西：${JSON.stringify(ok)}`);
});

// ---------- 现有策略全量门禁 ----------
test('现有 9 个内置策略全部通过前缀一致性（含修好的 HH/HL 枢轴与 RS 日期对齐）', () => {
  const rows = auditStrategies(STRATEGIES, BARS, { count: 20 });
  const bad = rows.filter(x => !x.ok);
  assert.eq(bad.length, 0, bad.map(x => `${x.id}: ${x.note}`).join(' | '));
  assert.eq(rows.length, STRATEGIES.length);
  for (const x of rows) assert.ok(x.checked >= 3, `${x.id} 抽查点太少：${x.checked}`);
});

test('HH/HL 结构：信号挂在枢轴**确认**那根，不是极值那根', () => {
  const st = STRATEGIES.find(s => s.id === 'hhLlStructure');
  const sig = st.signals(BARS, st.params);
  assert.ok(sig.filter(Boolean).length > 0, '测试序列太短会没有结构信号');
  for (const i of [300, 500, 700, 900, 1100]) {
    const t = (st.signals(BARS.slice(0, i + 1), st.params) || [])[i];
    assert.eq(t ? t.dir : null, sig[i] ? sig[i].dir : null, `第 ${i} 根截断重算结果不同 = 用了未来枢轴`);
  }
});

// ---------- RS 基准的日期对齐 ----------
test('RS 判据按日期对齐：基准还没开始的日子里返回"不可判"，而不是拿未来的值凑', () => {
  const bench = BARS.slice(300);                                  // 基准比品种晚 300 根开始
  const early = trendTemplate(BARS.slice(0, 320), { useRs: true, rsBars: bench, riseLook: 20 });
  assert.eq(early.rsAvailable, false, `品种前段没有基准可比，${early.crit.filter(c => c.ok === null).length} 条判据未参与判定`);
  const late = trendTemplate(BARS, { useRs: true, rsBars: bench, riseLook: 20 });
  assert.eq(late.rsAvailable, true, '基准覆盖到最后一根时应当可判');
  const off = trendTemplate(BARS, { useRs: false, rsBars: bench });
  assert.ok(off.crit.some(c => c.k.startsWith('RS') && c.ok === null), '开关关着就不参与判定');
});

// ---------- 引擎级门禁 ----------
test('BacktestEngine：改写未来行情，过去的成交与权益完全不变', () => {
  const st = STRATEGIES[1];                                        // Donchian 突破，带止损/移动止损路径
  const run = (bs) => new BacktestEngine(bs, SPEC, {
    capital: 200000, sizing: 'fixed', lots: 2, slippageTicks: 1,
    settlement: { enabled: true }
  }).run(st.signals(bs, st.params));
  const r = futureInvarianceProbe({ run, base: BARS, mutated: rewriteBarsAfter(BARS, CUT), cutDate: CUT });
  assert.ok(r.ok, r.note);
});

test('PortfolioEngine：波动率目标仓位的输入必须是逐根回看的（回归 :118 那条泄漏）', () => {
  const a = walkBars(1200, 7), b = walkBars(1200, 21, 4000);
  const st = STRATEGIES[0];
  const mk = (bs) => ([
    { symbol: 'A', name: 'A', bars: bs.a, spec: SPEC, strategy: st, params: st.params },
    { symbol: 'B', name: 'B', bars: bs.b, spec: SPEC, strategy: st, params: st.params }
  ]);
  const run = (entries) => new PortfolioEngine(entries, {
    capital: 1000000, sizing: 'volTarget', targetVolPct: 0.12, settlement: true
  }).run();
  const r = futureInvarianceProbe({
    run, base: mk({ a, b }), mutated: mk({ a: rewriteBarsAfter(a, CUT), b: rewriteBarsAfter(b, CUT, { seed: 123 }) }),
    cutDate: CUT
  });
  assert.ok(r.ok, `${r.note}（volTarget 用的必须是截至当日的滚动窗口，不是全序列末尾）`);
  assert.ok(r.checkedTrades > 0, '这条回归得真的比到开仓侧，空跑不算通过');
});

// ---------- 数据护栏 ----------
test('价格有效性：前复权压出的零价/负价要如实报数，连续性校验不得静默跳过', () => {
  const dirty = BARS.slice(0, 400).map((x, i) => (i < 50 ? { ...x, close: -Math.abs(x.close), open: -1 } : x));
  const pv = checkPriceValidity(dirty);
  assert.eq(pv.count, 50, `应报出 50 根不合格，实际 ${pv.count}`);
  assert.ok(/负价/.test(pv.note), pv.note);
  const clean = checkPriceValidity(BARS);
  assert.ok(clean.usable && clean.count === 0, clean.note);
});
