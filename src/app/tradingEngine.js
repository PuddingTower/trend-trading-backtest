/**
 * 手动复盘交易引擎（单笔持仓模型）。
 *
 * 与自动回测共用 src/core/orders.js 的条件单判定；两条驱动如果各写一套，
 * 同一根 bar 上人工按键和策略信号会给出不同出场点，而且不会报错。
 *
 * 市场差异全部由 useSpec() 注入：期货=保证金/双向/逐日盯市，A股=全额资金/单向/T+1/整手/印花税。
 */
import { ORDER_KIND, ratchetStop, makeBracket, evalExitOrders } from '../core/orders.js';
import { aShareCost, rulesFor } from '../markets/marketRules.js';

export class TradingEngine {
  constructor(profile = null) {
    this.market = profile?.id || 'futures';
    this.spec = null;
    this.initialCapital = 100000;
    this.cash = 100000;
    this.multiplier = 10;      // 吨/手；A股由规格注入为 100
    this.marginRatio = 0.10;   // 10%；A股固定 100% 全额资金
    this.maintenanceRatio = 0.75; // 权益 < 占用×该比例 → 强平（仅期货）
    this.commission = 4.0;     // 元/手（期货）
    this.commRate = 0.00025;   // A股佣金费率（万 2.5）
    this.tPlus1 = this.market === 'ashare';
    this.allowShort = this.market !== 'ashare';
    this.tradable = true;
    this.pendingLiquidation = null; // 上一根触发的强平，下一根开盘执行
    this.pendingExit = null;        // A股 T+1 / 板锁挡住后的待成交平仓
    this._bar = null;
    this._prevBar = null;

    this.position = null;      // { symbol, direction, lots, entryPrice, entryTime, entryIndex, margin }
    this.tradesHistory = [];   // 已平仓记录
    this.tradeMarkers = [];    // 图表买卖标记
    this.equitySnapshots = [{ tradeNum: 0, equity: 100000, positionRate: 0 }]; // 资金净值与仓位记录
    this.actionHistory = [];   // 撤销堆栈
  }

  /** 换品种时由合约规格注入市场口径。A股：乘数 100、全额资金、T+1、仅做多。 */
  useSpec(spec) {
    if (!spec) return;
    this.spec = spec;
    this.market = spec.market || this.market;
    this.multiplier = Number(spec.multiplier) || this.multiplier;
    this.tick = Number(spec.tick) || this.tick || 0.01;
    this.marginRatio = spec.market === 'futures'
      ? (Number(spec.marginRate) || 0.1)
      : 1;
    this.limitPct = Number.isFinite(Number(spec.limitPct)) ? Number(spec.limitPct) : null;
    this.tPlus1 = spec.market === 'ashare';
    this.allowShort = spec.market !== 'ashare' || !!spec.allowShort;
    this.tradable = spec.tradable !== false;
    if (spec.market === 'ashare' && spec.fee?.mode === 'rate') this.commRate = spec.fee.value;
  }

  reset(initialCapital = 100000) {
    this.initialCapital = initialCapital;
    this.cash = initialCapital;
    this.position = null;
    this.pendingLiquidation = null;
    this.pendingExit = null;
    this._bar = null;
    this._prevBar = null;
    this.tradesHistory = [];
    this.tradeMarkers = [];
    this.equitySnapshots = [{ tradeNum: 0, equity: initialCapital, positionRate: 0 }];
    this.actionHistory = [];
  }

  /** 每次推进一根 K 线时更新：涨跌停判定要用前收，T+1 要用交易日。 */
  setBarContext(bar, prevBar, prevDayClose = null) {
    this._bar = bar || null;
    this._prevBar = prevBar || null;
    this._prevDayClose = Number.isFinite(prevDayClose) && prevDayClose > 0 ? prevDayClose : null;
  }

  _dayOf(time) { return String(time || '').slice(0, 10); }
  _prevClose() {
    // A股板幅锚定的是**前一交易日收盘价**；60m 序列里上一根 bar 只是同一交易日的上一小时。
    if (this._prevDayClose) return this._prevDayClose;
    return this._prevBar && Number(this._prevBar.close) > 0 ? Number(this._prevBar.close) : null;
  }
  _qtyText(lots) {
    return this.market === 'ashare' ? `${lots}手/${lots * Math.round(this.multiplier)}股` : `${lots}手`;
  }

  _ashareCostSpec() {
    return {
      ...(this.spec || {}),
      market: 'ashare',
      multiplier: this.multiplier,
      fee: { mode: 'rate', value: this.commRate, min: 5 }
    };
  }

  _entryFee(price, lots) {
    return this.market === 'ashare'
      ? aShareCost(this._ashareCostSpec(), price, lots, { sell: false })
      : this.commission * lots;
  }

  _exitFee(price, lots) {
    return this.market === 'ashare'
      ? aShareCost(this._ashareCostSpec(), price, lots, { sell: true })
      : this.commission * lots;
  }

  _marginFor(price, lots) {
    return price * this.multiplier * lots * this.marginRatio;
  }

  /**
   * 板锁只在 A股 这一层接。期货板幅要先有交易所当日参数，规格表给的是常见值，
   * 拿它当硬门会把"今天能不能成交"变成一个默认值猜出来的结论。
   */
  _fillCheck(side, price, { closing = false } = {}) {
    if (this.market !== 'ashare') return { ok: true };
    const prevClose = this._prevClose();
    if (!prevClose) return { ok: true };
    const rules = rulesFor({ ...this._ashareCostSpec(), limitPct: this.limitPct });
    return rules.canFillAt(side, price, prevClose, { closing });
  }

  /** A股 T+1：当日买入（含当日加仓）的股份不能当日卖出。 */
  _canCloseAt(time) {
    if (!this.tPlus1) return true;
    const pos = this.position;
    if (!pos) return true;
    const day = this._dayOf(time);
    const entryDay = this._dayOf(pos.entryTime);
    const addDay = pos.lastAddTime ? this._dayOf(pos.lastAddTime) : null;
    return day !== entryDay && (addDay === null || day !== addDay);
  }

  /**
   * 平仓统一入口：T+1 或封板时挂成"待成交"，下一根开盘再试。
   * 止损/条件单都必须走这里 —— 直接调 _closeLots 会把当日买入的股票当天卖掉。
   */
  requestExit(price, time, barIndex, reason, tag = '', lots = null) {
    const pos = this.position;
    if (!pos) return { success: false, message: '当前无持仓' };
    const qty = Math.max(1, Math.min(pos.lots, Math.round(lots ?? pos.lots)));
    if (!this._canCloseAt(time)) {
      this.pendingExit = { price, reason, tag, lots: qty };
      return { deferred: true, message: 'A股 T+1：当日买入不能当日卖出，平仓已挂到下一交易日开盘' };
    }
    const fill = this._fillCheck('sell', price, { closing: true });
    if (!fill.ok) {
      this.pendingExit = { price, reason, tag, lots: qty };
      return { deferred: true, message: `封板无法卖出：${fill.reason}；下一根继续尝试` };
    }
    return this._closeLots(price, time, barIndex, qty, reason, tag);
  }


      getTotalEquity(currentPrice) {
        if (!this.position) return this.cash;
        const floating = this.calcFloatingPnL(currentPrice);
        return this.cash + this.position.margin + floating;
      }

      calcFloatingPnL(currentPrice) {
        if (!this.position) return 0;
        const diff = this.position.direction === 'long' 
          ? (currentPrice - this.position.entryPrice)
          : (this.position.entryPrice - currentPrice);
        return diff * this.multiplier * this.position.lots;
      }

      /**
       * 当前持仓的保证金风险。
       * 权益 = 可用现金 + 已占用保证金 + 浮动盈亏；维持线 = 当前价重算的占用 × 维持比例。
       * A股/全额占用（marginRatio=1）没有杠杆，返回 null —— 不能把期货强平套到股票上。
       */
      marginState(price) {
        const pos = this.position;
        if (!pos || !(price > 0) || !(this.marginRatio < 1 - 1e-9)) return null;
        const qty = this.multiplier * pos.lots;
        if (!(qty > 0)) return null;
        const rate = this.marginRatio;
        const ratio = this.maintenanceRatio;
        const equity = this.getTotalEquity(price);
        const marginReq = price * qty * rate;
        const maintenance = marginReq * ratio;
        const base = pos.entryPrice;
        const denomL = pos.direction === 'long' ? 1 - rate * ratio : 1 + rate * ratio;
        const denomC = pos.direction === 'long' ? 1 - rate : 1 + rate;
        const liqPrice = denomL > 1e-9
          ? (pos.direction === 'long'
              ? (base * qty - this.cash - pos.margin) / (qty * denomL)
              : (base * qty + this.cash + pos.margin) / (qty * denomL))
          : null;
        const callPrice = denomC > 1e-9
          ? (pos.direction === 'long'
              ? (base * qty - this.cash - pos.margin) / (qty * denomC)
              : (base * qty + this.cash + pos.margin) / (qty * denomC))
          : null;
        return {
          equity, marginReq, maintenance,
          riskRatio: equity > 0 ? marginReq / equity : Infinity,
          liqPrice: Number.isFinite(liqPrice) && liqPrice > 0 ? liqPrice : null,
          callPrice: Number.isFinite(callPrice) && callPrice > 0 ? callPrice : null
        };
      }

      /** 开盘检查：昨日挂起的强平先执行；跳空直接穿维持线也按开盘价平。 */
      liquidateAtOpen(bar, barIndex) {
        if (!this.position) { this.pendingLiquidation = null; return null; }
        if (!bar) return null;
        const m = this.marginState(bar.open);
        if (!m) return null;                         // A股/全额占用：不适用
        if (this.pendingLiquidation) {
          if (m.equity >= m.maintenance) {
            this.pendingLiquidation = null;
            return { kind: 'cancelled', message: '开盘权益已回到维持线之上，撤销强平挂单' };
          }
          return this._forceClose(bar, barIndex, m, '维持线强平');
        }
        if (m.equity < m.maintenance) {
          return this._forceClose(bar, barIndex, m, '跳空穿维持线');
        }
        return null;
      }

      /** 盘中/收盘检查：用本根已走完的高低价判定，触发后挂到下一根开盘执行。 */
      queueMarginExtreme(bar, barIndex) {
        const pos = this.position;
        if (!pos || !bar || this.pendingLiquidation) return null;
        const adverse = pos.direction === 'long' ? bar.low : bar.high;
        const m = this.marginState(adverse);
        if (!m) return null;
        const hitCall = m.callPrice !== null && (pos.direction === 'long'
          ? bar.low <= m.callPrice + 1e-9 : bar.high >= m.callPrice - 1e-9);
        const hitLiq = m.liqPrice !== null && (pos.direction === 'long'
          ? bar.low <= m.liqPrice + 1e-9 : bar.high >= m.liqPrice - 1e-9);
        if (hitLiq) {
          this.pendingLiquidation = { triggerPrice: m.liqPrice, triggerIndex: barIndex, dir: pos.direction };
          return { kind: 'pending', message: `盘中触及维持线 ${m.liqPrice.toFixed(2)}，下一根开盘强平（当前权益 ${Math.round(m.equity).toLocaleString()} / 维持线 ${Math.round(m.maintenance).toLocaleString()}）` };
        }
        if (hitCall && !pos.marginCalled) {
          pos.marginCalled = true;
          return { kind: 'call', message: `权益跌破保证金占用（风险度 ${(m.riskRatio * 100).toFixed(0)}%），注意追保；跌破维持线将强平` };
        }
        return null;
      }

      _forceClose(bar, barIndex, m, why) {
        const pos = this.position;
        if (!pos) return null;
        const price = bar.open;
        // 一字板在同一价位没有对手盘：想卖（多）或想买回（空）都排在队尾。
        // 不知道真实板幅时，用"整根 bar 一个价且对持仓不利"作保守判据；次日继续尝试。
        const locked = bar.high === bar.low && (pos.direction === 'long'
          ? bar.close < pos.entryPrice : bar.close > pos.entryPrice);
        if (locked) {
          this.pendingLiquidation = this.pendingLiquidation || { triggerPrice: m.liqPrice, triggerIndex: barIndex, dir: pos.direction };
          return { kind: 'blocked', message: `${why}无法成交：一字板无对手盘，仓位保留，下一根继续` };
        }
        const lots = pos.lots;
        const res = this._closeLots(price, bar.date, barIndex, lots, 'margin_call', '强制平仓');
        this.pendingLiquidation = null;
        return {
          kind: 'forced', trade: res.trade,
          message: `${why}：${lots} 手 @ ${price}，权益 ${Math.round(m.equity).toLocaleString()} / 维持线 ${Math.round(m.maintenance).toLocaleString()}`
        };
      }

      openLong(symbol, price, lots, time, barIndex) {
        if (!this.tradable) throw new Error('该品种不可直接交易（指数只能看图，请用 ETF 或股指期货）');
        lots = Math.max(1, Math.round(Number(lots) || 1));
        if (this.position) {
          if (this.position.direction === 'short') {
            throw new Error("当前持有空单！请先点击【一键平仓】，再开多单。");
          }
          throw new Error("已有持仓！暂支持单笔持仓管理，请先平仓。");
        }
        const fill = this._fillCheck('buy', price, { closing: false });
        if (!fill.ok) throw new Error(`买不进：${fill.reason}`);

        const marginNeeded = this._marginFor(price, lots);
        const fee = this._entryFee(price, lots);

        if (this.cash < marginNeeded + fee) {
          throw new Error(`可用资金不足！需要${this.market === 'ashare' ? '买入金额' : '保证金'} ${marginNeeded.toFixed(2)} 元 + 手续费 ${fee} 元。`);
        }

        const prevState = this.captureState();
        this.cash -= (marginNeeded + fee);
        this.pendingLiquidation = null;
        this.pendingExit = null;
        this.position = {
          symbol,
          direction: 'long',
          lots,
          entryPrice: price,
          entryTime: time,
          entryIndex: barIndex,
          margin: marginNeeded,
          openFee: fee,
          lastAddTime: null,
          orders: [],
          peak: price,
          trough: price
        };

        const marker = {
          barIndex,
          time,
          price,
          type: 'buy_long',
          direction: 'long',
          lots,
          text: `买开 ${this._qtyText(lots)} @ ${price}`
        };
        this.tradeMarkers.push(marker);
        this.actionHistory.push({ action: 'open', prevState });

        return { success: true, message: `成功买入 ${this._qtyText(lots)} @ ${price}` };
      }

      openShort(symbol, price, lots, time, barIndex) {
        if (!this.tradable) throw new Error('该品种不可直接交易（指数只能看图，请用 ETF 或股指期货）');
        lots = Math.max(1, Math.round(Number(lots) || 1));
        if (!this.allowShort) {
          throw new Error('A股默认仅做多（两融做空未开启），不能卖出开空。');
        }
        if (this.position) {
          if (this.position.direction === 'long') {
            throw new Error("当前持有多单！请先点击【一键平仓】，再开空单。");
          }
          throw new Error("已有持仓！暂支持单笔持仓管理，请先平仓。");
        }

        const marginNeeded = this._marginFor(price, lots);
        const fee = this._entryFee(price, lots);

        if (this.cash < marginNeeded + fee) {
          throw new Error(`可用资金不足！需要保证金 ${marginNeeded.toFixed(2)} 元 + 手续费 ${fee} 元。`);
        }

        const prevState = this.captureState();
        this.cash -= (marginNeeded + fee);
        this.pendingLiquidation = null;
        this.pendingExit = null;
        this.position = {
          symbol,
          direction: 'short',
          lots,
          entryPrice: price,
          entryTime: time,
          entryIndex: barIndex,
          margin: marginNeeded,
          openFee: fee,
          lastAddTime: null,
          orders: [],
          peak: price,
          trough: price
        };

        const marker = {
          barIndex,
          time,
          price,
          type: 'sell_short',
          direction: 'short',
          lots,
          text: `卖开 ${this._qtyText(lots)} @ ${price}`
        };
        this.tradeMarkers.push(marker);
        this.actionHistory.push({ action: 'open', prevState });

        return { success: true, message: `成功卖出开空 ${this._qtyText(lots)} @ ${price}` };
      }

      /**
       * 逐根 mark-to-market 权益序列。口径与已实现曲线严格一致：
       * 已实现部分只在平仓那一根切换到引擎自己记的 equityAfter（含双边手续费），
       * 持仓期间按该根收盘价计浮动盈亏并挂着开仓费——与 getTotalEquity 逐项等价。
       * 本引擎为单笔持仓模型，故任一时刻至多一笔在持仓。
       */
      buildFloatingEquitySeries(bars) {
        const out = [];
        const closed = this.tradesHistory;
        const open = this.position;
        let ci = 0;
        for (let i = 0; i < bars.length; i++) {
          // 平仓那一根起，权益直接取引擎自己记的 equityAfter，避免二次推导产生偏差
          while (ci < closed.length && closed[ci].exitIndex <= i) ci++;
          let equity = ci === 0 ? this.initialCapital : closed[ci - 1].equityAfter;

          let held = null;
          for (const t of closed) {
            if (t.entryIndex <= i && i < t.exitIndex) { held = t; break; }
          }
          const holdingOpen = !held && open && open.entryIndex <= i;
          if (holdingOpen) held = open;

          if (held) {
            // 开仓费在进场时已从现金扣走、平仓才退回，持仓期间必须挂着它
            const openFee = held.openFee !== undefined
              ? held.openFee
              : (held.fee !== undefined ? held.fee / 2 : this.commission * held.lots);
            const diff = held.direction === 'long'
              ? bars[i].close - held.entryPrice
              : held.entryPrice - bars[i].close;
            equity += diff * this.multiplier * held.lots - openFee;
          }
          out.push({ barIndex: i, date: bars[i].date, equity });
        }
        return out;
      }

      closePosition(exitPrice, exitTime, exitBarIndex) {
        if (!this.position) {
          throw new Error("当前无持仓，无法平仓！");
        }
        if (!this._canCloseAt(exitTime)) {
          throw new Error('A股 T+1：当日买入的股份不能当日卖出，请下一交易日再平仓');
        }
        const fill = this._fillCheck('sell', exitPrice, { closing: true });
        if (!fill.ok) throw new Error(`卖不出：${fill.reason}`);

        const prevState = this.captureState();
        const pos = this.position;
        const pointDiff = pos.direction === 'long' ? (exitPrice - pos.entryPrice) : (pos.entryPrice - exitPrice);
        const grossPnL = pointDiff * this.multiplier * pos.lots;
        const exitFee = this._exitFee(exitPrice, pos.lots);
        const openFee = pos.openFee ?? (this.market === 'ashare' ? this._entryFee(pos.entryPrice, pos.lots) : this.commission * pos.lots);
        const totalFee = openFee + exitFee;
        const netPnL = grossPnL - exitFee;

        this.cash += (pos.margin + netPnL);
        const currentEquity = this.cash;
        const holdingBars = Math.max(1, exitBarIndex - pos.entryIndex);
        const pctChg = ((pointDiff / pos.entryPrice) * 100);

        const tradeRecord = {
          id: this.tradesHistory.length + 1,
          symbol: pos.symbol,
          direction: pos.direction,
          entryIndex: pos.entryIndex,
          exitIndex: exitBarIndex,
          entryTime: pos.entryTime,
          exitTime: exitTime,
          entryPrice: pos.entryPrice,
          exitPrice: exitPrice,
          lots: pos.lots,
          points: pointDiff,
          pct: pctChg,
          grossPnL: grossPnL,
          fee: totalFee,
          openFee,
          exitFee,
          netPnL: netPnL,
          holdingBars,
          exitReason: 'manual',
          exitTag: '手动平仓',
          equityAfter: currentEquity,
          // 平仓前的仓位占用率：用平仓前权益（现金 + 释放的保证金 + 本笔毛盈亏）做分母
          positionRate: (() => {
            const preEquity = currentEquity + exitFee;
            return preEquity > 0 ? (pos.margin / preEquity) * 100 : 0;
          })()
        };

        this.tradesHistory.push(tradeRecord);
        this.equitySnapshots.push({
          tradeNum: this.tradesHistory.length,
          equity: currentEquity,
          positionRate: tradeRecord.positionRate
        });
        this.tradeMarkers.push({
          barIndex: exitBarIndex,
          time: exitTime,
          price: exitPrice,
          type: 'close',
          direction: pos.direction === 'long' ? 'sell_close' : 'buy_close',
          lots: pos.lots,
          text: `平仓 ${this._qtyText(pos.lots)} @ ${exitPrice} (${netPnL >= 0 ? '+' : ''}${netPnL.toFixed(0)})`
        });

        this.position = null;
        this.pendingLiquidation = null;
        this.pendingExit = null;
        this.actionHistory.push({ action: 'close', prevState });

        return { success: true, trade: tradeRecord };
      }

      /**
       * 挂条件单（M4）。所有触发判定都走 src/core/orders.js —— 与自动回测调的是同一个函数。
       * 两边各写一套的话，同一段行情下人工按键和策略信号会给出不同出场点，
       * 而这个差异不会报错，只会让人以为自己练出来的手感"就是"策略的行为。
       */
      attachConditional(cfg = {}) {
        if (!this.position) return { success: false, message: '当前无持仓，无法挂条件单' };
        const pos = this.position;
        const dir = pos.direction === 'long' ? 1 : -1;
        const bracket = makeBracket({
          entryPrice: pos.entryPrice, dir,
          stopPrice: cfg.stopPrice, stopPct: cfg.stopPct,
          targetPrice: cfg.targetPrice, targetPct: cfg.targetPct, rr: cfg.rr,
          trailPct: cfg.trailPct
        });
        if (!bracket.ok) return { success: false, message: bracket.reason };

        const prevState = this.captureState();
        // 同 kinds 覆盖而不是追加：券商里「改止损」就是替换，追加会叠出两张止损单，
        // 而两张都成立时先成交哪张取决于数组顺序 —— 复盘的人完全看不出来。
        const incoming = bracket.orders.map(o => ({ ...o, qtyLots: o.qty ?? pos.lots }));
        const kinds = new Set(incoming.map(o => o.kind));
        const kept = (pos.orders || []).filter(o => !kinds.has(o.kind) || o.qtyLots === 0);
        pos.orders = kept.concat(incoming);
        if (bracket.trail) pos.trailCfg = bracket.trail;
        const stopOrder = pos.orders.find(o => o.kind === ORDER_KIND.STOP);
        if (stopOrder) pos.stop = ratchetStop(pos.stop ?? null, stopOrder.price, dir);
        pos.peak = pos.direction === 'long' ? pos.entryPrice : -Infinity;
        pos.trough = pos.direction === 'long' ? Infinity : pos.entryPrice;
        this.actionHistory.push({ action: 'order', prevState });
        const labels = pos.orders.map(o => `${o.label} ${o.price}`).join(' / ');
        return { success: true, message: `已挂条件单：${labels}`, orders: pos.orders, risk: bracket.risk };
      }

      clearConditional() {
        if (!this.position) return { success: false, message: '当前无持仓' };
        const prevState = this.captureState();
        this.position.orders = [];
        this.position.trailCfg = null;
        this.actionHistory.push({ action: 'clearOrder', prevState });
        return { success: true, message: '已撤掉全部条件单' };
      }

      /**
       * 每揭示一根新 bar 调一次：先把移动止损收紧，再判是否触发。
       * 移动止损用「截至上一根」的极值 —— 拿本根最高价抬止损、又在同一根判触发，
       * 等于假设你永远在最有利的那一下按了按钮。
       */
      evaluateConditional(bar, barIndex) {
        const pos = this.position;
        const out = { closed: [], deferred: null };
        if (!pos || barIndex <= pos.entryIndex || !bar) return out;
        const dir = pos.direction === 'long' ? 1 : -1;
        // 收紧只用「截至上一根」的极值：先判触发，再把本根极值并进 peak ——
        // 顺序反了就等于假设你在本根最高点的那一刻手动把止损抬上去，同一根里又用它判出场。
        if (pos.trailCfg && Number(pos.trailCfg.pct) > 0) {
          const base = pos.direction === 'long' ? pos.peak : pos.trough;
          if (Number.isFinite(base)) {
            const cand = pos.direction === 'long'
              ? base * (1 - Number(pos.trailCfg.pct)) : base * (1 + Number(pos.trailCfg.pct));
            pos.stop = ratchetStop(pos.stop ?? null, cand, dir);
            const so = (pos.orders || []).find(o => o.kind === ORDER_KIND.STOP);
            if (so) so.price = pos.stop;
            else pos.orders = (pos.orders || []).concat([{ kind: ORDER_KIND.STOP, price: pos.stop, qtyLots: pos.lots, label: '移动止损' }]);
          }
        }
        const { hits, anyHit } = evalExitOrders(pos.orders || [], bar, dir);
        if (anyHit) {
          for (const h of hits) {
            if (!this.position || !this.position.lots) break;
            const lots = Math.min(this.position.lots, h.order.qtyLots ?? this.position.lots);
            const res = this.requestExit(h.price, bar.date, barIndex, h.gap ? `gap_${h.kind}` : h.kind, h.order.label, lots);
            if (res.deferred) {
              out.deferred = { message: res.message, tag: h.order.label };
              break;                            // 委托仍挂着，等下一根开盘
            }
            h.order.qtyLots = 0;                 // 一次性委托，成交过就不再挂
            if (res.trade) out.closed.push(res.trade);
          }
        }
        if (this.position) {
          const p = this.position;
          p.orders = (p.orders || []).filter(o => (o.qtyLots ?? 0) > 0);
          if (p.direction === 'long') p.peak = Math.max(p.peak ?? bar.high, bar.high);
          else p.trough = Math.min(p.trough ?? bar.low, bar.low);
        }
        return out;
      }

      /** 部分平仓：按比例释放保证金，均价不变，剩下的继续跑条件单。 */
      _closeLots(price, time, barIndex, lots, reason, tag = '') {
        const pos = this.position;
        if (!pos) return { success: false, message: '当前无持仓' };
        const closing = Math.max(1, Math.min(pos.lots, Math.round(lots)));
        if (!this._canCloseAt(time)) {
          this.pendingExit = { price, reason, tag, lots: closing };
          return { deferred: true, message: 'A股 T+1：当日买入不能当日卖出，已挂到下一交易日开盘' };
        }
        const fill = this._fillCheck('sell', price, { closing: true });
        if (!fill.ok) {
          this.pendingExit = { price, reason, tag, lots: closing };
          return { deferred: true, message: `封板无法卖出：${fill.reason}；下一根继续尝试` };
        }
        const prevState = this.captureState();
        const frac = closing / pos.lots;
        const pointDiff = pos.direction === 'long' ? (price - pos.entryPrice) : (pos.entryPrice - price);
        const grossPnL = pointDiff * this.multiplier * closing;
        const openFee = (pos.openFee ?? (this.market === 'ashare'
          ? this._entryFee(pos.entryPrice, pos.lots)
          : this.commission * pos.lots)) * frac;
        const exitFee = this._exitFee(price, closing);
        const fee = openFee + exitFee;
        const netPnL = grossPnL - exitFee;
        const marginReleased = pos.margin * frac;
        this.cash += marginReleased + netPnL;
        pos.lots -= closing;
        pos.margin = Math.round(pos.margin - marginReleased);
        pos.openFee = Math.max(0, (pos.openFee ?? 0) - openFee);
        const holdingBars = Math.max(1, barIndex - pos.entryIndex);
        const tradeRecord = {
          id: this.tradesHistory.length + 1, symbol: pos.symbol, direction: pos.direction,
          entryIndex: pos.entryIndex, exitIndex: barIndex, entryTime: pos.entryTime, exitTime: time,
          entryPrice: pos.entryPrice, exitPrice: price, lots: closing,
          points: pointDiff, pct: (pointDiff / pos.entryPrice) * 100,
          grossPnL, fee, openFee, exitFee, netPnL, holdingBars,
          exitReason: reason || 'manual', exitTag: tag,
          partial: closing < (pos.lots + closing),
          equityAfter: this.cash,
          positionRate: (this.cash + pos.margin) > 0 ? (pos.margin / (this.cash + pos.margin)) * 100 : 0
        };
        this.tradesHistory.push(tradeRecord);
        this.equitySnapshots.push({ tradeNum: this.tradesHistory.length, equity: this.cash, positionRate: tradeRecord.positionRate });
        this.tradeMarkers.push({
          barIndex, time, price, type: 'close',
          direction: pos.direction === 'long' ? 'sell_close' : 'buy_close',
          lots: closing, text: `${tag || '平仓'} ${this._qtyText(closing)} @ ${price} (${netPnL >= 0 ? '+' : ''}${netPnL.toFixed(0)})`
        });
        const emptied = pos.lots <= 0;
        if (emptied) { this.position = null; this.pendingLiquidation = null; this.pendingExit = null; }
        this.actionHistory.push({ action: 'close', prevState });
        return { success: true, trade: tradeRecord, emptied };
      }

      /**
       * 下一根开盘处理挂起的平仓（T+1 或封板）。
       * 必须放在开盘价上执行：委托是上一交易日收盘后挂出的，成交只能发生在下一个可交易时点。
       */
      resolvePendingExit(bar, barIndex) {
        const pos = this.position;
        if (!pos || !this.pendingExit || !bar) return null;
        if (!this._canCloseAt(bar.date)) return null;
        const qty = Math.min(pos.lots, Math.max(1, Math.round(this.pendingExit.lots || pos.lots)));
        const res = this._closeLots(bar.open, bar.date, barIndex, qty, this.pendingExit.reason, this.pendingExit.tag);
        if (res.deferred) return null;
        this.pendingExit = null;
        return res.trade || null;
      }

      partialClose(lots, price, time, barIndex) {
        if (!this.position) throw new Error('当前无持仓，无法部分平仓');
        const n = Math.max(1, Math.round(Number(lots) || 1));
        if (n >= this.position.lots) return this.closePosition(price, time, barIndex);
        return this._closeLots(price, time, barIndex, n, 'manual_partial', '减仓');
      }

      /**
       * 金字塔加仓：均价按手数加权，越加越贵，所以规模必须递减 ——
       * 等额加仓会把均价推到接近现价，一个正常回调就把整段浮盈打成亏损。
       */
      addToPosition(symbol, price, lots, time, barIndex) {
        const pos = this.position;
        if (!pos) return { success: false, message: '当前无持仓，先开仓再加仓' };
        if (pos.symbol !== symbol && symbol) return { success: false, message: '持仓品种不同，不能加仓' };
        const fill = this._fillCheck('buy', price, { closing: false });
        if (!fill.ok) return { success: false, message: `买不进：${fill.reason}` };
        const add = Math.max(1, Math.round(Number(lots) || 1));
        const marginNeeded = this._marginFor(price, add);
        const fee = this._entryFee(price, add);
        if (this.cash < marginNeeded + fee) {
          return { success: false, message: `可用资金不足，加仓需 ${marginNeeded.toFixed(2)} + ${fee.toFixed(2)}` };
        }
        const prevState = this.captureState();
        const total = pos.lots + add;
        pos.entryPrice = Math.round(((pos.entryPrice * pos.lots + price * add) / total) * 1e6) / 1e6;
        pos.lots = total;
        pos.margin += marginNeeded;
        pos.openFee = (pos.openFee ?? 0) + fee;
        pos.lastAddTime = time;
        this.cash -= (marginNeeded + fee);
        pos.orders = (pos.orders || []).map(o => ({ ...o, qtyLots: total }));
        this.tradeMarkers.push({
          barIndex, time, price, type: pos.direction === 'long' ? 'buy_long' : 'sell_short',
          direction: pos.direction, lots: add, text: `加仓 ${this._qtyText(add)} @ ${price}（均价 ${pos.entryPrice.toFixed(2)}）`
        });
        this.actionHistory.push({ action: 'add', prevState });
        return { success: true, message: `加仓 ${this._qtyText(add)} @ ${price}，均价 ${pos.entryPrice.toFixed(2)}`, avgPrice: pos.entryPrice };
      }

      captureState() {
        return {
          cash: this.cash,
          // 条件单挂的是数组，浅拷贝会让撤销恢复到「已经被成交消耗掉」的那份状态 ——
          // 挂单后撤销一次，止损单就凭空消失了。这里必须深拷贝。
          position: this.position ? JSON.parse(JSON.stringify(this.position)) : null,
          tradesHistory: JSON.parse(JSON.stringify(this.tradesHistory)),
          tradeMarkers: JSON.parse(JSON.stringify(this.tradeMarkers)),
          equitySnapshots: JSON.parse(JSON.stringify(this.equitySnapshots)),
          pendingLiquidation: this.pendingLiquidation ? JSON.parse(JSON.stringify(this.pendingLiquidation)) : null,
          pendingExit: this.pendingExit ? JSON.parse(JSON.stringify(this.pendingExit)) : null
        };
      }

      undo() {
        if (this.actionHistory.length === 0) return false;
        const last = this.actionHistory.pop();
        const prev = last.prevState;
        this.cash = prev.cash;
        this.position = prev.position;
        this.tradesHistory = prev.tradesHistory;
        this.tradeMarkers = prev.tradeMarkers;
        this.equitySnapshots = prev.equitySnapshots;
        this.pendingLiquidation = prev.pendingLiquidation ?? null;
        this.pendingExit = prev.pendingExit ?? null;
        return true;
      }

      // 计算4象限专业量化绩效指标 (匹配参考图 Image 1 & Image 5)
      getComprehensiveStatistics(currentPrice, totalReplayBars = 260) {
        const totalTrades = this.tradesHistory.length;
        const currentEquity = this.getTotalEquity(currentPrice);
        const netProfit = currentEquity - this.initialCapital;
        const returnRate = (netProfit / this.initialCapital) * 100;

        if (totalTrades === 0) {
          return {
            totalTrades: 0,
            winRate: 0,
            lossRate: 0,
            winCount: 0,
            lossCount: 0,
            avgProfitRatio: 0,
            profitFactor: 0,
            maxConsecutiveWins: 0,
            expectancyR: 0,
            compoundRate: 1.0,
            avgWin: 0,
            maxWin: 0,
            extremeProfitRatio: 0,
            maxWinContribution: 0,
            returnToDrawdown: 0,
            maxDrawdownAmount: 0,
            maxDrawdownPercent: 0,
            avgLoss: 0,
            maxLoss: 0,
            maxConsecutiveLosses: 0,
            totalFills: 0,
            totalFees: 0,
            feeToCapital: 0,
            avgHoldingBars: 0,
            intervalSpan: totalReplayBars,
            currentEquity,
            netProfit,
            returnRate
          };
        }

        let winCount = 0;
        let lossCount = 0;
        let totalWinAmount = 0;
        let totalLossAmount = 0;
        let maxWin = 0;
        let maxLoss = 0;
        let curWins = 0, maxConsecutiveWins = 0;
        let curLosses = 0, maxConsecutiveLosses = 0;
        let totalHoldingBars = 0;
        let totalFees = 0;

        for (const t of this.tradesHistory) {
          totalHoldingBars += t.holdingBars;
          totalFees += t.fee;

          if (t.netPnL > 0) {
            winCount++;
            totalWinAmount += t.netPnL;
            if (t.netPnL > maxWin) maxWin = t.netPnL;

            curWins++;
            curLosses = 0;
            if (curWins > maxConsecutiveWins) maxConsecutiveWins = curWins;
          } else if (t.netPnL < 0) {
            lossCount++;
            totalLossAmount += Math.abs(t.netPnL);
            if (Math.abs(t.netPnL) > maxLoss) maxLoss = Math.abs(t.netPnL);

            curLosses++;
            curWins = 0;
            if (curLosses > maxConsecutiveLosses) maxConsecutiveLosses = curLosses;
          } else {
            curWins = 0;
            curLosses = 0;
          }
        }

        const winRate = (winCount / totalTrades) * 100;
        const lossRate = (lossCount / totalTrades) * 100;
        const avgWin = winCount > 0 ? (totalWinAmount / winCount) : 0;
        const avgLoss = lossCount > 0 ? (totalLossAmount / lossCount) : 0;

        const avgProfitRatio = avgLoss > 0 ? (avgWin / avgLoss) : (totalWinAmount > 0 ? 99.9 : 0);
        const profitFactor = totalLossAmount > 0 ? (totalWinAmount / totalLossAmount) : (totalWinAmount > 0 ? 99.9 : 0);

        // 每单期望 R: (胜率 * 平均赚 - 负率 * 平均亏) / 平均亏
        const expectancyR = avgLoss > 0 ? (((winRate / 100) * avgWin - (lossRate / 100) * avgLoss) / avgLoss) : 0;

        // 账户复利
        const compoundRate = currentEquity / this.initialCapital;

        // 极值盈亏比: 最大盈利 / 平均亏损
        const extremeProfitRatio = avgLoss > 0 ? (maxWin / avgLoss) : 0;

        // 最大单笔贡献率 %
        const maxWinContribution = totalWinAmount > 0 ? ((maxWin / totalWinAmount) * 100) : 0;

        // 最大回撤
        let peak = this.initialCapital;
        let maxDrawdownAmount = 0;
        let maxDrawdownPercent = 0;
        for (const snap of this.equitySnapshots) {
          if (snap.equity > peak) peak = snap.equity;
          const dd = peak - snap.equity;
          const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
          if (dd > maxDrawdownAmount) maxDrawdownAmount = dd;
          if (ddPct > maxDrawdownPercent) maxDrawdownPercent = ddPct;
        }

        // 收益回撤比 (净盈亏 / 回撤金额)
        const returnToDrawdown = maxDrawdownAmount > 0 ? (netProfit / maxDrawdownAmount) : (netProfit > 0 ? 99.9 : 0);

        return {
          totalTrades,
          winRate,
          lossRate,
          winCount,
          lossCount,
          avgProfitRatio,
          profitFactor,
          maxConsecutiveWins,
          expectancyR,
          compoundRate,
          avgWin,
          maxWin,
          extremeProfitRatio,
          maxWinContribution,
          returnToDrawdown,
          maxDrawdownAmount,
          maxDrawdownPercent,
          avgLoss,
          maxLoss,
          maxConsecutiveLosses,
          totalFills: totalTrades * 2,
          totalFees,
          feeToCapital: (totalFees / this.initialCapital) * 100,
          avgHoldingBars: (totalHoldingBars / totalTrades),
          intervalSpan: totalReplayBars,
          currentEquity,
          netProfit,
          returnRate
        };
      }
    }
