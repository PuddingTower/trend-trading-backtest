/**
 * 「只画真实存在的K线」这条硬约束的回归守卫。
 *
 * 起因：在线取数失败时，旧代码会静默换成 MockDataGenerator 生成的 260 根随机游走，
 * 只在角落弹一条 2.6 秒就消失的 toast。用户输入 600637 看到的"行情"其实是造的，
 * 而回测数字看起来完全正常 —— 这是这个项目最坏的一种失败。
 *
 * 所以这里守两件事：
 *   1. 生产路径上（HTML + src，测试除外）不许再出现合成 bar 的生成器；
 *   2. 日内合成只许重排真实 bar，不许无中生有。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from './harness.js';
import { aggregateIntraday, tradingDayOf } from '../src/data/dominant.js';
import { normalizeSinaRow, normalizeSinaDate, sortByDate } from '../src/data/indicators.js';
import { AGG_BASE, PERIODS_PER_YEAR, periodsPerYear, periodLabel } from '../src/data/periods.js';
import { periodSpacingOk } from "../src/data/periods.js";
import { annotateGaps } from '../src/markets/dataQuality.js';
import { PortfolioEngine } from '../src/core/portfolioEngine.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');

/** 生产代码里不许出现的符号：合成行情生成器本体与它的入口。 */
const BANNED = [
  ['MockDataGenerator', '合成K线生成器'],
  ["from './src/data/mock.js'", 'mock 数据模块'],
  [/拟真行情/, '把合成数据当行情展示的话术'],
  [/已降级为仿真行情/, '取数失败静默换假数据'],
  [/仿真预置行情/, '下拉框里的仿真盘入口']
];

function walk(abs, acc = []) {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '__pycache__') continue;
    const p = path.join(abs, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(js|html)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

test('守卫：生产代码里不存在任何合成K线生成器', () => {
  const files = walk(root).filter(p => !p.includes(`${path.sep}tests${path.sep}`));
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    // 注释里保留"这里以前是假的"这段历史是有价值的，所以只扫真代码行
    const code = text.split('\n')
      .map((l, i) => ({ n: i + 1, t: l.trim() }))
      .filter(l => l.t && !/^(\/\/|\*|\/\*|<!--)/.test(l.t));
    for (const [pat, why] of BANNED) {
      const re = pat instanceof RegExp ? pat : new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const hit = code.find(l => re.test(l.t));
      if (hit) hits.push(`${path.relative(root, f)}:${hit.n} ${why}`);
    }
  }
  assert.eq(hits.length, 0, `发现合成行情通路：\n  ${hits.join('\n  ')}`);
});

test('守卫：src/data/mock.js 与 trading_core.js 已删除，取数失败只剩硬失败一条路', () => {
  assert.ok(!fs.existsSync(path.join(root, 'src', 'data', 'mock.js')), 'src/data/mock.js 不该还存在');
  assert.ok(!fs.existsSync(path.join(root, 'trading_core.js')), 'trading_core.js（含重复 mock）不该还存在');
  const html = fs.readFileSync(path.join(root, 'futures_replay_trader.html'), 'utf8');
  assert.ok(/9999/.test(html) === false, '下拉框和默认品种里不许再留 *9999 仿真代码');
  assert.ok(/showDataError/.test(html), '取数失败必须有持久横幅，不能只靠 2.6 秒的 toast');
});

const mk = (date, o, h, l, c, v = 100) => ({ date, open: o, high: h, low: l, close: c, volume: v });

test('交易日归属：夜盘算下一个交易日，周五夜盘跳过周末，凌晨续盘算当天', () => {
  assert.eq(tradingDayOf('2026-09-10 09:00'), '2026-09-10', '日盘算当天');
  assert.eq(tradingDayOf('2026-09-10 15:00'), '2026-09-10', '收盘那根仍算当天');
  assert.eq(tradingDayOf('2026-09-09 21:00'), '2026-09-10', '周三夜盘开的是周四的行情');
  assert.eq(tradingDayOf('2026-09-09 22:00'), '2026-09-10', '夜盘第二根同属周四');
  assert.eq(tradingDayOf('2026-09-10 01:00'), '2026-09-10', '周四凌晨是前一夜盘的续，算周四');
  assert.eq(tradingDayOf('2026-09-11 21:00'), '2026-09-14', '周五夜盘属下周一，不落在周末');
  assert.eq(tradingDayOf('2026-09-09'), '2026-09-09', '日线没有时间部分时原样取日期');
});

test('4小时合成：每根都由真实60分钟bar并成，凑不满也照样出一根短的', () => {
  const day = [
    mk('2026-09-10 10:00', 1, 9, 0.5, 2, 10),
    mk('2026-09-10 11:00', 2, 8, 1.5, 3, 20),
    mk('2026-09-10 14:00', 3, 7, 2.5, 4, 30),
    mk('2026-09-10 15:00', 4, 12, 3.5, 5, 40),
    mk('2026-09-10 21:00', 5, 6, 4.5, 5.5, 50)
  ];
  const out = aggregateIntraday(day, 4);
  assert.eq(out.length, 2, '日盘 4 根并 1 根，夜盘那根属下一交易日所以单独成组');
  assert.eq(out[0].date, '2026-09-10 15:00', '组标签取末根时间，和日线聚合口径一致');
  assert.eq(out[0].open, 1, 'open 取组内首根');
  assert.eq(out[0].close, 5, 'close 取组内末根');
  assert.eq(out[0].high, 12, 'high 取组内最大');
  assert.eq(out[0].low, 0.5, 'low 取组内最小');
  assert.eq(out[0].volume, 100, '成交量求和');
  assert.eq(out[1].spanBars, 1, '尾巴只有 1 根真实 bar，如实标出来而不是补成 4 根');
  assert.eq(out[1].date, '2026-09-10 21:00', '夜盘 21:00 归入下一交易日的组');
});

test('4小时合成：不新增也不吞掉任何一根真实 bar', () => {
  const bars = [];
  for (const d of ['2026-09-10', '2026-09-11']) {
    for (const t of ['10:00', '11:00', '14:00', '15:00']) {
      bars.push(mk(`${d} ${t}`, 1, 2, 0.5, 1.5, 7));
    }
  }
  const out = aggregateIntraday(bars, 4);
  assert.eq(out.length, 2, '两个交易日各 4 根 → 各 1 根 4 小时');
  const consumed = out.reduce((s, b) => s + b.spanBars, 0);
  assert.eq(consumed, bars.length, '合成后覆盖的真实根数必须等于输入根数，不许凭空多出');
  assert.eq(aggregateIntraday([], 4).length, 0, '空输入返回空，不返回占位 bar');
  assert.eq(aggregateIntraday(bars, 1).length, bars.length, 'n=1 时原样返回');
  assert.ok(out.every(b => Number.isFinite(b.high) && Number.isFinite(b.low)), '高低点不许是 NaN');
});

test('4小时合成：金额字段只在来源真的有才汇总', () => {
  const a = [mk('2026-09-10 10:00', 1, 2, 0.5, 1.5, 7), mk('2026-09-10 11:00', 1.5, 2, 1, 1.8, 7)];
  assert.ok(aggregateIntraday(a, 4)[0].amount === undefined, '输入没有 amount 就别造一个 0 出来');
  const withAmt = a.map((b, i) => ({ ...b, amount: 100 * (i + 1) }));
  assert.eq(aggregateIntraday(withAmt, 4)[0].amount, 300, '有 amount 时求和');
});

/* ── 第二轮排查抓到的三个 bug：都属"数字很安静地错"，必须留断言 ───────────── */

// 新浪 60m 实测发的是 "2023-11-07 15:00:00" 且整段**倒序**返回。
test('新浪日期归一化：保留钟点只去秒，日线不受影响', () => {
  assert.eq(normalizeSinaDate('2023-11-07 15:00:00'), '2023-11-07 15:00', '60m 必须留住钟点');
  assert.eq(normalizeSinaDate('2009-03-27'), '2009-03-27', '日线原样');
  assert.eq(normalizeSinaDate('2023-11-07T15:00:00Z'), '2023-11-07 15:00', 'ISO 形态也吃');
  assert.eq(normalizeSinaDate(''), '', '空串不炸');
});

test('回归：新浪倒序 60m 合成 4 小时不得把 open/close 反掉', () => {
  // 新浪真实返回顺序（倒序）：15:00 在前、10:00 在后
  const sinaDesc = [
    ['2023-11-07 15:00:00', '3806', '3816', '3782', '3805', '1672019'],
    ['2023-11-07 14:00:00', '3790', '3810', '3780', '3806', '1000000'],
    ['2023-11-07 11:00:00', '3780', '3795', '3770', '3790', '900000'],
    ['2023-11-07 10:00:00', '3770', '3785', '3760', '3780', '800000']
  ];
  const bars = sortByDate(sinaDesc.map(normalizeSinaRow).filter(Boolean));
  assert.eq(bars[0].date, '2023-11-07 10:00', 'sortByDate 后必须是最早那根在前');
  const agg = aggregateIntraday(bars, 4);
  assert.eq(agg[0].open, 3770, 'open 必须是当天最早那根的开盘（曾经拿到的是 15:00 的 3806）');
  assert.eq(agg[0].close, 3805, 'close 必须是当天最晚那根的收盘（曾经拿到的是 10:00 的 3780）');
  assert.eq(agg[0].high, 3816, 'high');
  assert.eq(agg[0].low, 3760, 'low');
  // 防御性排序：即使调用方喂进来的是倒序，结果也必须一致
  const rev = aggregateIntraday(bars.slice().reverse(), 4);
  assert.eq(rev[0].open, 3770, '倒序喂入仍然正确');
  assert.eq(rev[0].close, 3805, '倒序喂入 close 仍然正确');
});

test('回归：annotateGaps 对同一天多根 bar 必须保持原顺序（比较器要能返回 0）', () => {
  const intra = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00']
    .map(t => ({ date: `2023-11-07 ${t}`, open: 100, high: 101, low: 99, close: 100, volume: 10 }));
  const out = annotateGaps(intra, {}).bars;
  assert.eq(out.length, intra.length, '一根都不能丢');
  assert.ok(out.every((b, i) => b.date === intra[i].date), '同一天内的顺序不许变');
});

test('4小时 必须有底料映射，绝不允许被当成上游周期直接发出去', () => {
  assert.eq(AGG_BASE['4h'], '60m', "4h 的口径来源是 60m");
  assert.ok(periodsPerYear('4h') > 0 && periodLabel('4h') === '4小时', '周期元数据齐全');
  assert.eq(periodsPerYear('不认识的周期'), 252, '未知周期要落到日线因子而不是 NaN');
  // 东财 klt 表里没有 240：任何把 periodSelect 的值直接喂给 fetchBars 的新代码都会踩这个雷
  const wp = fs.readFileSync(path.join(root, 'src', 'ui', 'watchlistPanel.js'), 'utf8');
  assert.ok(!/fetchBars\(/.test(wp), 'watchlistPanel 不许再绕过 resolveBars 直接调 fetchBars');
  assert.ok(/resolveBars\(/.test(wp), '批量拉取必须走 resolveBars 这一条统一路径');
});

test('组合引擎遇到分钟级序列必须拒跑，而不是静默压成日线', () => {
  const day = (n, px) => Array.from({ length: n }, (_, i) => ({
    date: `2023-11-${String(7 + Math.floor(i / 6)).padStart(2, '0')}`,
    open: px, high: px + 1, low: px - 1, close: px, volume: 1000
  }));
  const intra = [];
  for (let d = 7; d <= 27; d++) {
    for (const t of ['10:00', '11:00', '14:00', '15:00']) {
      intra.push({ date: `2023-11-${String(d).padStart(2, '0')} ${t}`,
                   open: 100, high: 101, low: 99, close: 100, volume: 1000 });
    }
  }
  const strat = { signals: (b) => b.map((x, i) => (i === 5 ? { i, dir: 1 } : null)) };
  const spec = { multiplier: 10, tick: 1, marginRate: 0.1, limitPct: 0.1,
                 fee: { mode: 'fixed', value: 0 }, market: 'futures' };
  const daily = new PortfolioEngine([{ symbol: 'A', bars: day(26, 100), strategy: strat, params: {}, spec }],
                                    { capital: 1e6 }).run();
  assert.ok(!daily.error, `日线不该被拦，实际：${daily.error}`);
  const res = new PortfolioEngine([{ symbol: 'B', bars: intra, strategy: strat, params: {}, spec }],
                                  { capital: 1e6 }).run();
  assert.ok(res.error && /只支持日线/.test(res.error), '分钟级必须明确拒跑');
  // 空结构必须完整：调用方普遍直接 res.rejects.map(...)，缺字段会让上层崩在 undefined 上
  for (const k of ['trades', 'equityCurve', 'rejects', 'notices', 'symbols']) {
    assert.ok(Array.isArray(res[k]), `拒跑时 ${k} 仍须是数组`);
  }
});

/* ── 第三轮：浏览器冒烟抓到的两个静默错误 ─────────────────────────────── */

test('ChartModule 内部不许出现 this.chartModule（那是 undefined，会抛 TypeError）', () => {
  const html = fs.readFileSync(path.join(root, 'futures_replay_trader.html'), 'utf8').split('\n');
  const start = html.findIndex(l => /^    class ChartModule \{/.test(l));
  assert.ok(start > 0, '找不到 ChartModule 类起点');
  let end = start + 1;
  while (end < html.length && !/^    \}/.test(html[end])) end++;
  // updateLegend 曾经写 this.chartModule.blindMode —— 它就在 ChartModule 里面，
  // that 是 undefined，第一句就抛，于是 OHLC 图例从来没填过一次（界面恒为 --）。
  const bad = [];
  for (let i = start; i < end; i++) {
    const t = html[i].trim();
    if (/this\.chartModule\./.test(html[i]) && t && !/^(\/\/|\*|\/\*)/.test(t)) bad.push(`${i + 1}: ${t.slice(0, 70)}`);
  }
  assert.eq(bad.length, 0, `ChartModule 里引用了不存在的 this.chartModule：\n  ${bad.join('\n  ')}`);
});

test('periodSpacingOk 能认出"被静默降级成日线的周线缓存"', () => {
  // 连续日历日，升序 —— 判据看的是相邻间隔中位数，输入必须真的按时间排好
  const seq = (n, stepDays) => {
    const out = [];
    const t = Date.UTC(2023, 0, 1);
    for (let i = 0; i < n; i++) {
      out.push({ date: new Date(t + i * stepDays * 86400000).toISOString().slice(0, 10),
                 open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 });
    }
    return out;
  };
  const dailyBars = seq(140, 1);      // 间隔 1 天
  const weeklyBars = seq(40, 7);      // 间隔 7 天
  const monthlyBars = seq(36, 30);    // 间隔 30 天

  assert.ok(!periodSpacingOk(dailyBars, 'weekly'), '日线冒充周线必须被拒（这正是新浪旧行为）');
  assert.ok(periodSpacingOk(weeklyBars, 'weekly'), '真周线要放行');
  assert.ok(!periodSpacingOk(dailyBars, 'monthly'), '日线冒充月线必须被拒');
  assert.ok(!periodSpacingOk(weeklyBars, 'monthly'), '周线冒充月线也要被拒');
  assert.ok(periodSpacingOk(monthlyBars, 'monthly'), '真月线要放行');
  assert.ok(periodSpacingOk(dailyBars, 'daily'), 'daily 不在这条判据里，一律放行');
  assert.ok(periodSpacingOk(dailyBars.slice(0, 5), 'weekly'), '样本太少判不出来时别误伤');
});

test('新浪通道拒绝非 daily/60m 周期，不再拿日线顶替', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'data', 'sources.js'), 'utf8');
  assert.ok(/拒绝用日线顶替/.test(src), 'sources.js 必须明确拒绝没有的周期');
  const py = fs.readFileSync(path.join(root, 'run_local_server.py'), 'utf8');
  assert.ok(/拒绝用日线顶替/.test(py), 'Python 代理同样要拒绝，不能只有前端修好');
  // 旧的三元写法会把 weekly 静默落到日线服务上
  assert.ok(!/period === '60m'\s*\n?\s*\?/.test(src), '不许回到"非 60m 一律日线服务"那个写法');
});
