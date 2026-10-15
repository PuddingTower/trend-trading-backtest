/**
 * CSCV + PBO：Probability of Backtest Overfitting。
 * （Bailey, Borwein, López de Prado & Zhu, Journal of Computational Finance 20(4), 2017）
 *
 * 回答的问题跟 walk-forward 不一样：WF 只考一条"先训后测"的路径，
 * CSCV 把时间切成 S 块、枚举 C(S,S/2) 种"哪一半当样本内"的分法，
 * 看**样本内冠军在样本外排老几**。如果它总是掉到中下游，那个"最优参数"就是挑出来的噪声。
 *
 * PBO = Pr(样本内冠军的样本外相对排名 ≤ 中位) ≈ #{λ ≤ 0} / M，λ = ln(ω/(1-ω))。
 *
 * ω 的约定必须写死并说明：不同版本的论文对"相对排名"归一化方式不一致
 * （有用 (rank-1)/(n-1) 的，也有用 rank/(n+1) 的），差一点就会在 ω=0 或 1 处把 λ 抛成 ±∞。
 * 这里用**中位并列法**：ω = (严格低于它的个数 + (并列个数+1)/2) / n，
 * 于是 ω ∈ [1/(2n), 1-1/(2n)] 恒不发散，且恰好中位时 ω=0.5 → λ=0，与"PBO 数的是 λ≤0"这条边界一致。
 */

import { makeRng } from '../core/rng.js';

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function sd(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (n - 1));
}
/** 子段单期夏普；方差为 0 的平段按"没有边际"记 0，两侧口径必须一致，否则挑选与排名会讲两套话。 */
const srOf = (xs) => { const s = sd(xs); return s > 0 ? mean(xs) / s : 0; };

/** 把 [0,T) 切成 S 段；余数摊给前几段，保证不重叠、不丢尾、没有空段。 */
export function blockBounds(T, S) {
  const out = [];
  const base = Math.floor(T / S);
  const rem = T % S;
  if (base <= 0) return [];
  let start = 0;
  for (let i = 0; i < S; i++) {
    const len = base + (i < rem ? 1 : 0);
    out.push({ start, end: start + len });
    start += len;
  }
  return out;
}

function combinations(arr, k) {
  const out = [];
  const chosen = [];
  const rec = (from) => {
    if (chosen.length === k) { out.push(chosen.slice()); return; }
    for (let i = from; i < arr.length; i++) { chosen.push(arr[i]); rec(i + 1); chosen.pop(); }
  };
  if (k >= 0 && k <= arr.length) rec(0);
  return out;
}

/** 取若干块拼成一段（保持时间先后顺序，别打乱）。 */
function pickSeries(row, blocks, idxs) {
  const out = [];
  for (const s of idxs) { const b = blocks[s]; for (let i = b.start; i < b.end; i++) out.push(row[i]); }
  return out;
}

/**
 * IS/OOS 的划分集合。C(S,S/2) 涨得很快（S=16 → 12870），所以上限之外按固定种子抽样 ——
 * 抽样必须可复现，否则同一个网格两次跑给出两个 PBO，那这个数就没有参考价值了。
 */
export function cscvPartitions(S, { maxPartitions = 256, seed = 7 } = {}) {
  const half = Math.floor(S / 2);
  const all = combinations(Array.from({ length: S }, (_, i) => i), half);
  if (all.length <= maxPartitions) return { partitions: all, sampled: false, total: all.length };
  const rng = makeRng(seed);
  const picked = [];
  const seen = new Set();
  for (let g = 0; g < maxPartitions * 20 && picked.length < maxPartitions; g++) {
    const idx = Math.floor(rng() * all.length) % all.length;
    if (seen.has(idx)) continue;
    seen.add(idx); picked.push(all[idx]);
  }
  return { partitions: picked, sampled: true, total: all.length };
}

/**
 * @param {Array<Array<number>>} matrix 每个 config 一条单期收益序列，必须等长（同一条时间轴）
 * @returns {{pbo:number|null, partitions:number, blocks:number, configs:number, reason?:string}}
 */
export function cscvPbo(matrix, { blocks = 16, maxPartitions = 256, seed = 7, minBlockLen = 20 } = {}) {
  const rows = (matrix || []).map(r => (r && typeof r.length === 'number' ? Array.from(r) : null))
    .filter(r => r && r.length && r.every(v => Number.isFinite(v)));
  const n = rows.length;
  if (n < 2) return { pbo: null, reason: `PBO 至少要 2 个 config 才谈"挑出来的最好"，实际 ${n}` };
  const T = rows[0].length;
  if (rows.some(r => r.length !== T)) return { pbo: null, reason: '各 config 的收益序列必须等长（同一条时间轴）' };
  const bs = blockBounds(T, blocks);
  const S = bs.length;
  if (S < 4) return { pbo: null, reason: `T=${T} 切不出 ${blocks} 个非空块（只有 ${S}），至少 4 块才能一半 IS 一半 OOS` };
  const shortest = Math.min(...bs.map(b => b.end - b.start));
  if (shortest < minBlockLen) {
    return { pbo: null, reason: `每块只有 ${shortest} 根，少于 ${minBlockLen} 根的块里夏普基本是抽样噪声，`
      + 'PBO 会给出一个看着像结论的数：请减少块数或加长区间' };
  }

  const { partitions, sampled, total } = cscvPartitions(S, { maxPartitions, seed });
  let neg = 0;
  const lambdas = [];
  for (const isIdx of partitions) {
    const isSet = new Set(isIdx);
    const oosIdx = [];
    for (let s = 0; s < S; s++) if (!isSet.has(s)) oosIdx.push(s);
    const isSr = rows.map(r => srOf(pickSeries(r, bs, isIdx)));
    const oosSr = rows.map(r => srOf(pickSeries(r, bs, oosIdx)));
    let best = 0;
    for (let i = 1; i < n; i++) if (isSr[i] > isSr[best]) best = i;   // 并列取靠前的，口径固定
    const w = oosSr[best];
    let below = 0, equal = 0;
    for (let i = 0; i < n; i++) { if (oosSr[i] < w) below++; else if (oosSr[i] === w) equal++; }
    /**
     * 中位秩 rank ∈ [1, n]（并列取中位），再归一到 ω = (rank - 0.5)/n。
     * 这里踩过一个坑：用 rank/n 的话冠军会取到 ω=1，λ=ln(1/0)=+∞，
     * 于是"IS 冠军在 OOS 排最好"被记成无穷确信，整个 PBO 系统性偏低（n=4 时中位 λ 直接是 Infinity）。
     * (rank-0.5)/n 恒在 (0,1) 内，且 rank ↔ n+1-rank 时 ω ↔ 1-ω 精确对称，
     * 中位情形 ω=0.5 → λ=0，正对"PBO 数的是 λ≤0"这条边界。
     */
    const rank = below + (equal + 1) / 2;
    const omega = (rank - 0.5) / n;
    const lambda = Math.log(omega / (1 - omega));
    lambdas.push(lambda);
    if (lambda <= 0) neg++;
  }
  lambdas.sort((a, b) => a - b);
  return {
    pbo: lambdas.length ? neg / lambdas.length : null,
    partitions: lambdas.length,
    partitionsTotal: total,
    sampled,
    blocks: S,
    configs: n,
    T,
    medianLambda: lambdas.length ? lambdas[Math.floor(lambdas.length / 2)] : null,
    omegaConvention: 'ω=(rank-0.5)/n，rank 是 IS 冠军在 OOS 夏普序列里的中位秩(1..n)；恒在 (0,1) 内，且 rank↔(n+1-rank) 时 ω↔(1-ω) 对称'
  };
}
