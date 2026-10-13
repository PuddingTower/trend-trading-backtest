import { test, assert } from './harness.js';
import { calcMA, attachDefaultMAs, normalizeSinaRow, sortByDate } from '../src/data/indicators.js';
import { parseCSV, barsToCSV, tradesToCSV, toCSV } from '../src/data/csvIO.js';
import { stitch, aggregate, findRolloverGaps, STITCH_MODES } from '../src/data/dominant.js';
import { barKey, upgradeLegacyKey } from '../src/data/barStore.js';
import { mightHaveLocalBackend } from '../src/data/sources.js';

const mk = (date, o, h, l, c, v = 1000) => ({ date, open: o, high: h, low: l, close: c, volume: v });

// ---------- indicators ----------
test('normalizeSinaRow：吃位置数组（接口实际形态），也吃对象形态', () => {
  const arr = normalizeSinaRow(['2024-07-17', '4676.000', '4715.000', '4640.000', '4641.000', '340190']);
  assert.eq(arr.date, '2024-07-17');
  assert.eq(arr.open, 4676); assert.eq(arr.high, 4715);
  assert.eq(arr.low, 4640); assert.eq(arr.close, 4641); assert.eq(arr.volume, 340190);

  const obj = normalizeSinaRow({ d: '2024-07-18', o: '1', h: '2', l: '0.5', c: '1.5', v: '10' });
  assert.eq(obj.close, 1.5);
  assert.eq(normalizeSinaRow(['2024-01-01', 'x', 'y', 'z', 'w', '0']), null, '非数字要丢掉而不是产 NaN');
});

test('60m 倒序输入 → 升序输出（新浪 60m 实测是倒序）', () => {
  const sorted = sortByDate([mk('2024-01-03', 1, 1, 1, 1), mk('2024-01-01', 1, 1, 1, 1), mk('2024-01-02', 1, 1, 1, 1)]);
  assert.deep(sorted.map(b => b.date), ['2024-01-01', '2024-01-02', '2024-01-03']);
});

test('attachDefaultMAs 与旧内联 calcMA 逐值一致（均线不能因重构而变）', () => {
  const bars = [10, 11, 12, 13, 14, 15].map((c, i) => mk(`2024-01-0${i + 1}`, c, c, c, c));
  attachDefaultMAs(bars);
  for (let i = 0; i < bars.length; i++) {
    assert.eq(bars[i].ma5, calcMA(bars, i, 5), `idx=${i} ma5`);
    assert.eq(bars[i].ma10, calcMA(bars, i, 10), '不足 10 根应为 null');
  }
  assert.eq(bars[4].ma5, 12, '前 5 根收盘均值');
  assert.eq(bars[3].ma5, null, '不足 5 根必须 null（图表靠 null 断线）');
});

// ---------- csv ----------
// 旧版要求「表头 + 至少 5 根」，沿用这个下限，所以 fixture 给 5 根数据。
const CSV_EN = ['date,open,high,low,close,volume',
  '2025-01-02,100,110,95,105,1000',
  '2025-01-03,105,115,100,110,1200',
  '2025-01-06,110,120,105,118,900',
  '2025-01-07,118,125,112,120,1500',
  '2025-01-08,120,128,118,124,1100'].join('\n');

test('CSV：英文表头 + BOM 也能读', () => {
  const { bars } = parseCSV('﻿' + CSV_EN);
  assert.eq(bars.length, 5);
  assert.eq(bars[0].open, 100); assert.eq(bars[4].close, 124);
  assert.eq(bars[0].ma5, null);
});

test('CSV：中文表头（行情软件导出的常见形态）', () => {
  const cn = ['时间,开盘,最高,最低,收盘,成交量',
    '2025-01-02,100,110,95,105,1000', '2025-01-03,105,115,100,110,1200',
    '2025-01-06,110,120,105,118,900', '2025-01-07,118,125,112,120,1500',
    '2025-01-08,120,128,118,124,1100'].join('\n');
  const { bars } = parseCSV(cn);
  assert.eq(bars.length, 5);
  assert.eq(bars[1].high, 115);
});

test('CSV：表头 low 不能被单字母 l 抢列', () => {
  const tricky = ['date,open,high,low,close,vol',
    '2025-01-02,10,11,9,10,1', '2025-01-03,10,12,10,11,1',
    '2025-01-06,11,12,10,11,1', '2025-01-07,11,13,11,12,1',
    '2025-01-08,12,14,11,13,1'].join('\n');
  const { bars } = parseCSV(tricky);
  assert.eq(bars[0].low, 9);
  assert.eq(bars[0].high, 11);
});

test('CSV：缺成交量列时补 50000（沿用旧行为，图表量能栏不能空）', () => {
  const noVol = ['date,open,high,low,close',
    '2025-01-02,10,11,9,10', '2025-01-03,10,12,10,11',
    '2025-01-06,11,12,10,11', '2025-01-07,11,13,11,12',
    '2025-01-08,12,14,11,13'].join('\n');
  const { bars } = parseCSV(noVol);
  assert.eq(bars[0].volume, 50000);
});

test('CSV：行数不足 / 缺 OHLC 必须明确报错', () => {
  assert.throws(() => parseCSV('date,open,high,low,close\n2025-01-02,1,1,1,1'), '行数不足');
  assert.throws(() => parseCSV(['date,open,high,close,volume',
    '2025-01-02,1,1,1,1', '2025-01-03,1,1,1,1', '2025-01-06,1,1,1,1',
    '2025-01-07,1,1,1,1', '2025-01-08,1,1,1,1'].join('\n')), 'low');
});

test('CSV 导出：期货与 A股列集不同，且能原样读回', () => {
  const csv = barsToCSV([{ date: '2025-01-02', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]);
  assert.ok(csv.indexOf('﻿') === 0, 'Excel 需要 BOM');
  const t = tradesToCSV([{ id: 1, symbol: 'RB2610', direction: 'long', entryTime: 'a', exitTime: 'b',
    entryPrice: 3000, exitPrice: 3100, lots: 2, points: 100, pct: 3.33, fee: 6.18, netPnL: 1993.82,
    holdingBars: 5, equityAfter: 101993.82 }], 'futures');
  assert.ok(t.includes('平今费') && t.includes('点数差'), '期货列');
  const tA = tradesToCSV([{ id: 1, symbol: '600519', direction: 'long', entryTime: 'a', exitTime: 'b',
    entryPrice: 100, exitPrice: 110, shares: 100, pct: 10, commission: 5, stampTax: 5.5,
    transferFee: 0.1, netPnL: 989.4, holdingBars: 3, equityAfter: 100989.4 }], 'ashare');
  assert.ok(tA.includes('印花税') && tA.includes('过户费'), 'A股列');
  assert.ok(!tA.includes('平今费'), 'A股不该出现期货专列');
});

test('CSV 转义：含逗号/引号的单元格不破列', () => {
  const out = toCSV([['a', 'b,c', 'd"e']]);
  assert.eq(out, 'a,"b,c","d""e"');
});

// ---------- dominant ----------
const SEG = [
  { contract: 'rb2601', bars: [mk('2025-12-29', 3000, 3050, 2980, 3020), mk('2025-12-30', 3020, 3060, 3010, 3040)] },
  { contract: 'rb2605', bars: [mk('2025-12-31', 3100, 3120, 3080, 3110), mk('2026-01-05', 3110, 3150, 3100, 3140)] }
];

test('换月拼接 diff：消除换月跳空，收益率连续', () => {
  const stitched = stitch(SEG, STITCH_MODES.DIFF);
  assert.eq(stitched.length, 4);
  // 价差 = 3110(新首根) - 3040(旧末根) = 70 → 新段整体 -70
  assert.eq(stitched[2].close, 3040);
  assert.eq(stitched[3].close, 3070);
  assert.eq(stitched[2].rollover, true);
  const rets = [1, 2, 3].map(i => (stitched[i].close / stitched[i - 1].close - 1));
  assert.ok(Math.abs(rets[1]) < 0.02, `换月日不该有 2% 以上跳空，实际 ${(rets[1] * 100).toFixed(2)}%`);
});

test('换月拼接 raw：保留真实缺口并标记，供策略避开换月日', () => {
  const stitched = stitch(SEG, STITCH_MODES.RAW);
  assert.eq(stitched[2].close, 3110, 'raw 不平移');
  assert.eq(stitched[2].rollover, true);
  const gaps = findRolloverGaps(stitched);
  assert.eq(gaps.length, 1);
  assert.eq(gaps[0].gap, 70);
});

test('换月拼接 ratio：按价格比例缩放而非加减', () => {
  const stitched = stitch(SEG, STITCH_MODES.RATIO);
  const scale = 3040 / 3110;
  assert.near(stitched[2].close, 3110 * scale, 0.01);
  assert.near(stitched[3].close, 3140 * scale, 0.01);
});

test('三段以上连续换月，diff 不会累积漂移', () => {
  const segs = [
    { contract: 'a', bars: [mk('d1', 100, 100, 100, 100)] },
    { contract: 'b', bars: [mk('d2', 110, 110, 110, 110)] },
    { contract: 'c', bars: [mk('d3', 121, 121, 121, 121)] }
  ];
  const st = stitch(segs, STITCH_MODES.DIFF);
  assert.deep(st.map(b => b.close), [100, 100, 100], '每段都被拉回同一尺度');
});

test('周线聚合：open 取组首、close 取组末、high/low 取极值、量累加、日期用最后交易日', () => {
  const daily = [
    mk('2026-01-05', 100, 105, 98, 103, 1000),   // 周一
    mk('2026-01-06', 103, 110, 102, 108, 1200),  // 周二
    mk('2026-01-12', 108, 112, 106, 107, 900)    // 下周一 → 另一周
  ];
  const w = aggregate(daily, 'weekly');
  assert.eq(w.length, 2);
  assert.eq(w[0].date, '2026-01-06');
  assert.eq(w[0].open, 100); assert.eq(w[0].close, 108);
  assert.eq(w[0].high, 110); assert.eq(w[0].low, 98);
  assert.eq(w[0].volume, 2200);
});

test('月线聚合跨月分组正确', () => {
  const m = aggregate([mk('2026-01-28', 1, 9, 1, 8), mk('2026-02-02', 8, 12, 7, 11)], 'monthly');
  assert.eq(m.length, 2);
  assert.eq(m[0].date, '2026-01-28');
  assert.eq(m[1].high, 12);
});

// ---------- barStore key ----------
test('v1→v2 缓存键迁移：EG0_daily → futures:EG0:daily:none', () => {
  assert.eq(barKey('futures', 'EG0', 'daily', 'none'), 'futures:EG0:daily:none');
  assert.eq(upgradeLegacyKey('EG0_daily'), 'futures:EG0:daily:none');
  assert.eq(upgradeLegacyKey('RB0_60m'), 'futures:RB0:60m:none');
  assert.eq(upgradeLegacyKey('ashare:600519:daily:qfq'), 'ashare:600519:daily:qfq', '新格式原样返回');
});

// ---------- 本地后端存在性判定（静态托管不再空打 /api/* 吃 404） ----------
test('mightHaveLocalBackend：本机与局域网放行，静态托管与 file:// 拒绝', () => {
  const loc = (protocol, hostname) => ({ protocol, hostname });
  assert.eq(mightHaveLocalBackend(loc('http:', 'localhost')), true);
  assert.eq(mightHaveLocalBackend(loc('http:', '127.0.0.1')), true);
  assert.eq(mightHaveLocalBackend(loc('http:', '::1')), true, 'IPv6 回环');
  // iPad 通过局域网访问本地服务器时，origin 就是这台机器的私网地址，必须放行
  for (const ip of ['192.168.1.20', '10.0.0.5', '172.16.3.9', '172.31.255.1']) {
    assert.eq(mightHaveLocalBackend(loc('http:', ip)), true, `${ip} 是局域网地址`);
  }
  assert.eq(mightHaveLocalBackend(loc('http:', 'nas.local')), true);
  assert.eq(mightHaveLocalBackend(loc('https:', 'puddingtower.github.io')), false, 'GitHub Pages 上没有后端');
  assert.eq(mightHaveLocalBackend(loc('https:', 'example.com')), false);
  assert.eq(mightHaveLocalBackend(loc('file:', '')), false, 'file:// 下没有同源后端');
  assert.eq(mightHaveLocalBackend(loc('http:', '172.15.0.1')), false, '172.15 不属于私网段');
  assert.eq(mightHaveLocalBackend(null), false, '拿不到 location 时保守判否');
});
