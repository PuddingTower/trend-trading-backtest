/**
 * 供需区（Supply & Demand Zones）+ 简化 Wyckoff 事件。
 *
 * 供需区取的是最主流的可定义版本：
 *   需求区 = 窄幅 base 之后紧跟一段强向上脱离（RBR/DBD）
 *   供给区 = 窄幅 base 之后紧跟一段强向下脱离（RBD/DBR）
 * base 用「实体很小 + 随后一根的位移远大于 base 波动」来判定，而不是随便找密集成交区。
 * 区域一旦被收盘价有效穿越即失效（broken），不再画 —— 留着失效区是最常见的误报来源。
 *
 * Wyckoff 只做两件可核验的事：区间内的 spring（下破后收回）与 upthrust（上破后收回），
 * 以及放量突破（SOS/SOW）。完整的 Wyckoff 阶段/因果分析不在这里装懂。
 */

import { atr } from './common.js';

export function supplyDemandZones(bars, {
  baseMaxRangeAtr = 0.6,
  departureAtrMult = 1.8,
  maxZones = 8,
  atrPeriod = 14
} = {}) {
  const n = (bars || []).length;
  if (n < atrPeriod + 5) return [];
  const a = atr(bars, atrPeriod);
  const zones = [];

  for (let i = atrPeriod; i < n - 1; i++) {
    const at = a[i];
    if (!at) continue;
    const base = bars[i];
    const baseRange = base.high - base.low;
    if (baseRange > at * baseMaxRangeAtr) continue;

    const next = bars[i + 1];
    const move = next.close - next.open;
    const strength = Math.abs(next.close - base.close) / at;
    if (strength < departureAtrMult) continue;

    const isDemand = move > 0;
    const top = Math.max(base.high, base.open, base.close);
    const bottom = Math.min(base.low, base.open, base.close);

    // 向后找首次被收盘价穿越的那根。一旦穿越即失效 —— 包括“最后一根才跌破”的情况：
    // 留着刚破的区继续画，是供需区最常见的误报来源（读者会以为支撑还在）。
    let broken = false;
    for (let j = i + 2; j < n; j++) {
      if (isDemand ? bars[j].close < bottom : bars[j].close > top) { broken = true; break; }
    }
    if (broken) continue;

    zones.push({
      kind: isDemand ? 'demand' : 'supply',
      label: isDemand ? '需求区' : '供给区',
      top, bottom,
      startIdx: i,
      endIdx: n - 1,
      strength,
      freshness: n - 1 - i
    });
  }

  return zones.sort((x, y) => y.strength - x.strength).slice(0, maxZones);
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
