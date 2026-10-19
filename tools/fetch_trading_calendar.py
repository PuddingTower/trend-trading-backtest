"""
生成可离线使用的 A股 / 期货交易日历。

为什么用两个序列做并集：
  - 上证指数（sh000001）给出 A股真实开市日，不会停牌，是最干净的日历源；
  - 期货日线会出现「节假日晚上夜盘算到第二天」的 bar（如 2015-10-01），
    也会有个别数据缺口。期货日历 = 指数开市日 ∪ RB0 有 bar 的日子，
    这样既不会把夜盘 bar 误判成停牌，也不会因 RB0 缺一天就把正常交易日算成假期。

输出 src/markets/tradingCalendar.js（只存节假日，周末由代码隐含）。
用法：python tools/fetch_trading_calendar.py
"""

import datetime as dt
import json
import os
import re
import urllib.request

INDEX_URL = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
             "CN_MarketData.getKLineData?symbol=sh000001&scale=240&ma=no&datalen=10000")
FUTURES_URL = ("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_RB0=/"
               "InnerFuturesNewService.getDailyKLine?symbol=RB0")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "src", "markets", "tradingCalendarData.js")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def get(url, referer):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "replace")


def index_dates():
    rows = json.loads(get(INDEX_URL, "https://finance.sina.com.cn/"))
    return {r["day"] for r in rows if r.get("day")}


def futures_dates():
    text = get(FUTURES_URL, "https://finance.sina.com.cn/")
    m = re.search(r"\((\[.*\])\)", text, re.S)
    if not m:
        raise ValueError("新浪期货返回格式异常")
    rows = json.loads(m.group(1))
    return {r["d"] for r in rows if r.get("d")}


def weekdays(first, last):
    d = dt.date.fromisoformat(first)
    end = dt.date.fromisoformat(last)
    while d <= end:
        if d.weekday() < 5:
            yield d.isoformat()
        d += dt.timedelta(days=1)


def holidays_of(trading_days):
    first, last = min(trading_days), max(trading_days)
    return [d for d in weekdays(first, last) if d not in trading_days], first, last


def emit(name, trading_days):
    hols, first, last = holidays_of(trading_days)
    return {
        "first": first, "last": last, "tradingDays": len(trading_days),
        "holidays": hols,
    }, name


def main():
    a_dates = index_dates()
    f_dates = futures_dates()
    # 期货日历取并集：夜盘把 bar 记到节假日那天、或 RB0 偶发缺数据，都不该变成"停牌"
    f_union = {d for d in a_dates if d >= min(f_dates)} | f_dates
    a, _ = emit("A_SHARE", a_dates)
    f, _ = emit("FUTURES", f_union)

    lines = [
        "/**",
        " * 自动生成，勿手改。生成命令：python tools/fetch_trading_calendar.py",
        f" * 数据源：新浪上证指数 sh000001 与 螺纹钢主连 RB0 日线。",
        f" * A股 {a['first']} → {a['last']}；期货 {f['first']} → {f['last']}。",
        " * 只存工作日里的休市日；周末由代码隐含。范围外的日期如实返回未覆盖，不猜。",
        " */",
        "",
        "export const CALENDAR_SOURCE = {",
        f"  aShare: {{ first: '{a['first']}', last: '{a['last']}', tradingDays: {a['tradingDays']} }},",
        f"  futures: {{ first: '{f['first']}', last: '{f['last']}', tradingDays: {f['tradingDays']} }},",
        "  generatedBy: 'tools/fetch_trading_calendar.py',",
        "};",
        "",
        "// prettier-ignore",
        f"export const A_SHARE_HOLIDAYS = new Set({json.dumps(a['holidays'], ensure_ascii=False)});",
        "",
        "// prettier-ignore",
        f"export const FUTURES_HOLIDAYS = new Set({json.dumps(f['holidays'], ensure_ascii=False)});",
        "",
    ]
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
    print(f"A股：{a['first']} → {a['last']}，{a['tradingDays']} 个交易日，{len(a['holidays'])} 个休市工作日")
    print(f"期货：{f['first']} → {f['last']}，{f['tradingDays']} 个交易日，{len(f['holidays'])} 个休市工作日")
    print(f"写入 {OUT}")


if __name__ == "__main__":
    main()
