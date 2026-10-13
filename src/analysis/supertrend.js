/**
 * Supertrend —— 一条单向动态支撑/阻力线。
 * 用经典 Wilder 递推（final band 会被上一根“锁住”，不允许往回缩），
 * 直接用 src±mult*ATR 画出来的那种是错的：会在震荡里来回跳，失去支撑/阻力含义。
 */

import { atr } from './common.js';

export function supertrend(bars, { period = 10, multiplier = 3 } = {}) {
  const n = (bars || []).length;
  const a = atr(bars, period);
  const out = new Array(n).fill(null);
  let prevUpper = null, prevLower = null, prevST = null;

  for (let i = 0; i < n; i++) {
    const at = a[i];
    if (at === null || !Number.isFinite(at)) continue;
    const b = bars[i];
    const src = (b.high + b.low) / 2;
    const bu = src + multiplier * at;
    const bl = src - multiplier * at;
    const pc = i > 0 ? bars[i - 1].close : b.close;

    const fu = (prevUpper === null || bu < prevUpper || pc > prevUpper) ? bu : prevUpper;
    const fl = (prevLower === null || bl > prevLower || pc < prevLower) ? bl : prevLower;

    let st;
    if (prevST === null) st = fu;
    else if (prevST === prevUpper) st = (b.close <= fu) ? fu : fl;
    else st = (b.close >= fl) ? fl : fu;

    const trend = st === fl ? 1 : -1;   // 1=多头趋势(线在价格下方) -1=空头
    out[i] = {
      idx: i, date: b.date, value: st, trend,
      upper: fu, lower: fl, atr: at,
      reversal: prevST !== null && ((prevST === prevUpper) !== (st === fu))
    };
    prevUpper = fu; prevLower = fl; prevST = st;
  }
  return out;
}

/** 最后一段趋势与最近一次翻转 —— 侧栏摘要用。 */
export function supertrendSummary(series) {
  const valid = (series || []).filter(Boolean);
  if (valid.length === 0) return null;
  const last = valid[valid.length - 1];
  let flips = 0, lastFlipIdx = null;
  for (const s of valid) if (s.reversal) { flips++; lastFlipIdx = s.idx; }
  return {
    trend: last.trend, value: last.value, price: last.price,
    flips, lastFlipIdx, barsSinceFlip: lastFlipIdx === null ? null : last.idx - lastFlipIdx
  };
}
