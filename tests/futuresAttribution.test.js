import { test, assert } from './harness.js';
import { sectorOf, sectorAttribution, decomposeRoll, portfolioRollExposure, SECTOR_OF } from '../src/report/futuresAttribution.js';

test('sectorOf：64 品种全覆盖，未知落"其他"，主连后缀剥离', () => {
  assert.eq(sectorOf('RB'), '黑色建材');
  assert.eq(sectorOf('rbm'), '黑色建材', '主连后缀 M 要剥掉');
  assert.eq(sectorOf('CU'), '有色金属');
  assert.eq(sectorOf('AU'), '贵金属');
  assert.eq(sectorOf('SC'), '能源化工');
  assert.eq(sectorOf('M'), '农产品软商品');
  assert.eq(sectorOf('IF'), '股指');
  assert.eq(sectorOf('T'), '国债');
  assert.eq(sectorOf('ZZ_UNKNOWN'), '其他');
  assert.eq(sectorOf(''), '其他');
  // 表里的每个品种都必须能落到七大板块之一（不许漏进"其他"）
  for (const [code, sec] of Object.entries(SECTOR_OF)) {
    assert.ok(sec !== '其他' || ['EC', 'PS'].includes(code), `${code} 应有明确板块`);
  }
});

test('sectorAttribution：分组加总、胜率、贡献占比', () => {
  const rows = [
    { symbol: 'RB', netPnL: 1000, trades: 10, wins: 6, sharpe: 1.0, maxDDPct: 0.1 },
    { symbol: 'HC', netPnL: 500, trades: 5, wins: 3, sharpe: 0.5, maxDDPct: 0.2 },
    { symbol: 'AU', netPnL: -300, trades: 4, wins: 1, sharpe: -0.4, maxDDPct: 0.05 },
    { symbol: 'IF', netPnL: 200, trades: 2, wins: 1, sharpe: 0.3, maxDDPct: 0.08 },
  ];
  const r = sectorAttribution(rows);
  assert.eq(r.totalPnL, 1400);
  const bySector = Object.fromEntries(r.sectors.map(s => [s.sector, s]));
  assert.near(bySector['黑色建材'].netPnL, 1500, 1e-9);
  assert.near(bySector['黑色建材'].winRate, 9 / 15, 1e-9);
  assert.near(bySector['黑色建材'].avgSharpe, (1.0 * 10 + 0.5 * 5) / 15, 1e-9, '按笔数加权');
  assert.near(bySector['黑色建材'].contributionPct, 1500 / 1400, 1e-9);
  assert.eq(bySector['黑色建材'].symbols.join(','), 'HC,RB');
  assert.near(bySector['贵金属'].netPnL, -300, 1e-9);
  assert.eq(r.sectors[0].sector, '黑色建材', '按净利降序排');
});

test('decomposeRoll：贴水与升水两条手算基线', () => {
  // 贴水换月：旧合约 100→102，新合约 90 起步 → gap=−12，展期收益 +12
  const barsBack = [
    { date: 'd1', close: 100, rawClose: 100, contract: 'A' },
    { date: 'd2', close: 101, rawClose: 101, contract: 'A' },
    { date: 'd3', close: 102, rawClose: 102, contract: 'A' },
    { date: 'd4', close: 90, rawClose: 90, contract: 'B', rollover: true },
    { date: 'd5', close: 91, rawClose: 91, contract: 'B' },
    { date: 'd6', close: 92, rawClose: 92, contract: 'B' },
  ];
  const r = decomposeRoll(barsBack);
  assert.ok(r.usable);
  assert.eq(r.nRolls, 1);
  assert.near(r.rolls[0].gap, -12, 1e-9);
  assert.near(r.rollYield, 12, 1e-9, '贴水结构：多头展期收基差');
  assert.near(r.rawPriceChange, -8, 1e-9, '未复权终点差 92−100');
  assert.near(r.totalRollAdjusted, 4, 1e-9, '真实持有收益 = −8 + 12 = 4（与逐合约盯市 2+2 一致）');

  // 升水换月：新合约更贵 → 多头展期付基差损耗
  const barsCont = [
    { date: 'd1', close: 100, rawClose: 100, contract: 'A' },
    { date: 'd2', close: 110, rawClose: 110, contract: 'B', rollover: true },
    { date: 'd3', close: 112, rawClose: 112, contract: 'B' },
  ];
  const r2 = decomposeRoll(barsCont);
  assert.near(r2.rolls[0].gap, 10, 1e-9);
  assert.near(r2.rollYield, -10, 1e-9, '升水结构：多头展期损耗');
  assert.near(r2.totalRollAdjusted, 2, 1e-9);
  assert.ok(r2.note && r2.note.includes('升水'), '升水要在 note 里点名基差损耗');

  // 没有 rawClose 的序列如实报不可用
  assert.eq(decomposeRoll([{ date: 'd1', close: 1 }]).usable, false);
});

test('decomposeRoll：无 rollover 标记时按 contract 变化识别', () => {
  const bars = [
    { date: 'd1', rawClose: 100, contract: 'A' },
    { date: 'd2', rawClose: 101, contract: 'A' },
    { date: 'd3', rawClose: 95, contract: 'B' },      // 换月但没打标记
    { date: 'd4', rawClose: 96, contract: 'B' },
  ];
  const r = decomposeRoll(bars);
  assert.eq(r.nRolls, 1, 'contract 变了就是换月，不管有没有标记');
  assert.near(r.rollYield, 6, 1e-9);
});

test('portfolioRollExposure：等权汇总与"做结构还是做方向"提示', () => {
  const list = [
    { usable: true, rollYieldPct: 0.10, rawPriceChangePct: 0.02 },   // 全靠贴水
    { usable: true, rollYieldPct: -0.04, rawPriceChangePct: 0.30 },  // 全靠方向
  ];
  const r = portfolioRollExposure(list);
  assert.ok(r.usable);
  assert.near(r.rollYieldPct, 0.03, 1e-9);
  assert.near(r.priceReturnPct, 0.16, 1e-9);
  assert.near(r.totalReturnPct, 0.19, 1e-9);
  assert.ok(r.note === null, '展期占比 3/19 不到一半，不该触发提示');
  const struct = portfolioRollExposure([
    { usable: true, rollYieldPct: 0.12, rawPriceChangePct: 0.01 },
    { usable: true, rollYieldPct: 0.10, rawPriceChangePct: 0.01 },
  ]);
  assert.ok(struct.note && struct.note.includes('期限结构'), '展期贡献占绝对主导要点破');
  assert.eq(portfolioRollExposure([{ usable: false }]).usable, false);
});
