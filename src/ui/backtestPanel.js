/**
 * 策略自动回测面板（底部「策略回测」tab 的内容与行为）。
 *
 * 刻意做成「面板只管收集参数和展示结果」，撮合与账目全在 BacktestEngine ——
 * 界面里绝不能自己算盈亏，否则手动复盘与自动回测会出现两套数字。
 */

import { STRATEGIES } from '../strategy/library.js';
import { BacktestEngine } from '../core/backtestEngine.js';
import { computeMetrics, benchmarkCompare } from '../report/metrics.js';
import { resolveTradeSpec } from '../markets/instrumentSpec.js';
import { rulesFor } from '../markets/marketRules.js';

const pct = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (v * 100).toFixed(d) + '%';
const num = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : Number(v).toFixed(d);
const money = (v) => (v === null || !Number.isFinite(v)) ? '—' : Math.round(v).toLocaleString('zh-CN');
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class BacktestPanel {
  constructor(chart, rootId) {
    this.chart = chart;
    this.root = document.getElementById(rootId);
    this.lastResult = null;
    this.render();
  }

  get state() {
    return {
      strategy: this.root.querySelector('#btStrategy').value,
      capital: Number(this.root.querySelector('#btCapital').value) || 200000,
      sizing: this.root.querySelector('#btSizing').value,
      notionalPct: Number(this.root.querySelector('#btNotional').value) / 100 || 0.25,
      lots: Number(this.root.querySelector('#btLots').value) || 1,
      slippageTicks: Number(this.root.querySelector('#btSlip').value) || 0,
      allowShort: this.root.querySelector('#btAllowShort').checked,
      range: this.root.querySelector('#btRange').value
    };
  }

  render() {
    const stratId = this.root.querySelector('#btStrategy')?.value;
    const st = STRATEGIES.find(s => s.id === stratId) || STRATEGIES[0];
    this.root.innerHTML = `
      <div style="display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; padding:8px 4px;">
        <label style="font-size:11px; color:var(--text-muted);">策略
          <select id="btStrategy" class="form-input" style="width:auto;">
            ${STRATEGIES.map(s => `<option value="${s.id}" ${s.id === st.id ? 'selected' : ''}>${s.name}</option>`).join('')}
          </select>
        </label>
        <label style="font-size:11px; color:var(--text-muted);">区间
          <select id="btRange" class="form-input" style="width:auto;">
            <option value="all">全部已加载K线</option>
            <option value="visible">仅已揭示部分</option>
            <option value="y3">最近 3 年</option>
            <option value="y1">最近 1 年</option>
          </select>
        </label>
        <label style="font-size:11px; color:var(--text-muted);">资金
          <input id="btCapital" class="form-input" type="number" value="200000" step="10000" style="width:90px;" /></label>
        <label style="font-size:11px; color:var(--text-muted);">仓位
          <select id="btSizing" class="form-input" style="width:auto;">
            <option value="notional">按名义价值</option>
            <option value="fixed">固定手数</option>
          </select>
        </label>
        <label style="font-size:11px; color:var(--text-muted);">单笔占比%
          <input id="btNotional" class="form-input" type="number" value="25" min="1" max="100" style="width:56px;" /></label>
        <label style="font-size:11px; color:var(--text-muted);">固定手数
          <input id="btLots" class="form-input" type="number" value="1" min="1" style="width:52px;" /></label>
        <label style="font-size:11px; color:var(--text-muted);">滑点tick
          <input id="btSlip" class="form-input" type="number" value="1" min="0" style="width:48px;" /></label>
        <label style="font-size:11px; color:var(--text-muted); display:flex; align-items:center; gap:4px;">
          <input id="btAllowShort" type="checkbox" checked /> 允许做空</label>
        <button class="btn btn-primary btn-sm" id="btRun">▶ 运行回测</button>
        <button class="btn btn-sm" id="btClearMarks">清除图上标记</button>
      </div>
      <div id="btParams" style="display:flex; flex-wrap:wrap; gap:10px; padding:0 4px 8px; border-bottom:1px solid var(--border-color);"></div>
      <div id="btOut" style="padding:8px 4px; color:var(--text-muted); font-size:12px;">
        选策略与参数后点【运行回测】。成交口径为<b style="color:var(--accent-gold);">信号次日开盘成交</b>，
        含手续费、平今费与滑点；跳空穿透止损按开盘价成交，不做美化。
      </div>`;
    this.renderParams();
    this.root.querySelector('#btStrategy').addEventListener('change', () => this.renderParams());
    this.root.querySelector('#btRun').addEventListener('click', () => this.run());
    this.root.querySelector('#btClearMarks').addEventListener('click', () => {
      this.chart.backtestMarkers = null; this.chart.requestRender();
    });
  }

  renderParams() {
    const st = STRATEGIES.find(s => s.id === this.root.querySelector('#btStrategy').value);
    const box = this.root.querySelector('#btParams');
    box.innerHTML = Object.entries(st.params).map(([k, v]) => {
      const isBool = typeof v === 'boolean';
      const isStr = typeof v === 'string';
      const input = isBool
        ? `<input data-p="${k}" data-t="bool" type="checkbox" ${v ? 'checked' : ''} style="width:auto;" />`
        : isStr
          ? `<input data-p="${k}" data-t="str" value="${esc(v)}" class="form-input" style="width:70px;" />`
          : `<input data-p="${k}" data-t="num" type="number" value="${v}" step="${Math.abs(v) < 1 ? 0.05 : 1}" class="form-input" style="width:64px;" />`;
      return `<label style="font-size:11px; color:var(--text-muted); display:flex; align-items:center; gap:4px;">${k} ${input}</label>`;
    }).join('') + `<span style="font-size:11px; color:var(--text-muted); align-self:center;">— ${esc(st.name)} 默认参数</span>`;
  }

  collectParams() {
    const st = STRATEGIES.find(s => s.id === this.root.querySelector('#btStrategy').value);
    const out = {};
    this.root.querySelectorAll('#btParams [data-p]').forEach(el => {
      const t = el.getAttribute('data-t'), k = el.getAttribute('data-p');
      out[k] = t === 'bool' ? el.checked : t === 'num' ? Number(el.value) : el.value;
    });
    return { def: st, id: st.id, params: out };
  }

  sliceBars(range) {
    const all = this.chart.data;
    const revealed = all.slice(0, this.chart.visibleDataCount);
    if (range === 'visible') return revealed;
    const src = range === 'all' ? all : revealed;
    if (range === 'y1' || range === 'y3') {
      const n = range === 'y1' ? 250 : 750;
      return src.slice(Math.max(0, src.length - n));
    }
    return src;
  }

  run() {
    const out = this.root.querySelector('#btOut');
    const code = this.chart.backtestCode || this.chart.data?.[0]?.symbol;
    const bars = this.sliceBars(this.state.range);
    if (!bars || bars.length < 60) {
      out.innerHTML = `<span style="color:var(--up-color);">K线不足 60 根，先在线同步一个品种再回测。</span>`;
      return;
    }

    const resolved = resolveTradeSpec(code || 'RB0');
    if (!resolved.ok) {
      out.innerHTML = `<span style="color:var(--up-color);">代码 ${esc(code)} 无法解析：${esc(resolved.reason)}</span>`;
      return;
    }
    const spec = resolved.spec;
    const { def, params } = this.collectParams();
    const s = this.state;

    let res;
    try {
      const signals = def.signals(bars, params);
      const rules = rulesFor(spec);
      if (!s.allowShort && rules.canOpen(-1).ok) { rules.spec = { ...spec, allowShort: false }; }
      const eng = new BacktestEngine(bars, spec, {
        capital: s.capital, sizing: s.sizing, notionalPct: s.notionalPct,
        lots: s.lots, slippageTicks: s.slippageTicks, allowShort: s.allowShort,
        rules
      });
      const raw = eng.run(signals);
      const metrics = computeMetrics({
        equityCurve: raw.equityCurve, trades: raw.trades, capital: s.capital,
        periodsPerYear: this.chart.periodsPerYear || 252, bars
      });
      res = { ...raw, metrics, bars, spec, strategy: def.name, params, signals, rejected: raw.rejected };
    } catch (e) {
      out.innerHTML = `<span style="color:var(--up-color);">回测失败：${esc(e.message)}</span>`;
      console.error(e);
      return;
    }

    this.lastResult = res;
    // 回测跑的是全部K线，但复盘游标可能只揭示了前 120 根 —— 不展开的话
    // 用户点了「运行回测」会看到一张什么标记都没有的图，以为功能没生效。
    if (this.state.range !== 'visible' && this.chart.visibleDataCount < bars.length) {
      this.chart.setVisibleCount(bars.length);
    }
    this.paintMarkers(res);
    this.paintReport(res, resolved);
  }

  /** 把成交点交给图表绘制（复用图表坐标系，不在面板里另画一张图）。 */
  paintMarkers(res) {
    this.chart.backtestMarkers = res.trades.map(t => ({
      entryIdx: t.entryIdx, exitIdx: t.exitIdx, entryPrice: t.entryPrice,
      exitPrice: t.exitPrice, dir: t.dir, netPnL: t.netPnL, lots: t.lots
    }));
    this.chart.requestRender();
  }

  paintReport(res, resolved) {
    const m = res.metrics;
    // 基准要换算成「同样这么多钱、同样手数」的权益，不能直接拿价格除资金：
    // 价格量级（5000 点）和权益量级（20 万元）不同底，相减得到的“超额”毫无意义。
    const lots0 = res.trades.length ? res.trades[0].lots : 1;
    const benchEquity = res.bars.map(b => res.capital + (b.close - res.bars[0].open) * res.spec.multiplier * lots0);
    const cmp = benchmarkCompare(res.equityCurve.map(p => p.equity), benchEquity, res.capital);
    const card = (label, value, cls = '') =>
      `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value ${cls}">${value}</div></div>`;
    const sign = v => (v > 0 ? 'val-up' : v < 0 ? 'val-down' : '');

    const years = Object.entries(m.byYear || {}).map(([y, v]) =>
      `<tr><td>${y}</td><td class="${sign(v.ret)}">${pct(v.ret)}</td></tr>`).join('');
    const reasons = Object.entries(m.byReason || {}).map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td>${v.n}</td><td class="${sign(v.pnl)}">${money(v.pnl)}</td></tr>`).join('');

    this.root.querySelector('#btOut').innerHTML = `
      ${m.ruined ? `<div style="color:var(--up-color); font-weight:700; padding:6px 0;">⚠ 本次回测权益曾归零或转负：年化/Sharpe 无意义，仓位口径过激进，别把它当业绩。</div>` : ''}
      ${resolved.warning ? `<div style="color:var(--accent-gold); padding:4px 0;">${esc(resolved.warning)}</div>` : ''}
      <div class="kpi-bar" style="margin:6px 0;">
        ${card('总收益率', pct(m.totalReturn), sign(m.totalReturn))}
        ${card('年化', pct(m.annualReturn), sign(m.annualReturn))}
        ${card('最大回撤', pct(m.maxDDPct), 'val-down')}
        ${card('Sharpe', num(m.sharpe))}
        ${card('Calmar', num(m.calmar))}
        ${card('胜率', pct(m.winRate))}
        ${card('盈亏比', num(m.payoffRatio, 2))}
        ${card('交易次数', m.trades)}
      </div>
      <div style="display:flex; gap:24px; flex-wrap:wrap; font-size:11px; color:var(--text-muted); padding:4px 0;">
        <span>品种 <b style="color:var(--text-main);">${esc(res.spec.name || '')} / ${esc(resolved.parsed.contractCode || resolved.parsed.code || '')}</b></span>
        <span>策略 <b style="color:var(--text-main);">${esc(res.strategy)}</b></span>
        <span>参数 <b>${esc(JSON.stringify(res.params))}</b></span>
        <span>区间 <b>${res.bars[0].date} → ${res.bars[res.bars.length - 1].date}</b>（${res.bars.length} 根）</span>
        <span>期末权益 <b>${money(m.finalEquity)}</b></span>
        <span>总手续费 <b>${money(m.totalFees)}</b></span>
        <span>持仓占比 <b>${pct(m.exposure, 0)}</b></span>
        <span>平均持仓 <b>${num(m.avgHoldingBars, 1)} 根</b></span>
        <span>资金不足拒单 <b>${res.rejected.margin}</b></span>
        <span>强平次数 <b>${res.rejected.marginCalls || 0}</b></span>
        <span>涨停买不进 <b>${res.rejected.boardLock || 0}</b></span>
        <span>T+1/方向被拒 <b>${(res.rejects || []).filter(x => x.kind === 'tPlus1').length} / ${res.rejected.rules || 0}</b></span>
        <span>同期持有涨幅 <b class="${sign(cmp.benchReturn)}">${pct(cmp.benchReturn)}</b></span>
        <span>超额 <b class="${sign(cmp.alpha)}">${pct(cmp.alpha)}</b></span>
      </div>
      <div style="display:flex; gap:20px; flex-wrap:wrap;">
        <table class="data-table" style="flex:1; min-width:220px;"><thead><tr><th>年份</th><th>收益</th></tr></thead><tbody>${years}</tbody></table>
        <table class="data-table" style="flex:1.4; min-width:260px;"><thead><tr><th>进出场原因</th><th>笔数</th><th>合计盈亏</th></tr></thead><tbody>${reasons}</tbody></table>
      </div>
      <div style="margin-top:8px; max-height:180px; overflow:auto;">
        <table class="data-table"><thead><tr>
          <th>#</th><th>方向</th><th>开仓</th><th>开价</th><th>平仓</th><th>平价</th><th>手数</th><th>净盈亏</th><th>持仓</th><th>出场原因</th>
        </tr></thead><tbody>
        ${res.trades.slice(-60).map(t => `<tr>
          <td>${t.id}</td>
          <td class="${t.dir === 'long' ? 'val-up' : 'val-down'}">${t.dir === 'long' ? '多' : '空'}</td>
          <td>${t.entryDate}</td><td>${num(t.entryPrice, 2)}</td>
          <td>${t.exitDate}</td><td>${num(t.exitPrice, 2)}</td>
          <td>${t.lots}</td>
          <td class="${sign(t.netPnL)}">${money(t.netPnL)}</td>
          <td>${t.holdingBars}</td><td>${esc(t.exitReason)}</td></tr>`).join('')}
        </tbody></table>
        ${res.trades.length > 60 ? `<div style="font-size:11px; color:var(--text-muted);">仅显示最近 60 笔，共 ${res.trades.length} 笔</div>` : ''}
      </div>`;
  }
}
