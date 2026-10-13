/**
 * 策略用指标。全部为纯函数、无随机、无当前时间 —— 回测必须可复现。
 * 输出统一为与 bars 等长的数组，暖机期为 null：让「数据不足」显式可见，
 * 而不是悄悄用 0 参与计算（0 会让 ATR/波动仓位算出荒谬的大仓位）。
 */

import { atr, trueRanges } from '../analysis/common.js';

export { atr, trueRanges };

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

/** MACD：DIF=EMA(f)-EMA(s)，DEA=EMA(DIF,signal)，柱=2*(DIF-DEA)（国内软件惯例）。 */
export function macd(closes, { fast = 12, slow = 26, signal = 9 } = {}) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const dif = closes.map((_, i) => (ef[i] === null || es[i] === null ? null : ef[i] - es[i]));
  const compact = dif.filter(v => v !== null);
  const deaCompact = ema(compact, signal);
  const dea = new Array(closes.length).fill(null);
  let j = 0;
  for (let i = 0; i < dif.length; i++) if (dif[i] !== null) { dea[i] = deaCompact[j++]; }
  const hist = dif.map((v, i) => (v === null || dea[i] === null ? null : (v - dea[i]) * 2));
  return { dif, dea, hist };
}

export function boll(closes, { period = 20, mult = 2 } = {}) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

/** Donchian 通道：用**上一根为止**的 N 根极值，不含当前 bar —— 否则等于用今天的最高价决定今天的突破。 */
export function donchian(bars, period = 20) {
  const upper = new Array(bars.length).fill(null);
  const lower = new Array(bars.length).fill(null);
  for (let i = period; i < bars.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period; j < i; j++) {   // 注意 j < i：排除当前 bar
      if (bars[j].high > hi) hi = bars[j].high;
      if (bars[j].low < lo) lo = bars[j].low;
    }
    upper[i] = hi; lower[i] = lo;
  }
  return { upper, lower, mid: upper.map((u, i) => (u === null || lower[i] === null ? null : (u + lower[i]) / 2)) };
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

export function kdj(bars, { period = 9, k = 3, d = 3 } = {}) {
  const kv = new Array(bars.length).fill(null);
  const dv = new Array(bars.length).fill(null);
  const jv = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j].high > hi) hi = bars[j].high;
      if (bars[j].low < lo) lo = bars[j].low;
    }
    const rsv = hi === lo ? 50 : (bars[i].close - lo) / (hi - lo) * 100;
    kv[i] = i === period - 1 ? rsv : (kv[i - 1] * (k - 1) + rsv) / k;
    dv[i] = i === period - 1 ? kv[i] : (dv[i - 1] * (d - 1) + kv[i]) / d;
    jv[i] = 3 * kv[i] - 2 * dv[i];
  }
  return { k: kv, d: dv, j: jv };
}

/** 上一根为止的 N 根最高/最低（突破判定用，不含当前 bar）。 */
export function priorExtreme(bars, period, field) {
  const out = new Array(bars.length).fill(null);
  for (let i = period; i < bars.length; i++) {
    let v = field === 'high' ? -Infinity : Infinity;
    for (let j = i - period; j < i; j++) v = field === 'high' ? Math.max(v, bars[j].high) : Math.min(v, bars[j].low);
    out[i] = v;
  }
  return out;
}

/** 交叉检测：上穿/下穿，null 暖机期不参与。 */
export function crosses(a, b) {
  const n = Math.min(a.length, b.length);
  const up = new Array(n).fill(false), dn = new Array(n).fill(false);
  for (let i = 1; i < n; i++) {
    if (a[i] === null || b[i] === null || a[i - 1] === null || b[i - 1] === null) continue;
    up[i] = a[i - 1] <= b[i - 1] && a[i] > b[i];
    dn[i] = a[i - 1] >= b[i - 1] && a[i] < b[i];
  }
  return { up, dn };
}
