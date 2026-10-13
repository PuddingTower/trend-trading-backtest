/** CSV 导入导出 —— 双市场字段兼容。保留旧行为：表头模糊匹配（含中文）、缺量默认 50000、导出带 BOM。 */

import { attachDefaultMAs } from './indicators.js';

const NL = String.fromCharCode(10);
const BOM = '﻿';

const HEADER_MATCHERS = {
  date: ['date', 'time', 'timestamp', 'datetime', '时间', '日期', '交易日'],
  open: ['open', 'o', '开盘', '开盘价'],
  high: ['high', 'h', '最高', '最高价'],
  low: ['low', 'l', '最低', '最低价'],
  close: ['close', 'c', '收盘', '收盘价'],
  volume: ['vol', 'volume', '量', '成交量', '成交'],
  amount: ['amount', 'amt', '额', '成交额'],
  symbol: ['symbol', 'code', '代码', '合约', '品种'],
  name: ['name', '名称', '品种名']
};

/** 表头列名匹配：短词（o/h/l/c）只允许全等，否则 'low' 会被 'l' 抢走。 */
function findColumn(headers, field) {
  const needles = HEADER_MATCHERS[field];
  for (const exact of needles) {
    const i = headers.findIndex(h => h === exact);
    if (i !== -1) return i;
  }
  for (const needle of needles) {
    if (needle.length <= 2) continue;
    const i = headers.findIndex(h => h.includes(needle));
    if (i !== -1) return i;
  }
  return -1;
}

export function parseCSV(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '');
  const lines = clean.trim().split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 5) throw new Error('CSV 文件行数不足（至少需要表头 + 4 行数据）');

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idx = {};
  for (const field of Object.keys(HEADER_MATCHERS)) idx[field] = findColumn(headers, field);

  for (const need of ['date', 'open', 'high', 'low', 'close']) {
    if (idx[need] === -1) {
      throw new Error(`未能识别 ${need} 列（可用：${['date/时间/日期', 'open/开盘', 'high/最高', 'low/最低', 'close/收盘'].join('、')}）。表头实为：${headers.join('|')}`);
    }
  }

  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',').map(c => c.trim());
    if (row.length < 5) continue;
    const bar = {
      date: row[idx.date],
      open: parseFloat(row[idx.open]),
      high: parseFloat(row[idx.high]),
      low: parseFloat(row[idx.low]),
      close: parseFloat(row[idx.close]),
      volume: idx.volume !== -1 ? (parseFloat(row[idx.volume]) || 0) : 50000
    };
    if (idx.amount !== -1) bar.amount = parseFloat(row[idx.amount]) || 0;
    if (!Number.isFinite(bar.open) || !Number.isFinite(bar.high) ||
        !Number.isFinite(bar.low) || !Number.isFinite(bar.close)) continue;
    if (!bar.date) continue;
    bars.push(bar);
  }
  if (bars.length < 5) throw new Error(`有效行情数据少于 5 条（解析到 ${bars.length} 条）`);

  const detected = idx.symbol !== -1 ? row0(lines, idx.symbol) : null;
  return { bars: attachDefaultMAs(bars), detectedSymbol: detected, columnMap: idx };
}

function row0(lines, col) {
  const first = (lines[1] || '').split(',')[col];
  return first ? first.trim() : null;
}

export function toCSV(rows) {
  return rows.map(r => r.map(cell => {
    const s = cell === null || cell === undefined ? '' : String(cell);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join(NL);
}

/** K线导出（双市场通用列） */
export function barsToCSV(bars, meta = {}) {
  const header = ['date', 'open', 'high', 'low', 'close', 'volume'];
  const hasAmount = bars.some(b => b.amount !== undefined);
  if (hasAmount) header.push('amount');
  const rows = [header];
  for (const b of bars) {
    const r = [b.date, b.open, b.high, b.low, b.close, b.volume];
    if (hasAmount) r.push(b.amount ?? '');
    rows.push(r);
  }
  return BOM + toCSV(rows);
}

/**
 * 交易明细导出。期货与 A股分列：期货有点数差/保证金/平今费，A股有印花税/过户费/T+1 持仓天数。
 * 缺字段留空，而不是给两条市场硬套同一套列。
 */
export function tradesToCSV(trades, market = 'futures') {
  const isFutures = market === 'futures';
  const head = isFutures
    ? ['序号', '合约代码', '市场', '交易方向', '开仓时间', '平仓时间', '开仓价', '平仓价', '手数',
       '点数差', '涨跌幅%', '手续费', '其中平今费', '净盈亏', '持仓根数', '平仓后资金权益']
    : ['序号', '股票代码', '名称', '市场', '交易方向', '开仓时间', '平仓时间', '开仓价', '平仓价',
       '股数', '金额', '盈亏比%', '佣金', '印花税', '过户费', '净盈亏', '持仓根数', '平仓后资金权益'];

  const rows = [head];
  for (const t of trades) {
    rows.push(isFutures
      ? [t.id, t.symbol, t.market || 'futures', t.direction === 'long' ? '做多' : '做空',
         t.entryTime, t.exitTime, t.entryPrice, t.exitPrice, t.lots,
         t.points, t.pct ? t.pct.toFixed(2) + '%' : '', t.fee,
         t.closeTodayFee ?? '', t.netPnL, t.holdingBars, t.equityAfter]
      : [t.id, t.symbol, t.name || '', t.market || 'ashare', t.direction === 'long' ? '买入' : '卖出',
         t.entryTime, t.exitTime, t.entryPrice, t.exitPrice,
         t.shares ?? t.lots, t.notional ?? '', t.pct ? t.pct.toFixed(2) + '%' : '',
         t.commission ?? '', t.stampTax ?? '', t.transferFee ?? '',
         t.netPnL, t.holdingBars, t.equityAfter]);
  }
  return BOM + toCSV(rows);
}

export function downloadText(filename, content, mime = 'text/csv;charset=utf-8;') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const SAMPLE_CSV = `date,open,high,low,close,volume
2025-09-01,4210,4265,4195,4258,85420
2025-09-02,4255,4290,4240,4282,92100
2025-09-03,4280,4315,4260,4270,78300
2025-09-04,4272,4285,4220,4235,69500
2025-09-05,4230,4250,4180,4190,83200`;
