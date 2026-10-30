/** 策略规则 v1 的结构校验与规范化。 */

import { getStrategy } from './library.js';

const REQUIRED_FIELDS = ['schemaVersion', 'kind', 'id', 'name', 'revision'];
const ALLOWED_FIELDS = new Set([
  ...REQUIRED_FIELDS,
  'description', 'parameters', 'requires', 'series', 'rules', 'params', 'metadata'
]);
const KINDS = new Set(['builtin', 'rules']);
const COMPARISON_OPS = new Set(['greaterThan', 'lessThan', 'greaterThanOrEqual', 'lessThanOrEqual', 'equal', 'notEqual']);
const CROSS_OPS = new Set(['crossUp', 'crossDown']);
const ARITHMETIC_OPS = new Set(['add', 'subtract', 'multiply', 'divide']);
const SERIES_OPS = new Set(['sma', 'ema', 'rsi', 'atr', 'priorHigh', 'priorLow']);
const PARAMETER_TYPES = new Set(['integer', 'number', 'boolean', 'string']);
const ACTIONS = new Set(['long', 'short', 'close', 'noop']);
const ACTION_FIELDS = new Set(['action', 'reason', 'risk']);
const RISK_FIELDS = new Set(['stop', 'target', 'trail']);
const MAX_RULE_NODES = 2048;
const MAX_RULE_DEPTH = 64;
const BAR_FIELDS = new Set(['date', 'open', 'high', 'low', 'close', 'volume']);
const PARAMETER_FIELDS = new Set(['type', 'default', 'min', 'max', 'enum', 'label', 'description']);

function error(code, path, message) {
  return { code, path, message };
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function jsonComplexity(value, depth = 0, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return { nodes: 1, maxDepth: depth };
  if (seen.has(value)) return { nodes: Number.POSITIVE_INFINITY, maxDepth: depth };
  seen.add(value);
  let nodes = 1, maxDepth = depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const result = jsonComplexity(child, depth + 1, seen);
    nodes += result.nodes;
    maxDepth = Math.max(maxDepth, result.maxDepth);
  }
  return { nodes, maxDepth };
}

function validateParameters(parameters, path, errors) {
  if (parameters === undefined) return;
  if (!isRecord(parameters)) {
    errors.push(error('INVALID_PARAMETERS', path, 'parameters 必须是对象'));
    return;
  }
  for (const [name, definition] of Object.entries(parameters)) {
    const itemPath = `${path}.${name}`;
    if (!isRecord(definition)) {
      errors.push(error('INVALID_PARAMETER', itemPath, `参数 ${name} 必须是定义对象`));
      continue;
    }
    for (const field of Object.keys(definition)) {
      if (!PARAMETER_FIELDS.has(field)) errors.push(error('UNKNOWN_PARAMETER_FIELD', `${itemPath}.${field}`, `未知参数属性 ${field}`));
    }
    if (!PARAMETER_TYPES.has(definition.type)) errors.push(error('INVALID_PARAMETER_TYPE', `${itemPath}.type`, '参数类型只能是 integer、number、boolean 或 string'));
    if (definition.default === undefined) errors.push(error('MISSING_PARAMETER_DEFAULT', `${itemPath}.default`, '参数必须提供 default'));
    if (definition.type === 'integer' && (!Number.isInteger(definition.default) || definition.default < 1)) {
      errors.push(error('INVALID_PARAMETER_DEFAULT', `${itemPath}.default`, 'integer 参数的默认值必须是大于 0 的整数'));
    }
  }
}

function validateValueRef(ref, path, parameters, series, errors) {
  if (!isRecord(ref)) {
    errors.push(error('INVALID_VALUE_REF', path, '数值引用必须是对象'));
    return;
  }
  if (ref.param) {
    if (!parameters[ref.param]) errors.push(error('UNKNOWN_PARAMETER', path, `引用了不存在的参数 ${ref.param}`));
    return;
  }
  if (ref.series) {
    if (!series[ref.series]) errors.push(error('UNKNOWN_SERIES', path, `引用了不存在的指标序列 ${ref.series}`));
    return;
  }
  if (ref.op) {
    if (!ARITHMETIC_OPS.has(ref.op)) {
      errors.push(error('UNKNOWN_VALUE_OP', `${path}.op`, `未知数值操作符 ${ref.op}`));
      return;
    }
    validateValueRef(ref.left, `${path}.left`, parameters, series, errors);
    validateValueRef(ref.right, `${path}.right`, parameters, series, errors);
    return;
  }
  if (!ref.field && ref.const === undefined) {
    errors.push(error('INVALID_VALUE_REF', path, '数值引用必须使用 field、series、const、param 或算术表达式'));
  }
}

function validateCondition(condition, path, parameters, series, errors) {
  if (!isRecord(condition)) {
    errors.push(error('INVALID_CONDITION', path, '条件必须是对象'));
    return;
  }
  if (condition.op === 'and' || condition.op === 'or') {
    if (!Array.isArray(condition.conditions) || !condition.conditions.length) {
      errors.push(error('INVALID_CONDITIONS', `${path}.conditions`, 'and/or 必须包含非空 conditions 数组'));
      return;
    }
    condition.conditions.forEach((child, index) => validateCondition(child, `${path}.conditions[${index}]`, parameters, series, errors));
    return;
  }
  if (condition.op === 'not') {
    validateCondition(condition.condition, `${path}.condition`, parameters, series, errors);
    return;
  }
  if (!COMPARISON_OPS.has(condition.op) && !CROSS_OPS.has(condition.op)) {
    errors.push(error('UNKNOWN_CONDITION_OP', `${path}.op`, `未知条件操作符 ${condition.op}`));
    return;
  }
  validateValueRef(condition.left, `${path}.left`, parameters, series, errors);
  validateValueRef(condition.right, `${path}.right`, parameters, series, errors);
}

function validateRulesKind(rule, errors) {
  const parameters = isRecord(rule.parameters) ? rule.parameters : {};
  const series = isRecord(rule.series) ? rule.series : {};

  validateParameters(rule.parameters, '$.parameters', errors);

  if (rule.requires !== undefined && isRecord(rule.requires)) {
    const fields = rule.requires.fields;
    if (!Array.isArray(fields)) errors.push(error('INVALID_REQUIRES', '$.requires.fields', 'requires.fields 必须是数组'));
    else fields.forEach((field, index) => {
      if (!BAR_FIELDS.has(field)) errors.push(error('UNSUPPORTED_FIELD', `$.requires.fields[${index}]`, `首版不支持行情字段 ${field}`));
    });
  }

  if (!isRecord(rule.series)) errors.push(error('INVALID_SERIES', '$.series', 'series 必须是对象'));
  for (const [name, spec] of Object.entries(series)) {
    const itemPath = `$.series.${name}`;
    if (!isRecord(spec)) {
      errors.push(error('INVALID_SERIES', itemPath, '指标序列必须是对象'));
      continue;
    }
    if (!SERIES_OPS.has(spec.op)) errors.push(error('UNKNOWN_SERIES_OP', `${itemPath}.op`, `未知指标操作符 ${spec.op}`));
    if (!isRecord(spec.source) || !BAR_FIELDS.has(spec.source.field)) {
      if (spec.op !== 'atr') errors.push(error('INVALID_SERIES_SOURCE', `${itemPath}.source`, '首版指标只允许消费已支持的行情字段'));
    }
    validateValueRef(spec.period, `${itemPath}.period`, parameters, series, errors);
  }

  if (!Array.isArray(rule.rules) || !rule.rules.length) errors.push(error('INVALID_RULES', '$.rules', 'rules 必须是非空数组'));
  else rule.rules.forEach((conditionRule, index) => {
    const itemPath = `$.rules[${index}]`;
    if (!isRecord(conditionRule)) {
      errors.push(error('INVALID_RULE', itemPath, '规则项必须是对象'));
      return;
    }
    validateCondition(conditionRule.when, `${itemPath}.when`, parameters, series, errors);
    if (!isRecord(conditionRule.do)) errors.push(error('INVALID_ACTION_OBJECT', `${itemPath}.do`, '动作必须是对象'));
    else {
      if (!ACTIONS.has(conditionRule.do.action)) errors.push(error('INVALID_ACTION', `${itemPath}.do.action`, 'action 只能是 long、short、close 或 noop'));
      for (const field of Object.keys(conditionRule.do)) {
        if (!ACTION_FIELDS.has(field)) errors.push(error('UNKNOWN_ACTION_FIELD', `${itemPath}.do.${field}`, `未知动作字段 ${field}`));
      }
      if (conditionRule.do.risk !== undefined) {
        if (!isRecord(conditionRule.do.risk)) {
          errors.push(error('INVALID_RISK', `${itemPath}.do.risk`, 'risk 必须是对象'));
        } else {
          for (const [field, value] of Object.entries(conditionRule.do.risk)) {
            const itemRiskPath = `${itemPath}.do.risk.${field}`;
            if (!RISK_FIELDS.has(field)) errors.push(error('UNKNOWN_RISK_FIELD', itemRiskPath, `未知风控字段 ${field}`));
            else validateValueRef(value, itemRiskPath, parameters, series, errors);
          }
        }
      }
    }
  });
}

export function validateRule(rule) {
  const errors = [];
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return [error('INVALID_RULE_DOCUMENT', '$', '策略规则必须是 JSON 对象')];
  }

  if (rule.schemaVersion === undefined) errors.push(error('MISSING_FIELD', '$.schemaVersion', '缺少 schemaVersion'));
  else if (rule.schemaVersion !== 1) errors.push(error('UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion', '仅支持 schemaVersion 1'));

  if (rule.kind === undefined) errors.push(error('MISSING_FIELD', '$.kind', '缺少 kind'));
  else if (!KINDS.has(rule.kind)) errors.push(error('UNSUPPORTED_KIND', '$.kind', `kind 只能是 ${[...KINDS].join(' 或 ')}`));

  if (typeof rule.id !== 'string' || !rule.id) errors.push(error('INVALID_ID', '$.id', 'id 必须是非空字符串'));
  if (rule.name === undefined) {
    if (rule.kind === 'rules') errors.push(error('MISSING_FIELD', '$.name', '自定义规则必须提供 name'));
  } else if (typeof rule.name !== 'string' || !rule.name) {
    errors.push(error('INVALID_NAME', '$.name', 'name 必须是非空字符串'));
  }
  if (!Number.isInteger(rule.revision) || rule.revision < 1) {
    errors.push(error('INVALID_REVISION', '$.revision', 'revision 必须是大于 0 的整数'));
  }
  for (const field of Object.keys(rule)) {
    if (!ALLOWED_FIELDS.has(field)) errors.push(error('UNKNOWN_FIELD', `$.${field}`, `未知顶层字段 ${field}`));
  }
  if (errors.length) return errors;
  const complexity = jsonComplexity(rule);
  if (complexity.nodes > MAX_RULE_NODES || complexity.maxDepth > MAX_RULE_DEPTH) {
    errors.push(error('RULE_TOO_COMPLEX', '$.rules', `规则文档最多 ${MAX_RULE_NODES} 个节点、嵌套深度不超过 ${MAX_RULE_DEPTH} 层`));
    return errors;
  }
  if (rule.kind === 'rules') validateRulesKind(rule, errors);
  return errors;
}

export function normalizeRule(rule) {
  const errors = validateRule(rule);
  if (errors.length) {
    throw new Error(`策略规则校验失败: ${errors.map((e) => `${e.code} ${e.path}`).join('; ')}`);
  }

  if (rule.kind === 'builtin') {
    return {
      schemaVersion: 1,
      kind: 'builtin',
      id: rule.id,
      name: rule.name || getStrategy(rule.id).name,
      revision: rule.revision,
      params: { ...(rule.params || {}) }
    };
  }

  return {
    schemaVersion: 1,
    kind: 'rules',
    id: rule.id,
    name: rule.name,
    revision: rule.revision,
    ...(rule.description ? { description: rule.description } : {}),
    parameters: { ...(rule.parameters || {}) },
    requires: { ...(rule.requires || {}) },
    series: { ...(rule.series || {}) },
    rules: [...(rule.rules || [])]
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
  return value;
}

function fnv1a(text, offset) {
  let hash = offset >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function ruleHash(rule) {
  const canonical = JSON.stringify(canonicalize(normalizeRule(rule)));
  return fnv1a(canonical, 0x811c9dc5) + fnv1a(canonical, 0x01000193);
}
