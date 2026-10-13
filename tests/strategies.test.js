import { test, assert } from './harness.js';
import { getStrategy, minerviniTemplate, trendRegime, nVolumePattern, STRATEGIES } from '../src/strategy/library.js';
import { adx, roc, rising, toWeekly, fieldSma, priorRange } from '../src/strategy/indicators.js';
import { BacktestEngine, DIR } from '../src/core/backtestEngine.js';

const mk = (date, o, h, l, c, v = 100) => ({ date, open: o, high: h, low: l, close: c, volume: v });
const SPEC = { market: 'futures', multiplier: 10, tick: 1, marginRate: 0.1, fee: { mode: 'fixed', value: 4 } };
/** 第 i 个**交易日**（跳过周末）：回测数据里混进周六周日会让周线聚合出现不该有的 7 根。 */
const date = (i) => {
  const d = new Date(Date.UTC(2023, 0, 2));        // 2023-01-02 是周一
  let add = 0, count = 0;
  while (count < i) { add++; const w = new Date(d.getTime() + add * 86400000).getUTCDay(); if (w !== 0 && w !== 6) count++; }
  return new Date(d.getTime() + add * 86400000).toISOString().slice(0, 10);
};

/**
 * 稳定上涨的长序列。
 * 上影（high）必须比日均涨幅小，否则收盘永远创不出"25 日新高"—— 那样测的是影线不是策略。
 */
function uptrend(n = 420, start = 100, growth = 1.006, vol = 100, wick = 1.001) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = Math.round(start * Math.pow(growth, i) * 10) / 10;
    out.push(mk(date(i), p, Math.round(p * wick * 10) / 10, Math.round(p * 0.995 * 10) / 10, p, vol));
  }
  return out;
}

// ---------- 指标 ----------
test('adx：单边趋势给高值，来回震荡给低值', () => {
  const trend = [], flat = [];
  for (let i = 0; i < 80; i++) {
    const p = 100 + i * 2;
    trend.push(mk(date(i), p, p + 2, p - 0.5, p + 1.5));
    const q = 100 + (i % 3) * 0.4;
    flat.push(mk(date(i), q, q + 1.2, q - 1.2, q));
  }
  const a = adx(trend, 14).adx, b = adx(flat, 14).adx;
  assert.eq(a.slice(0, 15).every(v => v === null), true, '暖机期必须是 null');
  assert.ok(a[79] > 25, `单边上涨的 ADX 应该高，实际 ${a[79]}`);
  assert.ok(b[79] < 20, `来回震荡的 ADX 应该低，实际 ${b[79]}`);
  assert.ok(a[79] >= a[40], '趋势走稳后 ADX 不该塌回去');
});

test('roc / rising / fieldSma：暖机期为 null，缺数据不当 0 算', () => {
  const r = roc([100, 110, 121, 133], 2);
  assert.eq(r[0], null); assert.eq(r[1], null);
  assert.near(r[2], 0.21, 1e-9);
  const up = rising([1, 2, 3, 2, 5], 2);
  assert.eq(up[0], null); assert.eq(up[1], null);
  assert.eq(up[2], true); assert.eq(up[3], false); assert.eq(up[4], true);
  const vs = fieldSma([{ volume: 100 }, { volume: 200 }, { volume: 300 }], 'volume', 2);
  assert.eq(vs[0], null); assert.eq(vs[1], 150); assert.eq(vs[2], 250);
});

test('toWeekly：按周聚合只用走完的周，日期是交易日', () => {
  const b = [];
  for (let i = 0; i < 10; i++) b.push(mk(date(i), 100 + i, 101 + i, 99 + i, 100.5 + i));
  const { weekly, weekIdx } = toWeekly(b);
  assert.eq(weekly.length, 2, `两周应为 2 根周线，实际 ${weekly.length}`);
  assert.eq(weekly[0].open, 100);
  assert.eq(weekly[0].high, 105, '周高 = 周内各日最高的极大值');
  assert.eq(weekly[0].close, 104.5, '周收 = 周内最后一日收盘');
  assert.eq(weekIdx[0], 0); assert.eq(weekIdx[5], 1, '第二周的下标');
  const rng = priorRange(b, 5);
  assert.eq(rng.hi[4], 105); assert.eq(rng.lo[3], null, '不足周期给 null');
});

// ---------- Minervini 趋势模板 ----------
test('趋势模板：多头排列 + 创新高 + 放量才给信号，缺一条就不许进场', () => {
  const bars = uptrend(420, 100, 1.006, 100);
  // 默认 pivotVolMul=1.2，全程量=100（均量也=100）→ 量能不过，一路不该有信号
  assert.eq(minerviniTemplate.signals(bars, { ...minerviniTemplate.params }).filter(Boolean).length, 0,
    '量能没放大就进场，等于把模板里"机构在买"这一条丢了');
  // 后面放量 → 突破成立
  const withVol = bars.map((b, i) => ({ ...b, volume: i >= 400 ? 260 : 100 }));
  const sigs = minerviniTemplate.signals(withVol, { ...minerviniTemplate.params });
  const hit = sigs.filter(Boolean);
  assert.ok(hit.length >= 1, '放量创新高应当进场');
  assert.eq(hit[0].dir, DIR.LONG);
  assert.ok(/模板 \d+\/\d+/.test(hit[0].reason), `reason 要写清通过几条，实际 ${hit[0].reason}`);
  assert.eq(hit[0].template.crit.length, 8);
  assert.ok(Number.isFinite(hit[0].stop) && hit[0].stop < withVol[hit[0].i].close, '初始止损必须在价下');
});

test('趋势模板：下跌排列一条不过；给了基准序列 RS 条才参与判定', () => {
  const down = uptrend(420, 300, 0.994, 300);
  assert.eq(minerviniTemplate.signals(down, { ...minerviniTemplate.params }).filter(Boolean).length, 0,
    '一路下跌还做多，那不叫趋势模板');
  const up = uptrend(420, 100, 1.006, 300);
  // 关掉量能门槛、开着 RS 判定，单独看这一条的作用
  const opts = (rsBars) => ({ ...minerviniTemplate.params, pivotVolMul: 0.2, useRs: true, rsBars });
  const sWeak = minerviniTemplate.signals(up, opts(uptrend(420, 100, 1.0005, 100)));       // 基准涨得慢 → 本品种相对强
  const sStrong = minerviniTemplate.signals(up, opts(uptrend(420, 100, 1.012, 100)));      // 基准涨得快 → 跑输
  const rsOf = (sig) => { const h = sig.filter(Boolean); return h.length ? h[0].template.crit.find(c => /RS/.test(c.k)).ok : 'no-signal'; };
  assert.eq(rsOf(sWeak), true, '跑赢基准时 RS 条应判通过');
  assert.ok(sWeak.filter(Boolean).length > 0, '跑赢基准 + 其余各条都过 → 应该进场');
  // 跑输基准时模板整体不成立，也就没有信号可 inspect —— 用"关掉 RS 就恢复出信号"来证明是这一条拦住的
  assert.eq(sStrong.filter(Boolean).length, 0, 'RS 不过就整体不过 —— 这正是它作为过滤器的意义');
  const sStrongLoose = minerviniTemplate.signals(up, { ...minerviniTemplate.params, pivotVolMul: 0.2, useRs: false, rsBars: uptrend(420, 100, 1.012, 100) });
  assert.ok(sStrongLoose.filter(Boolean).length > 0, '同一段行情只把 RS 这条撤掉就该出信号，说明拦下来的确实是它');
  // 要求 RS 但拿不到基准序列：宁可不交易，也不假装跑的是完整模板
  assert.eq(minerviniTemplate.signals(up, opts(undefined)).filter(Boolean).length, 0,
    'useRs=true 又没给基准时不该出信号');
  // 不要求 RS：按能算的 7 条判定，并把这条如实标成未参与
  const noReq = minerviniTemplate.signals(up, { ...minerviniTemplate.params, pivotVolMul: 0.2, useRs: false }).filter(Boolean);
  assert.ok(noReq.length >= 1, '无基准时其余各条仍应能给出信号');
  assert.eq(noReq[0].template.crit.find(c => /RS/.test(c.k)).ok, null, '拿不到横截面数据就如实标 unavailable');
  assert.eq(noReq[0].template.enabled, 7, '判定分母必须是"能算的那几条"');
  assert.ok(/RS 无基准未参与/.test(noReq[0].reason), `reason 要说明这条没参与，实际 ${noReq[0].reason}`);
});

// ---------- N 字量价 ----------
function nShape(pullbackVol = 60, breakVol = 300) {
  const b = [];
  for (let i = 0; i < 30; i++) b.push(mk(date(i), 100, 101, 99, 100, 100));
  b.push(mk(date(30), 100, 107, 100, 106, 400));                     // 倍量起涨
  for (let k = 0; k < 5; k++) {
    const i = 31 + k;
    b.push(mk(date(i), 105 - k, 105.5 - k, 102 - k * 0.5, 104 - k * 0.8, pullbackVol));   // 缩量回调，不跌破起涨根开盘
  }
  b.push(mk(date(36), 101, 108, 101, 108, breakVol));                // 放量突破前高
  return b;
}
test('N字形态：倍量起涨→缩量回调→放量突破三段齐全才给信号', () => {
  const hit = nVolumePattern.signals(nShape(), { ...nVolumePattern.params }).filter(Boolean);
  assert.ok(hit.length >= 1, '该出信号却没出');
  assert.eq(hit[0].i, 36, '信号必须落在突破那根');
  assert.eq(hit[0].dir, DIR.LONG);
  assert.ok(/N字/.test(hit[0].reason));
});

test('N字形态：回调不放量（缩量条件破坏）或突破无跟进量，都不许算成立', () => {
  assert.eq(nVolumePattern.signals(nShape(200), { ...nVolumePattern.params }).filter(Boolean).length, 0,
    '回调段还在放量，说明是出货不是缩量洗盘');
  assert.eq(nVolumePattern.signals(nShape(60, 100), { ...nVolumePattern.params }).filter(Boolean).length, 0,
    '突破那根没有跟进量，是假突破的典型形状');
  // 回调砸穿起涨根开盘：结构已经坏了
  const broken = nShape().map((b, i) => (i >= 31 && i <= 35 ? { ...b, low: 98 } : b));
  assert.eq(nVolumePattern.signals(broken, { ...nVolumePattern.params }).filter(Boolean).length, 0,
    '回调砸穿起涨位就不是 N 字，是二次探底');
});

// ---------- 趋势区间过滤 ----------
test('趋势区间过滤：ADX 门槛把震荡里的假突破挡在外面', () => {
  const chop = [];
  for (let i = 0; i < 200; i++) {
    const p = 100 + Math.sin(i / 4) * 3;
    chop.push(mk(date(i), p, p + 1, p - 1, p, 100));
  }
  const noFilter = trendRegime.signals(chop, { ...trendRegime.params, adxMin: 0 }).filter(Boolean);
  const withFilter = trendRegime.signals(chop, { ...trendRegime.params }).filter(Boolean);
  assert.ok(noFilter.length >= withFilter.length, '关掉门槛只会放进更多信号');
  assert.ok(withFilter.length <= 3, `震荡市的过滤后信号应寥寥可数，实际 ${withFilter.length}`);
  const trendBars = uptrend(300, 100, 1.006, 300);
  const t = trendRegime.signals(trendBars, { ...trendRegime.params }).filter(Boolean);
  assert.ok(t.length > 0, '趋势态里该抓到突破，实际一个都没有');
  assert.eq(t[0].dir, DIR.LONG);
  assert.ok(t[0].adx >= 20, `进场时 ADX 必须已达标，实际 ${t[0].adx}`);
});

test('新策略都在策略库里，且默认参数能跑通不抛异常', () => {
  for (const id of ['minerviniTemplate', 'trendRegime', 'nVolumePattern']) assert.ok(getStrategy(id), `${id} 没注册`);
  assert.eq(STRATEGIES.length, 9);
  const bars = uptrend(300, 100, 1.002, 150);
  for (const s of STRATEGIES) {
    const sig = s.signals(bars, { ...s.params });
    assert.eq(sig.length, bars.length, `${s.id} 的信号数组必须与 bar 等长`);
  }
});

// ---------- 保本止损 / 时间止损 ----------
const sigEntry = (n, extra = {}) => Array.from({ length: n }, (_, i) => (i === 0 ? { i: 0, dir: DIR.LONG, stop: 96, ...extra } : null));

test('保本止损：浮盈到 1R 后止损抬到成本，回踩时以小亏出场而不是吃满初始风险', () => {
  const bars = [
    mk(date(0), 100, 101, 99, 100),
    mk(date(1), 100, 102, 99, 101),
    mk(date(2), 101, 106, 100, 105),          // 走到 106，1R（=4）已经够
    mk(date(3), 104, 104, 97, 98),            // 回踩：保本轮应被打在成本附近
    mk(date(4), 97, 98, 90, 92)               // 不设保本时会一路亏到 96 止损
  ];
  const plain = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 1 }).run(sigEntry(5));
  const guarded = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 1, breakeven: { afterR: 1 } }).run(sigEntry(5));
  const t0 = plain.trades[0], t1 = guarded.trades[0];
  assert.ok(t0 && t1, '两种口径都该有成交');
  assert.near(t0.exitPrice, 96, 1e-6, `未保本时打在初始止损 96，实际 ${t0.exitPrice}`);
  assert.near(t1.exitPrice, 100, 1e-6, `保本后打在成本 100，实际 ${t1.exitPrice}`);
  assert.ok(t1.netPnL > t0.netPnL, '保本必须显著减小这笔的亏损');
  assert.eq(guarded.riskControls.breakeven.afterR, 1, '风控参数要能在结果里回查');
});

test('保本止损：extraPct 把手续费盖进成本价', () => {
  const bars = [
    mk(date(0), 100, 101, 99, 100), mk(date(1), 100, 102, 99, 101),
    mk(date(2), 101, 106, 100, 105), mk(date(3), 104, 105, 100, 101)
  ];
  const r = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 1, breakeven: { afterR: 1, extraPct: 0.01 } }).run(sigEntry(4));
  assert.near(r.trades[0].exitPrice, 101, 1e-6, `成本上浮 1% 后出场价应=101，实际 ${r.trades[0].exitPrice}`);
  // 没有初始止损 → 没有 R → 保本不该介入
  const noStop = Array.from({ length: 5 }, (_, i) => (i === 0 ? { i, dir: DIR.LONG } : null));
  const r2 = new BacktestEngine([...bars, mk(date(4), 101, 102, 90, 92)], SPEC,
    { capital: 100000, lots: 1, breakeven: { afterR: 1 } }).run(noStop);
  assert.ok(r2.trades.every(t => t.exitReason !== 'stop'), '无初始止损时无处定义 1R，必须跳过保本');
});

test('时间止损：拿着不动的仓位在 N 根后被请出去，出场在下一根开盘', () => {
  const bars = [mk(date(0), 100, 101, 99, 100)];
  for (let i = 1; i <= 12; i++) bars.push(mk(date(i), 100 - i, 101 - i, 99 - i, 100 - i));   // 逐日阴跌，始终在水下
  const sigs = sigEntry(13, { stop: 88 });
  const off = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 1 }).run(sigs);
  const on = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 1, timeStop: { bars: 4 } }).run(sigs);
  assert.ok(off.trades[0] && off.trades[0].exitReason !== 'time_stop', '不设时间止损时这笔应活得更久');
  assert.ok(off.trades[0].exitIdx > on.trades[0].exitIdx, '不设时应该更晚出场');
  const t = on.trades[0];
  assert.eq(t.exitReason, 'time_stop', `应触发时间止损，实际 ${t.exitReason}`);
  assert.eq(t.entryIdx, 1, '第 1 根开盘进场');
  assert.eq(t.exitIdx, 6, '第 5 根收盘判定（持仓满 4 根）、第 6 根开盘执行');
  assert.near(t.exitPrice, 94, 1e-6, `按第 6 根开盘 94 成交，实际 ${t.exitPrice}`);
  assert.eq(on.riskControls.timeStop.bars, 4);
});

test('时间止损：requireLoss=false 时到期就走，不管赚没赚', () => {
  const bars = [mk(date(0), 100, 101, 99, 100)];
  for (let i = 1; i <= 8; i++) bars.push(mk(date(i), 104 + i, 105 + i, 103 + i, 104 + i));   // 一直浮盈
  const r = new BacktestEngine(bars, SPEC, { capital: 100000, lots: 1, timeStop: { bars: 3, requireLoss: false } })
    .run(sigEntry(9));
  assert.eq(r.trades[0].exitReason, 'time_stop', '浮盈也到期离场的口径要能表达');
  assert.ok(r.trades[0].netPnL > 0, '这笔是带着盈利走的');
});

// ---------- 不看未来 ----------
test('新策略没有未来函数：截断数据后前段信号逐根一致', () => {
  const bars = uptrend(360, 100, 1.006, 260);
  const cut = 240;
  for (const s of [minerviniTemplate, trendRegime, nVolumePattern]) {
    const full = s.signals(bars, { ...s.params });
    const part = s.signals(bars.slice(0, cut), { ...s.params });
    let compared = 0;
    for (let i = 40; i < cut; i++) {
      const a = full[i], b = part[i];
      compared++;
      assert.eq(JSON.stringify(a && { dir: a.dir, stop: a.stop, reason: a.reason }),
        JSON.stringify(b && { dir: b.dir, stop: b.stop, reason: b.reason }),
        `${s.id} 第 ${i} 根被后面的行情改写了`);
    }
    assert.ok(compared > 100, `${s.id} 这条断言不能是空的`);
  }
});
