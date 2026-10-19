/**
 * 研究面板（M5）：参数寻优、Walk-Forward、组合回测、高级报表。
 *
 * 面板只做编排与展示，算法全在 report/optimizer.js、core/portfolio.js、report/advanced.js ——
 * 那些是纯函数，能离线单测；把算法写进 DOM 里就没法验证它了。
 *
 * 关于 Worker：优先用 module worker（分块并行 + 进度条），拿不到就退回主线程分块跑。
 * 两条路径跑的是同一份 gridRunner / walkForward，不存在"Worker 版和主线程版结果不同"这种可能。
 */

import { STRATEGIES, getStrategy } from '../strategy/library.js';
import { OBJECTIVES, gridRunner, walkForward, neighborhoodScore, runOne } from '../report/optimizer.js';
import { simulatePaths, parameterHeatmap, costStress, DEFAULT_COST_SCENARIOS } from '../report/monteCarlo.js';
import { runPortfolio } from '../core/portfolio.js';
import { PortfolioEngine } from '../core/portfolioEngine.js';
import { computeMetrics } from '../report/metrics.js';
import { monthlyReturns, underwaterSeries, tradeDistribution, benchmarkSeries, reportToCsv, reportToHtml } from '../report/advanced.js';
import { resolveTradeSpec } from '../markets/instrumentSpec.js';
import { rulesFor } from '../markets/marketRules.js';
import { scanUniverse, filterRows, sortRows, scanSummary } from '../markets/scanner.js';
import { rotationSignals, rotationSnapshot } from '../core/rotation.js';
import { buyHold } from '../core/backtestEngine.js';

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pc = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (v * 100).toFixed(d) + '%';
const nf = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : Number(v).toFixed(d);
const INP = 'background:var(--bg-tertiary);color:#fff;border:1px solid var(--border-color);padding:5px 7px;border-radius:4px;font-size:13px;';
const BTN = 'background:var(--bg-tertiary);color:var(--text-main);border:1px solid var(--border-color);padding:7px 12px;border-radius:4px;font-size:13px;cursor:pointer;min-height:34px;';
const BTN_HI = 'background:rgba(41,98,255,.18);color:#93c5fd;border:1px solid var(--accent-blue);padding:7px 12px;border-radius:4px;font-size:13px;cursor:pointer;min-height:34px;';
const MON = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

/** 默认网格：每个策略给一组"合理范围内该试试"的参数，用户可以直接改。 */
const DEFAULT_GRIDS = {
  maCross: { fast: [5, 10, 20], slow: [20, 40, 60], trailAtr: [0, 3] },
  donchianBreak: { entry: [20, 40, 55, 70], exit: [10, 20], stopAtr: [0, 2, 3] },
  dualThrust: { n: [3, 5, 7], k1: [0.4, 0.5, 0.7], k2: [0.4, 0.5, 0.7] },
  macdTrend: { fast: [8, 12], slow: [20, 26, 34], signal: [7, 9], trailAtr: [0, 2, 3] },
  hhLlStructure: { swingPct: [0.02, 0.035, 0.05], trailAtr: [2, 2.5, 3.5] },
  rsiReversion: { period: [7, 14, 21], low: [20, 30], high: [70, 80] },
  minerviniTemplate: { pivotLook: [15, 25, 40], pivotVolMul: [1, 1.2, 1.8], stopPct: [0.05, 0.075, 0.1] },
  trendRegime: { breakout: [20, 40, 55], adxMin: [0, 20, 25], stopAtr: [2, 2.5, 3.5], trailAtr: [0, 3] },
  nVolumePattern: { startMul: [1.5, 1.8, 2.5], breakMul: [1.2, 1.5, 2], maxPull: [5, 8, 12] }
};

/**
 * 参数网格解析。必须同时吃两种写法，因为文本框里的默认值就是 JSON 生成的：
 *   {"entry": [20,40,55], "stopAtr": [0,2]}          ← 默认展示格式，也是"导出/复用"格式
 *   entry: 20,40,55                                  ← 手打更快
 * 只认后者的话，用户什么都没改、直接点"开始寻优"就会看到"网格是空的" ——
 * 而那个提示会让他以为是自己的数据有问题。
 */
function parseGrid(text) {
  const raw = String(text || '').trim();
  if (!raw) return {};
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v) && v.length) out[k] = v;
        else if (v !== null && typeof v !== 'object') out[k] = [v];
      }
      return out;
    } catch (e) {
      // 常见的半截 JSON（多一个逗号、少一个括号）：明确报错，别静默当空网格
      return { __error: `JSON 解析失败：${e.message}` };
    }
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*"?([A-Za-z_][\w]*)"?\s*[:=]\s*(.+?)\s*,?\s*$/.exec(line);
    if (!m) continue;
    const vals = m[2].replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
      .map(s => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s));
    if (vals.length) out[m[1]] = vals;
  }
  return out;
}

export class ResearchPanel {
  /**
   * @param {string} rootId
   * @param {{chart:object, toast:Function, watchlistItems:Function, runBacktestWith:Function}} api
   */
  constructor(rootId, api) {
    this.root = document.getElementById(rootId);
    this.api = api || {};
    this.tab = 'grid';
    this.gridRows = null;
    this.wf = null;
    this.portfolio = null;
    this.report = null;
    this.busy = '';
    this.progress = null;
    this.scanSortKey = 'score';
    this.scanSortDir = 'desc';
    this._worker = null;
    this.bind();
    this.render();
  }

  get code() { return this.api.chart?.currentSymbol || 'RB0'; }
  get bars() { return (this.api.chart?.data) || []; }

  /** Worker 起不来就退回主线程分块，功能不减，只是慢一点、UI 会卡一下。 */
  worker() {
    if (this._worker !== null) return this._worker;
    try {
      const url = new URL('../report/optimizeWorker.js', import.meta.url);
      const w = new Worker(url, { type: 'module' });
      w.onerror = () => { this._worker = false; w.terminate(); this.runOnMainThread(); };
      this._worker = w;
      return w;
    } catch (e) {
      this._worker = false;      // Safari 老版本 / Pages 上 MIME 异常时走这里
      return false;
    }
  }

  bind() {
    this.root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-rs]');
      if (!el) return;
      const act = el.dataset.rs;
      if (act === 'tab') { this.tab = el.dataset.tab; this.render(); }
      else if (act === 'runGrid') this.runGrid();
      else if (act === 'runWf') this.runWalkForward();
      else if (act === 'runPort') this.runPortfolio();
      else if (act === 'runMc') this.runMonteCarlo();
      else if (act === 'runCost') this.runCostStress();
      else if (act === 'runScan') this.runScan();
      else if (act === 'scanSort') { this.scanSortKey = el.dataset.key; this.scanSortDir = el.dataset.dir === 'asc' ? 'asc' : 'desc'; this.render(); }
      else if (act === 'scanOpen') this.api.openSymbol?.(el.dataset.sym);
      else if (act === 'heat') this.drawHeatmap(el.dataset.x, el.dataset.y);
      else if (act === 'applyBest') this.applyBestFromHeat();
      else if (act === 'runReport') this.buildReport();
      else if (act === 'applyRow') this.applyRow(Number(el.dataset.idx));
      else if (act === 'robust') this.computeRobustness(Number(el.dataset.idx));
      else if (act === 'exportCsv') this.exportCsv();
      else if (act === 'exportHtml') this.exportHtml();
      else if (act === 'stop') this.stopRun();
    });
    // 核算方式/仓位算法一改，下面这排参数就整块换掉，不重绘的话用户看到的是上一套控件
    this.root.addEventListener('change', (e) => {
      const id = e.target.id || '';
      if (id === 'rsPortMode' || id === 'rsPoolSizing') { this.render(); return; }
      // 扫描的四个过滤条件都在 DOM 里，改一个就得重新过滤+排序，否则表格还是上一次的结果
      if (id.startsWith('rsScan') && id !== 'rsScanBench') this.applyScanFilter();
    });
  }

  stopRun() {
    this.stopping = true;
    this.busy = '';
    this.progress = null;
    this.render();
  }

  specFor(code) {
    const resolved = resolveTradeSpec(code || 'RB0');
    if (!resolved.ok) return null;
    const spec = resolved.spec;
    const rules = rulesFor(spec);
    return { spec, rules, resolved };
  }

  engineOpts() {
    const g = (id, d) => { const el = document.getElementById(id); const v = el ? Number(el.value) : NaN; return Number.isFinite(v) ? v : d; };
    return { capital: g('rsCapital', 200000), sizing: 'fixed', lots: g('rsLots', 1), slippageTicks: g('rsSlip', 1), allowShort: true };
  }

  render() {
    if (!this.root) return;
    const bars = this.bars;
    const tabs = [['grid', '🎯 参数寻优'], ['wf', '🚪 Walk-Forward'], ['port', '🧺 组合回测'],
      ['mc', '🎲 蒙特卡洛·成本'], ['scan', '🔍 市场扫描'], ['rep', '📊 报表与导出']]
      .map(([k, label]) => `<button class="tab-btn ${this.tab === k ? 'active' : ''}" data-rs="tab" data-tab="${k}" style="font-size:12px;">${label}</button>`).join('');
    const head = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--border-color);margin-bottom:10px;">${tabs}</div>
      ${bars.length < 60 ? `<div style="color:var(--up-color);padding:10px;">当前图表只有 ${bars.length} 根 K 线，先去「行情与缓存中心」拉一个品种。</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;font-size:12px;">
        <label>资金<input id="rsCapital" type="number" value="200000" style="${INP}width:92px;" /></label>
        <label>手数<input id="rsLots" type="number" value="1" min="1" style="${INP}width:56px;" /></label>
        <label>滑点tick<input id="rsSlip" type="number" value="1" min="0" style="${INP}width:56px;" /></label>
        <span style="color:var(--text-muted);">品种 ${esc(this.code)} · ${bars.length} 根 · 周期 ${esc(this.api.chart?.periodLabel || 'daily')}</span>
      </div>`;
    const body = this.tab === 'grid' ? this.gridHtml()
      : this.tab === 'wf' ? this.wfHtml()
        : this.tab === 'port' ? this.portHtml()
          : this.tab === 'mc' ? this.mcHtml()
            : this.tab === 'scan' ? this.scanHtml() : this.reportHtml();
    this.root.innerHTML = head + body;
  }

  strategySelect(id) {
    const cur = document.getElementById(id)?.value || 'donchianBreak';
    return `<select id="${id}" style="${INP}">` + STRATEGIES.map(s => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('') + '</select>';
  }

  gridHtml() {
    const sid = document.getElementById('rsStrategy')?.value || 'donchianBreak';
    const def = getStrategy(sid);
    const el = document.getElementById('rsGrid');
    const defText = JSON.stringify(DEFAULT_GRIDS[sid] || {});
    const prevDefText = this._gridSid ? JSON.stringify(DEFAULT_GRIDS[this._gridSid] || {}) : null;
    // 换策略时网格要不要跟着换？只看一件事：文本框里还是不是"上一个策略的默认网格"。
    // 是 → 说明用户没动过，留着旧键名（entry/exit）会让新策略把无关参数当成网格，
    //       24 组跑出来的其实是同一个默认参数，热图全是平的；
    // 否 → 用户自己写的，一个字都不许覆盖。
    let gridText = defText;
    if (el && el.value.trim()) {
      const untouched = prevDefText !== null && el.value.trim() === prevDefText.trim();
      gridText = (this._gridSid && this._gridSid !== sid && untouched) ? defText : el.value;
    }
    this._gridSid = sid;
    const objSel = `<select id="rsObjective" style="${INP}">` +
      Object.entries(OBJECTIVES).map(([k, v]) => `<option value="${k}" ${k === (document.getElementById('rsObjective')?.value || 'sharpe') ? 'selected' : ''}>${esc(v.label)}</option>`).join('') + '</select>';
    return `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
        ${this.strategySelect('rsStrategy')} ${objSel}
        <button class="btn btn-sm" style="${BTN_HI}" data-rs="runGrid">▶ 开始寻优</button>
        ${this.busy ? `<button class="btn btn-sm" style="${BTN}" data-rs="stop">■ 停止</button>` : ''}
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">
        参数网格（每行一个维度，值用逗号或数组；没改过的网格会跟着策略一起换，改过的保留）：</div>
      <textarea id="rsGrid" rows="4" style="${INP}width:100%;font-family:var(--font-mono);font-size:12px;">${esc(gridText)}</textarea>
      ${this.progressHtml()}
      ${this.gridTableHtml()}
      ${def ? `<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">基准参数：${esc(JSON.stringify(def.params))}</div>` : ''}`;
  }

  progressHtml() {
    if (!this.progress) return '';
    const p = this.progress;
    const pct = p.total ? Math.min(100, Math.round(p.done / p.total * 100)) : 0;
    return `<div style="margin:8px 0;">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:3px;">${esc(this.busy || '计算中')} ${p.done}/${p.total}</div>
      <div style="height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:var(--accent-blue);transition:width .15s;"></div></div></div>`;
  }

  gridTableHtml() {
    const rows = this.gridRows;
    if (!rows) return '';
    if (!rows.length) return '<div style="color:var(--up-color);">没有任何一组参数跑出结果。</div>';
    const best = rows[0];
    const cols = Object.keys(best.params);
    return `
      <div style="overflow:auto;max-height:340px;border:1px solid var(--border-color);border-radius:6px;margin-top:10px;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:var(--bg-tertiary);position:sticky;top:0;">
          <th style="padding:4px 6px;">#</th>${cols.map(c => `<th>${esc(c)}</th>`).join('')}
          <th>得分</th><th>年化</th><th>Sharpe</th><th>回撤</th><th>胜率</th><th>笔数</th><th></th></tr></thead>
        <tbody>${rows.slice(0, 30).map((r, i) => `<tr style="border-top:1px solid var(--border-color);${i === 0 ? 'background:rgba(41,98,255,.10);' : ''}">
          <td style="padding:4px 6px;">${r.rank}${i === 0 ? ' ★' : ''}</td>
          ${cols.map(c => `<td>${esc(r.params[c])}</td>`).join('')}
          <td>${nf(r.score)}</td><td>${pc(r.metrics.annualReturn)}</td><td>${nf(r.metrics.sharpe, 2)}</td>
          <td>${pc(r.metrics.maxDDPct)}</td><td>${pc(r.metrics.winRate, 0)}</td><td>${r.metrics.trades}</td>
          <td><button class="btn btn-sm" style="${BTN}padding:3px 8px;" data-rs="applyRow" data-idx="${i}">用这组</button>
              <button class="btn btn-sm" style="${BTN}padding:3px 8px;" data-rs="robust" data-idx="${i}" title="每个维度 ±1 档重跑，看成绩掉多少">稳健度</button></td></tr>`).join('')}</tbody></table></div>
      ${this.robustHtml()}
      ${this.heatmapHtmlBlock()}
      ${this.robustnessNote(rows)}`;
  }

  robustHtml() {
    const r = this.robust;
    if (!r) return '';
    if (!r.variants.length) return '<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">该参数在网格边缘或维度单一，没有邻域可比。</div>';
    const worst = Math.min(...r.variants.map(v => v.score));
    const best = Number.isFinite(r.bestScore) ? r.bestScore : null;
    return `<div style="border:1px solid var(--border-color);border-radius:6px;padding:8px;margin:8px 0;font-size:12px;">
      <div style="color:var(--text-white);">邻域稳健度 · ${esc(JSON.stringify(r.params))}</div>
      <div style="color:var(--text-muted);font-size:11px;margin:2px 0 4px;">本组得分 ${nf(r.bestScore)} · 邻域最差 ${nf(worst)}</div>
      <table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:4px;">
        <tr style="color:var(--text-muted);"><th style="text-align:left;">维度</th><th>档位</th><th>得分</th><th>相对本组</th></tr>
        ${r.variants.map(v => `<tr style="border-top:1px solid var(--border-color);">
          <td style="text-align:left;">${esc(v.k)}</td><td>${esc(v.value)}${v.delta > 0 ? ' ↑' : ' ↓'}</td>
          <td>${nf(v.score)}${v.ruined ? '（亏光）' : ''}</td>
          <td>${(best !== null && best > 0 && Number.isFinite(v.score)) ? (v.score / best * 100).toFixed(0) + '%' : '—'}</td></tr>`).join('')}
      </table>
      <div style="color:${r.retain !== null && r.retain < 0.5 ? 'var(--accent-gold)' : 'var(--text-muted)'};margin-top:5px;">
        ${r.retain === null ? '本组得分非正，比例无意义 —— 只看邻域的绝对得分。'
          : `邻域最差保留了 ${(r.retain * 100).toFixed(0)}%。${r.retain < 0.5 ? ' <b>孤峰嫌疑</b>：换个 1 档就崩，这个"最优"多半是拟合噪声。' : ' 邻域较平，参数相对站得住。'}`}
      </div></div>`;
  }

  robustnessNote(rows) {
    const ruined = rows.filter(r => r.metrics.ruined).length;
    const thin = rows.filter(r => (r.metrics.trades || 0) < 10).length;
    const pct0 = Number.isFinite(rows[0].percentile) ? (rows[0].percentile * 100).toFixed(0) + '%' : '—';
    return `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.8;">
      共 ${rows.length} 组参数。其中 <b>${thin}</b> 组笔数 &lt; 10（样本太少，成绩没有统计意义），
      <b>${ruined}</b> 组亏光。第 1 名分位 ${pct0} ——
      挑参数本身就是在制造过拟合，请再看 Walk-Forward 那一页的效率比。
    </div>`;
  }

  runGrid() {
    const bars = this.bars;
    if (bars.length < 60) { this.api.toast?.('K 线不足'); return; }
    const sp = this.specFor(this.code);
    if (!sp) { this.api.toast?.('当前品种无法解析规格'); return; }
    const strategyId = document.getElementById('rsStrategy').value;
    const strategy = getStrategy(strategyId);
    const grids = parseGrid(document.getElementById('rsGrid').value);
    if (grids.__error) { this.api.toast?.(`参数网格有问题：${grids.__error}`); return; }
    if (!Object.keys(grids).length) { this.api.toast?.('网格是空的：写成 entry: 20,40,55 或 {"entry":[20,40,55]}'); return; }
    // 网格里出现策略参数表没有的键 = 这一整轮在重复跑同一组默认参数（成绩全是平的）。
    // 以前只能靠用户自己发现，现在当场拦住并说清是哪几个键。
    const unknown = Object.keys(grids).filter(k => !(k in strategy.params));
    if (unknown.length) {
      this.api.toast?.(`网格键 ${unknown.join('、')} 不属于「${strategy.name}」，请换成该策略自己的参数`);
      this.gridRows = null;
      this.render();
      return;
    }
    const objective = document.getElementById('rsObjective').value;
    const engineOpts = { ...this.engineOpts(), rules: sp.rules };
    this.stopping = false;
    this.busy = '寻优中';
    this.progress = { done: 0, total: 1 };
    this.gridRows = null;
    // Worker 起不来时要能原地退回主线程，所以先把这一轮的入参存一份
    this._mainArgs = { bars, sp, strategy, grids, objective, engineOpts };

    const w = this.worker();
    if (w) {
      this._workerHandler = (e) => {
        const m = e.data || {};
        if (m.type === 'progress') { this.progress = { done: Math.min(m.done, m.total), total: m.total }; this.refreshProgress(); }
        else if (m.type === 'result') {
          this.busy = ''; this.progress = null;
          // 直接用 Worker 算好的名次表。把它拿回主线程重算一遍等于白开 Worker。
          this.gridRows = m.rows;
          this.gridCtx = { bars, sp, strategyId, grids, objective, engineOpts };
          this.render();
        } else if (m.type === 'error') { this.busy = ''; this.api.toast?.(`Worker：${m.error}`); this.render(); }
      };
      w.addEventListener('message', this._workerHandler);
      // engineOpts 里带的是普通数据；rules 由 Worker 自己用 rulesFor(spec) 造 ——
      // 类实例过不了结构化克隆，传过去会变成没有方法的外壳。
      w.postMessage({ job: 'grid', bars, spec: sp.spec, strategyId, baseParams: { ...strategy.params }, grids, objective, engineOpts, periodsPerYear: this.api.chart?.periodsPerYear || 252 });
      return;
    }
    this.runOnMainThread({ bars, sp, strategy, grids, objective, engineOpts });
  }

  /**
   * 邻域稳健度：把某一组参数的每个维度 ±1 档重跑，看成绩掉多少。
   * 只在用户点「稳健度」时算 —— 它要多跑几组，放进主寻优里会让进度条假装卡住。
   * 孤峰（邻域掉一半以上）基本就是拟合噪声拟合出来的参数。
   */
  computeRobustness(idx) {
    const row = (this.gridRows || [])[idx];
    const ctx = this.gridCtx;
    if (!row || !ctx) return;
    const strategy = getStrategy(ctx.strategyId);
    const grids = Object.fromEntries(Object.entries(ctx.grids).map(([k, v]) => [k, v]));
    const nb = neighborhoodScore({
      bars: ctx.bars, spec: ctx.sp.spec, strategy, best: row.params, grids,
      engineOpts: ctx.engineOpts, objective: ctx.objective
    });
    const bestScore = Number.isFinite(row.score) ? row.score : null;
    this.robust = { params: row.params, bestScore, ...nb };
    this.render();
  }

  /** 热图块：寻优有结果就自动摊成矩阵，默认挑变化最多的两维。 */
  heatmapHtmlBlock() {
    const rows = this.gridRows;
    if (!rows || !rows.length) return '';
    const chosen = this.heatDims || {};
    const h = parameterHeatmap(rows, { xDim: chosen.x, yDim: chosen.y });
    this.heat = h;
    if (h.error) return `<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">${esc(h.error)}</div>`;
    return heatmapHtml(h);
  }

  drawHeatmap(xDim, yDim) {
    if (!this.gridRows?.length) return;
    this.heatDims = { x: xDim, y: yDim };
    this.heat = parameterHeatmap(this.gridRows, this.heatDims);
    this.render();
  }

  applyBestFromHeat() {
    const b = this.heat?.best;
    if (!b?.params) { this.api.toast?.('热图还没有最优格'); return; }
    const strategyId = document.getElementById('rsStrategy')?.value;
    this.api.toast?.(`已把热图最优格参数交给回测面板`);
    this.api.runBacktestWith?.(strategyId, b.params);
  }

  runOnMainThread(args) {
    const { bars, sp, strategy, grids, objective, engineOpts } = args || this._mainArgs || {};
    if (!bars || !sp || !strategy || !Object.keys(grids || {}).length) {
      this.busy = ''; this.progress = null;
      this.api.toast?.('寻优上下文丢了，请重新点一次「开始寻优」');
      this.render();
      return;
    }
    const runner = gridRunner({
      bars, spec: sp.spec, strategy, baseParams: { ...strategy.params }, grids, objective, engineOpts,
      periodsPerYear: this.api.chart?.periodsPerYear || 252
    });
    this.busy = '寻优中（主线程分块）';
    this.progress = { done: 0, total: runner.total };
    const step = () => {
      if (this.stopping) { this.busy = '已停止'; this.progress = null; this.render(); return; }
      runner.step(6);
      this.progress = { done: Math.min(runner.total, this.progress ? this.progress.done + 6 : 6), total: runner.total };
      this.refreshProgress();
      if (!runner.done()) setTimeout(step, 0);
      else {
        this.gridRows = runner.finish();
        this.gridCtx = { bars, sp, strategyId: strategy.id, grids, objective, engineOpts };
        this.busy = ''; this.progress = null;
        this.render();
      }
    };
    setTimeout(step, 0);
  }

  refreshProgress() {
    const host = this.root.querySelector('[data-rs="progressHost"]');
    if (host) host.innerHTML = this.progressHtml();
  }

  applyRow(idx) {
    const row = (this.gridRows || [])[idx];
    if (!row) return;
    const strategyId = document.getElementById('rsStrategy')?.value;
    this.api.toast?.(`已把第 ${row.rank} 名参数交给回测面板`);
    this.api.runBacktestWith?.(strategyId, row.params);
  }

  // ---------------- Walk-Forward ----------------
  wfHtml() {
    const sid = document.getElementById('rsWfStrategy')?.value || 'donchianBreak';
    const gridText = document.getElementById('rsWfGrid')?.value ?? JSON.stringify(DEFAULT_GRIDS[sid] || {});
    const v = (id, d) => document.getElementById(id)?.value ?? d;
    return `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;font-size:12px;">
        ${this.strategySelect('rsWfStrategy')}
        <label>目标<select id="rsWfObjective" style="${INP}">${Object.entries(OBJECTIVES).map(([k, x]) => `<option value="${k}">${esc(x.label)}</option>`).join('')}</select></label>
        <label>样本内<input id="rsIs" type="number" value="${v('rsIs', 500)}" style="${INP}width:70px;" /></label>
        <label>样本外<input id="rsOos" type="number" value="${v('rsOos', 120)}" style="${INP}width:70px;" /></label>
        <label>步长<input id="rsStep" type="number" value="${v('rsStep', 120)}" style="${INP}width:70px;" /></label>
        <button class="btn btn-sm" style="${BTN_HI}" data-rs="runWf">▶ 跑 Walk-Forward</button>
      </div>
      <textarea id="rsWfGrid" rows="3" style="${INP}width:100%;font-family:var(--font-mono);font-size:12px;">${esc(gridText)}</textarea>
      ${this.progressHtml()}
      ${this.wfTableHtml()}`;
  }

  wfTableHtml() {
    const r = this.wf;
    if (!r) return '';
    if (r.error) return `<div style="color:var(--up-color);margin-top:8px;">${esc(r.error)}</div>`;
    const s = r.summary;
    return `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin:10px 0;">
        ${[['段数', s.segments], ['样本内均值', nf(s.meanIsScore)], ['样本外均值', nf(s.meanOosScore)],
           ['效率比 OOS/IS', nf(s.efficiency)], ['IS-OOS 落差', nf(s.isOosGap)],
           ['正收益段', `${s.positiveOosSegments}/${s.segments}`], ['合并总收益', pc(s.totalReturn)], ['合并最大回撤', pc(s.maxDDPct)]]
          .map(([k, val]) => `<div style="background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:5px;padding:7px 9px;">
            <div style="font-size:11px;color:var(--text-muted);">${esc(k)}</div><div style="font-size:15px;color:#fff;font-weight:600;">${esc(val)}</div></div>`).join('')}
      </div>
      ${s.efficiency !== null && s.efficiency < 0.3
        ? `<div style="color:var(--accent-gold);font-size:12px;margin-bottom:8px;">⚠ 效率比 ${nf(s.efficiency)} &lt; 0.3：样本内挑出来的参数到样本外基本不成立，这套参数是拟合出来的。</div>` : ''}
      <div style="overflow:auto;max-height:300px;border:1px solid var(--border-color);border-radius:6px;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:var(--bg-tertiary);"><th style="padding:4px 6px;">#</th><th>样本内区间</th><th>样本外区间</th><th>选中参数</th><th>IS</th><th>OOS</th></tr></thead>
        <tbody>${r.windows.map((w, i) => `<tr style="border-top:1px solid var(--border-color);">
          <td style="padding:4px 6px;">${i + 1}</td>
          <td>${esc(w.isDateFrom)}→${esc(w.isDateTo)}</td>
          <td>${esc(w.oosDateFrom)}→${esc(w.oosDateTo)}</td>
          <td style="font-family:var(--font-mono);">${esc(Object.entries(w.best).map(([k, x]) => `${k}=${x}`).join(' '))}</td>
          <td>${nf(w.isScore)}</td>
          <td style="color:${w.oosScore >= 0 ? 'var(--up-color)' : 'var(--down-color)'};">${nf(w.oosScore)}</td></tr>`).join('')}</tbody></table></div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">参数漂移：${esc(Object.entries(r.drift).map(([k, d]) => `${k} 换了 ${d.changes} 次（${(d.rate * 100).toFixed(0)}%）`).join('，'))}
      —— 每段都在换参数，说明"最优"跟着行情走，不是稳定结构。</div>`;
  }

  runWalkForward() {
    const bars = this.bars;
    const sp = this.specFor(this.code);
    if (!sp || bars.length < 60) { this.api.toast?.('数据不足'); return; }
    const strategy = getStrategy(document.getElementById('rsWfStrategy').value);
    const grids = parseGrid(document.getElementById('rsWfGrid').value);
    if (grids.__error) { this.api.toast?.(`参数网格有问题：${grids.__error}`); return; }
    if (!Object.keys(grids).length) { this.api.toast?.('网格是空的：写成 entry: 20,40,55 或 {"entry":[20,40,55]}'); return; }
    const unknown = Object.keys(grids).filter(k => !(k in strategy.params));
    if (unknown.length) { this.api.toast?.(`网格键 ${unknown.join('、')} 不属于「${strategy.name}」`); return; }
    const num = (id, d) => Number(document.getElementById(id)?.value) || d;
    const isLen = num('rsIs', 500), oosLen = num('rsOos', 120), stepLen = num('rsStep', 120);
    const objective = document.getElementById('rsWfObjective').value;
    const opts = { ...this.engineOpts(), rules: sp.rules };
    this.busy = 'Walk-Forward 计算中';
    this.progress = { done: 0, total: Math.max(1, Math.floor((bars.length - isLen - oosLen) / stepLen) + 1) };
    this.wf = null;
    this.render();
    setTimeout(() => {
      const res = walkForward({
        bars, spec: sp.spec, strategy, baseParams: { ...strategy.params }, grids, objective,
        isLen, oosLen, stepLen, engineOpts: opts,
        periodsPerYear: this.api.chart?.periodsPerYear || 252,
        onWindow: (w, n) => { this.progress = { done: n, total: this.progress ? this.progress.total : n }; }
      });
      this.wf = res;
      this.busy = ''; this.progress = null;
      this.render();
    }, 30);
  }

  // ---------------- 组合 ----------------
  portHtml() {
    const items = (this.api.watchlistItems?.() || []);
    const sid = document.getElementById('rsPortStrategy')?.value || 'donchianBreak';
    const def = getStrategy(sid);
    const list = items.length ? items : [];
    const mode = document.getElementById('rsPortMode')?.value || 'split';
    const v = (id, d) => document.getElementById(id)?.value ?? d;
    const poolCtl = mode === 'pool' ? `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;font-size:12px;">
        <label>仓位算法<select id="rsPoolSizing" style="${INP}">
          <option value="notional" ${v('rsPoolSizing', 'notional') === 'notional' ? 'selected' : ''}>名义占比</option>
          <option value="atr" ${v('rsPoolSizing', 'notional') === 'atr' ? 'selected' : ''}>ATR 风险预算</option>
          <option value="volTarget" ${v('rsPoolSizing', 'notional') === 'volTarget' ? 'selected' : ''}>波动率目标</option>
        </select></label>
        <label>占比/风险%<input id="rsPoolRisk" type="number" value="${v('rsPoolRisk', 20)}" step="1" style="${INP}width:66px;" /></label>
        <label>ATR 倍数<input id="rsPoolAtrMult" type="number" value="${v('rsPoolAtrMult', 3)}" step="0.5" style="${INP}width:56px;" /></label>
        <label>止损%<input id="rsPoolStop" type="number" value="${v('rsPoolStop', 3)}" step="0.5" style="${INP}width:56px;" title="开仓即挂的初始止损，按开仓价百分比；0=不挂" /></label>
        <label>盈亏比目标<input id="rsPoolRr" type="number" value="${v('rsPoolRr', 0)}" step="0.5" style="${INP}width:60px;" title="止盈 = 止损距离 × 该倍数；0=不挂止盈" /></label>
        <label>止盈平仓%<input id="rsPoolTpFrac" type="number" value="${v('rsPoolTpFrac', 100)}" min="1" max="100" style="${INP}width:62px;" title="到止盈只平这么多仓位，剩下的继续带止损跑；100=全平。需要先设「盈亏比目标」或策略自带止盈价" /></label>
        <label>加仓次数<input id="rsPoolAdds" type="number" value="${v('rsPoolAdds', 0)}" min="0" max="3" style="${INP}width:56px;" title="金字塔加仓次数；0=不加仓。加仓单按突破首仓价 + 步长成交" /></label>
        <label>加仓步长%<input id="rsPoolAddStep" type="number" value="${v('rsPoolAddStep', 2)}" step="0.5" style="${INP}width:62px;" title="第 k 次加仓的突破价 = 首仓价 × (1 + k × 步长)" /></label>
        <label>加仓衰减<input id="rsPoolAddDecay" type="number" value="${v('rsPoolAddDecay', 0.5)}" step="0.1" min="0.05" max="1" style="${INP}width:58px;" title="每次加仓手数 = 首仓 × 衰减^k；0.5 表示逐次减半" /></label>
        <label>维持比例%<input id="rsPoolMaint" type="number" value="${v('rsPoolMaint', 75)}" style="${INP}width:60px;" title="权益低于「占用保证金 × 该比例」时逐品种强平" /></label>
        <label>强平冷却<input id="rsPoolCooldown" type="number" value="${v('rsPoolCooldown', 3)}" min="0" style="${INP}width:52px;" title="被强平的品种多少根 bar 内不许重开" /></label>
        <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" id="rsPoolSettle" ${document.getElementById('rsPoolSettle')?.checked !== false ? 'checked' : ''} style="width:auto;" />逐日盯市结算</label>
      </div>` : '';
    return `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;font-size:12px;">
        ${this.strategySelect('rsPortStrategy')}
        <label>核算方式<select id="rsPortMode" style="${INP}">
          <option value="split" ${mode === 'split' ? 'selected' : ''}>分仓独立（各花各的钱）</option>
          <option value="pool" ${mode === 'pool' ? 'selected' : ''}>共享保证金池（一个账户）</option>
        </select></label>
        <label>权重<select id="rsWeights" style="${INP}"><option value="equal">等权</option><option value="inverseVol">逆波动率</option></select></label>
        <label>保证金上限%<input id="rsCap" type="number" value="60" style="${INP}width:66px;" /></label>
        <label>资金<input id="rsPortCap" type="number" value="1000000" style="${INP}width:110px;" /></label>
        <button class="btn btn-sm" style="${BTN_HI}" data-rs="runPort">▶ 跑组合</button>
      </div>
      ${poolCtl}
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">参与品种（来自自选池，勾选即纳入）：
        ${list.length ? '' : '<span style="color:var(--accent-gold);">自选池是空的 —— 先去「⭐ 自选池」加品种</span>'}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
        ${list.map((it, i) => `<label style="display:flex;align-items:center;gap:4px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:4px;padding:4px 8px;font-size:12px;">
          <input type="checkbox" class="rsPortPick" value="${i}" ${i < 6 ? 'checked' : ''} style="width:auto;" />${esc(it.openCode || it.symbol)} ${esc(it.name || '')}</label>`).join('')}
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">参数：${esc(JSON.stringify(def?.params || {}))}</div>
      ${this.portTableHtml()}`;
  }

  portTableHtml() {
    const p = this.portfolio;
    if (!p) return '';
    if (p.error) return `<div style="color:var(--up-color);">${esc(p.error)}</div>`;
    if (p.mode === 'pool') return this.poolResultHtml(p);
    return `
      <div style="overflow:auto;border:1px solid var(--border-color);border-radius:6px;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:var(--bg-tertiary);"><th style="padding:4px 6px;">品种</th><th>权重</th><th>分仓资金</th><th>笔数</th><th>净盈亏</th><th>Sharpe</th><th>回撤</th></tr></thead>
        <tbody>${p.allocation.map(a => `<tr style="border-top:1px solid var(--border-color);">
          <td style="padding:4px 6px;">${esc(a.symbol)} <span style="color:var(--text-muted);">${esc(a.name || '')}</span></td>
          <td>${pc(a.weight, 1)}</td><td>${nf(a.capital, 0)}</td><td>${a.trades}</td>
          <td style="color:${a.netPnL >= 0 ? 'var(--up-color)' : 'var(--down-color)'};">${nf(a.netPnL, 1)}</td>
          <td>${nf(a.sharpe, 2)}</td><td>${pc(a.maxDDPct)}</td></tr>`).join('')}</tbody></table></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-top:10px;">
        ${[['合并总收益', pc(p.metrics.totalReturn)], ['年化', pc(p.metrics.annualReturn)], ['Sharpe', nf(p.metrics.sharpe, 2)],
           ['Calmar', nf(p.metrics.calmar, 2)], ['最大回撤', pc(p.metrics.maxDDPct)], ['笔数', p.metrics.trades],
           ['峰值保证金占用', pc(p.exposure.peakMarginRatio, 1)], ['缩仓系数', nf(p.exposure.appliedScale, 3)]]
          .map(([k, v]) => `<div style="background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:5px;padding:7px 9px;">
            <div style="font-size:11px;color:var(--text-muted);">${esc(k)}</div><div style="font-size:15px;color:#fff;font-weight:600;">${esc(v)}</div></div>`).join('')}
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">${esc(p.note)}</div>
      ${(this.skipped || []).length ? `<div style="color:var(--accent-gold);font-size:12px;margin-top:4px;">⚠ 已跳过 ${this.skipped.length} 个勾选项：${esc(this.skipped.join('、'))}</div>` : ''}
      ${p.exposure.scaledDown ? `<div style="color:var(--accent-gold);font-size:12px;margin-top:4px;">已按上限把各品种手数等比缩到 ${(p.exposure.appliedScale * 100).toFixed(1)}%。</div>` : ''}
      ${sparklineHtml(p.combinedEquity, '合并权益曲线')}`;
  }

  /**
   * 共享保证金池的结果页。
   * 除了成绩，这里必须把「账有没有闭合」和「什么时候被追保/强平」摊开：
   * 组合引擎最容易出的错不是算错收益率，而是某笔现金漏记或多记 —— 收益率照样好看，账却是假的。
   */
  poolResultHtml(p) {
    const bySym = new Map();
    for (const t of p.trades) {
      const b = bySym.get(t.symbol) || { symbol: t.symbol, name: t.name, n: 0, win: 0, pnl: 0, bars: 0, liq: 0 };
      b.n++; b.pnl += t.netPnL; b.bars += t.holdingBars;
      if (t.netPnL > 0) b.win++;
      if (t.exitReason === 'margin_call') b.liq++;
      bySym.set(t.symbol, b);
    }
    const rows = [...bySym.values()].sort((a, b) => b.pnl - a.pnl);
    const sumNet = p.trades.reduce((s, t) => s + t.netPnL, 0);
    const gap = Math.round((p.finalEquity - p.capital - sumNet) * 1000) / 1000;
    const ok = Math.abs(gap) <= 0.5;
    const eqCurve = p.equityCurve.map(q => ({ date: q.date, equity: q.equity }));
    const peakMargin = Math.max(0, ...p.equityCurve.map(q => q.margin || 0));
    const liq = p.notices.filter(n => n.kind === 'forced_liquidation');
    const calls = p.notices.filter(n => n.kind === 'margin_notice');
    const kinds = {};
    for (const r of p.rejects) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    return `
      <div style="overflow:auto;border:1px solid var(--border-color);border-radius:6px;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:var(--bg-tertiary);"><th style="padding:4px 6px;">品种</th><th>笔数</th><th>胜率</th><th>净盈亏</th><th>平均持仓</th><th>被强平</th></tr></thead>
        <tbody>${rows.map(a => `<tr style="border-top:1px solid var(--border-color);">
          <td style="padding:4px 6px;">${esc(a.symbol)} <span style="color:var(--text-muted);">${esc(a.name || '')}</span></td>
          <td>${a.n}</td><td>${a.n ? pc(a.win / a.n, 0) : '—'}</td>
          <td style="color:${a.pnl >= 0 ? 'var(--up-color)' : 'var(--down-color)'};">${nf(a.pnl, 1)}</td>
          <td>${a.n ? (a.bars / a.n).toFixed(1) : '—'} 根</td>
          <td style="color:${a.liq ? 'var(--accent-gold)' : 'inherit'};">${a.liq || '—'}</td></tr>`).join('')}</tbody></table></div>
      ${metricCards([['总收益', pc(p.metrics.totalReturn)], ['年化', pc(p.metrics.annualReturn)], ['Sharpe', nf(p.metrics.sharpe, 2)],
        ['最大回撤', pc(p.metrics.maxDDPct)], ['期末权益', nf(p.finalEquity, 0)], ['笔数', p.trades.length],
        ['峰值保证金占用', nf(peakMargin, 0)], ['强平次数', p.rejected.marginCalls],
        ['追保天数', calls.length], ['冷却拒单', p.rejected.reentryBlocked],
        ['板锁拒单', p.rejected.boardLock], ['算不出整手', p.rejected.sizingZero]])}
      <div style="font-size:12px;margin-top:8px;padding:7px 9px;border-radius:5px;border:1px solid var(--border-color);background:${ok ? 'rgba(16,185,129,.10)' : 'rgba(239,68,68,.14)'};">
        对账：期末 ${nf(p.finalEquity, 2)} − 本金 ${nf(p.capital, 0)} − Σ净盈亏 ${nf(sumNet, 2)} =
        <b style="color:${ok ? 'var(--down-color)' : 'var(--up-color)'};">${nf(gap, 2)}</b>
        ${ok ? '（闭合：现金池每一笔都能追溯到成交）' : '（不闭合 —— 引擎记错了现金，本页成绩不可信）'}
      </div>
      ${liq.length ? `<div style="font-size:11px;margin-top:6px;color:var(--accent-gold);">
        强平记录：${liq.slice(0, 12).map(n => `${esc(n.date)} ${esc(n.symbol)}（权益 ${nf(n.equity, 0)}／占用 ${nf(n.used, 0)}）`).join('；')}${liq.length > 12 ? `…共 ${liq.length} 次` : ''}</div>` : ''}
      ${calls.length ? `<div style="font-size:11px;margin-top:4px;color:var(--text-muted);">
        可用资金转负（追保、未到强平线）：${calls.length} 天，首次 ${esc(calls[0].date)}，最深缺口 ${nf(Math.min(...calls.map(n => n.cash)), 0)}</div>` : ''}
      ${Object.keys(kinds).length ? `<div style="font-size:11px;margin-top:4px;color:var(--text-muted);">
        拒单分布：${Object.entries(kinds).map(([k, n]) => `${esc(k)} ×${n}`).join('，')}（明细最多存 200 条）</div>` : ''}
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">仓位算法 ${esc(p.sizing.mode)}（占比/单笔风险 ${pc(p.sizing.riskPct, 1)}）·
        总敞口上限 ${pc(p.exposure.maxMarginPct, 0)} · ${p.exposure.settlement ? '逐日盯市结算' : '不结算（浮动留到平仓）'}${p.adds ? ` · 加仓 ${p.adds} 次` : ''}。${esc(p.note)}</div>
      ${(this.skipped || []).length ? `<div style="color:var(--accent-gold);font-size:12px;margin-top:4px;">⚠ 已跳过 ${this.skipped.length} 个勾选项：${esc(this.skipped.join('、'))}</div>` : ''}
      ${sparklineHtml(eqCurve, '共享池权益曲线')}`;
  }

  async runPortfolio() {
    const items = this.api.watchlistItems?.() || [];
    const checked = [...this.root.querySelectorAll('.rsPortPick:checked')].map(el => items[Number(el.value)]).filter(Boolean);
    if (checked.length < 2) { this.api.toast?.('至少勾两个品种'); return; }
    const strategy = getStrategy(document.getElementById('rsPortStrategy').value);
    const weights = document.getElementById('rsWeights').value;
    const capPct = Number(document.getElementById('rsCap').value) / 100;
    const capital = Number(document.getElementById('rsPortCap').value) || 1000000;
    const mode = document.getElementById('rsPortMode')?.value || 'split';
    const num = (id, d) => { const x = Number(document.getElementById(id)?.value); return Number.isFinite(x) ? x : d; };
    const poolOpts = {
      capital,
      sizing: document.getElementById('rsPoolSizing')?.value || 'notional',
      maxMarginPct: Number.isFinite(capPct) && capPct > 0 ? capPct : 0.6,
      notionalPct: num('rsPoolRisk', 20) / 100,
      riskPct: num('rsPoolRisk', 20) / 100,
      atrMult: num('rsPoolAtrMult', 3),
      stopPct: num('rsPoolStop', 3) > 0 ? num('rsPoolStop', 3) / 100 : null,
      targetRr: num('rsPoolRr', 0) > 0 ? num('rsPoolRr', 0) : null,
      takeProfitFraction: Math.min(100, Math.max(1, num('rsPoolTpFrac', 100))) / 100,
      pyramid: num('rsPoolAdds', 0) > 0 ? {
        maxAdds: Math.round(num('rsPoolAdds', 0)),
        stepPct: Math.max(0.1, num('rsPoolAddStep', 2)) / 100,
        decay: Math.min(1, Math.max(0.05, num('rsPoolAddDecay', 0.5)))
      } : null,
      maintenanceRatio: num('rsPoolMaint', 75) / 100,
      reentryCooldownBars: num('rsPoolCooldown', 3),
      settlement: document.getElementById('rsPoolSettle')?.checked !== false,
      slippageTicks: this.engineOpts().slippageTicks
    };
    this.skipped = [];        // 勾了却跑不了的品种必须列出来，不能静默少跑
    this.busy = '准备品种数据 0/' + checked.length;
    this.progress = { done: 0, total: checked.length };
    this.portfolio = null;
    this.render();

    const entries = [];
    for (let ci = 0; ci < checked.length; ci++) {
      const it = checked[ci];
      this.busy = `准备品种数据 ${ci + 1}/${checked.length} · ${it.openCode || it.symbol}`;
      this.progress = { done: ci + 1, total: checked.length };
      this.refreshProgress();
      const code = it.openCode || it.symbol;
      const bars = await this.api.loadBarsFor?.(it);
      if (!bars || bars.length < 60) { this.skipped.push(`${code}（无足够历史，仅 ${bars ? bars.length : 0} 根）`); continue; }
      const sp = this.specFor(code);
      if (!sp) { this.skipped.push(`${code}（合约规格表里没有它，月份/代码可能写错了）`); continue; }
      entries.push({
        symbol: code, name: it.name, bars, spec: sp.spec, rules: sp.rules,
        strategy, params: { ...strategy.params },
        allowShort: sp.spec.market !== 'ashare',
        periodsPerYear: this.api.chart?.periodsPerYear || 252,
        // 不传 capital：组合的分仓资金由权重决定，带进去会盖掉分配（core/portfolio 也会兜住这件事）
        engineOpts: { sizing: 'fixed', lots: this.engineOpts().lots, slippageTicks: this.engineOpts().slippageTicks,
                      rules: sp.rules, allowShort: sp.spec.market !== 'ashare' }
      });
    }
    this.busy = '组合计算中';
    this.progress = null;
    if (entries.length < 2) {
      this.busy = '';
      this.portfolio = { error: '可用品种不足 2 个（每个品种至少 60 根 K 线且规格可解析）' };
      this.render();
      return;
    }
    this.portfolioMode = mode;
    setTimeout(() => {
      if (mode === 'pool') {
        const eng = new PortfolioEngine(entries.map(e => ({
          symbol: e.symbol, name: e.name, bars: e.bars, spec: e.spec, rules: e.rules,
          strategy: e.strategy, params: e.params, allowShort: e.allowShort, periodsPerYear: e.periodsPerYear
        })), poolOpts);
        const res = eng.run();
        const metrics = res.error ? null : computeMetrics({
          equityCurve: res.equityCurve, trades: res.trades, capital: poolOpts.capital,
          periodsPerYear: entries[0].periodsPerYear || 252, bars: null
        });
        this.portfolio = { ...res, metrics, mode: 'pool', poolOpts };
      } else {
        this.portfolio = { ...runPortfolio({ entries, capital, weights, maxMarginPct: Number.isFinite(capPct) && capPct > 0 ? capPct : null }), mode: 'split' };
      }
      this.busy = '';
      this.render();
      this.api.toast?.(`组合完成：${entries.length} 个品种`);
    }, 30);
  }

  // ---------------- 蒙特卡洛 · 成本 ----------------
  mcHtml() {
    const v = (id, d) => document.getElementById(id)?.value ?? d;
    return `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;font-size:12px;">
        <label>样本<select id="rsMcSource" style="${INP}">
          <option value="symbol" ${v('rsMcSource', 'symbol') === 'symbol' ? 'selected' : ''}>本品种当前参数</option>
          <option value="pool" ${v('rsMcSource', 'symbol') === 'pool' ? 'selected' : ''}>组合·共享池（上一页结果）</option>
          <option value="split" ${v('rsMcSource', 'symbol') === 'split' ? 'selected' : ''}>组合·分仓（上一页结果）</option>
        </select></label>
        <label>重放方式<select id="rsMcMode" style="${INP}">
          ${[['sequence', '交易顺序重排'], ['bootstrap', '有放回抽样'], ['noise', '逐笔乘性扰动']].map(([k, l]) => `<option value="${k}" ${v('rsMcMode', 'sequence') === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
        <label>次数<input id="rsMcRuns" type="number" value="${v('rsMcRuns', 500)}" min="50" max="20000" style="${INP}width:70px;" /></label>
        <label>种子<input id="rsMcSeed" type="number" value="${v('rsMcSeed', 20240101)}" style="${INP}width:104px;" title="同种子必得同一结果，可复现" /></label>
        <label>破产线%<input id="rsMcRuin" type="number" value="${v('rsMcRuin', 50)}" min="5" max="99" style="${INP}width:60px;" title="权益跌破「本金 ×(1−该比例)」算一次破产" /></label>
        <label>扰动%<input id="rsMcNoise" type="number" value="${v('rsMcNoise', 20)}" style="${INP}width:58px;" title="仅「逐笔乘性扰动」用" /></label>
        <button class="btn btn-sm" style="${BTN_HI}" data-rs="runMc">▶ 跑蒙特卡洛</button>
        <button class="btn btn-sm" style="${BTN}" data-rs="runCost" title="同一套信号把手续费与滑点逐档放大，看毛利还剩多少">💰 成本敏感性</button>
      </div>
      ${this.busy ? `<div style="font-size:12px;color:var(--accent-gold);margin-bottom:8px;">${esc(this.busy)}…</div>` : ''}
      ${this.mcHtml_()}
      ${this.costHtml_()}`;
  }

  /**
   * 交易样本从哪来。组合那两项直接吃上一页的结果 —— 顺序风险在组合层面更致命，
   * 因为几个品种的亏损段一旦排在同一段时间，回撤不是各品种回撤之和而是更深。
   */
  mcSample() {
    const which = document.getElementById('rsMcSource')?.value || 'symbol';
    if (which !== 'symbol') {
      const p = this.portfolio;
      if (!p || p.error) return { error: `「${which === 'pool' ? '共享池' : '分仓'}」还没有结果：先去「组合回测」跑一轮` };
      const trades = which === 'pool' ? p.trades : (p.perSymbol || []).flatMap(s => s.trades || []);
      return { trades, capital: p.capital, label: which === 'pool' ? '共享保证金池组合' : '分仓独立组合' };
    }
    const bars = this.bars, sp = this.specFor(this.code);
    if (!sp || bars.length < 60) return { error: '当前图表数据不足 60 根或品种规格无法解析' };
    const strategy = getStrategy(this.api.currentStrategyId?.() || 'donchianBreak');
    const params = this.api.currentParams?.() || { ...strategy.params };
    const res = runOne({ bars, spec: sp.spec, strategy, params,
      engineOpts: { ...this.engineOpts(), rules: sp.rules }, periodsPerYear: this.api.chart?.periodsPerYear || 252 });
    return { trades: res.trades, capital: res.metrics.capital, label: `${this.code} · ${strategy.name}`,
             ctx: { bars, sp, strategy, params } };
  }

  mcHtml_() {
    const r = this.mc;
    if (!r) return `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
      回测只给一条曲线，而这条曲线最不该信的是<b>顺序</b>：同样的交易换个先来顺序，最大回撤能差一倍。
      重放之后看的是<b>回撤分布</b> —— 历史那条到底是 P50 还是 P95。</div>`;
    if (r.error) return `<div style="color:var(--up-color);font-size:12px;margin-bottom:10px;">${esc(r.error)}</div>`;
    const ddActualPct = r.actual.maxDDPct;
    return `
      <div style="border:1px solid var(--border-color);border-radius:6px;padding:10px;margin-bottom:10px;">
        <div style="font-size:12px;color:var(--text-white);margin-bottom:6px;">
          ${esc(r.label || '')} · ${r.mode} 重放 ${r.runs} 次（种子 ${r.seed}，${r.trades} 笔）</div>
        ${metricCards([
          ['回撤 P5', nf(r.drawdown.p5, 0)], ['回撤 P50', nf(r.drawdown.p50, 0)], ['回撤 P95', nf(r.drawdown.p95, 0)],
          ['实际最大回撤', `${nf(r.actual.maxDD, 0)}（${pc(ddActualPct)}）`],
          ['实际所处分位', r.drawdown.actualPctile !== null ? pc(r.drawdown.actualPctile, 0) : '—'],
          ['破产概率', pc(r.ruin.risk, 1)], ['归零概率', pc(r.ruin.riskHitZero, 1)],
          ['期末 P5', nf(r.endEquity.p5, 0)], ['期末 P95', nf(r.endEquity.p95, 0)],
          ['水下最长 P95', `${r.underwaterBars.p95 ?? '—'} 笔`], ['连亏最多 P95', r.maxConsecutiveLosses.p95 ?? '—']])}
        ${bandChartSvg(r)}
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">
          破产线设在本金的 ${(1 - r.ruinPct) * 100 | 0}%（即亏掉 ${pc(r.ruinPct, 0)}）：${r.ruin.ruined}/${r.ruin.runs} 条路径越线。
          ${esc(r.note)}</div>
        ${r.drawdown.actualPctile !== null && r.drawdown.actualPctile > 0.8
          ? `<div style="color:var(--accent-gold);font-size:12px;margin-top:5px;">⚠ 历史那条回撤已经落在自己分布的 ${(r.drawdown.actualPctile * 100).toFixed(0)}% 分位 ——
             这不是"最坏情况"，只是运气不算差。按 P95（${nf(r.drawdown.p95, 0)}）准备资金，别按历史。</div>` : ''}
      </div>`;
  }

  costHtml_() {
    const c = this.cost;
    if (!c) return '';
    if (c.error) return `<div style="color:var(--up-color);font-size:12px;">${esc(c.error)}</div>`;
    const baseNet = (c.rows.find(r => r.feeMult === 1 && r.slipTicks === c.baseSlip) || c.rows[0])?.netPnL;
    return `
      <div style="border:1px solid var(--border-color);border-radius:6px;padding:10px;">
        <div style="font-size:12px;color:var(--text-white);margin-bottom:6px;">成本敏感性（基准滑点 ${c.baseSlip} 个 tick）</div>
        <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
          <tr style="color:var(--text-muted);text-align:right;"><th style="text-align:left;padding:3px 6px;">场景</th>
            <th>净盈亏</th><th>手续费</th><th>成本占毛利</th><th>总收益</th><th>Sharpe</th><th>回撤</th><th>笔数</th></tr>
          ${c.rows.map(r => r.error
            ? `<tr style="border-top:1px solid var(--border-color);"><td style="text-align:left;padding:3px 6px;">${esc(r.label)}</td><td colspan="6" style="color:var(--up-color);">${esc(r.error)}</td></tr>`
            : `<tr style="border-top:1px solid var(--border-color);text-align:right;">
              <td style="text-align:left;padding:3px 6px;">${esc(r.label)}</td>
              <td style="color:${r.netPnL >= 0 ? 'var(--up-color)' : 'var(--down-color)'};">${nf(r.netPnL, 0)}</td>
              <td>${nf(r.fees, 0)}</td>
              <td>${r.costShare === null ? '—' : pc(r.costShare, 0)}</td>
              <td>${pc(r.totalReturn)}</td><td>${nf(r.sharpe, 2)}</td><td>${pc(r.maxDDPct)}</td><td>${r.trades}</td></tr>`).join('')}
        </table>
        ${c.ladder ? `<div style="font-size:12px;margin-top:7px;color:var(--accent-gold);">🪜 ${esc(c.ladder.note)}</div>` : ''}
        ${Number.isFinite(baseNet) ? `<div style="font-size:11px;color:var(--text-muted);margin-top:5px;">
          对比基准：净盈亏 ${nf(baseNet, 0)}。成本敏感性不改信号、只改成交成本 —— 表格里的<b>笔数</b>变化说明成本已经大到改变出场时点。</div>` : ''}
      </div>`;
  }

  runMonteCarlo() {
    this.busy = '蒙特卡洛重放';
    this.render();
    setTimeout(() => {
      const s = this.mcSample();
      if (s.error) { this.mc = { error: s.error }; this.busy = ''; this.render(); return; }
      const num = (id, d) => { const x = Number(document.getElementById(id)?.value); return Number.isFinite(x) && x > 0 ? x : d; };
      const r = simulatePaths(s.trades, {
        runs: num('rsMcRuns', 500), seed: num('rsMcSeed', 20240101),
        mode: document.getElementById('rsMcMode')?.value || 'sequence',
        capital: s.capital, ruinPct: num('rsMcRuin', 50) / 100, noisePct: num('rsMcNoise', 20) / 100
      });
      this.mc = { ...r, label: s.label };
      this.busy = '';
      this.render();
      if (!r.error) this.api.toast?.(`重放 ${r.runs} 次完成`);
    }, 20);
  }

  runCostStress() {
    const s = this.mcSample();
    if (s.error || !s.ctx) {
      this.cost = { error: s.error || '成本敏感性需要"本品种当前参数"作样本：组合页的多品种成本请各自看' };
      this.render();
      return;
    }
    this.busy = '成本敏感性逐档重跑';
    this.render();
    setTimeout(() => {
      const sp = this.specFor(this.code);
      this.cost = costStress({
        bars: s.ctx.bars, spec: sp.spec, strategy: s.ctx.strategy, params: s.ctx.params,
        engineOpts: { ...this.engineOpts(), rules: sp.rules },
        scenarios: DEFAULT_COST_SCENARIOS, periodsPerYear: this.api.chart?.periodsPerYear || 252
      });
      this.busy = '';
      this.render();
    }, 20);
  }

  // ---------------- 市场扫描 ----------------
  scanHtml() {
    const items = this.api.watchlistItems?.() || [];
    const v = (id, d) => { const el = document.getElementById(id); return el ? el.value : d; };
    const chk = (id, label, def) => {
      const el = document.getElementById(id);
      const on = el ? el.checked : def;
      return `<label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} style="width:auto;" />${esc(label)}</label>`;
    };
    const numV = (id, d) => { const el = document.getElementById(id); return el ? el.value : d; };
    return `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;font-size:12px;">
        <button class="btn btn-sm" style="${BTN_HI}" data-rs="runScan">🔍 扫描自选池</button>
        ${chk('rsScanTpl', '只要模板通过', true)}
        ${chk('rsScanBrk', '只要今日突破')}
        ${chk('rsScanRs', 'RS 参与判定（需基准）')}
        <label>距新高&lt;%<input id="rsScanNear" type="number" value="${numV('rsScanNear', 5)}" step="1" style="${INP}width:56px;" /></label>
        <label>ADX≥<input id="rsScanAdx" type="number" value="${numV('rsScanAdx', 0)}" step="5" style="${INP}width:52px;" /></label>
        <label>基准代码<input id="rsScanBench" type="text" value="${v('rsScanBench', '000300')}" style="${INP}width:86px;" title="算相对强度用的指数，如 000300 沪深300 / 000001 上证指数" /></label>
        <label>轮动持有<select id="rsScanTop" style="${INP}">${[1, 2, 3, 5].map(k => `<option value="${k}" ${String(numV('rsScanTop', 2)) === String(k) ? 'selected' : ''}>前 ${k}</option>`).join('')}</select></label>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">
        参与品种：自选池 <b>${items.length}</b> 个${items.length ? '' : '（空的 —— 先去「⭐ 自选池」加品种）'}。
        扫描用<b>各品种已缓存的日线</b>，缺数据的品种会在线补拉一次；判据与「Minervini 趋势模板」策略同源。</div>
      ${this.progressHtml()}
      ${this.scanTableHtml()}`;
  }

  scanTableHtml() {
    const s = this.scan;
    if (!s) return `<div style="font-size:12px;color:var(--text-muted);">
      扫描器回答的是"今晚该看哪三张图"，而不是"该买哪个"。<br />
      点表头可换排序列；点行尾「看盘」把该品种载进主图。</div>`;
    if (s.error) return `<div style="color:var(--up-color);font-size:12px;">${esc(s.error)}</div>`;
    const rows = s.viewRows;
    const cols = [
      ['symbol', '品种', 'left'], ['close', '收盘', 'right'], ['passed', '模板', 'right'],
      ['distHigh', '距新高', 'right'], ['aboveLow', '离低点', 'right'], ['adx', 'ADX', 'right'],
      ['atrPct', 'ATR%', 'right'], ['m3m', '3月', 'right'], ['m6m', '6月', 'right'], ['m12m', '12月', 'right'],
      ['score', '动量分', 'right'], ['volRatio', '量比', 'right']
    ];
    const cellVal = (r, k) => {
      if (k === 'symbol') return `<td style="text-align:left;padding:3px 6px;white-space:nowrap;"><b style="color:#fff;">${esc(r.symbol)}</b>
        <span style="color:var(--text-muted);"> ${esc(r.name || '')}</span></td>`;
      if (k === 'passed') {
        const t = r.template || { passed: 0, enabled: 0 };
        return `<td style="text-align:center;"><span style="color:${t.ok ? 'var(--up-color)' : 'var(--text-muted)'};">${t.passed}/${t.enabled}${t.ok ? ' ✓' : ''}</span></td>`;
      }
      if (k === 'breakout') return '';
      const raw = k.startsWith('m') ? (r.mom || {})[k] : r[k];
      if (!Number.isFinite(raw)) return '<td style="text-align:center;color:var(--text-muted);">—</td>';
      const isPct = ['distHigh', 'aboveLow', 'atrPct', 'm3m', 'm6m', 'm12m'].includes(k);
      const txt = isPct ? pc(raw, 1) : k === 'close' ? nf(raw, 2) : nf(raw, k === 'volRatio' ? 2 : 1);
      const col = isPct ? (raw >= 0 ? 'var(--up-color)' : 'var(--down-color)') : 'inherit';
      return `<td style="text-align:right;color:${col};">${txt}</td>`;
    };
    const arrow = (k) => this.scanSortKey === k ? (this.scanSortDir === 'asc' ? ' ↑' : ' ↓') : '';
    return `
      ${metricCards([['可判定', s.summary.total], ['模板通过', s.summary.templateOk], ['今日突破', s.summary.breakoutToday],
        ['接近新高', s.summary.nearHigh], ['ADX≥25', s.summary.strongAdx], ['6月上涨', s.summary.rising],
        ['数据不足', (s.raw.length - s.summary.total)]], 'margin:10px 0;')}
      <div style="font-size:12px;color:${s.summary.templateOk / Math.max(1, s.summary.total) > 0.5 ? 'var(--up-color)' : 'var(--text-muted)'};margin-bottom:6px;">
        ${esc(s.summary.note)}${s.asOf ? ` · 数据截至 ${esc(s.asOf)}` : ''}</div>
      <div style="overflow:auto;border:1px solid var(--border-color);border-radius:6px;">
      <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
        <thead><tr style="background:var(--bg-tertiary);position:sticky;top:0;">
          ${cols.map(([k, label, al]) => `<th data-rs="scanSort" data-key="${k}" data-dir="${this.scanSortKey === k && this.scanSortDir === 'desc' ? 'asc' : 'desc'}"
            style="padding:4px 6px;text-align:${al === 'left' ? 'left' : 'center'};cursor:pointer;white-space:nowrap;" title="点一下按这一列排序">${esc(label)}${arrow(k)}</th>`).join('')}
          <th>突破</th><th></th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(r => `<tr style="border-top:1px solid var(--border-color);">
            ${cols.map(([k]) => cellVal(r, k)).join('')}
            <td style="text-align:center;">${r.breakout && r.breakout.broke
              ? `<span style="color:${r.breakout.volOk ? 'var(--up-color)' : 'var(--accent-gold)'};">${r.breakout.volOk ? '放量越' : '缩量越'} ${nf(r.breakout.level, 2)}</span>`
              : '<span style="color:var(--text-muted);">—</span>'}</td>
            <td style="text-align:center;"><button class="btn btn-sm" style="${BTN}padding:2px 8px;" data-rs="scanOpen" data-sym="${esc(r.symbol)}">看盘</button></td>
          </tr>`).join('') : `<tr><td colspan="${cols.length + 2}" style="padding:10px;color:var(--accent-gold);">过滤后没有品种：把条件放宽一档看看。</td></tr>`}
        </tbody></table></div>
      ${this.rotationHtml_(s)}
      ${(s.skipped || []).length ? `<div style="color:var(--accent-gold);font-size:12px;margin-top:6px;">
        ⚠ 未能扫描 ${s.skipped.length} 个：${esc(s.skipped.join('、'))}</div>` : ''}`;
  }

  /** 轮动视角：同一池品种按风险调整后动量排名，今天该持有前 K 个是谁。 */
  rotationHtml_(s) {
    const rot = s.rotation;
    if (!rot) return '';
    if (rot.error) return `<div style="font-size:12px;color:var(--text-muted);margin-top:8px;">轮动视角不可用：${esc(rot.error)}</div>`;
    const snap = rotationSnapshot(rot);
    if (!snap.rows.length) return `<div style="font-size:12px;color:var(--text-muted);margin-top:8px;">${esc(snap.note)}</div>`;
    return `
      <div style="margin-top:12px;">
        <div style="font-size:12px;color:var(--text-white);margin-bottom:4px;">
          轮动视角 · 最近调仓 ${esc(snap.date)}${snap.daysToNext ? `（还有 ${snap.daysToNext} 天再调）` : ''}</div>
        <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
          <tr style="color:var(--text-muted);text-align:right;"><th style="text-align:left;padding:2px 6px;">名次</th>
            <th style="text-align:left;">品种</th><th>动量分</th><th>6月</th><th>数据参考日</th><th>今日</th></tr>
          ${snap.rows.map(r => `<tr style="border-top:1px solid var(--border-color);text-align:right;">
            <td style="text-align:left;padding:2px 6px;">${r.rank}</td>
            <td style="text-align:left;color:#fff;">${esc(r.symbol)}</td>
            <td>${nf(r.score, 2)}</td><td>${r.mom === null ? '—' : pc(r.mom, 1)}</td>
            <td style="color:var(--text-muted);">${esc(r.refDate || '')}</td>
            <td>${r.held ? '<span style="color:var(--up-color);">持有</span>' : '<span style="color:var(--text-muted);">观望</span>'}</td></tr>`).join('')}
        </table>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${esc(rot.note)}</div>
        ${snap.skipped.length ? `<div style="font-size:11px;color:var(--accent-gold);margin-top:3px;">未参与排名：${esc(snap.skipped.join('、'))}（数据不足或太久没更新）</div>` : ''}
      </div>`;
  }

  async runScan() {
    const items = this.api.watchlistItems?.() || [];
    if (!items.length) { this.api.toast?.('自选池是空的'); return; }
    this.scan = null;
    this.busy = '扫描品种 0/' + items.length;
    this.progress = { done: 0, total: items.length };
    this.render();
    const useRs = document.getElementById('rsScanRs')?.checked === true;
    const benchCode = (document.getElementById('rsScanBench')?.value || '').trim();
    let indexBars = null;
    if (useRs && benchCode) {
      const loaded = await this.api.loadBarsFor?.({ openCode: benchCode, symbol: benchCode, market: 'index' });
      if (loaded && loaded.length > 70) indexBars = loaded;
      else this.api.toast?.(`基准 ${benchCode} 取不到数据，RS 这一条不参与判定`);
    }
    const entries = [], skipped = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const code = it.openCode || it.symbol;
      this.busy = `扫描品种 ${i + 1}/${items.length} · ${code}`;
      this.progress = { done: i + 1, total: items.length };
      this.refreshProgress();
      const bars = await this.api.loadBarsFor?.(it);
      if (!bars || bars.length < 60) { skipped.push(`${code}（${bars ? bars.length : 0} 根）`); continue; }
      entries.push({ symbol: code, name: it.name || '', bars, indexBars });
    }
    this.progress = null; this.busy = '';
    if (!entries.length) {
      this.scan = { error: '池子里没有一个品种有足够数据', skipped };
      this.render();
      return;
    }
    const raw = scanUniverse(entries, { useRs: !!indexBars });
    const topK = Number(document.getElementById('rsScanTop')?.value) || 2;
    const rot = rotationSignals(entries, { lookback: 126, volLen: 63, topK, rebalanceEvery: 21, longOnly: true });
    this.scan = {
      raw: raw.rows, skipped, asOf: raw.asOf,
      rotation: rot.rebalances.length ? rot : { error: '数据不足，没能完成一次调仓排名' },
      summary: scanSummary(raw.rows)
    };
    this.applyScanFilter();
    this.api.toast?.(`扫描完成：${raw.length} 个品种`);
  }

  applyScanFilter() {
    const s = this.scan;
    if (!s) return;
    const near = Number(document.getElementById('rsScanNear')?.value);
    const adx = Number(document.getElementById('rsScanAdx')?.value);
    const filtered = filterRows(s.raw, {
      templateOnly: document.getElementById('rsScanTpl')?.checked !== false,
      breakoutOnly: document.getElementById('rsScanBrk')?.checked === true,
      nearHighPct: Number.isFinite(near) && near > 0 ? near / 100 : null,
      adxMin: Number.isFinite(adx) && adx > 0 ? adx : null
    });
    s.viewRows = sortRows(filtered, this.scanSortKey || 'score', this.scanSortDir || 'desc');
    this.render();
  }

  // ---------------- 报表 ----------------
  reportHtml() {
    const r = this.report;
    if (!r) return `<div style="margin-bottom:8px;"><button class="btn btn-sm" style="${BTN_HI}" data-rs="runReport">📊 生成本品种完整报表</button>
      <span style="font-size:12px;color:var(--text-muted);margin-left:8px;">用当前图表数据 + 回测面板里那套参数</span></div>`;
    return `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
        <button class="btn btn-sm" style="${BTN}" data-rs="exportHtml">⬇ 导出 HTML 报告</button>
        <button class="btn btn-sm" style="${BTN}" data-rs="exportCsv">⬇ 导出 CSV</button>
        <button class="btn btn-sm" style="${BTN}" data-rs="runReport">↻ 重新生成</button>
      </div>
      ${monthlyHeatmap(r.monthly)}
      ${sparklineHtml(r.underwater.series.map(s => ({ date: s.date, equity: s.equity })), '权益曲线')}
      ${underwaterChartHtml(r.underwater)}
      ${distTables(r.distribution)}
      ${r.bench ? benchBlock(r.bench) : ''}`;
  }

  buildReport() {
    const bars = this.bars;
    const sp = this.specFor(this.code);
    if (!sp || bars.length < 60) { this.api.toast?.('数据不足'); return; }
    const strategy = getStrategy(this.api.currentStrategyId?.() || 'donchianBreak');
    const params = this.api.currentParams?.() || { ...strategy.params };
    const engineOpts = { ...this.engineOpts(), rules: sp.rules };
    this.busy = '生成报表';
    this.render();
    setTimeout(() => {
      const res = runOne({ bars, spec: sp.spec, strategy, params, engineOpts, periodsPerYear: this.api.chart?.periodsPerYear || 252 });
      const bench = benchmarkSeries(res.equityCurve, buyHold(bars, sp.spec, res.metrics.capital, engineOpts.lots || 1));
      this.report = {
        metrics: res.metrics, trades: res.trades, equityCurve: res.equityCurve,
        monthly: monthlyReturns(res.equityCurve), underwater: underwaterSeries(res.equityCurve),
        distribution: tradeDistribution(res.trades), bench, params, strategyName: strategy.name
      };
      this.busy = '';
      this.render();
    }, 20);
  }

  exportHtml() {
    const r = this.report;
    if (!r) return;
    const html = reportToHtml({
      title: `回测报告 · ${this.code} · ${r.strategyName}`, metrics: r.metrics, monthly: r.monthly,
      underwater: r.underwater, distribution: r.distribution, walkForward: this.wf, allocation: this.portfolio?.allocation,
      generatedAt: new Date().toLocaleString('zh-CN')
    });
    downloadFile(`${this.code}_report.html`, html, 'text/html');
  }

  exportCsv() {
    const r = this.report;
    if (!r) return;
    downloadFile(`${this.code}_report.csv`, reportToCsv({
      metrics: r.metrics, allocation: this.portfolio?.allocation, trades: r.trades, walkForwardSummary: this.wf?.summary
    }), 'text/csv');
  }
}


/* ---------------- 渲染小件 ---------------- */

/** 指标卡片网格：组合/蒙特卡洛/扫描三页共用，免得同一个数字在两处格式不一样。 */
function metricCards(pairs, extraStyle = 'margin-top:10px;') {
  return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;${extraStyle}">
    ${pairs.map(([k, val]) => `<div style="background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:5px;padding:7px 9px;">
      <div style="font-size:11px;color:var(--text-muted);">${esc(k)}</div><div style="font-size:15px;color:#fff;font-weight:600;">${esc(val)}</div></div>`).join('')}
  </div>`;
}

function monthlyHeatmap(m) {
  if (!m || !m.rows || !m.rows.length) return '';
  const cell = (v) => {
    if (v === undefined || v === null) return '<td></td>';
    const a = Math.min(1, Math.abs(v) / 0.12);
    const bg = v >= 0 ? `rgba(239,68,68,${(0.12 + a * 0.55).toFixed(2)})` : `rgba(16,185,129,${(0.12 + a * 0.55).toFixed(2)})`;
    return `<td style="background:${bg};color:#fff;text-align:center;padding:3px 2px;font-size:11px;">${(v * 100).toFixed(1)}</td>`;
  };
  return `<h4 style="margin:14px 0 6px;color:var(--text-white);font-size:13px;">月度收益热力图（%）</h4>
    <div style="overflow:auto;"><table style="border-collapse:collapse;font-size:11px;">
    <tr><th style="padding:3px 6px;color:var(--text-muted);">年</th>${MON.map(x => `<th style="color:var(--text-muted);">${x}</th>`).join('')}<th style="padding:3px 6px;color:var(--text-muted);">全年</th></tr>
    ${m.rows.map(r => `<tr><td style="padding:3px 6px;color:var(--text-muted);">${esc(r.year)}</td>${MON.map((_, i) => cell(r.months[i])).join('')}<td>${cell(r.total)}</td></tr>`).join('')}
    </table></div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">红=盈利、绿=亏损（国内配色习惯）。空白格表示该月无数据或缺基期。</div>`;
}

function sparklineHtml(points, label) {
  if (!points || points.length < 2) return '';
  const vals = points.map(p => p.equity);
  const min = Math.min(...vals), max = Math.max(...vals);
  const w = 100, h = 28;
  const path = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p.equity - min) / (max - min || 1)) * h;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  return `<div style="margin:10px 0;">
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px;">${esc(label)} ${nf(min, 0)} ~ ${nf(max, 0)}</div>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:56px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:4px;">
      <path d="${path}" fill="none" stroke="#60a5fa" stroke-width="0.6" vector-effect="non-scaling-stroke" /></svg></div>`;
}

/**
 * 蒙特卡洛分位带：P5~P95 的权益包络 + 历史实际那条。
 * 画在一起才有说服力 —— 单独一条"历史回撤 18%"看不出它是常态还是运气。
 */
function bandChartSvg(r) {
  const b = r.bands;
  if (!b || b.steps.length < 3) return '';
  const w = 100, h = 42;
  const n = b.steps.length;
  const lo = Math.min(...b.p5, ...(r.actual.curve || []));
  const hi = Math.max(...b.p95, ...(r.actual.curve || []));
  const span = (hi - lo) || 1;
  const X = (i) => (i / (n - 1)) * w;
  const Y = (v) => h - ((v - lo) / span) * h;
  const band = b.p5.map((v, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(2)},${Y(v).toFixed(2)}`).join(' ')
    + b.p95.slice().reverse().map((v, k) => `L${X(n - 1 - k).toFixed(2)},${Y(v).toFixed(2)}`).join(' ') + 'Z';
  const line = (arr) => arr.map((v, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(2)},${Y(v).toFixed(2)}`).join(' ');
  // 实际路径的横轴是"第几笔"，要映射到采样后的列上
  const curve = r.actual.curve || [];
  const actual = curve.length > 1
    ? curve.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (curve.length - 1)) * (n - 1)).toFixed(2)},${Y(v).toFixed(2)}`).join(' ')
    : '';
  const capY = Y(r.capital);
  return `<div style="margin:8px 0 4px;">
    <div style="font-size:11px;color:var(--text-muted);">重放权益分位带：${lo.toFixed(0)} ~ ${hi.toFixed(0)}（灰带 P5–P95，蓝线 P50，橙线＝历史实际）</div>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:96px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:4px;">
      <path d="${band}" fill="rgba(148,163,184,.22)" stroke="none" />
      <line x1="0" y1="${capY.toFixed(2)}" x2="${w}" y2="${capY.toFixed(2)}" stroke="#848c9e" stroke-width="0.4" stroke-dasharray="1.5,1.5" vector-effect="non-scaling-stroke" />
      <path d="${line(b.p50)}" fill="none" stroke="#60a5fa" stroke-width="0.7" vector-effect="non-scaling-stroke" />
      ${actual ? `<path d="${actual}" fill="none" stroke="#f59e0b" stroke-width="0.7" vector-effect="non-scaling-stroke" />` : ''}
    </svg></div>`;
}

/** 参数矩阵热图：一行一列的表格，色深按得分。空格保持空白，不画成 0 分。 */
function heatmapHtml(h) {
  if (!h || h.error) return '';
  const vals = h.cells.flat().map(c => c.score).filter(Number.isFinite);
  if (!vals.length) return '';
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const best = h.best?.score;
  const cell = (c) => {
    if (!Number.isFinite(c.score)) return `<td style="text-align:center;color:var(--text-muted);background:repeating-linear-gradient(45deg,transparent,transparent 4px,rgba(255,255,255,.05) 4px,rgba(255,255,255,.05) 8px);" title="网格里没扫到这个组合">—</td>`;
    const rel = hi > lo ? (c.score - lo) / (hi - lo) : 1;
    const isBest = c.score === best;
    return `<td style="text-align:center;background:rgba(41,98,255,${(0.10 + rel * 0.55).toFixed(2)});color:#fff;${isBest ? 'outline:1.5px solid var(--accent-gold);' : ''}"
      title="${esc(JSON.stringify(c.params))} · 样本 ${c.n} 组">${nf(c.score, 2)}</td>`;
  };
  return `<div style="margin:12px 0;">
    <div style="font-size:12px;color:var(--text-white);margin-bottom:4px;">参数矩阵热图（行 ${esc(h.yDim)} × 列 ${esc(h.xDim)}，得分 ${nf(lo, 2)} ~ ${nf(hi, 2)}）
      <button class="btn btn-sm" style="${BTN}padding:2px 8px;margin-left:8px;" data-rs="applyBest">用热图最优这组</button></div>
    <div style="overflow:auto;"><table style="border-collapse:collapse;font-size:11px;width:100%;">
      <tr><th style="padding:3px 6px;color:var(--text-muted);">${esc(h.yDim)}\\${esc(h.xDim)}</th>
        ${h.xVals.map(x => `<th style="color:var(--text-muted);padding:2px 4px;">${esc(x)}</th>`).join('')}</tr>
      ${h.cells.map((row, j) => `<tr><td style="padding:2px 6px;color:var(--text-muted);text-align:right;">${esc(h.yVals[j])}</td>${row.map(cell).join('')}</tr>`).join('')}
    </table></div>
    <div style="font-size:11px;color:${h.plateau && h.plateau.ratio < 0.5 ? 'var(--accent-gold)' : 'var(--text-muted)'};margin-top:4px;">
      ${h.plateau ? `最优格 ${esc(String(h.best.x))}×${esc(String(h.best.y))} 的 ${h.plateau.total} 个邻格里 ${h.plateau.alive} 个保留了 60% 以上得分 —— ${esc(h.plateau.verdict)}。` : ''}
      ${esc(h.note)}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--text-muted);margin-top:4px;">
      <span>换列维度：</span>
      ${(h.sweptDims || Object.keys(h.cells.flat().find(c => c.params)?.params || {})).map(k =>
        `<button class="btn btn-sm" style="${BTN}padding:2px 7px;" data-rs="heat" data-x="${esc(k)}" data-y="${esc(k === h.xDim ? h.yDim : h.xDim)}">${esc(k)} 为列</button>`).join('')}
      ${(h.fixedDims || []).length ? `<span style="align-self:center;">（${esc(h.fixedDims.join('、'))} 没进网格，摊成行列只会得到 1×1）</span>` : ''}
    </div></div>`;
}

function underwaterChartHtml(u) {
  const s = u?.series;
  if (!s || s.length < 2) return '';
  const w = 100, h = 30;
  const path = s.map((p, i) => {
    const x = (i / (s.length - 1)) * w;
    const y = Math.abs(p.drawdown) * h;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ') + ` L${w},${h} L0,${h} Z`;
  return `<div style="margin:10px 0;">
    <div style="font-size:11px;color:var(--text-muted);">水下曲线（最深 ${pc(u.maxDDPct)}，最长水下 ${u.worstUnderwater.days} 根：${esc(u.worstUnderwater.from || '')} → ${esc(u.worstUnderwater.to || '')}）</div>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:52px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:4px;">
      <path d="${path}" fill="rgba(16,185,129,.28)" stroke="#10b981" stroke-width="0.5" vector-effect="non-scaling-stroke" /></svg></div>`;
}

function distTables(d) {
  if (!d) return '';
  const blocks = [['byDirection', '按方向'], ['byExitReason', '按出场原因'], ['byHolding', '按持仓 bar 数'], ['byMonth', '按平仓月份'], ['bySymbol', '按品种']];
  return blocks.map(([key, label]) => {
    const rows = d[key] || [];
    if (!rows.length) return '';
    return `<h4 style="margin:12px 0 5px;font-size:12px;color:var(--text-white);">${esc(label)}</h4>
      <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <tr style="color:var(--text-muted);"><th style="text-align:left;padding:3px 6px;">${esc(label)}</th><th>笔数</th><th>胜率</th><th>净盈亏</th><th>单笔均额</th></tr>
      ${rows.map(r => `<tr style="border-top:1px solid var(--border-color);"><td style="text-align:left;padding:3px 6px;">${esc(r.key)}</td><td>${r.n}</td><td>${pc(r.winRate, 0)}</td>
        <td style="color:${r.pnl >= 0 ? 'var(--up-color)' : 'var(--down-color)'};">${nf(r.pnl, 1)}</td><td>${nf(r.avg, 1)}</td></tr>`).join('')}</table>`;
  }).join('');
}

function benchBlock(b) {
  if (!b || !b.series || b.series.length < 2) return '';
  const w = 100, h = 30;
  const max = Math.max(...b.series.map(p => Math.max(p.strategy, p.bench)));
  const min = Math.min(...b.series.map(p => Math.min(p.strategy, p.bench)));
  const line = (key) => b.series.map((p, i) => {
    const x = (i / (b.series.length - 1)) * w;
    const y = h - ((p[key] - min) / (max - min || 1)) * h;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  return `<div style="margin:12px 0;">
    <div style="font-size:11px;color:var(--text-muted);">基准对比：策略 ${pc(b.strategyReturn)} vs 基准 ${pc(b.benchReturn)} → alpha ${pc(b.alpha)}</div>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:56px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:4px;">
      <path d="${line('bench')}" fill="none" stroke="#848c9e" stroke-width="0.6" vector-effect="non-scaling-stroke" />
      <path d="${line('strategy')}" fill="none" stroke="#60a5fa" stroke-width="0.6" vector-effect="non-scaling-stroke" /></svg></div>`;
}

function downloadFile(name, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
