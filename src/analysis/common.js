/**
 * 分析层公共件。
 *
 * 全层硬约束：所有函数只接收「已揭示」的 bar 切片，内部绝不看 idx 之后的数据。
 * 复盘工具一旦用了未来 bar，指标就会“神准”，训练价值归零 —— 这比算错更难被发现。
 */

export function trueRanges(bars) {
  const tr = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0) { tr[i] = b.high - b.low; continue; }
    const pc = bars[i - 1].close;
    tr[i] = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  return tr;
}

/** Wilder ATR（与绝大多数行情软件一致，不是简单移动平均）。 */
export function atr(bars, period = 14) {
  const tr = trueRanges(bars);
  const out = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  out[period - 1] = sum / period;
  for (let i = period; i < bars.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

/**
 * ZigZag 摆动点。阈值用「相对幅度」而不是固定像素：
 * 同一套参数在 3000 点的螺纹和 1800 点的茅台上必须给出同一种“拐点”定义。
 * @returns [{idx, price, type:'high'|'low', confirmedAt}] 交替出现
 *   idx  = 极值所在 bar（价格意义上的拐点）
 *   confirmedAt = 拐点**成立**的那根 bar —— 回撤/反弹首次越过阈值的位置。
 *   两者相差若干根是定义本身决定的，不是实现瑕疵。任何要据此下指令的地方
 *   必须挂在 confirmedAt 上；挂在 idx 上等于拿未来数据给过去下指令。
 */
export function swingPoints(bars, { pct = 0.03, lookback = 2 } = {}) {
  if (bars.length < 3) return [];
  const pts = [];
  let lastHigh = -Infinity, lastHighIdx = -1;
  let lastLow = Infinity, lastLowIdx = -1;
  let dir = 0;   // 1 = 向上腿, -1 = 向下腿, 0 = 未定

  for (let i = 0; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low;
    if (h > lastHigh) { lastHigh = h; lastHighIdx = i; }
    if (l < lastLow) { lastLow = l; lastLowIdx = i; }

    if (dir >= 0) {
      // 上升腿中：只要没从高点回撤超过阈值就继续抬高高点
      if (lastHigh > 0 && (lastHigh - l) / lastHigh >= pct) {
        pts.push({ idx: lastHighIdx, price: lastHigh, type: 'high', confirmedAt: i });
        dir = -1;
        lastLow = l; lastLowIdx = i;
      }
    }
    if (dir <= 0) {
      if (lastLow > 0 && (h - lastLow) / lastLow >= pct) {
        pts.push({ idx: lastLowIdx, price: lastLow, type: 'low', confirmedAt: i });
        dir = 1;
        lastHigh = h; lastHighIdx = i;
      }
    }
  }
  // 去掉同向连续重复，保证 high/low 交替（形态识别依赖交替性）
  const cleaned = [];
  for (const p of pts) {
    const prev = cleaned[cleaned.length - 1];
    if (!prev) { cleaned.push(p); continue; }
    if (prev.type === p.type) {
      if ((p.type === 'high' && p.price > prev.price) || (p.type === 'low' && p.price < prev.price)) {
        cleaned[cleaned.length - 1] = p;
      }
    } else if (p.idx > prev.idx) {
      cleaned.push(p);
    }
  }
  void lookback;
  return cleaned;
}

export const fmtPrice = (v, digits = 2) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  return v.toFixed(digits);
};
