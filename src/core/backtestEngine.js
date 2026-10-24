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
import { tradingDayOf } from '../data/dominant.js';
import { roundTick } from '../markets/marketRules.js';
import { sqrtImpactPrice, participationCapLots, dailyVolSeries } from './impact.js';

export const DIR = { FLAT: 0, LONG: 1, SHORT: -1 };

const round2 = (v) => Math.round(v * 100) / 100;
/** 只有杠杆品种才有保证金/强平。A股现货 marginRate=1，不能套用期货那套。 */
const isLeveragedSpec = (spec) => (spec?.marginRate ?? 0.1) < 1 - 1e-9;
/** 带钟点的 bar 才是分钟级：只有它能在日内按成交量估当日结算价。 */
const hasClock = (date) => /\d{2}:\d{2}/.test(String(date));

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
     * L2 冲击成本模型（core/impact.js）。默认关闭 —— 关闭时所有成交路径与旧版逐位一致。
     *   eta/delta         —— ΔP = η·σ·(Q/V)^δ 的两个经验常数
     *   maxParticipation  —— 单根 bar 最大成交量参与率，超过部分砍手数（容量测试的硬约束）
     *   volLookback       —— 冲击用的日波动率回看窗（截至前一根，不含当根）
     * 不传就退回纯固定滑点（L1）：小单摸底用 L1 足够，别让默认值悄悄变贵。
     */
    this.impact = opts.impact && Number(opts.impact.eta) > 0
      ? { eta: Number(opts.impact.eta), delta: Number(opts.impact.delta) > 0 ? Number(opts.impact.delta) : 0.5,
          maxParticipation: Number(opts.impact.maxParticipation) > 0 ? Number(opts.impact.maxParticipation) : 0.1,
          volLookback: Math.max(2, Number(opts.impact.volLookback) || 20) }
      : null;
    /** 订单量→bar成交量 的单位换算。期货日线 volume 是手（1）；A股是股（一手=100 股）。 */
    this.qtyPerLot = opts.qtyPerLot ?? (this.rules && typeof this.rules.lotSize === 'function' ? this.rules.lotSize() : 1);
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
     * 杠杆品种（期货）强制逐日盯市 —— 这不是可选项，真实账户每天都结算。
     *   maintenanceRatio —— 维持保证金 = 占用保证金 × 该比例，权益跌破它才强平
     *   warningRatio     —— 可用资金为负（权益 < 占用）即发追保通知
     *
     * 三件事必须做对，否则杠杆回撤会被系统性低估：
     *   1. 每个**交易日**按结算价把浮动盈亏划转进现金，不是每根 bar 都结算；
     *      结算价优先用上游交易所结算价（bar.settlement），缺失才用 VWAP/收盘价代理并写明；
     *   2. 保证金占用按结算价重算，价格涨上去多头占用跟着涨；
     *   3. 先追保通知、再到维持线才强平，强平在**次根开盘**成交。
     *
     * A股现货没有杠杆，不结算、也不存在保证金强平 —— 以前那条"权益 ≤ 占用×75%"
     * 会在满仓浮亏 25% 时把股票账户强平，纯属把期货口径套到了现货上。
     */
    this._leveraged = isLeveragedSpec(spec);
    this.settlement = this._leveraged
      ? { maintenanceRatio: 0.75, warningRatio: 1.0, ...(opts.settlement || {}), enabled: true, forced: true }
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
    this.forcedLiquidations = [];
    this.liquidationNotices = [];
    this._pendingLiquidation = -1;
    this._settleSource = null;
    this._settledReal = 0;
    this._settledProxy = 0;
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
   * 滑点后的可成交价。上限/下限的层级刻意是：
   *   1) 当根 K 线实际成交区间 —— 记录下来的 high/low 已经包含全部成交，
   *      成交价跑到区间外等于凭空多出一个根本不存在的价格；
   *   2) L2 冲击 —— 只在配置了 impact 且给了手数时生效。大单按参与率吃深度，
   *      成交价**允许**超出当根观测区间：那根 bar 是"没有你这笔单"的世界里的行情，
   *      你自己的单子本来就会把 range 推开 —— 这正是冲击模型要计的价。
   *   3) 交易所涨跌停板 —— 无论冲击多大都不可能成交在板外，最后再夹一次。
   * 强平单也走这里，避免"最低只到 92，却按 88 强平"这种假亏。
   */
  _fillPrice(raw, idx, side, lots = null) {
    let px = this._slip(raw, side);
    const bar = this.bars[idx];
    if (!bar) return px;
    px = side === 'buy' ? Math.min(px, bar.high) : Math.max(px, bar.low);
    if (this.impact && Number.isFinite(lots) && lots > 0 && bar.volume > 0 && this._volSeries) {
      const vol = this._volSeries[idx];
      if (Number.isFinite(vol)) {
        const part = (lots * this.qtyPerLot) / bar.volume;
        const imp = sqrtImpactPrice({ price: px, dailyVol: vol, participation: part,
                                      eta: this.impact.eta, delta: this.impact.delta });
        px = side === 'buy' ? px + imp : px - imp;
      }
    }
    const base = this._limitBaseFor(idx);
    const lim = Number(this.spec.limitPct);
    if (this.rules && base && lim > 0 && !(bar.stalePrevClose && !this._leveraged)) {
      const tick = this.spec.tick || 1;
      const up = roundTick(base * (1 + lim), tick);
      const dn = roundTick(base * (1 - lim), tick);
      px = side === 'buy' ? Math.min(px, up) : Math.max(px, dn);
    }
    return px;
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
    // 冲击模型需要逐根的"截至前一根"日波动率，一次性预算而不是每次成交现算
    this._volSeries = this.impact ? dailyVolSeries(bars, this.impact.volLookback) : null;
    this._prepareSettlementCalendar(bars);

    let cash = this.capital0;
    let pos = null;       // {dir, lots, entryPrice, entryIdx, entryDate, margin, feePaid, stop, target, trail, reason, orders}
    let peak = -Infinity, trough = Infinity;
    let pendingTrail = null;   // 上一根信号给出的移动止损候选位，本根开盘后才生效
    let blockedEntryBar = -1;  // 强平当根禁止按同一信号原样重开

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];

      // ---- 0. 开盘：执行挂起的强平；跳空直接穿维持线也在这里处理 ----
      // 强平判定来自上一根已走完的行情（收盘或极值），成交在下一根开盘 —— 不给
      // "当根假设能出掉"的口径。若开盘价已经恢复，撤单；若开盘直接穿线，按开盘价强平。
      if (pos) {
        const done = this._handleOpenRisk(pos, bar, i, cash);
        if (done) {
          cash = done.cash;
          pos = null;
          blockedEntryBar = i;
        }
      } else {
        this._pendingLiquidation = -1;
        this._pendingTimeStop = -1;
      }

      // ---- 1. 上一根信号在本根开盘成交 ----
      // 信号 bar 只负责产生委托，绝不在那根就建仓/计入权益；否则信号 bar 的收益
      // 会按未来成交价倒算出来，强平也会被提前一根触发。
      const sig = i > 0 ? signals[i - 1] : null;
      if (sig && sig.trail !== undefined && sig.trail !== null) pendingTrail = sig.trail;
      if (sig) {
        const wantDir = sig.dir ?? 0;
        const curDir = pos ? pos.dir : DIR.FLAT;

        if (pos && wantDir !== curDir) {
          const px = this._fillPrice(bar.open, i, pos.dir === DIR.LONG ? 'sell' : 'buy', pos.lots);
          const gate = this._closingAllowed(px, i, pos.dir, bar.open);
          if (gate.ok) {
            cash = this._closePosition(pos, px, i, wantDir === DIR.FLAT ? 'signal_close' : 'signal_reverse', cash);
            pos = null;
            this._pendingLiquidation = -1;
            this._pendingTimeStop = -1;
          } else {
            // 平不掉就不反手：下面的开仓分支要求 !pos，仓位还在就自然跳过
            this._noteReject(i, gate, wantDir === DIR.FLAT ? '信号平仓' : '信号反手');
          }
        }

        if (wantDir !== DIR.FLAT && !pos) {
          if (i === blockedEntryBar) {
            this.rejected.reentryBlocked = (this.rejected.reentryBlocked || 0) + 1;
            this.rejects.push({ idx: i, kind: 'reentryBlocked', reason: '强平当根禁止按同一信号原样重开' });
          } else if (wantDir === DIR.SHORT && !this.allowShort) {
            this.rejected.shortDisabled++;
          } else {
            const side = wantDir === DIR.LONG ? 'buy' : 'sell';
            let px = this._fillPrice(bar.open, i, side);
            const prevClose = this._limitBaseFor(i);

            // 规则闸门一：该方向能不能开（A股默认仅做多）
            const openGate = this.rules ? this.rules.canOpen(wantDir) : { ok: true };
            if (!openGate.ok) {
              this.rejected.rules = (this.rejected.rules || 0) + 1;
              this.rejects.push({ idx: i, kind: 'open', reason: openGate.reason });
            }
            // 规则闸门二：涨跌停板锁（封板时开单价排队成交不了）
            // 前收盘失效只适用于 A股复牌；期货的板幅基准是上一交易日结算价，
            // 长假后照样有板，不能因为缺口长就跳过。
            const boardJudgable = !bar.suspended && (!bar.stalePrevClose || this._leveraged);
            const fillGate = openGate.ok && this.rules && boardJudgable
              ? this.rules.canFillAt(side, px, prevClose, { closing: false, sealRef: bar.open }) : { ok: true };
            if (openGate.ok && bar.suspended) {
              this.rejected.suspended = (this.rejected.suspended || 0) + 1;
              this.rejects.push({ idx: i, kind: 'suspended', reason: '停牌日不可成交' });
            }
            if (openGate.ok && !fillGate.ok) {
              this.rejected.boardLock = (this.rejected.boardLock || 0) + 1;
              this.rejects.push({ idx: i, kind: 'boardLock', reason: fillGate.reason });
            }
            if (openGate.ok && fillGate.ok && !bar.suspended) {
              const marginRate = this.spec.marginRate ?? 0.1;
              let perLotMargin = px * this.spec.multiplier * marginRate;
              let lots = this.sizing === 'notional'
                ? Math.max(1, Math.floor((cash * this.notionalPct) / (perLotMargin || Infinity)))
                : this.lots;
              // 最大参与率上限：单根 bar 吃不掉的单子就该被砍 —— 5000 手砸进 800 手
              // 成交量的 bar 里，"按同一个价全成"是把流动性当无限的幻想。
              if (this.impact && this.impact.maxParticipation > 0) {
                const capLots = participationCapLots({ barVolume: bar.volume, qtyPerLot: this.qtyPerLot,
                                                       maxParticipation: this.impact.maxParticipation });
                if (capLots < lots) this.rejected.participationCapped = (this.rejected.participationCapped || 0) + 1;
                if (capLots <= 0) {
                  this.rejected.noLiquidity++;     // bar 无量：没有对手盘就不该成交
                  lots = 0;
                } else lots = Math.min(lots, capLots);
              }
              // 冲击重估：手数定了才知道 Q/V，才知道自己把价格推了多少。
              // 保证金按冲击后的价重算 —— 占用是用真实成本算的，不是用幻想成本。
              if (this.impact && lots > 0) {
                px = this._fillPrice(bar.open, i, side, lots);
                perLotMargin = px * this.spec.multiplier * marginRate;
              }
              const margin = perLotMargin * lots;
              const fee = this._fee(px, lots, {});
              if (lots <= 0 || cash - margin - fee < 0) {
                if (lots > 0) this.rejected.margin++;          // 资金不足就不开仓，而不是强行开进去
              } else {
                cash -= (margin + fee);
                pos = {
                  dir: wantDir, lots, entryPrice: px, entryIdx: i, entryDate: bar.date,
                  margin, feePaid: fee, stop: sig.stop ?? null, target: sig.target ?? null,
                  trail: sig.trail ?? null, reason: sig.reason || 'signal', openBarIdx: i,
                  orders: this._buildOrders(sig, wantDir, px, lots),
                  lastSettle: px,
                  // 初始风险（每单位价格距离）：保本止损的"1R"就是它。没挂止损就没有 R，不猜。
                  riskPerUnit: (sig.stop !== null && sig.stop !== undefined) ? Math.abs(px - sig.stop) : null,
                  beDone: false,
                  addCount: 0
                };
                peak = -Infinity;
                trough = Infinity;
                this._pendingLiquidation = -1;
                this._pendingTimeStop = -1;
              }
            }
          }
        }
      }

      // ---- 2. 时间止损：上一根收盘决定"这笔不动了"，本根开盘执行 ----
      if (pos && this._pendingTimeStop === i - 1) {
        const px = this._fillPrice(bar.open, i, pos.dir === DIR.LONG ? 'sell' : 'buy', pos.lots);
        const gate = this._closingAllowed(px, i, pos.dir, bar.open);
        if (gate.ok) {
          cash = this._closePosition(pos, px, i, 'time_stop', cash);
          pos = null;
          this._pendingLiquidation = -1;
        } else this._noteReject(i, gate, '时间止损');
        this._pendingTimeStop = -1;      // 判定只生效一次；被拒也不在同一根重试
      }

      // ---- 3. 移动止损/保本/条件单/加仓（用当前 bar 的 high/low 判定） ----
      // 持仓过夜的仓位才收紧移动止损；当天新开的仓位不用信号 bar 的极值给它定价。
      if (pos) {
        if (i > pos.entryIdx) {
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
        }
        if (pendingTrail !== null) {
          pos.stop = ratchetStop(pos.stop ?? null, pendingTrail, pos.dir);
        }
        this._syncStopOrder(pos);

        const exit = this._checkExit(pos, bar, i);
        if (exit) {
          cash = this._settleExit(pos, exit, cash);
          if (!pos.lots) {
            pos = null;
            this._pendingLiquidation = -1;
            this._pendingTimeStop = -1;
          }
        } else {
          cash = this._settleAdds(pos, bar, i, cash);   // 出场优先：同一根里触了止损就不再看加仓
        }
      }
      pendingTrail = null;

      // ---- 4. 账户级风险：用本根已走完的极值判定，次根开盘执行 ----
      // 条件单先判（止损优先）再查账户，和 README 里「判定用本根收盘或已走完的极值、
      // 成交在次根」是同一条时间轴；不假设盘中某一瞬能按哪个价出掉。
      if (pos) this._checkAccountRisk(pos, bar, i, cash);

      if (pos) {
        peak = Math.max(peak, bar.high);
        trough = Math.min(trough, bar.low);
        // 时间止损的判定放在收盘：收盘还没脱离成本才算"没启动"，下一根开盘走。
        if (this.timeStop && this._pendingTimeStop < i && i - pos.entryIdx >= this.timeStop.bars) {
          const notWorking = this.timeStop.requireLoss ? bar.close <= pos.entryPrice : true;
          if (notWorking) this._pendingTimeStop = i;
        }
      }

      // ---- 5. 盯市权益 + 当日无负债结算 ----
      const float = pos ? this._floating(pos, bar) : 0;
      let equity = cash + (pos ? pos.margin : 0) + float;
      // 结算之后账面上不再存在"浮动盈亏"—— 那笔钱已经划进现金了。
      // 记录时若仍填划转前的浮动值，就会出现 cash + 占用 + 浮动 ≠ 权益，
      // 而任何拿这三个字段做二次计算的上层（组合、报表）都会算错。
      let recordFloat = float, settled = false, settledPnl = 0, settlePrice = null;
      // 只在交易日最后一根结算，不是每根 bar 都结算 —— 60 分钟线每天结算一次，
      // 不是每小时把浮盈划一次现金。
      if (pos && this.settlement && this._dayEnd[i]) {
        const sp = this._settlePriceByDay.get(this._dayKeys[i]);
        const s = this._markToMarket(pos, sp, cash, i);
        cash = s.cash;
        equity = s.equity;                       // 划转后 cash + margin 恒等于原盯市权益
        recordFloat = 0;
        settled = true;
        settledPnl = s.segPnl;
        settlePrice = sp;
        if (this._settleRealByDay.get(this._dayKeys[i])) this._settledReal++;
        else this._settledProxy++;
        if (s.notice) this._noteMarginCall(pos, this._dayKeys[i], i, sp, equity, s.margin);
        if (s.liquidate && !pos._liqTriggered) {
          pos._liqTriggered = true;
          pos._liqTriggerPrice = sp;
          pos._liqTriggerIdx = i;
          if (this._pendingLiquidation < 0) this._pendingLiquidation = i;
        }
      }
      // margin 一并记下来：组合回测要算「合并保证金占用」才能执行总仓位上限，
      // 曲线里没这个数，上层就只能靠成交记录反推，反推出来的敞口是错的。
      this.equityCurve.push({ idx: i, date: bar.date, equity, cash, margin: pos ? pos.margin : 0,
                             floating: recordFloat, settled, settledPnl, settlePrice,
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
    // 前收盘失效是 A股复牌口径；期货板幅看上一交易日结算价，长假后照样有板。
    if (!this.rules || (bar.stalePrevClose && !this._leveraged)) return { ok: true };
    const side = dir === DIR.LONG ? 'sell' : 'buy';
    const ref = Number.isFinite(sealRef) ? sealRef : (side === 'sell' ? bar.low : bar.high);
    const gate = this.rules.canFillAt(side, px, this._limitBaseFor(idx), { closing: true, sealRef: ref });
    return gate.ok ? { ok: true } : { ok: false, bucket: 'boardLockClose', reason: gate.reason };
  }

  /**
   * 涨跌停板基准。期货用**上一交易日结算价**，不是昨收 —— 两者在结算价不等于收盘价时
   * 会差出几个 tick，板锁判定跟着错。A股仍用前收盘。第一个交易日没有昨日结算价，
   * 不猜，直接放行板锁（宁可不拦，也不拿当天价格冒充昨天的结算价）。
   */
  _limitBaseFor(idx) {
    if (idx <= 0) return null;
    const k = this._dayIdx?.[idx];
    if (!Number.isInteger(k) || k <= 0) {
      // 没建日历（理论上不会）时退回昨收；A股日内也至少不能拿当天上一根冒充昨收。
      return this._leveraged ? null : (this.bars[idx - 1]?.close ?? null);
    }
    if (!this._leveraged) {
      // A股复牌/长缺口那天整天的板幅基准都不可信，不能只放过当天第一根。
      if (this._staleDays?.has(this._dayKeys[idx])) return null;
      const prev = this._dayLastIdx?.get(this._dayOrder[k - 1]);
      return prev === undefined ? null : this.bars[prev].close;
    }
    const p = this._settlePriceByDay?.get(this._dayOrder[k - 1]);
    return Number.isFinite(p) && p > 0 ? p : null;
  }

  /**
   * 逐日盯市日历：按真实交易日分组（夜盘算次日），最后一个 bar 才是结算 bar。
   * 分钟级序列用当日成交量加权均价近似结算价；日线及以上只有收盘价，明确标成代理值。
   */
  _prepareSettlementCalendar(bars) {
    const dayKeys = bars.map(b => tradingDayOf(b.date));
    const dayOrder = [];
    const groups = new Map();
    const dayIdx = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      const k = dayKeys[i];
      if (!groups.has(k)) { groups.set(k, []); dayOrder.push(k); }
      groups.get(k).push(i);
      dayIdx[i] = dayOrder.length - 1;
    }
    const dayEnd = new Array(bars.length).fill(false);
    const dayLastIdx = new Map();
    const staleDays = new Set();
    const settlePriceByDay = new Map();
    const settleRealByDay = new Map();
    let exchangeDays = 0, vwapDays = 0, closeDays = 0;
    for (const k of dayOrder) {
      const idxs = groups.get(k);
      dayEnd[idxs[idxs.length - 1]] = true;
      dayLastIdx.set(k, idxs[idxs.length - 1]);
      if (!this._leveraged && idxs.some(i => bars[i].stalePrevClose)) staleDays.add(k);
      const intraday = idxs.some(i => hasClock(bars[i].date));
      let vol = 0, pv = 0;
      if (intraday) {
        for (const i of idxs) {
          const v = Number(bars[i].volume) || 0;
          if (v > 0) { vol += v; pv += ((bars[i].high + bars[i].low + bars[i].close) / 3) * v; }
        }
      }
      const last = bars[idxs[idxs.length - 1]];
      // 上游带交易所结算价就用它；0 或缺失不算数（拿 0 结算会把权益瞬间打穿）。
      const real = Number.isFinite(last.settlement) && last.settlement > 0;
      settleRealByDay.set(k, real);
      if (real) { settlePriceByDay.set(k, last.settlement); exchangeDays++; }
      else if (intraday && vol > 0) { settlePriceByDay.set(k, pv / vol); vwapDays++; }
      else { settlePriceByDay.set(k, last.close); closeDays++; }
    }
    // 数据最后一组如果是分钟级且停在日盘收盘前（例如只到 09:00），这一天并没有走完，
    // 不能把半天的 VWAP 当成结算价。日线/周线没有钟点，天然算完整。
    const lastDay = dayOrder[dayOrder.length - 1];
    const lastIdx = groups.get(lastDay)?.[groups.get(lastDay).length - 1];
    const lastBar = lastIdx !== undefined ? bars[lastIdx] : null;
    if (lastBar && hasClock(lastBar.date)) {
      const hh = Number(String(lastBar.date).slice(11, 13));
      if (Number.isFinite(hh) && hh < 14) dayEnd[lastIdx] = false;
    }
    this._dayKeys = dayKeys;
    this._dayOrder = dayOrder;
    this._dayIdx = dayIdx;
    this._dayLastIdx = dayLastIdx;
    this._staleDays = staleDays;
    this._dayEnd = dayEnd;
    this._settlePriceByDay = settlePriceByDay;
    this._settleRealByDay = settleRealByDay;
    this._settleSource = exchangeDays
      ? ((vwapDays || closeDays) ? 'mixed' : 'exchange')
      : (vwapDays && closeDays ? 'mixed' : (vwapDays ? 'vwap' : 'close'));
  }

  /** 强平触发价：权益 = 当前价 × 乘数 × 手数 × 保证金率 × ratio 的那个价。 */
  _breachPrice(dir, cash, margin, settleBase, qty, rate, ratio) {
    const k = rate * Math.max(0, Number(ratio) || 0);
    const denom = dir === DIR.LONG ? 1 - k : 1 + k;
    if (!(denom > 1e-9) || !(qty > 0)) return null;
    const p = dir === DIR.LONG
      ? (settleBase * qty - cash - margin) / (qty * denom)
      : (settleBase * qty + cash + margin) / (qty * denom);
    return Number.isFinite(p) && p > 0 ? p : null;
  }

  /** 追保通知：同一持仓同一交易日只报一次，不按 bar 刷屏。 */
  _noteMarginCall(pos, day, i, price, equity, margin) {
    if (pos._noticeDay === day) return;
    pos._noticeDay = day;
    this.marginNotices.push({
      idx: i, date: this.bars[i]?.date, kind: 'margin_call',
      price: round2(price), equity: round2(equity), margin: round2(margin ?? pos.margin)
    });
  }

  /**
   * 账户级风险判定。用本根**已走完**的低/高判定，不假设盘中某一瞬能出掉；
   * 触发后只挂单，成交仍在次根开盘（由 _handleOpenRisk 执行）。
   */
  _checkAccountRisk(pos, bar, i, cash) {
    if (!this.settlement) return;
    const qty = this.spec.multiplier * pos.lots;
    if (!(qty > 0)) return;
    const rate = this.spec.marginRate ?? 0.1;
    const base = pos.lastSettle ?? pos.entryPrice;
    const callPx = this._breachPrice(pos.dir, cash, pos.margin, base, qty, rate, 1.0);
    const liqPx = this._breachPrice(pos.dir, cash, pos.margin, base, qty, rate, this.maintenanceRatio);
    const adverse = pos.dir === DIR.LONG ? bar.low : bar.high;
    const hit = (p) => p !== null && (pos.dir === DIR.LONG ? adverse <= p + 1e-9 : adverse >= p - 1e-9);

    if (hit(callPx)) {
      const eq = cash + pos.margin + (pos.dir === DIR.LONG ? callPx - base : base - callPx) * qty;
      this._noteMarginCall(pos, this._dayKeys[i], i, callPx, eq, callPx * qty * rate);
    }
    if (hit(liqPx) && !pos._liqTriggered) {
      pos._liqTriggered = true;
      pos._liqTriggerPrice = liqPx;
      pos._liqTriggerIdx = i;
      if (this._pendingLiquidation < 0) this._pendingLiquidation = i;
      this.liquidationNotices.push({
        idx: i, date: bar.date, kind: 'liquidation_pending',
        triggerPrice: round2(liqPx),
        equity: round2(cash + pos.margin + (pos.dir === DIR.LONG ? liqPx - base : base - liqPx) * qty)
      });
    }
  }

  /**
   * 开盘处理强平挂单。
   * 1) 开盘权益已回到维持线上 → 撤单（价格自己修复了，不再强制平）；
   * 2) 否则按开盘价强平；封板/停牌出不掉就保留挂单，下一根继续。
   * 没有挂单但开盘跳空直接穿维持线，同样在开盘执行。
   */
  _handleOpenRisk(pos, bar, i, cash) {
    if (!this.settlement) return null;
    const qty = this.spec.multiplier * pos.lots;
    if (!(qty > 0)) return null;
    const rate = this.spec.marginRate ?? 0.1;
    const day = this._dayKeys[i];
    const marginAtOpen = bar.open * qty * rate;
    const maintAtOpen = marginAtOpen * this.maintenanceRatio;
    const eqOpen = this._equity(cash, pos, bar.open);

    if (this._pendingLiquidation >= 0) {
      if (eqOpen >= maintAtOpen) {
        this.liquidationNotices.push({
          idx: i, date: bar.date, kind: 'liquidation_cancelled',
          equity: round2(eqOpen), maintenance: round2(maintAtOpen)
        });
        this._pendingLiquidation = -1;
        pos._liqTriggered = false;
        pos._liqTriggerPrice = null;
        pos._liqTriggerIdx = null;
        return null;
      }
      if (eqOpen < marginAtOpen) this._noteMarginCall(pos, day, i, bar.open, eqOpen, marginAtOpen);
      return this._tryLiquidate(pos, bar, i, cash, bar.open, day);
    }

    if (eqOpen < maintAtOpen) {
      if (eqOpen < marginAtOpen) this._noteMarginCall(pos, day, i, bar.open, eqOpen, marginAtOpen);
      pos._liqTriggered = true;
      pos._liqTriggerPrice = bar.open;
      pos._liqTriggerIdx = i;
      this._pendingLiquidation = i;
      return this._tryLiquidate(pos, bar, i, cash, bar.open, day);
    }
    return null;
  }

  _tryLiquidate(pos, bar, i, cash, refPrice, day) {
    const px = this._fillPrice(refPrice, i, pos.dir === DIR.LONG ? 'sell' : 'buy', pos.lots);
    const gate = this._closingAllowed(px, i, pos.dir, refPrice);
    if (!gate.ok) {
      // 真实账户就是这样闷在跌停板里：仓位留着，下一根继续试，不是理论上一按就出。
      this._noteReject(i, gate, '维持保证金强平');
      if (pos._blockedDay !== day) {
        pos._blockedDay = day;
        this.liquidationNotices.push({
          idx: i, date: bar.date, kind: 'liquidation_blocked',
          equity: round2(this._equity(cash, pos, refPrice)),
          triggerPrice: pos._liqTriggerPrice != null ? round2(pos._liqTriggerPrice) : null,
          reason: gate.reason
        });
      }
      if (this._pendingLiquidation < 0) this._pendingLiquidation = i;
      return null;
    }
    const triggerPrice = pos._liqTriggerPrice;
    const triggerIdx = pos._liqTriggerIdx;
    const lots = pos.lots;
    const dir = pos.dir === DIR.LONG ? 'long' : 'short';
    cash = this._closePosition(pos, px, i, 'margin_call', cash);
    this.rejected.marginCalls = (this.rejected.marginCalls || 0) + 1;
    this.forcedLiquidations.push({
      idx: i, date: bar.date, dir, lots, price: px,
      triggerPrice: triggerPrice != null ? round2(triggerPrice) : null, triggerIdx,
      equityAfter: round2(cash)
    });
    this._pendingLiquidation = -1;
    this._pendingTimeStop = -1;
    return { cash };
  }

  _noteReject(idx, gate, label) {
    this.rejected[gate.bucket] = (this.rejected[gate.bucket] || 0) + 1;
    this.rejects.push({ idx, kind: gate.bucket, reason: `${label}：${gate.reason}` });
  }

  _settleExit(pos, exit, cash) {
    const bar = this.bars[exit.idx];
    for (const h of exit.hits) {
      if (!pos.lots) break;
      const lotsToClose = Math.min(pos.lots, h.order.qtyLots ?? pos.lots);
      const px = this._fillPrice(h.price, exit.idx, pos.dir === DIR.LONG ? 'sell' : 'buy', lotsToClose);
      // 跳空穿透按开盘成交 → 锚定价用开盘价；盘中触碰 → 用不利那一侧的极值。
      // 用收盘价倒推"这根到底封没封死"，等于知道结局再决定开局能不能成交。
      const sealRef = h.gap ? bar?.open : (pos.dir === DIR.LONG ? bar?.low : bar?.high);
      const gate = this._closingAllowed(px, exit.idx, pos.dir, sealRef);
      if (!gate.ok) {
        this._noteReject(exit.idx, gate, h.kind);     // 委托不下岗，下一根继续判
        continue;
      }
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
  _markToMarket(pos, settle, cash, i) {
    const mult = this.spec.multiplier;
    const rate = this.spec.marginRate ?? 0.1;
    // settle 由 _prepareSettlementCalendar 选定：交易所结算价 > 分钟级 VWAP > 收盘价代理。
    const base = pos.lastSettle ?? pos.entryPrice;
    const segPnl = (pos.dir === DIR.LONG ? settle - base : base - settle) * mult * pos.lots;
    const equity = cash + pos.margin + segPnl;
    const newMargin = settle * mult * rate * pos.lots;

    pos.margin = Math.round(newMargin * 100) / 100;
    // 现金按「取整后的占用」倒推，而不是取整前的理论值：否则 cash + margin 与记录下来的
    // equity 差着几厘钱，「结算前后权益必须一致」这条不变量就没法严格断言。
    const nextCash = equity - pos.margin;
    pos.lastSettle = settle;
    pos.settledIdx = i;

    const maintenance = pos.margin * this.maintenanceRatio;
    const notice = nextCash < 0 ? 'margin_call' : null;                 // 可用资金为负 → 追保通知
    const liquidate = equity < maintenance;                             // 权益跌破维持线 → 强平
    return { cash: nextCash, equity, segPnl, notice, liquidate, settle };
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
      // 加仓手数先于成交价确定（订单上写着），冲击模型需要它算 Q/V
      const lots = Math.max(1, Math.round(a.order.qtyLots ?? 1));
      const px = this._fillPrice(a.price, idx, pos.dir === DIR.LONG ? 'buy' : 'sell', lots);
      const prevClose = idx > 0 ? this.bars[idx - 1].close : null;
      const side = pos.dir === DIR.LONG ? 'buy' : 'sell';
      const gate = this.rules ? this.rules.canFillAt(side, px, prevClose, { closing: false }) : { ok: true };
      if (!gate.ok) {
        this.rejected.boardLock = (this.rejected.boardLock || 0) + 1;
        this.rejects.push({ idx, kind: 'boardLock', reason: gate.reason });
        continue;
      }
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
    // 平今按**交易日**判：夜盘 21:00 开的仓，次日 09:00 平仍算平今（同一交易日），
    // 用 bar 下标比较会把夜盘和日盘当成两天，平今费整段漏收。
    const sameDay = tradingDayOf(this.bars[idx].date) === tradingDayOf(this.bars[pos.entryIdx].date);
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
    const bits = [];
    if (this._settledReal) bits.push(`${this._settledReal} 根用交易所结算价`);
    if (this._settledProxy) {
      const proxy = this._settleSource === 'vwap' ? '日 VWAP 近似'
        : this._settleSource === 'mixed' ? 'VWAP/收盘代理'
        : '收盘价代理';
      bits.push(`${this._settledProxy} 根用${proxy}`);
    }
    const settleNote = `期货强制逐日盯市${bits.length ? `；结算价：${bits.join('，')}` : ''}`;
    return {
      trades: this.trades,
      equityCurve: this.equityCurve,
      rejected: { ...this.rejected },
      marginNotices: this.marginNotices.slice(),
      forcedLiquidations: this.forcedLiquidations.slice(),
      liquidationNotices: this.liquidationNotices.slice(),
      settlement: this.settlement ? {
        ...this.settlement,
        priceSource: this._settleSource,
        realBars: this._settledReal,
        proxyBars: this._settledProxy,
        note: settleNote
      } : null,
      riskControls: { breakeven: this.breakeven, timeStop: this.timeStop, pyramid: this.pyramid },
      rejects: this.rejects.slice(),
      finalEquity: this._endCash ?? (this.equityCurve.length ? this.equityCurve[this.equityCurve.length - 1].equity : this.capital0),
      capital: this.capital0,
      spec: { multiplier: this.spec.multiplier, tick: this.spec.tick, marginRate: this.spec.marginRate,
              leveraged: this._leveraged, maintenanceRatio: this.maintenanceRatio }
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
