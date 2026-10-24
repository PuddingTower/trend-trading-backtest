/**
 * 期货多维归因（架构白皮书 §2.4.1 的期货部分）：
 *   1) 板块归因 —— 黑色/有色/贵金属/能化/农产品/股指/国债七大板块的净利、胜率、笔数拆解；
 *   2) 展期收益拆解 —— 把主连序列的持有收益分离成「价格变动」与「展期收益/基差损耗」。
 *
 * 展期拆解的记账口径（这个推导在别处很少写清楚，必须留在注释里）：
 *   真实滚动持有的总盈亏 = Σ 每个合约自己持有期内的盯市盈亏。
 *   差值拼接（后复权）序列的起终点差 **恰好** 等于它，因为拼接在换月日把旧合约
 *   序列整体平移了 Σgap。于是有恒等式：
 *
 *     真实持有收益 = 未复权终点差 (rawClose_end − rawClose_start) − Σ换月缺口
 *
 *   其中换月缺口 gap = 新合约首根 rawClose − 旧合约末根 rawClose。
 *   长头寸视角：贴水结构（新合约更便宜，gap<0）→ 展期收益为正；
 *   升水结构（gap>0）→ 展期损耗为负 —— 这就是"基差损耗"的量化。
 *   注意：这里的"价格变动"用的是未复权终点差，它是"图表上看到的涨跌"，
 *   两者相加才回到真实收益 —— 单看哪一半都会得出错误结论。
 */

/* ---------------- 板块映射（contractSpecs 的 64 个品种全覆盖） ---------------- */

export const SECTORS = ['黑色建材', '有色金属', '贵金属', '能源化工', '农产品软商品', '股指', '国债', '其他'];

export const SECTOR_OF = {
  // 黑色建材
  RB: '黑色建材', HC: '黑色建材', I: '黑色建材', J: '黑色建材', JM: '黑色建材',
  SF: '黑色建材', SM: '黑色建材', SS: '黑色建材', FG: '黑色建材', SA: '黑色建材',
  // 有色金属
  CU: '有色金属', AL: '有色金属', ZN: '有色金属', PB: '有色金属', NI: '有色金属',
  SN: '有色金属', AO: '有色金属', SI: '有色金属', BC: '有色金属',
  // 贵金属
  AU: '贵金属', AG: '贵金属',
  // 能源化工
  RU: '能源化工', FU: '能源化工', BU: '能源化工', SP: '能源化工', BR: '能源化工',
  L: '能源化工', V: '能源化工', PP: '能源化工', EG: '能源化工', PG: '能源化工',
  SC: '能源化工', LU: '能源化工', NR: '能源化工', TA: '能源化工', MA: '能源化工',
  PF: '能源化工', PX: '能源化工', EB: '能源化工', UR: '能源化工',
  // 农产品软商品
  M: '农产品软商品', Y: '农产品软商品', A: '农产品软商品', B: '农产品软商品',
  P: '农产品软商品', C: '农产品软商品', CS: '农产品软商品', JD: '农产品软商品',
  LH: '农产品软商品', RR: '农产品软商品', SR: '农产品软商品', CF: '农产品软商品',
  RM: '农产品软商品', OI: '农产品软商品', AP: '农产品软商品', CJ: '农产品软商品',
  PK: '农产品软商品',
  // 股指
  IF: '股指', IH: '股指', IC: '股指', IM: '股指',
  // 国债
  T: '国债', TF: '国债', TS: '国债', TL: '国债',
  // 新能源新材料（广期所，归入有色/其他）
  LC: '有色金属', EC: '其他', PS: '其他',
};

export function sectorOf(symbol) {
  const s = String(symbol || '').toUpperCase();
  // 先查全码再剥主连后缀 —— 单字母品种（M 豆粕、P 棕榈油）自身以 M 结尾，先剥会变成空串
  if (SECTOR_OF[s]) return SECTOR_OF[s];
  return SECTOR_OF[s.replace(/M$/, '')] || '其他';
}

/**
 * 板块归因。allocation 是组合/跑批层的逐品种结果行：
 *   [{ symbol, netPnL, trades, wins, sharpe, maxDDPct }]（wins 缺省按 netPnL>0 估算不了，
 *   只在给了的时候算胜率，不给就 null —— 不猜）。
 */
export function sectorAttribution(allocation) {
  const rows = allocation || [];
  const acc = new Map();
  for (const r of rows) {
    const sec = sectorOf(r.symbol);
    let a = acc.get(sec);
    if (!a) { a = { sector: sec, symbols: [], netPnL: 0, trades: 0, wins: 0, hasWins: false, sharpeW: 0, mddWorst: 0 }; acc.set(sec, a); }
    a.symbols.push(r.symbol);
    a.netPnL += (Number.isFinite(r.netPnL) ? r.netPnL : 0);
    a.trades += (Number.isFinite(r.trades) ? r.trades : 0);
    if (Number.isFinite(r.wins)) { a.wins += r.wins; a.hasWins = true; }
    if (Number.isFinite(r.sharpe)) a.sharpeW += r.sharpe * (r.trades || 1);   // 按笔数加权
    if (Number.isFinite(r.maxDDPct)) a.mddWorst = Math.max(a.mddWorst, r.maxDDPct);
  }
  const out = [...acc.values()].map(a => ({
    sector: a.sector,
    symbols: a.symbols.sort(),
    n: a.symbols.length,
    netPnL: Math.round(a.netPnL * 100) / 100,
    trades: a.trades,
    winRate: a.hasWins && a.trades > 0 ? a.wins / a.trades : null,
    avgSharpe: a.trades > 0 ? a.sharpeW / a.trades : null,
    worstMaxDDPct: a.mddWorst || null
  })).sort((x, y) => y.netPnL - x.netPnL);
  const total = out.reduce((s, a) => s + a.netPnL, 0);
  for (const a of out) a.contributionPct = total !== 0 ? a.netPnL / Math.abs(total) : null;
  return { sectors: out, totalPnL: Math.round(total * 100) / 100 };
}

/* ---------------- 展期收益拆解 ---------------- */

/**
 * 从主连拼接序列拆出价格变动与展期收益。
 * bars 必须带 rawClose（dominant.stitch 的产物都有）；rollover 标记可选 ——
 * 没有标记时按 contract 变化识别换月。
 */
export function decomposeRoll(bars) {
  const list = (bars || []).filter(b => b && Number.isFinite(b.rawClose));
  if (list.length < 2) return { usable: false, note: '序列无 rawClose（不是拼接产物或数据不足）' };
  const rolls = [];
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1], cur = list[i];
    const isRoll = cur.rollover === true || (cur.contract && prev.contract && cur.contract !== prev.contract);
    if (!isRoll) continue;
    const gap = cur.rawClose - prev.rawClose;
    rolls.push({
      date: cur.date, from: prev.contract || null, to: cur.contract || null,
      gap: Math.round(gap * 1e4) / 1e4,
      gapPct: prev.rawClose ? gap / prev.rawClose : null
    });
  }
  const p0 = list[0].rawClose, p1 = list[list.length - 1].rawClose;
  const rawPriceChange = p1 - p0;
  const gapSum = rolls.reduce((s, r) => s + r.gap, 0);
  // 长头寸的展期收益 = −Σgap：贴水（gap<0）→ 正收益；升水 → 负（基差损耗）
  const rollYield = -gapSum;
  return {
    usable: true,
    rawStart: p0, rawEnd: p1,
    rawPriceChange: Math.round(rawPriceChange * 1e4) / 1e4,
    rawPriceChangePct: p0 ? rawPriceChange / p0 : null,
    rollYield: Math.round(rollYield * 1e4) / 1e4,
    rollYieldPct: p0 ? rollYield / p0 : null,
    totalRollAdjusted: Math.round((rawPriceChange + rollYield) * 1e4) / 1e4,
    rolls,
    nRolls: rolls.length,
    note: rolls.some(r => r.gap > 0)
      ? '存在升水换月（gap>0）：多头每次展期都在付基差损耗，图表上看到的价格涨幅里有水分'
      : (rolls.length ? '全部为贴水换月：多头展期在收基差收益，图上的涨幅低估了真实持有收益' : null)
  };
}

/**
 * 把一批品种的 decomposeRoll 汇总成组合口径：
 *   组合展期收益 = Σ 每品种 rollYieldPct × 该品种名义权重（默认等权）。
 * 这是"策略的收益里有多少来自贴水结构而非方向判断"的组合级答案。
 */
export function portfolioRollExposure(list, weights = null) {
  const rows = (list || []).filter(r => r && r.usable);
  if (!rows.length) return { usable: false, note: '没有可用的展期拆解结果' };
  const w = weights || rows.map(() => 1 / rows.length);
  const ws = w.reduce((a, b) => a + b, 0);
  let roll = 0, price = 0, total = 0;
  rows.forEach((r, i) => {
    const wi = w[i] / ws;
    roll += wi * (r.rollYieldPct ?? 0);
    price += wi * (r.rawPriceChangePct ?? 0);
    total += wi * ((r.rollYieldPct ?? 0) + (r.rawPriceChangePct ?? 0));
  });
  return {
    usable: true, n: rows.length,
    priceReturnPct: price, rollYieldPct: roll, totalReturnPct: total,
    rollShare: total !== 0 ? roll / total : null,
    note: Math.abs(roll) > Math.abs(total) * 0.5 && total !== 0
      ? '展期贡献超过总收益一半：这个组合主要在做期限结构，不是在赌方向'
      : null
  };
}
