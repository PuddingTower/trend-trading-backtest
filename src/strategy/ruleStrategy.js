/**
 * 将版本化 JSON 规则编译为现有策略接口。
 *
 * 信号仍严格遵守既有契约：每项只能使用 bars[0..i]，无操作返回 null。
 */

import { sma, ema, rsi, atr, priorExtreme } from './indicators.js';
import { getStrategy } from './library.js';
import { validateRule } from './ruleSchema.js';

const ACTION_DIR = { long: 1, short: -1, close: 0 };

const COMPARISONS = {
  greaterThan: (a, b) => a > b,
  lessThan: (a, b) => a < b,
  greaterThanOrEqual: (a, b) => a >= b,
  lessThanOrEqual: (a, b) => a <= b,
  equal: (a, b) => a === b,
  notEqual: (a, b) => a !== b
};

const ARITHMETIC = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  divide: (a, b) => b === 0 ? null : a / b
};

const CROSS_OPS = new Set(['crossUp', 'crossDown']);

function defaultParams(parameters = {}) {
  return Object.fromEntries(Object.entries(parameters).map(([key, definition]) => [key, definition.default]));
}

function resolveNumber(ref, values, params) {
  if (!ref || typeof ref !== 'object') return null;
  if (ref.param) return Number(params[ref.param]);
  if (ref.const !== undefined) return Number(ref.const);
  return null;
}

function resolveValue(ref, bars, series, i, params) {
  if (!ref || typeof ref !== 'object') return null;
  if (ref.field) return Number(bars[i]?.[ref.field]);
  if (ref.series) return series[ref.series]?.[i] ?? null;
  if (ref.const !== undefined) return Number(ref.const);
  if (ref.param) return Number(params[ref.param]);
  if (ARITHMETIC[ref.op]) {
    const left = resolveValue(ref.left, bars, series, i, params);
    const right = resolveValue(ref.right, bars, series, i, params);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
    return ARITHMETIC[ref.op](left, right);
  }
  return null;
}

function buildSeries(specs, bars, params) {
  const out = {};
  for (const [name, spec] of Object.entries(specs || {})) {
    const period = resolveNumber(spec.period, bars.map((b) => b[spec.source?.field]), params);
    const values = spec.source?.field ? bars.map((bar) => Number(bar[spec.source.field])) : [];
    if (spec.op === 'sma') out[name] = sma(values, period);
    else if (spec.op === 'ema') out[name] = ema(values, period);
    else if (spec.op === 'rsi') out[name] = rsi(values, period);
    else if (spec.op === 'priorHigh') out[name] = priorExtreme(bars, period, 'high');
    else if (spec.op === 'priorLow') out[name] = priorExtreme(bars, period, 'low');
    else if (spec.op === 'atr') out[name] = atr(bars, period);
    else throw new Error(`未知指标操作符 ${spec.op}`);
  }
  return out;
}

function evaluateCondition(condition, bars, series, i, params) {
  if (condition.op === 'and') {
    return (condition.conditions || []).every((child) => evaluateCondition(child, bars, series, i, params));
  }
  if (condition.op === 'or') {
    return (condition.conditions || []).some((child) => evaluateCondition(child, bars, series, i, params));
  }
  if (condition.op === 'not') {
    return !evaluateCondition(condition.condition, bars, series, i, params);
  }
  if (CROSS_OPS.has(condition.op)) {
    if (i === 0) return false;
    const currentLeft = resolveValue(condition.left, bars, series, i, params);
    const currentRight = resolveValue(condition.right, bars, series, i, params);
    const previousLeft = resolveValue(condition.left, bars, series, i - 1, params);
    const previousRight = resolveValue(condition.right, bars, series, i - 1, params);
    if (![currentLeft, currentRight, previousLeft, previousRight].every(Number.isFinite)) return false;
    if (condition.op === 'crossUp') return previousLeft <= previousRight && currentLeft > currentRight;
    return previousLeft >= previousRight && currentLeft < currentRight;
  }
  const compare = COMPARISONS[condition.op];
  if (!compare) throw new Error(`未知条件操作符 ${condition.op}`);
  const left = resolveValue(condition.left, bars, series, i, params);
  const right = resolveValue(condition.right, bars, series, i, params);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return compare(left, right);
}

export function compileRule(rule) {
  const errors = validateRule(rule);
  if (errors.length) {
    throw new Error(`策略规则校验失败: ${errors.map((e) => `${e.code} ${e.path}`).join('; ')}`);
  }
  if (rule.kind === 'builtin') {
    const base = getStrategy(rule.id);
    if (!base) throw new Error(`未知内置策略 ${rule.id}`);
    return {
      id: rule.id,
      name: base.name,
      params: { ...base.params, ...(rule.params || {}) },
      signals(bars, overrides = {}) {
        return base.signals(bars, { ...this.params, ...overrides });
      }
    };
  }
  if (rule.kind !== 'rules') throw new Error(`暂不支持的规则类型 ${rule.kind}`);

  return {
    id: rule.id,
    name: rule.name,
    description: rule.description || '',
    params: defaultParams(rule.parameters),
    parameters: rule.parameters || {},
    signals(bars, overrides = {}) {
      const params = { ...this.params, ...overrides };
      const series = buildSeries(rule.series, bars, params);
      return bars.map((bar, i) => {
        for (const conditionRule of rule.rules || []) {
          if (!evaluateCondition(conditionRule.when, bars, series, i, params)) continue;
          const action = conditionRule.do.action;
          if (action === 'noop') return null;
          const signal = { i, dir: ACTION_DIR[action] };
          if (conditionRule.do.reason) signal.reason = conditionRule.do.reason;
          if (action !== 'close' && conditionRule.do.risk) {
            for (const [key, ref] of Object.entries(conditionRule.do.risk)) {
              const value = resolveValue(ref, bars, series, i, params);
              if (Number.isFinite(value)) signal[key] = value;
            }
          }
          return signal;
        }
        return null;
      });
    }
  };
}
