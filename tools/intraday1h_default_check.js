/**
 * 已保存默认规则的 1h 样本外复核。
 *
 * 与 exploratory 的 intraday1h_research.js 分开：这里直接读 src/strategy/defaultRules.js，
 * 保证复核的就是应用启动时加载的那两条文档，不是另抄一份参数。
 *
 * 口径：70–100% 为完整样本外，85–100% 为最终留出；每段前留 300 根暖机。
 * 期货保证金 5%（约 0.5 倍名义敞口），A股 50% 现金；滑点 1 tick，含手续费与板锁/T+1。
 *
 * 用法：node tools/intraday1h_default_check.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RULES } from '../src/strategy/defaultRules.js';
import { compileRule } from '../src/strategy/ruleStrategy.js';
import { ruleHash } from '../src/strategy/ruleSchema.js';
import { runOne } from '../src/report/optimizer.js';
import { computeMetrics, maxDrawdown } from '../src/report/metrics.js';
import { atr } from '../src/strategy/indicators.js';
import { resolveTradeSpec } from '../src/markets/instrumentSpec.js';
import { rulesFor } from '../src/markets/marketRules.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, '..', 'fixtures', 'intraday1h');

function loadItems() {
  const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
  return Object.entries(idx.files).map(([fn, meta]) => {
    const bars = JSON.parse(fs.readFileSync(path.join(DATA, fn), 'utf8')).bars;
    const first = new Date(bars[0].date.replace(' ', 'T')).getTime();
    const last = new Date(bars.at(-1).date.replace(' ', 'T')).getTime();
    const years = Math.max(1 / 365, (last - first) / (365.25 * 86400000));
    return {
      meta, bars, spec: resolveTradeSpec(meta.symbol).spec,
      ppy: Math.max(200, Math.min(3000, Math.round(bars.length / years)))
    };
  });
}

function segment(item, strategy, doc, fromFrac, toFrac) {
  const n = item.bars.length;
  const from = Math.floor(n * fromFrac), to = Math.floor(n * toFrac);
  const warm = 300, start = Math.max(0, from - warm);
  const bars = item.bars.slice(start, to);
  const allowShort = item.meta.market === 'futures' && doc.rules.some((r) => r.do.action === 'short');
  const engineOpts = {
    capital: 200000, sizing: 'notional',
    notionalPct: item.meta.market === 'futures' ? 0.05 : 0.5,
    slippageTicks: 1, allowShort,
    rules: rulesFor(item.spec)
  };
  const res = runOne({ bars, spec: item.spec, strategy, params: {}, engineOpts, periodsPerYear: item.ppy });
  const offset = from - start;
  const eq = res.equityCurve.slice(offset);
  if (eq.length < 10) return null;
  const m = computeMetrics({
    equityCurve: eq, trades: res.trades.filter((t) => t.exitIdx >= offset),
    capital: eq[0].equity, periodsPerYear: item.ppy, bars: bars.slice(offset)
  });
  const a = atr(bars, 14).slice(offset);
  const ap = [];
  for (let i = 0; i < a.length; i++) {
    const b = bars[offset + i];
    if (Number.isFinite(a[i]) && b.close > 0) ap.push(a[i] / b.close);
  }
  ap.sort((x, y) => x - y);
  return { m, eq: eq.map((p) => ({ date: p.date, v: p.equity / eq[0].equity })), atrPct: ap[Math.floor(ap.length / 2)] || 1 };
}

const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const pct = (v, d = 1) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '--');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '--');

function aggregate(rows) {
  const ms = rows.map((r) => r.m);
  return {
    n: ms.length,
    medianReturn: median(ms.map((m) => m.totalReturn)),
    positiveShare: ms.filter((m) => m.totalReturn > 0).length / ms.length,
    medianSharpe: median(ms.map((m) => m.sharpe)),
    medianDD: median(ms.map((m) => m.maxDDPct)),
    worstDD: Math.max(...ms.map((m) => m.maxDDPct)),
    trades: ms.reduce((a, m) => a + m.trades, 0)
  };
}

function portfolio(rows) {
  const byDate = new Map();
  const wsum = rows.reduce((a, r) => a + 1 / Math.max(r.atrPct, 1e-6), 0);
  for (const r of rows) {
    const w = (1 / Math.max(r.atrPct, 1e-6)) / wsum;
    for (const p of r.eq) {
      if (!byDate.has(p.date)) byDate.set(p.date, []);
      byDate.get(p.date).push({ v: p.v, w });
    }
  }
  const dates = [...byDate.keys()].sort();
  const rp = [], ew = [];
  for (const d of dates) {
    let num = 0, den = 0, sum = 0, cnt = 0;
    for (const x of byDate.get(d)) { num += x.w * x.v; den += x.w; sum += x.v; cnt++; }
    rp.push(num / den); ew.push(sum / cnt);
  }
  return {
    rpReturn: rp.at(-1) - 1, rpDD: maxDrawdown(rp).maxDDPct,
    ewReturn: ew.at(-1) - 1, ewDD: maxDrawdown(ew).maxDDPct,
    from: dates[0], to: dates.at(-1)
  };
}

function main() {
  const items = loadItems();
  const out = { generatedAt: new Date().toISOString(), rules: [], checks: [] };
  console.log(`\n1H 默认规则复核：${items.length} 个品种\n`);

  for (const doc of DEFAULT_RULES) {
    const strategy = compileRule(doc);
    const useItems = doc.id.endsWith('_both') ? items.filter((it) => it.meta.market === 'futures') : items;
    const oos = [], hold = [];
    for (const it of useItems) {
      const a = segment(it, strategy, doc, 0.7, 1.0);
      const b = segment(it, strategy, doc, 0.85, 1.0);
      if (a) oos.push({ ...a, meta: it.meta });
      if (b) hold.push({ ...b, meta: it.meta });
    }
    const A = aggregate(oos), B = aggregate(hold), P = portfolio(oos);
    out.rules.push({ id: doc.id, name: doc.name, hash: ruleHash(doc), params: strategy.params, oos: A, holdout: B, portfolio: P });
    out.checks.push(...useItems.map((it) => {
      const r = oos.find((x) => x.meta.symbol === it.meta.symbol);
      return r ? {
        rule: doc.id, symbol: it.meta.symbol, name: it.meta.name, market: it.meta.market,
        totalReturn: r.m.totalReturn, sharpe: r.m.sharpe, maxDDPct: r.m.maxDDPct,
        trades: r.m.trades, winRate: r.m.winRate, profitFactor: r.m.profitFactor
      } : null;
    }).filter(Boolean));

    console.log(`══ ${doc.name}  ${doc.id}  hash=${ruleHash(doc)}`);
    console.log(`样本外(70–100%) n=${A.n} 中位收益=${pct(A.medianReturn)} 正收益=${pct(A.positiveShare, 0)} 中位Sharpe=${f2(A.medianSharpe)} 中位回撤=${pct(A.medianDD)} 最差回撤=${pct(A.worstDD)} 笔数=${A.trades}`);
    console.log(`最终留出(85–100%) n=${B.n} 中位收益=${pct(B.medianReturn)} 正收益=${pct(B.positiveShare, 0)} 中位Sharpe=${f2(B.medianSharpe)} 笔数=${B.trades}`);
    console.log(`组合 ${P.from} → ${P.to} 等权=${pct(P.ewReturn)} (DD ${pct(P.ewDD)}) 风险平价=${pct(P.rpReturn)} (DD ${pct(P.rpDD)})\n`);
    const rows = oos.map((r) => [r.meta.name, r.meta.market, pct(r.m.totalReturn), pct(r.m.maxDDPct), r.m.trades, pct(r.m.winRate, 0), f2(r.m.profitFactor)])
      .sort((a, b) => parseFloat(b[2]) - parseFloat(a[2]));
    for (const r of rows) console.log(`  ${r[0].padEnd(14)} ${r[1].padEnd(7)} ${r[2].padStart(7)} DD ${r[3].padStart(6)} n=${String(r[4]).padStart(3)} 胜率 ${r[5].padStart(4)} 盈亏比 ${r[6]}`);
    console.log('');
  }

  fs.writeFileSync(path.join(DATA, 'default_check.json'), JSON.stringify(out, null, 1));
  console.log(`明细已写 ${path.join(DATA, 'default_check.json')}`);
}

main();
