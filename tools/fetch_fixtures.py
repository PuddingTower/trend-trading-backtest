"""抓取真实行情做回测夹具（走本地服务器 /api/kline，与前端同源）。

为什么固定成夹具而不是每次回测都联网：
  1. 回测必须可复现 —— 上游补数据/改复权会让同一份参数昨天赚钱今天亏钱，那种"验证"没有意义。
  2. 秒级离线迭代（对齐"离线回放先行"）：调策略时不该被网络拖住。
用法：python tools/fetch_fixtures.py
"""
import json
import os
import sys
import urllib.parse
import urllib.request

BASE = os.environ.get("TREND_BASE", "http://localhost:8080")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "fixtures")

# 覆盖两类市场 + 不同波动特性：黑色/化工/农产品/金属/股指/宽基指数/白酒/新能源/ETF
TARGETS = [
    ("futures", "113.rbm", "rbm", "daily", "none", "螺纹钢主连"),
    ("futures", "113.hcm", "hcm", "daily", "none", "热卷主连"),
    ("futures", "113.cum", "cum", "daily", "none", "沪铜主连"),
    ("futures", "113.aum", "aum", "daily", "none", "沪金主连"),
    ("futures", "114.mm", "mm", "daily", "none", "豆粕主连"),
    ("futures", "114.im", "im", "daily", "none", "铁矿石主连"),
    ("futures", "114.egm", "egm", "daily", "none", "乙二醇主连"),
    ("futures", "115.SAm", "SAm", "daily", "none", "纯碱主连"),
    ("futures", "115.MAm", "MAm", "daily", "none", "甲醇主连"),
    ("futures", "225.lcm", "lcm", "daily", "none", "碳酸锂主连"),
    ("futures", "142.scm", "scm", "daily", "none", "原油主连"),
    ("futures", "220.IFM", "IFM", "daily", "none", "沪深300股指主连"),
    ("ashare", "1.600519", "600519", "daily", "hfq", "贵州茅台"),
    ("ashare", "0.000001", "000001", "daily", "hfq", "平安银行"),
    ("ashare", "0.300750", "300750", "daily", "hfq", "宁德时代"),
    ("ashare", "1.510300", "510300", "daily", "hfq", "沪深300ETF"),
    ("ashare", "1.000300", "000300", "daily", "none", "沪深300指数"),
]

# 回测区间：够长以覆盖多种市况（含 2015 股灾、2018 熊市、2020 疫情、2021 大宗牛、2022-2024 震荡）
BEG, END = "20150101", "20261013"


def fetch(market, secid, period, adjust):
    qs = urllib.parse.urlencode({
        "secid": secid, "market": market, "period": period,
        "adjust": adjust, "beg": BEG, "end": END
    })
    with urllib.request.urlopen(f"{BASE}/api/kline?{qs}", timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    os.makedirs(OUT, exist_ok=True)
    index, failures = {}, []
    for market, secid, symbol, period, adjust, name in TARGETS:
        try:
            data = fetch(market, secid, period, adjust)
        except Exception as exc:
            failures.append(f"{symbol}: {exc}")
            continue
        if not data.get("ok") or not data.get("bars"):
            failures.append(f"{symbol}: ok={data.get('ok')} error={data.get('error')} warning={data.get('warning')}")
            continue
        bars = data["bars"]
        fn = f"{market}_{symbol}_{period}_{adjust}.json"
        payload = {
            "meta": {
                "market": market, "secid": secid, "symbol": symbol, "name": name,
                "period": period, "adjust": adjust, "count": len(bars),
                "firstDate": bars[0]["date"], "lastDate": bars[-1]["date"],
                "source": data.get("source"), "fetchedAt": data.get("fetchedAt"),
                "note": "期货主连由东财拼接口径提供；A股用后复权(hfq)以保证价格恒正且收益连续"
            },
            "bars": bars
        }
        with open(os.path.join(OUT, fn), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        index[fn] = payload["meta"]
        print(f"  {market:8} {symbol:8} {len(bars):5} 根  {bars[0]['date']} → {bars[-1]['date']}  {name}")

    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f"\n夹具 {len(index)} 份已写入 fixtures/，索引 fixtures/index.json")
    if failures:
        print("失败：")
        for x in failures:
            print("  ", x)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
