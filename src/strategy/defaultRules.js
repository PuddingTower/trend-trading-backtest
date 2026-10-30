/**
 * 随应用启动加载的默认 JSON 规则。
 *
 * 这两条规则来自 2026-10 的 1 小时多品类研究（tools/fetch_intraday_1h.js +
 * tools/intraday1h_research.js），不是拍脑袋的示例：
 *   - 期货多空版在完整 30% 样本外：18 个品种中位收益 +1.4%、正收益 67%、
 *     中位 Sharpe 1.09、中位回撤 8.5%；等权组合 +4.3%、风险平价组合 +5.8%。
 *     但最差单品种回撤仍有 46.6%（原油），最后 15% 的震荡段走平 —— 只能算研究起点。
 *   - A股/ETF 不能做空，用只做多版；它在同一段样本外中位收益约 0，明显弱于多空版。
 *
 * 两条规则都只做趋势：价格离开慢线一定幅度且快慢线同向才入场，回到中性区或
 * ATR 移动止损离场；没有固定止盈、没有超买超卖反转。参数是整数值，避免把
 * 样本内的噪声当成可复现的边际。
 *
 * 注意：默认参数不是实盘建议。样本只有约 9–12 个月 60 分钟线，且期货主连
 * 不含交易所结算价（引擎按当日 VWAP 代理）。请先跑 Walk-Forward 与压力测试。
 */

const num = (type, def, min, max, label, description) => ({
  type, default: def, min, max, label, ...(description ? { description } : {})
});

const PARAMS = {
  fast: num('integer', 20, 2, 200, '快线', 'EMA 快线；必须小于慢线'),
  slow: num('integer', 89, 10, 400, '慢线', 'EMA 慢线；趋势带围绕它展开'),
  band: num('number', 0.01, 0, 0.5, '趋势带%', '收盘离开慢线至少这个比例才算趋势；回到带内即中性区'),
  atrLen: num('integer', 14, 2, 100, 'ATR周期', '止损与移动止损都按它计算'),
  stopAtr: num('number', 3, 0.5, 10, '初始止损(ATR倍)', '入场时挂在收盘价外侧的初始止损'),
  trailAtr: num('number', 6, 0.5, 12, '移动止损(ATR倍)', '从持仓期极值回撤 N 倍 ATR 收紧；只紧不松'),
  trailLook: num('integer', 40, 2, 100, '移动止损回看', '移动止损参考的极值回看根数')
};

const SERIES_BASE = {
  fast: { op: 'ema', source: { field: 'close' }, period: { param: 'fast' } },
  slow: { op: 'ema', source: { field: 'close' }, period: { param: 'slow' } },
  atr: { op: 'atr', period: { param: 'atrLen' } },
  hh: { op: 'priorHigh', source: { field: 'high' }, period: { param: 'trailLook' } }
};

const UPPER = { op: 'multiply', left: { series: 'slow' }, right: { op: 'add', left: { const: 1 }, right: { param: 'band' } } };
const LOWER = { op: 'multiply', left: { series: 'slow' }, right: { op: 'subtract', left: { const: 1 }, right: { param: 'band' } } };

const longRisk = {
  stop: {
    op: 'subtract', left: { field: 'close' },
    right: { op: 'multiply', left: { param: 'stopAtr' }, right: { series: 'atr' } }
  },
  trail: {
    op: 'subtract', left: { series: 'hh' },
    right: { op: 'multiply', left: { param: 'trailAtr' }, right: { series: 'atr' } }
  }
};

const RAW_RULES = [
  {
    schemaVersion: 1,
    kind: 'rules',
    id: 'intraday_ema_band_both',
    name: '1H EMA趋势带(期货多空)',
    revision: 1,
    description: '60分钟趋势带多空：收盘高于慢线 1% 且快线在慢线上方才做多，低于慢线 1% 且快线在慢线下方才做空；回到趋势带内或 ATR 移动止损离场，不设固定止盈。仅用于期货等可做空品种。研究样本约 5–12 个月（各品种覆盖不同），默认参数不是实盘建议。',
    parameters: PARAMS,
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: {
      ...SERIES_BASE,
      ll: { op: 'priorLow', source: { field: 'low' }, period: { param: 'trailLook' } }
    },
    rules: [
      {
        when: {
          op: 'and', conditions: [
            { op: 'greaterThan', left: { field: 'close' }, right: UPPER },
            { op: 'greaterThan', left: { series: 'fast' }, right: { series: 'slow' } }
          ]
        },
        do: { action: 'long', reason: '站上趋势带且快慢线多头排列', risk: longRisk }
      },
      {
        when: {
          op: 'and', conditions: [
            { op: 'lessThan', left: { field: 'close' }, right: LOWER },
            { op: 'lessThan', left: { series: 'fast' }, right: { series: 'slow' } }
          ]
        },
        do: {
          action: 'short', reason: '跌破趋势带且快慢线空头排列',
          risk: {
            stop: {
              op: 'add', left: { field: 'close' },
              right: { op: 'multiply', left: { param: 'stopAtr' }, right: { series: 'atr' } }
            },
            trail: {
              op: 'add', left: { series: 'll' },
              right: { op: 'multiply', left: { param: 'trailAtr' }, right: { series: 'atr' } }
            }
          }
        }
      },
      {
        when: {
          op: 'and', conditions: [
            { op: 'greaterThan', left: { field: 'close' }, right: LOWER },
            { op: 'lessThan', left: { field: 'close' }, right: UPPER }
          ]
        },
        do: { action: 'close', reason: '回到中性趋势带，趋势不明确' }
      }
    ]
  },
  {
    schemaVersion: 1,
    kind: 'rules',
    id: 'intraday_ema_band_long',
    name: '1H EMA趋势带(只做多)',
    revision: 1,
    description: '60分钟趋势带只做多：收盘高于慢线 1% 且快线在慢线上方才做多；跌回趋势带下沿或快线走弱离场，不设固定止盈。用于 A股/ETF 等不能做空的品种。同一段样本外它明显弱于期货多空版，默认参数不是实盘建议。',
    parameters: PARAMS,
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: SERIES_BASE,
    rules: [
      {
        when: {
          op: 'and', conditions: [
            { op: 'greaterThan', left: { field: 'close' }, right: UPPER },
            { op: 'greaterThan', left: { series: 'fast' }, right: { series: 'slow' } }
          ]
        },
        do: { action: 'long', reason: '站上趋势带且快慢线多头排列', risk: longRisk }
      },
      {
        when: {
          op: 'or', conditions: [
            { op: 'lessThan', left: { field: 'close' }, right: LOWER },
            { op: 'lessThan', left: { series: 'fast' }, right: { series: 'slow' } }
          ]
        },
        do: { action: 'close', reason: '跌回趋势带下沿或快慢线走弱' }
      }
    ]
  }
];

// 规则文档里 UPPER/LOWER/longRisk/参数定义是复用对象。编译器的复杂度检查会把共享引用
// 当成环（nodes=Infinity），所以这里按「一份 JSON 文档一份独立对象」深拷贝后再导出。
export const DEFAULT_RULES = RAW_RULES.map((rule) => JSON.parse(JSON.stringify(rule)));

export const DEFAULT_RULE_IDS = new Set(DEFAULT_RULES.map((rule) => rule.id));
