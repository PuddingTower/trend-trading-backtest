/**
 * 风格暴露 —— 收益回归风格分析（Returns-Based Style Analysis, Sharpe 1992）。
 *
 * 架构白皮书要的是 Barra CNE5/6 全套：截面回归 + PIT 财务 + 行业哑变量。
 * 免费行情数据里没有 PIT 基本面与行业历史，完整版是已知边界（不做假实现）。
 * 这里实现的是它的可行情化子集：用**组合收益对风格因子收益做时序回归**，
 * 回答 Barra 想回答的那个问题 —— "你的策略到底在赌什么"：
 *
 *   r_p = α + β_mkt·F_mkt + β_mom·F_mom + β_vol·F_vol + β_size·F_size + ε
 *
 * 因子收益全部从品种池行情构建（无未来函数：t 日因子用截至 t−1 的数据排序，
 * 赚 t 日收益）：
 *   F_mkt  —— 池内等权收益（给了指数序列就用指数）
 *   F_mom  —— 动量：过去 momLookback 收益最高的 1/3 减最低的 1/3（WML）
 *   F_vol  —— 波动：过去 volLookback 波动最高的 1/3 减最低的 1/3
 *   F_size —— 规模代理：近 20 日均价×均量（成交额代理）最大的 1/3 减最小的 1/3
 * 诊断口径：R² 低 + 残差波动低 → 真选股 Alpha；β_size 显著为正 → 其实是在赌大票。
 */

/** 多元 OLS（含截距）。返回系数、标准误、t 值、R²、残差标准差。 */
export function ols(y, X, { addIntercept = true } = {}) {
  const T = y?.length ?? 0;
  const K = X?.[0]?.length ?? 0;
  if (T < K + 3) return { usable: false, note: '样本量不足以估计这么多因子' };
  // 构建设计矩阵（可加截距列），并过滤含非有限值的行
  const rowsY = [], rowsX = [];
  for (let t = 0; t < T; t++) {
    const row = X[t];
    if (!row || row.length !== K || !Number.isFinite(y[t]) || !row.every(Number.isFinite)) continue;
    rowsY.push(y[t]);
    rowsX.push(addIntercept ? [1, ...row] : [...row]);
  }
  const n = rowsY.length, k = rowsX[0].length;
  if (n < k + 2) return { usable: false, note: '有效样本不足' };
  // 正规方程 (XᵀX)⁻¹Xᵀy
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += rowsX[i][a] * rowsY[i];
      for (let b = 0; b < k; b++) XtX[a][b] += rowsX[i][a] * rowsX[i][b];
    }
  }
  // 高斯消元求逆 + 解（这里直接解增广矩阵）
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return { usable: false, note: '因子共线，方程奇异（去掉相关因子再试）' };
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let j = 0; j <= k; j++) M[c][j] /= d;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (!f) continue;
      for (let j = 0; j <= k; j++) M[r][j] -= f * M[c][j];
    }
  }
  const beta = M.map(row => row[k]);
  const fitted = rowsX.map(row => row.reduce((s, v, i) => s + v * beta[i], 0));
  const meanY = rowsY.reduce((a, b) => a + b, 0) / n;
  let sse = 0, sst = 0;
  for (let i = 0; i < n; i++) { const e = rowsY[i] - fitted[i]; sse += e * e; sst += (rowsY[i] - meanY) ** 2; }
  const dof = n - k;
  const s2 = dof > 0 ? sse / dof : 0;
  // (XᵀX)⁻¹ 对角线 = 系数方差（×s²）。重新求逆拿对角线。
  const inv = (() => {
    const A = XtX.map(row => [...row]);
    const I = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)));
    for (let c = 0; c < k; c++) {
      let piv = c;
      for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-14) return null;
      [A[c], A[piv]] = [A[piv], A[c]];
      const d = A[c][c];
      for (let j = 0; j < k; j++) { A[c][j] /= d; I[c][j] /= d; }
      for (let r = 0; r < k; r++) {
        if (r === c) continue;
        const f = A[r][c];
        if (!f) continue;
        for (let j = 0; j < k; j++) { A[r][j] -= f * A[c][j]; I[r][j] -= f * I[c][j]; }
      }
    }
    return I;
  })();
  const se = inv ? beta.map((_, a) => Math.sqrt(Math.max(0, s2 * inv[a][a]))) : null;
  const t = se ? beta.map((b, a) => (se[a] > 1e-15 ? b / se[a] : null)) : null;
  return {
    usable: true, n,
    alpha: addIntercept ? beta[0] : 0,
    alphaT: t ? t[0] : null,
    beta: addIntercept ? beta.slice(1) : beta,
    t: t ? t.slice(1) : t,
    r2: sst > 0 ? 1 - sse / sst : null,
    residualSd: Math.sqrt(s2)
  };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdev = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / (xs.length - 1));
};

/**
 * 从品种池构建风格因子收益序列（全部按日期对齐，缺值品种该日不参与）。
 * seriesList: [{symbol, bars}]；bars 按日期升序、带 close（可选 volume）。
 * 排序一律用截至 t−1 的窗口，赚 t 日的收益 —— 顺序错了就是未来函数。
 */
export function styleFactorReturns(seriesList, { momLookback = 60, volLookback = 20, sizeLookback = 20, bucket = 3 } = {}) {
  const list = (seriesList || []).filter(s => s && Array.isArray(s.bars) && s.bars.length > 5);
  if (list.length < 4) return { usable: false, note: '品种池至少需要 4 个序列才能切分位' };
  const dateSet = new Set();
  for (const s of list) for (const b of s.bars) dateSet.add(b.date);
  const dates = [...dateSet].sort();
  const idx = new Map(dates.map((d, i) => [d, i]));
  const N = list.length, T = dates.length;
  const close = Array.from({ length: T }, () => new Array(N).fill(null));
  const volv = Array.from({ length: T }, () => new Array(N).fill(null));
  const amount = Array.from({ length: T }, () => new Array(N).fill(null));
  list.forEach((s, j) => {
    for (const b of s.bars) {
      const t = idx.get(b.date);
      if (t === undefined) continue;
      close[t][j] = Number.isFinite(b.close) ? b.close : null;
      if (Number.isFinite(b.volume) && Number.isFinite(b.close)) amount[t][j] = b.close * b.volume;
    }
    // 逐日滚动波动率（截至当日，供 t−1 排序用）
    const rets = [];
    for (let t = 0; t < T; t++) {
      if (t > 0 && Number.isFinite(close[t][j]) && Number.isFinite(close[t - 1][j]) && close[t - 1][j] > 0) {
        rets.push(close[t][j] / close[t - 1][j] - 1);
      }
      volv[t][j] = rets.length >= 5 ? stdev(rets.slice(-volLookback)) : null;
    }
  });
  const ret = Array.from({ length: T }, () => new Array(N).fill(null));
  for (let t = 1; t < T; t++) {
    for (let j = 0; j < N; j++) {
      if (Number.isFinite(close[t][j]) && Number.isFinite(close[t - 1][j]) && close[t - 1][j] > 0) {
        ret[t][j] = close[t][j] / close[t - 1][j] - 1;
      }
    }
  }
  const momAt = (t, j) => {
    if (t < momLookback) return null;
    const c0 = close[t - momLookback][j], c1 = close[t - 1][j];
    return (Number.isFinite(c0) && Number.isFinite(c1) && c0 > 0) ? c1 / c0 - 1 : null;
  };
  const rollMean = (t, j, lb) => {
    if (t < lb) return null;
    let s = 0, m = 0;
    for (let u = t - lb; u < t; u++) { if (Number.isFinite(amount[u][j])) { s += amount[u][j]; m++; } }
    return m >= lb * 0.6 ? s / m : null;
  };
  // 三分位排序辅助：返回 [低组, 高组] 的品种索引（按值升序，各 1/bucket）
  const extremes = (vals, validIdx) => {
    const rows = validIdx.map(j => ({ j, v: vals[j] })).filter(r => Number.isFinite(r.v)).sort((a, b) => a.v - b.v);
    const per = Math.max(1, Math.floor(rows.length / bucket));
    if (rows.length < bucket * 2) return null;
    return { low: rows.slice(0, per).map(r => r.j), high: rows.slice(rows.length - per).map(r => r.j) };
  };

  const fMkt = new Array(T).fill(null), fMom = new Array(T).fill(null),
        fVol = new Array(T).fill(null), fSize = new Array(T).fill(null);
  for (let t = 1; t < T; t++) {
    const valid = [];
    for (let j = 0; j < N; j++) if (Number.isFinite(ret[t][j])) valid.push(j);
    if (valid.length < 4) continue;
    fMkt[t] = mean(valid.map(j => ret[t][j]));
    const mm = extremes(valid.map(j => momAt(t, j)), valid);
    if (mm) {
      fMom[t] = mean(mm.high.map(j => ret[t][j])) - mean(mm.low.map(j => ret[t][j]));
    }
    const mv = extremes(valid.map(j => volv[t - 1]?.[j]), valid);
    if (mv) fVol[t] = mean(mv.high.map(j => ret[t][j])) - mean(mv.low.map(j => ret[t][j]));
    const ms = extremes(valid.map(j => rollMean(t, j, sizeLookback)), valid);
    if (ms) fSize[t] = mean(ms.high.map(j => ret[t][j])) - mean(ms.low.map(j => ret[t][j]));
  }
  return { usable: true, dates, factors: { mkt: fMkt, momentum: fMom, volatility: fVol, size: fSize } };
}

/**
 * 风格暴露诊断：策略日收益对风格因子收益的 OLS。
 * 返回逐因子暴露（含 t 值与一句话解读）、α 及其 t 值、R²、残差波动。
 */
export function styleExposure({ strategyReturns, factorReturns, factorNames = ['mkt', 'momentum', 'volatility', 'size'] }) {
  const { dates, factors } = factorReturns || {};
  if (!dates || !strategyReturns || strategyReturns.length < 30) {
    return { usable: false, note: '策略收益或因子序列不足' };
  }
  const T = dates.length;
  const y = new Array(T).fill(null);
  for (let t = 0; t < T; t++) {
    y[t] = Number.isFinite(strategyReturns[t]) ? strategyReturns[t] : null;
  }
  const X = dates.map((_, t) => factorNames.map(fn => (Number.isFinite(factors[fn]?.[t]) ? factors[fn][t] : null)));
  // 对齐：只保留 y 与全部因子都有效的行
  const rowsY = [], rowsX = [];
  for (let t = 0; t < T; t++) {
    if (y[t] === null || !X[t].every(Number.isFinite)) continue;
    rowsY.push(y[t]); rowsX.push(X[t]);
  }
  if (rowsY.length < 30) return { usable: false, note: '策略收益与因子可对齐的样本不足 30 期' };
  const withAlpha = ols(rowsY, rowsX, { addIntercept: true });
  const LABELS = {
    mkt: '市场 Beta',
    momentum: '动量',
    volatility: '波动（高减低）',
    size: '规模（大减小）'
  };
  if (!withAlpha.usable) return withAlpha;
  const exposures = factorNames.map((fn, i) => {
    const b = withAlpha.beta[i], t = withAlpha.t[i];
    let interp = null;
    if (fn === 'mkt' && Number.isFinite(b)) interp = b > 1.2 ? '高贝塔：比市场波动放大，牛市前锋熊市垫底' : b < 0.3 ? '接近市场中性' : null;
    if (fn === 'size' && Number.isFinite(b) && t && Math.abs(t) > 2) interp = b > 0 ? '显著押大票：赚的可能是风格钱不是选股钱' : '显著押小票（微盘暴露）';
    if (fn === 'momentum' && Number.isFinite(b) && t && Math.abs(t) > 2) interp = b > 0 ? '显著追涨：收益与动量因子同向' : '逆向/反转偏好';
    if (fn === 'volatility' && Number.isFinite(b) && t && Math.abs(t) > 2) interp = b > 0 ? '高波动暴露：回撤会被放大' : '低波动偏好';
    return { factor: fn, label: LABELS[fn] || fn, beta: b, tStat: t, interpretation: interp };
  });
  const pureAlpha = withAlpha.alphaT !== null && Math.abs(withAlpha.alphaT) > 2;
  return {
    usable: true, n: withAlpha.n,
    exposures,
    alpha: withAlpha.alpha, alphaT: withAlpha.alphaT,
    r2: withAlpha.r2, residualSd: withAlpha.residualSd,
    note: withAlpha.r2 !== null && withAlpha.r2 > 0.9
      ? '收益几乎被风格因子解释干净——"选股/择时能力"多半是风格暴露的马甲'
      : (pureAlpha ? '截距显著：存在风格解释不了的部分，这才值得深挖' : null)
  };
}
