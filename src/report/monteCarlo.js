/**
 * 蒙特卡洛、参数矩阵热图、成本敏感性（把闭源软件里那几个"吃进来"的功能补上）。
 *
 * 为什么是这三件：
 *   1. 蒙特卡洛 —— 回测给的是**唯一一条**权益曲线，而这条曲线里最不该相信的就是"顺序"。
 *      同样这 40 笔交易，连着亏的那几笔排在前面，最大回撤能比现实大一倍。
 *      重排之后看回撤分布，才知道"历史最大回撤 18%"到底是 P50 还是 P95。
 *   2. 参数热图 —— 一维列表看不出"参数高原"。两个维度摊成一张表，
 *      最优格周围如果是一片红，那组参数才站得住（矩阵优化是 MultiCharts/TB 的标配）。
 *   3. 成本敏感性 —— 趋势策略的手续费+滑点常常吃掉一半毛利。反过来问更有力：
 *      "滑点加到几个点我就不赚钱了？" 这个数比 Sharpe 更能说明策略能不能实盘。
 *
 * 全部纯函数，随机一律走 core/rng.js 的可复现序列：结果要能被别人按同一个种子复算出来。
 */

import { makeRng, shuffled, bootstrap, between } from '../core/rng.js';
import { runOne } from './optimizer.js';
import { rulesFor } from '../markets/marketRules.js';

const round2 = (v) => Math.round(v * 100) / 100;

/** 已排序数组的线性插值分位数。p 用 0~1。 */
export function percentile(sorted, p) {
  const a = sorted || [];
  if (!a.length) return null;
  if (a.length === 1) return a[0];
  const pos = Math.max(0, Math.min(1, p)) * (a.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

const qset = (arr) => {
  const s = (arr || []).slice().sort((x, y) => x - y);
  return { p5: percentile(s, 0.05), p25: percentile(s, 0.25), p50: percentile(s, 0.5),
           p75: percentile(s, 0.75), p95: percentile(s, 0.95),
           mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null,
           min: s[0] ?? null, max: s[s.length - 1] ?? null };
};

/** 按一条 pnl 序列走出权益路径，返回这条路径自己的风险统计。 */
function pathStats(pnls, { capital, ruinPct }) {
  let equity = capital, peak = capital, maxDD = 0, minEquity = capital;
  let underwater = 0, worstUnderwater = 0, lossRun = 0, worstLossRun = 0;
  const curve = [capital];
  for (const v of pnls) {
    equity += v;
    curve.push(equity);
    if (equity > peak) { peak = equity; underwater = 0; } else { underwater++; worstUnderwater = Math.max(worstUnderwater, underwater); }
    if (v <= 0) { lossRun++; worstLossRun = Math.max(worstLossRun, lossRun); } else lossRun = 0;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
    if (equity < minEquity) minEquity = equity;
  }
  const ruinLine = capital * (1 - ruinPct);
  return {
    endEquity: equity, maxDD, maxDDPct: peak > 0 ? maxDD / peak : 0,
    minEquity, worstUnderwater, worstLossRun,
    ruined: minEquity <= ruinLine, hitZero: minEquity <= 0,
    curve
  };
}

/**
 * 交易序列的蒙特卡洛重放。
 *
 * @param {Array<{netPnL:number}>} trades 引擎产出的成交（用净盈亏，含手续费）
 * @param {Object} o {runs, seed, mode:'sequence'|'bootstrap'|'noise', capital, ruinPct,
 *                   noisePct, keepBands}
 *  - sequence  ：无重复地重排原有交易 —— 只回答"顺序换一下会怎样"，不引入新信息。
 *  - bootstrap ：有放回抽样 —— 有些交易被抽中两次、有些一次没有。这是更保守的版本，
 *                它同时在问"这批样本如果本来就不齐全呢"。
 *  - noise     ：保持顺序，给每笔净盈亏一个乘性扰动（执行误差/滑点差异的粗略代理）。
 * @returns 回撤/期末权益/水下长度的分位分布 + 破产概率 + 实际路径对照。
 */
export function simulatePaths(trades, o = {}) {
  const opts = { runs: 500, seed: 20240101, mode: 'sequence', capital: 100000,
                 ruinPct: 0.5, noisePct: 0.2, keepBands: true, ...o };
  const list = (trades || []).filter(t => t && Number.isFinite(t.netPnL));
  const n = list.length;
  // 3 笔交易做重排只能得出 6 种顺序 —— 那不叫分布，叫列举。设个下限比给个假统计诚实。
  if (n < 8) return { error: `成交只有 ${n} 笔，蒙特卡洛至少要 8 笔才有意义（少于这个数的"分布"是编出来的）` };

  const pnls = list.map(t => t.netPnL);
  const actual = pathStats(pnls, { capital: opts.capital, ruinPct: opts.ruinPct });
  const rng = makeRng(opts.seed);
  const runs = Math.max(1, Math.min(20000, Math.round(opts.runs)));

  const dds = [], ends = [], mins = [], uws = [], lossRuns = [];
  let ruined = 0, hitZero = 0;
  const wantBands = opts.keepBands && runs * (n + 1) <= 500_000;
  const bands = wantBands ? Array.from({ length: n + 1 }, () => new Float64Array(runs)) : null;

  for (let r = 0; r < runs; r++) {
    let seq;
    if (opts.mode === 'bootstrap') seq = bootstrap(pnls, rng);
    else if (opts.mode === 'noise') seq = pnls.map(v => v * (1 + between(rng, -opts.noisePct, opts.noisePct)));
    else seq = shuffled(pnls, rng);
    const st = pathStats(seq, { capital: opts.capital, ruinPct: opts.ruinPct });
    dds.push(st.maxDD); ends.push(st.endEquity); mins.push(st.minEquity);
    uws.push(st.worstUnderwater); lossRuns.push(st.worstLossRun);
    if (st.ruined) ruined++;
    if (st.hitZero) hitZero++;
    if (bands) for (let i = 0; i <= n; i++) bands[i][r] = st.curve[i];
  }

  const bandOut = bands ? (() => {
    const step = Math.max(1, Math.ceil(bands.length / 120));         // 采样到最多 120 列，够画了
    const steps = [], p5 = [], p50 = [], p95 = [];
    for (let i = 0; i < bands.length; i += step) {
      const col = Array.from(bands[i]).sort((a, b) => a - b);
      steps.push(i); p5.push(percentile(col, 0.05)); p50.push(percentile(col, 0.5)); p95.push(percentile(col, 0.95));
    }
    if (steps[steps.length - 1] !== bands.length - 1) {
      const col = Array.from(bands[bands.length - 1]).sort((a, b) => a - b);
      steps.push(bands.length - 1); p5.push(percentile(col, 0.05)); p50.push(percentile(col, 0.5)); p95.push(percentile(col, 0.95));
    }
    return { steps, p5, p50, p95 };
  })() : null;

  const ddSorted = dds.slice().sort((a, b) => a - b);
  // 「历史那条回撤排在什么位置」是一个**概率**（有多少比例的重放比它更差），
  // 不是回撤数列上的某个分位数值 —— 前者能直接读成"这次是 P 分位"，后者会把 0.85 变成 85 万。
  const actualPctile = ddSorted.length ? ddSorted.filter(v => v <= actual.maxDD).length / ddSorted.length : null;
  return {
    mode: opts.mode, runs, seed: opts.seed, trades: n, capital: opts.capital,
    ruinPct: opts.ruinPct, noisePct: opts.noisePct,
    actual: { maxDD: round2(actual.maxDD), maxDDPct: actual.maxDDPct, endEquity: round2(actual.endEquity),
              worstUnderwater: actual.worstUnderwater, worstLossRun: actual.worstLossRun,
              curve: actual.curve.map(v => round2(v)) },
    drawdown: { ...qset(dds), actualPctile },
    endEquity: qset(ends),
    minEquity: qset(mins),
    underwaterBars: qset(uws),
    maxConsecutiveLosses: qset(lossRuns),
    ruin: { risk: ruined / runs, riskHitZero: hitZero / runs, threshold: round2(opts.capital * (1 - opts.ruinPct)), ruined: ruined, runs },
    bands: bandOut,
    note: opts.mode === 'bootstrap'
      ? '有放回抽样：同一笔可能被抽中两次、也可能一次都没有。它同时在问"样本本来不全时会怎样"，比单纯重排更保守。'
      : opts.mode === 'noise'
        ? `保持原顺序，每笔净盈亏叠加 ±${(opts.noisePct * 100).toFixed(0)}% 的乘性扰动，作为执行误差的粗略代理。`
        : '只重排原有交易的顺序，不引入任何新数据 —— 回答的是"这笔盈亏序列换个先来顺序会怎样"。'
  };
}

/** 各维度在结果里出现过多少个不同取值 —— 只有一档的维度不值得当行列。 */
function dimVariants(rows) {
  const map = new Map();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.params || {})) {
      if (!map.has(k)) map.set(k, new Set());
      map.get(k).add(String(v));
    }
  }
  return [...map.entries()].map(([k, s]) => ({ k, n: s.size })).sort((a, b) => b.n - a.n || a.k.localeCompare(b.k));
}

/**
 * 参数矩阵热图：把寻优结果按两个维度摊成二维表，其余维度取该格的最优。
 *
 * 默认挑"变化最多的两维"而不是参数表里的头两维 —— 后者常常是没进网格的固定参数，
 * 摊出来是 1×1 的格子，看着像热图其实什么信息都没有。
 *
 * 结果是**边缘最优**，不是联合最优的切片 —— 表里每个格都是"其他参数随便挑，挑到最好"的成绩。
 * 这句话必须写在返回值里：不然用户会把一张乐观值的热图当成稳健性证据。
 */
export function parameterHeatmap(rows, { xDim, yDim, scoreKey = 'score' } = {}) {
  const list = rows || [];
  if (!list.length) return { error: '还没有寻优结果：先在「参数寻优」跑一轮' };
  const variants = dimVariants(list);
  const dims = variants.map(v => v.k);
  const swept = variants.filter(v => v.n > 1).map(v => v.k);
  const usable = (d) => d && dims.includes(d) ? d : null;
  const x = usable(xDim) || swept[0] || dims[0];
  // 只从"真正在变"的维度里挑第二维：拿一个恒定参数当行列会得到 3×1 的假矩阵，
  // 看着像热图、其实只有一维在被扫，不如直接说清楚。
  const y = (usable(yDim) && yDim !== x) ? yDim : (swept.find(k => k !== x) || null);
  if (!y) return { error: '只有一个参数维度在变化，摊不成矩阵：把网格再加一维（如 stopAtr: 0,2,3）才看得到高原与孤峰', dims, x, sweptDims: swept };
  const xVals = [...new Set(list.map(r => r.params[x]))].sort((a, b) => (typeof a === 'number' ? a - b : String(a).localeCompare(String(b))));
  const yVals = [...new Set(list.map(r => r.params[y]))].sort((a, b) => (typeof a === 'number' ? a - b : String(a).localeCompare(String(b))));
  const xi = new Map(xVals.map((v, i) => [String(v), i]));
  const yi = new Map(yVals.map((v, i) => [String(v), i]));
  const cells = yVals.map(() => xVals.map(() => ({ score: null, n: 0, params: null })));
  let best = null;
  for (const r of list) {
    const i = xi.get(String(r.params[x])), j = yi.get(String(r.params[y]));
    if (i === undefined || j === undefined) continue;
    const c = cells[j][i];
    c.n++;
    const s = r[scoreKey];
    if (Number.isFinite(s) && (c.score === null || s > c.score)) { c.score = s; c.params = r.params; c.rank = r.rank; c.metrics = r.metrics; }
  }
  for (let j = 0; j < yVals.length; j++) for (let i = 0; i < xVals.length; i++) {
    const c = cells[j][i];
    if (Number.isFinite(c.score) && (!best || c.score > best.score)) best = { ...c, x: xVals[i], y: yVals[j], i, j };
  }
  // 高原判定：最优格周围（含对角）有多少格成绩不低于它的 60%。
  // 孤峰 = 邻格大面积塌掉，这种"第一名"是拟合噪声。
  let plateau = null;
  if (best) {
    // 阈值不能跟分数的正负号耦合：老口径 best*0.6 在最优值为负时方向整个反过来
    // （-2 的 60% 是 -1.2，比最优还好的 -1.5 反倒被判成"塌掉"）。
    // 改用整张图的跨度做尺子：邻格要落在最优值 40% 跨度以内才算活着。
    const pool = cells.flat().map(c => c.score).filter(Number.isFinite);
    const span = pool.length ? Math.max(...pool) - Math.min(...pool) : 0;
    const thr = span > 0 ? best.score - 0.4 * span : best.score;
    let alive = 0, total = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ii = best.i + di, jj = best.j + dj;
      if (ii < 0 || jj < 0 || ii >= xVals.length || jj >= yVals.length) continue;
      total++;
      const s = cells[jj][ii].score;
      if (Number.isFinite(s) && s >= thr) alive++;
    }
    plateau = total ? { alive, total, ratio: alive / total, thr, span,
                        verdict: alive / total < 0.5 ? '孤峰嫌疑：邻格大面积塌掉' : '邻格基本存活，参数落在高原上' } : null;
  }
  const covered = cells.flat().filter(c => c.n).length;
  const holes = xVals.length * yVals.length - covered;
  // 所有格子的成绩一模一样 = 这两个参数在这段行情上根本不起作用（常见于单边流畅行情：
  // 突破窗口从 20 改到 55 都只在同一根进场）。不指出来的话，用户会以为"参数很稳健"。
  const finiteScores = [...new Set(cells.flat().map(c => c.score).filter(Number.isFinite))];
  const flat = finiteScores.length <= 1;
  return {
    xDim: x, yDim: y, xVals, yVals, cells, best, plateau, scoreKey, flat,
    sweptDims: swept, fixedDims: dims.filter(k => !swept.includes(k)),
    note: `其余 ${Math.max(0, dims.length - 2)} 个维度按"该格取最优"聚合，这是**边缘最优**而不是联合最优切片，读图时别当成稳健性证明。`
      + (holes > 0 ? ` 另有 ${holes} 个格子没有样本（网格里没扫到），空白不等于差。` : '')
      + (flat ? ' 本图各格成绩完全相同：这两维在所选数据上没起作用，谈不上稳健也不危险。' : ''),
    emptyCells: holes
  };
}

/** 手续费/平今费按比例缩放（返回新的 spec，不改原来的）。 */
function scaledSpec(spec, feeMult) {
  const s = { ...spec };
  const scale = (plan) => (!plan ? plan : { ...plan, value: plan.value * feeMult });
  if (s.fee) s.fee = scale(s.fee);
  if (s.closeTodayFee) s.closeTodayFee = scale(s.closeTodayFee);
  if (s.stampTax) s.stampTax = scale(s.stampTax);
  if (s.transferFee) s.transferFee = scale(s.transferFee);
  if (s.minFee) s.minFee = s.minFee * feeMult;
  return s;
}

export const DEFAULT_COST_SCENARIOS = [
  { label: '零成本（看毛利）', feeMult: 0, slipTicks: 0 },
  { label: '成本 ×1（基准）', feeMult: 1, slipTicks: null },
  { label: '手续费 ×2', feeMult: 2, slipTicks: null },
  { label: '滑点 ×2', feeMult: 1, slipTicks: 'double' },
  { label: '滑点 ×4', feeMult: 1, slipTicks: 'quad' },
  { label: '双打（费 ×2 + 滑 ×2）', feeMult: 2, slipTicks: 'double' }
];
/**
 * 成本敏感性：同一套信号，把手续费和滑点放大若干倍重跑。
 *
 * `slipTicks: null` 表示沿用面板里那个值（基准那一档就是"你实际会付的成本"）。
 * 'double'/'quad' 是相对基准的倍数 —— 绝对 tick 数在 1 元和 4000 元的品种上完全不是一个量级，
 * 用倍数才能横着比。
 */
export function costStress({ bars, spec, strategy, params, engineOpts, scenarios = DEFAULT_COST_SCENARIOS,
                             periodsPerYear = 252 }) {
  const baseSlip = Number(engineOpts?.slippageTicks ?? 1);
  const rows = [];
  for (const sc of scenarios) {
    const slip = sc.slipTicks === 'double' ? baseSlip * 2
      : sc.slipTicks === 'quad' ? baseSlip * 4
        : sc.slipTicks === null || sc.slipTicks === undefined ? baseSlip : sc.slipTicks;
    const sp = scaledSpec(spec, sc.feeMult ?? 1);
    // rules 里封着 spec（成本模型走 rules.cost），换了 spec 必须把 rules 一起换掉，
    // 否则手续费缩放根本不生效；也不能直接丢掉 rules —— 那等于把 T+1 和板锁一起丢了，
    // 各档之间就不再可比。
    const opts = { ...(engineOpts || {}), slippageTicks: slip };
    if (engineOpts?.rules) opts.rules = rulesFor(sp);
    let res;
    try {
      res = runOne({ bars, spec: sp, strategy, params, engineOpts: opts, periodsPerYear });
    } catch (e) {
      rows.push({ label: sc.label, error: e.message });
      continue;
    }
    const m = res.metrics;
    rows.push({
      label: sc.label, feeMult: sc.feeMult ?? 1, slipTicks: slip,
      totalReturn: m.totalReturn, annualReturn: m.annualReturn, sharpe: m.sharpe,
      maxDDPct: m.maxDDPct, trades: m.trades, winRate: m.winRate,
      fees: m.totalFees, netPnL: m.finalEquity - m.capital, ruined: m.ruined,
      // 毛利 = 净盈亏 + 成本：成本吃掉毛利的比例才是"这策略能不能实盘"的那个数
      grossPnL: (m.finalEquity - m.capital) + m.totalFees,
      costShare: m.totalFees > 0 && (m.finalEquity - m.capital) + m.totalFees !== 0
        ? m.totalFees / Math.abs((m.finalEquity - m.capital) + m.totalFees) : null
    });
  }
  const base = rows.find(r => r.feeMult === 1 && r.slipTicks === baseSlip) || rows[1] || rows[0];
  // 盈亏平衡滑点：把滑点一档档加上去，最后一档还能赚钱的 tick 数。
  let ladder = null;
  if (base && !base.error) {
    const ticks = [];
    for (let t = 0; t <= Math.max(8, baseSlip * 8); t += 0.5) ticks.push(t);
    let lastOk = null, firstBad = null, prev = null;
    for (const t of ticks) {
      const sp = scaledSpec(spec, 1);
      const lo = { ...(engineOpts || {}), slippageTicks: t };
      if (engineOpts?.rules) lo.rules = rulesFor(sp);
      const res = runOne({ bars, spec: sp, strategy, params, engineOpts: lo, periodsPerYear });
      const pnl = res.metrics.finalEquity - res.metrics.capital;
      if (pnl > 0) lastOk = { ticks: t, pnl, sharpe: res.metrics.sharpe };
      else { firstBad = { ticks: t, pnl }; break; }
      prev = t;
    }
    ladder = { lastOk, firstBad, maxScanned: ticks[ticks.length - 1], note: firstBad
      ? `滑点到 ${firstBad.ticks} 个 tick 就转亏（上一档 ${prev ?? 0} 还赚 ${Math.round(lastOk?.pnl ?? 0)}）。实盘滑点只要接近这个数，这套参数就没有边际。`
      : `扫到上界 ${ticks[ticks.length - 1]} 个 tick 仍然盈利（赚 ${Math.round(lastOk?.pnl ?? 0)}）—— 成本边际很宽，但也只是说"没扫到转折点"。` };
  }
  return { rows, baseSlip, ladder, note: '滑点用「相对基准的倍数」而不是绝对点数：1 个 tick 在 1 元品种和 4000 元品种上不是一个量级。' };
}
