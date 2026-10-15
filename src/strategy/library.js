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

import { ema, sma, macd, rsi, atr, crosses, priorExtreme, adx, roc, fieldSma, rising, priorRange } from './indicators.js';
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
    // 信号挂在**枢轴确认那根**（confirmedAt），不是极值那根（idx）：
    // 极值要等之后某根回撤过阈值才成立，挂在 idx 上等于拿未来几根的数据给过去下指令。
    // sw 本身就是按确认先后 push 的，所以 sw.slice(0,k) 恰是第 k 个枢轴确认时已看得见的全部历史。
    const byConf = new Map();
    sw.forEach((s, k) => {
      const at = Number.isFinite(s.confirmedAt) ? s.confirmedAt : s.idx;
      const list = byConf.get(at);
      if (list) list.push(k); else byConf.set(at, [k]);
    });
    let state = DIR.FLAT;
    return bars.map((b, i) => {
      for (const k of byConf.get(i) || []) {
        const pt = sw[k];
        const prior = sw.slice(0, k).filter(s => s.type === pt.type).slice(-q.lookback);
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

// ---------------- 7. Minervini 趋势模板 + 枢轴买点 ----------------
/**
 * 趋势模板的八条判据，单独导出成函数：扫描器要在"还没突破但模板成立"的品种上读它，
 * 而 signals() 只在持仓状态下返回对象 —— 拿不到判据就只能把八条重写一遍，两处会慢慢对不上。
 *
 * 第 8 条（RS 相对强度）是横截面指标，单品种拿不到：
 * opts.rsBars 给基准指数序列才算；useRs=true 又没给基准时 rsAvailable=false，
 * 由调用方决定是降级到 7 条还是不出信号（策略里选的是"要求就不出"）。
 // ---------------- 7. Minervini 趋势模板 + 枢轴买点 ----------------
/**
 * 《Trade Like a Stock Market Wizard》里那 8 条趋势模板。
 * 它的价值不在买点有多聪明，而在**过滤掉八成不合格的机会**：只在多头排列、
 * 离新高近、离低点远的品种上找突破。
 *
 * 第 8 条（RS 相对强度）是横截面指标，单品种拿不到：rsBars 给基准序列才算。
 * useRs=true 又缺基准时策略**不出信号**（静默降级等于假装自己跑的是完整模板）；
 * useRs=false 时按能算的 7 条判定，reason 里如实写明"RS 无基准未参与"。
 */
/**
 * 逐根的模板判据（向量化算一遍，供 signals 与扫描器共用）。
 * 每个下标返回 {crit, passed, enabled, ok}，暖机期返回 null —— 不假装判得过。
 */
function templateSeries(bars, q) {
  const closes = bars.map(b => b.close);
  const f = sma(closes, q.maFast), m = sma(closes, q.maMid), s = sma(closes, q.maSlow);
  const rg = priorRange(bars, q.rangeLook);
  const rr = rising(sma(closes, q.maSlow), q.riseLook);
  const rrMid = rising(sma(closes, q.maMid), q.riseLook);
  const rsFlag = (() => {
    if (q.useRs !== true) return null;             // 开关关着就不参与判定，给了基准也不算
    const rb = q.rsBars;
    if (!Array.isArray(rb) || rb.length < q.riseLook + 2) return null;
    const own = roc(closes, q.riseLook);
    const benchRoc = roc(rb.map(b => b.close), q.riseLook);
    // 基准按**日期**对齐而不是按下标：基准起步晚于品种时，bench[i] 取到的是未来的某一天，
    // RS 判据会凭空变强。日期对不上就返回 null（该判据不参与判定），而不是硬凑一个值。
    const benchByDate = new Map(rb.map((b, k) => [String(b.date).slice(0, 10), benchRoc[k]]));
    return closes.map((_, i) => {
      const o = own[i], b2 = benchByDate.get(String(bars[i].date).slice(0, 10));
      return (o === null || o === undefined || !Number.isFinite(b2)) ? null : o > b2;
    });
  })();
  return bars.map((b, i) => {
    if ([f[i], m[i], s[i], rg.hi[i], rg.lo[i]].some(v => v === null)) return null;
    const crit = [
      { k: '价>150&200日线', ok: b.close > m[i] && b.close > s[i] },
      { k: '150>200', ok: m[i] > s[i] },
      { k: '价>50日线', ok: b.close > f[i] },
      { k: '50>150>200', ok: f[i] > m[i] && m[i] > s[i] },
      { k: `离${q.rangeLook}日低≥${(q.minAboveLow * 100) | 0}%`, ok: b.close / rg.lo[i] - 1 >= q.minAboveLow },
      { k: `距${q.rangeLook}日高≤${(q.maxBelowHigh * 100) | 0}%`, ok: b.close / rg.hi[i] - 1 >= -q.maxBelowHigh },
      { k: '200日/150日上行', ok: rr[i] === true && rrMid[i] === true },
      { k: 'RS 强于基准', ok: rsFlag ? rsFlag[i] : null }
    ];
    const enabled = crit.filter(c => c.ok !== null);
    const passed = enabled.filter(c => c.ok).length;
    return { crit, passed, enabled: enabled.length,
             ok: enabled.length >= 6 && passed === enabled.length,
             rsAvailable: rsFlag !== null && rsFlag[i] !== null && rsFlag[i] !== undefined,
             values: { ma50: f[i], ma150: m[i], ma200: s[i], hi: rg.hi[i], lo: rg.lo[i], close: b.close } };
  });
}

const TEMPLATE_DEFAULTS = { maFast: 50, maMid: 150, maSlow: 200, rangeLook: 250, minAboveLow: 0.15,
                            maxBelowHigh: 0.25, riseLook: 63, useRs: false };

/** 最后一根的模板判据 —— 扫描器用它回答"这个品种今天符合趋势模板吗"。 */
export function trendTemplate(bars, opts = {}) {
  const q = { ...TEMPLATE_DEFAULTS, ...opts };
  const list = templateSeries(bars || [], q);
  const last = list.length ? list[list.length - 1] : null;
  return last || { crit: [], passed: 0, enabled: 0, ok: false, rsAvailable: false, values: null };
}

/** 枢轴突破：收盘越过前 N 根高点（不含本根），可选量能确认。 */
export function pivotBreak(bars, { pivotLook = 25, volLen = 50, volMul = 1.2, i = null } = {}) {
  const idx = i === null ? bars.length - 1 : i;
  const hh = priorExtreme(bars, pivotLook, 'high');
  if (hh[idx] === null) return { broke: false, level: null, volOk: false };
  const volMa = fieldSma(bars, 'volume', volLen);
  const b = bars[idx];
  const volOk = !(Number.isFinite(b.volume) && Number.isFinite(volMa[idx])) || b.volume >= volMul * volMa[idx];
  return { broke: b.close > hh[idx], level: hh[idx], volOk, volume: b.volume, volMa: volMa[idx] };
}

export const minerviniTemplate = {
  id: 'minerviniTemplate', name: 'Minervini 趋势模板',
  params: { ...TEMPLATE_DEFAULTS, pivotLook: 25, pivotVolMul: 1.2, stopPct: 0.075, exitMa: true, bothWays: false },
  signals(bars, p = {}) {
    const q = { ...this.params, ...p };
    const tpl = templateSeries(bars, q);
    const f = sma(bars.map(b => b.close), q.maFast);
    const hh = priorExtreme(bars, q.pivotLook, 'high');
    const volMa = fieldSma(bars, 'volume', 50);
    const rsMissing = q.useRs === true && !tpl.some(t => t && t.rsAvailable);   // 要求 RS 又拿不到基准：宁可不交易
    let state = DIR.FLAT;
    return bars.map((b, i) => {
      const t = tpl[i];
      if (state === DIR.LONG && q.exitMa && f[i] !== null && b.close < f[i]) state = DIR.FLAT;
      if (state !== DIR.LONG && t && t.ok && !rsMissing && hh[i] !== null && b.close > hh[i]
        && !(Number.isFinite(b.volume) && Number.isFinite(volMa[i]) && b.volume < q.pivotVolMul * volMa[i])) state = DIR.LONG;
      if (state === DIR.FLAT) return null;
      const sig = { i, dir: state,
        reason: `模板 ${t ? t.passed : '?'}/${t ? t.enabled : '?'}${t && !t.rsAvailable ? '（RS 无基准未参与）' : ''} · 突破${q.pivotLook}日枢轴`,
        template: { crit: t ? t.crit : [], passed: t ? t.passed : 0, enabled: t ? t.enabled : 0, rsAvailable: t ? t.rsAvailable : false } };
      sig.stop = b.close * (1 - q.stopPct);
      return sig;
    });
  }
};

// ---------------- 8. 趋势区间过滤突破（Clenow 式） ----------------
/**
 * 里肖《Stock Market Logic / Trend Following》那一套：先判"现在是不是趋势状态"，
 * 再用长周期均线之上 + ADX 达标 + 放量突破近期高点进场。
 * 和唐奇安的区别：Donchian 什么行情都突破，这里**只在趋势里**突破 —— 用胜率换出手次数。
 */
export const trendRegime = {
  id: 'trendRegime', name: '趋势区间过滤突破',
  params: {
    maLen: 100, riseLook: 21, adxLen: 14, adxMin: 20, breakout: 20, volLen: 20, volMul: 1.0,
    atrLen: 14, stopAtr: 2.5, trailAtr: 3, exitMa: true, bothWays: false
  },
  signals(bars, p = {}) {
    const q = { ...this.params, ...p };
    const closes = bars.map(b => b.close);
    const ma = sma(closes, q.maLen);
    const up = rising(ma, q.riseLook);
    const { adx: ax, plus, minus } = adx(bars, q.adxLen);
    const volMa = fieldSma(bars, 'volume', q.volLen);
    const hh = priorExtreme(bars, q.breakout, 'high');
    const ll = priorExtreme(bars, q.breakout, 'low');
    const exL = priorExtreme(bars, Math.max(5, Math.round(q.breakout / 2)), 'low');
    const exH = priorExtreme(bars, Math.max(5, Math.round(q.breakout / 2)), 'high');
    const a = atr(bars, q.atrLen);
    let state = DIR.FLAT;
    return bars.map((b, i) => {
      if (ma[i] === null || ax[i] === null || hh[i] === null) return null;
      const bullRegime = b.close > ma[i] && up[i] === true && ax[i] >= q.adxMin && (plus[i] ?? 0) > (minus[i] ?? 0);
      const bearRegime = b.close < ma[i] && up[i] === false && ax[i] >= q.adxMin && (minus[i] ?? 0) > (plus[i] ?? 0);
      const volOk = !(Number.isFinite(b.volume) && Number.isFinite(volMa[i])) || b.volume >= q.volMul * volMa[i];
      if (state === DIR.FLAT) {
        if (bullRegime && b.close > hh[i] && volOk) state = DIR.LONG;
        else if (q.bothWays && bearRegime && b.close < ll[i] && volOk) state = DIR.SHORT;
      } else if (state === DIR.LONG) {
        if (q.exitMa && b.close < ma[i]) state = q.bothWays && bearRegime ? DIR.SHORT : DIR.FLAT;
        else if (exL[i] !== null && b.close < exL[i]) state = q.bothWays && bearRegime ? DIR.SHORT : DIR.FLAT;
      } else if (q.exitMa && b.close > ma[i]) state = bullRegime ? DIR.LONG : DIR.FLAT;
      else if (exH[i] !== null && b.close > exH[i]) state = bullRegime ? DIR.LONG : DIR.FLAT;
      if (state === DIR.FLAT) return null;
      const sig = { i, dir: state, reason: `ADX${ax[i].toFixed(0)} 趋势态 · 突破${q.breakout}日`, adx: ax[i] };
      if (q.stopAtr) sig.stop = state === DIR.LONG ? b.close - q.stopAtr * a[i] : b.close + q.stopAtr * a[i];
      return applyTrail(bars, a, sig, state, q.trailAtr);
    });
  }
};

// ---------------- 9. N 字量价形态（倍量起涨 → 缩量回调 → 放量突破） ----------------
/**
 * 国内教材里最常见的一个结构：一根放量大阳把趋势拉开，回调时量能缩回去（没人卖），
 * 再放量越过前高时进场 —— 进场点比裸突破晚一点，但假突破少得多。
 *
 * 判定只用 i 及之前的 bar：起涨根、回调段、突破根全在窗口内，未来函数无处下手。
 */
export const nVolumePattern = {
  id: 'nVolumePattern', name: 'N字量价突破',
  params: {
    volLen: 20, startMul: 1.8, shrinkMul: 0.9, minPull: 2, maxPull: 8, breakMul: 1.5,
    atrLen: 14, stopAtr: 2, trailAtr: 2.5, exitLowLook: 10, bothWays: false
  },
  signals(bars, p = {}) {
    const q = { ...this.params, ...p };
    const a = atr(bars, q.atrLen);
    const volMa = fieldSma(bars, 'volume', q.volLen);
    const exL = priorExtreme(bars, q.exitLowLook, 'low');
    let state = DIR.FLAT;
    const nudge = (i) => {           // 找出以 i 为突破根的 N 字结构，返回起涨根下标或 null
      if (volMa[i] === null || !Number.isFinite(bars[i].volume)) return null;
      if (!(bars[i].close > bars[i].open) || bars[i].volume < q.breakMul * volMa[i]) return null;
      for (let j = Math.max(1, i - q.maxPull - 1); j <= i - q.minPull; j++) {
        if (volMa[j] === null) continue;
        const rallied = bars[j].close > bars[j].open && bars[j].volume >= q.startMul * volMa[j];
        if (!rallied) continue;
        if (bars[i].close <= bars[j].high) continue;                 // 必须越过起涨根的高点
        let shrunk = true, held = true;
        for (let k = j + 1; k < i; k++) {
          if (volMa[k] !== null && bars[k].volume > q.shrinkMul * volMa[k]) { shrunk = false; break; }
          if (bars[k].low < bars[j].open) { held = false; break; }   // 回调跌破起涨那根的开盘 = 结构坏了
        }
        if (shrunk && held) return j;
      }
      return null;
    };
    return bars.map((b, i) => {
      if (i < q.volLen + 2) return null;
      if (state === DIR.LONG && exL[i] !== null && b.close < exL[i]) state = DIR.FLAT;
      if (state === DIR.FLAT) { const j = nudge(i); if (j !== null) state = DIR.LONG; }
      if (state === DIR.FLAT) return null;
      const sig = { i, dir: state, reason: 'N字：倍量起涨→缩量回调→放量突破' };
      if (q.stopAtr) sig.stop = b.close - q.stopAtr * a[i];
      return applyTrail(bars, a, sig, state, q.trailAtr);
    });
  }
};

export const STRATEGIES = [maCross, donchianBreak, dualThrust, macdTrend, hhLlStructure, rsiReversion,
                           minerviniTemplate, trendRegime, nVolumePattern];
export const getStrategy = (id) => STRATEGIES.find(s => s.id === id) || null;
