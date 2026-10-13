/**
 * 交易所代码表 —— 数值来自 2026-10-13 对 eastmoney 接口的实测（tools/probe_em_dominant.py），
 * 不是凭记忆写的：每个 marketId 都实际返回过合约，每个 <品种>m 主连都取到过 2026-10-13 的 K线。
 */

export const EXCHANGES = {
  SHFE: { id: 113, name: '上期所', fullName: '上海期货交易所' },
  DCE: { id: 114, name: '大商所', fullName: '大连商品交易所' },
  CZCE: { id: 115, name: '郑商所', fullName: '郑州商品交易所' },
  INE: { id: 142, name: '上期能源', fullName: '上海国际能源交易中心' },
  CFFEX: { id: 220, name: '中金所', fullName: '中国金融期货交易所' },
  GFEX: { id: 225, name: '广期所', fullName: '广州期货交易所' }
};

export const MARKET_ID_TO_EXCHANGE = Object.fromEntries(
  Object.entries(EXCHANGES).map(([k, v]) => [v.id, k])
);

/** 郑商所合约月份用 3 位（SR609 = 2026年9月），其余交易所用 4 位（rb2609）。 */
export const MONTH_CODE_LEN = { CZCE: 3, SHFE: 4, DCE: 4, INE: 4, CFFEX: 4, GFEX: 4 };

/** eastmoney secid：A股/ETF/指数用 1=沪 0=深；期货用上表 marketId。 */
export const emSecid = (marketId, code) => `${marketId}.${String(code).toUpperCase()}`;

/** 主连（主力连续）合约号：实测所有 6 个交易所统一是 品种代码 + m，且大小写不敏感。 */
export const dominantCode = (variety) => `${variety}m`;
