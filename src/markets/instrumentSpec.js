/**
 * 交易规格解析：把任意代码解析成回测/下单需要的 {multiplier, tick, marginRate, fee, closeTodayFee}。
 *
 * 抽出来的原因：界面面板和命令行跑批都要用同一套口径。两处各写一份的话，
 * 迟早会出现「网页里跑出来和命令行不一样」这种最难查的分歧。
 */

import { parseSymbol, MARKETS } from './symbolMeta.js';
import { FUTURES_SPECS } from './contractSpecs.js';

/** A股现货默认规格：1 手=100 股、全额资金（marginRate=1）、佣金万 2.5 最低 5 元、卖出印花税 0.05%。 */
export const ASHARE_SPEC = {
  name: 'A股现货',
  multiplier: 100,
  tick: 0.01,
  marginRate: 1.0,
  fee: { mode: 'rate', value: 0.00025, min: 5 },
  closeTodayFee: { mode: 'rate', value: 0.00025, min: 5 },
  stampTax: { mode: 'rate', value: 0.0005, onSellOnly: true },
  transferFee: { mode: 'rate', value: 0.00001 },
  tPlus1: true,
  allowShortByDefault: false
};

/**
 * @param {string} code 任意写法：rb2610 / RB0 / 600519 / sh000001
 * @returns {{ok:boolean, spec:Object, parsed:Object, warning?:string}}
 */
export function resolveTradeSpec(code) {
  const parsed = parseSymbol(code, '');
  if (!parsed.ok) return { ok: false, reason: parsed.reason || '无法解析代码', parsed };

  if (parsed.market === MARKETS.FUTURES) {
    const s = parsed.spec || FUTURES_SPECS[parsed.variety];
    if (!s) return { ok: false, reason: `品种 ${parsed.variety} 不在规格表内`, parsed };
    return {
      ok: true,
      parsed,
      spec: {
        name: s.name, market: 'futures', multiplier: s.multiplier, tick: s.tick,
        marginRate: s.marginRate ?? 0.1, fee: s.fee, closeTodayFee: s.closeTodayFee,
        limitPct: s.limitPct, confidence: s.confidence, allowShortByDefault: true, tPlus1: false
      }
    };
  }

  const isIndex = parsed.kind === 'index';
  const isEtf = parsed.kind === 'etf';
  return {
    ok: true,
    parsed,
    warning: isIndex ? '指数不可直接交易，回测结果只能当参考（实盘需走对应 ETF/股指期货）' : null,
    spec: {
      ...ASHARE_SPEC,
      name: parsed.code,
      market: 'ashare',
      kind: parsed.kind,
      limitPct: parsed.limitPct,
      // 指数/ETF 无印花税；ETF 实行 T+0 的只有跨境/债券等少数品种，这里保守按 T+1
      stampTax: (isIndex || isEtf) ? null : ASHARE_SPEC.stampTax
    }
  };
}

/** 手续费：支持「最低收费」，A股佣金最低 5 元就是靠它。 */
export function tradeCost(spec, price, qty, { sell = false, closeToday = false } = {}) {
  const plan = (closeToday && spec.closeTodayFee) ? spec.closeTodayFee : spec.fee;
  let fee = 0;
  if (plan) {
    const notional = price * spec.multiplier * qty;
    fee = plan.mode === 'rate' ? notional * plan.value : plan.value * qty;
    if (plan.min) fee = Math.max(fee, plan.min);
  }
  const notional = price * spec.multiplier * qty;
  if (sell && spec.stampTax) fee += notional * spec.stampTax.value;
  if (spec.transferFee) fee += notional * spec.transferFee.value;
  return Math.round(fee * 100) / 100;
}
