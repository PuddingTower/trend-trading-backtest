/**
 * 叠加指标渲染层（TradingView 式开关背后的绘制部分）。
 *
 * 三条硬规矩：
 * 1. 只喂已揭示的 bar：所有计算基于 bars[0 .. visibleDataCount-1]，
 *    渲染区间是 [start, end]。算错一个下标就会让复盘“未卜先知”。
 * 2. 一律 clip 到价格区（右侧 priceScaleWidth 与底部 timeScaleHeight 不给画），
 *    否则标签会盖住价格刻度，看起来像 bug。
 * 3. 结果按 key 缓存：render() 每帧都跑，逐帧重算 VP/形态会把播放拖成幻灯片。
 */

import { volumeProfile, autoAnchorRange } from '../analysis/volumeProfile.js';
import { supertrend } from '../analysis/supertrend.js';
import { computePivots, highLowPivots } from '../analysis/pivots.js';
import { detectPatterns } from '../analysis/patterns.js';
import { supplyDemandZones, wyckoffEvents } from '../analysis/zones.js';

const C = {
  poc: '#f59e0b', va: 'rgba(41, 98, 255, 0.30)', vaEdge: '#2962ff',
  hvn: '#8b5cf6', lvn: '#848c9e',
  up: '#ef4444', down: '#10b981',
  pivot: '#06b6d4', text: '#d1d5db', muted: '#848c9e',
  demand: 'rgba(16, 185, 129, 0.16)', demandEdge: '#10b981',
  supply: 'rgba(239, 68, 68, 0.16)', supplyEdge: '#ef4444',
  bull: '#ef4444', bear: '#10b981'
};

export const DEFAULT_OVERLAY_STATE = {
  vp: { on: false, bins: 48, vaPct: 0.70, mode: 'auto', lookback: 250, width: 0.22 },
  supertrend: { on: false, period: 10, multiplier: 3 },
  pivots: { on: false, type: 'standard', timeframe: 'daily', showHL: true, hlLeft: 5, hlRight: 5, visibleSets: 3 },
  patterns: { on: false, swingPct: 0.035, max: 4 },
  zones: { on: false, maxZones: 6, wyckoff: true }
};

export class OverlayManager {
  constructor(state = null) {
    this.state = JSON.parse(JSON.stringify(DEFAULT_OVERLAY_STATE));
    if (state) this.merge(state);
    this._key = null;
    this._cache = null;
    this.summary = [];
  }

  merge(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (this.state[k]) Object.assign(this.state[k], v);
    }
    this._key = null;   // 参数一变即失效
  }

  toggle(name) {
    if (!this.state[name]) return false;
    this.state[name].on = !this.state[name].on;
    return this.state[name].on;
  }

  get anyOn() {
    return Object.values(this.state).some(s => s.on);
  }

  _compute(chart, revealed, start, end) {
    const s = this.state;
    const out = { summary: [] };

    if (s.vp.on) {
      let range = { startIdx: Math.max(0, start), endIdx: end };
      if (s.vp.mode === 'auto') {
        const a = autoAnchorRange(revealed, { lookback: s.vp.lookback });
        if (a) range = { startIdx: a.startIdx, endIdx: a.endIdx, anchor: a };
      } else if (s.vp.mode === 'visible') {
        range = { startIdx: Math.max(0, start), endIdx: end };
      } else if (s.vp.mode === 'lookback') {
        range = { startIdx: Math.max(0, end - s.vp.lookback), endIdx: end };
      }
      const slice = revealed.slice(range.startIdx, range.endIdx + 1);
      const prof = volumeProfile(slice, { bins: s.vp.bins, valueAreaPct: s.vp.vaPct });
      if (prof) {
        out.vp = { ...prof, startIdx: range.startIdx, endIdx: range.endIdx, anchor: range.anchor };
        out.summary.push(`POC ${prof.poc.price.toFixed(2)} · VAH ${prof.vah.toFixed(2)} · VAL ${prof.val.toFixed(2)}`);
      }
    }

    if (s.supertrend.on) {
      const st = supertrend(revealed, { period: s.supertrend.period, multiplier: s.supertrend.multiplier });
      const last = [...st].reverse().find(Boolean);
      out.st = st;
      if (last) out.summary.push(`SuperTrend ${last.trend === 1 ? '多头' : '空头'} @ ${last.value.toFixed(2)}`);
    }

    if (s.pivots.on) {
      out.pivots = computePivots(revealed, { type: s.pivots.type, timeframe: s.pivots.timeframe });
      if (s.pivots.showHL) {
        // 分形摆动位一多就把图糊成网格：只留触碰最多的 6 条，且必须落在当前可见价位内
        const lo = chart.currentPriceRange ? chart.currentPriceRange.minPrice : -Infinity;
        const hi = chart.currentPriceRange ? chart.currentPriceRange.maxPrice : Infinity;
        // endIdx >= start：早就被穿越失效的线不再占名额（排序已让活线优先）
        out.hl = highLowPivots(revealed, { left: s.pivots.hlLeft, right: s.pivots.hlRight })
          .filter(p => p.price > lo && p.price < hi && p.endIdx >= start)
          .slice(0, 6);
      }
    }

    if (s.patterns.on) {
      // 这里原来是 .filter(p => p.confirmedAtIdx <= end)，恒真、什么也没过滤掉。
      // 真正的可见性判据是“生命周期还没走完，或走完的位置仍在窗口内”。
      out.patterns = detectPatterns(revealed, { swingPct: s.patterns.swingPct, maxPatterns: s.patterns.max })
        .filter(p => (p.resolvedAtIdx === null ? end : p.resolvedAtIdx) >= start);
      if (out.patterns.length) {
        out.summary.push(`形态 ${out.patterns.map(p => `${p.label}·${p.stateLabel}`).join(' / ')}`);
      }
    }

    if (s.zones.on) {
      out.zones = supplyDemandZones(revealed, { maxZones: s.zones.maxZones })
        .filter(z => z.endIdx >= start);
      if (s.zones.wyckoff) out.wyckoff = wyckoffEvents(revealed, {}).filter(e => e.idx <= end).slice(-8);
      if (out.zones.length) out.summary.push(`供需区 ${out.zones.length} 个`);
    }
    return out;
  }

  render(chart) {
    if (!this.anyOn) { this.summary = []; return; }
    const { ctx } = chart;
    const end = chart.visibleDataCount - 1;
    const { startIdx } = chart.calcVisibleRange();
    const start = Math.max(0, startIdx);
    if (end < 1) return;

    const revealed = chart.data.slice(0, end + 1);
    const key = JSON.stringify(this.state) + '|' + end + '|' + (chart.data.length || 0) + '|' + (chart.data[0] && chart.data[0].date);
    if (key !== this._key) { this._key = key; this._cache = this._compute(chart, revealed, start, end); }
    const d = this._cache;
    this.summary = d.summary || [];

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, chart.mainWidth, chart.klineHeight);
    ctx.clip();

    if (d.zones) this._drawZones(ctx, chart, d.zones, start, end);
    if (d.vp) this._drawVolumeProfile(ctx, chart, d.vp, start, end);
    if (d.pivots) this._drawPivots(ctx, chart, d.pivots, start, end);
    if (d.hl) this._drawHighLowPivots(ctx, chart, d.hl, start, end);
    if (d.st) this._drawSupertrend(ctx, chart, d.st, start, end);
    if (d.patterns) this._drawPatterns(ctx, chart, d.patterns, start, end);
    if (d.wyckoff) this._drawWyckoff(ctx, chart, d.wyckoff, start, end);

    ctx.restore();

    if (this.summary.length) this._drawSummaryChip(ctx, chart);
  }

  /**
   * 某根 bar 的右边缘 x。
   * 叠加层的线必须截止在这里，而不是一路拖到 mainWidth —— 「拖到最右边」是这一层
   * 原先最主要的观感问题：一期的日枢轴、一条早已失效的摆动位、一个走完了的形态
   * 都会被拉成横贯全屏的报价线，看起来都还是“当前有效”。
   */
  _barRight(chart, idx) {
    return Math.min(chart.mainWidth, chart.barIndexToX(idx) + (chart.barWidth + chart.barSpacing) / 2);
  }

  _drawVolumeProfile(ctx, chart, vp, start, end) {
    const w = chart.mainWidth * this.state.vp.width;
    const right = chart.mainWidth - 4;
    const maxV = vp.poc.volume || 1;

    for (const b of vp.bins) {
      const y = chart.priceToY(b.center);
      const h = Math.max(1, Math.abs(chart.priceToY(b.low) - chart.priceToY(b.high)) - 0.5);
      const len = (b.volume / maxV) * w;
      ctx.fillStyle = b.isPOC ? 'rgba(245,158,11,0.55)' : b.inVA ? C.va : 'rgba(132,140,158,0.20)';
      ctx.fillRect(right - len, y - h / 2, len, h);
    }

    const line = (price, color, label, dash) => {
      const y = chart.priceToY(price);
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = 1.4;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(chart.mainWidth, y); ctx.stroke();
      ctx.fillStyle = color; ctx.font = '11px Consolas, monospace';
      ctx.fillText(label, 6, y - 3);
      ctx.restore();
    };
    line(vp.poc.price, C.poc, `POC ${vp.poc.price.toFixed(2)}`, null);
    line(vp.vah, C.vaEdge, `VAH ${vp.vah.toFixed(2)}`, [5, 3]);
    line(vp.val, C.vaEdge, `VAL ${vp.val.toFixed(2)}`, [5, 3]);

    for (const b of vp.bins.filter(x => x.isLVN).slice(0, 6)) {
      const y = chart.priceToY(b.center);
      ctx.save();
      ctx.strokeStyle = C.lvn; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(chart.barIndexToX(start), y); ctx.lineTo(right - w, y); ctx.stroke();
      ctx.fillStyle = C.lvn; ctx.font = '10px Consolas, monospace';
      ctx.fillText('LVN', chart.barIndexToX(start) + 4, y - 2);
      ctx.restore();
    }

    // 锚定点标出来，用户才知道这张剖面是从哪根开始算的
    const ax = chart.barIndexToX(vp.startIdx);
    ctx.save();
    ctx.strokeStyle = 'rgba(139,92,246,0.8)'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ax, 0); ctx.lineTo(ax, chart.klineHeight); ctx.stroke();
    ctx.fillStyle = C.hvn; ctx.font = '10px Consolas, monospace';
    ctx.fillText(vp.anchor ? `锚定 ${vp.anchor.anchorType === 'high' ? '顶' : '底'}` : '锚定', ax + 3, 12);
    ctx.restore();
  }

  _drawHighLowPivots(ctx, chart, list, start, end) {
    if (!list.length) return;
    ctx.save();
    ctx.font = '10px Consolas, monospace';
    for (const p of list) {
      const y = chart.priceToY(p.price);
      const x0 = chart.barIndexToX(Math.max(start, p.confirmedAtIdx));
      const x1 = this._barRight(chart, Math.min(p.endIdx, end));
      if (x1 <= x0) continue;                      // 窗口整段都在失效点之后：这条线没有信息量
      const broken = p.status === 'broken';
      ctx.save();
      ctx.globalAlpha = broken ? 0.4 : 1;
      ctx.strokeStyle = p.kind === 'high' ? 'rgba(239,68,68,0.45)' : 'rgba(16,185,129,0.45)';
      ctx.setLineDash([1, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(`${p.kind === 'high' ? 'HL↑' : 'HL↓'}${p.touches}${broken ? '破' : ''}`,
        Math.max(0, x1 - 40), y - 2);
      ctx.restore();
    }
    ctx.restore();
  }

  _drawSupertrend(ctx, chart, st, start, end) {
    ctx.lineWidth = 1.8;
    let prev = null;
    for (let i = start; i <= end; i++) {
      const cur = st[i];
      if (!cur) { prev = null; continue; }
      if (prev) {
        ctx.strokeStyle = cur.trend === 1 ? C.up : C.down;
        ctx.beginPath();
        ctx.moveTo(chart.barIndexToX(i - 1), chart.priceToY(prev.value));
        ctx.lineTo(chart.barIndexToX(i), chart.priceToY(cur.value));
        ctx.stroke();
      }
      prev = cur;
    }
  }

  /**
   * 每期枢轴只在自己的 [fromIdx, toIdx] 内画 —— 日级枢轴本来就是“当日有效”的报价，
   * 拖过收盘点就变成在替后面的日子报价。
   * 原先这里只取 slice(-1)[0] 画一组并拉到右边缘：日级 timeframe 下一屏几百根只出 1 组枢轴，
   * 看着像随机出现的一条线。现在按 visibleSets 显示最近几期，历史期淡出且不再叠标签。
   */
  _drawPivots(ctx, chart, sets, start, end) {
    const inView = sets.filter(s => s.toIdx >= start && s.fromIdx <= end);
    if (!inView.length) return;
    const count = Math.max(1, Math.min(20, this.state.pivots.visibleSets | 0 || 3));
    const shown = inView.slice(-count);
    ctx.font = '10px Consolas, monospace';

    shown.forEach((cur, i) => {
      const isLatest = i === shown.length - 1;
      const x0 = chart.barIndexToX(Math.max(start, cur.fromIdx));
      const x1 = this._barRight(chart, Math.min(cur.toIdx, end));
      if (x1 <= x0) return;
      ctx.save();
      ctx.globalAlpha = isLatest ? 1 : 0.38;
      for (const [k, v] of Object.entries(cur.levels)) {
        if (v === null || !Number.isFinite(v)) continue;
        const y = chart.priceToY(v);
        const isP = k === 'P';
        const isR = k.startsWith('R');
        ctx.strokeStyle = isP ? C.pivot : isR ? 'rgba(239,68,68,0.75)' : 'rgba(16,185,129,0.75)';
        ctx.setLineDash(isP ? [] : [4, 3]);
        ctx.lineWidth = isP ? 1.6 : 1;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        if (isLatest) {
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fillText(`${cur.type === 'standard' ? '' : cur.type[0].toUpperCase()}${k} ${v.toFixed(2)}`, x0 + 4, y - 2);
        }
      }
      ctx.restore();
    });
  }

  _drawPatterns(ctx, chart, patterns, start, end) {
    ctx.font = '11px system-ui, sans-serif';
    for (const p of patterns) {
      if (p.endIdx < start) continue;
      const color = p.direction === 'bull' ? C.bull : C.bear;
      // 三条关键位只在生命周期内有效：走完了（达标/失效/过期）就截止在那一根
      const lastIdx = p.resolvedAtIdx === null ? end : Math.min(p.resolvedAtIdx, end);
      const settled = p.resolvedAtIdx !== null;
      ctx.save();
      ctx.globalAlpha = settled ? 0.55 : 1;
      ctx.strokeStyle = color; ctx.lineWidth = 1.6;
      ctx.beginPath();
      p.points.forEach((pt, i) => {
        const x = chart.barIndexToX(pt.idx), y = chart.priceToY(pt.price);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      if (p.upperFit) {
        const a = p.points[0].idx, b = p.points[p.points.length - 1].idx;
        ctx.moveTo(chart.barIndexToX(a), chart.priceToY(p.upperFit.intercept + p.upperFit.slope * a));
        ctx.lineTo(chart.barIndexToX(b), chart.priceToY(p.upperFit.intercept + p.upperFit.slope * b));
        ctx.moveTo(chart.barIndexToX(a), chart.priceToY(p.lowerFit.intercept + p.lowerFit.slope * a));
        ctx.lineTo(chart.barIndexToX(b), chart.priceToY(p.lowerFit.intercept + p.lowerFit.slope * b));
      }
      ctx.stroke();

      const x0 = chart.barIndexToX(Math.max(start, p.confirmedAtIdx));
      const x1 = this._barRight(chart, lastIdx);
      const keyLine = (price, label, dash) => {
        if (x1 <= x0) return;
        const y = chart.priceToY(price);
        ctx.save();
        ctx.strokeStyle = color; ctx.globalAlpha = settled ? 0.4 : 0.75;
        if (dash) ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.fillStyle = color;
        ctx.fillText(`${label} ${price.toFixed(2)}`, x0 + 6, y - 3);
        ctx.restore();
      };
      keyLine(p.breakout, '突破', [6, 3]);
      keyLine(p.target, '目标', [2, 3]);
      keyLine(p.stop, '止损', [2, 3]);

      const lx = chart.barIndexToX(p.startIdx) + 6;
      const ly = chart.priceToY(p.points[0].price) + (p.direction === 'bull' ? 16 : -8);
      ctx.fillStyle = color;
      ctx.fillText(`${p.label} · 置信 ${(p.confidence * 100).toFixed(0)}% · ${p.stateLabel}`, lx, ly);
      if (p.state === 'brokenOut' && p.breakoutAtIdx !== null && p.breakoutAtIdx <= end) {
        const bx = chart.barIndexToX(p.breakoutAtIdx);
        ctx.beginPath(); ctx.arc(bx, chart.priceToY(p.breakout), 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  _drawZones(ctx, chart, zones, start, end) {
    for (const z of zones) {
      const x0 = chart.barIndexToX(z.startIdx);
      const x1 = this._barRight(chart, Math.min(z.endIdx, end));
      if (x1 <= x0) continue;                       // 整段在窗口左侧，或早已走完全程
      const yTop = chart.priceToY(z.top), yBot = chart.priceToY(z.bottom);
      const suffix = z.status === 'broken' ? '·已失效' : z.status === 'forming' ? '·形成中' : '';
      ctx.save();
      if (z.status === 'broken') ctx.globalAlpha = 0.5;
      ctx.fillStyle = z.kind === 'demand' ? C.demand : C.supply;
      ctx.fillRect(x0, Math.min(yTop, yBot), x1 - x0, Math.abs(yBot - yTop));
      ctx.strokeStyle = z.kind === 'demand' ? C.demandEdge : C.supplyEdge;
      ctx.lineWidth = 1;
      // 没走完的结构右边界用虚线，视觉上就和已成立的区分开
      if (z.status !== 'active') ctx.setLineDash([4, 3]);
      ctx.strokeRect(x0, Math.min(yTop, yBot), x1 - x0, Math.abs(yBot - yTop));
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(`${z.label} ×${z.strength.toFixed(1)}ATR${suffix}`, x0 + 4, Math.min(yTop, yBot) - 2);
      ctx.restore();
    }
  }

  _drawWyckoff(ctx, chart, events, start, end) {
    ctx.font = '10px system-ui, sans-serif';
    for (const e of events) {
      if (e.idx < start || e.idx > end) continue;
      const bar = chart.data[e.idx];
      const x = chart.barIndexToX(e.idx);
      const isBull = e.kind === 'spring' || e.kind === 'sos';
      const y = chart.priceToY(isBull ? bar.low : bar.high);
      ctx.fillStyle = isBull ? C.bull : C.bear;
      ctx.beginPath();
      const dir = isBull ? 1 : -1;
      ctx.moveTo(x, y); ctx.lineTo(x - 5, y + 10 * dir); ctx.lineTo(x + 5, y + 10 * dir); ctx.closePath();
      ctx.fill();
      ctx.fillText(e.label, x + 7, y + 8 * dir);
    }
  }

  _drawSummaryChip(ctx, chart) {
    const text = this.summary.join('   ');
    ctx.save();
    ctx.font = '11px Consolas, monospace';
    const w = Math.min(chart.mainWidth - 8, ctx.measureText(text).width + 14);
    ctx.fillStyle = 'rgba(18,21,28,0.82)';
    ctx.fillRect(4, chart.klineHeight - 20, w, 16);
    ctx.strokeStyle = 'rgba(42,49,66,0.9)';
    ctx.strokeRect(4, chart.klineHeight - 20, w, 16);
    ctx.fillStyle = C.text;
    ctx.fillText(text, 10, chart.klineHeight - 8);
    ctx.restore();
  }
}
