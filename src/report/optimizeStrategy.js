/**
 * 寻优 Worker 的策略重建入口。
 *
 * postMessage 会丢掉函数，因此自定义规则必须以纯数据文档传输，并在 Worker 内
 * 使用与主线程完全相同的编译器重建。
 */

import { getStrategy } from '../strategy/library.js';
import { normalizeRule } from '../strategy/ruleSchema.js';
import { compileRule } from '../strategy/ruleStrategy.js';

export function resolveOptimizerStrategy(message) {
  if (message.ruleDoc) return compileRule(normalizeRule(message.ruleDoc));
  return getStrategy(message.strategyId ?? message.id);
}
