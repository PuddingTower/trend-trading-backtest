/**
 * 形态自动识别 —— 基于摆动点的几何规则。
 *
 * 诚实定位：这是**启发式**，不是带统计验证的识别器。规则宁可保守（少报）也不要
 * 激进（乱报）—— 图上标错一个头肩顶比不标更有害，复盘者会把它当成“市场给过信号”去归因。
 *
 * 头肩的 5 点结构（这点很容易搞错）：左肩-颈线1-头-颈线2-右肩，
 * 顶头肩的摆动点类型是 高低高低高，底头肩是 低高低低高 的镜像。
 * 少了“右肩”那个点就不是头肩 —— 之前用 低-高-低-高-低 判顶，把普通下跌的
 * 任意四个拐点当成了头肩，120 根里报出 4 个。
 *
 * 反未来函数：每个形态带 confirmedAtIdx = 最后一个摆动点被右侧确认的那根。
 */

import { swingPoints } from './common.js';

const tol = (a, b, pct) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) <= pct;

/** 置信度：深度与持续时间各占一半，不 saturate 到 1。 */
function score(depthRatio, durationRatio) {
  const s = 0.55 * Math.min(1, depthRatio / 0.12) + 0.45 * Math.min(1, durationRatio / 1.2);
  return Math.max(0.05, Math.min(0.95, s));
}

function slopeOf(pts) {
  const n = pts.length;
  if (n < 2) return { slope: 0, intercept: n ? pts[0].price : 0 };
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const p of pts) { sx += p.idx; sy += p.price; sxy += p.idx * p.price; sxx += p.idx * p.idx; }
  const d = n * sxx - sx * sx;
  if (Math.abs(d) < 1e-9) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / d;
  return { slope, intercept: (sy - slope * sx) / n };
}
const priceAt = (f, idx) => f.intercept + f.slope * idx;

const MIN_SPAN = 12;   // 少于 12 根摆出来的“形态”多半是噪声

export function detectPatterns(bars, { swingPct = 0.035, confirmRight = 3, maxPatterns = 4 } = {}) {
  const n = (bars || []).length;
  if (n < 30) return [];

  const all = swingPoints(bars, { pct: swingPct });
  const usable = all.filter(p => p.idx + confirmRight <= n - 1);
  if (usable.length < 3) return [];

  const found = [];
  const push = (p) => {
    const lastPt = p.points[p.points.length - 1];
    p.startIdx = p.points[0].idx;
    p.endIdx = lastPt.idx;
    p.confirmedAtIdx = Math.min(n - 1, lastPt.idx + confirmRight);
    found.push(p);
  };

  // ---------- 头肩（5 点：左肩-颈1-头-颈2-右肩） ----------
  for (let i = 0; i + 4 < usable.length; i++) {
    const [a, b, c, d, e] = usable.slice(i, i + 5);
    const span = e.idx - a.idx;
    if (span < MIN_SPAN) continue;

    if (a.type === 'high' && b.type === 'low' && c.type === 'high' && d.type === 'low' && e.type === 'high') {
      const [ls, n1, head, n2, rs] = [a.price, b.price, c.price, d.price, e.price];
      const neck = (n1 + n2) / 2;
      const depth = head - neck;
      if (head > ls && head > rs && depth > 0 &&
          tol(ls, rs, 0.06) &&                    // 两肩对称
          n1 < ls && n2 < rs &&                   // 颈线确实在两肩之下
          Math.abs(n1 - n2) / n1 < 0.08) {        // 颈线近似水平
        push({
          kind: 'head_shoulders_top', direction: 'bear', label: '头肩顶',
          points: [a, b, c, d, e], breakout: neck, target: neck - depth, stop: head,
          confidence: score(depth / head, span / 60)
        });
      }
    }

    if (a.type === 'low' && b.type === 'high' && c.type === 'low' && d.type === 'high' && e.type === 'low') {
      const [ls, n1, head, n2, rs] = [a.price, b.price, c.price, d.price, e.price];
      const neck = (n1 + n2) / 2;
      const depth = neck - head;
      if (head < ls && head < rs && depth > 0 &&
          tol(ls, rs, 0.06) &&
          n1 > ls && n2 > rs &&
          Math.abs(n1 - n2) / n1 < 0.08) {
        push({
          kind: 'head_shoulders_bottom', direction: 'bull', label: '头肩底',
          points: [a, b, c, d, e], breakout: neck, target: neck + depth, stop: head,
          confidence: score(depth / neck, span / 60)
        });
      }
    }
  }

  // ---------- 双顶 / 双底（3 点） ----------
  for (let i = 0; i + 2 < usable.length; i++) {
    const [x1, x2, x3] = usable.slice(i, i + 3);
    if (x3.idx - x1.idx < MIN_SPAN) continue;
    if (x1.type === 'high' && x2.type === 'low' && x3.type === 'high' &&
        tol(x1.price, x3.price, 0.02) && x2.price < Math.min(x1.price, x3.price) * 0.97) {
      const top = Math.max(x1.price, x3.price), neck = x2.price;
      push({
        kind: 'double_top', direction: 'bear', label: '双顶',
        points: [x1, x2, x3], breakout: neck, target: neck - (top - neck), stop: top,
        confidence: score((top - neck) / top, (x3.idx - x1.idx) / 60)
      });
    }
    if (x1.type === 'low' && x2.type === 'high' && x3.type === 'low' &&
        tol(x1.price, x3.price, 0.02) && x2.price > Math.max(x1.price, x3.price) * 1.03) {
      const bot = Math.min(x1.price, x3.price), neck = x2.price;
      push({
        kind: 'double_bottom', direction: 'bull', label: '双底',
        points: [x1, x2, x3], breakout: neck, target: neck + (neck - bot), stop: bot,
        confidence: score((neck - bot) / neck, (x3.idx - x1.idx) / 60)
      });
    }
  }

  // ---------- 三角形 / 楔形 ----------
  for (const w of [6, 5, 4]) {
    for (let i = 0; i + w <= usable.length; i++) {
      const seg = usable.slice(i, i + w);
      const highs = seg.filter(p => p.type === 'high');
      const lows = seg.filter(p => p.type === 'low');
      if (highs.length < 2 || lows.length < 2) continue;

      const span = seg[seg.length - 1].idx - seg[0].idx;
      if (span < MIN_SPAN) continue;

      const hf = slopeOf(highs), lf = slopeOf(lows);
      const ref = seg.reduce((m, p) => Math.max(m, p.price), 0);
      const hs = hf.slope * span / ref, ls = lf.slope * span / ref;
      const FLAT = 0.012, EPS = 0.03;

      let hit = null;
      if (hs < -EPS && ls > EPS) hit = { kind: 'sym_triangle', label: '对称三角形', direction: Math.abs(hs) > Math.abs(ls) ? 'bear' : 'bull' };
      else if (Math.abs(hs) < FLAT && ls > EPS) hit = { kind: 'asc_triangle', label: '上升三角形', direction: 'bull' };
      else if (hs < -FLAT && Math.abs(ls) < FLAT) hit = { kind: 'desc_triangle', label: '下降三角形', direction: 'bear' };
      else if (hs > EPS && ls > EPS && hs < ls - EPS) hit = { kind: 'rising_wedge', label: '上升楔形', direction: 'bear' };
      else if (hs < -EPS && ls < -EPS && hs > ls + EPS) hit = { kind: 'falling_wedge', label: '下降楔形', direction: 'bull' };
      if (!hit) continue;

      const endIdx = Math.max(highs[highs.length - 1].idx, lows[lows.length - 1].idx);
      const height = Math.abs(priceAt(hf, seg[0].idx) - priceAt(lf, seg[0].idx));
      const breakout = hit.direction === 'bull' ? priceAt(hf, endIdx) : priceAt(lf, endIdx);

      push({
        ...hit, points: seg, upperFit: hf, lowerFit: lf, breakout,
        target: hit.direction === 'bull' ? breakout + height : breakout - height,
        stop: hit.direction === 'bull' ? priceAt(lf, endIdx) : priceAt(hf, endIdx),
        confidence: score(height / ref, span / 60)
      });
      i += w - 2;   // 同一个三角形不该被重叠窗口报 5 次
    }
    if (found.some(f => f.upperFit)) break;
  }

  // ---------- 旗形 ----------
  for (let i = 0; i + 3 < usable.length; i++) {
    const a = usable[i], b = usable[i + 1];
    const pole = (b.price - a.price) / a.price;
    if (Math.abs(pole) < 0.06) continue;
    const rest = usable.slice(i + 1, i + 5);
    if (rest.length < 3) continue;
    const hi = Math.max(...rest.map(p => p.price));
    const lo = Math.min(...rest.map(p => p.price));
    if ((hi - lo) / Math.abs(a.price) > Math.abs(pole) * 0.5) continue;

    push({
      kind: pole > 0 ? 'bull_flag' : 'bear_flag',
      label: pole > 0 ? '牛旗' : '熊旗',
      direction: pole > 0 ? 'bull' : 'bear',
      points: [a, b, ...rest],
      breakout: pole > 0 ? hi : lo,
      target: pole > 0 ? b.price + Math.abs(pole) * a.price : b.price - Math.abs(pole) * a.price,
      stop: pole > 0 ? lo : hi,
      confidence: 0.4
    });
    break;
  }

  return dedupeOverlaps(found).slice(0, maxPatterns);
}

/**
 * 同一组摆动点常被多条规则各报一次（头肩顶里也含双顶），保留置信度最高的那个。
 * 不去重的话图上会叠三四层标签，等于没标。
 */
function dedupeOverlaps(list) {
  const sorted = list.slice().sort((x, y) => y.confidence - x.confidence);
  const kept = [];
  for (const p of sorted) {
    const overlaps = kept.some(q => p.startIdx <= q.endIdx && q.startIdx <= p.endIdx);
    if (!overlaps) kept.push(p);
  }
  return kept.sort((x, y) => y.confirmedAtIdx - x.confirmedAtIdx);
}
