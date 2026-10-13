"""
国内期货手动复盘系统 - 本地一键启动服务器
用途：在本地快速启动轻量级 HTTP Web 服务器并自动在浏览器中打开复盘回测系统。
运行方式：python run_local_server.py
"""

import http.server
import socketserver
import webbrowser
import os
import sys

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

def main():
    os.chdir(DIRECTORY)
    url = f"http://localhost:{PORT}/futures_replay_trader.html"
    print(f"=== 国内期货手动复盘与划线模拟交易回测系统 ===")
    print(f"本地服务已启动: http://localhost:{PORT}")
    print(f"系统运行主页: {url}")
    print(f"正在自动为您打开默认浏览器... (按 Ctrl+C 可停止服务)")
    
    try:
        webbrowser.open(url)
    except Exception:
        pass
        
    try:
        with socketserver.TCPServer(("", PORT), Handler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n本地服务已安全停止。")

if __name__ == '__main__':
    main()
