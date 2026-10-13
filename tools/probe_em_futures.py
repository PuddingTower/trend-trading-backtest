"""Probe eastmoney futures code table: variety -> dominant-continuous secid, plus decimal precision."""
import json, urllib.request, urllib.parse, sys

UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"}
MARKETS = {113: "SHFE", 114: "DCE", 115: "CZCE", 142: "INE", 220: "CFFEX", 225: "GFEX"}


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def clist_all(fs, fields):
    out, pn = [], 1
    while True:
        j = get("https://push2.eastmoney.com/api/qt/clist/get?pn=%d&pz=100&po=1&np=1&fltt=2&invt=2&fs=%s&fields=%s" % (pn, urllib.parse.quote(fs), fields))
        d = (j.get("data") or {})
        diff = d.get("diff") or []
        if not diff:
            break
        out.extend(diff)
        if len(out) >= int(d.get("total") or 0) or pn > 30:
            break
        pn += 1
    return out


for mkt, name in MARKETS.items():
    rows = clist_all("m:%d&s:1" % mkt, "f12,f14,f13")
    dom = [r for r in rows if "主连" in str(r.get("f14", ""))]
    print("### %s (%d)  listed=%d  dominant=%d" % (name, mkt, len(rows), len(dom)))
    print("   dominant:", ", ".join("%s=%s" % (r.get("f12"), r.get("f14")) for r in dom) or "(none with m:%d&s:1)")
    sys.stdout.flush()
