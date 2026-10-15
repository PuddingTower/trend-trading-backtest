/**
 * 统计诚实套件 · 第一部分：概率与夏普的显著性。
 *
 * 为什么要它：网格寻优天然是"从 N 个候选里挑最好那个"，而 max-of-N 本身就是偏差。
 * 一个 200 格网格里挑出来的样本内 Sharpe，即便策略完全是噪声也一定好看。
 * 这三个量就是把"好看"换算成"可信"的：
 *   PSR   —— 给定基准夏普，实测夏普是真的更强的概率
 *   DSR   —— 把基准换成"N 次试验里最大者的期望"，也就是扣掉挑选偏差后的 PSR
 *   MinTRL —— 想以给定置信度认出这个夏普，至少要跑多长回测
 *
 * 三个最容易做错的地方，都在下面写死了：
 * 1. **喂 per-period 的 Sharpe，不是年化**。文献里的公式全部基于单期均值/标准差；
 *    把年化 0.8 当成 SR 代进去，DSR 会算出接近 1 的假自信。用 annualizeSharpe() 换算。
 * 2. **kurt 用非超额峰度**（正态=3）。公式项是 (γ4-1)/4，若传超额峰度（正态=0）会变成
 *    -0.25·SR² 这种方向都反了的修正。
 * 3. **N 是真实试验次数**，不是格子数。高度相关的邻格（slow=60 与 slow=62）算不到一次独立试验，
 *    所以 N 由 trialJournal 给有效试验数，而不是 plans.length。
 */

const SQRT2 = Math.SQRT2;
const EULER_GAMMA = 0.5772156649015329;

/** Abramowitz & Stegun 7.1.26：|误差| < 1.5e-7。够用，且不需要任何依赖。 */
export function erf(x) {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592)
    * t * Math.exp(-a * a);
  return s * y;
}

function pdf(z) { return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); }

/**
 * 标准正态分布函数。
 * 尾部（z>5）改用 Mills 展开：A-S 的 erf 绝对误差 1.5e-7，而 Q(5)≈2.9e-7，
 * 直接 1-Φ 会把尾概率算成 0 —— 报出"p<1e-300"这种假精确比不报更糟。
 */
export function normCdf(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  if (z > 5) return 1 - normUpperTail(z);
  return 0.5 * (1 + erf(z / SQRT2));
}

/** 上尾 Q(z)=1-Φ(z)，z>=0。Mills 比值三项展开，z=5 处相对误差约 1e-4 量级。 */
export function normUpperTail(z) {
  if (z < 0) return normCdf(z);
  if (z === 0) return 0.5;
  const inv = 1 / (z * z);
  return pdf(z) / z * (1 - inv + 3 * inv * inv);
}

/**
 * 标准正态分位数（逆 CDF）。Acklam 有理近似给初值，再用两次 Halley 修正。
 * p 必须严格在 (0,1)；端点返回 ±Infinity 而不是硬套一个大数。
 */
export function normInv(p) {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : (p === 1 ? Infinity : NaN);
  const a = [-3.969683028665376e+01, 2.209460756977612e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539320275e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754404259903238e+00];
  const pl = 0.02425;
  let q;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    q = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    q = p - 0.5;
    const r = q * q;
    q = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    q = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // Halley 修正：Φ⁻¹ 的近似式残差用 (Φ(q)-p)/φ(q) 再压一截。
  // 精度上限由上面的 normCdf 决定（|误差|≈1.5e-7），别对外宣称 1e-15。
  for (let i = 0; i < 2; i++) {
    const e = normCdf(q) - p;
    const u = pdf(q);
    if (!(u > 0)) break;
    q -= (e / u) / (1 + 0.5 * q * (e / u));
  }
  return q;
}

/**
 * 收益序列的矩。sd 用样本标准差（n-1），skew/kurt 用总体中心矩 ——
 * 这是刻意选的，并且写死在这里：文献里两套约定都有人用，同一份数据能差 10% 以上，
 * 换来换去会让"我的 DSR 和你的不一样"变成无法讨论的问题。
 * kurt 返回**非超额**峰度（正态 = 3）。
 */
export function returnMoments(returns) {
  const xs = (returns || []).filter(v => Number.isFinite(v));
  const n = xs.length;
  if (n < 3) return { n, mean: null, sd: null, skew: null, kurt: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const x of xs) { const d = x - mean, d2 = d * d; m2 += d2; m3 += d2 * d; m4 += d2 * d2; }
  const varPop = m2 / n;
  const sdSample = Math.sqrt(m2 / (n - 1));
  if (!(varPop > 0) || !(sdSample > 0)) return { n, mean, sd: 0, skew: 0, kurt: 0 };
  return {
    n, mean, sd: sdSample,
    skew: (m3 / n) / Math.pow(varPop, 1.5),
    kurt: (m4 / n) / (varPop * varPop)
  };
}

/** 单期（per-period）夏普：均值 ÷ 样本标准差。DSR/PSR/MinTRL 要的就是这个，不是年化值。 */
export function perPeriodSharpe(returns) {
  const m = returnMoments(returns);
  return m.sd && m.sd > 0 ? m.mean / m.sd : null;
}

export const annualizeSharpe = (srPerPeriod, periodsPerYear = 252) =>
  (Number.isFinite(srPerPeriod) ? srPerPeriod * Math.sqrt(periodsPerYear) : null);

/**
 * Probabilistic Sharpe Ratio（Bailey & López de Prado, JPM 2014）。
 * PSR = Φ( (SR̂ - SR*)·√(T-1) / √(1 - γ3·SR̂ + ((γ4-1)/4)·SR̂²) )
 * @param {number} sr 单期夏普
 * @param {number} T  观测根数（不是年数）
 */
export function psr({ sr, T, skew = 0, kurt = 3, srStar = 0 }) {
  if (!Number.isFinite(sr) || !(T > 2)) return null;
  const kk = Number.isFinite(kurt) ? kurt : 3;
  const sk = Number.isFinite(skew) ? skew : 0;
  const inner = 1 - sk * sr + ((kk - 1) / 4) * sr * sr;
  if (!(inner > 0)) return null;      // 极端厚尾下修正项会翻负，宁可返回 null 也不给一个假概率
  return normCdf((sr - srStar) * Math.sqrt(T - 1) / Math.sqrt(inner));
}

/** PSR 反解：给定置信度要多少根 bar 才认得下这个夏普（J. Risk 2012 的 MinTRL）。 */
export function minBacktestLength({ sr, skew = 0, kurt = 3, alpha = 0.95 }) {
  if (!Number.isFinite(sr) || !(sr > 0)) return null;
  const z = normInv(alpha);
  const inner = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  if (!(inner > 0) || !(z > 0)) return null;
  return 1 + inner * Math.pow(z / sr, 2);
}

/**
 * N 个独立试验里最大者的期望夏普（闭式近似）。
 * E[max] ≈ SR̄ + σ_SR·[(1-γ)·Φ⁻¹(1-1/N) + γ·Φ⁻¹(1-1/(N·e))]，γ 为欧拉常数。
 * 已知偏差：N=2 时比真值低约 8%，N≥10 时进到 2% 以内 —— 所以别用它给"只试了 3 组"的结果撑腰，
 * 那种场景真值更接近直接拿最大值本身。
 */
export function expectedMaxSharpe({ srMean, srStd, nTrials }) {
  const N = Math.max(2, Math.round(nTrials || 0));
  if (!Number.isFinite(srMean) || !Number.isFinite(srStd)) return null;
  const g = EULER_GAMMA;
  return srMean + srStd * ((1 - g) * normInv(1 - 1 / N) + g * normInv(1 - 1 / (N * Math.E)));
}

/**
 * Deflated Sharpe Ratio：把 PSR 的基准从 0 换成"N 次试验最大者的期望"。
 * @param {Array} trials 每次试验的 {sr, skew, kurt, T}（单期口径）
 * @returns {{dsr, srBest, sr0Star, nTrials, effectiveTrials, bestSr, srSpread}} | null
 */
export function deflatedSharpe(trials, { nTrials = null } = {}) {
  const list = (trials || []).filter(t => t && Number.isFinite(t.sr));
  if (list.length < 2) return null;
  const srs = list.map(t => t.sr);
  const mm = returnMoments(srs);
  if (!mm.sd) return null;
  const nEff = Number.isFinite(nTrials) && nTrials > 0 ? nTrials : list.length;
  const best = list.reduce((a, b) => (b.sr > a.sr ? b : a), list[0]);
  const sr0 = expectedMaxSharpe({ srMean: mm.mean, srStd: mm.sd, nTrials: nEff });
  const p = psr({ sr: best.sr, T: best.T, skew: best.skew, kurt: best.kurt, srStar: sr0 });
  if (p === null) return null;
  return { dsr: p, sr0Star: sr0, bestSr: best.sr, nTrials: list.length, effectiveTrials: nEff,
    srMean: mm.mean, srSpread: mm.sd, T: best.T };
}

/** 从权益曲线取单期简单收益（与 metrics 的年化口径互不干扰，这里只要比值）。 */
export function returnsFromEquity(curve) {
  const out = [];
  const c = curve || [];
  for (let i = 1; i < c.length; i++) {
    const prev = c[i - 1] && c[i - 1].equity;
    const cur = c[i] && c[i].equity;
    if (!(prev > 0) || !Number.isFinite(cur)) continue;
    out.push(cur / prev - 1);
  }
  return out;
}
