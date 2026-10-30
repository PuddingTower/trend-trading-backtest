/**
 * 浏览器会话内的自定义策略规则注册表。
 *
 * 规则文档是纯数据，编译结果仍符合内置策略的 signals(bars, params) 契约。
 */

import { compileRule } from './ruleStrategy.js';
import { normalizeRule, ruleHash, validateRule } from './ruleSchema.js';
import { getStrategy } from './library.js';

const entries = new Map();
const MAX_RULE_TEXT_BYTES = 256_000;

export function parseRuleJson(text) {
  if (String(text).length > MAX_RULE_TEXT_BYTES) {
    return { errors: [{ code: 'RULE_FILE_TOO_LARGE', path: '$', message: `规则文件超过 ${MAX_RULE_TEXT_BYTES} 字符上限` }] };
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (e) {
    return { errors: [{ code: 'INVALID_JSON', path: '$', message: `JSON 解析失败：${e.message}` }] };
  }
  const errors = validateRule(document);
  if (errors.length) return { errors };
  return { document };
}

export function addRule(rule) {
  const doc = normalizeRule(rule);
  const existing = entries.get(doc.id);
  if (existing && existing.revision >= doc.revision) {
    throw new Error(`规则 ${doc.id} 已有不低于 ${existing.revision} 的版本，请先提高 revision`);
  }
  const entry = {
    id: doc.id,
    name: doc.name,
    revision: doc.revision,
    kind: doc.kind,
    hash: ruleHash(doc),
    doc,
    strategy: compileRule(doc)
  };
  entries.set(doc.id, entry);
  return entry;
}

export function getRuleEntry(id) {
  return entries.get(id) || null;
}

export function listRuleEntries() {
  return [...entries.values()];
}

export function removeRuleEntry(id) {
  return entries.delete(id);
}

export const strategyValue = (entry) => `custom:${entry.id}`;

export function resolveStrategyValue(value) {
  if (!value) return null;
  if (value.startsWith('custom:')) {
    return getRuleEntry(value.slice('custom:'.length))?.strategy || null;
  }
  return getStrategy(value);
}
