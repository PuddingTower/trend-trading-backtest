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
import { runPortfolio } from '../core/portfolio.js';
import { monthlyReturns, underwaterSeries, tradeDistribution, benchmarkSeries, reportToCsv, reportToHtml } from '../report/advanced.js';
import { resolveTradeSpec } from '../markets/instrumentSpec.js';
import { rulesFor } from '../markets/marketRules.js';
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
  rsiReversion: { period: [7, 14, 21], low: [20, 30], high: [70, 80] }
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
      else if (act === 'runReport') this.buildReport();
      else if (act === 'applyRow') this.applyRow(Number(el.dataset.idx));
      else if (act === 'robust') this.computeRobustness(Number(el.dataset.idx));
      else if (act === 'exportCsv') this.exportCsv();
      else if (act === 'exportHtml') this.exportHtml();
      else if (act === 'stop') this.stopRun();
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
    const tabs = [['grid', '🎯 参数寻优'], ['wf', '🚪 Walk-Forward'], ['port', '🧺 组合回测'], ['rep', '📊 报表与导出']]
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
    const body = this.tab === 'grid' ? this.gridHtml() : this.tab === 'wf' ? this.wfHtml() : this.tab === 'port' ? this.portHtml() : this.reportHtml();
    this.root.innerHTML = head + body;
  }

  strategySelect(id) {
    const cur = document.getElementById(id)?.value || 'donchianBreak';
    return `<select id="${id}" style="${INP}">` + STRATEGIES.map(s => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('') + '</select>';
  }

  gridHtml() {
    const sid = document.getElementById('rsStrategy')?.value || 'donchianBreak';
    const def = getStrategy(sid);
    const gridText = document.getElementById('rsGrid')?.value ?? JSON.stringify(DEFAULT_GRIDS[sid] || {});
    const objSel = `<select id="rsObjective" style="${INP}">` +
      Object.entries(OBJECTIVES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('') + '</select>';
    return `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
        ${this.strategySelect('rsStrategy')} ${objSel}
        <button class="btn btn-sm" style="${BTN_HI}" data-rs="runGrid">▶ 开始寻优</button>
        ${this.busy ? `<button class="btn btn-sm" style="${BTN}" data-rs="stop">■ 停止</button>` : ''}
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">参数网格（每行一个维度，值用逗号或数组）：</div>
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
    return `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.8;">
      共 ${rows.length} 组参数。其中 <b>${thin}</b> 组笔数 &lt; 10（样本太少，成绩没有统计意义），
      <b>${ruined}</b> 组亏光。第 1 名分位 ${(rows[0].percentile * 100).toFixed(0)}% ——
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
    return `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;font-size:12px;">
        ${this.strategySelect('rsPortStrategy')}
        <label>权重<select id="rsWeights" style="${INP}"><option value="equal">等权</option><option value="inverseVol">逆波动率</option></select></label>
        <label>保证金上限%<input id="rsCap" type="number" value="60" style="${INP}width:66px;" /></label>
        <label>资金<input id="rsPortCap" type="number" value="1000000" style="${INP}width:110px;" /></label>
        <button class="btn btn-sm" style="${BTN_HI}" data-rs="runPort">▶ 跑组合</button>
      </div>
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

  async runPortfolio() {
    const items = this.api.watchlistItems?.() || [];
    const checked = [...this.root.querySelectorAll('.rsPortPick:checked')].map(el => items[Number(el.value)]).filter(Boolean);
    if (checked.length < 2) { this.api.toast?.('至少勾两个品种'); return; }
    const strategy = getStrategy(document.getElementById('rsPortStrategy').value);
    const weights = document.getElementById('rsWeights').value;
    const capPct = Number(document.getElementById('rsCap').value) / 100;
    const capital = Number(document.getElementById('rsPortCap').value) || 1000000;
    const base = this.engineOpts();
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
        symbol: code, name: it.name, bars, spec: sp.spec,
        strategy, params: { ...strategy.params },
        // 不传 capital：组合的分仓资金由权重决定，带进去会盖掉分配（core/portfolio 也会兜住这件事）
        engineOpts: { sizing: base.sizing, lots: base.lots, slippageTicks: base.slippageTicks,
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
    setTimeout(() => {
      this.portfolio = runPortfolio({ entries, capital, weights, maxMarginPct: Number.isFinite(capPct) && capPct > 0 ? capPct : null });
      this.busy = '';
      this.render();
      this.api.toast?.(`组合完成：${entries.length} 个品种`);
    }, 30);
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
