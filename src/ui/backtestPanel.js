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
import { annotateGaps, checkAdjustmentContinuity, checkRolloverGaps, checkPriceValidity, repairAdjustmentGaps } from '../markets/dataQuality.js';

const pct = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (v * 100).toFixed(d) + '%';
const num = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : Number(v).toFixed(d);
const money = (v) => (v === null || !Number.isFinite(v)) ? '—' : Math.round(v).toLocaleString('zh-CN');
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 参数的中文名与提示。策略库里存的是 `fast/slow/...` 这种给代码看的键，
 * 直接把它们当标签摆给用户，等于要求用户先读源码才知道该调什么。
 * 这里只做展示层映射，不改策略库的键名 —— 跑批/寻优/历史结果仍用原键。
 */
const PARAM_LABELS = {
  fast: '快线', slow: '慢线', signal: '信号线周期', mode: '均线类型',
  atrLen: 'ATR周期', stopAtr: '初始止损(ATR倍)', trailAtr: '移动止损(ATR倍)', bothWays: '允许反手',
  entry: '入场回看(根)', exit: '出场回看(根)', n: '周期N(根)', k1: '上轨系数', k2: '下轨系数',
  zeroFilter: '零轴过滤', swingPct: '摆动幅度%', lookback: '回看根数', period: 'RSI周期',
  low: '超卖线', high: '超买线', exitLevel: '退出线',
  maFast: '快线', maMid: '中线', maSlow: '慢线', rangeLook: '区间回看(根)',
  minAboveLow: '站上低点最少条', maxBelowHigh: '距高点最多%', riseLook: '上涨回看(根)',
  useRs: '相对强度过滤', pivotLook: '枢轴回看(根)', pivotVolMul: '枢轴量能倍数',
  stopPct: '止损%', exitMa: '退出均线',
  maLen: '均线周期', adxLen: 'ADX周期', adxMin: 'ADX阈值', breakout: '突破回看(根)',
  volLen: '量能周期', volMul: '量能倍数',
  startMul: '起涨量倍数', shrinkMul: '回调缩量倍数', minPull: '最短回调(根)',
  maxPull: '最长回调(根)', breakMul: '突破量倍数', exitLowLook: '退出低点回看(根)'
};
const PARAM_HINTS = {
  fast: '短周期均线；越小越灵敏，也越容易被震荡打脸',
  slow: '长周期均线；必须大于快线',
  atrLen: 'ATR 回看根数；止损/移动止损都按它算',
  stopAtr: '0 = 不挂初始止损；趋势策略常用 1.5~2 倍 ATR',
  trailAtr: '从持仓极值回撤 N 倍 ATR 收紧止损；0 = 不移动',
  bothWays: '关闭则只做多，不再反手做空',
  mode: 'EMA 响应快；SMA 更平滑',
  zeroFilter: '只做与 MACD 零轴同向的信号',
  useRs: '要求品种强于基准；没有基准数据时会自动跳过',
  minPull: 'N 字回调允许的最少根数',
  maxPull: 'N 字回调允许的最多根数',
  startMul: '起涨根成交量至少是均量的几倍；调低更容易触发',
  shrinkMul: '回调段每根成交量最多是均量的几倍；调高更容易触发',
  breakMul: '突破根成交量至少是均量的几倍；调低更容易触发'
};
const PARAM_OPTIONS = { mode: [['ema', 'EMA（响应快）'], ['sma', 'SMA（更平滑）']] };
const STRATEGY_DESC = {
  maCross: '快慢均线交叉：金叉做多、死叉反手；最基础的趋势跟随。',
  donchianBreak: '唐奇安通道：突破 N 日高点追多，跌破 N 日低点反手，海龟式。',
  dualThrust: 'Dual Thrust：用前 N 日振幅定上下轨，突破区间才入场。',
  macdTrend: 'MACD 趋势：快慢线与信号线定方向，可加零轴过滤。',
  hhLlStructure: '高低点结构：按 HH/HL 判趋势，结构破坏才出场。',
  rsiReversion: 'RSI 均值回归：超买做空、超卖做多；作为趋势策略的对照，不是趋势系统。',
  minerviniTemplate: 'Minervini 趋势模板 + 枢轴突破；参数最多，建议先用默认值。',
  trendRegime: '趋势区间过滤：均线/ADX 确认趋势，放量突破才入场。',
  nVolumePattern: 'N 字量价：倍量起涨 → 缩量回调 → 放量突破；条件较严，0 笔成交时先调低量能倍数。'
};
const paramLabel = (k) => PARAM_LABELS[k] || k;
const paramValueLabel = (k, v) => k === 'mode'
  ? (v === 'ema' ? 'EMA' : v === 'sma' ? 'SMA' : v) : v;

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
      maintenanceRatio: (Number(this.root.querySelector('#btMaint')?.value) || 75) / 100,
      breakevenR: Number(this.root.querySelector('#btBe')?.value) || 0,
      timeStopBars: Number(this.root.querySelector('#btTimeStop')?.value) || 0,
      repairAdjustment: this.root.querySelector('#btRepair')?.checked ?? false,
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
            ${STRATEGIES.map(s => `<option value="${s.id}" title="${esc(STRATEGY_DESC[s.id] || '')}" ${s.id === st.id ? 'selected' : ''}>${s.name}</option>`).join('')}
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
        <label data-sizing="notional" style="font-size:11px; color:var(--text-muted);">单笔占比%
          <input id="btNotional" class="form-input" type="number" value="25" min="1" max="100" style="width:56px;" /></label>
        <label data-sizing="fixed" style="font-size:11px; color:var(--text-muted);">固定手数
          <input id="btLots" class="form-input" type="number" value="1" min="1" style="width:52px;" /></label>
        <label style="font-size:11px; color:var(--text-muted);">滑点tick
          <input id="btSlip" class="form-input" type="number" value="1" min="0" style="width:48px;" /></label>
        <label style="font-size:11px; color:var(--text-muted); display:flex; align-items:center; gap:4px;"
          title="仅期货有效；A股按 T+1 与仅做多规则处理，勾了也不会开空">
          <input id="btAllowShort" type="checkbox" checked /> 允许做空</label>
        <span style="font-size:11px; color:var(--text-muted);"
          title="期货/杠杆品种强制逐日盯市：每个交易日按结算价划转浮盈、重算占用；A股现货无杠杆，不结算、不强平">
          逐日盯市：<b style="color:var(--text-main);">期货强制 / A股不适用</b></span>
        <label style="font-size:11px; color:var(--text-muted); display:flex; align-items:center; gap:4px;"
          title="期货/杠杆品种：权益跌破「占用保证金 × 该比例」即在下一根开盘强平；A股不适用">维持比例%
          <input id="btMaint" class="form-input" type="number" value="75" min="10" max="100" style="width:52px;" /></label>
        <label style="font-size:11px; color:var(--text-muted); display:flex; align-items:center; gap:4px;"
          title="浮盈达到该倍初始风险后，把止损抬到开仓价（保本）。0=不启用；策略没挂初始止损时无法定义 1R，会自动跳过">保本×R
          <input id="btBe" class="form-input" type="number" value="0" min="0" step="0.5" style="width:48px;" /></label>
        <label style="font-size:11px; color:var(--text-muted); display:flex; align-items:center; gap:4px;"
          title="持仓超过该根数仍未脱离成本，下一根开盘平仓（趋势不启动就走人）。0=不启用">时间止损(根)
          <input id="btTimeStop" class="form-input" type="number" value="0" min="0" step="1" style="width:48px;" /></label>
        <button class="btn btn-primary btn-sm" id="btRun">▶ 运行回测</button>
        <button class="btn btn-sm" id="btCheck" title="只体检数据不跑策略：停牌缺口、复权断崖、换月跳空">🩺 数据体检</button>
        <label style="font-size:11px; color:var(--text-muted); display:flex; align-items:center; gap:4px;"
          title="A股专用：把超过涨跌停幅度的隔夜跳空按复权因子接回（前复权本来就该这么做）。默认关闭，勾选后体检和回测都会用修正后的序列；成交额/成交量不改。">
          <input id="btRepair" type="checkbox" /> 修复杂复权断崖</label>
        <button class="btn btn-sm" id="btClearMarks">清除图上标记</button>
      </div>
      <div id="btParams" style="display:flex; flex-wrap:wrap; gap:10px; padding:0 4px 8px; border-bottom:1px solid var(--border-color);"></div>
      <div id="btDq" style="padding:6px 4px 0; font-size:11px; color:var(--text-muted);"></div>
      <div id="btOut" style="padding:8px 4px; color:var(--text-muted); font-size:12px;">
        选策略与参数后点【运行回测】。成交口径为<b style="color:var(--accent-gold);">信号次日开盘成交</b>，
        含手续费、平今费与滑点；跳空穿透止损按开盘价成交，不做美化。<br>
        <span style="font-size:11px; opacity:.8;">默认参数只用于跑通口径，不代表策略能赚钱；判断策略请用寻优与 Walk-Forward 的样本外结果。</span>
      </div>`;
    this.renderParams();
    const syncSizing = () => {
      const mode = this.root.querySelector('#btSizing').value;
      this.root.querySelectorAll('[data-sizing]').forEach(el => {
        el.style.display = el.getAttribute('data-sizing') === mode ? '' : 'none';
      });
    };
    this.root.querySelector('#btSizing').addEventListener('change', syncSizing);
    syncSizing();
    this.root.querySelector('#btStrategy').addEventListener('change', () => this.renderParams());
    this.root.querySelector('#btRun').addEventListener('click', () => this.run());
    this.root.querySelector('#btCheck').addEventListener('click', () => {
      const bars = this.sliceBars(this.state.range);
      const code = this.chart.backtestCode || this.chart.data?.[0]?.symbol;
      this.renderDataQuality(bars, code, { standalone: true });
    });
    this.root.querySelector('#btClearMarks').addEventListener('click', () => {
      this.chart.backtestMarkers = null; this.chart.requestRender();
    });
  }

  renderParams() {
    const st = STRATEGIES.find(s => s.id === this.root.querySelector('#btStrategy').value);
    const box = this.root.querySelector('#btParams');
    const inputs = Object.entries(st.params).map(([k, v]) => {
      const isBool = typeof v === 'boolean';
      const options = PARAM_OPTIONS[k];
      const input = isBool
        ? `<input data-p="${k}" data-t="bool" type="checkbox" ${v ? 'checked' : ''} style="width:auto;" />`
        : options
          ? `<select data-p="${k}" data-t="str" class="form-input" style="width:118px;">`
            + options.map(([val, label]) => `<option value="${esc(val)}" ${v === val ? 'selected' : ''}>${esc(label)}</option>`).join('')
            + '</select>'
          : typeof v === 'string'
            ? `<input data-p="${k}" data-t="str" value="${esc(v)}" class="form-input" style="width:80px;" />`
            : `<input data-p="${k}" data-t="num" type="number" value="${v}" step="${Math.abs(v) < 1 ? 0.05 : 1}" class="form-input" style="width:68px;" />`;
      const hint = PARAM_HINTS[k] ? ` title="${esc(PARAM_HINTS[k])}"` : '';
      return `<label style="font-size:11px; color:var(--text-muted); display:flex; align-items:center; gap:4px;"${hint}>${esc(paramLabel(k))} ${input}</label>`;
    }).join('');
    box.innerHTML = `
      <div style="flex-basis:100%; font-size:11px; color:var(--text-muted);">
        ${esc(STRATEGY_DESC[st.id] || '')}
        <span style="opacity:.7;">参数名后括号是单位；改完点「运行回测」即可。</span>
      </div>
      ${inputs}
      <button class="btn btn-sm" id="btResetParams" style="font-size:11px;" title="把当前策略的参数恢复为策略库默认值">恢复默认</button>`;
    box.querySelector('#btResetParams')?.addEventListener('click', () => this.renderParams());
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

  /**
   * 数据体检：缺口/停牌标注 + 复权连续性 + 换月跳空，并产出**带标记字段的 K 线副本**给撮合层。
   *
   * 结论必须显示出来，而不是只在后台悄悄改字段：复权没做好时回测照样能跑出很漂亮曲线，
   * 这类错不会报错，只会让结果不可信 —— 所以「体检」既是提示，也是本次回测的输入口径。
   * 标注函数按日期重排过，顺序和图表不一致的话图上标记会错位到别的 K 线，因此显式校验一次。
   */
  qualityCheck(bars, code) {
    const host = this.root.querySelector('#btDq');
    const resolved = resolveTradeSpec(code || 'RB0');
    const spec = resolved.ok ? resolved.spec : null;
    const limitPct = spec && Number(spec.limitPct) > 0 ? Number(spec.limitPct) : 0;
    // 指数/无板幅品种的 spec.limitPct 是 0；不能拿 10% 的默认值去判它"复权断崖"
    const adjLimit = spec && Number.isFinite(Number(spec.limitPct)) ? Number(spec.limitPct) : 0.10;
    if (!bars || bars.length < 2) {
      if (host) host.innerHTML = '<span style="color:var(--up-color);">数据不足两根，无法体检。</span>';
      return { bars: bars || [], usable: false };
    }
    const isFutures = !!spec && spec.market === 'futures';
    // 复权修正只在用户显式勾选时做：悄悄改历史价格比报错更危险。
    let useBars = bars;
    let repair = null;
    if (!isFutures && this.state.repairAdjustment) {
      repair = repairAdjustmentGaps(useBars, { limitPct: adjLimit });
      if (repair.changed) useBars = repair.bars;
    }
    const ann = annotateGaps(useBars, { market: isFutures ? 'futures' : 'ashare' });
    const keepsOrder = ann.bars.length === useBars.length
      && ann.bars.every((b, i) => String(b.date).slice(0, 10) === String(useBars[i].date).slice(0, 10));
    const cont = isFutures
      ? { issues: checkRolloverGaps(useBars, { limitPct: limitPct > 0 ? limitPct : 0.08 }),
          label: '换月跳空', tail: '连续合约在换月当天的价差不是行情。若拼接模式用的是「原始价位」，这些缺口会被当成真突破/真跌破。' }
      : { ...checkAdjustmentContinuity(useBars, { limitPct: adjLimit }), label: '复权断崖' };
    const pv = checkPriceValidity(useBars);
    const gaps = ann.longGaps;
    const worst = gaps.length ? gaps.reduce((a, b) => (b.naturalDays > a.naturalDays ? b : a)) : null;
    const staleCount = ann.bars.filter(b => b.stalePrevClose).length;

    const parts = [];
    if (repair && repair.changed) parts.push(`<span style="color:var(--accent-gold);">🔧 ${esc(repair.note)}</span>`);
    parts.push(`自然日缺口 <b>${gaps.length}</b> 处（≥4 天）${worst ? `，最长 ${worst.naturalDays} 天：${esc(worst.from)}→${esc(worst.to)}（${esc(worst.to)} 那根不套用板锁）` : ''}`);
    parts.push(ann.calendarKnown
      ? (ann.calendarSource === 'builtin'
        ? `已用内置${esc(ann.calendarLabel || '')}交易日历区分停牌与节假日`
          + (ann.calendarPartial ? `（${esc(ann.calendarReason || '部分日期超出日历覆盖')}）` : '')
        : '已用参照交易日历区分停牌与节假日')
      : `<span style="color:var(--accent-gold);">无可用的交易日历${ann.calendarReason ? `（${esc(ann.calendarReason)}）` : ''}：长假与停牌在单品种数据里无法区分，只报自然日缺口</span>`);
    if (cont.issues.length) {
      parts.push(`<span style="color:var(--accent-gold);">${cont.label} <b>${cont.issues.length}</b> 处：`
        + cont.issues.slice(0, 5).map(x => `${esc(x.date)} ${(x.jump * 100).toFixed(1)}%`).join('、')
        + (cont.issues.length > 5 ? '…' : '') + (cont.note ? `。${esc(cont.note)}` : (cont.tail ? `。${esc(cont.tail)}` : '')) + '</span>');
    } else {
      parts.push(esc(cont.note || cont.tail || '未发现异常跳空'));
    }
    if (pv.count) {
      const neg = pv.bad.filter(x => x.values.some(v => Number.isFinite(v) && v <= 0)).length;
      parts.push('<span style="color:var(--up-color);">价格有效性 <b>' + pv.count + '</b> 根不合格（其中 '
        + neg + ' 根含零或负价）：'
        + pv.bad.slice(0, 3).map(x => `${esc(x.date)} ${x.fields.join('/')}=${x.values.join(',')}`).join('、')
        + (pv.count > 3 ? '…' : '')
        + '。这种序列进撮合会把保证金占用算成负数，请先缩短起始区间或换复权口径</span>');
    }
    if (!keepsOrder) parts.push('<span style="color:var(--up-color);">K 线日期不是升序，缺口标注已跳过（否则图上标记会错位）</span>');
    if (staleCount) parts.push(`前收盘失效（缺口过长）<b>${staleCount}</b> 根：这些 bar 的涨跌停判定已跳过`);
    if (host) {
      host.innerHTML = `<div style="margin-bottom:2px;">🩺 数据体检</div>`
        + parts.map(p => `<div style="margin-top:2px;">· ${p}</div>`).join('');
    }
    return { bars: keepsOrder ? ann.bars : useBars, usable: keepsOrder && pv.usable,
             gaps, suspensions: ann.suspensions, continuity: cont, priceValidity: pv,
             repair, repaired: !!(repair && repair.changed) };
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
    // 先体检再用带缺口标记的那份 K 线：停牌日不许成交、前收盘失效的 bar 不套用板锁，
    // 这些都靠 annotateGaps 写进 bar 的字段，撮合层只认字段不认提示。
    const qc = this.qualityCheck(bars, code);
    const useBars = qc.bars && qc.bars.length ? qc.bars : bars;

    // 零或负价直接拒跑：占用 = 价×乘数×保证金率，负价会把占用算成负数，
    // 板幅基准也会翻向 —— 这不是"结果差一点"，是整条权益曲线没有意义。
    if (qc.priceValidity && qc.priceValidity.count) {
      out.innerHTML = `<span style="color:var(--up-color);">已拒绝回测：${esc(qc.priceValidity.note)}</span>`;
      return;
    }

    let res;
    try {
      const signals = def.signals(useBars, params);
      const rules = rulesFor(spec);
      if (!s.allowShort && rules.canOpen(-1).ok) { rules.spec = { ...spec, allowShort: false }; }
      const eng = new BacktestEngine(useBars, spec, {
        capital: s.capital, sizing: s.sizing, notionalPct: s.notionalPct,
        lots: s.lots, slippageTicks: s.slippageTicks, allowShort: s.allowShort,
        // 期货/杠杆品种强制逐日盯市；维持比例仍由面板控制，A股现货不适用。
        settlement: { enabled: true, maintenanceRatio: s.maintenanceRatio },
        maintenanceRatio: s.maintenanceRatio,
        breakeven: s.breakevenR > 0 ? { afterR: s.breakevenR, extraPct: 0 } : null,
        timeStop: s.timeStopBars > 0 ? { bars: s.timeStopBars, requireLoss: true } : null,
        rules
      });
      const raw = eng.run(signals);
      const metrics = computeMetrics({
        equityCurve: raw.equityCurve, trades: raw.trades, capital: s.capital,
        periodsPerYear: this.chart.periodsPerYear || 252, bars: useBars
      });
      res = { ...raw, metrics, bars: useBars, spec, strategy: def.name, strategyId: def.id,
              params, signals, rejected: raw.rejected, settlementOn: !!raw.settlement };
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
    // 基准用「第一笔成交的手数」从区间首根开盘持有到末根，按同样本金折算；
    // 这不是等资金/等风险基准，只是回答"同样手数一直拿着会怎样"的粗略对照。
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
    const settleSrc = !res.settlement ? '—'
      : res.settlement.priceSource === 'exchange' ? '交易所结算价'
      : res.settlement.priceSource === 'vwap' ? '日均价近似'
      : res.settlement.priceSource === 'mixed' ? '混合来源'
      : '收盘代理';

    this.root.querySelector('#btOut').innerHTML = `
      ${m.ruined ? `<div style="color:var(--up-color); font-weight:700; padding:6px 0;">⚠ 本次回测权益曾归零或转负：年化/Sharpe 无意义，仓位口径过激进，别把它当业绩。</div>` : ''}
      ${!m.ruined && m.totalReturn < 0 ? `<div style="font-size:11px; color:var(--text-muted); padding:2px 0;">默认参数跑出负收益很常见，不是程序坏了；策略好坏要看样本外、成本敏感性与参数邻域，不要只看这一行。</div>` : ''}
      ${m.trades === 0 ? `<div style="font-size:11px; color:var(--accent-gold); padding:2px 0;">本次没有触发任何成交：不是撮合失败，而是这个策略/参数在当前数据上没有满足入场条件。可以调低起涨量/突破量门槛，或换品种、周期再试；先看信号是否出现，再谈收益。</div>` : ''}
      ${m.trades > 0 && m.trades < 10 ? `<div style="font-size:11px; color:var(--accent-gold); padding:2px 0;">本次只有 ${m.trades} 笔成交，Sharpe/胜率还没有统计意义；别据此判断策略好坏。</div>` : ''}
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
        <span>参数 <b>${esc(Object.entries(res.params).map(([k, v]) =>
          `${paramLabel(k)}=${typeof v === 'boolean' ? (v ? '开' : '关') : paramValueLabel(k, v)}`).join('，'))}</b></span>
        <span>说明 <b style="color:var(--text-main); font-weight:400;">${esc(STRATEGY_DESC[res.strategyId] || '')}</b></span>
        <span>区间 <b>${res.bars[0].date} → ${res.bars[res.bars.length - 1].date}</b>（${res.bars.length} 根）</span>
        <span>期末权益 <b>${money(m.finalEquity)}</b></span>
        <span>总手续费 <b>${money(m.totalFees)}</b></span>
        <span>持仓占比 <b>${pct(m.exposure, 0)}</b></span>
        <span>平均持仓 <b>${num(m.avgHoldingBars, 1)} 根</b></span>
        <span>资金不足拒单 <b>${res.rejected.margin}</b></span>
        <span>强平次数 <b>${res.rejected.marginCalls || 0}</b></span>
        <span>逐日盯市 <b>${res.settlementOn ? '强制' : '不适用'}</b></span>
        <span>结算价 <b>${settleSrc}</b></span>
        <span>追保通知 <b>${(res.marginNotices || []).length}</b></span>
        <span>强平被板锁拦截 <b>${(res.liquidationNotices || []).filter(n => n.kind === 'liquidation_blocked').length}</b></span>
        <span>保本止损 <b>${res.riskControls && res.riskControls.breakeven ? res.riskControls.breakeven.afterR + 'R' : '关'}</b></span>
        <span>时间止损 <b>${res.riskControls && res.riskControls.timeStop ? res.riskControls.timeStop.bars + ' 根' : '关'}</b></span>
        <span>时间止损出场 <b>${(res.trades || []).filter(t => t.exitReason === 'time_stop').length}</b> 笔</span>
        <span>涨停买不进 <b>${res.rejected.boardLock || 0}</b></span>
        <span>T+1/方向被拒 <b>${(res.rejects || []).filter(x => x.kind === 'tPlus1').length} / ${res.rejected.rules || 0}</b></span>
        <span title="用第一笔成交的手数，从区间首根开盘买入并持有到末根，按同样本金折算；不是策略平均仓位，也不是等风险基准">同期持有涨幅 <b class="${sign(cmp.benchReturn)}">${pct(cmp.benchReturn)}</b></span>
        <span title="策略收益率 − 上述「同期持有」收益率，只作粗略对照">超额 <b class="${sign(cmp.alpha)}">${pct(cmp.alpha)}</b></span>
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
