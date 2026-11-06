/**
 * 腾讯 ifzq 通道（东财 push2his 整段拒连时 A股 在线版唯一的兜底）的离线用例。
 * 全部用实测录下来的响应行，不联网。
 */
import { test, assert } from './harness.js';
import { tencentCodeOf, txRowsToBars, assertTxGeometry, tencentBasisOf, viaTencentDirect } from '../src/data/sources.js';
import { barKey, BarStore, getCacheByBases } from '../src/data/barStore.js';

// 2026-11-05 sz000001 真实行（新浪同日 open 11.710 / high 11.770 / low 11.560 / close 11.640 对得上）
const REAL_ROW = ['2026-11-05', '11.710', '11.640', '11.770', '11.560', '1228997.000'];

test('tencentCodeOf：东财 secid 的市场号换成腾讯前缀', () => {
  assert.eq(tencentCodeOf('0.000001'), 'sz000001', '深市');
  assert.eq(tencentCodeOf('1.600519'), 'sh600519', '沪市');
  assert.eq(tencentCodeOf('1.000300'), 'sh000300', '沪市指数同一条规则');
  assert.eq(tencentCodeOf('sh510300'), 'sh510300', '已是腾讯写法则原样');
  assert.eq(tencentCodeOf('113.rbm'), '', '期货 secid 不归本通道管');
  assert.eq(tencentCodeOf(''), '', '空输入不能编出一个代码');
});

test('txRowsToBars：第 3 列是收盘不是最高（列序写反=整根K线颠倒）', () => {
  const [b] = txRowsToBars([REAL_ROW]);
  assert.eq(b.date, '2026-11-05');
  assert.eq(b.open, 11.71);
  assert.eq(b.close, 11.64, 'close 必须落在第 3 列');
  assert.eq(b.high, 11.77);
  assert.eq(b.low, 11.56);
  assert.eq(b.volume, 1228997);
});

test('txRowsToBars：丢掉非数字与短行，输出按日期升序', () => {
  const bars = txRowsToBars([
    ['2026-11-05', '11.710', '11.640', '11.770', '11.560', '1'],
    ['2024-13-99', '1', '2', '3', '0.5', '1'],          // 日期不是 YYYY-MM-DD
    ['2026-11-03', 'a', 'b', 'c', 'd', '1'],            // 全非数字
    ['2026-11-04', '11.6'],                              // 列数不够
    ['2026-11-04', '11.750', '11.740', '11.860', '11.680', '1437906.000', '1680000000'],  // 多余字段
  ]);
  assert.deep(bars.map(b => b.date), ['2026-11-04', '2026-11-05'], '坏行不能产出 NaN bar');
  assert.eq(bars[0].high, 11.86);
});

test('assertTxGeometry：真实序列放行；把 close/high 两列写反必须拒绝', () => {
  const good = txRowsToBars(Array.from({ length: 30 }, (_, i) => {
    const d = `2026-09-${String(i + 1).padStart(2, '0')}`;
    return [d, '10.0', '10.5', '10.8', '9.7', '100'];
  }));
  assert.ok(assertTxGeometry(good) === undefined, '正常序列不该抛错');

  // 若上游改成 OHLC 而我们仍按 [开,收,高,低] 读，"high" 会变成 9.7 < max(open,close)=10.5
  const swapped = good.map(b => ({ ...b, high: b.low, low: b.close }));
  assert.throws(() => assertTxGeometry(swapped), '几何校验', '列序变了要拒绝出图，不能画颠倒K线');
});

test('tencentBasisOf：不复权不隔开，前/后复权按腾讯基准另存', () => {
  assert.eq(tencentBasisOf('none'), '');
  assert.eq(tencentBasisOf('qfq'), 'tx');
  assert.eq(tencentBasisOf('hfq'), 'tx');
});

test('barKey 加了基准位也不能动历史键（否则所有人的缓存一夜清空）', () => {
  assert.eq(barKey('ashare', '000001', 'daily', 'hfq'), 'ashare:000001:daily:hfq');
  assert.eq(barKey('ashare', '000001', 'daily', 'hfq', ''), 'ashare:000001:daily:hfq', '空基准=旧键');
  assert.ok(barKey('ashare', '000001', 'daily', 'hfq', 'tx') !== barKey('ashare', '000001', 'daily', 'hfq'),
    '腾讯基准必须另占一键');
});

test('getCacheByBases：东财基准优先，只有它没有时才认腾讯基准', async () => {
  const em = barKey('ashare', 'TEST1', 'daily', 'hfq');
  const tx = barKey('ashare', 'TEST1', 'daily', 'hfq', 'tx');
  await BarStore.setCache(tx, [{ date: '2026-01-01', open: 1, high: 2, low: 0.5, close: 1.5 }], { source: 'tencent' });
  const hit = await getCacheByBases('ashare', 'TEST1', 'daily', 'hfq');
  assert.ok(hit, '腾讯基准的缓存要能被秒开找到');
  assert.eq(hit.key, tx, '命中的键原样交回，回写才不会串到东财键上');

  await BarStore.setCache(em, [{ date: '2026-01-02', open: 1, high: 2, low: 0.5, close: 1.5 }], { source: 'eastmoney' });
  assert.eq((await getCacheByBases('ashare', 'TEST1', 'daily', 'hfq')).key, em, '东财恢复了就先回东财基准');
});

test('viaTencentDirect：没有的周期与不认识的口径一律拒绝，不拿日线顶替', async () => {
  for (const [arg, why] of [
    [{ secid: '0.000001', period: '60m', adjust: 'hfq' }, '没有 60m 这个周期'],
    [{ secid: '0.000001', period: '4h', adjust: 'hfq' }, '没有 4h 这个周期'],
    [{ secid: '113.rbm', period: 'daily', adjust: 'hfq' }, '解析不出'],
    [{ secid: '0.000001', period: 'daily', adjust: 'weird' }, '不认识复权口径'],
  ]) {
    let err = null;
    try { await viaTencentDirect(arg); } catch (e) { err = e; }
    assert.ok(err, `${arg.period}/${arg.adjust} 本该拒绝（${why}）`);
    assert.ok(String(err.message).includes(why), `报错文案该说明"${why}"，实际：${err.message}`);
  }
});
