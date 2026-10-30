/**
 * 抓取多品类 60 分钟线，落盘到 fixtures/intraday1h/。
 *
 * 数据源：新浪（期货 getFewMinLine、A股 CN_MarketDataService）。
 * 东财 60m 实测只回最近约 124 根，做不了样本外；新浪能给约 1 年 / 1023 根。
 *
 * 两条必须做的清洗：
 *   1. 新浪周五夜盘 00:00 那根会标成下周一（例如 10-31 00:00 标成 11-02 00:00），
 *      原序列里还排在 01:00 之后。不修就会在周末凭空多出一根"未来 K 线"。
 *   2. 新浪 A股 60m 是不复权的（实测 600519 与东财 fqt=0 收盘一致），
 *      用东财日线 hfq / none 的收盘比值按日期乘回去，否则除息日会出现假跳空。
 *
 * 用法：node tools/fetch_intraday_1h.js [--only rb,cu,600519]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTradeSpec } from '../src/markets/instrumentSpec.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, '..', 'fixtures', 'intraday1h');

const FUTURES = [
  { sina: 'RB0', code: 'rbm', name: '螺纹钢主连', category: '黑色' },
  { sina: 'HC0', code: 'hcm', name: '热卷主连', category: '黑色' },
  { sina: 'I0', code: 'im', name: '铁矿石主连', category: '黑色' },
  { sina: 'CU0', code: 'cum', name: '沪铜主连', category: '有色' },
  { sina: 'AL0', code: 'alm', name: '沪铝主连', category: '有色' },
  { sina: 'AU0', code: 'aum', name: '沪金主连', category: '贵金属' },
  { sina: 'AG0', code: 'agm', name: '沪银主连', category: '贵金属' },
  { sina: 'SC0', code: 'scm', name: '原油主连', category: '能源' },
  { sina: 'TA0', code: 'tam', name: 'PTA主连', category: '化工' },
  { sina: 'MA0', code: 'mam', name: '甲醇主连', category: '化工' },
  { sina: 'EG0', code: 'egm', name: '乙二醇主连', category: '化工' },
  { sina: 'SA0', code: 'SAm', name: '纯碱主连', category: '化工' },
  { sina: 'M0', code: 'mm', name: '豆粕主连', category: '农产品' },
  { sina: 'Y0', code: 'ym', name: '豆油主连', category: '农产品' },
  { sina: 'CF0', code: 'cfm', name: '棉花主连', category: '农产品' },
  { sina: 'IF0', code: 'IFM', name: '沪深300股指主连', category: '金融' },
  { sina: 'IM0', code: 'IMm', name: '中证1000股指主连', category: '金融' },
  { sina: 'LC0', code: 'lcm', name: '碳酸锂主连', category: '新能源' }
];

const ASHARES = [
  { sina: 'sh600519', code: '600519', secid: '1.600519', name: '贵州茅台', category: '消费' },
  { sina: 'sz300750', code: '300750', secid: '0.300750', name: '宁德时代', category: '新能源' },
  { sina: 'sh510300', code: '510300', secid: '1.510300', name: '沪深300ETF', category: '宽基' },
  { sina: 'sh601318', code: '601318', secid: '1.601318', name: '中国平安', category: '金融' },
  { sina: 'sh600036', code: '600036', secid: '1.600036', name: '招商银行', category: '银行' },
  { sina: 'sz002594', code: '002594', secid: '0.002594', name: '比亚迪', category: '汽车' },
  { sina: 'sh601899', code: '601899', secid: '1.601899', name: '紫金矿业', category: '有色' },
  { sina: 'sh600900', code: '600900', secid: '1.600900', name: '长江电力', category: '公用' },
  { sina: 'sz159915', code: '159915', secid: '0.159915', name: '创业板ETF', category: '成长' }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { timeoutMs = 30000, referer = 'https://finance.sina.com.cn' } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { Referer: referer, 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, opts, label, attempts = 3) {
  let last;
  for (let n = 0; n < attempts; n++) {
    try { return await fetchText(url, opts); }
    catch (e) { last = e; await sleep(2500 * (n + 1)); }
  }
  throw new Error(`${label}: ${last?.message || last}`);
}

function parseJsonp(text) {
  const start = text.indexOf('([');
  const end = text.lastIndexOf('])');
  if (start < 0 || end < 0) throw new Error('返回不是预期的 JSONP 数组');
  return JSON.parse(text.slice(start + 1, end + 1));
}

const weekday = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0=周日 6=周六

function repairFridayNightLabels(bars) {
  // 只修「01:00 之后又出现一根 00:00」的周五夜盘：其余 00:00 都是正常的次根。
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1], cur = bars[i];
    if (!cur.date.endsWith('00:00') || !prev.date.endsWith('01:00')) continue;
    const prevDay = prev.date.slice(0, 10);
    if (weekday(prevDay) !== 6 || cur.date <= prev.date) continue;
    cur.date = `${prevDay} 00:00`;
  }
  return bars;
}

function normalizeFutures(rows) {
  const bars = rows.map((r) => ({
    date: String(r.d || '').slice(0, 16),
    open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c),
    volume: Number(r.v) || 0
  })).filter((b) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(b.date));
  repairFridayNightLabels(bars);
  return dedupeSort(bars);
}

function normalizeAShare(rows) {
  const bars = rows.map((r) => ({
    date: String(r.day || '').slice(0, 16),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
    volume: Number(r.volume) || 0
  })).filter((b) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(b.date));
  return dedupeSort(bars);
}

function dedupeSort(bars) {
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out = [];
  for (const b of bars) {
    if (out.length && out[out.length - 1].date === b.date) {
      out[out.length - 1] = b; // 同一时间戳只留后到的一条，不合并价格
      continue;
    }
    out.push(b);
  }
  return out;
}

async function fetchFutures60m(sinaSymbol) {
  const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/InnerFuturesNewService.getFewMinLine?symbol=${sinaSymbol}&type=60`;
  return normalizeFutures(parseJsonp(await fetchWithRetry(url, {}, sinaSymbol)));
}

async function fetchAShare60m(sinaSymbol) {
  const url = `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20t=/CN_MarketDataService.getKLineData?symbol=${sinaSymbol}&scale=60&ma=no&datalen=1023`;
  return normalizeAShare(parseJsonp(await fetchWithRetry(url, {}, sinaSymbol)));
}

async function fetchEmDaily(secid, fqt) {
  const qs = new URLSearchParams({
    secid, fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: '101', fqt: String(fqt), beg: '20250901', end: '20500101'
  });
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?${qs}`;
  const text = await fetchWithRetry(url, { referer: 'https://quote.eastmoney.com/' }, `${secid} daily fqt=${fqt}`);
  const json = JSON.parse(text);
  return (json.data?.klines || []).map((line) => {
    const p = line.split(',');
    return { date: p[0], close: Number(p[2]) };
  }).filter((r) => Number.isFinite(r.close) && r.close > 0);
}

function hfqFactorByDate(hfq, none) {
  const noneByDate = new Map(none.map((r) => [r.date, r.close]));
  const map = new Map();
  for (const r of hfq) {
    const base = noneByDate.get(r.date);
    if (base > 0) map.set(r.date, r.close / base);
  }
  return map;
}

function applyHfq(bars, factors) {
  const dates = [...factors.keys()].sort();
  let last = 1, missing = 0, used = 0;
  for (const b of bars) {
    const d = b.date.slice(0, 10);
    let f = factors.get(d);
    if (!Number.isFinite(f)) {
      // 日线缺失时沿用最近一个有效因子；因子本身是慢变的，不能在这里凭空插值
      const prev = dates.filter((x) => x <= d).pop();
      f = prev ? factors.get(prev) : null;
      missing++;
    } else used++;
    if (!Number.isFinite(f) || f <= 0) throw new Error(`缺少 ${d} 的复权因子`);
    last = f;
    for (const k of ['open', 'high', 'low', 'close']) b[k] = Math.round(b[k] * f * 1e4) / 1e4;
  }
  return { missing, used, lastFactor: last, firstFactor: factors.get(dates[0]) };
}

function quality(bars, { limitPct = 0.2 } = {}) {
  let dup = 0, bad = 0, zeroVol = 0, gapMax = 0, gapCount = 0;
  const dayCount = new Map();
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!(b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0)) bad++;
    if (b.high < Math.max(b.open, b.close) - 1e-9 || b.low > Math.min(b.open, b.close) + 1e-9) bad++;
    if (!(b.volume > 0)) zeroVol++;
    const d = b.date.slice(0, 10);
    dayCount.set(d, (dayCount.get(d) || 0) + 1);
    if (i > 0) {
      const prev = bars[i - 1];
      if (prev.date === b.date) dup++;
      const gap = Math.abs(b.open / prev.close - 1);
      if (gap > gapMax) gapMax = gap;
      if (gap > limitPct) gapCount++;
    }
  }
  const perDay = [...dayCount.values()].sort((a, b) => a - b);
  return {
    bars: bars.length, days: dayCount.size, dup, bad, zeroVol,
    medianBarsPerDay: perDay.length ? perDay[Math.floor(perDay.length / 2)] : 0,
    maxOpenGap: Math.round(gapMax * 1e4) / 1e4,
    gapsOverLimit: gapCount
  };
}

function save(kind, item, bars, extra) {
  const spec = resolveTradeSpec(item.code);
  if (!spec.ok) throw new Error(`${item.code} 规格解析失败：${spec.reason}`);
  const fn = `${kind}_${item.code}_60m.json`;
  const meta = {
    symbol: item.code, sinaSymbol: item.sina, name: item.name, category: item.category,
    market: kind, period: '60m', adjust: kind === 'ashare' ? 'hfq' : 'none',
    count: bars.length, firstDate: bars[0]?.date, lastDate: bars.at(-1)?.date,
    source: 'sina', fetchedAt: new Date().toISOString().slice(0, 19),
    spec: { multiplier: spec.spec.multiplier, tick: spec.spec.tick, marginRate: spec.spec.marginRate },
    ...extra
  };
  fs.writeFileSync(path.join(OUT, fn), JSON.stringify({ meta, bars }, null, 0));
  return { fn, meta, q: quality(bars, { limitPct: kind === 'futures' ? (spec.spec.limitPct || 0.1) * 1.5 : 0.12 }) };
}

async function main() {
  const onlyArg = process.argv.indexOf('--only');
  const only = onlyArg > 0 ? process.argv[onlyArg + 1].split(',') : null;
  const wanted = (item) => !only || only.some((k) => item.code === k || item.sina.toLowerCase() === k.toLowerCase());
  fs.mkdirSync(OUT, { recursive: true });

  // --only 只补抓指定品种：必须合并旧清单，否则一次局部更新会把其他品种从索引里抹掉
  const indexPath = path.join(OUT, 'index.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')).files || {}; } catch {}
  const failures = [], rows = [];
  for (const item of FUTURES.filter(wanted)) {
    try {
      const bars = await fetchFutures60m(item.sina);
      const r = save('futures', item, bars, { settlement: 'missing（60m 不带交易所结算价，引擎按当日 VWAP 代理）' });
      index[r.fn] = r.meta; rows.push([item.category, item.name, r.q.bars, r.meta.firstDate, r.meta.lastDate, r.q.medianBarsPerDay, r.q.bad + r.q.dup, r.q.gapsOverLimit, r.q.maxOpenGap]);
      console.log(`✓ ${item.name} ${r.q.bars} 根 ${r.meta.firstDate} → ${r.meta.lastDate}`);
    } catch (e) { failures.push(`${item.sina}: ${e.message}`); console.log(`✗ ${item.name} ${e.message}`); }
    await sleep(900);
  }

  for (const item of ASHARES.filter(wanted)) {
    try {
      const bars = await fetchAShare60m(item.sina);
      const [hfq, none] = [await fetchEmDaily(item.secid, 1), await fetchEmDaily(item.secid, 0)];
      const adj = applyHfq(bars, hfqFactorByDate(hfq, none));
      const r = save('ashare', item, bars, { hfqMissingDays: adj.missing, hfqFactor: { first: adj.firstFactor, last: adj.lastFactor } });
      index[r.fn] = r.meta; rows.push([item.category, item.name, r.q.bars, r.meta.firstDate, r.meta.lastDate, r.q.medianBarsPerDay, r.q.bad + r.q.dup, r.q.gapsOverLimit, r.q.maxOpenGap]);
      console.log(`✓ ${item.name} ${r.q.bars} 根 ${r.meta.firstDate} → ${r.meta.lastDate} 因子 ${adj.firstFactor.toFixed(4)}→${adj.lastFactor.toFixed(4)} 缺 ${adj.missing}`);
    } catch (e) { failures.push(`${item.sina}: ${e.message}`); console.log(`✗ ${item.name} ${e.message}`); }
    await sleep(900);
  }

  fs.writeFileSync(indexPath, JSON.stringify({ generatedAt: new Date().toISOString(), failures, files: index }, null, 1));
  console.log('\n品类        品种             根数   首根                 末根                 根/日  坏/重  大跳空  最大开盘跳空');
  for (const r of rows) console.log(String(r[0]).padEnd(10), String(r[1]).padEnd(16), String(r[2]).padStart(5), String(r[3]).padEnd(20), String(r[4]).padEnd(20), String(r[5]).padStart(4), String(r[6]).padStart(5), String(r[7]).padStart(6), String(r[8]).padStart(8));
  if (failures.length) console.log('\n失败：\n' + failures.join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
