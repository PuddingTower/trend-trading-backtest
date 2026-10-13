/**
 * 头寸规模（计划 M5/M6 里"别的软件有、我们缺"的那一块）。
 *
 * 趋势交易的胜负手从来不是入场点，而是"这一笔押多少"：
 * 同一套突破信号，固定 1 手和按 ATR 风险预算开出来的资金曲线是两条完全不同的东西 ——
 * 螺纹钢一手名义 3.8 万、510300 一手 400 块，固定手数等于在不同品种间随机分配风险。
 *
 * 全部纯函数：给定权益、价格、波动，返回手数。取整与"至少 1 手还是 0 手"的口径写在这里，
 * 不在 UI 里各算一遍。
 */

import { atr } from '../analysis/common.js';

/**
 * ATR 风险预算（固定分数风险 / Fixed Fractional）：
 *   手数 = 权益 × 单笔风险比例 / (止损距离 × 乘数)
 * 止损距离 = atrMult × ATR。这是海龟式的标准算法，也是"每笔最多亏 1%"这句话的唯一定义。
 *
 * @returns {number} 手数（≥0）。算不满 1 手时返回 0 —— 而不是凑 1 手。
 *   凑 1 手等于在小额账户上把风险比例悄悄放大到几倍，账户越小错得越离谱，
 *   而这恰好是最需要风控的那批人。
 */
export function atrRiskSize({ equity, atrValue, atrMult = 2, multiplier = 1, riskPct = 0.01, maxLots = Infinity }) {
  if (!(equity > 0) || !(atrValue > 0) || !(atrMult > 0) || !(multiplier > 0)) return 0;
  const riskPerLot = atrValue * atrMult * multiplier;
  if (!(riskPerLot > 0) || !(riskPct > 0)) return 0;
  const lots = Math.floor((equity * riskPct) / riskPerLot);
  return Math.max(0, Math.min(lots, maxLots === Infinity ? lots : maxLots));
}

/** 名义敞口比例：每笔占用的保证金 ≈ 权益 × pct。小账户也能开出来，风险随权益等比。 */
export function notionalSize({ equity, price, multiplier = 1, marginRate = 0.1, pct = 0.25, maxLots = Infinity }) {
  if (!(equity > 0) || !(price > 0) || !(multiplier > 0)) return 0;
  const perLot = price * multiplier * (marginRate > 0 ? marginRate : 1);
  if (!(perLot > 0)) return 0;
  return Math.max(0, Math.min(Math.floor((equity * pct) / perLot), maxLots));
}

/** 年化波动率（对数收益不划算，用简单收益；不足 20 个样本返回 null 而不是给个假数）。 */
export function annualizedVol(closes, periodsPerYear = 252) {
  const list = (closes || []).filter(v => Number.isFinite(v) && v > 0);
  if (list.length < 21) return null;
  const rets = [];
  for (let i = 1; i < list.length; i++) rets.push(list[i] / list[i - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, x) => a + (x - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v * periodsPerYear);
}

/**
 * 波动率目标仓位：让单一品种对组合年化波动的贡献 ≈ targetVolPct。
 *   手数 = 权益 × 目标波动 / (品种年化波动 × 名义占比)
 * 与 ATR 法的区别：ATR 管的是"这一笔最多亏多少"（尾部），波动率目标管的是"这段时间账户抖多少"。
 * 两者不冲突，组合层面通常后者定权重、单笔层面前者定止损。
 */
export function volTargetSize({ equity, price, multiplier = 1, vol, targetVolPct = 0.10, maxLots = Infinity }) {
  if (!(equity > 0) || !(price > 0) || !(vol > 0)) return 0;
  const notional = (equity * targetVolPct) / vol;
  const lots = Math.floor(notional / (price * multiplier));
  return Math.max(0, Math.min(lots, maxLots === Infinity ? lots : maxLots));
}

/**
 * 半 Kelly。Kelly 分数 = W - (1-W)/R，W=胜率、R=平均盈亏比。
 * 全 Kelly 用的是"期望收益/赔率"，参数估计误差会让它远超真实最优 —— 稍有偏差就超额下注，
 * 所以业界通行做法是取一半（甚至 1/4）。这里默认半 Kelly，并在返回值里把两者都给出来。
 */
export function kellyFraction({ winRate, payoffRatio, full = false }) {
  if (!Number.isFinite(winRate) || !Number.isFinite(payoffRatio) || payoffRatio <= 0) {
    return { kelly: 0, half: 0, samples: 0, note: '样本不足，Kelly 无法估计' };
  }
  const f = winRate - (1 - winRate) / payoffRatio;
  const clamped = Math.max(0, Math.min(1, f));
  return { kelly: f > 1 ? 1 : Math.max(0, f), half: clamped / 2, fullValue: f, note: f <= 0 ? '期望为负：任何正仓位都在亏钱' : '' };
}

/** 相关性矩阵（Pearson），用于分散度与风险平价。 */
export function correlationMatrix(seriesList) {
  const list = (seriesList || []).map(s => (s || []).filter(v => Number.isFinite(v)));
  const n = list.length;
  const m = Math.min(...list.map(s => s.length).filter(x => Number.isFinite(x)), Infinity);
  if (!n || !Number.isFinite(m) || m < 3) return { matrix: [], usable: false };
  const rets = list.map(s => {
    const out = [];
    for (let i = 1; i < Math.min(s.length, m + 1); i++) out.push(s[i] / s[i - 1] - 1);
    return out;
  });
  const k = Math.min(...rets.map(r => r.length));
  if (k < 3) return { matrix: [], usable: false };
  const trimmed = rets.map(r => r.slice(0, k));
  const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
  const std = (x) => { const mu = mean(x); return Math.sqrt(x.reduce((a, v) => a + (v - mu) ** 2, 0) / (x.length - 1)); };
  const mu = trimmed.map(mean), sd = trimmed.map(std);
  const matrix = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      if (i === j) { row.push(1); continue; }
      if (!(sd[i] > 0) || !(sd[j] > 0)) { row.push(0); continue; }
      let cov = 0;
      for (let t = 0; t < k; t++) cov += (trimmed[i][t] - mu[i]) * (trimmed[j][t] - mu[j]);
      row.push(Math.round((cov / (k - 1)) / (sd[i] * sd[j]) * 1e4) / 1e4);
    }
    matrix.push(row);
  }
  return { matrix, usable: true, samples: k };
}

/**
 * 风险平价权重：w_i ∝ 1/vol_i 后再按相关性粗略惩罚。
 * 纯逆波动率是它对相关性矩阵的常用一阶近似 —— 这里明确用一阶近似而不是求解
 * 真正的 ERC 方程组：那需要迭代求解器，误差与收敛条件都要额外解释，不值得在这个工具里装。
 */
export function riskParityWeights(vols) {
  const inv = (vols || []).map(v => (Number.isFinite(v) && v > 0 ? 1 / v : 0));
  const sum = inv.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return (vols || []).map(() => 1 / Math.max(1, vols.length));
  return inv.map(x => x / sum);
}

/** 分散度：加权平均相关性越低越分散。给出一个能直接读的分数，而不是让用户自己看矩阵。 */
export function diversificationScore(matrix) {
  if (!matrix || matrix.length < 2) return { avgCorr: null, score: null, note: '不足两个品种，谈不上分散' };
  let sum = 0, n = 0;
  for (let i = 0; i < matrix.length; i++) for (let j = i + 1; j < matrix.length; j++) { sum += matrix[i][j]; n++; }
  const avgCorr = n ? sum / n : null;
  return {
    avgCorr: avgCorr === null ? null : Math.round(avgCorr * 1e4) / 1e4,
    score: avgCorr === null ? null : Math.round((1 - avgCorr) * 100) / 100,
    note: avgCorr > 0.8 ? '高度同涨同跌，组合实际上是一个头寸的重复' : avgCorr > 0.5 ? '相关性偏高，分散有限' : '相关性可控，分散有效'
  };
}

/** ATR 序列（供 sizing 与策略共用），不足 period 返回 null 前缀。 */
export function atrSeries(bars, period = 14) {
  return atr(bars || [], period);
}
