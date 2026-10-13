"""Determine eastmoney dominant-continuous secid per futures variety by direct kline probe."""
import json, urllib.request, urllib.parse, sys, concurrent.futures as cf

UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"}
VARIETIES = {
    113: ["rb", "hc", "cu", "al", "zn", "pb", "ni", "sn", "au", "ag", "ru", "bu", "fu", "sp",
          "ss", "ad", "br", "ao"],
    114: ["m", "y", "a", "b", "p", "c", "cs", "jd", "i", "j", "jm", "l", "v", "pp", "eg", "pg",
          "fb", "bb", "rr", "lh"],
    115: ["SR", "CF", "TA", "MA", "FG", "RM", "OI", "AP", "CJ", "PF", "SA", "UR", "PK", "SF",
          "SM", "CY", "RS", "PX", "PR", "SH"],
    142: ["sc", "bc", "lu", "nr", "ao"],
    220: ["IF", "IH", "IC", "IM", "T", "TF", "TS", "TL"],
    225: ["si", "lc", "pd", "pt"],
}


def probe(secid):
    url = ("https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=%s"
           "&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=0&beg=20240101&end=20261013&lmt=5") % urllib.parse.quote(secid)
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=20) as r:
            j = json.loads(r.read().decode("utf-8", "replace"))
        d = j.get("data")
        if not d or not d.get("klines"):
            return secid, None
        return secid, {"name": d.get("name"), "decimal": d.get("decimal"),
                       "dktotal": d.get("dktotal"), "last": d["klines"][-1].split(",")[0]}
    except Exception as exc:
        return secid, {"err": str(exc)[:60]}


candidates = []
for mkt, vs in VARIETIES.items():
    for v in vs:
        for cand in ("%d.%sm" % (mkt, v), "%d.%sM" % (mkt, v), "%d.%s" % (mkt, v.lower())):
            candidates.append(cand)

seen, results = set(), {}
with cf.ThreadPoolExecutor(max_workers=12) as ex:
    for secid, info in ex.map(probe, candidates):
        if secid not in seen:
            seen.add(secid)
            results[secid] = info

for mkt, vs in VARIETIES.items():
    print("### market", mkt)
    for v in vs:
        hits = []
        for cand in ("%d.%sm" % (mkt, v), "%d.%sM" % (mkt, v)):
            info = results.get(cand)
            if info and "err" not in info:
                hits.append("%s(name=%s,dec=%s,hist=%s,last=%s)" % (
                    cand.split(".", 1)[1], info["name"], info["decimal"], info["dktotal"], info["last"]))
        print("  %-5s %s" % (v, " | ".join(hits) or "NO DOMINANT FOUND"))
    sys.stdout.flush()
