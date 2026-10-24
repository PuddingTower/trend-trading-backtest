/**
 * 历史黑天鹅压力测试场景库（架构白皮书 §2.4.2 Historical Crisis Replay）。
 *
 * 回测总收益再好看，也回答不了投委会最狠的那个问题："2015 年 6 月你的策略会怎么样？"
 * 压力测试就是把当前策略原封不动地投射到已知的市场极端切片上重放一遍。
 * 它不是预测——是**体检**：策略在哪种极端行情里失血、失血多快、有没有被板锁关在门外。
 *
 * 场景日期是"已发生"的历史事实，不是参数，写死在库里并注明检验目的。
 * 每个场景都带 market 标签：给 A 股品种跑"双十一夜盘闪崩"没有意义，调用方应按市场过滤。
 */

import { BacktestEngine } from '../core/backtestEngine.js';
import { computeMetrics } from './metrics.js';

export const CRISIS_SCENARIOS = [
  {
    id: 'crash2015', market: 'aShare', from: '2015-06-15', to: '2015-08-26',
    name: '2015 千股跌停',
    why: '杠杆牛崩塌+千股连续跌停。检验多头策略在"跌停卖不出"下的真实回撤——板锁拒绝次数比亏损本身更能说明问题。'
  },
  {
    id: 'circuit2016', market: 'aShare', from: '2016-01-04', to: '2016-01-28',
    name: '2016 熔断四日',
    why: '熔断机制实施四天即夭折。检验极端流动性真空下的出场能力。'
  },
  {
    id: 'double11', market: 'futures', from: '2016-11-10', to: '2016-11-30',
    name: '2016 双十一夜盘闪崩',
    why: '夜盘几分钟内多头从涨停砸到跌停。检验 CTA 止损单在跳空穿越下的滑点 reality check。'
  },
  {
    id: 'trade2018', market: 'aShare', from: '2018-03-23', to: '2018-10-19',
    name: '2018 贸易摩擦阴跌',
    why: '近一年单边阴跌、反弹稀碎。检验趋势策略在"每次突破都失败"的钝刀行情里被止损磨血的程度。'
  },
  {
    id: 'covid2020', market: 'both', from: '2020-02-03', to: '2020-02-28',
    name: '2020 春节疫情缺口',
    why: '春节后三千余股开盘即跌停。检验隔夜跳空对止损的穿透（按开盘成交、不按委托价，引擎口径在此最关键）。'
  },
  {
    id: 'oil2020', market: 'futures', from: '2020-04-20', to: '2020-04-30',
    name: '2020 负油价外溢',
    why: 'WTI 负价格冲击全球商品。检验能源链品种空头挤兑与保证金剧变的账户存活。'
  },
  {
    id: 'nickel2022', market: 'futures', from: '2022-03-07', to: '2022-03-18',
    name: '2022 伦镍逼空外溢',
    why: 'LME 镍史诗级逼空带动国内涨停潮。检验空头策略在连续一字板下的"平不掉仓"风险。'
  },
  {
    id: 'micro2024', market: 'aShare', from: '2024-01-02', to: '2024-02-08',
    name: '2024 微盘股踩踏',
    why: '雪球敲入+量化 DMA 踩踏，小微盘连跌。检验小市值暴露策略的回撤极值。'
  },
  {
    id: 'rally2024', market: 'both', from: '2024-09-24', to: '2024-10-11',
    name: '2024 924 急涨',
    why: '政策组合拳后的极速普涨、随后高位剧震。检验空头与低波策略在急涨中的受损，以及多头追高的接盘风险。'
  }
];

/** 按市场过滤场景：A股品种跑 aShare/both，期货品种跑 futures/both。 */
export function scenariosFor(market) {
  return CRISIS_SCENARIOS.filter(s => s.market === 'both' || s.market === market);
}

/** 找日期边界：返回 [startIdx, endIdx)（闭开区间）。找不到返回 null。日期比较只用 YYYY-MM-DD 前缀。 */
function windowBounds(bars, from, to) {
  const day = (d) => String(d).slice(0, 10);
  let startIdx = -1, endIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (startIdx < 0 && day(bars[i].date) >= from) startIdx = i;
    if (day(bars[i].date) <= to) endIdx = i + 1;
  }
  if (startIdx < 0 || endIdx <= startIdx) return null;
  return [startIdx, endIdx];
}

/**
 * 在单个场景窗口里重放策略。
 *
 * 指标需要预热（MA60/ATR 都要历史），所以引擎跑的是 [窗口起点-lookback, 窗口终点]，
 * 但**业绩只统计窗口内的权益点**——预热段的盈亏不该记在压力场景头上。
 * strategy 传 null 时自动跑买入持有，作为"这口锅是策略的还是行情的"对照组。
 */
export function runScenario({ bars, spec, strategy, params = {}, engineOpts = {}, scenario,
                               lookback = 60, periodsPerYear = 252 }) {
  const bounds = windowBounds(bars, scenario.from, scenario.to);
  if (!bounds) return { scenario: scenario.id, name: scenario.name, available: false, note: `数据不覆盖 ${scenario.from}~${scenario.to}` };
  const [s0, s1] = bounds;
  const w0 = Math.max(0, s0 - Math.max(0, Math.round(lookback)));
  const slice = bars.slice(w0, s1);
  if (slice.length < 5) return { scenario: scenario.id, name: scenario.name, available: false, note: '窗口内数据过少' };

  const signals = strategy
    ? strategy.signals(slice, params)
    : slice.map(() => ({ dir: 1 }));                       // 买入持有对照组
  const eng = new BacktestEngine(slice, spec, { ...engineOpts });
  const res = eng.run(signals);

  // 只把窗口内的权益点交给指标，且基期 = 窗口起点权益：预热段的盈亏不记在场景头上。
  // 成交同理只保留窗口内平仓的 —— 跨界持仓的盈亏本来就无法干净切开，算平仓日归属。
  const inWindow = res.equityCurve.filter(p => String(p.date).slice(0, 10) >= scenario.from);
  const firstInWin = res.equityCurve.findIndex(p => String(p.date).slice(0, 10) >= scenario.from);
  const base = firstInWin >= 0 ? res.equityCurve[firstInWin].equity : res.capital;
  const winTrades = res.trades.filter(t => String(t.exitDate).slice(0, 10) >= scenario.from);
  const metrics = computeMetrics({
    equityCurve: inWindow.length > 1 ? inWindow : res.equityCurve,
    trades: winTrades, capital: base, periodsPerYear, bars: slice
  });
  const buyHold = firstInWin >= 0
    ? res.equityCurve[res.equityCurve.length - 1].equity / res.equityCurve[firstInWin].equity - 1
    : null;

  return {
    scenario: scenario.id, name: scenario.name, why: scenario.why,
    from: scenario.from, to: scenario.to,
    available: true,
    barsInWindow: inWindow.length,
    totalReturn: metrics.totalReturn,
    maxDDPct: metrics.maxDDPct,
    trades: metrics.trades,
    winRate: metrics.winRate,
    ruined: metrics.ruined,
    sharpe: metrics.sharpe,
    // 板锁/停牌/保证金拒绝在极端窗口里是**信息**：跌停平不掉仓是 2015 的真实体验
    rejected: { ...res.rejected },
    buyHoldReturn: buyHold,
    excessVsBuyHold: buyHold !== null && metrics.totalReturn !== null ? metrics.totalReturn - buyHold : null,
    fees: metrics.totalFees
  };
}

/**
 * 跑全部场景。汇总给出最脆弱一幕与存活判定。
 * rejected 合计里单列 boardLockClose：它是"策略在极端日想走走不掉"的直接证据。
 */
export function runStressSuite({ bars, spec, strategy, params = {}, engineOpts = {}, market,
                                 scenarios = null, lookback = 60, periodsPerYear = 252 }) {
  const list = scenarios || scenariosFor(market || (spec && spec.multiplier === 100 ? 'aShare' : 'futures'));
  const results = list.map(sc => runScenario({ bars, spec, strategy, params, engineOpts, scenario: sc, lookback, periodsPerYear }));
  const ok = results.filter(r => r.available);
  const withReturn = ok.filter(r => r.totalReturn !== null);
  const worst = withReturn.length
    ? withReturn.reduce((a, b) => (b.totalReturn < a.totalReturn ? b : a))
    : null;
  const boardLockTotal = ok.reduce((s, r) => s + (r.rejected?.boardLockClose || 0), 0);
  return {
    results,
    summary: {
      scenarios: results.length,
      available: ok.length,
      missingData: results.filter(r => !r.available).map(r => `${r.name}（${r.note}）`),
      worstScenario: worst ? { id: worst.scenario, name: worst.name, totalReturn: worst.totalReturn, maxDDPct: worst.maxDDPct } : null,
      ruinedAnywhere: ok.some(r => r.ruined),
      boardLockCloseTotal: boardLockTotal,
      note: boardLockTotal > 0 ? `极端窗口里共有 ${boardLockTotal} 次平仓被板锁拒绝——这些仓位是"想走走不掉"，亏损会继续扩大` : null
    }
  };
}
