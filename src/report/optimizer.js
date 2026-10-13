/**
 * 参数寻优与 walk-forward（计划 M5）。
 *
 * 这一层的存在意义不是"找到最好的参数"，而是**把过拟合量化出来**。
 * 只报样本内最优成绩的工具都在骗人：200 组参数里挑出来的那组，样本内 Sharpe 2.3、
 * 样本外 0.2 是常态。所以这里每跑一次寻优都同时给出：
 *   - 最优参数在样本内的成绩
 *   - 它在全部参数里的分位（排第几）
 *   - 相邻参数邻域的成绩（孤峰 = 换个 1 就崩，是过拟合最直接的证据）
 *
 * 全部纯函数、无副作用、不碰 DOM：可以离线单测，也可以在 Web Worker 里直接跑。
 */

import { BacktestEngine } from '../core/backtestEngine.js';
import { computeMetrics } from './metrics.js';

/** 目标函数。null（亏光/序列过短）一律当 -Infinity 排名，不能让废 run 排到中间。 */
export const OBJECTIVES = {
  net:      { label: '净收益',       get: m => (m.ruined ? -Infinity : m.finalEquity - m.capital) },
  sharpe:   { label: 'Sharpe',       get: m => (m.sharpe === null || m.ruined ? -Infinity : m.sharpe) },
  calmar:   { label: 'Calmar',       get: m => (m.calmar === null || m.ruined ? -Infinity : m.calmar) },
  payoff:   { label: '盈亏比',       get: m => (m.ruined ? -Infinity : m.payoffRatio * Math.sqrt(Math.max(1, m.trades))) },
  winRate:  { label: '胜率(带笔数)', get: m => (m.ruined ? -Infinity : m.winRate * Math.sqrt(Math.max(1, m.trades))) },
  mddFree:  { label: '回撤最小',     get: m => (m.ruined ? -Infinity : -m.maxDDPct) }
};

/**
 * 笛卡尔积展开参数网格。
 * 键名先排序再展开 —— 否则同一组网格换个书写顺序，跑出来的名次表就会整体错位，
 * 而"我上次跑的最佳参数"就再也复现不出来了。
 */
export function gridPlans(baseParams = {}, grids = {}, { validate = null } = {}) {
  const keys = Object.keys(grids).filter(k => Array.isArray(grids[k]) && grids[k].length).sort();
  if (!keys.length) return [{ ...baseParams }];
  let plans = [{}];
  for (const k of keys) {
    const next = [];
    for (const p of plans) for (const v of grids[k]) next.push({ ...p, [k]: v });
    plans = next;
  }
  const out = plans.map(p => ({ ...baseParams, ...p }));
  return validate ? out.filter(p => validate(p) !== false) : out;
}

/**
 * 跑一组参数。runOne 只做「策略→信号→撮合→指标」，可被 Worker 与主线程共用。
 * 引擎在这里必须每次新建：它内部带 trades / equityCurve 累积状态，复用会把上一组的结果串进来。
 */
export function runOne({ bars, spec, strategy, params, engineOpts = {}, periodsPerYear = 252 }) {
  const signals = strategy.signals(bars, params);
  const eng = new BacktestEngine(bars, spec, { ...engineOpts });
  const res = eng.run(signals);
  const metrics = computeMetrics({ equityCurve: res.equityCurve, trades: res.trades, capital: res.capital, periodsPerYear, bars });
  return { params, metrics, trades: res.trades, equityCurve: res.equityCurve, rejected: res.rejected };
}

/**
 * 网格寻优。不一次性算完 —— 5 个品种 × 200 组参数会直接把主线程冻死，
 * 所以这里做成**可分块推进的迭代器**，UI 层每跑一块就交还控制权刷新进度条。
 */
export function gridRunner({ bars, spec, strategy, baseParams, grids, objective = 'sharpe', engineOpts = {}, periodsPerYear = 252, validate }) {
  const plans = gridPlans(baseParams, grids, { validate });
  const obj = OBJECTIVES[objective] || OBJECTIVES.sharpe;
  let i = 0;
  const acc = [];          // 已跑完的结果自己攒着
  return {
    total: plans.length,
    plans,
    objective,
    /** 已完成的组数（进度条用）。 */
    get progressed() { return i; },
    done: () => i >= plans.length,
    /** 跑最多 chunk 组。UI 每跑一块就把主线程交还给浏览器刷新进度条。 */
    step(chunk = 8) {
      const out = [];
      for (let n = 0; n < chunk && i < plans.length; n++, i++) {
        const r = runOne({ bars, spec, strategy, params: plans[i], engineOpts, periodsPerYear });
        acc.push(r); out.push(r);
      }
      return out;
    },
    /**
     * 收尾。这里必须返回**全部**结果而不是"剩下没跑的" ——
     * 分块推进的调用方通常已经自己 while(!done) step() 跑完了，
     * 那时 finish() 若只排剩余块就会返回空表，界面上看像是"寻优没找到任何参数"。
     */
    finish() {
      while (!this.done()) this.step(16);
      return rankResults(acc, obj);
    },
    rank: () => rankResults(acc, obj)
  };
}

/** 排序 + 补上分位与邻域稳健度。 */
export function rankResults(results, obj) {
  const scored = results.map(r => ({ ...r, score: Number.isFinite(obj.get(r.metrics)) ? obj.get(r.metrics) : -Infinity }))
    .sort((a, b) => (b.score - a.score) || (a.params < b.params ? -1 : 1));
  const n = scored.length;
  return scored.map((r, i) => ({
    params: r.params,
    score: r.score,
    metrics: r.metrics,
    rank: i + 1,
    percentile: n > 1 ? (n - i) / n : 1,
    trades: r.trades,
    equityCurve: r.equityCurve,
    rejected: r.rejected
  }));
}

/**
 * 邻域稳健度：把最优参数在每个维度上 ±1 档，看成绩掉多少。
 * 孤峰（掉得很狠）= 换个 1 就崩，这个"最优"是拟合噪声拟合出来的。
 */
export function neighborhoodScore({ bars, spec, strategy, best, grids, engineOpts = {}, objective = 'sharpe', periodsPerYear = 252 }) {
  const obj = OBJECTIVES[objective] || OBJECTIVES.sharpe;
  const keys = Object.keys(grids).sort();
  const variants = [];
  for (const k of keys) {
    const list = grids[k];
    const at = list.indexOf(best[k]);
    if (at === -1) continue;
    for (const d of [-1, 1]) {
      const j = at + d;
      if (j < 0 || j >= list.length) continue;
      const params = { ...best, [k]: list[j] };
      const r = runOne({ bars, spec, strategy, params, engineOpts, periodsPerYear });
      variants.push({ k, delta: d, value: list[j], score: obj.get(r.metrics), ruined: !!r.metrics.ruined });
    }
  }
  const finite = variants.map(v => v.score).filter(Number.isFinite);
  const bestScore = obj.get(best._metrics || { sharpe: null });
  const worst = finite.length ? Math.min(...finite) : null;
  return {
    variants,
    // 邻域最差值相对最优值的保留比例：>0.5 才敢说这个参数站得住
    retain: (worst !== null && Number.isFinite(bestScore) && bestScore > 0) ? worst / bestScore : null
  };
}

/**
 * Walk-forward：滚动「样本内挑参数 → 样本外验证」。
 *
 * 样本外才是策略的真实成绩。这里把每段的样本外权益**拼接**成一条连续曲线，
 * 而不是把各段单独年化再平均 —— 平均会让"连亏三段"看起来和"波动大但赚钱"一样好。
 */
export function walkForward({ bars, spec, strategy, baseParams, grids, objective = 'sharpe',
                              isLen = 500, oosLen = 120, stepLen = 120, engineOpts = {},
                              periodsPerYear = 252, onWindow = null }) {
  const n = (bars || []).length;
  if (n < isLen + oosLen) return { windows: [], error: `数据 ${n} 根，不够一个 IS(${isLen})+OOS(${oosLen}) 窗口` };
  const obj = OBJECTIVES[objective] || OBJECTIVES.sharpe;
  const windows = [];
  let cursor = 0;
  while (cursor + isLen + oosLen <= n) {
    const isBars = bars.slice(cursor, cursor + isLen);
    const oosBars = bars.slice(cursor + isLen, cursor + isLen + oosLen);
    const plans = gridPlans(baseParams, grids);
    let best = null;
    for (const p of plans) {
      const r = runOne({ bars: isBars, spec, strategy, params: p, engineOpts, periodsPerYear });
      const s = obj.get(r.metrics);
      if (!best || s > best.score) best = { params: p, score: s, metrics: r.metrics };
    }
    if (!best || !Number.isFinite(best.score)) {
      cursor += stepLen;
      continue;
    }
    // 样本外用样本内挑出的参数，且**不许重新拟合**
    const oos = runOne({ bars: oosBars, spec, strategy, params: best.params, engineOpts, periodsPerYear });
    const window = {
      isStartIdx: cursor, isEndIdx: cursor + isLen - 1,
      oosStartIdx: cursor + isLen, oosEndIdx: cursor + isLen + oosLen - 1,
      isDateFrom: isBars[0].date, isDateTo: isBars[isBars.length - 1].date,
      oosDateFrom: oosBars[0].date, oosDateTo: oosBars[oosBars.length - 1].date,
      best: best.params, isScore: best.score, isMetrics: best.metrics,
      oosScore: obj.get(oos.metrics), oosMetrics: oos.metrics, oosCurve: oos.equityCurve,
      // 本段样本外的收益倍数。拼接曲线按因子连乘，而不是把各段绝对金额相加 ——
      // 每段都从满仓起步，金额不可比，因子才可比。
      oosFactor: oos.metrics.capital > 0 ? oos.metrics.finalEquity / oos.metrics.capital : 1
    };
    windows.push(window);
    if (onWindow) onWindow(window, windows.length);
    cursor += stepLen;
  }
  if (!windows.length) return { windows: [], error: '没有任何一段样本内能选出参数（全部亏损或数据不足）' };

  const isScores = windows.map(w => w.isScore).filter(Number.isFinite);
  const oosScores = windows.map(w => w.oosScore).filter(Number.isFinite);
  const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  // 参数漂移：同一维度在相邻窗口里换了几次。每段都换 = 参数根本不稳定，
  // 那么"样本内最优"只是在追噪声。
  const drift = {};
  for (const k of Object.keys(grids).sort()) {
    let changes = 0;
    for (let i = 1; i < windows.length; i++) if (windows[i].best[k] !== windows[i - 1].best[k]) changes++;
    drift[k] = { changes, rate: windows.length > 1 ? changes / (windows.length - 1) : 0 };
  }
  // 拼接样本外权益曲线：逐段把「本段内的收益因子」连乘到上一层水位
  const startEquity = windows[0].oosMetrics.capital || 100000;
  let level = startEquity;
  const stitched = [{ idx: windows[0].oosStartIdx - 1, date: windows[0].oosDateFrom, equity: startEquity }];
  for (const w of windows) {
    const curve = w.oosCurve || [];
    const base = curve.length ? curve[0].equity : 0;
    for (const p of curve) {
      const factor = base > 0 ? p.equity / base : 1;
      stitched.push({ idx: w.oosStartIdx + p.idx, date: p.date, equity: level * factor });
    }
    if (curve.length && base > 0) level = level * (curve[curve.length - 1].equity / base);
    w.oosEndEquity = level;
  }
  let peakEq = stitched.length ? stitched[0].equity : startEquity, stitchedMaxDDPct = 0;
  for (const s of stitched) {
    if (s.equity > peakEq) peakEq = s.equity;
    if (peakEq > 0) stitchedMaxDDPct = Math.max(stitchedMaxDDPct, (peakEq - s.equity) / peakEq);
  }

  return {
    windows,
    drift,
    combinedEquity: stitched,
    summary: {
      segments: windows.length,
      meanIsScore: mean(isScores),
      meanOosScore: mean(oosScores),
      // 效率比 = 样本外均值 / 样本内均值。<0.3 基本可以断定这套参数是拟合出来的
      efficiency: mean(isScores) > 0 ? mean(oosScores) / mean(isScores) : null,
      isOosGap: mean(isScores) - mean(oosScores),
      positiveOosSegments: oosScores.filter(s => s > 0).length,
      totalReturn: startEquity > 0 ? level / startEquity - 1 : 0,
      maxDDPct: stitchedMaxDDPct
    }
  };
}
