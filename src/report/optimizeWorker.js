/**
 * 寻优 Worker（计划 M5：Web Worker 分块并行）。
 *
 * 只干一件事：把「策略 id + 参数网格」变成名次表，边跑边报进度。
 * 主线程靠这个才不会在 200 组参数 × 5 年日线时冻住 —— 冻住的页面上 iPad 会直接
 * 把它当成卡死杀掉。
 *
 * 注意：Worker 收不到函数（结构化克隆会丢掉），所以传的是 **策略 id**，
 * 由这里从 STRATEGIES 注册表里取。品种数据直接传 bar 数组。
 * 任何 Worker 不支持 / module worker 不可用的环境，上层会退回主线程分块跑，
 * 所以这里的逻辑必须和 gridRunner / walkForward 完全同源（只 import，不复制）。
 */

import { gridRunner, walkForward } from './optimizer.js';
import { getStrategy } from '../strategy/library.js';
import { rulesFor } from '../markets/marketRules.js';

/**
 * postMessage 走结构化克隆：类实例会被拆成普通对象，**原型上的方法全丢**。
 * 所以 rules 绝不能从主线程传进来 —— 传进来就变成没有 canOpen / canFillAt 的空壳，
 * 引擎里 `this.rules.canOpen(...)` 直接炸。这里只收纯数据的 spec，规则由 Worker 自己造。
 * rulesFor(spec) 是纯函数，两边造出来的行为一致。
 */
function optsWithRules(msg) {
  const { rules: _ignored, ...rest } = msg.engineOpts || {};
  return { ...rest, rules: rulesFor(msg.spec) };
}

self.onmessage = (e) => {
  const msg = e.data || {};
  try {
    const strategy = getStrategy(msg.strategyId);
    if (!strategy) return self.postMessage({ type: 'error', error: `未知策略 ${msg.strategyId}` });
    const engineOpts = optsWithRules(msg);

    if (msg.job === 'grid') {
      const runner = gridRunner({
        bars: msg.bars, spec: msg.spec, strategy, baseParams: msg.baseParams || {},
        grids: msg.grids || {}, objective: msg.objective || 'sharpe',
        engineOpts, periodsPerYear: msg.periodsPerYear || 252
      });
      const chunk = msg.chunk || 8;
      while (!runner.done()) {
        runner.step(chunk);
        self.postMessage({ type: 'progress', job: 'grid', done: runner.progressed, total: runner.total });
      }
      const ranked = runner.finish();
      // 名次表只回传渲染需要的字段：整条权益曲线有几千个点，结构化克隆它会把主线程压垮
      self.postMessage({
        type: 'result', job: 'grid', total: runner.total,
        rows: ranked.map(r => ({ params: r.params, score: r.score, rank: r.rank, percentile: r.percentile, metrics: slim(r.metrics) })),
        best: ranked[0] ? ranked[0].params : null
      });
      return;
    }

    if (msg.job === 'walkforward') {
      const res = walkForward({
        bars: msg.bars, spec: msg.spec, strategy, baseParams: msg.baseParams || {},
        grids: msg.grids || {}, objective: msg.objective || 'sharpe',
        isLen: msg.isLen, oosLen: msg.oosLen, stepLen: msg.stepLen,
        engineOpts, periodsPerYear: msg.periodsPerYear || 252,
        onWindow: (w, n) => self.postMessage({ type: 'progress', job: 'walkforward', done: n, total: msg.totalWindows || 0, window: slimWindow(w) })
      });
      self.postMessage({
        type: 'result', job: 'walkforward',
        summary: res.summary || null, error: res.error || null,
        drift: res.drift || {},
        windows: (res.windows || []).map(slimWindow),
        combinedEquity: res.combinedEquity || []
      });
      return;
    }

    self.postMessage({ type: 'error', error: `未知任务 ${msg.job}` });
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err && err.message || err) });
  }
};

function slim(m) {
  if (!m) return null;
  return { totalReturn: m.totalReturn, annualReturn: m.annualReturn, sharpe: m.sharpe, calmar: m.calmar,
           maxDDPct: m.maxDDPct, winRate: m.winRate, payoffRatio: m.payoffRatio, trades: m.trades,
           finalEquity: m.finalEquity, ruined: m.ruined, expectancy: m.expectancy };
}

function slimWindow(w) {
  return {
    isDateFrom: w.isDateFrom, isDateTo: w.isDateTo, oosDateFrom: w.oosDateFrom, oosDateTo: w.oosDateTo,
    best: w.best, isScore: w.isScore, oosScore: w.oosScore, oosFactor: w.oosFactor,
    isMetrics: slim(w.isMetrics), oosMetrics: slim(w.oosMetrics)
  };
}
