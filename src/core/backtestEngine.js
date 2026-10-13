/**
 * 事件驱动回测内核。
 *
 * 三条防自欺规矩（这三条决定回测数字是不是垃圾）：
 * 1. **信号在第 i 根产生，成交在第 i+1 根开盘**。用收盘价决策又在同一根收盘成交，
 *    等于假设你在收盘前一瞬就知道了收盘价 —— 趋势策略会因此虚高一大截。
 * 2. **跳空穿透按开盘成交**，不按止损价。夜盘品种隔天低开 3% 时，你的 1% 止损
 *    实际成交在 -3%，按 1% 记账是在骗自己。
 * 3. **同一根内止损与止盈都可能触发时，先算止损**（悲观优先）。
 *
 * 与手动复盘的关系：这里只做撮合与账目，规则/成本由注入的 spec 决定，
 * 所以同一份成本口径既能被自动回测用，也能被手动复盘用（演进计划 §2「一份成交逻辑，两种驱动」）。
 *
 * 条件单（止损/止盈/移动止损/括号单/部分平仓/金字塔加仓）的触发判定在 core/orders.js，
 * 本文件与手动复盘引擎调的是同一个函数 —— 不重复实现一遍，否则两边迟早漂移。
 */

import { ORDER_KIND, ratchetStop, evalExitOrders, evalAddOrders, makeBracket, pyramidScales } from './orders.js';

export const DIR = { FLAT: 0, LONG: 1, SHORT: -1 };

export class BacktestEngine {
  /**
   * @param {Array} bars 升序 K线
   * @param {Object} spec 合约规格：{multiplier, tick, fee, closeTodayFee, marginRate}
   * @param {Object} opts {capital, lots, slippageTicks, allowShort, entryBarOffset}
   */
  constructor(bars, spec, opts = {}) {
    this.bars = bars;
    this.spec = spec;
    this.capital0 = opts.capital ?? 100000;
    this.lots = Math.max(1, opts.lots ?? 1);
    this.slippageTicks = opts.slippageTicks ?? 0;
    this.allowShort = opts.allowShort ?? true;
    /**
     * 手数口径。固定 1 手会让不同品种的名义敞差上数量级（510300 一手约 400 元，
     * 股指期货一手名义上百万），横比等于在比“谁的价格高”，不是比策略。
     *   fixed    —— 恒为 lots（做单品种深挖时用）
     *   notional —— 每笔投入的保证金≈权益的 notionalPct，跨品种可比
     */
    this.sizing = opts.sizing ?? 'fixed';
    this.notionalPct = opts.notionalPct ?? 0.25;
    /**
     * 市场规则（M2）。不传就退回引擎内置的期货口径，保证已有跑批不受影响。
     * 传了之后：开仓方向限制、涨跌停板锁、T+1、成本模型全部交给规则决定。
     */
    this.rules = opts.rules || null;
    /**
     * 金字塔加仓（M4）：{ maxAdds, stepPct, decay }
     * 开仓时按 stepPct 铺出若干突破加仓单，每笔规模按 decay 递减。
     * 不等额递增加仓会把平均成本推到接近现价，一个正常回调就能把整段浮盈打成亏损。
     */
    this.pyramid = opts.pyramid && opts.pyramid.maxAdds > 0 ? { stepPct: 0.02, decay: 0.5, ...opts.pyramid } : null;
    this.trades = [];
    this.rejects = [];
    this.equityCurve = [];
    this.rejected = { margin: 0, noLiquidity: 0, shortDisabled: 0 };
  }

  _fee(price, lots, { closeToday = false, side = 'buy', sell = false } = {}) {
    if (this.rules) return this.rules.cost(price, lots, { closeToday, sell: sell || side === 'sell' });
    const plan = closeToday && this.spec.closeTodayFee ? this.spec.closeTodayFee : this.spec.fee;
    if (!plan) return 0;
    const raw = plan.mode === 'rate' ? price * this.spec.multiplier * lots * plan.value : plan.value * lots;
    return Math.round(raw * 100) / 100;
  }

  /** 滑点：往不利方向偏移。 */
  _slip(price, dir) {
    const t = this.spec.tick || 1;
    const steps = this.slippageTicks * t;
    const p = dir === 'buy' ? price + steps : price - steps;
    const dec = String(t).includes('.') ? (String(t).split('.')[1] || '').length : 0;
    return Number(p.toFixed(dec));
  }

  /**
   * @param {Array<Object>} signals 与 bars 等长；每项 {dir, stop?, target?, trail?, reason?}
   *        dir: 1 多 / -1 空 / 0 平仓观望。stop 是「价格」，trail 是「跟随收紧」的候选价。
   */
  run(signals) {
    const { bars } = this;
    if (!signals || signals.length !== bars.length) throw new Error('signals 必须与 bars 等长');

    let cash = this.capital0;
    let pos = null;       // {dir, lots, entryPrice, entryIdx, entryDate, margin, feePaid, stop, target, trail, reason, orders}
    let peak = -Infinity, trough = Infinity;
    let pendingTrail = null;   // 上一根信号给出的移动止损候选位，本根开盘后才生效

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];

      // ---- 0. 逐日盯市强平：权益跌破维持保证金就必须先平仓，再谈别的 ----
      // 没有这一步，杠杆品种回测会出现「权益为负」的荒谬结果 —— 现金可以无限亏，
      // 而真实账户在保证金不足时已被强平。这是 M2 规则引擎的正式课题，这里先立一道底线。
      if (pos && i > pos.entryIdx) {
        const prevEq = this.equityCurve.length ? this.equityCurve[this.equityCurve.length - 1].equity : this.capital0;
        if (prevEq <= pos.margin * (this.maintenanceRatio ?? 0.5)) {
          const px = this._slip(bar.open, pos.dir === DIR.LONG ? 'sell' : 'buy');
          cash = this._closePosition(pos, px, i, 'margin_call', cash);
          pos = null;
          this.rejected.marginCalls = (this.rejected.marginCalls || 0) + 1;
        }
      }

      // ---- 1. 出场与加仓（用当前 bar 的 high/low 判定，成交价保守取） ----
      // 移动止损先按「上一根信号给出的候选位」收紧，再判触发。
      // 原实现只在开仓时取一次 sig.trail，之后再也不更新 —— 吊灯止损实际上根本不动，
      // 回测里那条「移动止损」是个装饰品。
      if (pos) {
        this._applyTrails(pos, peak, trough);
        if (pendingTrail !== null) {
          pos.stop = ratchetStop(pos.stop ?? null, pendingTrail, pos.dir);
        }
        pendingTrail = null;
        this._syncStopOrder(pos);

        const exit = this._checkExit(pos, bar, i);
        if (exit) {
          cash = this._settleExit(pos, exit, cash);
          if (!pos.lots) pos = null;
        } else {
          cash = this._settleAdds(pos, bar, i, cash);   // 出场优先：同一根里触了止损就不再看加仓
        }
      }

      // ---- 2. 信号在 i 根产生，委托固定在第 i+1 根的开盘成交 ----
      // 不提供「当根成交」开关：那个口径等于用未来信息，留着就有人会去拧。
      const sig = signals[i];
      const fillIdx = i + 1;
      // 移动止损的候选位跟着信号走：第 i 根算出的值只在第 i+1 根生效，
      // 与「信号在 i、成交在 i+1」同一条时间轴，否则就是用本根最高点给本根的止损定价。
      if (sig && sig.trail !== undefined && sig.trail !== null) pendingTrail = sig.trail;
      if (sig && fillIdx < bars.length) {
        const wantDir = sig.dir ?? 0;
        const curDir = pos ? pos.dir : DIR.FLAT;

        if (curDir !== DIR.FLAT && wantDir !== curDir) {
          // 反手/平仓：在下一根开盘平掉
          const fb = bars[fillIdx];
          const px = this._slip(fb.open, pos.dir === DIR.LONG ? 'sell' : 'buy');
          cash = this._closePosition(pos, px, fillIdx, wantDir === DIR.FLAT ? 'signal_close' : 'signal_reverse', cash);
          pos = null;
        }

        if (wantDir !== DIR.FLAT && !pos) {
          if (wantDir === DIR.SHORT && !this.allowShort) {
            this.rejected.shortDisabled++;
          } else {
            const fb = bars[fillIdx];
            const side = wantDir === DIR.LONG ? 'buy' : 'sell';
            const px = this._slip(fb.open, side);
            const prevClose = bars[fillIdx - 1]?.close;

            // 规则闸门一：该方向能不能开（A股默认仅做多）
            const openGate = this.rules ? this.rules.canOpen(wantDir) : { ok: true };
            if (!openGate.ok) {
              this.rejected.rules = (this.rejected.rules || 0) + 1;
              this.rejects.push({ idx: fillIdx, kind: 'open', reason: openGate.reason });
            }
            // 规则闸门二：涨跌停板锁（封板时开单价排队成交不了）
            const fillGate = openGate.ok && this.rules
              ? this.rules.canFillAt(side, px, prevClose, { closing: false }) : { ok: true };
            if (openGate.ok && !fillGate.ok) {
              this.rejected.boardLock = (this.rejected.boardLock || 0) + 1;
              this.rejects.push({ idx: fillIdx, kind: 'boardLock', reason: fillGate.reason });
            }
            if (openGate.ok && fillGate.ok) {
            const marginRate = this.spec.marginRate ?? 0.1;
            const perLotMargin = px * this.spec.multiplier * marginRate;
            const lots = this.sizing === 'notional'
              ? Math.max(1, Math.floor((this._equity(cash, pos, fb.open) * this.notionalPct) / (perLotMargin || Infinity)))
              : this.lots;
            const margin = perLotMargin * lots;
            const fee = this._fee(px, lots, {});
            if (cash - margin - fee < 0) {
              this.rejected.margin++;          // 资金不足就不开仓，而不是强行开进去
            } else {
              cash -= (margin + fee);
              pos = {
                dir: wantDir, lots, entryPrice: px, entryIdx: fillIdx, entryDate: fb.date,
                margin, feePaid: fee, stop: sig.stop ?? null, target: sig.target ?? null,
                trail: sig.trail ?? null, reason: sig.reason || 'signal', openBarIdx: i,
                orders: this._buildOrders(sig, wantDir, px, lots),
                addCount: 0
              };
              peak = wantDir === DIR.LONG ? fb.high : Infinity;
              trough = wantDir === DIR.LONG ? -Infinity : fb.low;
            }
            }
          }
        }
      }

      if (pos) {
        peak = Math.max(peak, bar.high);
        trough = Math.min(trough, bar.low);
      }

      // ---- 3. 逐 bar 盯市权益 ----
      const float = pos ? this._floating(pos, bar) : 0;
      const equity = cash + (pos ? pos.margin : 0) + float;
      this.equityCurve.push({ idx: i, date: bar.date, equity, cash, floating: float, inPosition: !!pos, dir: pos ? pos.dir : 0 });
    }

    // 收尾：末根收盘强平，避免最后一笔浮盈被当成已实现收益
    if (pos) {
      const last = bars[bars.length - 1];
      this._closePosition(pos, last.close, bars.length - 1, 'end_of_data', this.equityCurve[this.equityCurve.length - 1].cash);
    }
    return this.result();
  }

  /**
   * 结算一根 bar 上的出场单。分批止盈时只平命中的那部分手数，
   * 剩下的继续持仓跑止损 —— 「到目标就走人」和「到目标减一半、留一半吃趋势」是两种策略，
   * 只有部分平仓能把后者表达出来。
   */
  _settleExit(pos, exit, cash) {
    for (const h of exit.hits) {
      if (!pos.lots) break;
      const px = this._slip(h.price, pos.dir === DIR.LONG ? 'sell' : 'buy');
      const lotsToClose = Math.min(pos.lots, h.order.qtyLots ?? pos.lots);
      cash = this._closePosition(pos, px, exit.idx, h.gap ? `gap_${h.kind}` : h.kind, cash, lotsToClose);
      h.order.qtyLots = 0;                       // 一次性委托：成交过就作废，下一根不再重复触发
      for (const other of (pos.orders || [])) {
        if (other !== h.order && other.qtyLots > 0 && other.qtyLots > pos.lots) other.qtyLots = pos.lots;
      }
    }
    return cash;
  }

  /**
   * 金字塔加仓：突破加仓单成交后，平均成本按手数加权，保证金与手续费逐笔累加。
   * 加不进去就记一条 reject —— 资金不足/板锁挡住是常态，静默跳过会让"加满3次"的回测
   * 和实际发生的次数对不上。
   */
  _settleAdds(pos, bar, idx, cash) {
    if (!pos.orders || !pos.orders.some(o => o.kind === ORDER_KIND.ADD)) return cash;
    if (idx <= pos.entryIdx) return cash;
    const adds = evalAddOrders(pos.orders, bar, pos.dir);
    for (const a of adds) {
      if (this.pyramid && (pos.addCount || 0) >= this.pyramid.maxAdds) break;
      if (this.rules?.tPlus1 && String(bar.date).slice(0, 10) === String(this.bars[pos.entryIdx].date).slice(0, 10)) {
        this.rejects.push({ idx, kind: 'tPlus1', reason: 'T+1：当日买入不可当日加仓' });
        break;
      }
      const px = this._slip(a.price, pos.dir === DIR.LONG ? 'buy' : 'sell');
      const prevClose = idx > 0 ? this.bars[idx - 1].close : null;
      const side = pos.dir === DIR.LONG ? 'buy' : 'sell';
      const gate = this.rules ? this.rules.canFillAt(side, px, prevClose, { closing: false }) : { ok: true };
      if (!gate.ok) {
        this.rejected.boardLock = (this.rejected.boardLock || 0) + 1;
        this.rejects.push({ idx, kind: 'boardLock', reason: gate.reason });
        continue;
      }
      const lots = Math.max(1, Math.round(a.order.qtyLots ?? 1));
      const marginRate = this.spec.marginRate ?? 0.1;
      const addMargin = px * this.spec.multiplier * marginRate * lots;
      const fee = this._fee(px, lots, {});
      if (cash - addMargin - fee < 0) { this.rejected.margin++; continue; }

      cash -= (addMargin + fee);
      const total = pos.lots + lots;
      pos.entryPrice = Math.round(((pos.entryPrice * pos.lots + px * lots) / total) * 1e6) / 1e6;
      pos.lots = total;
      pos.margin += addMargin;
      pos.feePaid += fee;
      pos.addCount = (pos.addCount || 0) + 1;
      // 加仓把平均成本推高了，止损不动就等于风险被放大；同步抬一条新的止损单并把已加的仓位纳入保护
      for (const o of pos.orders) if (o.kind === ORDER_KIND.STOP || o.kind === ORDER_KIND.TARGET) o.qtyLots = pos.lots;
      a.order.qtyLots = 0;
      this.adds = (this.adds || 0) + 1;
    }
    return cash;
  }

  _floating(pos, bar) {
    const diff = pos.dir === DIR.LONG ? bar.close - pos.entryPrice : pos.entryPrice - bar.close;
    return diff * this.spec.multiplier * pos.lots;
  }

  /** 当前总权益 = 现金 + 占用保证金 + 浮动盈亏（用给定价格盯市）。 */
  _equity(cash, pos, price) {
    if (!pos) return cash;
    const diff = pos.dir === DIR.LONG ? price - pos.entryPrice : pos.entryPrice - price;
    return cash + pos.margin + diff * this.spec.multiplier * pos.lots;
  }

  /**
   * 把信号里的出场意图翻成条件单。
   *
   * sig.orders（core/orders 的 makeBracket 产物）优先，否则由 sig.stop / sig.target 合成。
   * 两者同时给时只认 sig.orders —— 括号单的止盈可能是按盈亏比算出来的，
   * 再叠一条 sig.target 就会有两单并存、先成交哪条取决于遍历顺序的歧义。
   *
   * takeProfitFraction 支持分批止盈：到目标只平这一部分，剩下的带着止损继续跑。
   */
  _buildOrders(sig, dir, entryPrice, lots) {
    const orders = [];
    if (Array.isArray(sig.orders) && sig.orders.length) {
      for (const o of sig.orders) {
        orders.push({
          kind: o.kind, price: o.price, label: o.label || o.kind,
          qtyLots: (o.qty === null || o.qty === undefined) ? lots : Math.max(1, Math.min(lots, Math.round(o.qty)))
        });
      }
    } else {
      if (sig.stop !== null && sig.stop !== undefined) orders.push({ kind: ORDER_KIND.STOP, price: sig.stop, qtyLots: lots, label: '止损' });
      if (sig.target !== null && sig.target !== undefined) {
        const frac = Number(sig.takeProfitFraction);
        const qty = Number.isFinite(frac) && frac > 0 && frac < 1
          ? Math.max(1, Math.min(lots - 1, Math.floor(lots * frac))) : lots;
        orders.push({ kind: ORDER_KIND.TARGET, price: sig.target, qtyLots: qty, label: '止盈' });
      }
    }
    // 策略给的吊灯止损候选位（价格）转成一条可ratchet的移动止损
    if (sig.trail !== null && sig.trail !== undefined) orders.trailPrice = sig.trail;
    if (sig.trailPct || sig.trailAtr) orders.trailCfg = { pct: sig.trailPct, atr: sig.trailAtr };

    if (this.pyramid) {
      const scales = pyramidScales(this.pyramid.maxAdds, this.pyramid.decay);
      scales.forEach((w, k) => {
        const off = this.pyramid.stepPct * (k + 1);
        orders.push({
          kind: ORDER_KIND.ADD,
          price: Math.round((dir === DIR.LONG ? entryPrice * (1 + off) : entryPrice * (1 - off)) * 1e4) / 1e4,
          qtyLots: Math.max(1, Math.floor(lots * w)),
          label: `加仓${k + 1}`
        });
      });
    }
    return orders;
  }

  /**
   * 移动止损的收紧：只用「截至上一根」的极值，不用本根 ——
   * 拿本根最高价抬止损、又在同一根判触发，等于假设盘中你永远在最有利的那一下按了按钮。
   * 同时同步 pos.stop（老字段）与 STOP 单的价格（新路径），两条读法不能给两个数。
   */
  _applyTrails(pos, peak, trough, atrValue) {
    const orders = pos.orders || [];
    const cfg = orders.trailCfg || null;
    let candidate = orders.trailPrice ?? null;
    if (cfg) {
      const base = pos.dir === DIR.LONG ? peak : trough;
      if (Number.isFinite(Number(cfg.pct)) && Number(cfg.pct) > 0 && Number.isFinite(base)) {
        candidate = pos.dir === DIR.LONG ? base * (1 - Number(cfg.pct)) : base * (1 + Number(cfg.pct));
      } else if (Number.isFinite(Number(cfg.atr)) && Number(cfg.atr) > 0 && Number.isFinite(atrValue) && atrValue > 0) {
        candidate = pos.dir === DIR.LONG ? peak - Number(cfg.atr) * atrValue : trough + Number(cfg.atr) * atrValue;
      }
    }
    if (candidate === null) return;
    pos.stop = (pos.stop === null || pos.stop === undefined) ? candidate : ratchetStop(pos.stop, candidate, pos.dir);
    this._syncStopOrder(pos);
  }

  /**
   * pos.stop 与 STOP 条件单必须亦步亦趋。
   * 只给 trail 不给 stop 的策略（MACD 趋势、HH/LL 结构）本来没有止损单，
   * 止损位是靠移动止损候选价推出来的 —— 不同步就会出现最坏的一种错：
   * 止损价每天都在动、报表也写着有止损，实际上永远不会触发。
   */
  _syncStopOrder(pos) {
    if (pos.stop === null || pos.stop === undefined) return;
    const orders = pos.orders || (pos.orders = []);
    const hit = orders.find(o => o.kind === ORDER_KIND.STOP);
    if (hit) hit.price = pos.stop;
    else orders.push({ kind: ORDER_KIND.STOP, price: pos.stop, qtyLots: pos.lots, label: '移动止损' });
  }

  /**
   * 止损/止盈判定。走 core/orders 的同一套规则（触碰即触发、跳空按开盘、止损优先），
   * 手动复盘那边调的是同一个 evalExitOrders。
   */
  _checkExit(pos, bar, idx) {
    if (idx <= pos.entryIdx) return null;   // 成交那根不再判出场，避免同一根进出

    // T+1：当日买入的股票当日不能卖。不满足就作废这笔出场，而不是假装成交 ——
    // 后者正是让 A股回测虚高的原因。
    // 只比日期部分：日内 bar 的 date 带时分秒，整串比较会让这条规则永远不触发。
    if (this.rules?.tPlus1 &&
        String(bar.date).slice(0, 10) === String(this.bars[pos.entryIdx].date).slice(0, 10)) {
      this.rejects.push({ idx, kind: 'tPlus1', reason: 'T+1：当日买入不可当日卖出' });
      return null;
    }

    const { hits, anyHit } = evalExitOrders(pos.orders && pos.orders.length
      ? pos.orders
      : this._legacyOrders(pos), bar, pos.dir);
    if (!anyHit) return null;
    return { hits, idx };
  }

  /** 没有条件单的老口径持仓（stop/target 两个字段）——保证已有跑批与测试行为不变。 */
  _legacyOrders(pos) {
    const out = [];
    if (pos.stop !== null && pos.stop !== undefined) out.push({ kind: ORDER_KIND.STOP, price: pos.stop, qtyLots: pos.lots, label: '止损' });
    if (pos.target !== null && pos.target !== undefined) out.push({ kind: ORDER_KIND.TARGET, price: pos.target, qtyLots: pos.lots, label: '止盈' });
    return out;
  }

  /**
   * 平仓。lotsToClose 省略或等于持仓手数时是全平；小于就是分批止盈的那一半。
   * 保证金按比例释放、手续费按本次手数算、盈亏按本次手数算 —— 三处口径必须同批，
   * 否则部分平仓会把成本基础算歪，后半段的盈亏全是错的。
   */
  _closePosition(pos, price, idx, reason, cash, lotsToClose = null) {
    const closing = lotsToClose === null ? pos.lots : Math.max(1, Math.min(pos.lots, Math.round(lotsToClose)));
    const beforeLots = pos.lots;
    const frac = closing / pos.lots;
    const marginReleased = pos.margin * frac;
    const gross = (pos.dir === DIR.LONG ? price - pos.entryPrice : pos.entryPrice - price) * this.spec.multiplier * closing;
    const sameDay = idx === pos.entryIdx;
    const exitFee = this._fee(price, closing, { closeToday: sameDay });
    // 建仓时已按整笔手数扣过的开仓费，这里只按比例摊到本次平仓上，避免部分平仓重复扣。
    const entryFeeShare = pos.feePaid * frac;
    const net = gross - entryFeeShare - exitFee;
    cash += marginReleased + gross - exitFee;
    pos.lots -= closing;
    pos.margin = Math.round((pos.margin - marginReleased) * 100) / 100;
    pos.feePaid = Math.round((pos.feePaid - entryFeeShare) * 100) / 100;
    if (pos.lots <= 0) { pos.lots = 0; pos.margin = 0; pos.feePaid = 0; }
    this.trades.push({
      id: this.trades.length + 1,
      dir: pos.dir === DIR.LONG ? 'long' : 'short',
      entryIdx: pos.entryIdx, entryDate: pos.entryDate, entryPrice: pos.entryPrice,
      exitIdx: idx, exitDate: this.bars[idx].date, exitPrice: price,
      lots: closing, gross: Math.round(gross * 100) / 100,
      fee: Math.round((entryFeeShare + exitFee) * 100) / 100,
      netPnL: Math.round(net * 100) / 100,
      points: Math.round((pos.dir === DIR.LONG ? price - pos.entryPrice : pos.entryPrice - price) * 1e4) / 1e4,
      pct: Math.round((pos.dir === DIR.LONG ? (price - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - price) / pos.entryPrice) * 1e6) / 1e4,
      holdingBars: idx - pos.entryIdx,
      entryReason: pos.reason, exitReason: reason,
      partial: closing < beforeLots ? true : undefined,
      equityAfter: Math.round(cash * 100) / 100
    });
    return cash;
  }

  result() {
    return {
      trades: this.trades,
      equityCurve: this.equityCurve,
      rejected: { ...this.rejected },
      rejects: this.rejects.slice(),
      finalEquity: this.equityCurve.length ? this.equityCurve[this.equityCurve.length - 1].equity : this.capital0,
      capital: this.capital0,
      spec: { multiplier: this.spec.multiplier, tick: this.spec.tick, marginRate: this.spec.marginRate }
    };
  }
}

/** 买入持有基准（报表对比用）：首根开盘进场，逐根收盘盯市，不计手续费。 */
export function buyHold(bars, spec, capital = 100000, lots = 1) {
  const entry = bars[0].open;
  return bars.map((b, i) => ({
    idx: i, date: b.date,
    equity: capital + (b.close - entry) * spec.multiplier * lots,
    cash: capital, floating: (b.close - entry) * spec.multiplier * lots,
    inPosition: true, dir: 1
  }));
}
