/**
 * 可复现伪随机。
 *
 * 盲复盘的「再抽一次同样的题」和蒙特卡洛的「这条曲线不是运气好」都依赖同一件事：
 * 给定种子必须给出逐位相同的序列。用 Math.random 的话，用户截图里的结果别人复现不了，
 * 那蒙特卡洛就退化成了一个看起来很像证据的装饰。
 */

/** mulberry32：状态 32 位、无依赖、分布够用。 */
export function makeRng(seed = Date.now()) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从 rng 取 [lo,hi) 区间的数。 */
export const between = (rng, lo, hi) => lo + rng() * (hi - lo);

/** 整数索引：rng 给的小数映射到 [0,n)。 */
export const pickIndex = (n, rng) => Math.min(n - 1, Math.floor(rng() * n));

/** Fisher–Yates 洗牌，返回新数组，不改原数组（回测的交易表要留着给人看）。 */
export function shuffled(list, rng) {
  const out = (list || []).slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = pickIndex(i + 1, rng);
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
  }
  return out;
}

/** 有放回抽样：长度同为 n，但某些交易会出现两次、某些一次都没有。 */
export function bootstrap(list, rng) {
  const n = (list || []).length;
  if (!n) return [];
  return Array.from({ length: n }, () => list[pickIndex(n, rng)]);
}
