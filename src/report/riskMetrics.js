/**
 * 风险度量引擎：三模态 VaR / CVaR + 期货账户风险度（架构白皮书 §2.4.2）。
 *
 * 只报最大回撤和夏普的报表在机构风控眼里是不及格的：回撤是**事后**数字，
 * VaR 回答的是**事前**问题——"按当前策略的收益分布，明天有 1% 的概率亏掉多少以上"。
 * 三种算法必须同时给，因为它们各看分布的不同侧面，且互相校验：
 *
 *   参数法（Cornish-Fisher）—— 用均值/方差/偏度/峰度四个矩解析求分位数。
 *     优点是样本需求最低、能外推到样本没出现过的尾部；缺点是 A 股收益的尖峰厚尾
 *     远超四阶矩能表达的，极端分位常被低估。
 *   历史模拟 —— 直接取经验分位数，不做任何分布假设。
 *     优点是真实反映已发生过的尾部；缺点是样本外的黑天鹅（2015 式千股跌停）
 *     只在它发生过之后才会出现在窗口里，且样本少时分位数噪声极大。
 *   蒙特卡洛（EWMA 滤波 bootstrap）—— 用 EWMA(λ=0.94) 波动率把收益标准化成残差，
 *     再对残差做有放回抽样、逐日复利累计。波动率聚集（大波动跟大波动）被保留了，
 *     这是前两种都做不到的。GARCH 全 MLE 需要数值优化器，这里用 RiskMetrics 的
 *     固定 λ 口径替代——单参数、无收敛问题，且是业界沿用三十年的标准做法。
 *
 * 全部纯函数：输入收益序列（或权益曲线），输出数字。同种子可复现。
 */

import { returnMoments, normInv, returnsFromEquity } from '../validation/statTests.js';
import { makeRng } from '../core/rng.js';

/** 分位数（线性插值）。空序列/超界 p 返回 null，不假装 0。 */
export function quantile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  if (!(p >= 0 && p <= 1)) return null;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Cornish-Fisher 展开的修正 z 值：
 *   z_cf = z + (z²-1)S/6 + (z³-3z)(K-3)/24 - (2z³-5z)S²/36
 * K 是**非超额**峰度（与 returnMoments 的约定一致，正态=3）。左尾厚（S>0、K>3）时
 * z_cf 比 z 更负 → VaR 更大，这正是"厚尾要多吃资本"的解析表达。
 */
export function cornishFisherZ(z, skew, kurt) {
  const S = skew, Kx = kurt - 3;
  return z + (z * z - 1) * S / 6 + (z * z * z - 3 * z) * Kx / 24 - (2 * z * z * z - 5 * z) * S * S / 36;
}

/**
 * 参数法 VaR。horizon>1 时按 √h 缩放——这只在收益 iid 近似成立时合法，
 * 波动率聚集会让它低估多日风险，所以结果里带 scalingNote 让调用方别拿它当真理。
 */
export function parametricVaR(returns, { alpha = 0.95, horizon = 1 } = {}) {
  const m = returnMoments(returns);
  if (m.mean === null || !(m.sd > 0)) return { var: null, cvar: null, z: null, zCf: null, note: '样本不足或波动为 0，无法估参数法 VaR' };
  const z = normInv(1 - alpha);
  const zCf = cornishFisherZ(z, m.skew, m.kurt);
  const h = Math.max(1, horizon);
  const mu = m.mean * h, sd = m.sd * Math.sqrt(h);
  const v = -(mu + sd * zCf);
  // CVaR 参数法没有简洁闭式（要积正态的截尾矩），这里用同一修正分布的期望超出：
  // 以 zCf 截断、按正态算尾部期望 E[X | X < zCf]·sd + mu。给出值但标注是近似。
  const tailMean = normalTailMean(zCf);
  const cvar = -(mu + sd * tailMean);
  return {
    var: v, cvar, z, zCf,
    skew: m.skew, kurt: m.kurt, n: m.n,
    scalingNote: h > 1 ? '√h 缩放假设收益独立同分布；波动率聚集会低估多日风险' : null
  };
}

/** 标准正态在截断点 z 左侧的条件期望 E[Z | Z < z] = −φ(z)/Φ(z)（z<0 时为负数）。 */
function normalTailMean(z) {
  // φ(z) 用与 statTests 一致的直接公式；Φ(z) 用 erf 近似（复用 normCdf 精度足够）
  const phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cdf = 0.5 * (1 + erfApprox(z / Math.SQRT2));
  return cdf > 1e-12 ? -phi / cdf : 0;
}

function erfApprox(x) {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - y : y - 1;
}

/**
 * 历史模拟 VaR / CVaR。CVaR = 超出 VaR 的损失的条件均值（含 VaR 那一点本身，
 * Rockafellar-Uryasev 口径），这是尾部期望而不是"第二个分位数"。
 */
export function historicalVaR(returns, { alpha = 0.95, horizon = 1 } = {}) {
  const xs = (returns || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length < 10) return { var: null, cvar: null, n: xs.length, note: '历史模拟至少需要 10 个样本' };
  const q = quantile(xs, 1 - alpha);
  if (q === null) return { var: null, cvar: null, n: xs.length };
  const tail = xs.filter(x => x <= q);
  const cvar = tail.length ? -tail.reduce((a, b) => a + b, 0) / tail.length : -q;
  const h = Math.max(1, horizon);
  return {
    var: -q * Math.sqrt(h), cvar: cvar * Math.sqrt(h), n: xs.length,
    worst: -xs[0],
    scalingNote: h > 1 ? '√h 缩放假设收益独立同分布；波动率聚集会低估多日风险' : null
  };
}

/**
 * EWMA 滤波 bootstrap 蒙特卡洛 VaR。
 *
 * 流程：σ²_t = λσ²_{t-1} + (1-λ)r²_{t-1}（RiskMetrics 初始化 σ₀=全样本方差）
 *   → 残差 z_t = r_t/σ_t → 未来 h 天：每天抽一个残差、按当时的 EWMA 波动缩放、复利累计
 *   → 得到 h 日收益分布 → 取分位。波动率用"最后一天的 EWMA"外推（均值回复没有建模，
 *   对 1-10 日风险尺度是可接受的近似，注释说明而不是假装这是 GARCH）。
 */
export function monteCarloVaR(returns, { alpha = 0.95, horizon = 1, sims = 10000, lambda = 0.94, seed = 42 } = {}) {
  const xs = (returns || []).filter(Number.isFinite);
  if (xs.length < 30) return { var: null, cvar: null, sims: 0, note: '蒙特卡洛至少需要 30 个样本' };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance0 = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1);
  if (!(variance0 > 0)) return { var: null, cvar: null, sims: 0, note: '方差为 0' };

  // 递推 EWMA 波动率与标准化残差
  const residuals = new Array(xs.length);
  let v = variance0;
  for (let i = 0; i < xs.length; i++) {
    residuals[i] = xs[i] / Math.sqrt(v);
    v = lambda * v + (1 - lambda) * xs[i] * xs[i];
  }
  const sigmaNow = Math.sqrt(v);   // 最后一天的 EWMA 波动，往前外推

  const rng = makeRng(seed);
  const h = Math.max(1, Math.round(horizon));
  const paths = new Array(sims);
  for (let s = 0; s < sims; s++) {
    let logRet = 0;
    for (let d = 0; d < h; d++) {
      const z = residuals[Math.floor(rng() * residuals.length)];
      // 极端残差 × 高波动可能把日收益打到 ≤ −100%，log 无定义。截到 −99%：
      // 这是「爆仓归零」的近似，比 NaN 传染整条路径强。
      logRet += Math.log(Math.max(0.01, 1 + sigmaNow * z));
    }
    paths[s] = Math.exp(logRet) - 1;
  }
  paths.sort((a, b) => a - b);
  const q = quantile(paths, 1 - alpha);
  const tail = paths.filter(x => x <= q);
  return {
    var: -q, cvar: tail.length ? -tail.reduce((a, b) => a + b, 0) / tail.length : -q,
    sims, horizon: h, lambda, sigmaDaily: sigmaNow,
    note: 'EWMA(λ=0.94) 滤波 bootstrap，未建模波动率均值回复'
  };
}

/**
 * 三模态汇总：一次给齐三种口径的 VaR/CVaR，互相校验。
 * 三者差距本身就是信息：参数法 ≪ 历史法 → 分布厚尾超出矩的刻画能力，要相信历史法。
 */
export function varSuite(returns, { alpha = 0.95, horizon = 1, sims = 10000, seed = 42 } = {}) {
  return {
    alpha, horizon,
    parametric: parametricVaR(returns, { alpha, horizon }),
    historical: historicalVaR(returns, { alpha, horizon }),
    monteCarlo: monteCarloVaR(returns, { alpha, horizon, sims, seed })
  };
}

/**
 * 期货账户风险度监控（架构白皮书 §2.4.2 的 Margin-to-Equity / 追保概率）。
 *
 * equityCurve 每点必须有 {equity, margin}（单引擎与组合引擎都已有）。
 *   风险度 = 保证金占用 / 权益。>100% 意味着亏损已经吃进保证金之外的钱。
 *   追保 = 权益 < 占用保证金（可用资金为负）—— 真实柜台这时候发追保通知。
 *   强平距离 = (权益 - 维持保证金) / 权益，维持保证金 = 占用 × maintRatio。
 */
export function marginRisk(equityCurve, { maintRatio = 0.75, warnRatio = 1.0 } = {}) {
  const pts = (equityCurve || []).filter(p => p && Number.isFinite(p.equity));
  const withMargin = pts.filter(p => Number.isFinite(p.margin) && p.margin > 0);
  if (!withMargin.length) return { usable: false, note: '权益曲线无保证金数据（无杠杆品种或未持仓）' };
  const inPos = withMargin.filter(p => p.inPosition);
  const ratios = inPos.map(p => p.margin / p.equity).filter(Number.isFinite);
  if (!ratios.length) return { usable: false, note: '整段回测没有持仓，无风险度可算' };
  ratios.sort((a, b) => a - b);

  let marginCallDays = 0, liquidationGapMin = Infinity, worstDate = null, worstRatio = 0;
  for (const p of inPos) {
    const r = p.margin / p.equity;
    if (r > worstRatio) { worstRatio = r; worstDate = p.date; }
    if (p.equity < p.margin * warnRatio) marginCallDays++;
    const maint = p.margin * maintRatio;
    const gap = p.equity > 0 ? (p.equity - maint) / p.equity : 0;
    if (gap < liquidationGapMin) liquidationGapMin = gap;
  }
  return {
    usable: true,
    avgRiskDeg: ratios.reduce((a, b) => a + b, 0) / ratios.length,
    maxRiskDeg: ratios[ratios.length - 1],
    p95RiskDeg: quantile(ratios, 0.95),
    worstDate,
    marginCallDays,                       // 可用资金为负（发追保通知）的持仓天数
    marginCallRatio: inPos.length ? marginCallDays / inPos.length : 0,
    liquidationGapMin: Number.isFinite(liquidationGapMin) ? liquidationGapMin : null,
    note: marginCallDays > 0 ? `有 ${marginCallDays} 天权益跌破占用保证金——真实柜台会发追保通知，强平只在一念之间`
      : (liquidationGapMin < 0.2 ? '强平距离曾逼近 20% 以内，仓位对黑天鹅没有缓冲' : null)
  };
}

/** 便利封装：从权益曲线出发一次算全（收益三模态 + 风险度）。 */
export function fullRiskReport(equityCurve, opts = {}) {
  const rets = returnsFromEquity(equityCurve || []);
  const periodsPerYear = opts.periodsPerYear ?? 252;
  const alpha = opts.alpha ?? 0.95, alpha99 = opts.alpha99 ?? 0.99;
  return {
    periodsPerYear,
    var95: varSuite(rets, { alpha, horizon: 1, sims: opts.sims, seed: opts.seed }),
    var99: varSuite(rets, { alpha: alpha99, horizon: 1, sims: opts.sims, seed: opts.seed }),
    // 10 日持有期：监管口径（巴塞尔市场风险框架要求 10 日 99%）
    var10d99: varSuite(rets, { alpha: alpha99, horizon: 10, sims: opts.sims, seed: opts.seed }),
    margin: marginRisk(equityCurve, opts)
  };
}
