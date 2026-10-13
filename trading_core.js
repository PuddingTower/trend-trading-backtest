/**
 * 国内期货手动复盘与划线模拟交易回测系统 - 核心模块库
 * 包含：
 * 1. MockDataGenerator (仿真行情生成器)
 * 2. TradingEngine (双向期货模拟交易、保证金、手续费、4象限量化绩效统计)
 * 3. DrawingModule (水平线、趋势线、射线、测量尺、盈亏比计算器)
 * 4. ChartModule (Canvas K线、均线、成交量、持仓成本线、多空平仓连线轨迹)
 */

export const MockDataGenerator = {
  generate(symbol = 'eg9999', count = 260) {
    let basePrice = symbol === 'rb9999' ? 3380 : (symbol === 'm9999' ? 3050 : 4250);
    let volatility = symbol === 'rb9999' ? 22 : (symbol === 'm9999' ? 18 : 28);
    let startDate = new Date(2025, 4, 6, 9, 0);

    const data = [];
    let curClose = basePrice;

    for (let i = 0; i < count; i++) {
      let trend = 0;
      if (i < 40) trend = Math.sin(i / 6) * 12;
      else if (i < 55) trend = -20 - (i - 40) * 2;
      else if (i < 130) trend = 25 + Math.sin(i / 8) * 15;
      else if (i < 170) trend = Math.sin(i / 5) * 20;
      else if (i < 220) trend = -24 - Math.cos(i / 7) * 10;
      else trend = 18 + Math.sin(i / 4) * 8;

      const delta = (Math.random() - 0.48) * volatility + trend * 0.4;
      const open = Math.round(curClose + (Math.random() - 0.5) * (volatility * 0.4));
      const close = Math.round(open + delta);
      const high = Math.round(Math.max(open, close) + Math.random() * (volatility * 0.8));
      const low = Math.round(Math.min(open, close) - Math.random() * (volatility * 0.8));
      const volume = Math.round(35000 + Math.random() * 85000 + Math.abs(delta) * 1800);

      startDate.setDate(startDate.getDate() + 1);
      if (startDate.getDay() === 0) startDate.setDate(startDate.getDate() + 1);
      if (startDate.getDay() === 6) startDate.setDate(startDate.getDate() + 2);

      const yyyy = startDate.getFullYear();
      const mm = String(startDate.getMonth() + 1).padStart(2, '0');
      const dd = String(startDate.getDate()).padStart(2, '0');
      data.push({ date: `${yyyy}-${mm}-${dd}`, open, high, low, close, volume });
      curClose = close;
    }

    for (let i = 0; i < data.length; i++) {
      data[i].ma5 = this.calcMA(data, i, 5);
      data[i].ma10 = this.calcMA(data, i, 10);
      data[i].ma20 = this.calcMA(data, i, 20);
    }
    return data;
  },

  calcMA(data, idx, period) {
    if (idx < period - 1) return null;
    let sum = 0;
    for (let j = idx - period + 1; j <= idx; j++) sum += data[j].close;
    return Math.round((sum / period) * 10) / 10;
  }
};

export class TradingEngine {
  constructor() {
    this.initialCapital = 100000;
    this.cash = 100000;
    this.multiplier = 10;
    this.marginRatio = 0.10;
    this.commission = 4.0;
    this.position = null;
    this.tradesHistory = [];
    this.tradeMarkers = [];
    this.equitySnapshots = [{ tradeNum: 0, equity: 100000, positionRate: 0 }];
    this.actionHistory = [];
  }

  reset(initialCapital = 100000) {
    this.initialCapital = initialCapital;
    this.cash = initialCapital;
    this.position = null;
    this.tradesHistory = [];
    this.tradeMarkers = [];
    this.equitySnapshots = [{ tradeNum: 0, equity: initialCapital, positionRate: 0 }];
    this.actionHistory = [];
  }

  getTotalEquity(currentPrice) {
    if (!this.position) return this.cash;
    const diff = this.position.direction === 'long' 
      ? (currentPrice - this.position.entryPrice)
      : (this.position.entryPrice - currentPrice);
    const floating = diff * this.multiplier * this.position.lots;
    return this.cash + this.position.margin + floating;
  }

  openLong(symbol, price, lots, time, barIndex) {
    if (this.position) throw new Error("已有持仓，请先平仓！");
    const marginNeeded = price * this.multiplier * lots * this.marginRatio;
    const fee = this.commission * lots;
    if (this.cash < marginNeeded + fee) throw new Error("可用资金不足以支付保证金与手续费！");

    const prevState = this.captureState();
    this.cash -= (marginNeeded + fee);
    this.position = { symbol, direction: 'long', lots, entryPrice: price, entryTime: time, entryIndex: barIndex, margin: marginNeeded };
    this.tradeMarkers.push({ barIndex, time, price, type: 'buy_long', direction: 'long', lots, text: `买开 ${lots}手 @ ${price}` });
    this.actionHistory.push({ action: 'open', prevState });
    return true;
  }

  openShort(symbol, price, lots, time, barIndex) {
    if (this.position) throw new Error("已有持仓，请先平仓！");
    const marginNeeded = price * this.multiplier * lots * this.marginRatio;
    const fee = this.commission * lots;
    if (this.cash < marginNeeded + fee) throw new Error("可用资金不足！");

    const prevState = this.captureState();
    this.cash -= (marginNeeded + fee);
    this.position = { symbol, direction: 'short', lots, entryPrice: price, entryTime: time, entryIndex: barIndex, margin: marginNeeded };
    this.tradeMarkers.push({ barIndex, time, price, type: 'sell_short', direction: 'short', lots, text: `卖开 ${lots}手 @ ${price}` });
    this.actionHistory.push({ action: 'open', prevState });
    return true;
  }

  closePosition(exitPrice, exitTime, exitBarIndex) {
    if (!this.position) throw new Error("当前无持仓，无法平仓！");
    const prevState = this.captureState();
    const pos = this.position;
    const pointDiff = pos.direction === 'long' ? (exitPrice - pos.entryPrice) : (pos.entryPrice - exitPrice);
    const grossPnL = pointDiff * this.multiplier * pos.lots;
    const fee = this.commission * pos.lots * 2;
    const netPnL = grossPnL - this.commission * pos.lots;

    this.cash += (pos.margin + netPnL);
    const trade = {
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
      pct: (pointDiff / pos.entryPrice) * 100,
      fee,
      netPnL,
      holdingBars: Math.max(1, exitBarIndex - pos.entryIndex),
      equityAfter: this.cash,
      positionRate: (pos.margin / this.cash) * 100
    };

    this.tradesHistory.push(trade);
    this.equitySnapshots.push({ tradeNum: this.tradesHistory.length, equity: this.cash, positionRate: trade.positionRate });
    this.tradeMarkers.push({
      barIndex: exitBarIndex,
      time: exitTime,
      price: exitPrice,
      type: 'close',
      direction: pos.direction === 'long' ? 'sell_close' : 'buy_close',
      lots: pos.lots,
      text: `平仓 ${pos.lots}手 @ ${exitPrice} (${netPnL >= 0 ? '+' : ''}${netPnL.toFixed(0)})`
    });

    this.position = null;
    this.actionHistory.push({ action: 'close', prevState });
    return trade;
  }

  captureState() {
    return {
      cash: this.cash,
      position: this.position ? { ...this.position } : null,
      tradesHistory: JSON.parse(JSON.stringify(this.tradesHistory)),
      tradeMarkers: JSON.parse(JSON.stringify(this.tradeMarkers)),
      equitySnapshots: JSON.parse(JSON.stringify(this.equitySnapshots))
    };
  }

  undo() {
    if (this.actionHistory.length === 0) return false;
    const prev = this.actionHistory.pop().prevState;
    this.cash = prev.cash;
    this.position = prev.position;
    this.tradesHistory = prev.tradesHistory;
    this.tradeMarkers = prev.tradeMarkers;
    this.equitySnapshots = prev.equitySnapshots;
    return true;
  }

  getComprehensiveStatistics(currentPrice, totalReplayBars = 260) {
    const totalTrades = this.tradesHistory.length;
    const currentEquity = this.getTotalEquity(currentPrice);
    const netProfit = currentEquity - this.initialCapital;
    const returnRate = (netProfit / this.initialCapital) * 100;

    if (totalTrades === 0) {
      return { totalTrades: 0, winRate: 0, lossRate: 0, winCount: 0, lossCount: 0, avgProfitRatio: 0, profitFactor: 0, maxConsecutiveWins: 0, expectancyR: 0, compoundRate: 1.0, avgWin: 0, maxWin: 0, extremeProfitRatio: 0, maxWinContribution: 0, returnToDrawdown: 0, maxDrawdownAmount: 0, maxDrawdownPercent: 0, avgLoss: 0, maxLoss: 0, maxConsecutiveLosses: 0, totalFills: 0, totalFees: 0, feeToCapital: 0, avgHoldingBars: 0, intervalSpan: totalReplayBars, currentEquity, netProfit, returnRate };
    }

    let winCount = 0, lossCount = 0, totalWinAmount = 0, totalLossAmount = 0, maxWin = 0, maxLoss = 0;
    let curWins = 0, maxConsecutiveWins = 0, curLosses = 0, maxConsecutiveLosses = 0, totalHoldingBars = 0, totalFees = 0;

    for (const t of this.tradesHistory) {
      totalHoldingBars += t.holdingBars;
      totalFees += t.fee;
      if (t.netPnL > 0) {
        winCount++; totalWinAmount += t.netPnL; if (t.netPnL > maxWin) maxWin = t.netPnL;
        curWins++; curLosses = 0; if (curWins > maxConsecutiveWins) maxConsecutiveWins = curWins;
      } else if (t.netPnL < 0) {
        lossCount++; totalLossAmount += Math.abs(t.netPnL); if (Math.abs(t.netPnL) > maxLoss) maxLoss = Math.abs(t.netPnL);
        curLosses++; curWins = 0; if (curLosses > maxConsecutiveLosses) maxConsecutiveLosses = curLosses;
      }
    }

    const winRate = (winCount / totalTrades) * 100;
    const lossRate = (lossCount / totalTrades) * 100;
    const avgWin = winCount > 0 ? (totalWinAmount / winCount) : 0;
    const avgLoss = lossCount > 0 ? (totalLossAmount / lossCount) : 0;
    const avgProfitRatio = avgLoss > 0 ? (avgWin / avgLoss) : (totalWinAmount > 0 ? 99.9 : 0);
    const profitFactor = totalLossAmount > 0 ? (totalWinAmount / totalLossAmount) : 99.9;
    const expectancyR = avgLoss > 0 ? (((winRate / 100) * avgWin - (lossRate / 100) * avgLoss) / avgLoss) : 0;

    let peak = this.initialCapital, maxDrawdownAmount = 0, maxDrawdownPercent = 0;
    for (const s of this.equitySnapshots) {
      if (s.equity > peak) peak = s.equity;
      const dd = peak - s.equity;
      const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
      if (dd > maxDrawdownAmount) maxDrawdownAmount = dd;
      if (ddPct > maxDrawdownPercent) maxDrawdownPercent = ddPct;
    }

    return {
      totalTrades, winRate, lossRate, winCount, lossCount, avgProfitRatio, profitFactor, maxConsecutiveWins, expectancyR,
      compoundRate: currentEquity / this.initialCapital, avgWin, maxWin, extremeProfitRatio: avgLoss > 0 ? maxWin / avgLoss : 0,
      maxWinContribution: totalWinAmount > 0 ? (maxWin / totalWinAmount) * 100 : 0,
      returnToDrawdown: maxDrawdownAmount > 0 ? netProfit / maxDrawdownAmount : 99.9,
      maxDrawdownAmount, maxDrawdownPercent, avgLoss, maxLoss, maxConsecutiveLosses,
      totalFills: totalTrades * 2, totalFees, feeToCapital: (totalFees / this.initialCapital) * 100,
      avgHoldingBars: totalHoldingBars / totalTrades, intervalSpan: totalReplayBars, currentEquity, netProfit, returnRate
    };
  }
}
