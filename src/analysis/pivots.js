/**
 * Pivot Points —— 经典关键位自动计算。
 *
 * 关键口径：某一期的枢轴由**它自己那期的 H/L/C** 算出，但只能画在**下一期开始之后**。
 * 若在期内就把当期高低点算进去，等于用当天尚未收盘的数据预测当天支撑位 —— 未来函数。
 * 所以这里每个 level set 带 fromIdx（首个可见 bar）与 toIdx。
 */

/**
 * iOS/Safari 的 `new Date('2026-10-14 10:30')` 返回 Invalid Date，而 60m bar 的 date 正是这个形状。
 * 周线枢轴一旦落到 iPad 上就会全体归到同一个坏 key 里，所以这里只按字符串取年月日，
 * 再用 Date.UTC 构造（这个形式全平台都能解析）。
 */
const dayKey = (dateStr) => String(dateStr).slice(0, 10);

const periodKey = (dateStr, timeframe) => {
  const day = dayKey(dateStr);
  if (timeframe === 'monthly') return day.slice(0, 7);
  if (timeframe === 'weekly') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
    if (!m) return day;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const dow = (new Date(t).getUTCDay() + 6) % 7;    // 周一为一周起点
    return new Date(t - dow * 86400000).toISOString().slice(0, 10);
  }
  return day;   // daily：每个交易日自成一期
};

export function groupByPeriod(bars, timeframe = 'daily') {
  const groups = [];
  const map = new Map();
  for (let i = 0; i < bars.length; i++) {
    const k = periodKey(bars[i].date, timeframe);
    let g = map.get(k);
    if (!g) {
      g = { key: k, startIdx: i, endIdx: i, high: bars[i].high, low: bars[i].low, close: bars[i].close, open: bars[i].open };
      map.set(k, g); groups.push(g);
    } else {
      g.endIdx = i;
      if (bars[i].high > g.high) g.high = bars[i].high;
      if (bars[i].low < g.low) g.low = bars[i].low;
      g.close = bars[i].close;
    }
  }
  return groups;
}

export const PIVOT_TYPES = ['standard', 'fibonacci', 'camarilla', 'woodie'];

/**
 * 只放我有把握的四种。Demark 没做：它的 X 取法要按“当期收盘 vs 前一期收盘”分支，
 * 各家实现口径不一致，我没有把握写对，宁可不放。
 * 用户点名的 Standard 与 High-Low 分别在这里和 highLowPivots。
 */
export function pivotLevels(prev) {
  const H = prev.high, L = prev.low, C = prev.close;
  const R = H - L;
  const P = (H + L + C) / 3;
  const WP = (H + L + 2 * C) / 4;

  return {
    standard: {
      P, R1: 2 * P - L, S1: 2 * P - H,
      R2: P + R, S2: P - R,
      R3: H + 2 * (P - L), S3: L - 2 * (H - P)
    },
    fibonacci: {
      P, R1: P + 0.382 * R, R2: P + 0.618 * R, R3: P + R,
      S1: P - 0.382 * R, S2: P - 0.618 * R, S3: P - R
    },
    camarilla: {
      P,
      R1: C + R * 1.1 / 12, R2: C + R * 1.1 / 6, R3: C + R * 1.1 / 4, R4: C + R * 1.1 / 2,
      S1: C - R * 1.1 / 12, S2: C - R * 1.1 / 6, S3: C - R * 1.1 / 4, S4: C - R * 1.1 / 2
    },
    woodie: {
      P: WP, R1: 2 * WP - L, S1: 2 * WP - H,
      R2: WP + R, S2: WP - R,
      R3: H + 2 * (WP - L), S3: L - 2 * (H - WP)
    }
  };
}

/**
 * @param {string} type standard|fibonacci|camarilla|woodie
 * @param {string} timeframe daily|weekly|monthly
 */
export function computePivots(bars, { type = 'standard', timeframe = 'daily' } = {}) {
  const groups = groupByPeriod(bars, timeframe);
  const sets = [];
  for (let i = 1; i < groups.length; i++) {
    const prev = groups[i - 1];
    const levels = (pivotLevels(prev)[type]) || pivotLevels(prev).standard;
    const cur = groups[i];
    sets.push({
      sourcePeriod: prev.key,
      fromIdx: cur.startIdx,
      toIdx: cur.endIdx,
      levels, timeframe, type
    });
  }
  // 最后一组没有“下一期”，它的枢轴要等本期末收盘才成立 —— 不画，避免未来函数
  return sets;
}

/**
 * High-Low pivots：分形摆动高低点（左右各 n 根内的极值），同价位聚簇后带触碰次数当强度。
 * 与 common.swingPoints 的区别：这是行情软件 Pivot High/Low 的“局部极值”定义，
 * 不依赖百分比阈值，因此对盘整区更敏感。
 *
 * 右侧必须留够 right 根才算确认 —— 未确认的候选不返回，否则图上会浮出未来拐点。
 *
 * 每条线都算 `brokenAtIdx`：被收盘价穿越即失效，线的右端截止在那一根。
 * 不这么做的话，一条 2015 年就被突破的阻力位会一路拖到图上最右边，
 * 读图的人会继续把它当支撑看 —— 这比漏标更有害。
 */
export function highLowPivots(bars, { left = 5, right = 5, mergePct = 0.002 } = {}) {
  const n = (bars || []).length;
  const raw = [];
  for (let i = left; i < n - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) raw.push({ idx: i, price: bars[i].high, kind: 'high', confirmedAtIdx: i + right });
    if (isLow) raw.push({ idx: i, price: bars[i].low, kind: 'low', confirmedAtIdx: i + right });
  }

  const out = [];
  for (const p of raw) {
    const hit = out.find(o => o.kind === p.kind && Math.abs(o.price - p.price) / o.price <= mergePct);
    if (hit) {
      hit.price = (hit.price * hit.touches + p.price) / (hit.touches + 1);
      hit.touches++;
      hit.lastIdx = Math.max(hit.lastIdx, p.idx);
      hit.confirmedAtIdx = Math.max(hit.confirmedAtIdx, p.confirmedAtIdx);
    } else {
      out.push({ price: p.price, kind: p.kind, touches: 1, firstIdx: p.idx, lastIdx: p.idx, confirmedAtIdx: p.confirmedAtIdx });
    }
  }

  for (const lv of out) {
    let brokenAtIdx = null;
    for (let j = lv.lastIdx + 1; j < n; j++) {
      if (lv.kind === 'high' ? bars[j].close > lv.price : bars[j].close < lv.price) { brokenAtIdx = j; break; }
    }
    lv.brokenAtIdx = brokenAtIdx;
    lv.status = brokenAtIdx === null ? 'active' : 'broken';
    lv.endIdx = brokenAtIdx === null ? n - 1 : brokenAtIdx;
    lv.freshness = n - 1 - lv.lastIdx;
  }

  // 还活着者优先，其次按触碰次数：否则“2010 年碰过 9 次”的线会永久霸占仅有的几个名额
  return out.sort((a, b) => (a.status === b.status
    ? b.touches - a.touches
    : a.status === 'active' ? -1 : 1));
}
