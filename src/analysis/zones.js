/**
 * 供需区（Supply & Demand Zones）+ 简化 Wyckoff 事件。
 *
 * 供需区取的是最主流的可定义版本：
 *   需求区 = 窄幅 base 之后紧跟一段强向上脱离（RBR/DBD）
 *   供给区 = 窄幅 base 之后紧跟一段强向下脱离（RBD/DBR）
 * base 用「1~3 根连续窄幅棒 + 随后若干根里出现远大于 base 波动的脱离」来判定，
 * 而不是随便找密集成交区。方向由第一个把收盘价甩出盆地 ± 阈值的那根决定。
 * 区域被收盘价有效穿越即失效（broken），并把色带截止在穿越那一根。
 * 过去这里是 `if (broken) continue` 直接丢弃：刚跌破的区会凭空消失，读者不知道它“曾经成立过”；
 * 而未跌破的区又一律 `endIdx = 最后一根`，于是一条 2015 年的需求区能一路糊到 2026 年。
 * 两者都不对 —— 现在 broken 的带子画到穿越点为止，active 的才延续到最新一根。
 *
 * Wyckoff 只做两件可核验的事：区间内的 spring（下破后收回）与 upthrust（上破后收回），
 * 以及放量突破（SOS/SOW）。完整的 Wyckoff 阶段/因果分析不在这里装懂。
 */

import { atr } from './common.js';

export function supplyDemandZones(bars, {
  baseMaxRangeAtr = 0.6,
  departureAtrMult = 1.2,
  maxBaseBars = 3,
  departureWindow = 3,
  maxZones = 8,
  atrPeriod = 14,
  freshnessHalfLife = 250    // 距今多少根衰减到一半：老区不再是“榜首常客”
} = {}) {
  const n = (bars || []).length;
  if (n < atrPeriod + 5) return [];
  const a = atr(bars, atrPeriod);

  const isNarrow = (i) => {
    const at = a[i];
    return !!at && at > 0 && (bars[i].high - bars[i].low) <= at * baseMaxRangeAtr;
  };
  const zones = [];

  for (let i = atrPeriod; i < n - 1; i++) {
    const at = a[i];
    if (!isNarrow(i)) continue;

    // base 可以是 1~maxBaseBars 根连续窄幅棒构成的盆地。
    // 原口径要求「单根窄棒 + 紧接着下一根就走完 1.8ATR」：实测螺纹钢 1900 根日线里
    // 够格的窄 base 有 233 个，但单根最大脱离只有 1.76ATR，门槛永远够不着 ——
    // 整个供需区叠加层恒返回 0，用户开了开关看到的是“什么都没画”。
    let runStart = i;
    while (runStart > i - maxBaseBars && runStart - 1 >= atrPeriod && isNarrow(runStart - 1)) runStart--;

    let top = -Infinity, bottom = Infinity;
    for (let j = runStart; j <= i; j++) {
      if (bars[j].high > top) top = bars[j].high;
      if (bars[j].low < bottom) bottom = bars[j].low;
    }
    if (!(top > bottom)) continue;

    // 脱离在随后几根内完成都算，取第一个把收盘价甩出盆地 ≥ 阈值的棒来定方向
    let dep = null;
    for (let k = 1; k <= departureWindow && i + k < n; k++) {
      const c = bars[i + k].close;
      const up = (c - top) / at;
      const dn = (bottom - c) / at;
      if (up >= departureAtrMult || dn >= departureAtrMult) {
        dep = { idx: i + k, isDemand: up >= departureAtrMult, strength: Math.max(up, dn) };
        break;
      }
    }
    if (!dep) continue;

    // 向后找首次被收盘价穿越的那根。找到了就在那里截止，而不是整条区间一律延长到最新一根。
    let brokenAtIdx = null;
    for (let j = dep.idx + 1; j < n; j++) {
      if (dep.isDemand ? bars[j].close < bottom : bars[j].close > top) { brokenAtIdx = j; break; }
    }

    // 脱离那根还是最新一根时，区域仍在“形成中”：它下一秒可能被直接吞掉，不能当已成立展示
    const forming = dep.idx >= n - 1;

    zones.push({
      kind: dep.isDemand ? 'demand' : 'supply',
      label: dep.isDemand ? '需求区' : '供给区',
      top, bottom,
      startIdx: runStart,
      originIdx: i,
      departureIdx: dep.idx,
      endIdx: brokenAtIdx === null ? n - 1 : brokenAtIdx,
      brokenAtIdx,
      status: brokenAtIdx !== null ? 'broken' : (forming ? 'forming' : 'active'),
      strength: dep.strength,
      freshness: n - 1 - i
    });
  }

  // 同一盆地的相邻起点会报出几乎重合的区，只留最强的那个
  const distinct = [];
  for (const z of zones.sort((x, y) => y.strength - x.strength)) {
    if (distinct.some(k => k.kind === z.kind && Math.abs(k.originIdx - z.originIdx) <= maxBaseBars)) continue;
    distinct.push(z);
  }

  // 名额权重 = 脱离强度 × 新鲜度衰减，失效区再打三折。
  // freshness 早就算出来了却没人用，所以全历史最强的老区永远占满名额 —— 这才是“显示一般”的主因。
  const rank = (z) => z.strength
    * Math.exp(-z.freshness / Math.max(1, freshnessHalfLife))
    * (z.status === 'broken' ? 0.3 : 1);
  return distinct
    .sort((x, y) => rank(y) - rank(x))
    .slice(0, maxZones)
    .sort((x, y) => x.startIdx - y.startIdx);
}

/**
 * 简化 Wyckoff：在滚动区间内找 spring / upthrust / 放量突破。
 *
 * spring 的本义是「轻微刺破区间低点、随即强力收回」—— 刺破必须浅（否则就是真跌破），
 * 收回必须坚决（否则只是收盘刚好压在边界上）。原实现只要 low<lo && close>lo 就算，
 * 结果一段单边下跌里每根创新低都算 spring，120 根报出 8 个，等于没有信息量。
 *
 * 还要求区间确实是「震荡区间」：区间宽度相对 ATR 太窄或太宽都不算，
 * 单边趋势里不存在 Wyckoff 意义的 spring。
 */
export function wyckoffEvents(bars, {
  range = 60, volumeRatio = 1.6, atrPeriod = 14,
  maxBreachAtr = 0.8,       // 刺破深度上限（ATR 倍）：超过就是真突破，不是假破
  minReclaimAtr = 0.5,      // 收回强度下限（ATR 倍）
  minRangeAtr = 4,          // 区间至少要有多宽才谈得上“吸筹/派发区”
  dedupeBars = 12
} = {}) {
  const n = (bars || []).length;
  if (n < range + 2) return [];
  const a = atr(bars, atrPeriod);
  const avgVol = (i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - range); j < i; j++) { s += bars[j].volume || 0; c++; }
    return c ? s / c : 0;
  };
  const events = [];

  for (let i = range; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - range; j < i; j++) {
      if (bars[j].high > hi) hi = bars[j].high;
      if (bars[j].low < lo) lo = bars[j].low;
    }
    const b = bars[i], at = a[i];
    if (!at || at <= 0) continue;
    if ((hi - lo) / at < minRangeAtr) continue;          // 不是有效震荡区间，跳过
    const vol = avgVol(i);

    const breachDown = lo - b.low;
    const breachUp = b.high - hi;

    if (breachDown > 0 && breachDown <= at * maxBreachAtr && b.close - lo >= at * minReclaimAtr) {
      events.push({ kind: 'spring', label: '弹簧(假跌破)', idx: i, date: b.date, price: lo, low: b.low, close: b.close, strength: (b.close - lo) / at });
    }
    if (breachUp > 0 && breachUp <= at * maxBreachAtr && hi - b.close >= at * minReclaimAtr) {
      events.push({ kind: 'upthrust', label: '上冲回落(假突破)', idx: i, date: b.date, price: hi, high: b.high, close: b.close, strength: (hi - b.close) / at });
    }
    if (b.close > hi && vol > 0 && b.volume > vol * volumeRatio) {
      events.push({ kind: 'sos', label: '强势信号SOS(放量上破)', idx: i, date: b.date, price: hi, close: b.close, strength: b.volume / vol });
    }
    if (b.close < lo && vol > 0 && b.volume > vol * volumeRatio) {
      events.push({ kind: 'sow', label: '弱势信号SOW(放量下破)', idx: i, date: b.date, price: lo, close: b.close, strength: b.volume / vol });
    }
  }

  // 同类型相邻事件合并：边界上连报多根是常态，只留最强的那个
  const merged = [];
  for (const e of events.sort((x, y) => x.idx - y.idx)) {
    const prev = merged.find(m => m.kind === e.kind && Math.abs(m.idx - e.idx) < dedupeBars);
    if (prev) { if (e.strength > prev.strength) Object.assign(prev, e); }
    else merged.push({ ...e });
  }
  return merged;
}
