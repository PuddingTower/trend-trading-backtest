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
 */

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
    this.trades = [];
    this.equityCurve = [];
    this.rejected = { margin: 0, noLiquidity: 0, shortDisabled: 0 };
  }

  _fee(price, lots, { closeToday = false } = {}) {
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
    let pos = null;       // {dir, lots, entryPrice, entryIdx, entryDate, margin, feePaid, stop, target, trail, reason}
    let peak = -Infinity, trough = Infinity;

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

      // ---- 1. 先处理持仓的止损/止盈（用当前 bar 的 high/low 判定，成交价保守取） ----
      if (pos) {
        if (pos.trail !== undefined && pos.trail !== null) {
          if (pos.dir === DIR.LONG) pos.stop = Math.max(pos.stop ?? -Infinity, pos.trail);
          else pos.stop = Math.min(pos.stop ?? Infinity, pos.trail);
        }
        const exit = this._checkExit(pos, bar, i);
        if (exit) {
          cash = this._closePosition(pos, exit.price, exit.idx, exit.reason, cash);
          pos = null;
        }
      }

      // ---- 2. 信号在 i 根产生，委托固定在第 i+1 根的开盘成交 ----
      // 不提供「当根成交」开关：那个口径等于用未来信息，留着就有人会去拧。
      const sig = signals[i];
      const fillIdx = i + 1;
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
                trail: sig.trail ?? null, reason: sig.reason || 'signal', openBarIdx: i
              };
              peak = wantDir === DIR.LONG ? fb.high : Infinity;
              trough = wantDir === DIR.LONG ? -Infinity : fb.low;
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
   * 止损/止盈判定。同一根内两者都可能触发时先算止损（悲观）。
   * 跳空穿透按开盘成交。
   */
  _checkExit(pos, bar, idx) {
    if (idx <= pos.entryIdx) return null;   // 成交那根不再判出场，避免同一根进出

    const isLong = pos.dir === DIR.LONG;
    const openBreachStop = isLong ? bar.open <= (pos.stop ?? -Infinity) : bar.open >= (pos.stop ?? Infinity);
    const openBreachTarget = isLong ? bar.open >= (pos.target ?? Infinity) : bar.open <= (pos.target ?? -Infinity);
    if (openBreachStop) return { price: bar.open, idx, reason: 'gap_stop' };
    if (openBreachTarget) return { price: bar.open, idx, reason: 'target' };

    const hitStop = pos.stop !== null && pos.stop !== undefined && (isLong ? bar.low <= pos.stop : bar.high >= pos.stop);
    if (hitStop) return { price: pos.stop, idx, reason: 'stop' };
    const hitTarget = pos.target !== null && pos.target !== undefined && (isLong ? bar.high >= pos.target : bar.low <= pos.target);
    if (hitTarget) return { price: pos.target, idx, reason: 'target' };
    return null;
  }

  _closePosition(pos, price, idx, reason, cash) {
    const gross = (pos.dir === DIR.LONG ? price - pos.entryPrice : pos.entryPrice - price) * this.spec.multiplier * pos.lots;
    const sameDay = idx === pos.entryIdx;
    const exitFee = this._fee(price, pos.lots, { closeToday: sameDay });
    // 单笔净盈亏必须把开仓费也算进去：开仓费虽然当时已从现金扣走，
    // 但若 netPnL 只减平仓费，每笔盈利都会被高估半个手续费，累计起来就是系统性偏差。
    const net = gross - pos.feePaid - exitFee;
    cash += pos.margin + gross - exitFee;      // 开仓费已在建仓时扣过，这里不再重复扣
    this.trades.push({
      id: this.trades.length + 1,
      dir: pos.dir === DIR.LONG ? 'long' : 'short',
      entryIdx: pos.entryIdx, entryDate: pos.entryDate, entryPrice: pos.entryPrice,
      exitIdx: idx, exitDate: this.bars[idx].date, exitPrice: price,
      lots: pos.lots, gross: Math.round(gross * 100) / 100,
      fee: Math.round((pos.feePaid + exitFee) * 100) / 100,
      netPnL: Math.round(net * 100) / 100,
      points: Math.round((pos.dir === DIR.LONG ? price - pos.entryPrice : pos.entryPrice - price) * 1e4) / 1e4,
      pct: Math.round((pos.dir === DIR.LONG ? (price - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - price) / pos.entryPrice) * 1e6) / 1e4,
      holdingBars: idx - pos.entryIdx,
      entryReason: pos.reason, exitReason: reason,
      equityAfter: Math.round(cash * 100) / 100
    });
    return cash;
  }

  result() {
    return {
      trades: this.trades,
      equityCurve: this.equityCurve,
      rejected: { ...this.rejected },
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
