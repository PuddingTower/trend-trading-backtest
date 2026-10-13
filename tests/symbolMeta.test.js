import { test, assert } from './harness.js';
import { classifyAShare, parseSymbol, parseFutures, MARKETS } from '../src/markets/symbolMeta.js';
import { getFuturesSpec, roundToTick, calcFuturesFee, FUTURES_SPECS } from '../src/markets/contractSpecs.js';

test('A股：600519 归沪市主板，涨跌停 10%', () => {
  const r = classifyAShare('600519');
  assert.ok(r.ok, '应识别');
  assert.eq(r.exchange, 'SH');
  assert.eq(r.kind, 'stock');
  assert.eq(r.secid, '1.600519');
  assert.near(r.limitPct, 0.10, 1e-9);
});

test('A股：688981 科创板 20%，300750 创业板 20%', () => {
  assert.eq(classifyAShare('688981').board, '科创板');
  assert.near(classifyAShare('688981').limitPct, 0.20, 1e-9);
  assert.eq(classifyAShare('300750').board, '创业板');
  assert.near(classifyAShare('300750').limitPct, 0.20, 1e-9);
});

test('A股：000001 同码多义必须给候选，不静默选一个', () => {
  const r = classifyAShare('000001');
  assert.ok(r.ok, '应识别为有效代码段');
  assert.ok(r.ambiguous, '000001 应标记为歧义');
  assert.eq(r.candidates.length, 2, '候选=平安银行(深股票)+上证指数(沪指数)');
  assert.ok(r.candidates.some(c => c.secid === '0.000001'), '应有深市股票候选');
  assert.ok(r.candidates.some(c => c.secid === '1.000001' && c.kind === 'index'), '应有沪市指数候选');
});

test('A股：ETF 与指数分段', () => {
  assert.eq(classifyAShare('510300').kind, 'etf');
  assert.eq(classifyAShare('510300').secid, '1.510300');
  assert.eq(classifyAShare('159915').kind, 'etf');
  assert.eq(classifyAShare('159915').secid, '0.159915');
  assert.eq(classifyAShare('399001').kind, 'index');
  assert.eq(classifyAShare('399001').exchange, 'SZ');
});

test('A股：北交所 830799 / 430047 → 30% 板幅', () => {
  for (const c of ['830799', '430047', '871981']) {
    const r = classifyAShare(c);
    assert.eq(r.exchange, 'BJ', `${c} 应归北交所`);
    assert.near(r.limitPct, 0.30, 1e-9, `${c} 北交所涨跌停`);
    assert.eq(r.secid, `0.${c}`, '北交所走 eastmoney 深市槽位 0');
  }
});

test('A股：显式前缀是消歧依据（sz000001 vs sh000001）', () => {
  assert.eq(parseSymbol('sh000001').secid, '1.000001');
  assert.eq(parseSymbol('sh000001').kind, 'index');
  assert.eq(parseSymbol('sz000001').secid, '0.000001');
  assert.eq(parseSymbol('sz000001').kind, 'stock');
  assert.eq(parseSymbol('SZ.002594').exchange, 'SZ');
});

test('A股：非法代码要拒绝而不是瞎猜', () => {
  assert.ok(!classifyAShare('123456').ok);
  assert.ok(!classifyAShare('60051').ok, '位数不足');
  assert.ok(!parseSymbol('').ok);
});

test('期货：rb2610 → 上期所具体合约', () => {
  const r = parseFutures('rb2610');
  assert.ok(r.ok);
  assert.eq(r.variety, 'RB');
  assert.eq(r.exchange, 'SHFE');
  assert.eq(r.secid, '113.rb2610');
  assert.eq(r.isDominant, false);
});

test('期货：RB0（文华主力写法）与 rbm 都落到主连', () => {
  assert.eq(parseFutures('RB0').secid, '113.rbm');
  assert.eq(parseFutures('rbm').secid, '113.rbm');
  assert.eq(parseFutures('rbm').isDominant, true);
});

test('期货：中文品种名解析（螺纹钢2610 / 螺纹钢主连）', () => {
  assert.eq(parseFutures('螺纹钢2610').secid, '113.rb2610');
  assert.eq(parseFutures('螺纹钢主连').secid, '113.rbm');
  assert.eq(parseFutures('乙二醇').secid, '114.egm');
  assert.eq(parseFutures('').ok || parseFutures('').reason === '空代码', true);
});

test('期货：郑商所 3 位月份码 SR609 / 大写品种', () => {
  const r = parseFutures('SR609');
  assert.ok(r.ok, 'SR609 应解析');
  assert.eq(r.exchange, 'CZCE');
  assert.eq(r.secid, '115.SR609');
});

test('期货：六大交易所 marketId 与实测一致', () => {
  const expect = { SHFE: '113', DCE: '114', CZCE: '115', INE: '142', CFFEX: '220', GFEX: '225' };
  for (const [ex, id] of Object.entries(expect)) {
    const v = { SHFE: 'cu', DCE: 'm', CZCE: 'MA', INE: 'sc', CFFEX: 'IF', GFEX: 'lc' }[ex];
    const r = parseFutures(`${v}2610`.replace('MA2610', 'MA610').replace('IF2610', 'IF2610'));
    assert.ok(r.ok, `${v} 应可解析`);
    assert.eq(r.secid.split('.')[0], id, `${ex} marketId`);
  }
});

test('期货：未知品种拒绝，不返回半成品', () => {
  assert.eq(parseFutures('zz9999').ok, false);
  assert.eq(parseFutures('不存在的品种').ok, false);
});

test('规格表：乘数/tick 抽查（回测最敏感的两项）', () => {
  const cases = [
    ['RB', 10, 1], ['CU', 5, 10], ['AU', 1000, 0.02], ['AG', 15, 1],
    ['SC', 1000, 0.1], ['IF', 300, 0.2], ['I', 100, 0.5], ['SR', 10, 1],
    ['EG', 10, 1], ['M', 10, 1], ['LH', 16, 5], ['LC', 1, 50]
  ];
  for (const [v, mult, tick] of cases) {
    const s = getFuturesSpec(v);
    assert.ok(s, `${v} 应在规格表内`);
    assert.eq(s.multiplier, mult, `${v} 合约乘数`);
    assert.eq(s.tick, tick, `${v} 最小变动价位`);
  }
});

test('规格表：每条目字段完整，主连代码可由 emCode 推出', () => {
  for (const [code, s] of Object.entries(FUTURES_SPECS)) {
    assert.ok(s.name && s.exchange && s.unit && s.aliases?.length, `${code} 字段缺失`);
    assert.ok(s.multiplier > 0 && s.tick > 0, `${code} 乘数/tick 非法`);
    assert.ok(s.marginRate > 0 && s.marginRate < 1, `${code} 保证金率异常`);
    assert.ok(s.limitPct > 0 && s.limitPct <= 0.35, `${code} 涨跌停幅度异常`);
    assert.ok(['high', 'verify'].includes(s.confidence), `${code} 置信度标记缺失`);
  }
});

test('tick 取整：AU 0.02 网格、CU 10 网格、I 0.5 网格', () => {
  assert.eq(roundToTick(457.839, 0.02), 457.84);
  assert.eq(roundToTick(78453, 10), 78450);
  assert.eq(roundToTick(812.7, 0.5), 812.5);
  assert.eq(roundToTick(3089, 1), 3089);
});

test('手续费：固定/费率两种模式，平今仓单独计费', () => {
  const rb = getFuturesSpec('RB');
  assert.eq(calcFuturesFee(rb, 3090, 1), 3.09);                          // rate 1%%，按分收口
  const m = getFuturesSpec('M');
  assert.eq(calcFuturesFee(m, 3000, 2), 3);                               // 1.5 元/手 × 2
  const if_ = getFuturesSpec('IF');
  // 3900 点 × 300 元/点 = 117 万名义额，万 0.23 → 26.91 元
  assert.eq(calcFuturesFee(if_, 3900, 1), 26.91);
  const today = calcFuturesFee(if_, 3900, 1, { closeToday: true });
  assert.eq(today, 269.1, '中金所平今万 2.3');
  assert.ok(today > calcFuturesFee(if_, 3900, 1) * 5, '中金所平今应显著贵于平昨');
});

test('易混写法：豆粕 m2610 是个合约，不能被当成主连；MM 才是豆粕主连', () => {
  assert.eq(parseFutures('m2610').secid, '114.m2610');
  assert.eq(parseFutures('m2610').isDominant, false);
  assert.eq(parseFutures('M0').secid, '114.mm');
  assert.eq(parseFutures('MM').secid, '114.mm');
  assert.eq(parseFutures('SM').secid, '115.SMm', 'SM 本身是锰硅品种，剥 m 会变错品种');
  assert.eq(parseFutures('SM2609').secid, '115.SM609', '郑商所 4 位年份要归一成 3 位月份');
});

