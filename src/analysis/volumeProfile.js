/**
 * Volume Profile —— POC / 价值区(VAH,VAL) / HVN·LVN。
 *
 * 成交量分配口径：把每根 bar 的量在其 [low, high] 覆盖的分箱上**均匀铺开**（uniform 法）。
 * 这是多数行情软件的默认做法；另一种 typical-price 法只把量记到 (H+L+C)/3 单箱，
 * 会让长影线区段被系统性低估 —— 这里不用它。
 *
 * 价值区算法：从 POC 箱出发，每次并吞左右邻箱中量较大的那个，直到累计 >= valueAreaPct。
 * 这是标准“逐步扩张”法，不是简单取分位数 —— 后者在多峰分布上会给出无意义的边界。
 */

export function volumeProfile(bars, opts = {}) {
  const {
    bins = 48,
    valueAreaPct = 0.70,
    tick = null,
    includeOpen = false
  } = opts;

  const src = (bars || []).filter(b => Number.isFinite(b.high) && Number.isFinite(b.low));
  if (src.length === 0) return null;

  let lo = Infinity, hi = -Infinity;
  for (const b of src) {
    if (b.low < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
    if (includeOpen) {
      if (b.open < lo) lo = b.open;
      if (b.open > hi) hi = b.open;
    }
  }
  if (!(hi > lo)) return null;

  let step = (hi - lo) / bins;
  if (tick && tick > 0) step = Math.max(step, tick);   // 分箱不该细于最小变动价位
  const nBins = Math.max(4, Math.min(400, Math.ceil((hi - lo) / step)));
  const width = (hi - lo) / nBins;

  const vols = new Array(nBins).fill(0);
  for (const b of src) {
    const first = Math.max(0, Math.floor((b.low - lo) / width));
    const last = Math.min(nBins - 1, Math.floor((b.high - lo) / width));
    const span = last - first + 1;
    const share = (b.volume || 0) / span;
    for (let i = first; i <= last; i++) vols[i] += share;
  }

  let total = 0;
  for (const v of vols) total += v;
  if (total <= 0) return null;

  let pocIdx = 0;
  for (let i = 1; i < nBins; i++) if (vols[i] > vols[pocIdx]) pocIdx = i;

  // 价值区扩张
  const target = total * valueAreaPct;
  let acc = vols[pocIdx], up = pocIdx, down = pocIdx;
  while (acc < target && (up < nBins - 1 || down > 0)) {
    const upV = up < nBins - 1 ? vols[up + 1] : -1;
    const dnV = down > 0 ? vols[down - 1] : -1;
    if (upV >= dnV) { up++; acc += vols[up]; }
    else { down--; acc += vols[down]; }
  }

  const binLow = (i) => lo + i * width;
  const binHigh = (i) => lo + (i + 1) * width;
  const binCenter = (i) => lo + (i + 0.5) * width;

  // HVN / LVN：对分箱量做 3 点平滑后取局部极值，避开边界箱
  const smooth = vols.map((v, i) => {
    const a = vols[Math.max(0, i - 1)], c = vols[Math.min(nBins - 1, i + 1)];
    return (a + v + c) / 3;
  });
  const mean = total / nBins;
  const hvn = [], lvn = [];
  for (let i = 1; i < nBins - 1; i++) {
    if (i === pocIdx) continue;
    if (smooth[i] >= smooth[i - 1] && smooth[i] >= smooth[i + 1] && vols[i] > mean * 1.15) {
      hvn.push({ idx: i, price: binCenter(i), volume: vols[i] });
    }
    if (smooth[i] <= smooth[i - 1] && smooth[i] <= smooth[i + 1] && vols[i] < mean * 0.65) {
      lvn.push({ idx: i, price: binCenter(i), volume: vols[i] });
    }
  }

  const binsOut = vols.map((v, i) => ({
    idx: i,
    low: binLow(i), high: binHigh(i), center: binCenter(i),
    volume: v,
    ratio: v / (vols[pocIdx] || 1),
    isPOC: i === pocIdx,
    inVA: i >= down && i <= up,
    isHVN: hvn.some(x => x.idx === i),
    isLVN: lvn.some(x => x.idx === i)
  }));

  return {
    bins: binsOut,
    binWidth: width,
    rangeLow: lo,
    rangeHigh: hi,
    totalVolume: total,
    poc: { price: binCenter(pocIdx), volume: vols[pocIdx], low: binLow(pocIdx), high: binHigh(pocIdx) },
    vah: binHigh(up),
    val: binLow(down),
    valueAreaPct,
    valueAreaActual: acc / total,
    hvn: hvn.map(x => ({ ...x })),
    lvn: lvn.sort((a, b) => a.volume - b.volume).map(x => ({ ...x }))
  };
}

/**
 * 自动锚定：从最近一个显著摆动极值开始统计到当前 bar。
 * 官方口径的“anchored to market highs/lows”就是这个意思 —— 不是随便取个窗口。
 * 顶锚定看的是「顶部以来谁在出货」，底锚定看的是「底部以来谁在建仓」。
 */
export function autoAnchorRange(bars, { lookback = 250, minSwingPct = 0.05 } = {}) {
  const n = (bars || []).length;
  if (n < 5) return null;
  const from = Math.max(0, n - 1 - lookback);

  let hiIdx = from, loIdx = from;
  for (let i = from; i < n; i++) {
    if (bars[i].high > bars[hiIdx].high) hiIdx = i;
    if (bars[i].low < bars[loIdx].low) loIdx = i;
  }
  const last = n - 1;
  const hiMove = (bars[hiIdx].high - bars[last].close) / bars[hiIdx].high;   // 顶部距今回撤幅度
  const loMove = (bars[last].close - bars[loIdx].low) / bars[loIdx].low;     // 底部距今涨幅

  // 取“更近且更有意义”的那个锚点：谁离当前更近且幅度达标
  const useHigh = hiIdx >= loIdx ? hiMove >= minSwingPct : hiMove >= loMove && hiMove >= minSwingPct;
  const anchorIdx = useHigh ? hiIdx : loIdx;
  if (anchorIdx >= last) return null;   // 锚点就是最后一根，没有可统计区间

  return {
    startIdx: anchorIdx,
    endIdx: last,
    anchorType: useHigh ? 'high' : 'low',
    anchorPrice: useHigh ? bars[hiIdx].high : bars[loIdx].low,
    anchorDate: bars[anchorIdx].date
  };
}

/** 手动/摆动锚定：把 VP 限制在给定区间。 */
export function profileForRange(bars, startIdx, endIdx, opts) {
  const slice = (bars || []).slice(Math.max(0, startIdx), Math.min(bars.length, endIdx + 1));
  return volumeProfile(slice, opts);
}
