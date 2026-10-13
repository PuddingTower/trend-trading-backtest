/**
 * 主力换月拼接 + 周期聚合。
 *
 * 为什么需要自己拼：eastmoney 的 <品种>m 主连是上游拼好的（实测可用，4273 根到 2026-10-13），
 * 但它怎么拼的不透明。回测要能复现、要能出「换月信号」，就得自己掌握拼接口径。三种模式：
 *
 *   diff  —— 后复权差值平移（默认）：换月日把旧序列整体减去价差。收益率连续，价格水平失真但可交易。
 *   ratio —— 前复权比例缩放：保留相对波动幅度，绝对价位随历史推移。
 *   raw   —— 真实换月：不平移，直接跳到新合约价。会产生跳空缺口，但每根 bar 都是真实可成交价，
 *            并给出 rollover 标记供策略避开换月日交易。
 *
 * 周期聚合自己做，是为了让 CSV 导入/离线数据也能出周月线（上游 klt=102/103 只覆盖在线数据）。
 */

export const STITCH_MODES = { DIFF: 'diff', RATIO: 'ratio', RAW: 'raw' };

/**
 * @param {Array<{contract:string, bars:Array}>} segments 按换月先后排序，bars 日期升序
 * @param {string} mode
 * 返回拼接后的连续序列；每根带 contract，换月那根带 rollover=true 与 gap（raw 模式下）。
 */
export function stitch(segments, mode = STITCH_MODES.DIFF) {
  const segs = (segments || []).filter(s => s && Array.isArray(s.bars) && s.bars.length > 0);
  if (segs.length === 0) return [];
  if (segs.length === 1) {
    return segs[0].bars.map(b => ({ ...b, contract: segs[0].contract, rollover: false, rawClose: b.close }));
  }

  const out = [];
  // diff: 累积加法平移量。ratio: 累积乘法缩放系数。都以「已调整后的上一段收盘」为锚。
  let offset = 0;
  let scale = 1;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const prevBar = out.length ? out[out.length - 1] : null;
    const firstRaw = seg.bars[0];
    let gap = 0;

    if (prevBar) {
      // 价差用调整后价格算，保证多段连续换月不会累积漂移
      gap = mode === STITCH_MODES.RAW
        ? firstRaw.close - prevBar.rawClose
        : firstRaw.close + offset - prevBar.close;

      if (mode === STITCH_MODES.DIFF) {
        offset -= gap;
      } else if (mode === STITCH_MODES.RATIO) {
        scale = prevBar.close / (firstRaw.close * scale) ;
      }
    }

    const transform = (v) => {
      if (mode === STITCH_MODES.RAW) return v;
      if (mode === STITCH_MODES.RATIO) return v * scale;
      return v + offset;
    };

    for (let j = 0; j < seg.bars.length; j++) {
      const b = seg.bars[j];
      const isFirst = i > 0 && j === 0;
      const bar = {
        date: b.date,
        open: transform(b.open), high: transform(b.high),
        low: transform(b.low), close: transform(b.close),
        volume: b.volume,
        contract: seg.contract,
        rollover: isFirst,
        rawClose: b.close
      };
      if (isFirst && mode === STITCH_MODES.RAW) bar.gap = gap;
      out.push(bar);
    }
  }

  // 浮点尾巴收口到 4 位，避免 3089.0000000000005 进图表和报表
  for (const b of out) {
    for (const k of ['open', 'high', 'low', 'close']) b[k] = Math.round(b[k] * 1e4) / 1e4;
  }
  return out;
}

/**
 * 按日期把合约归属切段。输入是所有合约的 K线（含每个合约的上市区间），
 * 输出主力合约逐日序列 → 分段。主力判定：给定的 dominantByDate（通常来自持仓量排序）。
 */
export function segmentByDominant(allBars, dominantByDate) {
  const byContract = new Map();
  for (const [date, contract] of Object.entries(dominantByDate || {})) {
    if (!byContract.has(contract)) byContract.set(contract, []);
  }
  const index = new Map();
  for (const bars of Object.values(allBars || {})) {
    for (const b of bars) index.set(b.date, b);
  }
  const segments = [];
  let current = null;
  for (const date of Object.keys(dominantByDate || {}).sort()) {
    const contract = dominantByDate[date];
    const bar = index.get(date);
    if (!bar) continue;
    if (!current || current.contract !== contract) {
      current = { contract, bars: [] };
      segments.push(current);
    }
    current.bars.push(bar);
  }
  return segments;
}

const PERIOD_OF = {
  weekly: (d) => { const dt = new Date(d); const day = (dt.getDay() + 6) % 7;
    dt.setDate(dt.getDate() - day); return dt.toISOString().slice(0, 10); },
  monthly: (d) => String(d).slice(0, 7)
};

/**
 * 日线聚合到周线/月线。日期取该组内最后一个交易日（与国内行情软件一致）。
 * dailyBars 必须按日期升序。
 */
export function aggregate(dailyBars, period = 'weekly') {
  if (period === 'daily') return dailyBars.slice();
  const keyOf = PERIOD_OF[period];
  if (!keyOf) throw new Error(`不支持的聚合周期：${period}`);
  const groups = [];
  const map = new Map();
  for (const b of dailyBars) {
    const k = keyOf(b.date);
    let g = map.get(k);
    if (!g) { g = { key: k, bars: [] }; map.set(k, g); groups.push(g); }
    g.bars.push(b);
  }
  return groups.map(g => {
    const bars = g.bars;
    const first = bars[0], last = bars[bars.length - 1];
    const agg = {
      date: last.date,
      open: first.open,
      close: last.close,
      high: Math.max(...bars.map(x => x.high)),
      low: Math.min(...bars.map(x => x.low)),
      volume: bars.reduce((s, x) => s + (x.volume || 0), 0)
    };
    if (bars.some(x => x.amount !== undefined)) {
      agg.amount = bars.reduce((s, x) => s + (x.amount || 0), 0);
    }
    return agg;
  });
}

/** 检测换月缺口：返回 [{date, gap, gapPct}]，供回测报告提示「这段收益里有多少是换月造成的」。 */
export function findRolloverGaps(bars) {
  return bars.filter(b => b.rollover).map(b => ({
    date: b.date, contract: b.contract,
    gap: b.gap !== undefined ? b.gap : (b.open - b.rawClose),
    gapPct: b.rawClose ? ((b.open - b.rawClose) / b.rawClose) * 100 : 0
  }));
}
