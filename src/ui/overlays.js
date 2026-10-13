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
  pivots: { on: false, type: 'standard', timeframe: 'daily', showHL: true, hlLeft: 5, hlRight: 5 },
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
        out.hl = highLowPivots(revealed, { left: s.pivots.hlLeft, right: s.pivots.hlRight })
          .filter(p => p.price > lo && p.price < hi)
          .slice(0, 6);
      }
    }

    if (s.patterns.on) {
      out.patterns = detectPatterns(revealed, { swingPct: s.patterns.swingPct, maxPatterns: s.patterns.max })
        .filter(p => p.confirmedAtIdx <= end);
      if (out.patterns.length) out.summary.push(`形态 ${out.patterns.map(p => p.label).join('/')}`);
    }

    if (s.zones.on) {
      out.zones = supplyDemandZones(revealed, { maxZones: s.zones.maxZones });
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

    if (d.zones) this._drawZones(ctx, chart, d.zones);
    if (d.vp) this._drawVolumeProfile(ctx, chart, d.vp, start, end);
    if (d.pivots) this._drawPivots(ctx, chart, d.pivots, start, end);
    if (d.hl) this._drawHighLowPivots(ctx, chart, d.hl, start, end);
    if (d.st) this._drawSupertrend(ctx, chart, d.st, start, end);
    if (d.patterns) this._drawPatterns(ctx, chart, d.patterns, start, end);
    if (d.wyckoff) this._drawWyckoff(ctx, chart, d.wyckoff, start, end);

    ctx.restore();

    if (this.summary.length) this._drawSummaryChip(ctx, chart);
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
      ctx.strokeStyle = p.kind === 'high' ? 'rgba(239,68,68,0.45)' : 'rgba(16,185,129,0.45)';
      ctx.setLineDash([1, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(chart.mainWidth, y); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(`${p.kind === 'high' ? 'HL↑' : 'HL↓'}${p.touches}`, chart.mainWidth - 42, y - 2);
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

  _drawPivots(ctx, chart, sets, start, end) {
    const cur = sets.filter(s => s.fromIdx <= end && s.toIdx >= start).slice(-1)[0];
    if (!cur) return;
    const x0 = chart.barIndexToX(Math.max(start, cur.fromIdx));
    const x1 = chart.mainWidth;
    ctx.font = '10px Consolas, monospace';
    for (const [k, v] of Object.entries(cur.levels)) {
      if (v === null || !Number.isFinite(v)) continue;
      const y = chart.priceToY(v);
      const isP = k === 'P';
      const isR = k.startsWith('R');
      ctx.save();
      ctx.strokeStyle = isP ? C.pivot : isR ? 'rgba(239,68,68,0.75)' : 'rgba(16,185,129,0.75)';
      ctx.setLineDash(isP ? [] : [4, 3]);
      ctx.lineWidth = isP ? 1.6 : 1;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(`${cur.type === 'standard' ? '' : cur.type[0].toUpperCase()}${k} ${v.toFixed(2)}`, x0 + 4, y - 2);
      ctx.restore();
    }
  }

  _drawPatterns(ctx, chart, patterns, start, end) {
    ctx.font = '11px system-ui, sans-serif';
    for (const p of patterns) {
      if (p.endIdx < start) continue;
      const color = p.direction === 'bull' ? C.bull : C.bear;
      ctx.save();
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

      const keyLine = (price, label, dash) => {
        const y = chart.priceToY(price);
        ctx.save();
        ctx.strokeStyle = color; ctx.globalAlpha = 0.75;
        if (dash) ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(chart.barIndexToX(p.confirmedAtIdx), y); ctx.lineTo(chart.mainWidth, y); ctx.stroke();
        ctx.fillStyle = color;
        ctx.fillText(`${label} ${price.toFixed(2)}`, chart.barIndexToX(p.confirmedAtIdx) + 6, y - 3);
        ctx.restore();
      };
      keyLine(p.breakout, '突破', [6, 3]);
      keyLine(p.target, '目标', [2, 3]);
      keyLine(p.stop, '止损', [2, 3]);

      const lx = chart.barIndexToX(p.startIdx) + 6;
      const ly = chart.priceToY(p.points[0].price) + (p.direction === 'bull' ? 16 : -8);
      ctx.fillStyle = color;
      ctx.fillText(`${p.label} · 置信 ${(p.confidence * 100).toFixed(0)}%`, lx, ly);
      ctx.restore();
    }
  }

  _drawZones(ctx, chart, zones) {
    for (const z of zones) {
      const x0 = chart.barIndexToX(z.startIdx);
      const yTop = chart.priceToY(z.top), yBot = chart.priceToY(z.bottom);
      ctx.fillStyle = z.kind === 'demand' ? C.demand : C.supply;
      ctx.fillRect(x0, Math.min(yTop, yBot), chart.mainWidth - x0, Math.abs(yBot - yTop));
      ctx.strokeStyle = z.kind === 'demand' ? C.demandEdge : C.supplyEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, Math.min(yTop, yBot), chart.mainWidth - x0, Math.abs(yBot - yTop));
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(`${z.label} ×${z.strength.toFixed(1)}ATR`, x0 + 4, Math.min(yTop, yBot) - 2);
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
