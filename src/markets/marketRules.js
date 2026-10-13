/**
 * 市场规则引擎（计划 M2）。
 *
 * 为什么必须有它：上一版回测在 A股上把「涨停买不进、跌停卖不出、当天买的不能卖」
 * 全当成可以自由成交，于是跑出一个现实中不可能实现的成绩。这类错误不会报错，
 * 只会让数字变好看 —— 是最危险的一种 bug。
 *
 * 规则接口对齐演进计划 §2 的 MarketRules：
 *   lotSize / priceTick / costModel / canOpen / canFillAt / isSuspended / tPlus1 / marginPolicy
 */

import { ASHARE_SPEC } from './instrumentSpec.js';

/** 引擎用数字 DIR(1/-1/0)，规则层用字符串 'long'/'short'：两种都吃，
 *  否则 canOpen(1) 会被当成做空而把所有多头开仓全拒掉。 */
const normDir = (d) => (d === 1 || d === 'long' || d === DIR_LONG ? 'long' : 'short');
const DIR_LONG = 1;

/** 涨跌停判定容差：价格经过复权/拼接后会有浮点尾巴，严格 === 会漏判。 */
const LIMIT_EPS = 1e-6;

export class MarketRules {
  constructor() {}
  get name() { return 'generic'; }
  lotSize() { return 1; }
  priceTick() { return 0.01; }
  /** 该方向是否允许开仓（A股默认仅做多）。 */
  canOpen(dir) { return normDir(dir) === 'long' ? { ok: true } : { ok: false, reason: '该品种不允许做空' }; }
  /** 委托能否成交：板锁判定。 */
  canFillAt() { return { ok: true }; }
  isSuspended() { return false; }
  get tPlus1() { return false; }
  /** 手数取整口径。 */
  normalizeQty(qty) { return Math.max(1, Math.floor(qty)); }
  cost() { return 0; }
}

export class FuturesRules extends MarketRules {
  constructor(spec) { super(); this.spec = spec; }
  get name() { return 'futures'; }
  lotSize() { return 1; }
  priceTick() { return this.spec.tick || 1; }
  canOpen() { return { ok: true }; }
  get tPlus1() { return false; }

  /**
   * 涨跌停板锁：封涨停时不成交买入开仓/卖出平仓之外的“买”方向，
   * 但**平仓始终允许**（涨停板上多头是可以走的，走的是买单排队）。
   * 口径：side=buy 且价格已触及涨停 → 买单排队买不到；side=sell 且触及跌停 → 卖单排队卖不掉。
   */
  canFillAt(side, price, prevClose, { closing = false } = {}) {
    const lim = this.spec.limitPct;
    if (!lim || !prevClose) return { ok: true };
    const up = roundTick(prevClose * (1 + lim), this.priceTick());
    const dn = roundTick(prevClose * (1 - lim), this.priceTick());
    if (!closing && side === 'buy' && price >= up - LIMIT_EPS) {
      return { ok: false, reason: '涨停封板，买单纯价排队买不到', limit: 'up' };
    }
    if (!closing && side === 'sell' && price <= dn + LIMIT_EPS) {
      return { ok: false, reason: '跌停封板，卖单纯价排队卖不掉', limit: 'down' };
    }
    return { ok: true };
  }

  cost(price, qty, { sell = false, closeToday = false } = {}) {
    return futuresCost(this.spec, price, qty, { sell, closeToday });
  }
}

export class AShareRules extends MarketRules {
  constructor(spec) { super(); this.spec = { ...ASHARE_SPEC, ...spec }; }
  get name() { return 'ashare'; }
  lotSize() { return 100; }
  priceTick() { return this.spec.tick || 0.01; }
  get tPlus1() { return true; }

  /** 买入必须整手；卖出允许零股一次性清仓（国内规则如此）。 */
  normalizeQty(qty, { sell = false } = {}) {
    if (sell) return Math.max(0, Math.floor(qty));
    return Math.max(100, Math.floor(qty / 100) * 100);
  }

  canOpen(dir) {
    if (normDir(dir) === 'long') return { ok: true };
    return this.spec.allowShort
      ? { ok: true }
      : { ok: false, reason: 'A股默认仅做多（两融做空未开启）' };
  }

  /**
   * 板锁：主板 ±10%、创业/科创 ±20%、ST ±5%、北交所 ±30%。
   * 关键点：**平仓方向永远允许**（涨停时多头能卖，跌停时空头能买回），
   * 只有开仓/加仓那个方向会被封死。
   */
  canFillAt(side, price, prevClose, { closing = false } = {}) {
    const lim = this.spec.limitPct ?? 0.10;
    if (!prevClose) return { ok: true };
    const up = roundTick(prevClose * (1 + lim), this.priceTick());
    const dn = roundTick(prevClose * (1 - lim), this.priceTick());
    if (!closing && side === 'buy' && price >= up - LIMIT_EPS) {
      return { ok: false, reason: `涨停封板(${(lim * 100).toFixed(0)}%)，买不进`, limit: 'up' };
    }
    if (!closing && side === 'sell' && price <= dn + LIMIT_EPS) {
      return { ok: false, reason: `跌停封板(${(lim * 100).toFixed(0)}%)，卖不出`, limit: 'down' };
    }
    return { ok: true };
  }

  cost(price, qty, { sell = false, closeToday = false } = {}) {
    return aShareCost(this.spec, price, qty, { sell });
  }
}

function roundTick(v, tick) {
  if (!tick || tick <= 0) return v;
  const dec = (String(tick).split('.')[1] || '').length;
  return Number((Math.round(v / tick) * tick).toFixed(dec));
}

export function futuresCost(spec, price, qty, { closeToday = false } = {}) {
  const plan = (closeToday && spec.closeTodayFee) ? spec.closeTodayFee : spec.fee;
  if (!plan) return 0;
  const raw = plan.mode === 'rate' ? price * spec.multiplier * qty * plan.value : plan.value * qty;
  return Math.round(raw * 100) / 100;
}

/** A股成本：佣金万2.5 最低 5 元 + 卖出印花税 0.05% + 过户费 0.001%（双向）。 */
export function aShareCost(spec, price, qty, { sell = false } = {}) {
  const notional = price * spec.multiplier * qty;
  let fee = 0;
  if (spec.fee) {
    fee = spec.fee.mode === 'rate' ? notional * spec.fee.value : spec.fee.value * qty;
    if (spec.fee.min) fee = Math.max(fee, spec.fee.min);
  }
  if (sell && spec.stampTax) fee += notional * spec.stampTax.value;
  if (spec.transferFee) fee += notional * spec.transferFee.value;
  return Math.round(fee * 100) / 100;
}

/** 按品种选规则。 */
export function rulesFor(spec) {
  if (spec.market === 'futures') return new FuturesRules(spec);
  if (spec.market === 'ashare') return new AShareRules(spec);
  return new MarketRules(spec);
}
