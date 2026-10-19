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
import { atr } from '../analysis/common.js';

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
    /**
     * 保本止损（Minervini/海龟都在用的一步）：浮盈达到 afterR 倍初始风险后，
     * 把止损抬到开仓价（可再加 extraPct 覆盖手续费），此后这笔最多打平。
     * 没有初始止损就算不出"1 倍风险"是多少，因此会跳过（不猜）。
     */
    this.breakeven = opts.breakeven && Number(opts.breakeven.afterR) > 0
      ? { afterR: Number(opts.breakeven.afterR), extraPct: Number(opts.breakeven.extraPct) || 0 } : null;
    /**
     * 时间止损：持仓超过 bars 根仍未脱离成本，就下一根开盘走人。
     * 趋势交易的机会成本是真实的 —— 资金压在不动的仓位上，等于同时错过下一波。
     */
    this.timeStop = opts.timeStop && Number(opts.timeStop.bars) > 0
      ? { bars: Number(opts.timeStop.bars), requireLoss: opts.timeStop.requireLoss !== false } : null;
    this._pendingTimeStop = -1;
    /**
     * 完整逐日盯市（期货「当日无负债结算」）。默认关，开着会影响每一根的计算。
     *   maintenanceRatio —— 维持保证金 = 占用保证金 × 该比例，权益跌破它才强平
     *   warningRatio     —— 可用资金为负（权益 < 占用）即发追保通知
     *
     * 与原来那道"底线强平"的三点区别：
     *   1. 每日按结算价把浮动盈亏**划转进现金**（bar.settlement 有就用交易所结算价，没有才用收盘价代理并写明）；
     *   2. 保证金占用按结算价**重算**，不是按开仓价挂着不动 —— 价格涨上去多头占用跟着涨，
     *      否则杠杆品种的回撤会被系统性低估；
     *   3. 先追保通知、再到维持线才强平，且强平在**次根开盘**成交（不当根假设能出掉）。
     */
    this.settlement = opts.settlement && opts.settlement.enabled
      ? { maintenanceRatio: 0.75, warningRatio: 1.0, ...opts.settlement }
      : null;
    /**
     * 维持保证金比例只留一个来源：opts.maintenanceRatio > 结算配置 > 0.75（交易所常见口径）。
     * 以前非结算那条路径读 this.maintenanceRatio —— 这字段从没被赋值，?? 0.5 悄悄生效，
     * 界面上那个「维持保证金 75%」输入框在关掉逐日盯市时其实是个摆设，两套口径还会给出不同的强平时点。
     */
    this.maintenanceRatio = opts.maintenanceRatio ?? this.settlement?.maintenanceRatio ?? 0.75;
    /** ATR 移动止损的周期：策略给的 trailAtr 是倍数，倍数要乘在当日 ATR 上才是止损位。 */
    this.atrLen = opts.atrLen ?? 14;
    this.marginNotices = [];
    this._pendingLiquidation = -1;
    this.trades = [];
    this.rejects = [];
    this.equityCurve = [];
    this.rejected = { margin: 0, noLiquidity: 0, shortDisabled: 0, boardLockClose: 0, suspendedClose: 0 };
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

    /**
     * 只在真的有 ATR 移动止损时才算这条序列。
     * 以前 _applyTrails 声明了第 4 个参数 atrValue，调用点只给 3 个 —— 于是
     * trailCfg.atr 那条分支永远进不去，六个策略暴露的 trailAtr 参数全是摆设。
     * 取值一律用 i-1：本根的 ATR 含本根高低，用它给本根的止损定价就是偷看本根行情。
     */
    const needsAtrTrail = signals.some(s => s && Number(s.trailAtr) > 0);
    const atrSeries = needsAtrTrail ? atr(bars, this.atrLen) : null;

    let cash = this.capital0;
    let pos = null;       // {dir, lots, entryPrice, entryIdx, entryDate, margin, feePaid, stop, target, trail, reason, orders}
    let peak = -Infinity, trough = Infinity;
    let pendingTrail = null;   // 上一根信号给出的移动止损候选位，本根开盘后才生效

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];

      // ---- 0. 逐日盯市强平：权益跌破维持保证金就必须先平仓，再谈别的 ----
      // 没有这一步，杠杆品种回测会出现「权益为负」的荒谬结果 —— 现金可以无限亏，
      // 而真实账户在保证金不足时已被强平。
      if (pos && i > pos.entryIdx) {
        const settledCall = this.settlement && this._pendingLiquidation === i - 1;
        const prevEq = this.equityCurve.length ? this.equityCurve[this.equityCurve.length - 1].equity : this.capital0;
        const legacyCall = !this.settlement && prevEq <= pos.margin * this.maintenanceRatio;
        if (settledCall || legacyCall) {
          const px = this._slip(bar.open, pos.dir === DIR.LONG ? 'sell' : 'buy');
          const gate = this._closingAllowed(px, i, pos.dir, bar.open);
          if (!gate.ok) {
            // 强平单也会被板锁卡住：仓位留着，结算层每天重新判定，下一根继续试。
            // 真实账户就是这样闷在跌停板里，而不是理论上一按就出。
            this._noteReject(i, gate, '维持保证金强平');
          } else {
            cash = this._closePosition(pos, px, i, 'margin_call', cash);
            pos = null;
            if (this._pendingLiquidation === i - 1) this._pendingLiquidation = -1;
            this.rejected.marginCalls = (this.rejected.marginCalls || 0) + 1;
          }
        }
      }

      // ---- 0.5 时间止损：上一根收盘决定"这笔不动了"，本根开盘执行 ----
      if (pos && this._pendingTimeStop === i - 1) {
        const px = this._slip(bar.open, pos.dir === DIR.LONG ? 'sell' : 'buy');
        const gate = this._closingAllowed(px, i, pos.dir, bar.open);
        if (gate.ok) {
          cash = this._closePosition(pos, px, i, 'time_stop', cash);
          pos = null;
        } else this._noteReject(i, gate, '时间止损');
        this._pendingTimeStop = -1;      // 判定只生效一次；被拒也不在同一根重试
      }

      // ---- 1. 出场与加仓（用当前 bar 的 high/low 判定，成交价保守取） ----
      // 移动止损先按「上一根信号给出的候选位」收紧，再判触发。
      // 原实现只在开仓时取一次 sig.trail，之后再也不更新 —— 吊灯止损实际上根本不动，
      // 回测里那条「移动止损」是个装饰品。
      if (pos) {
        this._applyTrails(pos, peak, trough, atrSeries ? atrSeries[i - 1] : null);
        // 保本止损：浮盈够了就把止损抬到成本。peak/trough 此刻只含到上一根为止的极值，
        // 所以这条判定用的是"已经走完的行情"，不偷看本根。
        if (this.breakeven && !pos.beDone && Number.isFinite(pos.riskPerUnit) && pos.riskPerUnit > 0) {
          const base = pos.dir === DIR.LONG ? peak : trough;
          const prog = Number.isFinite(base) ? (pos.dir === DIR.LONG ? base - pos.entryPrice : pos.entryPrice - base) : -Infinity;
          if (prog >= this.breakeven.afterR * pos.riskPerUnit) {
            const to = pos.dir === DIR.LONG
              ? pos.entryPrice * (1 + this.breakeven.extraPct)
              : pos.entryPrice * (1 - this.breakeven.extraPct);
            pos.stop = ratchetStop(pos.stop ?? null, to, pos.dir);
            pos.beDone = true;
          }
        }
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
          const gate = this._closingAllowed(px, fillIdx, pos.dir, fb.open);
          if (gate.ok) {
            cash = this._closePosition(pos, px, fillIdx, wantDir === DIR.FLAT ? 'signal_close' : 'signal_reverse', cash);
            pos = null;
          } else {
            // 平不掉就不反手：下面的开仓分支要求 !pos，仓位还在就自然跳过
            this._noteReject(fillIdx, gate, wantDir === DIR.FLAT ? '信号平仓' : '信号反手');
          }
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
            // 两个例外：停牌复牌首日前收可能是几周前的价，拿它算板幅是错的；
            // 以及该品种当天本身停牌（合成出来的空 bar）时根本不该成交。
            // sealRef 用开盘价：开仓单在第 i+1 根的开盘排队，那根后来破没破板是之后的事。
            const boardJudgable = !fb.stalePrevClose && !fb.suspended;
            const fillGate = openGate.ok && this.rules && boardJudgable
              ? this.rules.canFillAt(side, px, prevClose, { closing: false, sealRef: fb.open }) : { ok: true };
            if (openGate.ok && fb.suspended) {
              this.rejected.suspended = (this.rejected.suspended || 0) + 1;
              this.rejects.push({ idx: fillIdx, kind: 'suspended', reason: '停牌日不可成交' });
            }
            if (openGate.ok && !fillGate.ok) {
              this.rejected.boardLock = (this.rejected.boardLock || 0) + 1;
              this.rejects.push({ idx: fillIdx, kind: 'boardLock', reason: fillGate.reason });
            }
            if (openGate.ok && fillGate.ok && !fb.suspended) {
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
                lastSettle: px,
                // 初始风险（每单位价格距离）：保本止损的"1R"就是它。没挂止损就没有 R，不猜。
                riskPerUnit: (sig.stop !== null && sig.stop !== undefined) ? Math.abs(px - sig.stop) : null,
                beDone: false,
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
        // 时间止损的判定放在收盘：收盘还没脱离成本才算"没启动"，下一根开盘走。
        if (this.timeStop && this._pendingTimeStop < i && i - pos.entryIdx >= this.timeStop.bars) {
          const notWorking = this.timeStop.requireLoss ? bar.close <= pos.entryPrice : true;
          if (notWorking) this._pendingTimeStop = i;
        }
      }

      // ---- 3. 逐 bar 盯市权益 ----
      const float = pos ? this._floating(pos, bar) : 0;
      let equity = cash + (pos ? pos.margin : 0) + float;
      // 结算之后账面上不再存在"浮动盈亏"—— 那笔钱已经划进现金了。
      // 记录时若仍填划转前的浮动值，就会出现 cash + 占用 + 浮动 ≠ 权益，
      // 而任何拿这三个字段做二次计算的上层（组合、报表）都会算错。
      let recordFloat = float, settled = false, settledPnl = 0;
      // ---- 4. 当日无负债结算 ----
      if (pos && this.settlement && i > pos.entryIdx) {
        const s = this._markToMarket(pos, bar, cash, i);
        cash = s.cash;
        equity = s.equity;                       // 划转后 cash + margin 恒等于原盯市权益
        recordFloat = 0;
        settled = true;
        settledPnl = s.segPnl;
        if (s.notice) this.marginNotices.push({ idx: i, date: bar.date, kind: s.notice, equity, margin: pos.margin });
        this._pendingLiquidation = s.liquidate ? i : -1;
      }
      // margin 一并记下来：组合回测要算「合并保证金占用」才能执行总仓位上限，
      // 曲线里没这个数，上层就只能靠成交记录反推，反推出来的敞口是错的。
      this.equityCurve.push({ idx: i, date: bar.date, equity, cash, margin: pos ? pos.margin : 0,
                             floating: recordFloat, settled, settledPnl,
                             inPosition: !!pos, dir: pos ? pos.dir : 0 });
    }

    // 收尾：末根收盘强平，避免最后一笔浮盈被当成已实现收益
    const tail = this.equityCurve[this.equityCurve.length - 1] || null;
    let endCash = tail ? tail.cash : this.capital0;
    if (pos) {
      const last = bars[bars.length - 1];
      endCash = this._closePosition(pos, last.close, bars.length - 1, 'end_of_data', endCash);
    }
    // 收尾这笔的 exitDate 就是最后一根，平仓费属于那一天 —— 末点必须把它算进去。
    // 漏掉的话「期末权益 = 本金 + Σ净盈亏」会差出一笔平仓费，报表末值也跟着偏高，
    // 而组合回测按末值相加时品种越多差得越明显。
    this._endCash = Math.round(endCash * 100) / 100;
    if (tail) { tail.equity = this._endCash; tail.cash = this._endCash; tail.margin = 0; tail.floating = 0; tail.inPosition = false; tail.dir = 0; }
    return this.result();
  }

  /**
   * 结算一根 bar 上的出场单。分批止盈时只平命中的那部分手数，
   * 剩下的继续持仓跑止损 —— 「到目标就走人」和「到目标减一半、留一半吃趋势」是两种策略，
   * 只有部分平仓能把后者表达出来。
   */
  /**
   * 平仓侧的板锁与停牌闸门 —— 补上「平仓方向永远放行」那条后门。
   *
   * 封死的跌停板上排的是卖队，你想卖就是卖不掉，这跟你是在开空还是在平多没有关系。
   * 趋势策略的止损恰好大量打在跌停附近，后门一开，回测就在最该痛的地方装作不痛。
   * 被拒不等于没事：委托保留，下一根继续判 —— 真实账户就是这样被闷在板里一天又一天。
   */
  _closingAllowed(px, idx, dir, sealRef) {
    const bar = this.bars[idx];
    if (!bar) return { ok: true };
    if (bar.suspended) return { ok: false, bucket: 'suspendedClose', reason: '停牌日不可成交' };
    if (!this.rules || bar.stalePrevClose) return { ok: true };
    const side = dir === DIR.LONG ? 'sell' : 'buy';
    const ref = Number.isFinite(sealRef) ? sealRef : (side === 'sell' ? bar.low : bar.high);
    const gate = this.rules.canFillAt(side, px, this.bars[idx - 1]?.close, { closing: true, sealRef: ref });
    return gate.ok ? { ok: true } : { ok: false, bucket: 'boardLockClose', reason: gate.reason };
  }

  _noteReject(idx, gate, label) {
    this.rejected[gate.bucket] = (this.rejected[gate.bucket] || 0) + 1;
    this.rejects.push({ idx, kind: gate.bucket, reason: `${label}：${gate.reason}` });
  }

  _settleExit(pos, exit, cash) {
    const bar = this.bars[exit.idx];
    for (const h of exit.hits) {
      if (!pos.lots) break;
      const px = this._slip(h.price, pos.dir === DIR.LONG ? 'sell' : 'buy');
      // 跳空穿透按开盘成交 → 锚定价用开盘价；盘中触碰 → 用不利那一侧的极值。
      // 用收盘价倒推"这根到底封没封死"，等于知道结局再决定开局能不能成交。
      const sealRef = h.gap ? bar?.open : (pos.dir === DIR.LONG ? bar?.low : bar?.high);
      const gate = this._closingAllowed(px, exit.idx, pos.dir, sealRef);
      if (!gate.ok) {
        this._noteReject(exit.idx, gate, h.kind);     // 委托不下岗，下一根继续判
        continue;
      }
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
   * 当日无负债结算。
   *
   * 一个容易算错的点：盈亏划转进现金之后，浮动盈亏必须改从**结算价**起算。
   * 还从开仓价算的话，同一段盈亏会既躺在现金里、又挂在浮动里，被算两遍 ——
   * 权益曲线看上去"更平稳"，实际上是凭空多出来的钱。
   *
   * 划转公式：cash' = cash + 原占用 + 本段盈亏 - 新占用。
   * 这样 cash' + 新占用 恒等于划转前的 cash + 原占用 + 本段盈亏，权益不会因为结算本身而变动。
   *
   * @returns {{cash:number, equity:number, notice:string|null, liquidate:boolean}}
   */
  _markToMarket(pos, bar, cash, i) {
    const mult = this.spec.multiplier;
    const rate = this.spec.marginRate ?? 0.1;
    // 新浪日线带交易所结算价，优先用它；东财不带，只能回退收盘价代理。
    // 0 或缺失都不算数：拿 0 结算会把权益瞬间打穿，比用收盘价坏得多。
    const hasSettlement = Number.isFinite(bar.settlement) && bar.settlement > 0;
    const settle = hasSettlement ? bar.settlement : bar.close;
    if (hasSettlement) this._settledReal = (this._settledReal || 0) + 1;
    else this._settledProxy = (this._settledProxy || 0) + 1;
    const base = pos.lastSettle ?? pos.entryPrice;
    const segPnl = (pos.dir === DIR.LONG ? settle - base : base - settle) * mult * pos.lots;
    const equity = cash + pos.margin + segPnl;
    const newMargin = settle * mult * rate * pos.lots;

    pos.margin = Math.round(newMargin * 100) / 100;
    // 现金按「取整后的占用」倒推，而不是取整前的理论值：否则 cash + margin 与记录下来的
    // equity 差着几厘钱，「开不开盯市权益必须一致」这条不变量就没法严格断言。
    const nextCash = equity - pos.margin;
    pos.lastSettle = settle;
    pos.settledIdx = i;

    const maintenance = pos.margin * this.maintenanceRatio;
    const notice = nextCash < 0 ? 'margin_call' : null;                 // 可用资金为负 → 追保通知
    const liquidate = equity < maintenance;                             // 权益跌破维持线 → 强平
    return { cash: nextCash, equity, segPnl, notice, liquidate };
  }

  /**
   * 结算一根 bar 上该做的强平判定（在下一根开盘执行，不在当根假设能出掉）。
   * @returns {boolean} 是否需要在下一根开盘前处理挂起的强平
   */
  hasPendingLiquidation() {
    return this._pendingLiquidation === undefined ? false : this._pendingLiquidation >= 0;
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
      const oldLots = pos.lots;
      // 盯市基准也要按「加权」重算：老仓位从上一个基准价算，新加的这批从它的成交价算，
      // 合起来等价于把基准挪到两者的加权平均。只改 entryPrice 不改 lastSettle 的话，
      // 加仓那几手的成本差就凭空消失了 —— 账面会在平仓时多出（或少出）一笔钱。
      const base = pos.lastSettle ?? pos.entryPrice;
      pos.lastSettle = Math.round(((base * oldLots + px * lots) / total) * 1e6) / 1e6;
      pos.entryPrice = Math.round(((pos.entryPrice * oldLots + px * lots) / total) * 1e6) / 1e6;
      pos.lots = total;
      pos.margin += addMargin;
      pos.feePaid += fee;
      pos.addCount = (pos.addCount || 0) + 1;
      // 加仓把平均成本推高了，止损不动就等于风险被放大；同步抬一条新的止损单并把已加的仓位纳入保护。
      // 只改仍有效的单：qtyLots=0 是已经成交过的分批止盈单，借加仓复活它等于凭空多平一次。
      for (const o of pos.orders) {
        if ((o.kind === ORDER_KIND.STOP || o.kind === ORDER_KIND.TARGET) && o.qtyLots > 0) o.qtyLots = pos.lots;
      }
      a.order.qtyLots = 0;
      this.adds = (this.adds || 0) + 1;
    }
    return cash;
  }

  /**
   * 浮动盈亏。开了逐日盯市之后必须从**上一次结算价**起算：
   * 之前段落的盈亏已经划进现金了，再从开仓价算一遍就是双重计算。
   */
  _floating(pos, bar) {
    const base = pos.lastSettle ?? pos.entryPrice;
    const diff = pos.dir === DIR.LONG ? bar.close - base : base - bar.close;
    return diff * this.spec.multiplier * pos.lots;
  }

  /** 当前总权益 = 现金 + 占用保证金 + 浮动盈亏（用给定价格盯市）。 */
  _equity(cash, pos, price) {
    if (!pos) return cash;
    const base = pos.lastSettle ?? pos.entryPrice;
    const diff = pos.dir === DIR.LONG ? price - base : base - price;
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
    // 现金划转用「上次结算价」起算，成交记录用「开仓价」起算。两者不是一回事：
    // 开了逐日盯市时前面段位的盈亏已经结算进现金，现金只能再加本段，否则重复计算；
    // 而净盈亏必须是从开仓到平仓的完整盈亏，否则单笔统计会把一段拆成多段、看不出全貌。
    const settleBase = pos.lastSettle ?? pos.entryPrice;
    const cashPnl = (pos.dir === DIR.LONG ? price - settleBase : settleBase - price) * this.spec.multiplier * closing;
    const sameDay = idx === pos.entryIdx;
    const exitFee = this._fee(price, closing, { closeToday: sameDay });
    // 建仓时已按整笔手数扣过的开仓费，这里只按比例摊到本次平仓上，避免部分平仓重复扣。
    const entryFeeShare = pos.feePaid * frac;
    const net = gross - entryFeeShare - exitFee;
    cash += marginReleased + cashPnl - exitFee;
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
      marginNotices: this.marginNotices.slice(),
      settlement: this.settlement ? {
        ...this.settlement,
        realBars: this._settledReal || 0, proxyBars: this._settledProxy || 0,
        note: this._settledReal
          ? `结算价：${this._settledReal} 根用交易所结算价${this._settledProxy ? `，${this._settledProxy} 根缺失、回退收盘价` : ''}`
          : '数据源没有结算价，本次逐日盯市用收盘价代理（真实为当日加权均价）'
      } : null,
      riskControls: { breakeven: this.breakeven, timeStop: this.timeStop, pyramid: this.pyramid },
      rejects: this.rejects.slice(),
      finalEquity: this._endCash ?? (this.equityCurve.length ? this.equityCurve[this.equityCurve.length - 1].equity : this.capital0),
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
