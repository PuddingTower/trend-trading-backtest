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

/**
 * 板幅流动性的物理口径 —— **开仓与平仓在这里没有任何区别**。
 *
 * 旧实现给平仓开了「永远放行」的后门，等于假设跌停板上永远有人接你的卖单。
 * 真实情况是：封死的跌停板上排的是卖队、买单稀缺，所以想卖就是卖不掉；
 * 封死的涨停板上排的是买队，手里多头的卖单反而秒成交。
 * 约束只看**方向**，不看你是开仓还是在平仓。趋势策略的止损恰好大量打在跌停附近，
 * 这条后门会让回测系统性偏乐观 —— 而且乐观在最关键的那几笔上。
 *
 * 盘中破板说明对手盘出现过，排队单能成交；钉在板上才叫真封死。所以判定用的锚定价
 * **必须与成交路径一致**：开盘成交看开盘价，盘中触碰成交看那一侧的极值 ——
 * 拿收盘价去决定这根开盘能不能成交，本身又是一次前视。
 * sealRef 省略时按「封死」处理，这样既有调用方（不传锚定价）的行为不被顺带改掉。
 */
function boardLiquidity(side, price, up, dn, { closing = false, sealRef = null } = {}) {
  const ref = Number.isFinite(sealRef) ? sealRef : null;
  const sealedUp = ref === null ? true : ref >= up - LIMIT_EPS;
  const sealedDn = ref === null ? true : ref <= dn + LIMIT_EPS;
  const who = closing ? '平仓' : '开仓';
  if (side === 'buy' && price >= up - LIMIT_EPS && sealedUp) {
    return { ok: false, limit: 'up', sealed: true, reason: `${who}买入遇涨停封死(${up})，买单排队买不到` };
  }
  if (side === 'sell' && price <= dn + LIMIT_EPS && sealedDn) {
    return { ok: false, limit: 'down', sealed: true, reason: `${who}卖出遇跌停封死(${dn})，卖单排队卖不掉` };
  }
  return { ok: true };
}

export class MarketRules {
  constructor() {}
  get name() { return 'generic'; }
  lotSize() { return 1; }
  priceTick() { return 0.01; }
  /** 该方向是否允许开仓（A股默认仅做多）。 */
  canOpen(dir) { return normDir(dir) === 'long' ? { ok: true } : { ok: false, reason: '该品种不允许做空' }; }
  /** 委托能否成交：板锁判定。opts {closing, bar} —— bar 用来区分"一字封到收盘"与"盘中破板"。 */
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
   * 涨跌停板锁。口径见 boardLiquidity：只看委托方向对着哪一堵墙，开仓平仓一视同仁。
   */
  canFillAt(side, price, prevClose, { closing = false, sealRef = null } = {}) {
    const lim = this.spec.limitPct;
    if (!lim || !prevClose) return { ok: true };
    const up = roundTick(prevClose * (1 + lim), this.priceTick());
    const dn = roundTick(prevClose * (1 - lim), this.priceTick());
    return boardLiquidity(side, price, up, dn, { closing, sealRef });
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
   * 与期货同一条物理口径（见 boardLiquidity）：**封死的板上，平仓方向照样成交不了**。
   * 涨停时多头能卖（买单排队等着接），跌停时空头能买回（卖单排队等着出）；
   * 反过来就都卡在队尾 —— 这跟开仓还是平仓无关，只跟委托方向对着哪堵墙有关。
   */
  canFillAt(side, price, prevClose, { closing = false, sealRef = null } = {}) {
    const lim = this.spec.limitPct ?? 0.10;
    if (!prevClose) return { ok: true };
    const up = roundTick(prevClose * (1 + lim), this.priceTick());
    const dn = roundTick(prevClose * (1 - lim), this.priceTick());
    return boardLiquidity(side, price, up, dn, { closing, sealRef });
  }

  cost(price, qty, { sell = false, closeToday = false } = {}) {
    return aShareCost(this.spec, price, qty, { sell });
  }
}

export function roundTick(v, tick) {
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
