/**
 * 盲复盘（计划 M6）。
 *
 * 定位：把「我知道这是螺纹钢 2019 年那波」这个信息拿走，只留下图形本身。
 * 知道品种和年份之后，人的判断会被记忆污染 —— 你以为自己在读盘，其实在背答案。
 *
 * 不泄露未来信息是这一功能的命门，具体到三条可实现约束：
 *   1. 交给图表的只有抽取区间内的 bar，区间之后的数据一律截掉（不是"隐藏"，是真的没有）；
 *   2. 抽取时只决定「起点 + 长度」，揭示点 = 起点，而不是随机抽一段再让你从中间开始看；
 *   3. 品种名、交易所、任何能从图上认出身份的字段在揭示完成前都不给 UI。
 * 第 1 条尤其重要：只靠 UI 遮罩的话，控制台里改一下 visibleDataCount 就穿透了。
 */

/** 可复现的伪随机（mulberry32）。抽题要能重放，否则"我刚才那题没做好，再来一次同样的"做不到。 */
export function makeRng(seed = Date.now()) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 从池子里抽一道题。
 * @param {Array<{symbol:Object, bars:Array}>} pool 每项是「品种 + 它的完整 bar 序列」
 * @param {number} rangeLen 抽取区间长度（bar 数）
 * @returns {null | {pick, bars, startIdx, endIdx, revealIdx, seed, label}}
 *          label 只在答案揭晓时给；抽题阶段调用方不该把它显示出来。
 */
export function pickBlindSegment(pool, { rangeLen = 120, seed = Date.now(), rng = null } = {}) {
  const usable = (pool || []).filter(p => p && p.bars && p.bars.length >= rangeLen + 2);
  if (!usable.length) return null;
  const r = rng || makeRng(seed);
  const pick = usable[Math.floor(r() * usable.length) % usable.length];
  const maxStart = pick.bars.length - rangeLen;
  const startIdx = Math.floor(r() * (maxStart + 1));
  const endIdx = startIdx + rangeLen - 1;
  return {
    pick,
    // 只交出这一段。之后的 bar 不存在于返回的数组里 —— 这是"真的没有"，不是"藏起来"。
    bars: pick.bars.slice(startIdx, endIdx + 1),
    startIdx, endIdx,
    revealIdx: 0,                     // 揭示点在这段的第一根，往后一棒棒推进
    seed,
    rangeLen,
    label: pick.name || pick.symbol?.openCode || pick.symbol?.symbol || ''
  };
}

/**
 * 当前是否允许显示身份信息。
 * 推进到区间末尾之前都不许 —— 中途看到"这是 2020 年原油"等于把剩下的题白做了。
 */
export function canReveal(state, visibleCount) {
  if (!state) return true;
  return visibleCount >= state.bars.length;
}

/** 盲复盘中的 UI 遮罩内容：只给编号与进度，不给任何可识别信息。 */
export function blindBadge(state, visibleCount) {
  if (!state) return null;
  return {
    title: '盲复盘进行中',
    symbolText: '🔒 隐藏品种',
    dateText: `第 ${visibleCount} / ${state.bars.length} 根`,
    progress: state.bars.length ? visibleCount / state.bars.length : 0,
    answer: canReveal(state, visibleCount) ? state.label : null
  };
}

/** 一段 bar 的粗粒度"指纹"，用来做去重与题目登记（不含任何品种名）。 */
export function segmentFingerprint(bars) {
  if (!bars || !bars.length) return '';
  const first = bars[0], last = bars[bars.length - 1];
  let hi = -Infinity, lo = Infinity, sum = 0;
  for (const b of bars) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; sum += b.close; }
  const norm = (v, base) => Math.round((v / (base || 1)) * 1e4);
  return `${bars.length}|${norm(first.open, last.close)}|${norm(hi, last.close)}|${norm(lo, last.close)}|${norm(sum / bars.length, last.close)}`;
}
