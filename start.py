"""
一条命令启动：python start.py

做三件事，省掉新机器上手动折腾的顺序问题
  1. 起本地服务器（ES module 必须走 http://，双击 HTML 打不开）
  2. 夹具缺失时自动补抓 —— 之前必须先开一个终端跑服务器、再开一个终端跑
     fetch_fixtures.py，顺序错了就连不上，这不算开箱即用
  3. 打开浏览器

可选参数：
  --port N      换端口（默认 8080）
  --no-fixtures 跳过抓夹具（纯手动复盘用）
  --no-browser  不开浏览器
"""
import os
import socket
import sys
import threading
import time
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def port_is_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) != 0


def pick_port(preferred):
    if port_is_free(preferred):
        return preferred
    for p in range(preferred + 1, preferred + 20):
        if port_is_free(p):
            print(f"  端口 {preferred} 被占用，改用 {p}")
            return p
    print(f"  {preferred}~{preferred+19} 全被占用；可能已有一个实例在跑，直接用 {preferred}")
    return preferred


def main():
    args = sys.argv[1:]
    port = int(args[args.index("--port") + 1]) if "--port" in args and len(args) > args.index("--port") + 1 \
        else int(os.environ.get("TREND_PORT", "8080"))
    want_fixtures = "--no-fixtures" not in args
    want_browser = "--no-browser" not in args

    port = pick_port(port)
    os.environ["TREND_PORT"] = str(port)
    os.environ["TREND_BASE"] = f"http://localhost:{port}"
    url = f"http://localhost:{port}/futures_replay_trader.html"

    import run_local_server as server
    import socketserver

    print("=== 趋势交易回测系统 · 双市场（期货 + A股）===")
    print(f"  主页 {url}")
    lan = server.lan_ip()
    if lan:
        print(f"  平板/手机 http://{lan}:{port}/futures_replay_trader.html  （同一 Wi-Fi 下的 iPad 用这个）")
    print(f"  接口 /api/kline  /api/resolve  /api/ocr  /api/health")

    httpd = socketserver.ThreadingTCPServer(("", port), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print("  本地服务器已就绪")

    # 等自己可访问后再抓夹具（抓取脚本走的就是这个服务）
    for _ in range(40):
        try:
            import urllib.request
            with urllib.request.urlopen(f"http://localhost:{port}/api/health", timeout=2):
                break
        except Exception:
            time.sleep(0.25)

    if want_fixtures and not os.path.exists(os.path.join(HERE, "fixtures", "index.json")):
        print("  首次运行：正在抓取真实K线夹具（约 17 个品种，十几秒）…")
        try:
            import tools.fetch_fixtures as ff
            rc = ff.main()
            print("  夹具就绪" if rc == 0 else "  部分夹具抓取失败，回测仍可用在线通道")
        except Exception as exc:
            print(f"  夹具抓取失败（{exc}）；不影响手动复盘，回测需先跑 tools/fetch_fixtures.py")
    elif want_fixtures:
        print("  夹具已存在，跳过抓取")

    if want_browser:
        try:
            webbrowser.open(url)
        except Exception:
            print(f"  请手动打开：{url}")

    print("  Ctrl+C 退出\n")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        httpd.shutdown()
        print("\n已停止。")


if __name__ == "__main__":
    main()
