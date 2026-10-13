/**
 * 条件单（计划 M4 的基础设施）。
 *
 * 手动复盘和自动回测**必须共用这一份判定** —— 「一份成交逻辑，两种驱动」是这个项目的地基。
 * 如果各自写一套触发规则，同一段行情下人工复盘和策略回测会给出不同的出场点，
 * 而这个差异不会报错，只会让人以为自己复盘出来的手感"就是"策略的行为。
 *
 * 三条口径与回测内核完全一致，这里只列它们在本文件落在哪个函数：
 *   1. bar 高/低触碰即触发（不看收盘）
 *   2. 跳空越过时按开盘价成交，不按委托价 —— 按委托价记账会少记真实亏损
 *   3. 同一根内止损与止盈都可能触发时，先算止损（悲观优先）
 *
 * T+1 与涨跌停板锁不在这里判：那是市场规则的职权，由调用方（引擎）在拿到 hits 后过滤，
 * 否则条件单层就要重复实现一遍规则引擎，两边一旦漂移就出错。
 */

export const ORDER_KIND = { STOP: 'stop', TARGET: 'target', ADD: 'add' };

/** 只朝有利方向收紧：止损放松等于把已保住的利润交回去。 */
export function ratchetStop(currentStop, candidate, dir) {
  if (candidate === null || candidate === undefined) return currentStop ?? null;
  if (currentStop === null || currentStop === undefined) return candidate;
  return dir === 1 ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate);
}

/**
 * 把「百分比 / ATR 倍数 / 绝对价位」三种表述归一成绝对价。
 * 三种都要支持是因为：趋势交易者挂止损用结构位（绝对价），海龟式用 ATR，
 * 而风控口径统一的组合回测用百分比。写死成一种就会有人手算，手算就会算错。
 */
export function levelFrom({ price = null, pct = null, atrMult = null }, basePrice, atrValue, dir, side) {
  if (price !== null && price !== undefined && Number.isFinite(Number(price))) return Number(price);
  const below = (side === 'stop') === (dir === 1);   // 多头止损在下方、空头止损在上方；止盈反之
  const sign = below ? -1 : 1;
  if (pct !== null && pct !== undefined && Number.isFinite(Number(pct))) {
    return Number(basePrice) * (1 + sign * Math.abs(Number(pct)));
  }
  if (atrMult !== null && atrMult !== undefined && Number.isFinite(Number(atrMult)) && Number.isFinite(atrValue) && atrValue > 0) {
    return Number(basePrice) + sign * Math.abs(Number(atrMult)) * atrValue;
  }
  return null;
}

/**
 * 一键括号单（OCO）：开仓同时挂好止损与止盈。
 *
 * 止盈支持两种给法：直接给价/比例，或给盈亏比 rr（= 风险额 × rr），后者是交易者
 * 真正想要的东西 ——「我认这一档风险，回报至少要是它的 2.5 倍」。
 * 没有 rr 也没有 target 时返回纯止损单，调用方不该假装有个止盈。
 */
export function makeBracket({ entryPrice, dir, atr = null,
                              stopPrice, stopPct, stopAtr,
                              targetPrice, targetPct, targetAtr, rr = null,
                              trailPct = null, trailAtr = null, qty = null }) {
  const stop = levelFrom({ price: stopPrice, pct: stopPct, atrMult: stopAtr }, entryPrice, atr, dir, 'stop');
  if (stop === null) return { ok: false, reason: '括号单必须给出止损（价位 / 百分比 / ATR 倍数三选一）' };
  const risk = Math.abs(entryPrice - stop);
  if (!(risk > 0)) return { ok: false, reason: '止损价与开仓价重合，风险为 0' };

  let target = levelFrom({ price: targetPrice, pct: targetPct, atrMult: targetAtr }, entryPrice, atr, dir, 'target');
  if (target === null && Number.isFinite(Number(rr)) && Number(rr) > 0) {
    target = dir === 1 ? entryPrice + risk * Number(rr) : entryPrice - risk * Number(rr);
  }
  if (target !== null && !(dir === 1 ? target > entryPrice : target < entryPrice)) {
    return { ok: false, reason: '止盈价必须在盈利的方向上' };
  }

  const orders = [{ kind: ORDER_KIND.STOP, price: round(stop, dir), qty, label: '止损', triggered: false }];
  if (target !== null) orders.push({ kind: ORDER_KIND.TARGET, price: round(target, dir), qty, label: '止盈', triggered: false });
  const trail = levelFrom({ price: null, pct: trailPct, atrMult: trailAtr }, entryPrice, atr, dir, 'stop');
  // 必须是正数才算「要求了移动止损」：Number(null) 和 Number('') 都等于 0，
  // 只用 isFinite 判会把空值认成 0% 回撤，界面上凭空多出一条"移动止损 0.0%"。
  const tp = Number(trailPct), tt = Number(trailAtr);
  const hasTrail = (Number.isFinite(tp) && tp > 0) || (Number.isFinite(tt) && tt > 0);
  return {
    ok: true,
    risk,
    orders,
    // 键名与内核 _applyTrails 读的一致（pct / atr），两边叫法不同迟早读成 undefined
    trail: hasTrail ? { pct: Number.isFinite(tp) && tp > 0 ? tp : null, atr: Number.isFinite(tt) && tt > 0 ? tt : null } : null
  };
}

function round(v, dir) {
  return Math.round(v * 1e4) / 1e4;
}

/**
 * 单个委托在这根 bar 上的成交判定。
 * @returns {hit, price, gap} gap=true 表示开盘已越过委托价，按开盘成交
 */
export function fillPrice(order, bar, dir) {
  const isLong = dir === 1;
  if (order.kind === ORDER_KIND.STOP) {
    if (isLong ? bar.open <= order.price : bar.open >= order.price) return { hit: true, price: bar.open, gap: true };
    const touched = isLong ? bar.low <= order.price : bar.high >= order.price;
    return touched ? { hit: true, price: order.price, gap: false } : { hit: false };
  }
  if (order.kind === ORDER_KIND.TARGET) {
    if (isLong ? bar.open >= order.price : bar.open <= order.price) return { hit: true, price: bar.open, gap: true };
    const touched = isLong ? bar.high >= order.price : bar.low <= order.price;
    return touched ? { hit: true, price: order.price, gap: false } : { hit: false };
  }
  if (order.kind === ORDER_KIND.ADD) {
    // 加仓单顺着趋势方向突破才成交，同样开盘优先
    if (isLong ? bar.open >= order.price : bar.open <= order.price) return { hit: true, price: bar.open, gap: true };
    const touched = isLong ? bar.high >= order.price : bar.low <= order.price;
    return touched ? { hit: true, price: order.price, gap: false } : { hit: false };
  }
  return { hit: false };
}

/**
 * 一根 bar 上的出场单结算：先止损后止盈（悲观优先），同类多档全部成交。
 * 返回的 hits 按成交价对持仓不利的顺序排（多头从低到高）。
 */
/**
 * 止损/止盈单是**一次性**的：成交即消耗，下一根不会再来一遍。
 * 分批止盈时这一点尤其关键 —— 目标单只平了一半仓位，若不标记已成交，
 * 下一根开盘仍然高于目标价，同一张单会再平一次，等于把「止盈一半」悄悄变成「全部止盈」，
 * 而且报表上两笔都写着 target，看不出是被重复触发出场的。
 * qtyLots 归零即视为已消耗，不再参与判定。
 */
export function evalExitOrders(orders, bar, dir) {
  const live = (orders || []).filter(o => o && (o.kind === ORDER_KIND.STOP || o.kind === ORDER_KIND.TARGET)
    && (o.qtyLots === undefined || o.qtyLots === null || o.qtyLots > 0));
  const stops = [], targets = [];
  for (const o of live) {
    const f = fillPrice(o, bar, dir);
    if (!f.hit) continue;
    (o.kind === ORDER_KIND.STOP ? stops : targets).push({ order: o, price: f.price, gap: f.gap, kind: o.kind });
  }
  const picked = stops.length ? stops : targets;
  picked.sort((a, b) => (dir === 1 ? a.price - b.price : b.price - a.price));
  return { hits: picked, reason: stops.length ? 'stop' : 'target', anyHit: picked.length > 0 };
}

/** 突破方向的加仓单结算（与出场单分开判：一根 bar 里既触止损又触加仓时，止损优先）。 */
export function evalAddOrders(orders, bar, dir) {
  const out = [];
  for (const o of (orders || []).filter(x => x && x.kind === ORDER_KIND.ADD)) {
    const f = fillPrice(o, bar, dir);
    if (f.hit) out.push({ order: o, price: f.price, gap: f.gap, kind: o.kind });
  }
  return out;
}

/**
 * 金字塔加仓的规模序列：每一笔都比首仓小，且逐次递减（海龟式）。
 * 从 decay 起而不是从 1 起是有意的是因为：加仓与首仓等价时，两次加仓就能把
 * 平均成本推到接近现价，一个正常回调就把整段浮盈打回亏损 —— 那不是金字塔，是加倍下注。
 * @returns {number[]} 相对首仓手数的权重
 */
export function pyramidScales(maxAdds, decay = 0.5) {
  const out = [];
  let w = 1;
  for (let i = 0; i < Math.max(0, maxAdds); i++) { w *= decay; out.push(w); }
  return out;
}
