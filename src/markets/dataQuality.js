/**
 * 数据质量校验（补「已知边界」里两条：停牌日不可成交、除权日复权衔接）。
 *
 * 这两个问题都不会让回测报错，只会让它变好看：
 *   - 用未复权序列跑 A股，一次 10 送 10 会被当成"隔天腰斩"，策略凭空拿到一个假跌破信号；
 *   - 停牌造成的长缺口里，前一根 bar 可能是三周前的收盘价，拿它算涨跌停价就是错的板幅。
 * 所以在撮合之前先把数据问一遍，比事后调参数有用得多。
 */

const dayKey = (d) => String(d || '').slice(0, 10);

/** 两个日期之间的自然日差（yyyy-mm-dd 前缀可直接字典序比较，不需要 new Date，避免 Safari 解析陷阱）。 */
export function calendarDayGap(fromDate, toDate) {
  const a = dayKey(fromDate), b = dayKey(toDate);
  if (a.length !== 10 || b.length !== 10) return 0;
  const toDays = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
  return Math.round(toDays(b) - toDays(a));
}

/**
 * 交易日参照：把参考序列（指数或一篮子品种）有、而本品种没有的日期算作停牌。
 *
 * 为什么必须给参照：**光看本品种自己的 bar 序列分不出停牌和长假** ——
 * 春节/国庆的缺口能有 8~12 个自然日，比很多停牌还长。凭"缺口 > N 天"判停牌，
 * 会把每个长假都标成停牌，然后回测里那些天全部不成交，看起来反而更"真实"，
 * 而这恰恰是假的。没有参照时本函数如实返回 calendarKnown=false，让上层去提示而不是猜。
 */
export function tradingCalendarOf(bars, refBars) {
  const own = new Set((bars || []).map(b => dayKey(b.date)));
  const ref = (refBars || []).map(b => dayKey(b.date)).filter(Boolean);
  const calendarKnown = ref.length > 0;
  const dates = calendarKnown ? [...new Set(ref)].sort() : [...own].sort();
  return { dates, own, calendarKnown };
}

/**
 * 标注缺口与停牌。
 * @returns {{bars:Array, suspensions:Array, longGaps:Array, calendarKnown:boolean}}
 *   有参照时：参照有、自己没有 → bar 上挂 suspended 语义（用 suspendedBefore 表示"这根之前停牌了多少天"）。
 *   没有参照时：只把 ≥ minSuspensionDays 的自然日缺口记进 longGaps，并明确标为"无法与长假区分"。
 */
export function annotateGaps(bars, { refBars = null, minSuspensionDays = 4 } = {}) {
  const list = (bars || []).slice().sort((a, b) => (dayKey(a.date) < dayKey(b.date) ? -1 : 1));
  const { dates, own, calendarKnown } = tradingCalendarOf(list, refBars);
  const suspensions = [], longGaps = [];
  const dateSet = new Set(list.map(b => dayKey(b.date)));
  let pendingMissing = 0;

  const out = list.map((bar, i) => {
    const key = dayKey(bar.date);
    if (i > 0) {
      const prev = dayKey(list[i - 1].date);
      const gap = calendarDayGap(prev, key);
      if (calendarKnown) {
        // 参照序列里、这两根之间有多少个交易日是本品种没有的 → 那些就是停牌日
        const between = dates.filter(d => d > prev && d < key && !dateSet.has(d));
        pendingMissing = between.length;
        if (between.length >= minSuspensionDays) {
          suspensions.push({ resumeIdx: i, resumeDate: key, days: between.length, missing: between });
        }
      } else if (gap >= minSuspensionDays) {
        longGaps.push({ idx: i, from: prev, to: key, naturalDays: gap });
      }
    }
    const next = { ...bar };
    if (i > 0) {
      const prev = list[i - 1];
      next.prevClose = prev.close;
      next.gapNaturalDays = calendarDayGap(dayKey(prev.date), key);
      if (calendarKnown && pendingMissing > 0) {
        next.suspendedDays = pendingMissing;
        next.resumedAfterSuspension = true;
        pendingMissing = 0;
      }
      // 缺口长到前收盘价已经不代表"昨天的市场"：拿它算涨跌停价是错的，标出来让撮合层跳过板锁判定
      if (next.gapNaturalDays >= minSuspensionDays + 4) next.stalePrevClose = true;
    }
    return next;
  });

  return { bars: out, suspensions, longGaps, calendarKnown };
}

/**
 * 除权/复权连续性校验。
 *
 * 判据：|open / 前收 - 1| 超过当日涨跌停幅度 → 这个跳空在市场上不可能发生，
 * 只能是数据没复权（送转股、分红、配股都会造成这种"断崖"）。
 * 这不是"疑似异常波动"，是数据问题 —— 让它去参与回测，等于把公司行为当成行情。
 */
export function checkAdjustmentContinuity(bars, { limitPct = 0.10, tol = 0.02 } = {}) {
  const list = (bars || []).slice();
  const issues = [];
  let skipped = 0;
  if (!(limitPct > 0)) return { issues, usable: true, skipped, note: '该品种无涨跌幅限制（指数等），跳过连续性校验' };
  const ceiling = limitPct + tol;
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1], cur = list[i];
    const prevClose = prev.close, open = cur.open;
    // 非正价格没法算比值，但**必须计数**：静默 continue 会让「整段都是负价」看起来像「校验通过」
    if (!(prevClose > 0) || !(open > 0)) { skipped++; continue; }
    const jump = open / prevClose - 1;
    if (Math.abs(jump) > ceiling) {
      issues.push({
        idx: i, date: dayKey(cur.date), prevDate: dayKey(prev.date),
        jump: Math.round(jump * 1e4) / 1e4,
        ratio: Math.round((open / prevClose) * 1e4) / 1e4,
        kind: Math.abs(jump) > 0.5 ? 'split_suspect' : 'exright_suspect',
        naturalDays: calendarDayGap(dayKey(prev.date), dayKey(cur.date))
      });
    }
  }
  return {
    issues,
    usable: issues.length === 0,
    skipped,
    note: issues.length
      ? `发现 ${issues.length} 处超过涨跌停幅度的隔夜跳空（最大 ${(Math.max(...issues.map(x => Math.abs(x.jump))) * 100).toFixed(1)}%）。`
        + '这种价格变化在市场上不可能发生，几乎可以断定是**送转/分红未复权**。'
        + '请把复权切到"前复权"再回测，否则这些断崖会被当成真跌破/真突破。'
      : (skipped
        ? `连续性比对跳过了 ${skipped} 对（前收或开盘不是正数，没法算比值）—— 详见价格有效性检查。`
        : '未发现超出板幅的隔夜跳空，复权口径看起来是连续的。')
  };
}

/**
 * 价格有效性：OHLC 必须是正有限数。
 *
 * 前复权拉长历史时，早年的累计除权因子会把价格压到 0 甚至负数 —— 那不是行情，
 * 是"用未来的公司行为改写过去的价位"算出来的伪数。负价进引擎会把保证金占用算成负数
 * （sizing 里 perLot = 价×乘数×保证金率，没有 price>0 的护栏），板幅基准也会翻向，
 * 而连续性校验原先对这种 bar 直接跳过，等于静默放行。所以单独问一遍，如实报数。
 */
export function checkPriceValidity(bars) {
  const bad = [];
  (bars || []).forEach((b, i) => {
    const fields = ['open', 'high', 'low', 'close'].filter(k => !(Number.isFinite(b[k]) && b[k] > 0));
    if (fields.length) bad.push({ idx: i, date: dayKey(b.date), fields, values: fields.map(k => b[k]) });
  });
  const withNonPositive = bad.filter(x => x.values.some(v => Number.isFinite(v) && v <= 0)).length;
  return {
    bad,
    count: bad.length,
    usable: bad.length === 0,
    note: bad.length
      ? `${bad.length} 根 bar 的 OHLC 不是正有限数（首例 ${bad[0].date}，字段 ${bad[0].fields.join('/')} = `
        + `${bad[0].values.join(', ')}），其中 ${withNonPositive} 根含零或负价。`
        + '前复权拉长历史常把早年价格压成这样，是复权口径问题不是行情 —— '
        + '请缩短起始区间或改用后复权/不复权；这种序列进撮合会把保证金占用算成负数。'
      : 'OHLC 全为正有限数，可作为撮合输入。'
  };
}

/**
 * 主力换月缺口的拼接检查：连续合约在换月当天常有几十个点的跳空，
 * 那是合约切换不是行情。拼接模式没选对时，回测会把换月跳空当成一笔暴利或暴亏。
 */
export function checkRolloverGaps(bars, { limitPct = 0.10 } = {}) {
  const list = (bars || []).slice();
  const gaps = [];
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1], cur = list[i];
    if (!(prev.close > 0) || !(cur.open > 0)) continue;
    const jump = cur.open / prev.close - 1;
    if (Math.abs(jump) > limitPct) gaps.push({ idx: i, date: dayKey(cur.date), jump: Math.round(jump * 1e4) / 1e4 });
  }
  return gaps;
}
