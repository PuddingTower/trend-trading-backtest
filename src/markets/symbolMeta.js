/**
 * 统一代码解析：把用户/OCR 给的任意写法解析成 {market, kind, code, secid, ...}。
 * A股分类靠代码前缀规则（不靠 OCR 准确率），同码冲突返回多候选交给 resolver 用名称消歧。
 */

import { EXCHANGES, MARKET_ID_TO_EXCHANGE, dominantCode, MONTH_CODE_LEN } from './exchanges.js';
import { FUTURES_SPECS, resolveFuturesVariety } from './contractSpecs.js';

export const MARKETS = { ASHARE: 'ashare', FUTURES: 'futures' };

const SH = 1, SZ = 0;

/** 前缀 -> {exchange, kind, board, limitPct} */
const A_SHARE_RULES = [
  { test: /^60\d{4}$/, exchange: 'SH', secidMarket: SH, kind: 'stock', board: '沪市主板', limitPct: 0.10 },
  { test: /^68\d{4}$/, exchange: 'SH', secidMarket: SH, kind: 'stock', board: '科创板', limitPct: 0.20 },
  { test: /^900\d{3}$/, exchange: 'SH', secidMarket: SH, kind: 'stock', board: '沪市B股', limitPct: 0.10 },
  { test: /^(00[0-7]\d{3}|001\d{3}|002\d{3}|003\d{3})$/, exchange: 'SZ', secidMarket: SZ, kind: 'stock', board: '深市主板', limitPct: 0.10 },
  { test: /^30\d{4}$/, exchange: 'SZ', secidMarket: SZ, kind: 'stock', board: '创业板', limitPct: 0.20 },
  { test: /^20\d{4}$/, exchange: 'SZ', secidMarket: SZ, kind: 'stock', board: '深市B股', limitPct: 0.10 },
  { test: /^(43\d{4}|83\d{4}|87\d{4}|92\d{4})$/, exchange: 'BJ', secidMarket: SZ, kind: 'stock', board: '北交所', limitPct: 0.30 },
  // ETF：51/56/58 沪，15/16/18 深
  { test: /^(51|56|58)\d{4}$/, exchange: 'SH', secidMarket: SH, kind: 'etf', board: '沪市ETF', limitPct: 0.10 },
  { test: /^(15|16|18)\d{4}$/, exchange: 'SZ', secidMarket: SZ, kind: 'etf', board: '深市ETF', limitPct: 0.10 },
  // 指数：399 深，000 沪（000 与深市主板股票 000001 等冲突，见 candidates）
  { test: /^399\d{3}$/, exchange: 'SZ', secidMarket: SZ, kind: 'index', board: '深证指数', limitPct: null },
  { test: /^88[0-9]\d{3}$/, exchange: 'SH', secidMarket: SH, kind: 'index', board: 'Wind类指数', limitPct: null }
];

/** 沪市指数段 000xxx 与深市股票段 000xxx 同码 —— 两者都列为候选，必须靠名称/接口消歧。 */
const AMBIGUOUS_000 = /^000\d{3}$/;

export const exchangeMeta = (exchange) => EXCHANGES[exchange] || null;

/**
 * 纯代码分类。返回 { ok, kind, exchange, secid, limitPct, candidates }
 * candidates 非空表示同码多义，需 resolver 用名称决定。
 */
export function classifyAShare(code) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return { ok: false, reason: '不是 6 位数字代码' };

  const hits = A_SHARE_RULES.filter(r => r.test.test(c));
  if (AMBIGUOUS_000.test(c)) {
    hits.push({ exchange: 'SH', secidMarket: SH, kind: 'index', board: '上证指数', limitPct: null });
  }

  if (hits.length === 0) return { ok: false, reason: '未识别的 A股代码段' };

  const primary = hits[0];
  const mk = (r) => ({
    ok: true,
    market: MARKETS.ASHARE,
    kind: r.kind,
    exchange: r.exchange,
    board: r.board,
    limitPct: r.limitPct,
    secid: `${r.secidMarket}.${c}`,
    code: c
  });

  if (hits.length > 1) {
    const cand = hits.map(mk);
    return { ...cand[0], candidates: cand, ambiguous: true };
  }
  return mk(primary);
}

/** 文华/博易/通达信的主力连续写法：品种 + 全 0（RB0、M0、EG0）；99/9999 是部分软件的指数连续写法。 */
const isDominantDigits = (digits) => /^0+$/.test(digits) || digits === '99' || digits === '9999';

/**
 * 期货代码解析：rb2610 / RB2610 / SR609 / rb0 / RB0 / 螺纹钢主连 / 螺纹钢2610 / EGm / MM(豆粕主连)
 * 返回 { ok, market:'futures', variety, contractCode, isDominant, secid, spec }
 */
export function parseFutures(raw, nameHint = '') {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, reason: '空代码' };

  const norm = text.toUpperCase().replace(/[\s·、,，.]/g, '');

  // 1) 中文名（可带月份，可带主连/主力/连续后缀）
  const cjk = norm.match(/^([一-龥]{1,10}?)(主连|主力|连续|指数)?(\d{3,4})?$/);
  if (cjk) {
    const variety = resolveFuturesVariety(cjk[1]);
    if (variety) return buildFutures(variety, cjk[3] || null);
  }

  // 2) 字母 + 可选月份数字（3 个字母留给 RBM/MM 这种主连写法）
  const lat = norm.match(/^([A-Z]{1,3})(\d{0,4})$/);
  if (lat) {
    const [, letters, digits] = lat;
    // 主连尾缀 m：RBM/MM 去掉 m 才是品种；SM、FM 这类本身就是品种的绝不误剥。
    const bare = VARIETY_BY_LETTERS.has(letters) ? letters : letters.replace(/M$/, '');
    const variety = varietyFromLetters(bare);
    if (!variety) return { ok: false, reason: `未知期货品种「${letters}」` };
    if (!digits || isDominantDigits(digits)) return buildFutures(variety, null);
    return buildFutures(variety, digits);
  }

  return { ok: false, reason: `无法解析期货代码「${text}」` };
}

const VARIETY_BY_LETTERS = new Map(Object.keys(FUTURES_SPECS).map(k => [k, k]));

function varietyFromLetters(letters) {
  const up = String(letters).toUpperCase();
  if (VARIETY_BY_LETTERS.has(up)) return VARIETY_BY_LETTERS.get(up);
  return resolveFuturesVariety(up) || null;
}


function buildFutures(variety, monthDigits) {
  const spec = FUTURES_SPECS[variety];
  if (!spec) return { ok: false, reason: `品种 ${variety} 不在规格表内` };
  const marketId = EXCHANGES[spec.exchange].id;
  // 郑商所月份是 3 位（SR609），用户/OCR 常按 4 位习惯写 2609 —— 归一化，否则 secid 取不到数据。
  let month = monthDigits;
  if (month && MONTH_CODE_LEN[spec.exchange] === 3 && month.length === 4) month = month.slice(1);
  const code = month ? `${spec.emCode}${month}` : dominantCode(spec.emCode);
  return {
    ok: true,
    market: MARKETS.FUTURES,
    variety,
    name: spec.name,
    exchange: spec.exchange,
    marketId,
    contractCode: code,
    isDominant: !monthDigits,
    secid: `${marketId}.${code}`,
    spec
  };
}

/**
 * 顶层入口：接受 sh600519 / SZ.000001 / 600519 / rb2610 / RB0 / 螺纹钢主连。
 * A股段带 sh/sz/bj 前缀时以前缀为准（这是同码冲突最可靠的消歧信息）。
 */
export function parseSymbol(raw, nameHint = '') {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, reason: '空代码' };

  const prefixed = text.match(/^(sh|sz|bj|SS|SZ|SH)\.?(\d{6})$/i);
  if (prefixed) {
    const cls = classifyAShare(prefixed[2]);
    if (cls.ok) {
      const wantEx = prefixed[1].toUpperCase() === 'SH' ? 'SH' : prefixed[1].toUpperCase() === 'BJ' ? 'BJ' : 'SZ';
      if (cls.exchange === wantEx || !cls.candidates) return { ...cls, exchange: wantEx, via: 'prefix' };
      const picked = cls.candidates.find(c => c.exchange === wantEx);
      if (picked) return { ...picked, via: 'prefix' };
    }
  }

  if (/^\d{6}$/.test(text)) {
    const cls = classifyAShare(text);
    if (cls.ok) return cls;
  }

  const fut = parseFutures(text, nameHint);
  if (fut.ok) return fut;

  if (/^\d{6}$/.test(text)) {
    return { ok: false, reason: `${text} 同码多义：${fut.reason}`, needName: true, code: text };
  }
  return { ok: false, reason: fut.reason, fallbackText: text };
}

/** 交易所中文名（用于品种卡片展示） */
export const exchangeLabel = (parsed) => {
  if (!parsed || !parsed.ok) return '';
  if (parsed.market === MARKETS.FUTURES) return (EXCHANGES[parsed.exchange] || {}).name || parsed.exchange;
  return parsed.exchange === 'SH' ? '沪' : parsed.exchange === 'SZ' ? '深' : '北';
};

export { MARKET_ID_TO_EXCHANGE };
