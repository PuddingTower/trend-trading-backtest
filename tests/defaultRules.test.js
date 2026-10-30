import { test, assert, skip } from './harness.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RULES, DEFAULT_RULE_IDS } from '../src/strategy/defaultRules.js';
import { validateRule, ruleHash } from '../src/strategy/ruleSchema.js';
import { compileRule } from '../src/strategy/ruleStrategy.js';
import { addRule, getRuleEntry, isDefaultRule, listRuleEntries, strategyValue } from '../src/strategy/ruleRegistry.js';
import { runOne } from '../src/report/optimizer.js';
import { computeMetrics } from '../src/report/metrics.js';
import { resolveTradeSpec } from '../src/markets/instrumentSpec.js';
import { rulesFor } from '../src/markets/marketRules.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function syntheticBars({ start, step, n = 400 }) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const close = start + step * i + Math.sin(i / 9) * Math.abs(step) * 0.8;
    const open = close - step * 0.4;
    bars.push({
      date: `2026-01-${String(1 + Math.floor(i / 24)).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:00`,
      open, high: Math.max(open, close) + Math.abs(step) * 0.9 + 0.01,
      low: Math.min(open, close) - Math.abs(step) * 0.9 - 0.01,
      close, volume: 1000
    });
  }
  return bars;
}

test('默认规则通过校验、出现在注册表且带稳定内容哈希', () => {
  const entries = listRuleEntries();
  for (const doc of DEFAULT_RULES) {
    assert.deep(validateRule(doc), [], `${doc.id} 应通过 v1 校验`);
    const entry = getRuleEntry(doc.id);
    assert.ok(entry, `${doc.id} 应随注册表加载`);
    assert.eq(isDefaultRule(doc.id), true, `${doc.id} 应标记为默认规则`);
    assert.eq(entry.hash, ruleHash(doc), `${doc.id} 内容哈希应可复现`);
    assert.eq(entries.some((e) => e.id === doc.id), true, `${doc.id} 应出现在策略列表`);
    assert.eq(strategyValue(entry), `custom:${doc.id}`, `${doc.id} 的下拉值应稳定`);
  }
});

test('默认规则只做趋势：入场依赖均线排列，风控没有固定止盈', () => {
  for (const doc of DEFAULT_RULES) {
    const first = JSON.stringify(doc.rules[0].when);
    assert.ok(first.includes('"slow"') && first.includes('"fast"'), `${doc.id} 首条入场规则必须同时看快慢线`);
    assert.ok(!Object.values(doc.series).some((s) => s.op === 'rsi'), `${doc.id} 不应引入超买超卖反转`);
    for (const rule of doc.rules) {
      if (rule.do.risk) {
        assert.ok(!Object.prototype.hasOwnProperty.call(rule.do.risk, 'target'),
          `${doc.id} 不应设固定止盈（趋势策略让利润奔跑）`);
      }
    }
  }
  const both = DEFAULT_RULES.find((d) => d.id === 'intraday_ema_band_both');
  const long = DEFAULT_RULES.find((d) => d.id === 'intraday_ema_band_long');
  assert.ok(both.rules.some((r) => r.do.action === 'short'), '期货多空版必须有做空规则');
  assert.ok(!long.rules.some((r) => r.do.action === 'short'), '只做多版不能出现做空动作');
});

test('默认规则信号与 K 线等长，且截断未来 K 线不改变历史信号', () => {
  const bars = syntheticBars({ start: 100, step: 0.5 });
  for (const doc of DEFAULT_RULES) {
    const strategy = compileRule(doc);
    const full = strategy.signals(bars);
    const cut = strategy.signals(bars.slice(0, 250));
    assert.eq(full.length, bars.length, `${doc.id} 信号必须与 K 线等长`);
    assert.eq(cut.length, 250, `${doc.id} 截断后信号长度应对应截断 K 线`);
    assert.deep(full.slice(0, 250), cut, `${doc.id} 第 i 根信号不能使用 i 之后的数据`);
  }
});

test('单调上涨只出多、单调下跌只出空（按品种方向）', () => {
  const up = syntheticBars({ start: 100, step: 0.5 });
  const down = syntheticBars({ start: 500, step: -0.5 });
  for (const doc of DEFAULT_RULES) {
    const strategy = compileRule(doc);
    const upSignals = strategy.signals(up).filter(Boolean);
    const downSignals = strategy.signals(down).filter(Boolean);
    assert.ok(upSignals.some((s) => s.dir === 1), `${doc.id} 上涨段应有多头信号`);
    assert.ok(!upSignals.some((s) => s.dir === -1), `${doc.id} 上涨段不应出现空头信号`);
    assert.ok(!downSignals.some((s) => s.dir === 1), `${doc.id} 下跌段不应出现多头信号`);
    if (doc.id.endsWith('_both')) {
      assert.ok(downSignals.some((s) => s.dir === -1), '多空版在下跌段应有空头信号');
    } else {
      assert.ok(!downSignals.some((s) => s.dir === -1), '只做多版不能产生空头信号');
    }
  }
});

test('参数 step 是规范允许的属性，不再被当成未知字段拒绝', () => {
  const errors = validateRule({
    schemaVersion: 1, kind: 'rules', id: 'step_demo', name: '步长', revision: 1,
    parameters: { band: { type: 'number', default: 0.01, min: 0, max: 0.5, step: 0.005 } },
    series: { ma: { op: 'sma', source: { field: 'close' }, period: { const: 3 } } },
    rules: [{ when: { op: 'greaterThan', left: { field: 'close' }, right: { series: 'ma' } }, do: { action: 'long' } }]
  });
  assert.deep(errors, [], 'step 应与 docs/策略规则v1.md 的声明一致');
});

test('默认规则不能被同 revision 的导入文档静默覆盖', () => {
  assert.throws(() => addRule(DEFAULT_RULES[0]), '已有不低于');
});

test('默认多空规则在真实 1h 数据上能产生成交（无数据则跳过）', () => {
  const file = path.join(DIR, '..', 'fixtures', 'intraday1h', 'futures_rbm_60m.json');
  if (!fs.existsSync(file)) skip('fixtures/intraday1h 未抓取，运行 node tools/fetch_intraday_1h.js 后可跑');
  const bars = JSON.parse(fs.readFileSync(file, 'utf8')).bars;
  const doc = DEFAULT_RULES.find((d) => d.id === 'intraday_ema_band_both');
  const spec = resolveTradeSpec('rbm').spec;
  const first = new Date(bars[0].date.replace(' ', 'T')).getTime();
  const last = new Date(bars.at(-1).date.replace(' ', 'T')).getTime();
  const years = Math.max(1 / 365, (last - first) / (365.25 * 86400000));
  const ppy = Math.max(200, Math.min(3000, Math.round(bars.length / years)));
  const res = runOne({
    bars, spec, strategy: compileRule(doc), params: {},
    engineOpts: {
      capital: 200000, sizing: 'notional', notionalPct: 0.05, slippageTicks: 1,
      allowShort: true, rules: rulesFor(spec)
    },
    periodsPerYear: ppy
  });
  const m = computeMetrics({ equityCurve: res.equityCurve, trades: res.trades, capital: 200000, periodsPerYear: ppy, bars });
  assert.ok(m.trades > 0, '真实 60m 数据上应至少产生一笔成交');
  assert.ok(Number.isFinite(m.totalReturn), '收益应为有限数');
});
