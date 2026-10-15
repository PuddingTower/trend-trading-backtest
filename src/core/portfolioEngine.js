/**
 * 共享保证金池的组合引擎（补「已知边界」里"组合不共享保证金池"这一条）。
 *
 * 与 core/portfolio.js 的分工是有意保留两套的，不是重复实现：
 *   portfolio.js —— 各品种按权重分到一份资金，各自独立跑，再把权益按日期拼起来。
 *                   快、可并行、适合寻优里反复评估组合参数。
 *   本文件       —— **一个账户、一份现金池**。一个品种浮盈释放的保证金，下一根就能被
 *                   另一个品种的追保用上；总敞口越线时按风险大小排序强平，而不是各账户各自爆掉。
 *
 * 撮合与出场的触发判定不重新实现，走 core/orders.js —— 出场优先级/跳空按开盘成交这些口径
 * 一旦在两个引擎里长得不一样，组合回测和单品种回测就永远对不上账。
 *
 * 已知简化（都写在返回值 note 里，不装作是完整清算系统）：
 *   - 结算价用收盘价代理（真实为当日加权均价）；
 *   - 不做跨品种对冲保证金优惠（国内交易所对套利持仓有减免，这里全额占用，偏保守）；
 *   - 组合层面不支持部分平仓，只支持整笔开平。
 */

import { DIR } from './backtestEngine.js';
import { ORDER_KIND, evalExitOrders, ratchetStop, makeBracket } from './orders.js';
import { atrRiskSize, notionalSize, volTargetSize, annualizedVol } from './sizing.js';
import { atr } from '../analysis/common.js';

const round2 = (v) => Math.round(v * 100) / 100;

export class PortfolioEngine {
  /**
   * @param {Array} entries [{symbol,name,bars,spec,rules,strategy,params,allowShort?}]
   * @param {Object} opts {capital, sizing:'atr'|'notional'|'volTarget', riskPct, atrMult,
   *                       atrLen, targetVolPct, maxMarginPct, maintenanceRatio, slippageTicks,
   *                       settlement:boolean, stopPct/targetRr?}
   */
  constructor(entries, opts = {}) {
    this.entries = (entries || []).filter(e => e && e.bars && e.bars.length > 20 && e.strategy);
    this.o = {
      capital: 1_000_000, sizing: 'notional', riskPct: 0.01, atrMult: 2, atrLen: 14,
      targetVolPct: 0.10, maxMarginPct: 0.6, maintenanceRatio: 0.75, slippageTicks: 1,
      settlement: false, stopPct: null, targetRr: null, reentryCooldownBars: 3, ...opts
    };
    this.trades = [];
    this.equityCurve = [];
    this.rejected = { boardLock: 0, boardLockClose: 0, suspended: 0, suspendedClose: 0,
                      cash: 0, sizingZero: 0, marginCalls: 0, reentryBlocked: 0 };
    this.rejects = [];
    this.notices = [];
  }

  get ready() { return this.entries.length > 0; }

  /**
   * 平仓侧的板锁/停牌闸门 —— 与单品种引擎同一条口径。
   * 两个引擎对"封死的板上能不能平仓"给出不同答案，组合回测和单品种回测就永远对不上账。
   */
  _closingAllowed(entry, px, i, dir, sealRef) {
    const bar = entry.bars[i];
    if (!bar) return { ok: false, bucket: 'suspendedClose', reason: '当天没有这根 bar（停牌或未上市），出不了' };
    if (bar.suspended) return { ok: false, bucket: 'suspendedClose', reason: '停牌日不可成交' };
    if (!entry.rules || bar.stalePrevClose) return { ok: true };
    const side = dir === DIR.LONG ? 'sell' : 'buy';
    const ref = Number.isFinite(sealRef) ? sealRef : (side === 'sell' ? bar.low : bar.high);
    const gate = entry.rules.canFillAt(side, px, entry.bars[i - 1]?.close, { closing: true, sealRef: ref });
    return gate.ok ? { ok: true } : { ok: false, bucket: 'boardLockClose', reason: gate.reason };
  }

  _noteReject(date, symbol, gate, label) {
    this.rejected[gate.bucket] = (this.rejected[gate.bucket] || 0) + 1;
    this.rejects.push({ date, symbol, kind: gate.bucket, reason: `${label}：${gate.reason}` });
  }

  _slip(price, side, tick) {
    const t = tick || 1;
    const steps = (this.o.slippageTicks || 0) * t;
    const p = side === 'buy' ? price + steps : price - steps;
    const dec = String(t).includes('.') ? (String(t).split('.')[1] || '').length : 0;
    return Number(p.toFixed(dec));
  }

  _fee(spec, price, lots, { sell = false, closeToday = false } = {}) {
    if (spec.market === 'futures') {
      const plan = closeToday && spec.closeTodayFee ? spec.closeTodayFee : spec.fee;
      if (!plan) return 0;
      const raw = plan.mode === 'rate' ? price * spec.multiplier * lots * plan.value : plan.value * lots;
      return Math.round(raw * 100) / 100;
    }
    const notional = price * spec.multiplier * lots;
    let fee = 0;
    if (spec.fee) {
      fee = spec.fee.mode === 'rate' ? notional * spec.fee.value : spec.fee.value * lots;
      if (spec.fee.min) fee = Math.max(fee, spec.fee.min);
    }
    if (sell && spec.stampTax) fee += notional * spec.stampTax.value;
    if (spec.transferFee) fee += notional * spec.transferFee.value;
    return Math.round(fee * 100) / 100;
  }

  /** 权益 = 共享现金 + 各品种占用保证金 + 各品种浮动盈亏（用该日收盘价盯市）。 */
  _equity(cash, positions, priceOf) {
    let eq = cash;
    for (const p of positions.values()) {
      if (!p.pos) continue;
      const price = priceOf(p);
      eq += p.pos.margin + (p.pos.dir === DIR.LONG ? price - p.pos.lastSettle : p.pos.lastSettle - price) * p.spec.multiplier * p.pos.lots;
    }
    return eq;
  }

  _desiredLots(entry, equity, price, atrValue, vol) {
    const spec = entry.spec;
    const s = this.o.sizing;
    if (s === 'atr') {
      return atrRiskSize({ equity, atrValue, atrMult: this.o.atrMult, multiplier: spec.multiplier, riskPct: this.o.riskPct });
    }
    if (s === 'volTarget') {
      return volTargetSize({ equity, price, multiplier: spec.multiplier, vol, targetVolPct: this.o.targetVolPct });
    }
    return notionalSize({ equity, price, multiplier: spec.multiplier, marginRate: spec.marginRate ?? 0.1, pct: this.o.notionalPct ?? 0.2 });
  }

  run() {
    // 出错时也要给出完整的空结构：调用方普遍会直接 res.rejects.map(...)，
    // 只回一个 {error} 会让上层崩在 undefined 上，而不是读到那句人话错误。
    if (!this.ready) {
      return {
        error: '没有可用品种（每个品种需要 >20 根 bar 和一个策略）',
        trades: [], equityCurve: [], rejects: [], notices: [],
        rejected: { ...this.rejected }, finalEquity: this.o.capital, capital: this.o.capital,
        symbols: [], note: ''
      };
    }
    const o = this.o;

    // 每个品种：因果信号序列、ATR 序列、逐根回看的年化波动率、日期→下标
    const S = this.entries.map(e => {
      const signals = e.strategy.signals(e.bars, e.params) || [];
      const a = atr(e.bars, o.atrLen);
      const closes = e.bars.map(b => b.close);
      const py = e.periodsPerYear || 252;
      // 波动率序列必须逐根只回看：以前这里是「拿全序列末尾 120 根算一次」再复用给每一天，
      // 等于 2010 年的仓位按 2025 年的波动率来定 —— 那是未来函数，不是近似。
      const volSeries = closes.map((_, k) => annualizedVol(closes.slice(Math.max(0, k - 119), k + 1), py));
      return {
        ...e, signals, atrSeries: a, volSeries,
        idxOf: new Map(e.bars.map((b, i) => [String(b.date).slice(0, 10), i])),
        pos: null
      };
    });
    const calendar = [...new Set(S.flatMap(s => s.bars.map(b => String(b.date).slice(0, 10))))].sort();

    let cash = o.capital;
    let wasCashNegative = false;
    const positions = new Map(S.map((s, i) => [i, s]));
    const priceOf = (s) => s._lastClose ?? s.bars[0].close;

    for (let d = 0; d < calendar.length; d++) {
      const date = calendar[d];

      for (const s of positions.values()) {
        const i = s.idxOf.get(date);
        if (i === undefined) continue;              // 今天没有这根 bar（停牌或未上市）：什么也不做
        const bar = s.bars[i];
        s._lastClose = bar.close;
        const spec = s.spec, rules = s.rules;
        const tick = spec.tick || 1;

        // ---- 1. 出场：条件单先判（止损优先），用本根高低价 ----
        if (s.pos && i > s.pos.entryIdx) {
          if (s.pos.orders?.trailCfg) {
            const base = s.pos.dir === DIR.LONG ? s.pos.peak : s.pos.trough;
            if (Number.isFinite(base)) {
              const pct = Number(s.pos.orders.trailCfg.pct);
              if (Number.isFinite(pct) && pct > 0) {
                const cand = s.pos.dir === DIR.LONG ? base * (1 - pct) : base * (1 + pct);
                s.pos.stop = ratchetStop(s.pos.stop ?? null, cand, s.pos.dir);
                const so = s.pos.orders.find(x => x.kind === ORDER_KIND.STOP);
                if (so) so.price = s.pos.stop; else s.pos.orders.push({ kind: ORDER_KIND.STOP, price: s.pos.stop, qtyLots: s.pos.lots, label: '移动止损' });
              }
            }
          }
          const tPlus1Block = rules?.tPlus1 && String(bar.date).slice(0, 10) === String(s.bars[s.pos.entryIdx].date).slice(0, 10);
          if (!tPlus1Block) {
            const { hits, anyHit } = evalExitOrders(s.pos.orders, bar, s.pos.dir);
            if (anyHit) {
              const px = this._slip(hits[0].price, s.pos.dir === DIR.LONG ? 'sell' : 'buy', tick);
              const sealRef = hits[0].gap ? bar.open : (s.pos.dir === DIR.LONG ? bar.low : bar.high);
              const gate = this._closingAllowed(s, px, i, s.pos.dir, sealRef);
              if (gate.ok) cash = this._close(s, px, i, hits[0].gap ? `gap_${hits[0].kind}` : hits[0].kind, cash, date);
              else this._noteReject(date, s.symbol, gate, hits[0].kind);   // 委托不下岗，下一根继续判
            }
          }
        }
        if (s.pos) {
          s.pos.peak = Math.max(s.pos.peak ?? bar.high, bar.high);
          s.pos.trough = Math.min(s.pos.trough ?? bar.low, bar.low);
        }

        // ---- 2. 上一根的信号在本根开盘成交 ----
        const sig = s.signals[i - 1];
        if (sig && i > 0) {
          const want = sig.dir ?? 0;
          if (s.pos && want !== s.pos.dir) {
            const px = this._slip(bar.open, s.pos.dir === DIR.LONG ? 'sell' : 'buy', tick);
            const gate = this._closingAllowed(s, px, i, s.pos.dir, bar.open);
            if (gate.ok) {
              cash = this._close(s, px, i, want === 0 ? 'signal_close' : 'signal_reverse', cash, date);
            } else {
              // 平不掉就不反手：下面开仓分支要求 !s.pos，仓位还在自然跳过
              this._noteReject(date, s.symbol, gate, want === 0 ? '信号平仓' : '信号反手');
            }
          }
          if (want !== 0 && !s.pos) {
            const allowShort = s.allowShort ?? (spec.market === 'futures');
            if (want === DIR.SHORT && !allowShort) {
              this.rejected.shortDisabled = (this.rejected.shortDisabled || 0) + 1;
            } else if ((s.blockedUntilDay ?? -1) > d) {
              this.rejected.reentryBlocked++;
              this.rejects.push({ date, symbol: s.symbol, kind: 'reentryBlocked', reason: `被强平后 ${o.reentryCooldownBars ?? 3} 日内限制开仓` });
            } else {
              const gate = rules ? rules.canOpen(want) : { ok: true };
              if (!gate.ok) { this.rejects.push({ date, symbol: s.symbol, kind: 'open', reason: gate.reason }); }
              else {
                const side = want === DIR.LONG ? 'buy' : 'sell';
                const px = this._slip(bar.open, side, tick);
                const prevBar = s.bars[i - 1];
                const prevClose = prevBar ? prevBar.close : null;
                // 前收盘失效（停牌太久）时不套用板锁：拿三周前的价算今天的涨跌停价是错的
                const stale = bar.stalePrevClose || bar.gapNaturalDays > 8;
                const lock = (rules && !stale) ? rules.canFillAt(side, px, prevClose, { closing: false, sealRef: bar.open }) : { ok: true };
                if (bar.suspended) { this.rejected.suspended++; this.rejects.push({ date, symbol: s.symbol, kind: 'suspended', reason: '停牌日不可成交' }); }
                else if (!lock.ok) { this.rejected.boardLock++; this.rejects.push({ date, symbol: s.symbol, kind: 'boardLock', reason: lock.reason }); }
                else {
                  const equity = this._equity(cash, positions, priceOf);
                  const atrValue = s.atrSeries[i - 1] ?? null;
                  // 与 atrValue 同一口径：成交发生在本根开盘，能看见的只有上一根收盘为止的信息
                  const volValue = s.volSeries[i - 1] ?? null;
                  let lots = this._desiredLots(s, equity, px, atrValue, volValue);
                  const marginRate = spec.marginRate ?? 0.1;
                  // 每手的占用与手续费：占用 = 价×乘数×保证金率（与手数线性），
                  // 写成 px*mult*rate*lots 再乘一次 lots 就是二次方，仓位会被莫名压到几手。
                  const marginPerLot = px * spec.multiplier * marginRate;
                  const feePerLot = this._fee(spec, px, 1, {});
                  // 共享池的约束在这里生效：先按"总敞口上限"卡，再按剩余现金卡
                  const marginCap = Math.max(0, equity * o.maxMarginPct - this._usedMargin(positions));
                  while (lots > 0 && lots * (marginPerLot + feePerLot) > Math.min(marginCap, cash)) lots--;
                  if (lots <= 0) {
                    this.rejected.sizingZero++;
                    this.rejects.push({ date, symbol: s.symbol, kind: 'sizing', reason: `风险预算下算不出整手（权益 ${Math.round(equity)}、ATR ${atrValue ?? '—'}、可用 ${Math.round(cash)}）` });
                  } else {
                    const fee = this._fee(spec, px, lots, {});
                    cash -= (px * spec.multiplier * marginRate * lots + fee);
                    const b = makeBracket({ entryPrice: px, dir: want, stopPct: o.stopPct, rr: o.targetRr });
                    s.pos = {
                      dir: want, lots, entryPrice: px, entryIdx: i, entryDate: date, lastSettle: px,
                      margin: px * spec.multiplier * (spec.marginRate ?? 0.1) * lots, feePaid: fee,
                      stop: b.ok ? b.orders.find(x => x.kind === ORDER_KIND.STOP).price : null,
                      orders: b.ok ? b.orders.slice() : [],
                      peak: bar.high, trough: bar.low, reason: sig.reason || 'signal'
                    };
                    if (b.ok && o.trailPct) s.pos.orders.trailCfg = { pct: o.trailPct };
                  }
                }
              }
            }
          }
        }
      }

      // ---- 3. 当日无负债结算 + 组合层追保/强平 ----
      const equityBefore = this._equity(cash, positions, priceOf);
      if (o.settlement) {
        for (const s of positions.values()) {
          if (!s.pos || d === 0) continue;
          const settle = s._lastClose;
          if (settle === undefined) continue;
          const segPnl = (s.pos.dir === DIR.LONG ? settle - s.pos.lastSettle : s.pos.lastSettle - settle) * s.spec.multiplier * s.pos.lots;
          const newMargin = settle * s.spec.multiplier * (s.spec.marginRate ?? 0.1) * s.pos.lots;
          const eq = cash + s.pos.margin + segPnl;
          s.pos.margin = round2(newMargin);
          s.pos.lastSettle = settle;
          cash = eq - s.pos.margin;
        }
      }
      const equity = this._equity(cash, positions, priceOf);
      const used = this._usedMargin(positions);
      if (used > 0 && equity < used * o.maintenanceRatio) {
        // 强平顺序：浮动亏损最大者优先 —— 强平的目的是降风险敞口，不是均匀减仓。
        // 并且要一次一根地平到"回到维持线以内"为止：只平一根往往仍然越线，
        // 账户会在第二天被同一笔亏损再次打穿，回测就变成「每天强平一次」的假象。
        let eq = equity, u = used, needDeleverage = true;
        while (needDeleverage && this._usedMargin(positions) > 0) {
          const sorted = [...positions.values()].filter(s => s.pos)
            .sort((a, b) => this._lossSinceEntry(a) - this._lossSinceEntry(b));   // 亏得最狠的排前面
          if (!sorted.length) break;
          let didClose = false, closedSymbol = null;
          for (const victim of sorted) {
            const di = victim.idxOf.get(date);
            const bar = di !== undefined ? victim.bars[di] : null;
            const px = this._slip(bar ? bar.close : victim._lastClose, victim.pos.dir === DIR.LONG ? 'sell' : 'buy', victim.spec.tick || 1);
            const gate = this._closingAllowed(victim, px, di, victim.pos.dir, bar && bar.close);
            if (!gate.ok) { this._noteReject(date, victim.symbol, gate, '维持线强平'); continue; }
            cash = this._close(victim, px, di, 'margin_call', cash, date);
            // 强平当天不许立刻按同一信号原样重开：交易所对被强平的会员有限制开仓期，
            // 没有这道闸的话「平仓—重开—再平仓」会主导整段组合曲线，结果只反映撮合顺序而非策略。
            victim.blockedUntilDay = d + (o.reentryCooldownBars ?? 3);
            this.rejected.marginCalls++;
            didClose = true; closedSymbol = victim.symbol;
            break;                                             // 一次一根，平完重新评估敞口
          }
          if (!didClose) {
            // 所有持仓都被板锁/停牌闷住：这天就是降不下来，只能带着超限敞口过夜。
            // 报账户级通知并跳出 —— 继续循环会变成死循环，而真实处境就是连续跌停。
            this.notices.push({ date, kind: 'liquidation_blocked', equity: round2(this._equity(cash, positions, priceOf)),
                                used: round2(this._usedMargin(positions)), symbols: sorted.map(s => s.symbol) });
            break;
          }
          eq = this._equity(cash, positions, priceOf);
          u = this._usedMargin(positions);
          this.notices.push({ date, kind: 'forced_liquidation', symbol: closedSymbol, equity: round2(eq), used: round2(u) });
          needDeleverage = eq < u * o.maintenanceRatio;
        }
      } else if (cash < 0) {
        // 现金为负 = 结算后拿不出钱补足保证金，但权益还撑得住：这是"追加保证金通知"，
        // 不是强平。带 symbol 会让上层误读成某个品种被平了，所以只报账户级字段。
        // 只在"由正转负"那天报一次：追保是一次事件，连续 20 天没补钱不该刷出 20 条通知。
        if (!wasCashNegative) this.notices.push({ date, kind: 'margin_notice', equity: round2(equity), used: round2(used), cash: round2(cash) });
      }
      wasCashNegative = cash < 0;

      this.equityCurve.push({ idx: d, date, equity, cash: round2(cash), margin: round2(used), inPosition: [...positions.values()].some(s => !!s.pos) });
    }

    // 收尾：全部按最后一根收盘平掉，别让浮盈冒充已实现收益
    for (const s of positions.values()) {
      if (!s.pos) continue;
      const lastIdx = s.bars.length - 1;
      cash = this._close(s, s.bars[lastIdx].close, lastIdx, 'end_of_data', cash, calendar[calendar.length - 1]);
    }
    // 期末权益取平仓后的现金：全部持仓了结时权益恒等于现金。
    // 收尾这几笔的 exitDate 就是最后一根 bar，所以它们的手续费属于那一天 ——
    // 曲线最后一个点必须把它算进去，否则「期末权益」和「总收益」会差出一笔费用，
    // 而「期末 = 本金 + Σ净盈亏」这条对账等式也会差出同样的金额（品种越多差得越多）。
    this._endCash = round2(cash);
    const tail = this.equityCurve[this.equityCurve.length - 1];
    if (tail) { tail.equity = this._endCash; tail.cash = this._endCash; tail.margin = 0; tail.inPosition = false; }
    return this._result();
  }

  /**
   * 该品种自建仓以来的盈亏（负数=亏损），用来给强平排序。
   * 不能用"当日浮动"排序：开了逐日盯市以后，结算把当日浮盈转成了现金，
   * lastSettle 被推到当根收盘，当日浮动恒等于 0 —— 排序退化成 Map 的插入顺序，
   * 于是先开的那个品种（哪怕在赚钱）会被首先强平。
   */
  _lossSinceEntry(s) {
    if (!s.pos) return 0;
    const price = s._lastClose ?? s.pos.entryPrice;
    return (s.pos.dir === DIR.LONG ? price - s.pos.entryPrice : s.pos.entryPrice - price) * s.spec.multiplier * s.pos.lots;
  }

  _usedMargin(positions) {
    let m = 0;
    for (const s of positions.values()) if (s.pos) m += s.pos.margin;
    return m;
  }

  _close(s, price, idx, reason, cash, date) {
    const spec = s.spec, pos = s.pos;
    if (!pos) return cash;
    const grossRecord = (pos.dir === DIR.LONG ? price - pos.entryPrice : pos.entryPrice - price) * spec.multiplier * pos.lots;
    const grossCash = (pos.dir === DIR.LONG ? price - pos.lastSettle : pos.lastSettle - price) * spec.multiplier * pos.lots;
    const fee = this._fee(spec, price, pos.lots, { sell: pos.dir === DIR.LONG, closeToday: idx === pos.entryIdx });
    cash += pos.margin + grossCash - fee;
    this.trades.push({
      symbol: s.symbol, name: s.name, id: this.trades.length + 1,
      dir: pos.dir === DIR.LONG ? 'long' : 'short',
      entryIdx: pos.entryIdx, entryDate: pos.entryDate, entryPrice: pos.entryPrice,
      exitIdx: idx, exitDate: date, exitPrice: price, lots: pos.lots,
      gross: round2(grossRecord), fee: round2(pos.feePaid + fee), netPnL: round2(grossRecord - pos.feePaid - fee),
      holdingBars: idx - pos.entryIdx, entryReason: pos.reason, exitReason: reason
    });
    s.pos = null;
    return cash;
  }

  _result() {
    const curve = this.equityCurve;
    const last = curve.length ? curve[curve.length - 1].equity : this.o.capital;
    return {
      trades: this.trades, equityCurve: curve, rejected: { ...this.rejected }, rejects: this.rejects.slice(0, 200),
      notices: this.notices, finalEquity: this._endCash ?? last, capital: this.o.capital,
      symbols: this.entries.map(e => e.symbol),
      sizing: { mode: this.o.sizing, riskPct: this.o.riskPct, atrMult: this.o.atrMult, targetVolPct: this.o.targetVolPct },
      exposure: { maxMarginPct: this.o.maxMarginPct, peakMargin: Math.max(0, ...curve.map(p => p.margin)), settlement: !!this.o.settlement },
      note: '共享现金池：结算价用收盘价代理；不做跨品种对冲保证金减免；组合层不支持部分平仓。'
    };
  }
}
