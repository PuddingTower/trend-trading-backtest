import { test, assert } from './harness.js';
import { compileRule } from '../src/strategy/ruleStrategy.js';
import { normalizeRule, validateRule } from '../src/strategy/ruleSchema.js';

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
