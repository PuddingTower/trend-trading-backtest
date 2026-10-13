import { test, assert } from './harness.js';
import { scanSymbol, scanUniverse, filterRows, sortRows, scanSummary } from '../src/markets/scanner.js';
import { trendTemplate, pivotBreak } from '../src/strategy/library.js';

const mk = (date, o, h, l, c, v = 100) => ({ date, open: o, high: h, low: l, close: c, volume: v });
const date = (i) => {
  const d = new Date(Date.UTC(2023, 0, 2));
  let add = 0, count = 0;
  while (count < i) { add++; const w = new Date(d.getTime() + add * 86400000).getUTCDay(); if (w !== 0 && w !== 6) count++; }
  return new Date(d.getTime() + add * 86400000).toISOString().slice(0, 10);
};
function series(n, start, growth, vol = 100) {
  return Array.from({ length: n }, (_, i) => {
    const p = Math.round(start * Math.pow(1 + growth, i) * 10) / 10;
    return mk(date(i), p, Math.round(p * 1.001 * 10) / 10, Math.round(p * 0.995 * 10) / 10, p, vol);
  });
}

const UP = () => series(300, 100, 0.005, 100);
const DOWN = () => series(300, 300, -0.004, 100);

test('scanSymbol：一次扫描给出模板、突破、动量、波动、量能五项，字段齐而不炸', () => {
  const bars = UP().map((b, i) => ({ ...b, volume: i >= 298 ? 300 : 100 }));
  const r = scanSymbol({ symbol: 'RB0', name: '螺纹钢', bars });
  assert.eq(r.error, null, r.error || '');
  assert.eq(r.bars, 300);
  assert.ok(r.ok, '数据够就该可判定');
  assert.eq(r.lastDate, date(299));
  assert.ok(r.template && r.template.crit.length === 8, '八条判据都要在');
  assert.eq(r.template.ok, true, '稳定上行应当通过模板');
  assert.eq(r.template.enabled, 7, '没给基准时 RS 不参与，判定分母必须是 7');
  assert.ok(r.breakout && Number.isFinite(r.breakout.level), '枢轴位要给出来');
  assert.eq(r.breakout.broke, true, '收盘在上日为止 25 根高点之上就是突破');
  assert.eq(r.breakout.volOk, true, '放量 3 倍该通过量能确认');
  assert.ok(Number.isFinite(r.adx) && r.adx > 20, `ADX 应在，实际 ${r.adx}`);
  assert.ok(r.atrPct > 0 && r.atrPct < 0.05, `ATR/价格应在几个点，实际 ${r.atrPct}`);
  assert.ok(r.mom['m6m'] > 0 && r.mom['m3m'] > 0, '动量列必须是正数');
  assert.ok(r.score > 0, '风险调整后动量分应在');
  assert.ok(r.volRatio > 1, `近 5 日均量应高于长均量，实际 ${r.volRatio}`);
  assert.ok(r.distHigh >= -0.01 && r.aboveLow > 0.3, '距新高/离低点两列要能读');
});

test('scanSymbol：下跌品种模板不过；数据不足直接标 error 留在表里', () => {
  const down = scanSymbol({ symbol: 'XX', bars: DOWN() });
  assert.eq(down.template.ok, false, '一路下跌还判通过，扫描器就没意义了');
  assert.ok(down.template.passed <= 3, `通过条数应很少，实际 ${down.template.passed}`);
  assert.ok(down.mom['m6m'] < 0);
  const thin = scanSymbol({ symbol: 'THIN', bars: series(40, 100, 0.001) });
  assert.ok(thin.error && /至少需要/.test(thin.error), `数据不足要说明，实际 ${thin.error}`);
  assert.eq(scanSymbol({ symbol: '', bars: [] }).error !== null, true, '空输入不许抛异常');
});

test('scanSymbol：量能门槛是硬条件 —— 突破没有跟进量时 broke 为真但 volOk 为假', () => {
  const dry = scanSymbol({ symbol: 'DRY', bars: UP() });        // 全程量 100，均量也 100 → 不到 1.2 倍
  assert.eq(dry.breakout.broke, true);
  assert.eq(dry.breakout.volOk, false, '没有量能确认的突破不该被当成有效突破');
});

test('扫描一池：失败的行保留原因，asOf 取最晚有数据的日期', () => {
  const res = scanUniverse([
    { symbol: 'AAA', name: '甲', bars: UP() },
    { symbol: 'BBB', name: '乙', bars: DOWN() },
    { symbol: 'CCC', name: '丙', bars: series(20, 100, 0.001) }
  ]);
  assert.eq(res.rows.length, 3, '失败的品种也要留在表里，不然用户不知道少了谁');
  assert.eq(res.errors.length, 1);
  assert.eq(res.errors[0].symbol, 'CCC');
  assert.eq(res.asOf, date(299));
  assert.ok(/可判定/.test(res.note));
  assert.ok(scanUniverse([]).note.includes('空的'));
});

test('filterRows：模板/突破/新高附近/ADX 四个过滤各自生效且互不干扰', () => {
  const rows = scanUniverse([
    { symbol: 'UP', bars: UP().map((b, i) => ({ ...b, volume: i >= 298 ? 300 : 100 })) },
    { symbol: 'DOWN', bars: DOWN() }
  ]).rows;
  assert.eq(filterRows(rows, { templateOnly: true }).map(r => r.symbol).join(','), 'UP');
  assert.eq(filterRows(rows, { breakoutOnly: true }).map(r => r.symbol).join(','), 'UP');
  assert.eq(filterRows(rows, { nearHighPct: 0.03 }).map(r => r.symbol).join(','), 'UP');
  assert.eq(filterRows(rows, { adxMin: 20 }).length, 2, 'ADX 只判趋势强度不判方向，单边下跌同样高 ADX —— 想排下跌要用模板过滤');
  assert.eq(filterRows(rows, { adxMin: 1000 }).length, 0, '阈值拉到不可能高时应筛空，而不是放行');
  assert.eq(filterRows(rows, { minBars: 250 }).length, 2);
  assert.eq(filterRows([{ error: 'x', symbol: 'E' }], {}).length, 0, '坏行不许被过滤器放出去');
});

test('sortRows：分数降序、缺失值排最后、并列按代码序稳定', () => {
  const rows = [
    { symbol: 'A', score: 1.2, bars: 10 }, { symbol: 'B', score: null, bars: 10 },
    { symbol: 'C', score: 2.5, bars: 10 }, { symbol: 'D', score: 1.2, bars: 10 }
  ];
  assert.eq(sortRows(rows, 'score', 'desc').map(r => r.symbol).join(','), 'C,A,D,B');
  assert.eq(sortRows(rows, 'score', 'asc').map(r => r.symbol).join(','), 'A,D,C,B', '升序时缺失值仍在最后');
  assert.eq(sortRows(rows, 'passed', 'desc').length, 4, '没有该列也不该崩');
  const byMom = sortRows([{ symbol: 'A', mom: { m6m: 0.1 } }, { symbol: 'B', mom: { m6m: 0.4 } }], 'm6m');
  assert.eq(byMom[0].symbol, 'B', '动量列要能排序');
});

test('scanSummary：给出这池的市场温度，而不是只有一张表', () => {
  const rows = scanUniverse([
    { symbol: 'UP1', bars: UP().map((b, i) => ({ ...b, volume: i >= 298 ? 300 : 100 })) },
    { symbol: 'UP2', bars: UP() },
    { symbol: 'DN', bars: DOWN() }
  ]).rows;
  const s = scanSummary(rows);
  assert.eq(s.total, 3);
  assert.eq(s.templateOk, 2);
  assert.eq(s.nearHigh, 2);
  assert.eq(s.rising, 2);
  assert.ok(s.note && /多头排列/.test(s.note));
  assert.eq(scanSummary([]).total, 0);
});

test('扫描口径与策略口径同源：模板说通过的，枢轴位在策略里也是同一个数', () => {
  const bars = UP().map((b, i) => ({ ...b, volume: i >= 298 ? 300 : 100 }));
  const row = scanSymbol({ symbol: 'X', bars });
  const tpl = trendTemplate(bars, {});
  const pb = pivotBreak(bars, { pivotLook: 25, volLen: 60, volMul: 1.2 });
  assert.eq(row.template.passed, tpl.passed, '扫描器和策略的通过条数必须一致');
  assert.eq(row.breakout.level, pb.level, '枢轴位必须是同一个数');
  assert.eq(row.template.ok, tpl.ok);
});

test('RS 参与判定：给了基准指数时 RS 条进入分母，跑输就不算通过', () => {
  const own = series(300, 100, 0.002, 300);
  const strongBench = series(300, 100, 0.008, 100);
  const weakBench = series(300, 100, 0.0005, 100);
  const lose = scanSymbol({ symbol: 'A', bars: own, indexBars: strongBench }, { useRs: true });
  const win = scanSymbol({ symbol: 'A', bars: own, indexBars: weakBench }, { useRs: true });
  assert.eq(lose.template.enabled, 8, '给了基准，判定分母应升到 8 条');
  assert.eq(lose.template.rsAvailable, true);
  assert.eq(lose.template.crit[7].ok, false, '跑输基准应判不通过');
  assert.eq(lose.template.ok, false, '有一条不过就不算通过');
  assert.eq(win.template.crit[7].ok, true, '跑赢基准判通过');
  assert.eq(win.template.ok, true);
  const noBench = scanSymbol({ symbol: 'A', bars: own }, { useRs: true });
  assert.eq(noBench.template.rsAvailable, false, '没基准时如实报告不可用，而不是当成通过');
});
