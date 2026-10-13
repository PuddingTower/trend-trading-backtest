"""
国内期货真实历史行情批量下载与缓存脚本
用途：一键下载国内主要期货主力连续合约的历史真实K线数据，保存为标准 CSV 文件供复盘系统直接导入。
支持合约：EG0 (乙二醇)、RB0 (螺纹钢)、M0 (豆粕)、I0 (铁矿石)、CU0 (沪铜)、TA0 (PTA) 等。
"""

import urllib.request
import json
import csv
import os
import sys

# 默认待下载主力合约列表
DEFAULT_SYMBOLS = ['EG0', 'RB0', 'M0', 'I0', 'CU0', 'TA0']

def fetch_sina_futures_daily(symbol):
    """
    通过新浪财经公开接口拉取国内期货真实日K线历史数据
    """
    clean_symbol = symbol.strip().upper()
    url = f"https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_data=/IndexService.getInnerFuturesDailyKLine?symbol={clean_symbol}"
    
    print(f"正在从新浪行情服务器获取 {clean_symbol} 真实K线数据...")
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    )
    
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read().decode('utf-8', errors='ignore')
            # 提取 JSON 数组: var _data=([...]);
            start = content.find('[')
            end = content.rfind(']')
            if start == -1 or end == -1:
                print(f"❌ 解析 {clean_symbol} 数据失败，返回内容不包含有效数组")
                return None
            
            json_str = content[start:end+1]
            raw_data = json.loads(json_str)
            print(f"✅ 成功获取 {clean_symbol} 共 {len(raw_data)} 根真实日K线")
            return raw_data
    except Exception as e:
        print(f"❌ 下载 {clean_symbol} 失败: {e}")
        return None

def save_to_csv(symbol, raw_data, output_dir="./"):
    """
    保存为系统标准可直接导入的 CSV 格式
    """
    if not raw_data:
        return
    
    filename = os.path.join(output_dir, f"{symbol}_daily.csv")
    with open(filename, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.writer(f)
        writer.writerow(['date', 'open', 'high', 'low', 'close', 'volume'])
        for item in raw_data:
            writer.writerow([
                item.get('d', ''),
                item.get('o', ''),
                item.get('h', ''),
                item.get('l', ''),
                item.get('c', ''),
                item.get('v', '0')
            ])
    print(f"💾 数据已导出至 CSV: {filename}")

def main():
    symbols = sys.argv[1:] if len(sys.argv) > 1 else DEFAULT_SYMBOLS
    print(f"=== 开始批量抓取国内期货真实行情 ({len(symbols)}个品种) ===")
    for sym in symbols:
        data = fetch_sina_futures_daily(sym)
        if data:
            save_to_csv(sym, data)
    print("=== 全部下载任务完成！可直接拖拽生成的 CSV 到复盘系统界面中 ===")

if __name__ == '__main__':
    main()
