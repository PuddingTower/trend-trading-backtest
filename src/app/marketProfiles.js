/**
 * 两个工作台的市场配置。
 *
 * 期货和 A股 的差别不是皮肤差别：杠杆、方向、交收、板幅、税费全都不一样。
 * 所以这里给的不是"同一页加几个开关"，而是两套独立的界面口径；共享的只有撮合内核。
 */

export const MARKET_PROFILES = {
  futures: {
    id: 'futures',
    label: '期货',
    brandBadge: '期货复盘工作台',
    pageTitle: '烛台簿 · 期货复盘',
    otherPage: { href: 'ashare.html', label: 'A股工作台' },
    defaultSymbol: 'EG0',
    defaultCapital: 100000,
    defaultAdjust: 'none',
    showAdjust: false,
    allowShort: true,
    qtyLabel: '下单手数(手)',
    lotsHeader: '手数',
    pointsHeader: '盈亏点数',
    accountBadge: 'T+0 双向交易',
    marginUsedLabel: '占用保证金(元)',
    positionMarginLabel: '保证金占用',
    tradeLongLabel: '买入开多 (B)',
    tradeCloseLabel: '一键平仓 (C)',
    dataHint: '输入期货代码，一键直连东财/新浪抓取真实行情，并持久化缓存至本地 IndexedDB。主连写 RB0 / 螺纹钢主连，具体月份写 rb2610。',
    quickCodes: '乙二醇 EG0 · 螺纹钢 RB0 · 豆粕 M0 · 铁矿石 I0 · 沪铜 CU0 · PTA TA0 · 纯碱 SA0',
    symbolPlaceholder: '期货代码 如 rb2610、RB0、螺纹钢主连',
    symbolGroups: [
      {
        label: '期货主连 · 工业品（东财真实行情，日线可回溯 2015）',
        options: [
          ['EG0', 'EG0 乙二醇主连'], ['RB0', 'RB0 螺纹钢主连'], ['HC0', 'HC0 热卷主连'],
          ['CU0', 'CU0 沪铜主连'], ['AL0', 'AL0 沪铝主连'], ['I0', 'I0 铁矿石主连'],
          ['TA0', 'TA0 PTA主连'], ['MA0', 'MA0 甲醇主连'], ['FG0', 'FG0 玻璃主连'],
          ['SA0', 'SA0 纯碱主连'], ['FU0', 'FU0 燃料油主连'], ['SF0', 'SF0 硅铁主连'],
          ['LC0', 'LC0 碳酸锂主连']
        ]
      },
      {
        label: '期货主连 · 农产品 / 贵金属 / 股指',
        options: [
          ['M0', 'M0 豆粕主连'], ['C0', 'C0 玉米主连'], ['P0', 'P0 棕榈油主连'],
          ['AU0', 'AU0 沪金主连'], ['SC0', 'SC0 原油主连'], ['IF0', 'IF0 沪深300股指主连'],
          ['IM0', 'IM0 中证1000股指主连']
        ]
      }
    ]
  },

  ashare: {
    id: 'ashare',
    label: 'A股',
    brandBadge: 'A股复盘工作台',
    pageTitle: '烛台簿 · A股复盘',
    otherPage: { href: 'futures.html', label: '期货工作台' },
    defaultSymbol: '510300',
    defaultCapital: 100000,
    defaultAdjust: 'hfq',
    showAdjust: true,
    allowShort: false,
    qtyLabel: '买入手数(100股/手)',
    lotsHeader: '手数(100股)',
    pointsHeader: '盈亏价差',
    accountBadge: 'T+1 单向做多 · 全额资金',
    marginUsedLabel: '持仓市值(元)',
    positionMarginLabel: '持仓市值',
    tradeLongLabel: '买入 (B)',
    tradeCloseLabel: '卖出清仓 (C)',
    dataHint: '输入 A股 / ETF / 指数代码，一键直连东财抓取真实行情并缓存到本地。默认后复权；前复权把早年价格扣成负数时，对数轴会如实退回线性。',
    quickCodes: '贵州茅台 600519 · 平安银行 000001 · 宁德时代 300750 · 沪深300ETF 510300 · 创业板ETF 159915',
    symbolPlaceholder: 'A股代码 如 600519、sh000001、510300',
    symbolGroups: [
      {
        label: 'A股 / ETF / 指数（东财真实行情）',
        options: [
          ['600519', '600519 贵州茅台'], ['000001', '000001 平安银行'],
          ['300750', '300750 宁德时代'], ['688981', '688981 中芯国际'],
          ['510300', '510300 沪深300ETF'], ['159915', '159915 创业板ETF'],
          ['000300', '000300 沪深300指数'], ['399001', '399001 深证成指']
        ]
      }
    ]
  }
};

/** 把 profile 落到共享 shell 上：文案、符号表、市场专属区块的显隐。 */
export function applyMarketProfile(profile) {
  const body = document.body;
  body.dataset.market = profile.id;
  body.classList.toggle('market-futures', profile.id === 'futures');
  body.classList.toggle('market-ashare', profile.id === 'ashare');
  document.title = profile.pageTitle;

  const setText = (selector, value) => {
    document.querySelectorAll(selector).forEach(el => { el.textContent = value; });
  };
  setText('[data-profile-text="badge"]', profile.brandBadge);
  setText('[data-profile-text="accountBadge"]', profile.accountBadge);
  setText('[data-profile-text="qtyLabel"]', profile.qtyLabel);
  setText('[data-profile-text="lotsHeader"]', profile.lotsHeader);
  setText('[data-profile-text="pointsHeader"]', profile.pointsHeader);
  setText('[data-profile-text="marginUsedLabel"]', profile.marginUsedLabel);
  setText('[data-profile-text="positionMarginLabel"]', profile.positionMarginLabel);
  setText('[data-profile-text="tradeLongLabel"]', profile.tradeLongLabel);
  setText('[data-profile-text="tradeCloseLabel"]', profile.tradeCloseLabel);
  setText('[data-profile-text="dataHint"]', profile.dataHint);
  setText('[data-profile-text="quickCodes"]', profile.quickCodes);
  setText('[data-profile-text="otherPage"]', profile.otherPage.label);

  const other = document.querySelector('[data-profile-link="other"]');
  if (other) other.setAttribute('href', profile.otherPage.href);

  const symbolSelect = document.getElementById('symbolSelect');
  if (symbolSelect) {
    symbolSelect.textContent = '';
    for (const group of profile.symbolGroups) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      for (const [value, label] of group.options) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        optgroup.appendChild(option);
      }
      symbolSelect.appendChild(optgroup);
    }
    symbolSelect.value = profile.defaultSymbol;
  }

  const symbolInput = document.getElementById('symbolInput');
  if (symbolInput) {
    symbolInput.placeholder = profile.symbolPlaceholder;
    symbolInput.title = `也可直接输入代码：${profile.symbolPlaceholder}`;
  }

  const adjust = document.getElementById('adjustSelect');
  if (adjust) {
    adjust.hidden = !profile.showAdjust;
    adjust.disabled = !profile.showAdjust;
    adjust.value = profile.defaultAdjust;
  }

  const capital = document.getElementById('inputInitialCapital');
  if (capital) capital.value = String(profile.defaultCapital);
  const customSymbol = document.getElementById('inputCustomSymbol');
  if (customSymbol) customSymbol.value = profile.defaultSymbol;
  const customSymbolInput = document.getElementById('inputCustomSymbol');
  if (customSymbolInput) customSymbolInput.placeholder = profile.symbolPlaceholder;

  document.querySelectorAll('[data-market-only]').forEach(el => {
    const mine = el.getAttribute('data-market-only') === profile.id;
    el.hidden = !mine;
    el.querySelectorAll('input, select, button, textarea').forEach(ctl => { ctl.disabled = !mine; });
  });

  return profile;
}
