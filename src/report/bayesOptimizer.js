/**
 * TPE 贝叶斯参数寻优 + 早停剪枝 + 参数平原推荐 + 帕累托前沿（架构白皮书 §2.3.2）。
 *
 * 网格搜索撞上 4 个连续参数就是维度灾难：每维 10 档 = 1 万次回测。TPE 的思路是
 * 把"哪个参数好"的建模反转过来 ——
 *   l(x) = 好参数组（分位 γ 以内）的分布，g(x) = 差参数组的分布，
 *   下一个候选从 l(x) 里抽 24 个、挑 l(x)/g(x) 最大的那个。
 * 直觉：在"好参数出现的地方"再找"差参数从不出现的地方"，一步一个信息量。
 *
 * 早停剪枝走的是**分阶段评估**：先只用前 preFraction 段 K 线跑预演，
 * 预演成绩低于已完成预演的中位数就放弃（很多参数不用跑完就能断定没戏），
 * 省下的算力给更多试验数。回测是一次整跑，做不到引擎级 mid-run 剪枝 ——
 * 这个口径如实写在这里，不假装实现了 Hyperband。
 *
 * 全程确定性：同 seed 同参数空间两次寻优逐位一致。
 */

import { runOne, OBJECTIVES } from './optimizer.js';
import { makeRng } from '../core/rng.js';

/**
 * 参数空间定义：{ name, type: 'int'|'float'|'choice', lo, hi, options, log }
 * log=true 时在 [lo,hi] 上对数均匀采样（ATR 倍数这类跨量级参数必须用它）。
 */
export function sampleParam(p, rng) {
  if (p.type === 'choice') {
    return p.options[Math.min(p.options.length - 1, Math.floor(rng() * p.options.length))];
  }
  const lo = Number(p.lo), hi = Number(p.hi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return lo;
  const u = rng();
  if (p.log) {
    const v = lo * Math.pow(hi / lo, u);
    return p.type === 'int' ? Math.max(1, Math.round(v)) : v;
  }
  const v = lo + u * (hi - lo);
  return p.type === 'int' ? Math.round(v) : v;
}

export function sampleSpace(space, rng) {
  const out = {};
  for (const p of space) out[p.name] = sampleParam(p, rng);
  return out;
}

/** 归一化到 [0,1]（数值型），choice 取名次 —— 供距离度量与 KDE 用。 */
function normalize(space) {
  const fn = {};
  for (const p of space) {
    if (p.type === 'choice') {
      const opts = p.options;
      fn[p.name] = (v) => Math.max(0, opts.indexOf(v)) / Math.max(1, opts.length - 1);
    } else if (p.log) {
      const lo = Math.log(Number(p.lo)), hi = Math.log(Number(p.hi));
      fn[p.name] = (v) => (Math.log(Math.max(v, 1e-12)) - lo) / (hi - lo);
    } else {
      const lo = Number(p.lo), hi = Number(p.hi);
      fn[p.name] = (v) => (v - lo) / (hi - lo);
    }
  }
  return fn;
}

/** 高斯核密度（对角独立）：给一组样本与带宽规则，返回 pdf 函数。 */
function kde1d(values, rng) {
  const n = values.length;
  if (!n) return () => 1;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, n - 1));
  // Scott 规则加下限：样本全相等时带宽不能是 0
  const bw = Math.max(sd * Math.pow(n, -0.2), 1e-3);
  return (x) => {
    let s = 0;
    for (const v of values) {
      const z = (x - v) / bw;
      s += Math.exp(-0.5 * z * z);
    }
    return s / (n * bw * Math.sqrt(2 * Math.PI)) + 1e-12;
  };
}

/**
 * TPE 采样器：给已评估的 trials（{params, score}），建议下一个参数组。
 * γ 分位取 min(0.25, 25/n)；候选 24 个来自 l(x)（15% 概率全范围探索防塌缩）。
 */
export function tpeSuggest({ space, trials, seed = 7, nCandidates = 24, exploreP = 0.15 }) {
  const rng = makeRng(seed);
  const norm = normalize(space);
  // 归一化逆映射：候选在 [0,1] 空间生成后再换回原始单位 —— KDE、抖动、打分
  // 必须在同一个坐标系里，混用原始值与归一化值会把比值排序搅乱。
  const denorm = {};
  for (const p of space) {
    if (p.type === 'choice') continue;
    if (p.log) {
      const lo = Math.log(Number(p.lo)), hi = Math.log(Number(p.hi));
      denorm[p.name] = (u) => {
        const v = Math.exp(lo + u * (hi - lo));
        return p.type === 'int' ? Math.max(1, Math.round(v)) : v;
      };
    } else {
      const lo = Number(p.lo), hi = Number(p.hi);
      denorm[p.name] = (u) => {
        const v = lo + u * (hi - lo);
        return p.type === 'int' ? Math.round(v) : v;
      };
    }
  }
  if (trials.length < 2 || space.length === 0) return sampleSpace(space, rng);
  const sorted = [...trials].sort((a, b) => b.score - a.score);
  const nGood = Math.max(1, Math.min(Math.ceil(sorted.length * 0.25), Math.floor(sorted.length / 2)));
  const good = sorted.slice(0, nGood);
  const bad = sorted.slice(nGood);
  const dists = { good: {}, bad: {} };
  for (const p of space) {
    if (p.type === 'choice') {
      const count = (list) => {
        const m = new Map(p.options.map(o => [o, 1]));   // +1 平滑
        for (const t of list) m.set(t.params[p.name], (m.get(t.params[p.name]) || 0) + 1);
        const s = [...m.values()].reduce((a, b) => a + b, 0);
        return { p: [...m.values()].map(v => v / s), m };
      };
      const g = count(good), b = count(bad);
      dists.good[p.name] = { type: 'cat', options: p.options, good: g, bad: b };
    } else {
      dists.good[p.name] = {
        type: 'num',
        kdeG: kde1d(good.map(t => norm[p.name](Number(t.params[p.name])))),
        kdeB: kde1d(bad.map(t => norm[p.name](Number(t.params[p.name])))),
        p
      };
    }
  }
  let best = null, bestRatio = -Infinity;
  for (let c = 0; c < nCandidates; c++) {
    // 15% 全范围探索：TPE 会过早收敛，留一条退路
    const cand = rng() < exploreP ? sampleSpace(space, rng) : {};
    for (const p of space) {
      if (cand[p.name] !== undefined) continue;
      const d = dists.good[p.name];
      if (d.type === 'cat') {
        // 按好组分布抽（l/g 比值隐含在"好组里常见"这个选择里）
        let u = rng();
        let pick = d.options[d.options.length - 1];
        for (let i = 0; i < d.options.length; i++) {
          u -= d.good.p[i];
          if (u <= 0) { pick = d.options[i]; break; }
        }
        cand[p.name] = pick;
      } else {
        // 在好组的归一化位置附近抖动：三均匀和近似高斯，带宽不超过区间的 10%
        const nx0 = norm[p.name](Number(good[Math.floor(rng() * good.length)].params[p.name]));
        const nx = Math.max(0, Math.min(1, nx0 + (rng() + rng() + rng() - 1.5) * 0.13));
        cand[p.name] = denorm[p.name](nx);
      }
    }
    // 打分：Π l/g（对数域求和防下溢），全部在归一化坐标上
    let logRatio = 0;
    for (const p of space) {
      const d = dists.good[p.name];
      const v = cand[p.name];
      if (d.type === 'cat') {
        const gi = (d.good.m.get(v) || 1) / good.length;
        const bi = (d.bad.m.get(v) || 1) / Math.max(1, bad.length);
        logRatio += Math.log(gi / bi);
      } else {
        const nx = norm[p.name](v);
        logRatio += Math.log(d.kdeG(nx) / d.kdeB(nx));
      }
    }
    if (logRatio > bestRatio) { bestRatio = logRatio; best = cand; }
  }
  return best || sampleSpace(space, rng);
}

/**
 * TPE 寻优器。evalFn 缺省是真实回测（runOne），测试与跨品种批量可以注入假函数。
 * 分块接口与 gridRunner 一致：step(k) 跑 k 个试验，UI 拿去喂进度条。
 */
export function tpeRunner({ bars, spec, strategy, space, baseParams = {}, objective = 'sharpe',
                            engineOpts = {}, periodsPerYear = 252, nTrials = 50, startup = 10,
                            seed = 7, preFraction = 0.4, prune = true, evalFn = null, onTrial = null }) {
  const obj = OBJECTIVES[objective] || OBJECTIVES.sharpe;
  const evalTrial = evalFn || ((params, barsSlice) => {
    const r = runOne({ bars: barsSlice, spec, strategy, params: { ...baseParams, ...params }, engineOpts, periodsPerYear });
    return { score: obj.get(r.metrics), metrics: r.metrics, trades: r.trades.length };
  });
  const preBars = prune && bars.length > 100 ? bars.slice(0, Math.max(60, Math.floor(bars.length * preFraction))) : null;
  const preScores = [];   // 只存预演分 —— 基线口径必须纯净，混入全量分中位数就失真了
  const trials = [];
  let i = 0;
  return {
    total: nTrials,
    space,
    objective,
    get progressed() { return i; },
    done: () => i >= nTrials,
    get trials() { return trials; },
    step(chunk = 5) {
      const out = [];
      for (let k = 0; k < chunk && i < nTrials; k++, i++) {
        // 剪枝试验的 score 是预演口径，与全量分不可比 —— 喂回 TPE 会把好坏分界搅乱，
        // 只让全量评估过的试验参与建议分布；剪枝的留在 trials 里作算力账本。
        const params = i < startup || trials.filter(t => !t.pruned).length < 2
          ? sampleSpace(space, makeRng(seed * 100003 + i))
          : tpeSuggest({ space, trials: trials.filter(t => !t.pruned), seed: seed * 100003 + i });
        // 阶段一：预演（startup 期也跑预演来建立基线，但不据此剪枝 —— 没有可比中位数）
        let preScore = null;
        if (preBars) preScore = evalTrial(params, preBars).score;
        let pruned = false;
        if (preBars && i >= startup && preScores.length >= 4 && Number.isFinite(preScore)) {
          const sortedPre = [...preScores].sort((a, b) => a - b);
          const median = sortedPre[Math.floor(sortedPre.length / 2)];
          pruned = preScore < median;
        }
        let result;
        if (pruned) {
          result = { params, score: preScore, metrics: null, trades: 0, pruned: true, trial: i };
        } else {
          const r = evalTrial(params, bars);
          result = { params, score: r.score, metrics: r.metrics ?? null, trades: r.trades ?? 0, pruned: false, trial: i };
          if (preBars && Number.isFinite(preScore)) preScores.push(preScore);
        }
        trials.push(result);
        if (onTrial) onTrial(result, i + 1);
        out.push(result);
      }
      return out;
    },
    finish() {
      while (!this.done()) this.step(8);
      return rankTpe(trials, obj);
    },
    rank: () => rankTpe(trials, obj)
  };
}

/** 排序：剪枝的沉底但不删除 —— 它们是"省了多少算力"的证据。 */
export function rankTpe(trials, obj) {
  const scored = trials
    .filter(t => Number.isFinite(t.score))
    .sort((a, b) => b.score - a.score)
    .map((t, i) => ({ ...t, rank: i + 1 }));
  const pruned = trials.filter(t => t.pruned).length;
  return {
    ranked: scored,
    best: scored[0] || null,
    pruned,
    evaluated: trials.length - pruned,
    savings: trials.length ? Math.round(pruned / trials.length * 100) : 0
  };
}

/**
 * 参数平原推荐：最优≠最稳。对每个已评估点，找归一化空间里最近的 k 个邻居，
 * 用「自身与邻居的均值分 − 半个邻居标准差」当稳健分 —— 孤峰的邻居全是大坑，
 * 平原中心的邻居跟它一样好。推荐稳健分最高者，同时报告孤峰风险。
 */
export function plateauRecommendation(ranked, space, { k = 6 } = {}) {
  if (!ranked || ranked.length < 4 || !space.length) return { best: ranked?.[0] ?? null, note: '试验数不足，无法评估平原' };
  const norm = normalize(space);
  const pts = ranked.filter(r => Number.isFinite(r.score));
  const dist = (a, b) => {
    let s = 0;
    for (const p of space) s += (norm[p.name](a.params[p.name]) - norm[p.name](b.params[p.name])) ** 2;
    return Math.sqrt(s);
  };
  let bestIdx = -1, bestPlateau = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const others = pts.map((p, j) => ({ j, d: dist(pts[i], p) })).filter(x => x.j !== i)
      .sort((a, b) => a.d - b.d).slice(0, k);
    if (!others.length) continue;
    const scores = others.map(o => pts[o.j].score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const sd = Math.sqrt(scores.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, scores.length - 1));
    const plateau = mean - 0.5 * sd;
    pts[i].plateauScore = plateau;
    pts[i].spikeRisk = pts[i].score !== 0 ? 1 - mean / pts[i].score : null;
    if (plateau > bestPlateau) { bestPlateau = plateau; bestIdx = i; }
  }
  return {
    recommended: bestIdx >= 0 ? pts[bestIdx] : null,
    byBestScore: pts[0] ?? null,
    note: bestIdx >= 0 && pts[0] && pts[bestIdx] !== pts[0] && Math.abs(pts[0].score - pts[bestIdx].score) < Math.abs(pts[0].score) * 0.2
      ? '最高分参数与平原中心成绩接近：选平原中心，实盘换一天的行情它还活着' : null
  };
}

/**
 * 多目标帕累托前沿。keys 里收益类求大，minKeys 里风险类求小。
 * 返回非支配集 + 拐点推荐（到理想点最近者），供"别只看收益率"的强制视角。
 */
export function paretoFront(ranked, { keys = ['score'], minKeys = [] } = {}) {
  const pts = (ranked || []).filter(r => Number.isFinite(r.score)).map(r => ({
    ref: r,
    vals: keys.map(k => Number(r.metrics?.[k] ?? r[k] ?? -Infinity)),
    mins: minKeys.map(k => Number(r.metrics?.[k] ?? r[k] ?? Infinity))
  })).filter(p => p.vals.every(Number.isFinite));
  if (pts.length < 2) return { front: pts.map(p => p.ref), knee: null, note: '可比较的点不足' };
  const dominated = (a, b) =>   // a 是否被 b 支配
    b.vals.every((v, i) => v >= a.vals[i]) && b.mins.every((v, i) => v <= a.mins[i]) &&
    (b.vals.some((v, i) => v > a.vals[i]) || b.mins.some((v, i) => v < a.mins[i]));
  const front = pts.filter((a, i) => !pts.some((b, j) => j !== i && dominated(a, b)));
  // 拐点：归一化后离理想点最近的。理想点必须同时含收益维与风险维 ——
  // 只看收益维的话拐点永远是最激进的那个点，"多目标"就成了摆设。
  const rangesV = keys.map((k, i) => {
    const vs = pts.map(p => p.vals[i]);
    return Math.max(...vs) - Math.min(...vs) || 1;
  });
  const rangesM = minKeys.map((k, i) => {
    const vs = pts.map(p => p.mins[i]);
    return Math.max(...vs) - Math.min(...vs) || 1;
  });
  const idealV = keys.map((k, i) => Math.max(...pts.map(p => p.vals[i])));
  const idealM = minKeys.map((k, i) => Math.min(...pts.map(p => p.mins[i])));
  let knee = null, bestD = Infinity;
  for (const p of front) {
    const d = Math.sqrt(
      p.vals.reduce((s, v, i) => s + ((idealV[i] - v) / rangesV[i]) ** 2, 0) +
      p.mins.reduce((s, v, i) => s + ((v - idealM[i]) / rangesM[i]) ** 2, 0));
    if (d < bestD) { bestD = d; knee = p.ref; }
  }
  return { front: front.map(p => p.ref), knee };
}
