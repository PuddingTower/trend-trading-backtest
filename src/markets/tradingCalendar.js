/**
 * 内置交易日历。
 *
 * 以前 `annotateGaps` 只能靠「参照序列」区分停牌和长假：没有参照时，春节 8 天缺口
 * 和停牌 8 天在单品种数据上长得一模一样，所以它只能如实报 calendarKnown:false。
 * 这份日历把这个空白补上：A股用上证指数真实开市日，期货用「指数开市日 ∪ RB0 有 bar 的日子」，
 * 覆盖范围外的日期仍然如实返回未覆盖，不拿周末规则硬猜。
 *
 * 数据是 tools/fetch_trading_calendar.py 生成的，落在 tradingCalendarData.js；
 * 这里只负责查询，不手写节假日。
 */

import {
  A_SHARE_HOLIDAYS, FUTURES_HOLIDAYS, CALENDAR_SOURCE
} from './tradingCalendarData.js';

export { CALENDAR_SOURCE };

const dayKey = (d) => String(d || '').slice(0, 10);
const VALID = /^\d{4}-\d{2}-\d{2}$/;

function utcDay(key) {
  return Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) / 86400000;
}

function weekdayOf(key) {
  return new Date(utcDay(key) * 86400000).getUTCDay();   // 0=周日
}

function nextDay(key) {
  const d = new Date((utcDay(key) + 1) * 86400000);
  return d.toISOString().slice(0, 10);
}

export function calendarOf(market = 'ashare') {
  return market === 'futures'
    ? { holidays: FUTURES_HOLIDAYS, ...CALENDAR_SOURCE.futures, label: '期货' }
    : { holidays: A_SHARE_HOLIDAYS, ...CALENDAR_SOURCE.aShare, label: 'A股' };
}

/**
 * @returns {boolean|null} null = 超出内置日历覆盖范围（不知道，不猜）
 */
export function isTradingDay(date, market = 'ashare') {
  const key = dayKey(date);
  if (!VALID.test(key)) return null;
  const cal = calendarOf(market);
  if (key < cal.first || key > cal.last) return null;
  if (weekdayOf(key) === 0 || weekdayOf(key) === 6) return false;
  return !cal.holidays.has(key);
}

/**
 * 内置日历能否覆盖 [first, last]。
 * 覆盖不了就返回 null，让调用方退回原来的「只报自然日缺口」口径 ——
 * 拿半段日历去断言停牌，会把日历范围外的长假误判成停牌。
 */
export function builtinCalendar(first, last, market = 'ashare') {
  const a = dayKey(first), b = dayKey(last);
  if (!VALID.test(a) || !VALID.test(b) || a > b) return null;
  const cal = calendarOf(market);
  if (a < cal.first || b > cal.last) return null;
  const dates = [];
  for (let d = a; d <= b; d = nextDay(d)) {
    if (weekdayOf(d) !== 0 && weekdayOf(d) !== 6 && !cal.holidays.has(d)) dates.push(d);
  }
  return { dates, first: a, last: b, market, label: cal.label };
}

export function calendarCoverage(market = 'ashare') {
  const cal = calendarOf(market);
  return { market, label: cal.label, first: cal.first, last: cal.last, tradingDays: cal.tradingDays };
}
