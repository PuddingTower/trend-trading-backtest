import { test, assert } from './harness.js';
import { atr, swingPoints, trueRanges } from '../src/analysis/common.js';
import { volumeProfile, autoAnchorRange } from '../src/analysis/volumeProfile.js';
import { supertrend, supertrendSummary } from '../src/analysis/supertrend.js';
import { computePivots, groupByPeriod, pivotLevels, highLowPivots } from '../src/analysis/pivots.js';
import { detectPatterns } from '../src/analysis/patterns.js';
import { supplyDemandZones, wyckoffEvents } from '../src/analysis/zones.js';

const mk = (date, o, h, l, c, v = 1000) => ({ date, open: o, high: h, low: l, close: c, volume: v });

/** 造一段确定性序列：先涨后跌，避免随机数据让断言飘。 */
function series(specs) {
  return specs.map((s, i) => mk(`2024-01-${String(i + 1).padStart(2, '0')}`, ...s));
}

// ---------- ATR ----------
test('ATR：Wilder 递推与手算一致', () => {
  const bars = series([[10, 11, 9, 10.5], [10.5, 12, 10, 11.5], [11.5, 12.5, 11, 12], [12, 13, 11.5, 12.5], [12.5, 14, 12, 13]]);
  const tr = trueRanges(bars);
  assert.eq(tr[0], 2);                       // 首根 = high-low
  assert.eq(tr[1], Math.max(2, 12 - 10.5, Math.abs(10 - 10.5)));
  const a = atr(bars, 3);
  assert.eq(a[1], null, '不足 period 必须为 null');
  assert.near(a[2], (tr[0] + tr[1] + tr[2]) / 3, 1e-9, '首值=简单均值');
  assert.near(a[3], (a[2] * 2 + tr[3]) / 3, 1e-9, '之后走 Wilder 递推');
});

// ---------- swingPoints ----------
test('swingPoints：V 形与 Λ 形各给一个反向拐点，且高低交替', () => {
  const bars = [];
  for (let i = 0; i < 10; i++) bars.push(mk(`d${i}`, 100 - i, 100 - i + 1, 101 - i - 1.2, 100 - i));   // 下跌
  for (let i = 0; i < 10; i++) bars.push(mk(`u${i}`, 90 + i, 91 + i, 89 + i, 90 + i));                 // 上涨
  const sw = swingPoints(bars, { pct: 0.03 });
  assert.ok(sw.length >= 2, `应至少识别一低一高，实际 ${sw.length}`);
  assert.eq(sw[0].type, 'high', '起点是下跌 → 第一个拐点应是下跌前的高点');
  for (let i = 1; i < sw.length; i++) assert.ok(sw[i].type !== sw[i - 1].type, '摆动点必须交替');
  for (let i = 1; i < sw.length; i++) assert.ok(sw[i].idx > sw[i - 1].idx, '索引必须递增');
});

// ---------- Volume Profile ----------
test('VP：量集中的价位成为 POC，均匀分配算法可手算', () => {
  // 全部成交挤在 100~101，只有一根摸到 110
  const bars = [
    mk('a', 100, 101, 100, 100.5, 5000), mk('b', 100, 101, 100, 100.6, 5000),
    mk('c', 100, 101, 100, 100.4, 5000), mk('d', 109, 110, 109, 109.5, 100)
  ];
  const vp = volumeProfile(bars, { bins: 10 });
  assert.ok(vp, '应产出 profile');
  assert.near(vp.totalVolume, 15100, 1e-6);
  assert.ok(vp.poc.price >= 100 && vp.poc.price <= 101, `POC 应落在密集区，实际 ${vp.poc.price}`);
  assert.ok(vp.vah > vp.poc.price || Math.abs(vp.vah - vp.poc.price) < vp.binWidth * 1.5, 'VAH 在 POC 上方');
  assert.ok(vp.val < vp.vah, 'VAL 必须低于 VAH');
  assert.ok(vp.valueAreaActual >= 0.7 - 1e-9, `价值区至少覆盖 70%，实际 ${vp.valueAreaActual}`);
});

test('VP：价值区从 POC 向外扩张，bins 量总和等于总量', () => {
  const bars = [];
  for (let i = 0; i < 60; i++) bars.push(mk(`d${i}`, 100 + (i % 10), 101 + (i % 10), 99 + (i % 10), 100 + (i % 10), 100 + i));
  const vp = volumeProfile(bars, { bins: 24, valueAreaPct: 0.7 });
  const sum = vp.bins.reduce((s, b) => s + b.volume, 0);
  assert.near(sum, vp.totalVolume, 1e-6, '分箱量守恒');
  const inVA = vp.bins.filter(b => b.inVA);
  assert.near(inVA.reduce((s, b) => s + b.volume, 0) / vp.totalVolume, vp.valueAreaActual, 1e-9);
  assert.ok(vp.bins.filter(b => b.isPOC).length === 1, 'POC 唯一');
});

test('VP：空/单根/全平盘不崩', () => {
  assert.eq(volumeProfile([], {}), null);
  assert.eq(volumeProfile([mk('a', 100, 100, 100, 100, 10)], {}), null, '高低相同无法分箱');
});

test('自动锚定：锚在最近极值，且区间不含未来', () => {
  const bars = [];
  for (let i = 0; i < 40; i++) bars.push(mk(`d${i}`, 100 + i, 101 + i, 99 + i, 100 + i, 100));   // 一路涨到 139
  for (let i = 0; i < 25; i++) bars.push(mk(`e${i}`, 139 - i * 2, 140 - i * 2, 138 - i * 2, 139 - i * 2, 100)); // 回落到 89
  const a = autoAnchorRange(bars, { lookback: 200 });
  assert.ok(a, '应给出锚点');
  assert.eq(a.endIdx, bars.length - 1, '右端必须是当前 bar');
  assert.ok(a.anchorType === 'high' || a.anchorType === 'low');
  assert.ok(a.startIdx < a.endIdx);
  const vp = volumeProfile(bars.slice(a.startIdx, a.endIdx + 1), { bins: 30 });
  assert.ok(vp && vp.poc.price >= a.anchorPrice * 0.5, '锚定区间要能算出 profile');
});

// ---------- Supertrend ----------
test('Supertrend：单边上涨时线在价格下方且趋势=+1', () => {
  const bars = [];
  for (let i = 0; i < 60; i++) bars.push(mk(`d${i}`, 100 + i * 2, 103 + i * 2, 99 + i * 2, 102 + i * 2, 100));
  const st = supertrend(bars, { period: 10, multiplier: 3 }).filter(Boolean);
  assert.ok(st.length > 0);
  const last = st[st.length - 1];
  assert.eq(last.trend, 1, '上涨应为多头趋势');
  assert.ok(last.value < last.price || last.value < bars[bars.length - 1].close, '多头线应在价格下方');
});

test('Supertrend：由涨转跌要出现翻转，且线只朝有利方向棘轮', () => {
  const bars = [];
  for (let i = 0; i < 40; i++) bars.push(mk(`u${i}`, 100 + i * 3, 102 + i * 3, 98 + i * 3, 101 + i * 3, 100));
  for (let i = 0; i < 40; i++) bars.push(mk(`d${i}`, 220 - i * 4, 222 - i * 4, 218 - i * 4, 219 - i * 4, 100));
  const raw = supertrend(bars, { period: 10, multiplier: 3 });
  const st = raw.filter(Boolean);
  const flips = st.filter(s => s.reversal).length;
  assert.ok(flips >= 1, `应有翻转，实际 ${flips}`);
  assert.eq(st[st.length - 1].trend, -1, '末端应为空头');
  // 多头段内 lower band 不得下移（这是 supertrend 定义的一部分）
  for (let i = 1; i < st.length; i++) {
    if (st[i].trend === 1 && st[i - 1].trend === 1) assert.ok(st[i].value >= st[i - 1].value - 1e-9, '多头线不能下移');
    if (st[i].trend === -1 && st[i - 1].trend === -1) assert.ok(st[i].value <= st[i - 1].value + 1e-9, '空头线不能上移');
  }
  const s = supertrendSummary(raw);
  assert.eq(s.trend, -1);
  assert.ok(s.flips >= 1 && s.barsSinceFlip !== null);
});

// ---------- Pivots ----------
test('Pivot Standard：与手算一致', () => {
  const prev = { high: 110, low: 100, close: 105 };
  const lv = pivotLevels(prev).standard;
  const P = (110 + 100 + 105) / 3;
  assert.near(lv.P, P, 1e-9);
  assert.near(lv.R1, 2 * P - 100, 1e-9);
  assert.near(lv.S1, 2 * P - 110, 1e-9);
  assert.near(lv.R2, P + 10, 1e-9);
  assert.near(lv.R3, 110 + 2 * (P - 100), 1e-9);
});

test('Pivot：一期枢轴只能画在下一期，最后一期不得出现（防未来函数）', () => {
  const bars = [];
  let day = 1;
  for (let w = 0; w < 6; w++) {
    for (let i = 0; i < 5; i++) {
      const base = 100 + w * 10 + i;
      bars.push(mk(`2024-01-${String(day++).padStart(2, '0')}`, base, base + 3, base - 2, base + 1, 100));
    }
  }
  const g = groupByPeriod(bars, 'daily');
  assert.eq(g.length, bars.length, '日线口径每期一根 bar');
  const sets = computePivots(bars, { type: 'standard', timeframe: 'daily' });
  assert.eq(sets.length, g.length - 1, '最后一期的枢轴属于未来，必须少一组');
  for (const s of sets) {
    assert.ok(s.fromIdx >= 1, '首组枢轴不能从第 0 根开始');
    const srcPeriod = g.find(x => x.key === s.sourcePeriod);
    assert.ok(srcPeriod.endIdx < s.fromIdx, '枢轴来源期必须整体早于它被画出的位置');
  }
  // 渲染层把每组枢轴截止在自己的 [fromIdx,toIdx] 内，前提是相邻区间不重叠
  for (let i = 1; i < sets.length; i++) {
    assert.ok(sets[i - 1].toIdx < sets[i].fromIdx, `相邻两期的绘制区间必须不相交（${sets[i - 1].toIdx} vs ${sets[i].fromIdx}）`);
  }
});

test('Pivot 各族：Camarilla 层级递增、Fib 用 0.382/0.618', () => {
  const lv = pivotLevels({ high: 120, low: 100, close: 110 });
  const c = lv.camarilla;
  assert.ok(c.R1 < c.R2 && c.R2 < c.R3 && c.R3 < c.R4, 'Camarilla 上方层级递增');
  assert.ok(c.S1 > c.S2 && c.S2 > c.S3 && c.S3 > c.S4, '下方层级递减');
  const R = 20, P = (120 + 100 + 110) / 3;
  assert.near(lv.fibonacci.R1, P + 0.382 * R, 1e-9);
  assert.near(lv.fibonacci.R2, P + 0.618 * R, 1e-9);
});

test('High-Low pivots：分形极值需右侧确认，未确认不返回', () => {
  const bars = [];
  for (let i = 0; i < 5; i++) bars.push(mk(`a${i}`, 100 + i, 101 + i, 99 + i, 100 + i));
  bars.push(mk('peak', 130, 150, 129, 130));                                   // 尖顶 idx=5
  for (let i = 0; i < 5; i++) bars.push(mk(`b${i}`, 130 - i, 131 - i, 128 - i, 130 - i));
  const piv = highLowPivots(bars, { left: 3, right: 3 });
  assert.ok(piv.some(p => p.kind === 'high' && p.price === 150), '应识别出 150 的摆动高');
  const truncated = highLowPivots(bars.slice(0, 8), { left: 3, right: 3 });
  assert.ok(!truncated.some(p => p.price === 150), '右侧只 2 根时不该确认该高点');
});

test('High-Low pivots：被收盘穿越后标 broken 并给出截止根，活线优先占名额', () => {
  const bars = [];
  for (let i = 0; i < 5; i++) bars.push(mk(`a${i}`, 100 + i, 101 + i, 99 + i, 100 + i));
  bars.push(mk('peak', 130, 150, 129, 130));                                   // 尖顶 idx=5
  for (let i = 0; i < 5; i++) bars.push(mk(`b${i}`, 130 - i, 131 - i, 128 - i, 130 - i));
  let piv = highLowPivots(bars, { left: 3, right: 3 });
  let top = piv.find(p => p.price === 150);
  assert.eq(top.status, 'active', '没人收在 150 之上时该线仍有效');
  assert.eq(top.endIdx, bars.length - 1, 'active 线的右端才允许拖到最新一根');
  assert.ok(Number.isFinite(top.freshness), 'freshness 必须有值');

  const breached = bars.concat([mk('brk', 150, 160, 149, 158, 100)]);           // 收盘站上 150
  piv = highLowPivots(breached, { left: 3, right: 3 });
  top = piv.find(p => p.price === 150);
  assert.eq(top.status, 'broken', '收盘穿越后必须标失效，而不是继续当支撑/阻力展示');
  assert.eq(top.brokenAtIdx, breached.length - 1);
  assert.eq(top.endIdx, top.brokenAtIdx, '线必须截止在穿越那一根');
});

test('枢轴周线分桶不依赖 new Date("YYYY-MM-DD HH:mm")（iPad/Safari 会解析成 Invalid Date）', () => {
  const bars = [];
  // 60m 形态的 date：Safari 下 new Date() 直接得到 Invalid Date
  for (const d of ['2026-10-12 10:30', '2026-10-12 14:00', '2026-10-13 10:30', '2026-10-19 10:30']) {
    bars.push(mk(d, 100, 101, 99, 100));
  }
  const g = groupByPeriod(bars, 'weekly');
  assert.eq(g.length, 2, '10-12/10-13 同周、10-19 次周 → 应分成两期');
  assert.ok(g.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x.key)), `周 key 必须是合法日期，实际 ${g.map(x => x.key).join(',')}`);
});

// ---------- 形态 ----------
function synthDoubleTop() {
  const bars = [];
  const path = [];
  for (let i = 0; i < 12; i++) path.push(100 + i * 2);
  for (let i = 0; i < 10; i++) path.push(124 - i * 2);
  for (let i = 0; i < 12; i++) path.push(104 + i * 2);
  for (let i = 0; i < 10; i++) path.push(126 - i * 2);
  for (let i = 0; i < 12; i++) path.push(106 - i * 2);
  path.forEach((p, i) => bars.push(mk(`d${String(i).padStart(3, '0')}`, p, p + 1.2, p - 1.2, p, 100)));
  return bars;
}

test('形态：双顶能被识别，且带 breakout/target/stop 三关键位', () => {
  const bars = synthDoubleTop();
  const ps = detectPatterns(bars, { swingPct: 0.05 });
  const dt = ps.find(p => p.kind === 'double_top');
  assert.ok(dt, `应识别出双顶，实际：${ps.map(p => p.kind).join(',')}`);
  assert.eq(dt.direction, 'bear');
  assert.ok(dt.breakout < dt.stop, '双顶颈线应低于顶部');
  assert.ok(dt.target < dt.breakout, '目标位应在颈线下方（等高测算）');
});

test('形态生命周期：走完的形态必须截止，不能一直挂在图上装“在途中”', () => {
  // 双顶：颈线 106、顶 126、目标 86。完整序列里先破颈线、再触及目标。
  const full = synthDoubleTop();
  const dt = detectPatterns(full, { swingPct: 0.05 }).find(p => p.kind === 'double_top');
  assert.ok(dt, '完整序列应识别双顶');
  assert.ok(dt.breakoutAtIdx !== null, '收盘破颈线后必须记为已突破');
  assert.eq(dt.state, 'brokenOut', '破颈线但收盘未到目标位 → 仍是活形态');
  assert.eq(dt.stateLabel, '已突破');
  assert.eq(dt.resolvedAtIdx, null, '没走完就没有截止根，线才允许延续到最新一根');

  // 同一形态、截在颈线还没破的时候，并把窗口收窄 → 该过期就过期
  const pre = synthDoubleTop().slice(0, 44);
  const pd = detectPatterns(pre, { swingPct: 0.05, resolveWindow: 3 }).find(p => p.kind === 'double_top');
  assert.ok(pd, '截断序列也应识别双顶');
  assert.eq(pd.state, 'expired', '迟迟不破颈线的形态不该继续当有效机会展示');
  assert.eq(pd.stateLabel, '已过期');
  assert.ok(pd.resolvedAtIdx > pd.confirmedAtIdx, '过期根要在确认根之后');
});

test('形态生命周期：走完到目标位时收口为已达标并给出截止根', () => {
  // 在双顶之后接一段更深的下跌，把收盘打到目标位（78.4）之下
  const bars = synthDoubleTop();
  const extra = Array.from({ length: 6 }, (_, i) => mk(`t${i}`, 78 - i, 79 - i, 77 - i, 77 - i, 300));
  const dt = detectPatterns(bars.concat(extra), { swingPct: 0.05 }).find(p => p.kind === 'double_top');
  assert.ok(dt, '加长序列仍应识别双顶');
  assert.eq(dt.state, 'targetHit', '收盘触及目标位就该收口');
  assert.eq(dt.stateLabel, '已达标');
  assert.ok(dt.resolvedAtIdx !== null && dt.resolvedAtIdx < bars.length + extra.length, '必须给出截止根');
});

test('形态生命周期：反向打掉止损优先于目标（悲观优先，与回测内核同口径）', () => {
  const path = [];
  for (let i = 0; i < 12; i++) path.push(100 + i * 2);      // 顶 1 = 122
  for (let i = 0; i < 10; i++) path.push(124 - i * 2);      // 回落颈线
  for (let i = 0; i < 12; i++) path.push(104 + i * 2);      // 顶 2 = 126
  for (let i = 0; i < 10; i++) path.push(126 - i * 2);
  for (let i = 0; i < 12; i++) path.push(106 - i * 2);      // 跌到 84
  for (let i = 0; i < 12; i++) path.push(82 + i * 6);       // 反抽创出更高收盘 → 双顶该判失效
  const bars = path.map((p, i) => mk(`p${String(i).padStart(3, '0')}`, p, p + 1.2, p - 1.2, p, 100));
  const ps = detectPatterns(bars, { swingPct: 0.05 });
  const dt = ps.find(p => p.kind === 'double_top');
  assert.ok(dt, `应识别双顶，实际 ${ps.map(p => p.kind).join(',')}`);
  assert.eq(dt.state, 'invalidated', '收盘站上止损位应判失效，而不是继续挂着目标位');
  assert.eq(dt.stateLabel, '已失效');
  assert.ok(dt.resolvedAtIdx > dt.confirmedAtIdx, '失效根必须在确认根之后');
});

test('形态：confirmedAtIdx 不得超过已揭示末端（未来函数总闸）', () => {
  const full = synthDoubleTop();
  for (let end = 20; end <= full.length; end += 7) {
    const ps = detectPatterns(full.slice(0, end), { swingPct: 0.05 });
    for (const p of ps) {
      assert.ok(p.confirmedAtIdx < end, `截到 ${end} 根时不该出现 confirmedAtIdx=${p.confirmedAtIdx} 的 ${p.kind}`);
      assert.ok(p.endIdx < end);
    }
  }
});

test('形态：纯随机噪声不该乱报（保守优先）', () => {
  const bars = [];
  let p = 100;
  for (let i = 0; i < 120; i++) {
    p += Math.sin(i / 3) * 0.4;   // 小幅正弦，无结构
    bars.push(mk(`n${i}`, p, p + 0.5, p - 0.5, p, 100));
  }
  const ps = detectPatterns(bars, { swingPct: 0.06 });
  assert.ok(ps.length <= 1, `无结构序列不该报出 ${ps.length} 个形态`);
});

// ---------- 供需区 / Wyckoff ----------
function synthZone(tail = 10) {
  const bars = [];
  for (let i = 0; i < 20; i++) bars.push(mk(`w${i}`, 100, 101, 99, 100, 100));          // 攒够 ATR
  bars.push(mk('base', 100, 100.6, 99.6, 100.2, 100));                                   // 窄 base
  bars.push(mk('dep', 100.2, 106, 100, 105.8, 500));                                      // 强势脱离
  for (let i = 0; i < tail; i++) bars.push(mk(`r${i}`, 106 + i, 107 + i, 105 + i, 106.5 + i, 200));
  return bars;
}

test('供需区：base + 强脱离 → 需求区；收盘跌破后带失效标记并截止在那一根', () => {
  const bars = synthZone();
  let z = supplyDemandZones(bars, {});
  const live = z.find(x => x.kind === 'demand' && x.bottom === 99.6);
  assert.ok(live, `应识别需求区，实际 ${z.map(x => x.kind).join(',')}`);
  assert.eq(live.status, 'active', '没被穿越的区应是 active');
  assert.eq(live.endIdx, bars.length - 1, 'active 区的右端才允许延续到最新一根');

  const broken = bars.concat([mk('brk', 100, 100.5, 97, 97.5, 900)]);                     // 收盘跌破 base 下沿
  z = supplyDemandZones(broken, {});
  const dead = z.find(x => x.kind === 'demand' && x.bottom === 99.6);
  assert.ok(dead, '失效区要保留并画到穿越点，直接丢弃会让读者不知道它曾经成立');
  assert.eq(dead.status, 'broken');
  assert.eq(dead.brokenAtIdx, broken.length - 1, '失效点必须是被收盘穿越的那一根');
  assert.eq(dead.endIdx, dead.brokenAtIdx, '色带必须截止在失效点，不能拖到最新一根');
});

test('供需区：脱离棒仍是最新一根时标为形成中，不当已成立展示', () => {
  const z = supplyDemandZones(synthZone(0), {});       // base + 脱离，后面没有多余 bar
  const d = z.find(x => x.kind === 'demand');
  assert.ok(d, '应识别出需求区');
  assert.eq(d.status, 'forming', '脱离那根还是最新一根 → 结构没走完，不该算已确认');
});

test('供需区：名额按强度×新鲜度排，老区不再长期霸屏', () => {
  const bars = [];
  for (let i = 0; i < 20; i++) bars.push(mk(`w${i}`, 100, 101, 99, 100, 100));
  bars.push(mk('baseOld', 100, 100.6, 99.6, 100.2, 100));
  bars.push(mk('depOld', 100.2, 106, 100, 105.8, 500));
  // 之后价格始终在 old 区上沿之上运行：old 区从未被跌破，但已经很陈旧
  for (let i = 0; i < 300; i++) bars.push(mk(`m${i}`, 110, 111, 109, 110, 100));
  bars.push(mk('baseNew', 110, 110.6, 109.6, 110.2, 100));
  bars.push(mk('depNew', 110.2, 116, 110, 115.8, 500));

  const z = supplyDemandZones(bars, { maxZones: 1 });
  assert.eq(z.length, 1, 'maxZones 必须生效');
  assert.eq(z[0].bottom, 109.6, '两个区强度完全相同，只该留下新鲜的那个 —— 陈旧未破的区不该继续占名额');
});

test('Wyckoff：假跌破收回=spring，假上破收回=upthrust（需真震荡区间）', () => {
  // 区间宽 20、单根 TR≈1 → (hi-lo)/ATR≈20，才是 Wyckoff 意义上的吸筹区
  const wide = (n, seed) => Array.from({ length: n }, (_, i) => {
    const p = 100 + 10 * Math.sin((i + seed) / 4);
    return mk(`w${i}_${seed}`, p, p + 0.6, p - 0.6, p, 100);
  });
  const bars = wide(80, 0);
  bars.push(mk('spring', 90.4, 91, 87.5, 92.5, 300));    // 轻微刺破区间低后坚决收回
  const ev = wyckoffEvents(bars, { range: 60 });
  assert.ok(ev.some(e => e.kind === 'spring'), `应识别 spring，实际 ${ev.map(e => e.kind).join(',')}`);

  const up = wide(80, 1);
  up.push(mk('uth', 109.4, 111.2, 109, 107.5, 300));      // 只刺破 ~1 个 ATR 就收回（真突破不算）
  assert.ok(wyckoffEvents(up, { range: 60 }).some(e => e.kind === 'upthrust'), '应识别 upthrust');
});

test('Wyckoff：单边下跌里不该报 spring（趋势里不存在假跌破）', () => {
  const bars = [];
  for (let i = 0; i < 120; i++) bars.push(mk(`t${i}`, 200 - i, 201 - i, 199 - i, 200 - i, 100));
  const ev = wyckoffEvents(bars, { range: 60 });
  assert.eq(ev.filter(e => e.kind === 'spring').length, 0, `趋势段不该有 spring，实际 ${ev.length} 个事件`);
});

test('Wyckoff：放量上破记为 SOS，缩量上破不算', () => {
  const base = Array.from({ length: 80 }, (_, i) => {
    const p = 100 + 10 * Math.sin(i / 4);
    return mk(`v${i}`, p, p + 0.6, p - 0.6, p, 100);
  });
  const loud = base.concat([mk('big', 108, 118, 108, 117, 1000)]);
  assert.ok(wyckoffEvents(loud, { range: 60, volumeRatio: 1.6 }).some(e => e.kind === 'sos'));
  const quiet = base.concat([mk('small', 108, 118, 108, 117, 105)]);
  assert.ok(!wyckoffEvents(quiet, { range: 60, volumeRatio: 1.6 }).some(e => e.kind === 'sos'), '缩量上破不该报 SOS');
});

// ---------- 过度报告防线（截图实测暴露过的问题） ----------
test('形态：单边趋势段不该报出一堆头肩（曾因缺右肩判定而 120 根报 4 个）', () => {
  const bars = [];
  let p = 5300;
  for (let i = 0; i < 160; i++) {
    p -= 4 + Math.sin(i / 5) * 18;                       // 带波动的下跌趋势
    bars.push(mk(`g${i}`, p, p + 25, p - 25, p - 4, 1000));
  }
  const ps = detectPatterns(bars, { swingPct: 0.03 });
  const hs = ps.filter(x => x.kind.startsWith('head_shoulders'));
  assert.ok(hs.length <= 1, `趋势段最多容忍 1 个头肩，实际 ${hs.length}：${hs.map(h => h.label).join(',')}`);
  for (const x of ps) assert.ok(x.confidence < 0.95, `置信度不该顶到 ${x.confidence}`);
});

test('形态：重叠窗口不得重复报同一形态，且只返回 maxPatterns 个', () => {
  const bars = synthDoubleTop();
  const ps = detectPatterns(bars, { swingPct: 0.05, maxPatterns: 1 });
  assert.ok(ps.length <= 1, `应受 maxPatterns 限制，实际 ${ps.length}`);
  const many = detectPatterns(bars, { swingPct: 0.05 });
  for (let i = 0; i < many.length; i++) {
    for (let j = i + 1; j < many.length; j++) {
      const a = many[i], b = many[j];
      assert.ok(!(a.startIdx <= b.endIdx && b.startIdx <= a.endIdx), `检出形态区间重叠：${a.kind} 与 ${b.kind}`);
    }
  }
});
