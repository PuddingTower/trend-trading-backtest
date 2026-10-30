import { test, assert } from './harness.js';
import { compileRule } from '../src/strategy/ruleStrategy.js';
import { normalizeRule, ruleHash, validateRule } from '../src/strategy/ruleSchema.js';
import { resolveOptimizerStrategy } from '../src/report/optimizeStrategy.js';
import { compareStrategies } from '../src/report/strategyCompare.js';
import { addRule, getRuleEntry, listRuleEntries, parseRuleJson, resolveStrategyValue, strategyValue } from '../src/strategy/ruleRegistry.js';

const mk = (date, close) => ({ date, open: close, high: close, low: close, close, volume: 100 });

const singleRule = (condition) => ({
  schemaVersion: 1,
  kind: 'rules',
  id: 'comparison_demo',
  name: '比较条件',
  revision: 1,
  parameters: {},
  series: {},
  rules: [{ when: condition, do: { action: 'long', reason: '比较成立' } }]
});

test('JSON 规则可编译为与 K 线等长的现有策略信号', () => {
  const rule = {
    schemaVersion: 1,
    kind: 'rules',
    id: 'ma_above_demo',
    name: '收盘站上均线',
    revision: 1,
    parameters: {
      fast: { type: 'integer', default: 3, min: 1, max: 500 }
    },
    requires: {
      fields: ['open', 'high', 'low', 'close', 'volume']
    },
    series: {
      fastMa: { op: 'sma', source: { field: 'close' }, period: { param: 'fast' } }
    },
    rules: [
      {
        when: {
          op: 'greaterThan',
          left: { field: 'close' },
          right: { series: 'fastMa' }
        },
        do: { action: 'long', reason: '收盘站上均线' }
      }
    ]
  };
  const bars = [mk('2024-01-01', 90), mk('2024-01-02', 100), mk('2024-01-03', 110)];

  const strategy = compileRule(rule);
  assert.eq(strategy.id, 'ma_above_demo');
  assert.eq(strategy.name, '收盘站上均线');
  assert.eq(strategy.params.fast, 3);

  const signals = strategy.signals(bars, { fast: 3 });
  assert.deep(
    signals.map((s) => (s ? { i: s.i, dir: s.dir, reason: s.reason } : null)),
    [null, null, { i: 2, dir: 1, reason: '收盘站上均线' }]
  );
});

test('组合条件 and 支持显式平仓，未命中保持 null', () => {
  const rule = {
    schemaVersion: 1,
    kind: 'rules',
    id: 'explicit_close_demo',
    name: '显式平仓',
    revision: 1,
    parameters: {},
    series: {},
    rules: [
      {
        when: {
          op: 'and',
          conditions: [
            { op: 'greaterThan', left: { const: 2 }, right: { const: 1 } },
            { op: 'greaterThan', left: { const: 3 }, right: { const: 1 } }
          ]
        },
        do: { action: 'close', reason: '显式平仓' }
      },
      {
        when: {
          op: 'and',
          conditions: [
            { op: 'greaterThan', left: { const: 1 }, right: { const: 2 } },
            { op: 'greaterThan', left: { const: 3 }, right: { const: 1 } }
          ]
        },
        do: { action: 'long', reason: '永不命中' }
      }
    ]
  };
  const bars = [mk('2024-01-01', 100)];
  const signals = compileRule(rule).signals(bars);

  assert.deep(signals, [{ i: 0, dir: 0, reason: '显式平仓' }]);
});

test('组合条件 or 命中任一条件即执行对应动作', () => {
  const rule = {
    schemaVersion: 1,
    kind: 'rules',
    id: 'or_demo',
    name: '任一条件',
    revision: 1,
    parameters: {},
    series: {},
    rules: [
      {
        when: {
          op: 'or',
          conditions: [
            { op: 'greaterThan', left: { const: 1 }, right: { const: 2 } },
            { op: 'greaterThan', left: { const: 3 }, right: { const: 2 } }
          ]
        },
        do: { action: 'long', reason: '任一条件成立' }
      }
    ]
  };
  const signals = compileRule(rule).signals([mk('2024-01-01', 100)]);
  assert.deep(signals, [{ i: 0, dir: 1, reason: '任一条件成立' }]);
});

test('组合条件 not 反转原子条件结果', () => {
  const rule = {
    schemaVersion: 1,
    kind: 'rules',
    id: 'not_demo',
    name: '条件取反',
    revision: 1,
    parameters: {},
    series: {},
    rules: [
      {
        when: {
          op: 'not',
          condition: { op: 'greaterThan', left: { const: 1 }, right: { const: 2 } }
        },
        do: { action: 'long', reason: '原条件不成立' }
      }
    ]
  };
  const signals = compileRule(rule).signals([mk('2024-01-01', 100)]);
  assert.deep(signals, [{ i: 0, dir: 1, reason: '原条件不成立' }]);
});

test('比较操作符覆盖大小、等值与空值安全语义', () => {
  const compare = (op, left, right) => {
    const signals = compileRule(singleRule({ op, left, right })).signals([mk('2024-01-01', 100)]);
    return Boolean(signals[0]);
  };

  assert.eq(compare('greaterThan', { const: 2 }, { const: 1 }), true);
  assert.eq(compare('greaterThan', { const: 1 }, { const: 2 }), false);
  assert.eq(compare('lessThan', { const: 1 }, { const: 2 }), true);
  assert.eq(compare('greaterThanOrEqual', { const: 2 }, { const: 2 }), true);
  assert.eq(compare('lessThanOrEqual', { const: 2 }, { const: 2 }), true);
  assert.eq(compare('equal', { const: 2 }, { const: 2 }), true);
  assert.eq(compare('notEqual', { const: 2 }, { const: 3 }), true);
  assert.eq(compare('equal', { const: 2 }, { const: 3 }), false);

  const warmupSignals = compileRule({
    schemaVersion: 1,
    kind: 'rules',
    id: 'warmup_demo',
    name: '暖机期',
    revision: 1,
    parameters: { period: { type: 'integer', default: 2, min: 1, max: 500 } },
    series: { ma: { op: 'sma', source: { field: 'close' }, period: { param: 'period' } } },
    rules: [{
      when: { op: 'greaterThan', left: { field: 'close' }, right: { series: 'ma' } },
      do: { action: 'long', reason: '不应命中暖机期' }
    }]
  }).signals([mk('2024-01-01', 100)], { period: 2 });
  assert.eq(warmupSignals[0], null, '序列尚未就绪时比较条件不能把 null 当数值');
});

test('数值表达式支持加减乘除并在除零时安全失效', () => {
  const compareArithmetic = (op, expected) => {
    const rule = singleRule({
      op: 'equal',
      left: { op, left: { field: 'close' }, right: { const: 20 } },
      right: { const: expected }
    });
    return Boolean(compileRule(rule).signals([mk('2024-01-01', 100)])[0]);
  };

  assert.eq(compareArithmetic('add', 120), true);
  assert.eq(compareArithmetic('subtract', 80), true);
  assert.eq(compareArithmetic('multiply', 2000), true);
  assert.eq(compareArithmetic('divide', 5), true);
  assert.eq(compareArithmetic('divide', 0), false, '除数必须可配置，不能把除零结果当 0');

  const zeroDivide = singleRule({
    op: 'equal',
    left: { op: 'divide', left: { field: 'close' }, right: { const: 0 } },
    right: { const: 0 }
  });
  assert.eq(compileRule(zeroDivide).signals([mk('2024-01-01', 100)])[0], null);
});

test('builtin 规则文档复用现有策略实现', () => {
  const bars = [1, 2, 3, 4, 5].map((close, index) => mk(`2024-01-0${index + 1}`, close));
  const strategy = compileRule({
    schemaVersion: 1,
    kind: 'builtin',
    id: 'maCross',
    revision: 1,
    params: { fast: 2, slow: 3, mode: 'sma', trailAtr: 0, bothWays: false }
  });

  assert.eq(strategy.id, 'maCross');
  assert.eq(strategy.name, '双均线交叉');
  assert.eq(strategy.params.fast, 2);
  assert.eq(strategy.signals(bars).length, bars.length);
  assert.eq(strategy.signals(bars)[2].dir, 1);
});

test('校验器对缺失 schemaVersion 返回稳定错误码和 JSON 路径', () => {
  const errors = validateRule({ kind: 'rules', id: 'x', name: '测试', revision: 1, parameters: {}, series: {}, rules: [] });
  assert.deep(errors.map((e) => [e.code, e.path]), [['MISSING_FIELD', '$.schemaVersion']]);
  assert.ok(errors[0].message);
});

test('校验器拒绝未知规则类型和未知顶层字段', () => {
  const errors = validateRule({
    schemaVersion: 1,
    kind: 'expression',
    id: 'x',
    name: '测试',
    revision: 1,
    unknownOption: true
  });
  assert.deep(errors.map((e) => [e.code, e.path]), [
    ['UNSUPPORTED_KIND', '$.kind'],
    ['UNKNOWN_FIELD', '$.unknownOption']
  ]);
});

test('校验器按 JSON 路径报告未知参数、未知序列和非法动作', () => {
  const errors = validateRule({
    schemaVersion: 1,
    kind: 'rules',
    id: 'x',
    name: '测试',
    revision: 1,
    parameters: {},
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: {
      bad: { op: 'sma', source: { field: 'close' }, period: { param: 'missing' } }
    },
    rules: [
      {
        when: { op: 'greaterThan', left: { series: 'ghost' }, right: { const: 1 } },
        do: { action: 'hold' }
      }
    ]
  });

  assert.deep(errors.map((e) => [e.code, e.path]), [
    ['UNKNOWN_PARAMETER', '$.series.bad.period'],
    ['UNKNOWN_SERIES', '$.rules[0].when.left'],
    ['INVALID_ACTION', '$.rules[0].do.action']
  ]);
});

test('编译器在生成信号前拒绝非法规则文档', () => {
  assert.throws(
    () => compileRule({ kind: 'rules', id: 'x', name: '测试', revision: 1 }),
    'MISSING_FIELD',
    '编译失败应携带稳定校验错误码'
  );
});

test('规范化内置策略文档时补齐显示名并输出稳定字段', () => {
  assert.deep(normalizeRule({
    revision: 2,
    params: { fast: 2 },
    kind: 'builtin',
    id: 'maCross',
    schemaVersion: 1
  }), {
    schemaVersion: 1,
    kind: 'builtin',
    id: 'maCross',
    name: '双均线交叉',
    revision: 2,
    params: { fast: 2 }
  });
});

test('crossUp 与 crossDown 只在穿越发生的当前根给信号', () => {
  const bars = [10, 1, 2, 20].map((close, index) => mk(`2024-01-0${index + 1}`, close));
  const rule = {
    schemaVersion: 1,
    kind: 'rules',
    id: 'cross_demo',
    name: '均线交叉',
    revision: 1,
    parameters: {
      fast: { type: 'integer', default: 2, min: 1, max: 500 },
      slow: { type: 'integer', default: 3, min: 1, max: 500 }
    },
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: {
      fastMa: { op: 'sma', source: { field: 'close' }, period: { param: 'fast' } },
      slowMa: { op: 'sma', source: { field: 'close' }, period: { param: 'slow' } }
    },
    rules: [
      { when: { op: 'crossUp', left: { series: 'fastMa' }, right: { series: 'slowMa' } }, do: { action: 'long', reason: '上穿' } },
      { when: { op: 'crossDown', left: { series: 'fastMa' }, right: { series: 'slowMa' } }, do: { action: 'close', reason: '下穿' } }
    ]
  };

  assert.deep(
    compileRule(rule).signals(bars).map((s) => (s ? { i: s.i, dir: s.dir, reason: s.reason } : null)),
    [null, null, null, { i: 3, dir: 1, reason: '上穿' }]
  );
});

test('指标目录支持 ema、rsi 和 priorHigh', () => {
  const bars = [10, 1, 2, 20].map((close, index) => mk(`2024-01-0${index + 1}`, close));
  const rule = {
    schemaVersion: 1,
    kind: 'rules',
    id: 'indicator_catalog_demo',
    name: '指标目录',
    revision: 1,
    parameters: { len: { type: 'integer', default: 2, min: 1, max: 500 } },
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: {
      trend: { op: 'ema', source: { field: 'close' }, period: { param: 'len' } },
      strength: { op: 'rsi', source: { field: 'close' }, period: { param: 'len' } },
      recentHigh: { op: 'priorHigh', source: { field: 'high' }, period: { param: 'len' } }
    },
    rules: [
      {
        when: {
          op: 'and',
          conditions: [
            { op: 'greaterThan', left: { field: 'close' }, right: { series: 'trend' } },
            { op: 'greaterThan', left: { field: 'close' }, right: { series: 'recentHigh' } },
            { op: 'greaterThan', left: { series: 'strength' }, right: { const: 50 } }
          ]
        },
        do: { action: 'long', reason: '指标共振' }
      }
    ]
  };

  assert.deep(
    compileRule(rule).signals(bars).map((s) => (s ? { i: s.i, dir: s.dir, reason: s.reason } : null)),
    [null, null, null, { i: 3, dir: 1, reason: '指标共振' }]
  );
});

test('动作可输出初始止损和止盈绝对价格', () => {
  const rule = {
    schemaVersion: 1,
    kind: 'rules',
    id: 'risk_demo',
    name: '初始风险',
    revision: 1,
    parameters: {},
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: {},
    rules: [
      {
        when: { op: 'greaterThan', left: { field: 'close' }, right: { const: 90 } },
        do: {
          action: 'long',
          reason: '进场',
          risk: {
            stop: { op: 'subtract', left: { field: 'close' }, right: { const: 5 } },
            target: { op: 'add', left: { field: 'close' }, right: { const: 10 } }
          }
        }
      }
    ]
  };
  const signals = compileRule(rule).signals([mk('2024-01-01', 100)]);
  assert.deep(signals, [{ i: 0, dir: 1, reason: '进场', stop: 95, target: 110 }]);
});

test('规则注册表可解析 JSON、校验并编译导入规则', () => {
  const rule = {
    schemaVersion: 1,
    kind: 'rules',
    id: 'registered_demo',
    name: '已注册规则',
    revision: 1,
    parameters: {},
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: {},
    rules: [{ when: { op: 'greaterThan', left: { const: 2 }, right: { const: 1 } }, do: { action: 'long' } }]
  };
  const entry = addRule(rule);

  assert.eq(entry.id, 'registered_demo');
  assert.eq(entry.doc.name, '已注册规则');
  assert.ok(/^[a-f0-9]{16}$/.test(entry.hash));
  assert.eq(listRuleEntries().some((item) => item.id === entry.id), true);
  assert.eq(getRuleEntry(entry.id).strategy.signals([mk('2024-01-01', 100)])[0].dir, 1);
  assert.eq(parseRuleJson('{"schemaVersion":1,"kind":"unknown"}').errors[0].code, 'UNSUPPORTED_KIND');
});

test('自定义规则选项值可与内置策略 ID 隔离解析', () => {
  const rule = {
    schemaVersion: 1,
    kind: 'rules',
    id: 'option_demo',
    name: '选项规则',
    revision: 1,
    parameters: {},
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: {},
    rules: [{ when: { op: 'greaterThan', left: { const: 2 }, right: { const: 1 } }, do: { action: 'noop' } }]
  };
  const entry = addRule(rule);
  assert.eq(strategyValue(entry), 'custom:option_demo');
  assert.eq(resolveStrategyValue('custom:option_demo').id, 'option_demo');
  assert.eq(resolveStrategyValue('maCross').id, 'maCross');
});

test('寻优 Worker 可从纯数据规则文档重建策略', () => {
  const rule = {
    schemaVersion: 1,
    kind: 'rules',
    id: 'worker_demo',
    name: 'Worker 规则',
    revision: 1,
    parameters: { threshold: { type: 'number', default: 100, min: 1, max: 10000 } },
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: {},
    rules: [{
      when: { op: 'greaterThan', left: { field: 'close' }, right: { param: 'threshold' } },
      do: { action: 'long', reason: '超过阈值' }
    }]
  };
  const strategy = resolveOptimizerStrategy({ ruleDoc: rule });
  const signals = strategy.signals([mk('2024-01-01', 120)], { threshold: 100 });
  assert.deep(signals, [{ i: 0, dir: 1, reason: '超过阈值' }]);
  assert.eq(resolveOptimizerStrategy({ strategyId: 'maCross' }).id, 'maCross');
  assert.eq(resolveOptimizerStrategy({ strategyId: 'ghost' }), null);
});

test('策略对比可直接使用纯数据规则文档作为参与项', () => {
  const bars = [90, 100, 110].map((close, index) => mk(`2024-01-0${index + 1}`, close));
  const ruleDoc = {
    schemaVersion: 1,
    kind: 'rules',
    id: 'compare_rule',
    name: '对比规则',
    revision: 1,
    parameters: { threshold: { type: 'number', default: 80, min: 1, max: 10000 } },
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: {},
    rules: [{
      when: { op: 'greaterThan', left: { field: 'close' }, right: { param: 'threshold' } },
      do: { action: 'long', reason: '高于阈值' }
    }]
  };
  const result = compareStrategies({
    bars,
    spec: { market: 'futures', multiplier: 10, tick: 1, marginRate: 0.1, fee: { mode: 'fixed', value: 4 } },
    entries: [{ id: 'compare_rule', ruleDoc }, 'maCross'],
    engineOpts: { capital: 200000, lots: 1 },
    includeBenchmark: false
  });

  assert.eq(result.error, undefined);
  assert.eq(result.runs.length, 2);
  assert.eq(result.runs[0].name, '对比规则');
  assert.eq(result.runs[1].name, '双均线交叉');
});

test('规则声明的行情字段缺失时直接拒绝计算，不静默空跑', () => {
  const rule = {
    schemaVersion: 1,
    kind: 'rules',
    id: 'requires_demo',
    name: '字段要求',
    revision: 1,
    parameters: {},
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: {},
    rules: [{ when: { op: 'greaterThan', left: { field: 'close' }, right: { const: 0 } }, do: { action: 'long' } }]
  };
  const strategy = compileRule(rule);
  assert.throws(
    () => strategy.signals([{ date: '2024-01-01', open: 1, high: 2, low: 0.5, close: 1 }]),
    'REQUIRED_FIELD_MISSING',
    '缺少成交量时必须明确拒绝，而不是把所有条件算成 false'
  );
});

test('规则条件树超过复杂度上限时拒绝导入', () => {
  let condition = { op: 'greaterThan', left: { const: 1 }, right: { const: 0 } };
  for (let i = 0; i < 120; i++) condition = { op: 'and', conditions: [condition] };
  const errors = validateRule({
    schemaVersion: 1,
    kind: 'rules',
    id: 'deep_rule',
    name: '过深规则',
    revision: 1,
    parameters: {},
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: {},
    rules: [{ when: condition, do: { action: 'noop' } }]
  });
  assert.ok(errors.some(e => e.code === 'RULE_TOO_COMPLEX'), `应拒绝 120 层嵌套，实际 ${JSON.stringify(errors)}`);
});

test('规则内容哈希只认规范化后的内容', () => {
  const first = {
    revision: 1,
    params: { fast: 2 },
    schemaVersion: 1,
    kind: 'builtin',
    id: 'hash_demo',
    name: '哈希示例'
  };
  const reordered = {
    schemaVersion: 1,
    kind: 'builtin',
    id: 'hash_demo',
    name: '哈希示例',
    revision: 1,
    params: { fast: 2 }
  };
  const changed = { ...reordered, params: { fast: 10 } };

  assert.ok(/^[a-f0-9]{16}$/.test(ruleHash(first)));
  assert.eq(ruleHash(first), ruleHash(reordered));
  assert.ok(ruleHash(first) !== ruleHash(changed));
});

test('编译后的策略携带规则格式版本和内容哈希', () => {
  const doc = {
    schemaVersion: 1,
    kind: 'builtin',
    id: 'maCross',
    revision: 4,
    params: { fast: 8 }
  };
  const strategy = compileRule(doc);
  assert.eq(strategy.schemaVersion, 1);
  assert.eq(strategy.contentHash, ruleHash(doc));
});

test('超过体积上限的规则文本不进入 JSON 解析', () => {
  const result = parseRuleJson('[' + '1'.repeat(300_000) + ']');
  assert.eq(result.errors[0].code, 'RULE_FILE_TOO_LARGE');
});
