/**
 * 应用启动即加载的默认 JSON 规则。
 *
 * 六条规则按 docs/趋势交易方法论研究.md 保留的五种方法（M1–M5）对齐，一条一个层级：
 *   M5 1H EMA 趋势带（本仓库自研，唯一通过完整 30% 样本外的规则）—— 日内执行层，2 条
 *   M2 日频时序动量 + ATR 阈值（Moskowitz–Ooi–Pedersen 一族的信号腿）—— 组合层的单品种腿，2 条
 *   M3 海龟 S2（55 日突破 / 20 日反向通道出场 / 2N 止损）—— 期货战术层，1 条
 *   M1 月线均线闸门（Faber 10 月 SMA + 缓冲带）—— 战略仓位层，1 条
 * 文献方法与本地研究的差异在各自 description 里写明，metadata 记录方法编号与适用频率。
 *
 * M4（Minervini 趋势模板 8 条 + 枢轴买点）故意不在这里重复一遍：它的"200 日线上行"需要
 * 滞后算子、RS 判据需要横截面基准，v1 规则文档都表达不了，而 src/strategy/library.js 的
 * minerviniTemplate 已经按 8 条实现并被市场扫描器共用 —— 在规则层重写等于制造第二个真值源。
 * M3 的同族裸突破也已在内置库（donchianBreak，20/10/ATR14），这里只补文献的 S2 参数档。
 *
 * 证据状态（不要把默认参数当实盘建议）：
 *   - M5 多空版：18 个期货品种完整 30% 样本外中位 +1.4%、正收益 67%、中位 Sharpe 1.09、
 *     中位回撤 8.5%，最差单品种回撤 46.6%（原油）。只做多版同段中位收益约 0。
 *   - M1/M2/M3 是文献规则的可跑翻译。本仓库日线单品种上没有稳健边际（同族 20/10 突破
 *     11/17 正收益但仅 4/17 跑赢买入持有）；文献里的正收益全部是几十个市场等权 +
 *     每头寸同波动目标之后的组合曲线，所以这三条必须配组合层与风险平价仓位一起用。
 *   - 期货主连不含交易所结算价（引擎按当日 VWAP 代理），样本 2015 年起约 11.8 年。
 *     请先跑 Walk-Forward、压力测试与 CSCV-PBO，再谈取舍。
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

// ---------------- M2：日频时序动量 + ATR 阈值中性区 ----------------
// 文献写法是 sign(r_t-n→t) 在 3/6/12 月三个窗口上等权平均（"many worlds"，比单窗口稳）。
// v1 规则文档没有滞后算子，写不出"n 个月前的收盘价"，改用它的 ATR 阈值同族形式：
// (close - SMA_n) / ATR。两者都是"离均线几个波动单位"，且后者正好是 M5 那条 1H 规则的日线版。
const TSMOM_PARAMS = {
  w1: num('integer', 63, 5, 250, '动量窗口1', '约 3 个月的交易日数'),
  w2: num('integer', 126, 10, 380, '动量窗口2', '约 6 个月的交易日数'),
  w3: num('integer', 252, 20, 500, '动量窗口3', '约 12 个月的交易日数；三窗口必须等权平均，单窗口的读数在文献里不稳'),
  atrLen: num('integer', 14, 2, 100, 'ATR周期', '阈值与初始止损共用的尺度'),
  theta: num('number', 0.5, 0.05, 3, '开仓阈值(ATR倍)', '三窗口均分高于它才允许持仓，落在 ±它之间 = 中性区空仓'),
  stopAtr: num('number', 3, 0, 10, '初始止损(ATR倍)', '主风险阀是组合层的波动率目标，这里只防隔夜跳空把亏损放大')
};

const TSMOM_SERIES = {
  ma1: { op: 'sma', source: { field: 'close' }, period: { param: 'w1' } },
  ma2: { op: 'sma', source: { field: 'close' }, period: { param: 'w2' } },
  ma3: { op: 'sma', source: { field: 'close' }, period: { param: 'w3' } },
  atr: { op: 'atr', period: { param: 'atrLen' } }
};

// 任一窗口还在暖机（值为 null）时整个得分算不出来，条件一律不成立 —— 不会用 0 假装"中性"。
const devOf = (ma) => ({
  op: 'divide',
  left: { op: 'subtract', left: { field: 'close' }, right: { series: ma } },
  right: { series: 'atr' }
});
const score3 = {
  op: 'divide',
  left: {
    op: 'add',
    left: { op: 'add', left: devOf('ma1'), right: devOf('ma2') },
    right: devOf('ma3')
  },
  right: { const: 3 }
};
const THETA_UP = { param: 'theta' };
const THETA_DOWN = { op: 'multiply', left: { param: 'theta' }, right: { const: -1 } };
const isAboveTheta = { op: 'greaterThan', left: score3, right: THETA_UP };
const isBelowTheta = { op: 'lessThan', left: score3, right: THETA_DOWN };
const isNeutral = { op: 'and', conditions: [{ op: 'not', condition: isAboveTheta }, { op: 'not', condition: isBelowTheta }] };

const tsmomRisk = (sign) => ({
  stop: {
    op: sign > 0 ? 'subtract' : 'add', left: { field: 'close' },
    right: { op: 'multiply', left: { param: 'stopAtr' }, right: { series: 'atr' } }
  }
});

// ---------------- M3：海龟 S2 通道突破 ----------------
const TURTLE_PARAMS = {
  entry: num('integer', 55, 2, 250, '突破回看', 'S2 用 55 根；S1 的 20 根带"上次盈利则跳过"状态，规则层表达不了'),
  exit: num('integer', 20, 2, 250, '出场回看', 'S2 的反向通道是 20 根（S1 才是 10 根）'),
  atrLen: num('integer', 20, 2, 100, 'N 周期', '海龟的 N = 20 日 Wilder ATR；内置 donchianBreak 默认 14，按文献改回 20 手数才不偏大'),
  stopAtr: num('number', 2, 0, 10, '初始止损(N倍)', '入场价 ±2N')
};

const TURTLE_SERIES = {
  entryHigh: { op: 'priorHigh', source: { field: 'high' }, period: { param: 'entry' } },
  entryLow: { op: 'priorLow', source: { field: 'low' }, period: { param: 'entry' } },
  exitHigh: { op: 'priorHigh', source: { field: 'high' }, period: { param: 'exit' } },
  exitLow: { op: 'priorLow', source: { field: 'low' }, period: { param: 'exit' } },
  atr: { op: 'atr', period: { param: 'atrLen' } }
};

const turtleRisk = (sign) => ({
  stop: {
    op: sign > 0 ? 'subtract' : 'add', left: { field: 'close' },
    right: { op: 'multiply', left: { param: 'stopAtr' }, right: { series: 'atr' } }
  }
});

// ---------------- M1：月线均线闸门 ----------------
// 判定时点在月收盘、执行在次月首日开盘 —— 月线 bar 上"信号在 i、成交在 i+1 开盘"恰好就是这个次序。
// 两条规则之间留出缓冲带：带内不出任何信号，引擎继续持有，这才是 Faber 低换手的来源。
const GATE_PARAMS = {
  smaLen: num('integer', 10, 2, 60, '月均线', 'Faber 原文用 10 个月收盘价的简单平均；日线替代口径是 200 日均线，但 150/250 不复现，不要当成魔法数字'),
  band: num('number', 0.01, 0, 0.2, '缓冲带%', '高出均线这一比例才建仓、跌破均线下方这一比例才空仓，带内不动')
};

const GATE_SERIES = {
  ma: { op: 'sma', source: { field: 'close' }, period: { param: 'smaLen' } }
};

const GATE_UP = { op: 'multiply', left: { series: 'ma' }, right: { op: 'add', left: { const: 1 }, right: { param: 'band' } } };
const GATE_DOWN = { op: 'multiply', left: { series: 'ma' }, right: { op: 'subtract', left: { const: 1 }, right: { param: 'band' } } };

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
    ],
    metadata: { method: 'M5', layer: '日内执行层', freq: '60m', markets: ['futures'], evidence: '本地研究 + 完整 30% 样本外' }
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
    ],
    metadata: { method: 'M5', layer: '日内执行层', freq: '60m', markets: ['ashare', 'futures'], evidence: '本地研究；同段样本外明显弱于多空版' }
  },
  {
    schemaVersion: 1,
    kind: 'rules',
    id: 'daily_tsmom_atr_band_both',
    name: 'M2 日频时序动量(期货多空)',
    revision: 1,
    description: '日频时序动量 + ATR 阈值中性区：63/126/252 三窗口「收盘距均线几个 ATR」等权平均，均分高于阈值做多、低于负阈值做空、两者之间空仓；反向信号即离场，不设固定止盈。只用于可做空品种，只在日线周期运行（月线/60分钟上窗口含义会变）。文献里这一族的正收益是组合曲线（TTU 43 个程序、费后年化 7.43% / 最大回撤 20.93%；Moskowitz–Ooi–Pedersen 2012），单品种层面本仓库没有边际：日线 17 品种、1 手、全样本内、滑点 1 tick 的口径下 6/17 正收益、2/17 跑赢买入持有、平均 Sharpe −0.09。必须配 ≥15 个低相关品种 + 波动率目标或 ATR 反比风险平价一起用，默认参数不是实盘建议。',
    parameters: TSMOM_PARAMS,
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: TSMOM_SERIES,
    rules: [
      { when: isAboveTheta, do: { action: 'long', reason: '三窗口趋势分高于阈值，多头趋势态', risk: tsmomRisk(1) } },
      { when: isBelowTheta, do: { action: 'short', reason: '三窗口趋势分低于负阈值，空头趋势态', risk: tsmomRisk(-1) } },
      { when: isNeutral, do: { action: 'close', reason: '回到 ±阈值中性区，趋势不明确' } }
    ],
    metadata: { method: 'M2', layer: '组合层的单品种信号腿', freq: 'daily', markets: ['futures'],
      evidence: '文献规则翻译；本地日线 17 品种 6/17 正收益、2/17 跑赢持有、平均 Sharpe −0.09，只在组合层 + 风险平价下才有意义' }
  },
  {
    schemaVersion: 1,
    kind: 'rules',
    id: 'daily_tsmom_atr_band_long',
    name: 'M2 日频时序动量(只做多)',
    revision: 1,
    description: '上一条的多头半边：三窗口趋势分高于阈值才持有 ETF/股票，回到阈值内或转负就空仓（不能做空时的兜底）。只在日线周期运行。多头单腿的收益低于多空版，文献里的回撤改善主要由「跌回均线即空仓」贡献，而不是由做空贡献。本仓库日线 17 品种同口径读数：7/17 正收益、4/17 跑赢买入持有、平均 Sharpe 0.06，最差单品种回撤 95.6%。默认参数不是实盘建议。',
    parameters: TSMOM_PARAMS,
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: TSMOM_SERIES,
    rules: [
      { when: isAboveTheta, do: { action: 'long', reason: '三窗口趋势分高于阈值，多头趋势态', risk: tsmomRisk(1) } },
      {
        when: { op: 'not', condition: isAboveTheta },
        do: { action: 'close', reason: '趋势分回到阈值内或转负' }
      }
    ],
    metadata: { method: 'M2', layer: '组合层的单品种信号腿', freq: 'daily', markets: ['ashare', 'futures'],
      evidence: '文献规则翻译；本地日线 17 品种 7/17 正收益、4/17 跑赢持有、平均 Sharpe 0.06' }
  },
  {
    schemaVersion: 1,
    kind: 'rules',
    id: 'daily_donchian_turtle_s2',
    name: 'M3 海龟S2突破(55/20)',
    revision: 1,
    description: '海龟 S2 腿：收盘高于上一根为止 55 根最高价做多、低于 55 根最低价做空（突破判定不含当日），反向 20 根通道被收盘击穿即离场或反手，初始止损 ±2N（N = 20 日 ATR，文献口径），不设目标位。只在日线周期运行。规则层做不到、必须留在仓位层与执行层的海龟纪律有三条：unit = 1% 净值 ÷ (N × 每点价值)、每顺势 0.5N 加 1 单位至 4 单位（用 src/core/sizing.js 的 ATR 风险预算与加仓档），以及 S1 的「上次 20 日突破盈利则跳过本次信号」（有状态）。海龟学员账户属 C 级证据，同族业绩看 M2 的 A 级指数。本仓库日线 17 品种同口径读数：8/17 正收益、2/17 跑赢买入持有、平均 Sharpe 0.06 —— 比内置 donchianBreak 的 20/10 档（11/17 正收益、4/17 跑赢、0.14）更弱，说明文献参数不是本地最优，别把它当默认就该用的版本。',
    parameters: TURTLE_PARAMS,
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: TURTLE_SERIES,
    rules: [
      { when: { op: 'greaterThan', left: { field: 'close' }, right: { series: 'entryHigh' } },
        do: { action: 'long', reason: '突破 55 根高点(S2)', risk: turtleRisk(1) } },
      { when: { op: 'lessThan', left: { field: 'close' }, right: { series: 'entryLow' } },
        do: { action: 'short', reason: '跌破 55 根低点(S2 反向)', risk: turtleRisk(-1) } },
      { when: { op: 'lessThan', left: { field: 'close' }, right: { series: 'exitLow' } },
        do: { action: 'close', reason: '跌破 20 根反向通道，多头离场' } },
      { when: { op: 'greaterThan', left: { field: 'close' }, right: { series: 'exitHigh' } },
        do: { action: 'close', reason: '越过 20 根反向通道，空头离场' } }
    ],
    metadata: { method: 'M3', layer: '期货战术层', freq: 'daily', markets: ['futures'],
      evidence: '文献规则翻译(C级账户)；本地日线 8/17 正收益、2/17 跑赢持有、平均 Sharpe 0.06，弱于内置 20/10 档' }
  },
  {
    schemaVersion: 1,
    kind: 'rules',
    id: 'monthly_sma_gate_long',
    name: 'M1 月线均线闸门(持有/空仓)',
    revision: 1,
    description: '月线均线趋势闸门（Faber 式 10 月 SMA + 缓冲带）：月收盘高出均线一个缓冲带才在下个月持有，跌破均线下方缓冲带才换成现金，带内不出信号即继续持有。只在月线周期运行 —— 日线或 60 分钟上它会把 10 根当成 10 天，读数无意义。它是五种方法里唯一不需要盘中条件单的一层，换手极低，代价是永远慢一步。文献读数是「少亏」型：5 类资产 GTAA 组合 Sharpe 0.75→1.20、最大回撤 −19.62%→−9.51%；沪深 300 散户级复测回撤 45.4%→37.7%、年化 7.67%→7.19%，且 150/250 日均线不复现。本仓库月线 17 品种同口径读数：8/17 正收益、4/17 跑赢买入持有、平均 Sharpe 0.05、单品种最多 14 笔（换手确实极低）；形状与文献一致 —— 沪深300ETF 回撤 38.5%→10.4% 但涨幅 41.8%→3.3%，沪金 +278%→+566%，宁德时代 +1757%→+123%。它是"少亏"型记录，右尾大的品种会被切掉。',
    parameters: GATE_PARAMS,
    requires: { fields: ['open', 'high', 'low', 'close', 'volume'] },
    series: GATE_SERIES,
    rules: [
      { when: { op: 'greaterThan', left: { field: 'close' }, right: GATE_UP },
        do: { action: 'long', reason: '月收盘高于均线+缓冲带，下月持有' } },
      { when: { op: 'lessThan', left: { field: 'close' }, right: GATE_DOWN },
        do: { action: 'close', reason: '月收盘跌破均线−缓冲带，下月空仓' } }
    ],
    metadata: { method: 'M1', layer: '战略仓位层', freq: 'monthly', markets: ['ashare', 'futures'],
      evidence: '文献 A− 级记录；本地月线 17 品种 8/17 正收益、4/17 跑赢持有、平均 Sharpe 0.05' }
  }
];

// 规则文档里 UPPER/LOWER/longRisk/参数定义是复用对象。编译器的复杂度检查会把共享引用
// 当成环（nodes=Infinity），所以这里按「一份 JSON 文档一份独立对象」深拷贝后再导出。
export const DEFAULT_RULES = RAW_RULES.map((rule) => JSON.parse(JSON.stringify(rule)));

export const DEFAULT_RULE_IDS = new Set(DEFAULT_RULES.map((rule) => rule.id));
