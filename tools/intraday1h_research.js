/**
 * 1 小时多品类趋势策略研究。
 *
 * 口径：
 *   - 纯趋势：入场必须有已成立的趋势（均线多头排列 / 唐奇安突破且站上趋势均线），
 *     出场只有趋势破坏、反向突破或 ATR 止损，不设固定止盈、不做超买超卖反转。
 *   - 三段切分：前 50% 训练、50–70% 验证、后 30% 样本外；参数只在训练段挑，
 *     验证段决定要不要保留，样本外只用于最终汇报。
 *   - 每段前面留 250 根暖机，指标不靠切片边界的假信号；收益率以段首权益为基准。
 *   - 年化因子按该品种实际时间跨度算，不用固定的 252/1000 猜。
 *
 * 用法：node tools/intraday1h_research.js [--family ema|donchian|pullback] [--top 5]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRule } from '../src/strategy/ruleStrategy.js';
import { validateRule, ruleHash } from '../src/strategy/ruleSchema.js';
import { runOne } from '../src/report/optimizer.js';
import { computeMetrics } from '../src/report/metrics.js';
import { resolveTradeSpec } from '../src/markets/instrumentSpec.js';
import { rulesFor } from '../src/markets/marketRules.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, '..', 'fixtures', 'intraday1h');
const CAPITAL = 200000;
const WARMUP = 250;

const F = (field) => ({ field });
const S = (name) => ({ series: name });
const P = (name) => ({ param: name });
const and = (...conditions) => ({ op: 'and', conditions });
const or = (...conditions) => ({ op: 'or', conditions });
const gt = (left, right) => ({ op: 'greaterThan', left, right });
const lt = (left, right) => ({ op: 'lessThan', left, right });
const crossUp = (left, right) => ({ op: 'crossUp', left, right });
const crossDown = (left, right) => ({ op: 'crossDown', left, right });
const sub = (left, right) => ({ op: 'subtract', left, right });
const add = (left, right) => ({ op: 'add', left, right });
const mul = (left, right) => ({ op: 'multiply', left, right });

const num = (type, def, min, max, label) => ({ type, default: def, min, max, label });

function doc({ id, name, description, parameters, series, rules }) {
  return {
    schemaVersion: 1, kind: 'rules', id, name, revision: 1, description,
    parameters, requires: { fields: ['open', 'high', 'low', 'close', 'volume'] }, series, rules
  };
}

function emaTrendDoc(mode) {
  const longOnly = mode === 'long';
  const parameters = {
    fast: num('integer', 20, 2, 200, '快线'),
    slow: num('integer', 89, 10, 400, '慢线'),
    atrLen: num('integer', 14, 2, 100, 'ATR周期'),
    stopAtr: num('number', 2, 0.5, 10, '初始止损(ATR倍)'),
    trailAtr: num('number', 3, 0.5, 10, '移动止损(ATR倍)'),
    trailLook: num('integer', 20, 2, 100, '移动止损回看')
  };
  const series = {
    fast: { op: 'ema', source: F('close'), period: P('fast') },
    slow: { op: 'ema', source: F('close'), period: P('slow') },
    atr: { op: 'atr', period: P('atrLen') },
    hh: { op: 'priorHigh', source: F('high'), period: P('trailLook') }
  };
  const longRisk = {
    stop: sub(F('close'), mul(P('stopAtr'), S('atr'))),
    trail: sub(S('hh'), mul(P('trailAtr'), S('atr')))
  };
  const rules = [{
    when: and(gt(F('close'), S('slow')), gt(S('fast'), S('slow'))),
    do: { action: 'long', reason: 'EMA多头排列', risk: longRisk }
  }];
  if (longOnly) {
    rules.push({
      when: or(lt(F('close'), S('slow')), lt(S('fast'), S('slow'))),
      do: { action: 'close', reason: 'EMA多头排列破坏' }
    });
    return doc({
      id: 'intraday_ema_trend_long', name: '1H EMA趋势(只做多)',
      description: '60分钟 EMA 多头排列时持多，排列破坏或 ATR 移动止损离场；不设固定止盈。',
      parameters, series, rules
    });
  }
  series.ll = { op: 'priorLow', source: F('low'), period: P('trailLook') };
  rules.push({
    when: and(lt(F('close'), S('slow')), lt(S('fast'), S('slow'))),
    do: {
      action: 'short', reason: 'EMA空头排列',
      risk: { stop: add(F('close'), mul(P('stopAtr'), S('atr'))), trail: add(S('ll'), mul(P('trailAtr'), S('atr'))) }
    }
  });
  return doc({
    id: 'intraday_ema_trend_both', name: '1H EMA趋势(多空)',
    description: '60分钟 EMA 多头排列做多、空头排列做空，ATR 移动止损离场；不设固定止盈。',
    parameters, series, rules
  });
}

function donchianDoc(mode) {
  const longOnly = mode === 'long';
  const parameters = {
    entry: num('integer', 20, 5, 200, '突破回看'),
    exit: num('integer', 10, 3, 100, '离场回看'),
    trendLen: num('integer', 150, 20, 400, '趋势均线'),
    atrLen: num('integer', 14, 2, 100, 'ATR周期'),
    stopAtr: num('number', 2, 0.5, 10, '初始止损(ATR倍)'),
    trailAtr: num('number', 3, 0.5, 10, '移动止损(ATR倍)'),
    trailLook: num('integer', 20, 2, 100, '移动止损回看')
  };
  const series = {
    hhEntry: { op: 'priorHigh', source: F('high'), period: P('entry') },
    llEntry: { op: 'priorLow', source: F('low'), period: P('entry') },
    trend: { op: 'sma', source: F('close'), period: P('trendLen') },
    atr: { op: 'atr', period: P('atrLen') },
    hhTrail: { op: 'priorHigh', source: F('high'), period: P('trailLook') }
  };
  const rules = [{
    when: and(gt(F('close'), S('hhEntry')), gt(F('close'), S('trend'))),
    do: {
      action: 'long', reason: '突破通道高点的趋势',
      risk: { stop: sub(F('close'), mul(P('stopAtr'), S('atr'))), trail: sub(S('hhTrail'), mul(P('trailAtr'), S('atr'))) }
    }
  }];
  if (longOnly) {
    series.llExit = { op: 'priorLow', source: F('low'), period: P('exit') };
    rules.push({
      when: or(lt(F('close'), S('llExit')), lt(F('close'), S('trend'))),
      do: { action: 'close', reason: '跌破离场通道或趋势均线' }
    });
    return doc({
      id: 'intraday_donchian_long', name: '1H 唐奇安趋势(只做多)',
      description: '站上趋势均线且突破 N 根高点才做多，跌破 M 根低点或趋势均线离场；不设固定止盈。',
      parameters, series, rules
    });
  }
  series.llTrail = { op: 'priorLow', source: F('low'), period: P('trailLook') };
  rules.push({
    when: and(lt(F('close'), S('llEntry')), lt(F('close'), S('trend'))),
    do: {
      action: 'short', reason: '跌破通道低点的趋势',
      risk: { stop: add(F('close'), mul(P('stopAtr'), S('atr'))), trail: add(S('llTrail'), mul(P('trailAtr'), S('atr'))) }
    }
  });
  return doc({
    id: 'intraday_donchian_both', name: '1H 唐奇安趋势(多空)',
    description: '站上趋势均线且突破 N 根高点做多，跌破趋势均线且破 N 根低点做空；ATR 移动止损，不设固定止盈。',
    parameters, series, rules
  });
}

function pullbackDoc() {
  const parameters = {
    fast: num('integer', 20, 2, 200, '回踩均线'),
    slow: num('integer', 150, 10, 400, '趋势均线'),
    atrLen: num('integer', 14, 2, 100, 'ATR周期'),
    stopAtr: num('number', 2, 0.5, 10, '初始止损(ATR倍)'),
    trailAtr: num('number', 3, 0.5, 10, '移动止损(ATR倍)'),
    trailLook: num('integer', 20, 2, 100, '移动止损回看')
  };
  const series = {
    fast: { op: 'ema', source: F('close'), period: P('fast') },
    slow: { op: 'ema', source: F('close'), period: P('slow') },
    atr: { op: 'atr', period: P('atrLen') },
    hh: { op: 'priorHigh', source: F('high'), period: P('trailLook') }
  };
  return doc({
    id: 'intraday_pullback_trend_long', name: '1H 趋势回踩(只做多)',
    description: '收盘在长期趋势均线上方、且快线在慢线上方时，回踩后重新站上快线才做多；跌破趋势均线或 ATR 止损离场。',
    parameters, series,
    rules: [
      {
        when: and(gt(F('close'), S('slow')), gt(S('fast'), S('slow')), crossUp(F('close'), S('fast'))),
        do: {
          action: 'long', reason: '上升趋势中的回踩确认',
          risk: { stop: sub(F('close'), mul(P('stopAtr'), S('atr'))), trail: sub(S('hh'), mul(P('trailAtr'), S('atr'))) }
        }
      },
      {
        when: or(lt(F('close'), S('slow')), lt(S('fast'), S('slow'))),
        do: { action: 'close', reason: '趋势均线破坏' }
      }
    ]
  });
}

function variants() {
  const out = [];
  for (const mode of ['long', 'both']) {
    const template = emaTrendDoc(mode);
    for (const fast of [8, 12, 20]) for (const slow of [55, 89, 144]) {
      if (fast >= slow) continue;
      for (const stopAtr of [1.5, 2, 2.5]) for (const trailAtr of [2, 3, 4]) {
        out.push({ family: 'ema', mode, template, params: { fast, slow, atrLen: 14, stopAtr, trailAtr, trailLook: 20 } });
      }
    }
  }
  for (const mode of ['long', 'both']) {
    const template = donchianDoc(mode);
    for (const entry of [20, 40, 55]) for (const exit of [10, 20]) {
      if (exit >= entry) continue;
      for (const trendLen of [100, 150, 200]) for (const stopAtr of [1.5, 2, 2.5]) {
        out.push({ family: 'donchian', mode, template, params: { entry, exit, trendLen, atrLen: 14, stopAtr, trailAtr: 3, trailLook: 20 } });
      }
    }
  }
  const pull = pullbackDoc();
  for (const fast of [10, 20, 30]) for (const slow of [100, 150, 200]) {
    if (fast >= slow) continue;
    for (const stopAtr of [1.5, 2, 2.5]) {
      out.push({ family: 'pullback', mode: 'long', template: pull, params: { fast, slow, atrLen: 14, stopAtr, trailAtr: 3, trailLook: 20 } });
    }
  }
  for (const v of out) {
    const errors = validateRule(v.template);
    if (errors.length) throw new Error(`${v.template.id} 校验失败：${errors.map((e) => e.code + ' ' + e.path).join('; ')}`);
    v.strategy = compileRule(v.template);
    v.hash = ruleHash(v.template);
  }
  return out;
}

function loadData() {
  const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
  const items = [];
  for (const [fn, meta] of Object.entries(idx.files)) {
    const bars = JSON.parse(fs.readFileSync(path.join(DATA, fn), 'utf8')).bars;
    const resolved = resolveTradeSpec(meta.symbol);
    if (!resolved.ok) throw new Error(`${meta.symbol} 规格解析失败`);
    const first = new Date(bars[0].date.replace(' ', 'T')).getTime();
    const last = new Date(bars.at(-1).date.replace(' ', 'T')).getTime();
    const years = Math.max(1 / 365, (last - first) / (365.25 * 86400000));
    const ppy = Math.max(200, Math.min(3000, Math.round(bars.length / years)));
    items.push({ fn, meta, bars, spec: resolved.spec, years, ppy });
  }
  return items;
}

function engineOptsFor(item, allowShort) {
  return {
    capital: CAPITAL,
    sizing: 'notional',
    // 期货按保证金 5% 下单（约 0.5 倍名义敞口）；A股现货用 50% 现金。
    notionalPct: item.meta.market === 'futures' ? 0.05 : 0.5,
    slippageTicks: 1,
    allowShort,
    rules: rulesFor(item.spec)
  };
}

function segmentMetrics(item, strategy, params, from, to, allowShort) {
  const warm = Math.min(WARMUP, from);
  const start = from - warm;
  const bars = item.bars.slice(start, to);
  if (bars.length < 30) return null;
  const res = runOne({
    bars, spec: item.spec, strategy, params,
    engineOpts: engineOptsFor(item, allowShort), periodsPerYear: item.ppy
  });
  const offset = from - start;
  const eq = res.equityCurve.slice(offset);
  if (eq.length < 2) return null;
  const capital = eq[0].equity > 0 ? eq[0].equity : CAPITAL;
  const trades = res.trades.filter((t) => t.exitIdx >= offset);
  const m = computeMetrics({
    equityCurve: eq, trades, capital, periodsPerYear: item.ppy, bars: bars.slice(offset)
  });
  return { ...m, rejected: res.rejected };
}

const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.floor(v.length / 2);
  return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
};

function aggregate(results) {
  const valid = results.filter((m) => m && !m.error);
  const traded = valid.filter((m) => m.trades >= 1);
  const returns = traded.map((m) => m.totalReturn);
  const sharpes = traded.map((m) => m.sharpe).filter(Number.isFinite);
  const dds = traded.map((m) => m.maxDDPct);
  const calmar = traded.map((m) => m.calmar).filter(Number.isFinite);
  return {
    n: traded.length,
    medianReturn: median(returns),
    meanReturn: returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null,
    positiveShare: traded.length ? traded.filter((m) => m.totalReturn > 0).length / traded.length : 0,
    medianSharpe: median(sharpes),
    medianCalmar: median(calmar),
    worstDD: dds.length ? Math.max(...dds) : null,
    totalTrades: traded.reduce((a, m) => a + m.trades, 0),
    medianTrades: median(traded.map((m) => m.trades)),
    medianExposure: median(traded.map((m) => m.exposure)),
    ruined: valid.filter((m) => m.ruined).length
  };
}

function evalVariant(v, items) {
  const useItems = v.mode === 'both' ? items.filter((it) => it.meta.market === 'futures') : items;
  const allowShort = v.mode === 'both';
  const train = [], val = [], test = [];
  const bySymbol = [];
  for (const it of useItems) {
    const n = it.bars.length;
    const a = Math.floor(n * 0.5), b = Math.floor(n * 0.7);
    const tr = segmentMetrics(it, v.strategy, v.params, 0, a, allowShort);
    const va = segmentMetrics(it, v.strategy, v.params, a, b, allowShort);
    const te = segmentMetrics(it, v.strategy, v.params, b, n, allowShort);
    if (tr) train.push(tr);
    if (va) val.push(va);
    if (te) test.push(te);
    if (te) bySymbol.push({ symbol: it.meta.symbol, name: it.meta.name, market: it.meta.market, category: it.meta.category, ...te });
  }
  return { train: aggregate(train), val: aggregate(val), test: aggregate(test), bySymbol };
}

function rankScore(a) {
  if (!a || a.n < 5 || a.totalTrades < 10) return -Infinity;
  return (a.medianSharpe ?? -2) + a.positiveShare + 0.25 * (a.medianCalmar ?? -1);
}

const pct = (v, d = 1) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '--');
const f2 = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '--');

function printAgg(label, a) {
  console.log(`${label} n=${a.n}/${a.totalTrades}笔 中位收益=${pct(a.medianReturn)} 正收益=${pct(a.positiveShare, 0)} 中位Sharpe=${f2(a.medianSharpe)} 中位Calmar=${f2(a.medianCalmar)} 最差回撤=${pct(a.worstDD)} 持仓=${pct(a.medianExposure, 0)}`);
}

function main() {
  const args = process.argv.slice(2);
  const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const familyFilter = getArg('--family');
  const TOP = Number(getArg('--top') || 5);
  const items = loadData();
  console.log(`\n1H 研究：${items.length} 个品种，${items.filter((i) => i.meta.market === 'futures').length} 期货 / ${items.filter((i) => i.meta.market === 'ashare').length} A股\n`);
  console.log('品种年化因子与覆盖：');
  for (const it of items) console.log(`  ${it.meta.symbol.padEnd(9)} ${it.meta.name.padEnd(14)} ${it.bars.length}根 ${it.years.toFixed(2)}年 ppy=${it.ppy}`);

  const all = variants().filter((v) => !familyFilter || v.family === familyFilter);
  console.log(`\n参数组合：${all.length} 组\n`);
  const results = [];
  const t0 = Date.now();
  for (let i = 0; i < all.length; i++) {
    const v = all[i];
    const r = evalVariant(v, items);
    results.push({ ...v, strategy: undefined, ...r });
    if ((i + 1) % 20 === 0 || i + 1 === all.length) {
      console.log(`  进度 ${i + 1}/${all.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }

  const report = { generatedAt: new Date().toISOString(), data: items.map((it) => ({ ...it.meta, ppy: it.ppy, years: it.years })), variants: [] };
  const chosen = {};
  for (const family of ['ema', 'donchian', 'pullback']) {
    for (const mode of ['long', 'both']) {
      const group = results.filter((r) => r.family === family && r.mode === mode);
      if (!group.length) continue;
      group.sort((a, b) => rankScore(b.train) - rankScore(a.train));
      console.log(`\n══ ${family} / ${mode} 训练段前 ${TOP}（验证/样本外只看不挑）══`);
      const rows = [];
      for (const r of group.slice(0, TOP)) {
        rows.push([JSON.stringify(r.params), f2(rankScore(r.train)), pct(r.train.medianReturn), f2(r.train.medianSharpe), pct(r.val.medianReturn), f2(r.val.medianSharpe), pct(r.test.medianReturn), pct(r.test.positiveShare, 0), f2(r.test.medianSharpe), r.test.totalTrades, pct(r.test.worstDD)]);
      }
      const widths = ['参数', '训练分', '训收益', '训Sharpe', '验收益', '验Sharpe', '测收益', '测正率', '测Sharpe', '测笔数', '测最差DD'].map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
      const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
      console.log(line(['参数', '训练分', '训收益', '训Sharpe', '验收益', '验Sharpe', '测收益', '测正率', '测Sharpe', '测笔数', '测最差DD']));
      console.log('─'.repeat(widths.reduce((a, b) => a + b + 2, 0)));
      rows.forEach((r) => console.log(line(r)));

      // 选择：训练分最高且验证段中位收益 > 0、正收益率 >= 50%；没有就退回训练分最高并标注
      const passing = group.filter((r) => r.val.medianReturn > 0 && r.val.positiveShare >= 0.5 && r.val.totalTrades >= 10);
      const pick = passing[0] || group[0];
      const key = `${family}_${mode}`;
      chosen[key] = {
        family, mode, params: pick.params, hash: pick.hash, docId: pick.template.id,
        train: pick.train, val: pick.val, test: pick.test,
        passedValidation: passing.length > 0,
        bySymbol: pick.bySymbol.map((r) => ({
          symbol: r.symbol, name: r.name, market: r.market, category: r.category,
          totalReturn: r.totalReturn, annualReturn: r.annualReturn, sharpe: r.sharpe, maxDDPct: r.maxDDPct,
          trades: r.trades, winRate: r.winRate, profitFactor: r.profitFactor, exposure: r.exposure
        }))
      };
      console.log(`\n选择 ${family}/${mode}: ${JSON.stringify(pick.params)}  hash=${pick.hash}  ${passing.length ? '验证通过' : '⚠ 无组合通过验证，退回训练最优'}`);
      printAgg('  训练', pick.train); printAgg('  验证', pick.val); printAgg('  样本外', pick.test);
      report.variants.push(...group.map((r) => ({
        family, mode, params: r.params, hash: r.hash,
        train: r.train, val: r.val, test: r.test
      })));
    }
  }
  report.chosen = chosen;
  fs.writeFileSync(path.join(DATA, 'research_report.json'), JSON.stringify(report, null, 1));
  console.log(`\n报告已写 ${path.join(DATA, 'research_report.json')}`);
}

main();
