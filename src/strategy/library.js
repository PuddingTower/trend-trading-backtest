/**
 * 内置趋势策略库。
 *
 * 每个策略导出 `signals(bars, params) -> Array<{dir, stop?, target?, trail?, reason}>`，
 * 且**只允许看 bars[0..i]**（含 i）来产出第 i 项 —— 撮合与次根成交由引擎负责，
 * 策略里再出现 bars[i+1] 就是双重未来函数。
 *
 * trail 是「吊灯止损」候选位：引擎每根把它与现有 stop 取更紧的一侧，
 * 所以止损只会朝有利方向移动，不会放松。
 */

import { ema, sma, macd, rsi, atr, crosses, priorExtreme } from './indicators.js';
import { swingPoints } from '../analysis/common.js';

const DIR = { FLAT: 0, LONG: 1, SHORT: -1 };

/** 吊灯止损候选：多头=最高价-k*ATR，空头=最低价+k*ATR。 */
function chandelier(bars, a, i, mult, dir) {
  const look = 22;
  const from = Math.max(0, i - look + 1);
  let peak = -Infinity, trough = Infinity;
  for (let j = from; j <= i; j++) { peak = Math.max(peak, bars[j].high); trough = Math.min(trough, bars[j].low); }
  const at = a[i];
  if (!at) return null;
  return dir === DIR.LONG ? peak - mult * at : trough + mult * at;
}

function applyTrail(bars, a, sig, dir, trailMult) {
  if (!trailMult || dir === DIR.FLAT) return sig;
  const t = chandelier(bars, a, sig.i, trailMult, dir);
  return t === null ? sig : { ...sig, trail: t };
}

// ---------------- 1. 双均线交叉 ----------------
export const maCross = {
  id: 'maCross', name: '双均线交叉',
  params: { fast: 10, slow: 30, atrLen: 14, stopAtr: 0, trailAtr: 3, mode: 'ema', bothWays: true },
  signals(bars, p = {}) {
    const q = { ...this.params, ...p };
    const closes = bars.map(b => b.close);
    const f = q.mode === 'sma' ? sma(closes, q.fast) : ema(closes, q.fast);
    const s = q.mode === 'sma' ? sma(closes, q.slow) : ema(closes, q.slow);
    const a = atr(bars, q.atrLen);
    const { up, dn } = crosses(f, s);
    return bars.map((b, i) => {
      let sig = { i, dir: DIR.FLAT };
      if (up[i]) sig = { i, dir: DIR.LONG, reason: '均线金叉' };
      else if (dn[i]) sig = { i, dir: q.bothWays ? DIR.SHORT : DIR.FLAT, reason: q.bothWays ? '均线死叉(反手)' : '均线死叉(平仓)' };
      else if (f[i] !== null && s[i] !== null) sig = { i, dir: f[i] > s[i] ? DIR.LONG : (q.bothWays ? DIR.SHORT : DIR.FLAT) };
      if (sig.dir === DIR.FLAT) return null;
      if (q.stopAtr) sig.stop = sig.dir === DIR.LONG ? b.close - q.stopAtr * a[i] : b.close + q.stopAtr * a[i];
      return applyTrail(bars, a, sig, sig.dir, q.trailAtr);
    });
  }
};

// ---------------- 2. Donchian 通道突破（海龟式） ----------------
export const donchianBreak = {
  id: 'donchianBreak', name: '唐奇安通道突破',
  params: { entry: 20, exit: 10, atrLen: 14, stopAtr: 2, trailAtr: 0, bothWays: true },
  signals(bars, p = {}) {
    const q = { ...this.params, ...p };
    const a = atr(bars, q.atrLen);
    const hh = priorExtreme(bars, q.entry, 'high');
    const ll = priorExtreme(bars, q.entry, 'low');
    const exH = priorExtreme(bars, q.exit, 'high');
    const exL = priorExtreme(bars, q.exit, 'low');
    let state = DIR.FLAT;
    return bars.map((b, i) => {
      if (hh[i] === null || ll[i] === null) return null;
      if (state === DIR.FLAT || state === DIR.SHORT) { if (b.close > hh[i]) state = DIR.LONG; }
      else if (b.close < exL[i]) state = q.bothWays ? (b.close < ll[i] ? DIR.SHORT : DIR.FLAT) : DIR.FLAT;
      if (state === DIR.LONG && b.close < exL[i]) state = q.bothWays ? DIR.SHORT : DIR.FLAT;
      if (state === DIR.SHORT && b.close > exH[i]) state = DIR.FLAT;

      if (state === DIR.FLAT) return null;
      const sig = { i, dir: state, reason: state === DIR.LONG ? `突破${q.entry}日高` : `跌破${q.entry}日低` };
      if (q.stopAtr) sig.stop = state === DIR.LONG ? b.close - q.stopAtr * a[i] : b.close + q.stopAtr * a[i];
      return sig;
    });
  }
};

// ---------------- 3. Dual Thrust ----------------
export const dualThrust = {
  id: 'dualThrust', name: 'Dual Thrust',
  params: { n: 4, k1: 0.5, k2: 0.65, bothWays: true },
  signals(bars, p = {}) {
    const q = { ...this.params, ...p };
    let state = DIR.FLAT;
    return bars.map((b, i) => {
      if (i <= q.n) return null;
      let hh = -Infinity, ll = Infinity, hc = -Infinity, lc = Infinity;
      for (let j = i - q.n; j < i; j++) {
        hh = Math.max(hh, bars[j].high); ll = Math.min(ll, bars[j].low);
        hc = Math.max(hc, bars[j].close); lc = Math.min(lc, bars[j].close);
      }
      const range = Math.max(hh - lc, hc - ll);
      const buy = b.open + q.k1 * range, sell = b.open - q.k2 * range;
      if (b.close > buy) state = DIR.LONG;
      else if (b.close < sell) state = q.bothWays ? DIR.SHORT : DIR.FLAT;
      if (state === DIR.FLAT) return null;
      return { i, dir: state, reason: `DualThust 区间${range.toFixed(1)}` };
    });
  }
};

// ---------------- 4. MACD 趋势 ----------------
export const macdTrend = {
  id: 'macdTrend', name: 'MACD 趋势',
  params: { fast: 12, slow: 26, signal: 9, atrLen: 14, trailAtr: 3, zeroFilter: true },
  signals(bars, p = {}) {
    const q = { ...this.params, ...p };
    const closes = bars.map(b => b.close);
    const { dif, dea } = macd(closes, { fast: q.fast, slow: q.slow, signal: q.signal });
    const a = atr(bars, q.atrLen);
    const { up, dn } = crosses(dif, dea);
    let state = DIR.FLAT;
    return bars.map((b, i) => {
      if (dif[i] === null || dea[i] === null) return null;
      if (up[i]) state = q.zeroFilter && dif[i] < 0 ? state : DIR.LONG;
      if (dn[i]) state = q.zeroFilter && dif[i] > 0 ? state : DIR.SHORT;
      if (state === DIR.FLAT) return null;
      const sig = { i, dir: state, reason: 'MACD 交叉' };
      return applyTrail(bars, a, sig, state, q.trailAtr);
    });
  }
};

// ---------------- 5. 高低点结构 HH/HL ----------------
export const hhLlStructure = {
  id: 'hhLlStructure', name: '高低点结构(HH/HL)',
  params: { swingPct: 0.04, atrLen: 14, trailAtr: 2.5, lookback: 2 },
  signals(bars, p = {}) {
    const q = { ...this.params, ...p };
    const a = atr(bars, q.atrLen);
    const sw = swingPoints(bars, { pct: q.swingPct });
    const byIdx = new Map(sw.map(s => [s.idx, s]));
    let state = DIR.FLAT;
    return bars.map((b, i) => {
      const pt = byIdx.get(i);
      if (pt) {
        const prior = sw.filter(s => s.type === pt.type && s.idx < i).slice(-q.lookback);
        if (prior.length === q.lookback) {
          if (pt.type === 'high' && prior.every(s => s.price < pt.price)) state = DIR.LONG;    // 高点抬高 = HH
          else if (pt.type === 'low' && prior.every(s => s.price > pt.price)) state = DIR.SHORT; // 低点降低 = LL
          else if (pt.type === 'high' && prior.some(s => s.price > pt.price)) state = DIR.FLAT;  // 高点降低 = LH
          else if (pt.type === 'low' && prior.some(s => s.price < pt.price)) state = DIR.FLAT;   // 低点抬高 = HL
        }
      }
      if (state === DIR.FLAT) return null;
      const sig = { i, dir: state, reason: state === DIR.LONG ? 'HH 结构成立' : 'LL 结构成立' };
      return applyTrail(bars, a, sig, state, q.trailAtr);
    });
  }
};

// ---------------- 6. 均值回归对照（不是趋势策略，用来当反面教材） ----------------
export const rsiReversion = {
  id: 'rsiReversion', name: 'RSI 均值回归(对照)',
  params: { period: 14, low: 30, high: 70, exitLevel: 50 },
  signals(bars, p = {}) {
    const q = { ...this.params, ...p };
    const r = rsi(bars.map(b => b.close), q.period);
    let state = DIR.FLAT;
    return bars.map((b, i) => {
      if (r[i] === null) return null;
      if (state === DIR.FLAT) {
        if (r[i] < q.low) state = DIR.LONG;
        else if (r[i] > q.high) state = DIR.SHORT;
      } else if (state === DIR.LONG && r[i] > q.exitLevel) state = DIR.FLAT;
      else if (state === DIR.SHORT && r[i] < 100 - q.exitLevel) state = DIR.FLAT;
      return state === DIR.FLAT ? null : { i, dir: state, reason: `RSI ${r[i].toFixed(0)}` };
    });
  }
};

export const STRATEGIES = [maCross, donchianBreak, dualThrust, macdTrend, hhLlStructure, rsiReversion];
export const getStrategy = (id) => STRATEGIES.find(s => s.id === id) || null;
