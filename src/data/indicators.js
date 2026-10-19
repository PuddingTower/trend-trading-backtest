/**
 * 指标工具。原来 calcMA 挂在 MockDataGenerator 上，却被在线数据和 CSV 复用 ——
 * 那是错位而不是设计：指标属于数据管线，不属于仿真器。
 *
 * 输出形态保持不变（pre-bake 到每根 bar 的 ma5/ma10/ma20 字段），因为
 * ChartModule.drawMovingAverages 直接读 bar.ma5；改渲染契约不在 M1 范围内。
 */

export const calcMA = (data, idx, period) => {
  if (idx < period - 1) return null;
  let sum = 0;
  for (let j = idx - period + 1; j <= idx; j++) sum += data[j].close;
  return Math.round((sum / period) * 10) / 10;
};

/** 就地给 bar 序列打上 ma5/ma10/ma20（图表当前只画这三条）。 */
export function attachDefaultMAs(bars, periods = [5, 10, 20]) {
  for (let i = 0; i < bars.length; i++) {
    for (const p of periods) bars[i][`ma${p}`] = calcMA(bars, i, p);
  }
  return bars;
}

/**
 * 兼容新浪的两种响应形态：对象 {d,o,h,l,c,v} 与位置数组 [d,o,h,l,c,v]。
 * 原 HTML 只读对象键，而接口实际返回位置数组 —— 结果是每根 bar 都 parseFloat(undefined)=NaN
 * 被过滤掉，在线拉取静默降级成仿真数据。两种都吃才是安全的。
 */
export function normalizeSinaRow(row) {
  let date, o, h, l, c, v, s;
  if (Array.isArray(row)) {
    [date, o, h, l, c, v] = row;   // 60m 的数组形态没有结算价
  } else {
    date = row.d ?? row.date;
    o = row.o ?? row.open; h = row.h ?? row.high; l = row.l ?? row.low;
    c = row.c ?? row.close; v = row.v ?? row.volume; s = row.s ?? row.settlement;
  }
  const bar = {
    // 曾经这里是 String(date).slice(0,10)：新浪 60m 实测发的是 "2023-11-07 15:00:00"，
    // 一刀切成日期后，同一天的所有 bar 拿到同一个 key，而 sortByDate 对相等 key 返回 0、
    // 稳定排序于是原样保留新浪的**倒序**。再拿去合成 4 小时线就是 open/close 整根反掉
    // （实测 open=15:00 的开盘、close=10:00 的收盘），K线实体全部上下颠倒、均线与突破全错。
    // 秒去掉，统一成东财那套 "YYYY-MM-DD HH:MM"，两条通道才真的可比。
    date: normalizeSinaDate(date),
    open: parseFloat(o), high: parseFloat(h), low: parseFloat(l),
    close: parseFloat(c), volume: parseFloat(v) || 0
  };
  const settle = parseFloat(s);
  // 早年新浪的 s 是 0（没有结算价），不能把 0 当有效结算价写进 bar：
  // 逐日盯市会把权益直接归零，比回退收盘价坏得多。
  if (Number.isFinite(settle) && settle > 0) bar.settlement = settle;
  return Number.isFinite(bar.open) && Number.isFinite(bar.close) ? bar : null;
}

/** 保留钟点只去掉秒；纯日期（日线）原样返回。 */
export function normalizeSinaDate(date) {
  const s = String(date || '').trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?)?/);
  if (!m) return s;
  return m[2] ? `${m[1]} ${m[2]}` : m[1];
}

/** 按日期升序（新浪 60m 是倒序返回的）。 */
export const sortByDate = (bars) => bars.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
