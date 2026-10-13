"""
趋势交易回测系统 · 本地服务器
================================
职责（对齐演进计划 §2 目标架构）：
  1. 静态托管前端（ES module 需要 http:// 源，file:// 下浏览器拒绝加载模块）。
  2. /api/kline  行情代理：隔离 CORS 与上游接口变动，A股+期货走同一条归一化协议。
  3. /api/resolve 代码检索：eastmoney 权威代码表，供 M3 识图导入做名称-代码交叉校验。
  4. /api/ocr    截图识别（rapidocr_onnxruntime）；未安装时明确 501，前端自动走兜底通道。

设计约束：
  - 只用标准库（urllib），不引入 requests/flask，保证 `python run_local_server.py` 一条命令起。
  - 上游 secid 由前端 symbolMeta.js 解析后传入；服务器不重复实现代码解析，避免两处规则漂移。
  - eastmoney kline 字段序是 date,OPEN,CLOSE,HIGH,LOW,volume,...（不是 OHLC），映射错=整条曲线错。
"""

import http.server
import json
import os
import re
import socket
import socketserver
import sys
import urllib.parse
import urllib.request
import threading
import webbrowser
from datetime import datetime

PORT = int(os.environ.get("TREND_PORT", "8080"))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
KLINE_HOSTS = ("https://push2his.eastmoney.com", "https://push2.eastmoney.com")
SINA_JSONP = "https://stock2.finance.sina.com.cn/futures/api/jsonp.php"

# eastmoney 周期与复权口径
KLTL = {"daily": "101", "weekly": "102", "monthly": "103", "60m": "60", "30m": "30", "15m": "15", "5m": "5", "1m": "1"}
FQT = {"none": "0", "qfq": "1", "hfq": "2"}

_lock = threading.Lock()
_ocr_engine = {"tried": False, "engine": None, "error": None}


def http_get(url, referer=None, timeout=15, accept="application/json,text/plain,*/*"):
    """刻意不传 ssl context：显式 context 会让 urllib 绕过系统代理直连，
    实测那条路径命中的 searchapi CDN 会返回缓存串台的 JSONP（回调名固定、内容与查询无关）。
    用默认 opener（走系统代理、保持证书校验）才稳定返回干净 JSON。
    """
    headers = {"User-Agent": UA, "Accept": accept}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def fetch_em_kline(secid, period, adjust, beg, end, count):
    """返回归一化 bars。字段序严格按 f51..f56 = date,open,close,high,low,volume。

    实测坑：上游只在「不带 beg」时尊重 lmt。一旦带上 beg/end 全区间，lmt 被忽略并返回全部历史
    （要 3 根给 6019 根）。所以 count 语义走 end+lmt，区间语义走 beg+end。
    """
    fields2 = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
    qs = {
        "secid": secid, "fields1": "f1,f2,f3,f4,f5,f6", "fields2": fields2,
        "klt": KLTL.get(period, "101"), "fqt": FQT.get(adjust, "1"),
    }
    if count:
        qs["end"] = end or "20500101"
        qs["lmt"] = str(count)
    else:
        qs["beg"] = beg or "19700101"
        qs["end"] = end or "20500101"
    data = json.loads(http_get(f"{KLINE_HOSTS[0]}/api/qt/stock/kline/get?" + urllib.parse.urlencode(qs),
                               referer="https://quote.eastmoney.com/"))
    d = data.get("data") or {}
    bars, name = [], d.get("name")
    for line in (d.get("klines") or []):
        p = line.split(",")
        if len(p) < 6:
            continue
        date, o, c, h, l, v = p[0], p[1], p[2], p[3], p[4], p[5]
        bar = {
            "date": date,
            "open": float(o), "high": float(h), "low": float(l), "close": float(c),
            "volume": float(v or 0),
        }
        if len(p) > 6:
            bar["amount"] = float(p[6] or 0)
        if len(p) > 8:
            bar["pctChg"] = float(p[8] or 0)
        bars.append(bar)
    return {
        "ok": True, "source": "eastmoney", "secid": secid, "name": name,
        "period": period, "adjust": adjust, "decimal": d.get("decimal"),
        "totalAvailable": d.get("dktotal"), "count": len(bars),
        "bars": bars, "fetchedAt": datetime.now().isoformat(timespec="seconds"),
    }


def fetch_sina_futures(symbol, period):
    """新浪期货（遗留通道）。已知问题：日线数据冻结在 2024-07-17，仅作备用对照。
    响应是 JSONP 包裹的位置数组 [[date,open,high,low,close,volume], ...]，且 60m 是倒序。"""
    svc = ("IndexService.getInnerFuturesMiniKLine60m" if period == "60m"
           else "IndexService.getInnerFuturesDailyKLine")
    url = f"{SINA_JSONP}/var%20t=/{svc}?symbol={urllib.parse.quote(symbol.upper())}"
    text = http_get(url, referer="https://finance.sina.com.cn/")
    m = re.search(r"=\s*\((.*)\)\s*\)?;?\s*$", text, re.S)
    if not m:
        raise ValueError("新浪返回格式异常")
    arr = json.loads(m.group(1))
    bars = []
    for row in arr:
        if isinstance(row, dict):  # 兼容对象形态
            date, o, h, l, c, v = row.get("d"), row.get("o"), row.get("h"), row.get("l"), row.get("c"), row.get("v")
        else:
            date, o, h, l, c, v = row[0], row[1], row[2], row[3], row[4], row[5]
        try:
            bars.append({"date": str(date)[:10], "open": float(o), "high": float(h),
                         "low": float(l), "close": float(c), "volume": float(v or 0)})
        except (TypeError, ValueError):
            continue
    bars.sort(key=lambda b: b["date"])  # 60m 上游是倒序，统一成升序
    return {
        "ok": True, "source": "sina", "secid": f"sina.{symbol.upper()}", "name": None,
        "period": period, "adjust": "none", "decimal": None, "totalAvailable": len(bars),
        "count": len(bars), "bars": bars, "fetchedAt": datetime.now().isoformat(timespec="seconds"),
    }


def get_ocr():
    with _lock:
        if _ocr_engine["tried"]:
            return _ocr_engine["engine"], _ocr_engine["error"]
        _ocr_engine["tried"] = True
        try:
            from rapidocr_onnxruntime import RapidOCR
            _ocr_engine["engine"] = RapidOCR()
        except Exception as exc:
            _ocr_engine["error"] = str(exc)
        return _ocr_engine["engine"], _ocr_engine["error"]


def unwrap_jsonp(text):
    """searchapi 会按请求头在纯 JSON 与 JSONP（jQueryNNN_...({...})）之间切换，两种都要能吃。"""
    t = text.strip()
    if t.startswith("{") or t.startswith("["):
        return t
    m = re.search(r"\((.*)\)\s*;?\s*$", t, re.S)
    return m.group(1) if m else t


def extract_suggest_rows(data):
    """suggest 的两种形态字段层级不同：纯 JSON 是 QuotationCodeTable.Data，
    JSONP 形态是 result.Data / result.pages。只认前一种会让 resolve 静默返回 0 条。"""
    if not isinstance(data, dict):
        return []
    table = (data.get("QuotationCodeTable") or {})
    if isinstance(table.get("Data"), list):
        return table["Data"]
    result = (data.get("result") or {})
    if isinstance(result, dict):
        for key in ("Data", "pages", "Results"):
            if isinstance(result.get(key), list):
                return result[key]
    for key in ("Data",):
        if isinstance(data.get(key), list):
            return data[key]
    return []


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    # ES module 必须以 JS MIME 提供，否则浏览器拒绝执行；Windows 注册表常把 .js 映射错。
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript",
        ".css": "text/css", ".json": "application/json", ".html": "text/html",
        ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
    }

    def log_message(self, fmt, *args):
        sys.stdout.write("  %s\n" % (fmt % args))

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/kline":
            return self.handle_kline(urllib.parse.parse_qs(parsed.query))
        if parsed.path == "/api/resolve":
            return self.handle_resolve(urllib.parse.parse_qs(parsed.query))
        if parsed.path == "/api/health":
            engine, err = get_ocr()
            return self._send(200, {"ok": True, "time": datetime.now().isoformat(timespec="seconds"),
                                    "ocrReady": bool(engine), "ocrError": err})
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/ocr":
            return self.handle_ocr()
        return self._send(404, {"ok": False, "error": "未知接口"})

    def handle_kline(self, q):
        def one(k, d=None):
            v = q.get(k, [None])[0]
            return v if v not in (None, "") else d

        secid = one("secid")
        period = one("period", "daily")
        adjust = one("adjust", "qfq")
        provider = one("provider", "eastmoney")
        if provider == "sina":
            symbol = one("symbol")
            if not symbol:
                return self._send(400, {"ok": False, "error": "sina 通道需要 symbol 参数"})
            try:
                return self._send(200, fetch_sina_futures(symbol, period))
            except Exception as exc:
                return self._send(502, {"ok": False, "error": f"新浪通道失败：{exc}"})
        if not secid:
            return self._send(400, {"ok": False, "error": "缺少 secid（由前端 symbolMeta 解析得出）"})
        try:
            out = fetch_em_kline(secid, period, adjust, one("beg"), one("end"), one("count"))
        except Exception as exc:
            return self._send(502, {"ok": False, "error": f"eastmoney 拉取失败：{exc}", "secid": secid})
        if out["count"] == 0:
            out["warning"] = "上游返回 0 根 K 线：多半是 secid 无效、该合约未上市，或复权/周期组合不支持"
        return self._send(200, out)

    def handle_resolve(self, q):
        keyword = (q.get("q") or [""])[0].strip()
        if not keyword:
            return self._send(400, {"ok": False, "error": "缺少 q"})
        qs = urllib.parse.urlencode({"input": keyword, "type": "14", "count": "20"})
        try:
            raw = unwrap_jsonp(http_get(
                f"https://searchapi.eastmoney.com/api/suggest/get?{qs}",
                referer="https://quote.eastmoney.com/", accept="*/*"))
            data = json.loads(raw)
        except Exception as exc:
            return self._send(502, {"ok": False, "error": f"代码表检索失败：{exc}"})
        rows = extract_suggest_rows(data)
        cands = [{
            "code": r.get("Code"), "name": r.get("Name"), "secid": r.get("QuoteID"),
            "marketId": r.get("MktNum"), "kindRaw": r.get("SecurityTypeName"),
            "classify": r.get("Classify"),
        } for r in rows if r]
        return self._send(200, {"ok": True, "query": keyword, "count": len(cands), "candidates": cands})

    def handle_ocr(self):
        engine, err = get_ocr()
        if engine is None:
            return self._send(501, {
                "ok": False,
                "error": "OCR 引擎未安装",
                "detail": err,
                "install": "pip install rapidocr_onnxruntime",
                "fallback": "文本粘贴导入 / 手动输码 通道始终可用",
            })
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length == 0:
            return self._send(400, {"ok": False, "error": "空请求体"})
        if length > 12 * 1024 * 1024:
            return self._send(413, {"ok": False, "error": "图片过大（>12MB）"})
        body = self.rfile.read(length)
        try:
            result, ocr_err = engine(body)
        except Exception as exc:
            return self._send(500, {"ok": False, "error": f"OCR 执行异常：{exc}"})
        blocks = []
        for item in (result or []):
            box, text, score = item[0], item[1], item[2]
            xs = [p[0] for p in box]; ys = [p[1] for p in box]
            blocks.append({"text": text, "score": round(float(score), 4),
                           "bbox": [min(xs), min(ys), max(xs), max(ys)]})
        blocks.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
        return self._send(200, {"ok": True, "count": len(blocks), "blocks": blocks,
                                "engine": "rapidocr_onnxruntime", "engineError": ocr_err})


def lan_ip():
    """本机在局域网里的地址。

    服务器本来就绑在 ("", PORT) 即所有网卡上，但原先只打印 localhost ——
    iPad / 手机在同一 Wi-Fi 下根本不知道该填什么地址，等于把平板访问这条路堵死了。
    用 UDP connect 选出默认出口网卡，不会真的发包，也不依赖 hosts/DNS 配置。
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def main():
    url = f"http://localhost:{PORT}/futures_replay_trader.html"
    print("=== 趋势交易回测系统 · 双市场（期货 + A股）===")
    print(f"本地服务: http://localhost:{PORT}")
    print(f"主页:     {url}")
    ip = lan_ip()
    if ip:
        print(f"平板/手机: http://{ip}:{PORT}/futures_replay_trader.html")
        print(f"          （iPad 与本机连同一个 Wi-Fi，上面这个地址才是它能打开的）")
    print("接口:     /api/kline  /api/resolve  /api/ocr  /api/health")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
            print("服务已启动（Ctrl+C 停止）")
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n本地服务已安全停止。")


if __name__ == "__main__":
    main()
