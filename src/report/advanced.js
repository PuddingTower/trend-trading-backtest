/**
 * 高级报表（计划 M5）。
 *
 * 这里刻意只做**能从权益曲线和成交记录里直接算出来**的东西。
 * 月度热力图、水下曲线、交易分布这些是「把同一组数字换几个切面摆出来」，
 * 不引入新口径；一旦引入新口径（比如波动率缩放、Kelly 仓位）就要重新对账，
 * 那是另一件事，不混在这里装懂。
 */

import { maxDrawdown } from './metrics.js';

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

/**
 * 期末权益 → 月度收益。月内用「月末权益 / 上月末权益 - 1」，跨年也连续。
 *
 * 曲线里第一个观测点所在的那个月**没有基期数据**，返回 null 而不是算成 0% ——
 * 把「不知道」写成 0% 会让第一年的年化凭空差一个月。
 */
export function monthlyReturns(equityCurve) {
  const points = (equityCurve || []).filter(p => p && p.date && Number.isFinite(p.equity));
  if (points.length < 2) return { years: [], months: MONTHS, rows: [], note: '权益序列过短' };
  const monthEnd = new Map();      // 'YYYY-MM' -> { date, equity }
  for (let i = 1; i < points.length; i++) {
    const key = String(points[i].date).slice(0, 7);
    monthEnd.set(key, { date: points[i].date, equity: points[i].equity });
  }
  const keys = [...monthEnd.keys()].sort();
  const rows = [];
  const years = [...new Set(keys.map(k => k.slice(0, 4)))].sort();
  let prevEquity = points[0].equity;
  for (const k of keys) {
    const y = k.slice(0, 4), m = Number(k.slice(5, 7)) - 1;
    const end = monthEnd.get(k);
    const isBaseline = String(end.date) === String(points[0].date);
    const ret = isBaseline ? null : (prevEquity > 0 ? end.equity / prevEquity - 1 : null);
    const row = rows.find(r => r.year === y);
    if (!row) rows.push({ year: y, months: Object.fromEntries([[m, ret]]), total: null });
    else row.months[m] = ret;
    prevEquity = end.equity;
  }
  for (const r of rows) {
    const vals = Object.values(r.months).filter(v => v !== null && Number.isFinite(v));
    r.total = vals.length ? vals.reduce((a, b) => a * (1 + b), 1) - 1 : null;
    r.positive = vals.filter(v => v > 0).length;
    r.known = vals.length;
  }
  return { years, months: MONTHS, rows: rows.sort((a, b) => a.year.localeCompare(b.year)) };
}

/**
 * 水下曲线（drawdown series）：每天相对历史高点的跌幅。
 * 最大回撤只是一个数，看不出「那次回撤在水下泡了 14 个月」—— 而持有体验是由时长决定的。
 */
export function underwaterSeries(equityCurve) {
  const points = (equityCurve || []).filter(p => Number.isFinite(p.equity));
  let peak = points.length ? points[0].equity : 0;
  let trough = peak, troughIdx = 0, bestStart = 0, curStart = 0, worst = { from: null, to: null, days: 0 };
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.equity >= peak) {
      peak = p.equity;
      if (troughIdx > 0 && i - curStart > worst.days) worst = { from: points[curStart].date, to: p.date, days: i - curStart };
      curStart = i; trough = peak; troughIdx = 0;
    } else {
      if (p.equity < trough) { trough = p.equity; troughIdx = i; }
    }
    out.push({ idx: i, date: p.date, equity: p.equity, peak, drawdown: peak > 0 ? p.equity / peak - 1 : 0 });
  }
  if (troughIdx > 0 && points.length - curStart > worst.days) {
    worst = { from: points[curStart].date, to: points[points.length - 1].date, days: points.length - curStart };
  }
  const maxDD = maxDrawdown(points.map(p => p.equity));
  return { series: out, worstUnderwater: worst, maxDDPct: maxDD.maxDDPct };
}

/**
 * 交易分布：按方向 / 出场原因 / 月份 / 持仓时长切。
 * 持仓时长分桶用 bar 数而不是自然日 —— 数据本身是 bar 序列，自然日要靠日期硬算，
 * 周线/60m 混着看时会算出误导性的"平均持有 300 天"。
 */
export function tradeDistribution(trades) {
  const list = trades || [];
  const bucket = (n) => (n <= 2 ? '≤2' : n <= 5 ? '3-5' : n <= 10 ? '6-10' : n <= 20 ? '11-20' : n <= 60 ? '21-60' : '>60');
  const acc = {};
  const add = (map, k, t) => {
    map[k] = map[k] || { n: 0, pnl: 0, wins: 0 };
    map[k].n++; map[k].pnl += t.netPnL; if (t.netPnL > 0) map[k].wins++;
  };
  const byDirection = {}, byExitReason = {}, byMonth = {}, byHolding = {}, bySymbol = {};
  for (const t of list) {
    add(byDirection, t.dir, t);
    add(byExitReason, t.exitReason || '未知', t);
    const mk = String(t.exitDate || '').slice(0, 7);
    if (mk) add(byMonth, mk, t);
    add(byHolding, bucket(t.holdingBars), t);
    if (t.symbol) add(bySymbol, t.symbol, t);
  }
  const finalize = (map) => Object.entries(map).map(([k, v]) => ({
    key: k, n: v.n, pnl: Math.round(v.pnl * 100) / 100, winRate: v.n ? v.wins / v.n : 0,
    avg: v.n ? Math.round((v.pnl / v.n) * 100) / 100 : 0
  })).sort((a, b) => b.pnl - a.pnl);
  return {
    byDirection: finalize(byDirection), byExitReason: finalize(byExitReason),
    byMonth: finalize(byMonth).sort((a, b) => a.key.localeCompare(b.key)),
    byHolding: finalize(byHolding), bySymbol: finalize(bySymbol)
  };
}

/**
 * 基准对比。期货用该品种的买入持有；A股用沪深300（需要另外把指数拉进来时传 benchBars）。
 * 返回按共同日期对齐后的两条归一化曲线，起点都是 1.0 —— 不同资金规模的曲线直接叠在
 * 一张图上是没法比的。
 */
export function benchmarkSeries(strategyEquity, benchEquity) {
  if (!strategyEquity || !strategyEquity.length || !benchEquity || !benchEquity.length) {
    return { series: [], note: '缺基准数据' };
  }
  const bench = new Map(benchEquity.map(p => [String(p.date).slice(0, 10), p.equity]));
  const b0 = benchEquity[0].equity;
  const s0 = strategyEquity[0].equity;
  const series = [];
  let lastB = b0;
  for (const p of strategyEquity) {
    const d = String(p.date).slice(0, 10);
    if (bench.has(d)) lastB = bench.get(d);
    series.push({ date: p.date, strategy: s0 > 0 ? p.equity / s0 : 1, bench: b0 > 0 ? lastB / b0 : 1 });
  }
  const last = series[series.length - 1] || { strategy: 1, bench: 1 };
  return { series, alpha: last.strategy - last.bench, benchReturn: last.bench - 1, strategyReturn: last.strategy - 1 };
}

/* ---------------- 导出 ---------------- */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pc = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (v * 100).toFixed(d) + '%';
const numf = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : Number(v).toFixed(d);

export function reportToCsv({ metrics, allocation, trades, walkForwardSummary }) {
  const lines = ['# 绩效', '指标,值'];
  const m = metrics || {};
  for (const [k, label] of [['totalReturn', '总收益率'], ['annualReturn', '年化收益'], ['sharpe', 'Sharpe'],
                            ['sortino', 'Sortino'], ['calmar', 'Calmar'], ['maxDDPct', '最大回撤'],
                            ['winRate', '胜率'], ['payoffRatio', '盈亏比'], ['profitFactor', '盈亏系数'],
                            ['trades', '交易笔数'], ['exposure', '持仓时间占比'], ['totalFees', '总手续费']]) {
    const v = m[k];
    lines.push(`${label},${typeof v === 'number' ? (['maxDDPct', 'winRate', 'totalReturn', 'annualReturn', 'exposure'].includes(k) ? pc(v, 2) : numf(v, 2)) : '—'}`);
  }
  if (allocation && allocation.length) {
    lines.push('', '# 组合分配', '品种,权重,分仓资金,笔数,净盈亏,Sharpe,最大回撤');
    for (const a of allocation) {
      lines.push([a.symbol || a.name, pc(a.weight, 1), numf(a.capital, 0), a.trades, numf(a.netPnL, 1),
                  numf(a.sharpe, 2), pc(a.maxDDPct, 2)].join(','));
    }
  }
  if (walkForwardSummary) {
    lines.push('', '# Walk-Forward', '段数,样本内均值,样本外均值,效率比,落差,正收益段数,合并总收益,合并最大回撤');
    const w = walkForwardSummary;
    lines.push([w.segments, numf(w.meanIsScore, 3), numf(w.meanOosScore, 3), numf(w.efficiency, 3),
                numf(w.isOosGap, 3), w.positiveOosSegments, pc(w.totalReturn, 2), pc(w.maxDDPct, 2)].join(','));
  }
  if (trades && trades.length) {
    lines.push('', '# 成交', '方向,开仓时间,开仓价,平仓时间,平仓价,手数,净盈亏,持仓bar,出场原因');
    for (const t of trades) {
      lines.push([t.dir, t.entryDate, t.entryPrice, t.exitDate, t.exitPrice, t.lots,
                  numf(t.netPnL, 1), t.holdingBars, t.exitReason].join(','));
    }
  }
  return lines.join('\n');
}

/**
 * 导出成一张能直接发给别人看的 HTML。
 * 刻意内联样式、不引任何外部资源：这是学习工具产出的报告，打开就该能看，
 * 不该依赖 CDN、字体或网络。
 */
export function reportToHtml({ title = '回测报告', metrics, monthly, underwater, distribution, allocation, walkForward, generatedAt }) {
  const m = metrics || {};
  const kpi = [
    ['总收益', pc(m.totalReturn)], ['年化', pc(m.annualReturn)], ['Sharpe', numf(m.sharpe)],
    ['Sortino', numf(m.sortino)], ['Calmar', numf(m.calmar)], ['最大回撤', pc(m.maxDDPct)],
    ['胜率', pc(m.winRate)], ['盈亏比', numf(m.payoffRatio)], ['笔数', m.trades ?? '—'],
    ['手续费', numf(m.totalFees, 0)]
  ].map(([k, v]) => `<div class="c"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');

  const monthlyTable = monthly && monthly.rows && monthly.rows.length
    ? `<h2>月度收益</h2><table><tr><th>年份</th>${MONTHS.map(x => `<th>${x}</th>`).join('')}<th>全年</th></tr>` +
      monthly.rows.map(r => `<tr><td>${esc(r.year)}</td>${MONTHS.map((_, i) => {
        const v = r.months[i];
        return `<td class="${v > 0 ? 'up' : v < 0 ? 'dn' : ''}">${v === undefined ? '' : pc(v, 1)}</td>`;
      }).join('')}<td class="${r.total > 0 ? 'up' : 'dn'}"><b>${pc(r.total, 1)}</b></td></tr>`).join('') + '</table>'
    : '';

  const dist = distribution ? ['byDirection|方向', 'byExitReason|出场原因', 'byHolding|持仓时长', 'bySymbol|品种']
    .map(spec => {
      const [key, label] = spec.split('|');
      const rows = (distribution[key] || []);
      if (!rows.length) return '';
      return `<h3>${esc(label)}</h3><table><tr><th>${esc(label)}</th><th>笔数</th><th>胜率</th><th>净盈亏</th><th>单笔均额</th></tr>` +
        rows.map(r => `<tr><td>${esc(r.key)}</td><td>${r.n}</td><td>${pc(r.winRate, 0)}</td><td class="${r.pnl >= 0 ? 'up' : 'dn'}">${numf(r.pnl, 1)}</td><td>${numf(r.avg, 1)}</td></tr>`).join('') +
        '</table>';
    }).join('') : '';

  const wf = walkForward && walkForward.windows && walkForward.windows.length
    ? `<h2>Walk-Forward 分段</h2><table><tr><th>样本内区间</th><th>样本外区间</th><th>选中参数</th><th>样本内得分</th><th>样本外得分</th></tr>` +
      walkForward.windows.map(w => `<tr><td>${esc(w.isDateFrom)}→${esc(w.isDateTo)}</td><td>${esc(w.oosDateFrom)}→${esc(w.oosDateTo)}</td>
        <td>${esc(Object.entries(w.best).map(([k, v]) => `${k}=${v}`).join(' '))}</td>
        <td>${numf(w.isScore, 3)}</td><td class="${w.oosScore >= 0 ? 'up' : 'dn'}">${numf(w.oosScore, 3)}</td></tr>`).join('') +
      `</table><p>效率比（样本外/样本内）= <b>${numf(walkForward.summary.efficiency, 3)}</b>，
       参数漂移：<code>${esc(Object.entries(walkForward.drift).map(([k, v]) => `${k} 换了 ${v.changes} 次`).join('，'))}</code></p>`
    : '';

  const alloc = allocation && allocation.length
    ? `<h2>组合分配</h2><table><tr><th>品种</th><th>权重</th><th>分仓资金</th><th>笔数</th><th>净盈亏</th><th>Sharpe</th></tr>` +
      allocation.map(a => `<tr><td>${esc(a.symbol || a.name)}</td><td>${pc(a.weight, 1)}</td><td>${numf(a.capital, 0)}</td><td>${a.trades}</td><td class="${a.netPnL >= 0 ? 'up' : 'dn'}">${numf(a.netPnL, 1)}</td><td>${numf(a.sharpe, 2)}</td></tr>`).join('') + '</table>'
    : '';

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${esc(title)}</title>
<style>
 body{background:#12151c;color:#d1d5db;font:14px/1.7 system-ui,-apple-system,"Microsoft YaHei",monospace;margin:0;padding:24px;}
 h1{font-size:20px;color:#fff;} h2{font-size:15px;color:#93c5fd;margin-top:26px;} h3{font-size:13px;color:#8b5cf6;margin:16px 0 6px;}
 .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin:14px 0;}
 .c{background:#1a1f2b;border:1px solid #2a3142;border-radius:6px;padding:10px;display:flex;flex-direction:column;}
 .c b{font-size:18px;color:#fff;} .c span{font-size:11px;color:#848c9e;}
 table{border-collapse:collapse;width:100%;font-size:12px;}
 th,td{border:1px solid #2a3142;padding:4px 7px;text-align:right;} th{background:#1a1f2b;color:#848c9e;}
 td:first-child,th:first-child{text-align:left;}
 .up{color:#ef4444;} .dn{color:#10b981;}
 .note{color:#848c9e;font-size:12px;border-left:3px solid #2a3142;padding-left:10px;margin-top:20px;}
</style></head><body>
<h1>${esc(title)}</h1>
<div class="note">生成时间 ${esc(generatedAt || '')}。收益/亏损配色按国内习惯：<span class="up">红=盈利</span>、<span class="dn">绿=亏损</span>。</div>
<div class="cards">${kpi}</div>
${alloc}${wf}${monthlyTable}${dist}
<div class="note">默认策略没有一个是"能赚钱的策略"：真实数据跑批的结论是 6 个内置策略都没有稳定跑赢买入持有。
本报告的价值在于验证框架与口径，不在这几个默认参数。样本内最优参数在样本外通常大幅退化 —— 请看效率比那一行。</div>
</body></html>`;
}
