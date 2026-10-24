/**
 * 组合优化器（架构白皮书 §2.3.1）：收缩协方差 + 六种机构级权重分配器。
 *
 * 逆波动率加权只回答"波动大的少配点"；它不看相关性——两个 0.95 相关的品种
 * 各配 50% 等于押了同一个头寸两次。真正意义上的"组合构建"要解的是：
 *
 *     min wᵀΣw   或   max μᵀw − (λ/2)wᵀΣw   s.t. Σw=1, 0≤w≤umax
 *
 * 但 Σ 的样本估计本身是个误差放大器（Markowitz 被戏称 error maximizer 的由来），
 * 所以上来先做 Ledoit-Wolf 收缩，把特征值里的噪声往结构化目标上压。
 *
 * 求解器选型说明（刻意不用 CVXPY 那类通用求解器——本项目零依赖）：
 *   凸二次 + 单纯形/箱约束 → 投影梯度下降（步长 1/L，投影用 τ-平移二分法）；
 *   ERC → Spinu (2013) 凸化 min ½wᵀΣw − (1/N)Σlog wᵢ 的逐坐标不动点迭代；
 *   CVaR 平价 → 历史尾部边际贡献的乘性更新（历史 CVaR 对 w 是分片线性，梯度几乎处处存在）。
 * 都是几十行可读代码，收敛性各自有文献背书，比塞一个通用求解器进来更可解释。
 */

/* ---------------- 线性代数小工具 ---------------- */

export function transpose(A) {
  return (A[0] || []).map((_, j) => A.map(row => row[j]));
}

export function matMul(A, B) {
  const Bt = transpose(B);
  return A.map(row => Bt.map(col => row.reduce((s, v, k) => s + v * col[k], 0)));
}

/** 高斯-约当消元求逆（带部分主元）。奇异矩阵返回 null，让调用方显式处理。 */
export function invertMatrix(A) {
  const n = A.length;
  if (!n || A.some(r => r.length !== n)) return null;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map(row => row.slice(n));
}

/** 样本协方差（总体口径除以 T，与大样本场景一致；输入为 T×N 收益矩阵）。 */
export function sampleCovariance(R) {
  const T = R.length, N = R[0]?.length ?? 0;
  if (T < 3 || N < 1) return null;
  const mean = Array.from({ length: N }, (_, j) => R.reduce((s, r) => s + r[j], 0) / T);
  const C = Array.from({ length: N }, () => new Array(N).fill(0));
  for (const r of R) {
    for (let i = 0; i < N; i++) {
      const di = r[i] - mean[i];
      for (let j = i; j < N; j++) C[i][j] += di * (r[j] - mean[j]);
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j <= i; j++) C[i][j] = C[j][i] = C[i][j] / T;
  return C;
}

export function correlationFromCov(C) {
  const n = C.length;
  const sd = C.map((row, i) => Math.sqrt(Math.max(row[i], 1e-18)));
  return C.map((row, i) => row.map((v, j) => v / (sd[i] * sd[j])));
}

/** 多列价格序列 → 对齐的简单收益矩阵（按最短序列截齐，缺值行丢弃）。 */
export function alignReturns(seriesList) {
  const list = (seriesList || []).map(s => (s || []).filter(Number.isFinite));
  if (list.length < 1) return [];
  const T = Math.min(...list.map(s => s.length));
  if (T < 3) return [];
  const R = [];
  for (let t = 1; t < T; t++) {
    const row = list.map(s => s[t] / s[t - 1] - 1);
    if (row.every(Number.isFinite)) R.push(row);
  }
  return R;
}

/* ---------------- Ledoit-Wolf 收缩 ---------------- */

/**
 * Ledoit-Wolf (2004) 单位阵目标收缩。
 * 收缩强度 = b²/d²：样本噪声越大（T 小、N 大、厚尾）强度越接近 1，
 * 极端情形整张 Σ 退化为"平均方差 × I"——宁要粗糙但稳定的估计，不要精细但错的。
 */
export function ledoitWolfShrinkage(R) {
  const T = R.length, N = R[0]?.length ?? 0;
  if (T < 3 || N < 1) return null;
  const mean = Array.from({ length: N }, (_, j) => R.reduce((s, r) => s + r[j], 0) / T);
  const X = R.map(r => r.map((v, j) => v - mean[j]));
  const S = sampleCovariance(R);
  if (!S) return null;
  const norm2 = (A) => A.reduce((s, row) => s + row.reduce((a, v) => a + v * v, 0), 0) / N;

  const m = S.reduce((s, row, i) => s + row[i], 0) / N;
  const d2 = norm2(S.map((row, i) => row.map((v, j) => v - (i === j ? m : 0))));
  // b̄² = (1/T²) Σ_t ||x_t x_tᵀ − S||²_norm —— 样本外波动的主导项
  let b2bar = 0;
  for (const xt of X) {
    const outer = xt.map(a => xt.map(b => a * b));
    b2bar += norm2(outer.map((row, i) => row.map((v, j) => v - S[i][j])));
  }
  b2bar /= T * T;
  const b2 = Math.min(b2bar, d2);
  const intensity = d2 > 0 ? b2 / d2 : 0;
  const shrunk = S.map((row, i) => row.map((v, j) => (1 - intensity) * v + intensity * (i === j ? m : 0)));
  return { cov: shrunk, sample: S, intensity, m, note: intensity > 0.9 ? '样本严重不足，协方差几乎全靠收缩目标撑着' : null };
}

/* ---------------- 投影梯度求解器 ---------------- */

/**
 * 投影到 {Σw=1, 0≤w≤umax}：找 τ 使 Σ clip(v_i − τ, 0, u) = 1，单调 → 二分。
 * 这是投影梯度法能处理箱约束的关键，比交替投影稳定得多。
 */
export function projectBoxSimplex(v, { sum = 1, max = 1 } = {}) {
  const u = Math.max(max, sum / v.length);
  const f = (tau) => v.reduce((s, x) => s + Math.min(u, Math.max(0, x - tau)), 0);
  let lo = Math.min(...v) - u - 1, hi = Math.max(...v);
  for (let k = 0; k < 100; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > sum) lo = mid; else hi = mid;
  }
  const tau = (lo + hi) / 2;
  return v.map(x => Math.min(u, Math.max(0, x - tau)));
}

/**
 * 通用投影梯度：min f(w) s.t. w ∈ 箱单纯形。f 梯度由 gradFn 给出。
 * 步长用回溯线搜索（给出 objFn 时）：目标不降就把步长砍半 —— MVO 在 λ 很大时
 * 梯度量级巨大，固定步长会在单纯形顶点之间永久振荡，回溯是让它落下来的唯一办法。
 */
function projectedGradient({ n, gradFn, objFn = null, maxWeight = 1, iters = 4000, tol = 1e-12 }) {
  let w = new Array(n).fill(1 / n);
  let step = 0.05;
  const obj = objFn ? (x) => objFn(x) : null;
  let curObj = obj ? obj(w) : null;
  let converged = false;
  for (let it = 0; it < iters; it++) {
    const g = gradFn(w);
    let wNew = null;
    if (obj) {
      let s = step;
      for (let bt = 0; bt < 40; bt++) {
        const cand = projectBoxSimplex(w.map((x, i) => x - s * g[i]), { max: maxWeight });
        const cObj = obj(cand);
        if (cObj <= curObj + 1e-15) { wNew = cand; curObj = cObj; step = Math.min(s * 1.3, 10); break; }
        s /= 2;
      }
      if (!wNew) break;                      // 40 次回溯都降不动 → 已在数值精度上收敛
    } else {
      wNew = projectBoxSimplex(w.map((x, i) => x - step * g[i]), { max: maxWeight });
    }
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs(wNew[i] - w[i]);
    w = wNew;
    if (diff < tol) { converged = true; break; }
  }
  const s = w.reduce((a, b) => a + b, 0);
  return { weights: s > 0 ? w.map(x => x / s) : w, converged };
}

/* ---------------- 权重分配器 ---------------- */

/** 最小方差组合（long-only，带单品种上限）。 */
export function minVarianceWeights(cov, { maxWeight = 1, iters = 4000 } = {}) {
  const n = cov?.length ?? 0;
  if (!n || cov.some(r => r.length !== n)) return { weights: null, note: '协方差矩阵不可用' };
  const gradFn = (w) => cov.map((row, i) => row.reduce((s, v, j) => s + v * w[j], 0));
  const objFn = (w) => quadForm(cov, w);
  const { weights, converged } = projectedGradient({ n, gradFn, objFn, maxWeight, iters });
  return { weights, converged, portVar: quadForm(cov, weights) };
}

/** 均值-方差：max μᵀw − (λ/2)wᵀΣw。λ→∞ 退化为最小方差，λ→0 押满最高收益。 */
export function meanVarianceWeights(mu, cov, { riskAversion = 2, maxWeight = 1, iters = 4000 } = {}) {
  const n = cov?.length ?? 0;
  if (!n || !(cov[0].length === n) || !mu || mu.length !== n) return { weights: null, note: 'μ 与 Σ 维度不符' };
  const lam = Math.max(riskAversion, 1e-9);
  // 求解器做的是"最小化"：这里最小化 (λ/2)wᵀΣw − μᵀw，等价于最大化原目标
  const gradFn = (w) => {
    const Sw = cov.map((row, i) => row.reduce((s, v, j) => s + v * w[j], 0));
    return Sw.map((s, i) => lam * s - mu[i]);
  };
  const objFn = (w) => {
    let q = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) q += w[i] * cov[i][j] * w[j];
    return 0.5 * lam * q - mu.reduce((s, m, i) => s + m * w[i], 0);
  };
  const { weights, converged } = projectedGradient({ n, gradFn, objFn, maxWeight, iters });
  return { weights, converged, expRet: mu.reduce((s, m, i) => s + m * weights[i], 0),
           portVar: quadForm(cov, weights) };
}

function quadForm(C, w) {
  if (!w) return null;
  let s = 0;
  for (let i = 0; i < C.length; i++) for (let j = 0; j < C.length; j++) s += w[i] * C[i][j] * w[j];
  return s;
}

/**
 * 真风险平价（ERC，等风险贡献）。Spinu 凸化：min ½wᵀΣw − (1/N)Σ ln wᵢ，
 * 逐坐标解一元二次取正根，收敛后归一。逆波动率只是它的零阶近似 —— 相关性非零时两者差得不少。
 */
export function ercWeights(cov, { iters = 2000, tol = 1e-12 } = {}) {
  const n = cov?.length ?? 0;
  if (!n) return { weights: null, note: '协方差矩阵不可用' };
  let w = new Array(n).fill(1 / Math.sqrt(n));
  let converged = false;
  for (let it = 0; it < iters; it++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      // b = (Σw)_i − Σ_ii·w_i（去掉自身项的交叉项）
      let cross = 0;
      for (let j = 0; j < n; j++) if (j !== i) cross += cov[i][j] * w[j];
      const a = cov[i][i];
      // a·w² + cross·w − 1/N = 0 的正根
      const disc = cross * cross + 4 * a / n;
      const wNew = (-cross + Math.sqrt(Math.max(disc, 0))) / (2 * a);
      maxDelta = Math.max(maxDelta, Math.abs(wNew - w[i]));
      w[i] = wNew;
    }
    if (maxDelta < tol) { converged = true; break; }
  }
  const s = w.reduce((a, b) => a + b, 0);
  const weights = w.map(x => x / s);
  // 风险贡献：RC_i = w_i (Σw)_i / (wᵀΣw)
  const Sw = cov.map((row, i) => row.reduce((s2, v, j) => s2 + v * weights[j], 0));
  const total = quadForm(cov, weights);
  const rc = weights.map((x, i) => (total > 0 ? x * Sw[i] / total : 0));
  return { weights, converged, riskContributions: rc, rcSpread: Math.max(...rc) - Math.min(...rc) };
}

/**
 * CVaR 风险平价（历史模拟口径）。
 * 尾部由当前组合的实际分布决定：L_t = −r_p,t，取损失 ≥ VaR_α 的场景，
 * 边际贡献 m_i = −mean_{tail}(r_{t,i})，乘性更新 w_i ∝ w_i·(1/m_i)^η。
 * 某资产在尾部场景里反而是赚的（对冲品）时 m_i ≤ 0 —— 兜底夹成小正数并在 note 里说明。
 */
export function cvarParityWeights(R, { alpha = 0.95, eta = 1.0, iters = 500, tol = 1e-8 } = {}) {
  const T = R?.length ?? 0, N = R?.[0]?.length ?? 0;
  if (T < 30 || N < 2) return { weights: null, note: 'CVaR 平价至少需要 30 期 × 2 资产的收益矩阵' };
  let w = new Array(N).fill(1 / N);
  let hedger = false;
  let converged = false;
  for (let it = 0; it < iters; it++) {
    const port = R.map(r => r.reduce((s, v, i) => s + v * w[i], 0));
    const losses = port.map(x => -x).sort((a, b) => a - b);
    const varQ = losses[Math.min(losses.length - 1, Math.floor(alpha * losses.length))];
    // 尾部场景集合：损失 ≥ VaR
    const tailIdx = [];
    for (let t = 0; t < T; t++) if (-port[t] >= varQ - 1e-15) tailIdx.push(t);
    if (!tailIdx.length) break;
    const marg = new Array(N).fill(0);
    for (const t of tailIdx) for (let i = 0; i < N; i++) marg[i] += -R[t][i];
    let updated = w.map((x, i) => {
      let m = marg[i] / tailIdx.length;
      if (m <= 1e-12) { m = 1e-12; hedger = true; }
      return x * Math.pow(1 / m, eta);
    });
    const s = updated.reduce((a, b) => a + b, 0);
    updated = updated.map(x => x / s);
    let diff = 0;
    for (let i = 0; i < N; i++) diff += Math.abs(updated[i] - w[i]);
    w = updated;
    if (diff < tol) { converged = true; break; }
  }
  return {
    weights: w, converged,
    note: hedger ? '有资产在尾部场景反而盈利（对冲属性），其权重按边际贡献下限处理' : null
  };
}

/* ---------------- Black-Litterman ---------------- */

/**
 * B-L 后验。views: {P: K×N 观点矩阵, Q: K 观点值, omega: 可选 K×K 观点不确定度}。
 * omega 缺省用 τ·diag(PΣPᵀ)（Idzorek 的简化：观点越"重"越可信）。
 * 返回后验期望收益与后验协方差（He-Granger 修正项）。
 */
export function blackLitterman({ cov, wMarket, views = null, tau = 0.05, delta = 2.0 }) {
  const n = cov?.length ?? 0;
  if (!n || !wMarket || wMarket.length !== n) return { expRet: null, note: 'Σ 与市场权重维度不符' };
  const wm = wMarket.reduce((a, b) => a + b, 0) > 0 ? wMarket : new Array(n).fill(1 / n);
  const wSum = wm.reduce((a, b) => a + b, 0);
  const wNorm = wm.map(x => x / wSum);
  // 隐含均衡收益 Π = δΣw_mkt —— 市场组合本身是"对的"先验
  const pi = cov.map(row => delta * row.reduce((s, v, j) => s + v * wNorm[j], 0));
  if (!views || !views.P || !views.P.length) {
    return { expRet: pi, pi, postCov: cov, note: '无观点：后验即均衡隐含收益' };
  }
  const P = views.P, Q = views.Q, K = P.length;
  // Ω 缺省用 τ·diag(PΣPᵀ)（Idzorek 简化：观点触及的方差越大，观点越不确定）
  const omegaM = views.omega || P.map((_, k) => P.map((_, l) => (k === l ? tau * quadForm(cov, P[k]) : 0)));
  const tSinv = invertMatrix(cov.map(row => row.map(v => v * tau)));
  const OmInv = invertMatrix(omegaM);
  if (!tSinv || !OmInv) return { expRet: null, note: 'Σ 或 Ω 数值奇异，无法求后验' };
  // A = (τΣ)⁻¹ + PᵀΩ⁻¹P；b = (τΣ)⁻¹Π + PᵀΩ⁻¹Q；后验 = A⁻¹b
  const OmInvQ = OmInv.map(row => row.reduce((s, v, j) => s + v * Q[j], 0));
  const OmInvP = matMul(OmInv, P);
  const A = [];
  const b = [];
  for (let i = 0; i < n; i++) {
    const rowA = tSinv[i].slice();
    let bi = tSinv[i].reduce((s, v, j) => s + v * pi[j], 0);
    for (let k = 0; k < K; k++) {
      const Pik = P[k][i];
      if (Pik === 0) continue;
      bi += Pik * OmInvQ[k];
      for (let j = 0; j < n; j++) rowA[j] += Pik * OmInvP[k][j];
    }
    A.push(rowA); b.push(bi);
  }
  const Ainv = invertMatrix(A);
  if (!Ainv) return { expRet: null, note: '后验方程数值奇异' };
  const expRet = Ainv.map(row => row.reduce((s, v, j) => s + v * b[j], 0));
  // 后验协方差 = Σ + M，M = A⁻¹ − τΣ（He-Granger）；数值可能微小负定，给出但注明
  const M = Ainv.map((row, i) => row.map((v, j) => v - tau * cov[i][j]));
  const postCov = cov.map((row, i) => row.map((v, j) => v + M[i][j]));
  return { expRet, pi, postCov, tau, delta };
}

/* ---------------- HRP 层次风险平价 ---------------- */

/**
 * HRP（López de Prado）：不做矩阵求逆、不做优化器 —— 相关性距离上聚类，
 * 树形排序后递归二分。共线性矩阵（三五个品种同涨同跌）在 MVO 下直接爆炸，
 * HRP 连 Σ⁻¹ 都不碰，这是它在样本外长期占优的原因。
 *
 * 聚类用平均联接（简化 seriation：合并树的中序遍历），n ≤ 50 时 O(n³) 可忽略。
 */
export function hrpWeights(R, { maxIter = 64 } = {}) {
  const T = R?.length ?? 0, N = R?.[0]?.length ?? 0;
  if (T < 10 || N < 2) return { weights: null, note: 'HRP 至少需要 10 期 × 2 资产' };
  const cov = sampleCovariance(R);
  if (!cov) return { weights: null, note: '协方差不可算' };
  const corr = correlationFromCov(cov);
  const dist = corr.map((row, i) => row.map((v, j) => Math.sqrt(Math.max(0, 0.5 * (1 - v)))));

  // 自底向上聚类：簇数组，每个 {items, height}
  let clusters = Array.from({ length: N }, (_, i) => ({ items: [i], height: 0 }));
  const avgDist = (a, b) => {
    let s = 0;
    for (const i of a.items) for (const j of b.items) s += dist[i][j];
    return s / (a.items.length * b.items.length);
  };
  while (clusters.length > 1) {
    let best = Infinity, bi = -1, bj = -1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = avgDist(clusters[i], clusters[j]);
        if (d < best) { best = d; bi = i; bj = j; }
      }
    }
    const merged = { items: [...clusters[bi].items, ...clusters[bj].items], height: best, left: clusters[bi], right: clusters[bj] };
    clusters = clusters.filter((_, k) => k !== bi && k !== bj).concat(merged);
    if (clusters.length < 1) break;
  }
  // seriation：合并树中序（左=先合并的簇）→ 准对角排序
  const order = [];
  (function walk(c, depth) {
    if (depth > maxIter || !c) return;
    if (c.items && !c.left) { order.push(...c.items); return; }
    walk(c.left, depth + 1); walk(c.right, depth + 1);
  })(clusters[0], 0);
  if (order.length !== N) return { weights: null, note: '聚类序列化失败' };

  // 逆方差分配（簇内）+ 递归二分（簇间）：每次把排序后的资产列对半切开，
  // 按两半的簇方差倒数分配权重份额，递归到单个资产。全程无矩阵求逆。
  const ivpVar = (idx) => {
    const inv = idx.map(i => 1 / Math.max(cov[i][i], 1e-18));
    const s = inv.reduce((a, b) => a + b, 0);
    const wv = inv.map(x => x / s);
    let varSum = 0;
    for (const a of idx) for (const b of idx) varSum += wv[idx.indexOf(a)] * cov[a][b] * wv[idx.indexOf(b)];
    return varSum;
  };
  const w = new Array(N).fill(0);
  (function alloc(sub, share) {
    if (sub.length === 1) { w[sub[0]] += share; return; }
    const h = Math.floor(sub.length / 2);
    const L = sub.slice(0, h), Rt = sub.slice(h);
    const vL = ivpVar(L), vR = ivpVar(Rt);
    const alpha = 1 - vR / (vL + vR);
    alloc(L, share * alpha); alloc(Rt, share * (1 - alpha));
  })(order, 1);
  const s = w.reduce((a, b) => a + b, 0);
  const weights = w.map(x => x / s);
  return { weights, converged: true, cov, corr };
}
