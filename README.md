# 趋势交易回测系统 · Trend Replay Backtest

纯本地的**双市场（期货 + A股）K线复盘与策略回测**学习工具。手动复盘与自动回测**共用同一套撮合、规则与成本逻辑** —— 一份成交逻辑，两种驱动（人工按键 vs 策略信号）。

不接任何实盘/券商接口，不做实时行情推送，不做 tick 级高频回测。

---

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Python | 3.8+ | **只用标准库**，无需 `pip install` |
| Node.js | 16+ | 仅用于跑单元测试与命令行回测；开发期实测 v24 |
| 网络 | 需要 | 行情来自东方财富/新浪财经公开接口 |

零 npm 依赖、零 pip 依赖（`node_modules/` 不存在也不需要）。

---

## 启动

```bash
python run_local_server.py
```

自动打开浏览器 `http://localhost:8080/futures_replay_trader.html`。

> **必须通过这个服务器访问，不能双击 HTML 打开。**
> 前端用 ES modules（`<script type="module">`），浏览器在 `file://` 下会以 CORS 为由拒绝加载模块；
> 而且 `/api/kline` 行情代理也依赖这个服务器。

换端口：`TREND_PORT=9000 python run_local_server.py`

### 抓取行情夹具（新机器上必做一次）

真实K线夹具**不入版本库**（避免把上游抓取数据再分发），需要自己生成：

```bash
# 终端 1：先起服务器
python run_local_server.py

# 终端 2：再抓数据（脚本走的是本地 /api/kline 代理，所以服务器必须在跑）
python tools/fetch_fixtures.py
```

生成 `fixtures/` 下约 17 份 JSON（2015→今，覆盖黑色/化工/农产品/金属/股指/A股/ETF/指数）。
没抓夹具时测试会**自动 skip** 相关用例而不是报错。

---

## 验证与回测

```bash
npm test                      # 80 条单元测试
node tests/run.js backtest    # 只跑回测引擎那部分

node tools/backtest.js                                  # 全品种 × 全策略，真实数据跑批
node tools/backtest.js --strategy donchianBreak --grid  # 参数敏感性网格
node tools/backtest.js --only rbm,600519                # 指定品种
```

界面里也能直接回测：底部 **「🤖 策略自动回测」** tab。

---

## 服务器接口

| 路径 | 作用 |
|---|---|
| `GET /api/kline` | 行情代理。参数 `secid / period(daily,weekly,monthly,60m) / adjust(none,qfq,hfq) / count / beg / end` |
| `GET /api/resolve?q=` | 代码-名称检索（东方财富权威代码表），供识图导入做交叉校验 |
| `GET /api/health` | 服务与 OCR 引擎状态 |
| `POST /api/ocr` | 截图识别（需 `pip install rapidocr_onnxruntime`；未装返回 501 并给出兜底提示） |

`secid` 由前端 `src/markets/symbolMeta.js` 解析后传入，服务器不重复实现代码解析。
格式：`1.600519`(沪) / `0.000001`(深) / `113.rbm`(上期所主连) —— 交易所编号 113上期所 114大商所 115郑商所 142能源中心 220中金所 225广期所。

---

## 目录结构

```
futures_replay_trader.html   主页面（正在按绞杀者模式逐步拆出，仍含图表/画线/引擎）
run_local_server.py          静态托管 + 行情代理 + OCR
src/
  markets/     交易所表、期货合约规格、双市场代码解析、交易规格解析
  data/        IndexedDB v2 缓存、行情适配器(三通道降级)、CSV、换月拼接与周期聚合
  analysis/    量能剖面、Supertrend、Pivot、形态识别、供需区/Wyckoff（纯函数）
  strategy/    指标库 + 6 个内置趋势策略
  core/        事件驱动回测内核
  report/      绩效指标
  ui/          叠加层渲染器、回测面板
tools/         夹具抓取、回测跑批、上游接口实测脚本
tests/         零依赖单测骨架 + 用例；migration-probe.html 验证 IndexedDB 迁移
```

---

## 回测口径（重要，决定了结果可不可信）

这些不是文档里的提醒，而是 `tests/backtest.test.js` 里可断言的规则：

1. **信号在第 i 根产生，成交固定在第 i+1 根开盘**。不提供"当根成交"开关 —— 那个口径等于用未来信息。
2. **跳空穿透止损按开盘价成交**，不按止损价。按止损价记账会少记真实亏损。
3. **同一根内止损与止盈都可能触发时，先算止损**（悲观优先）。
4. **`priorExtreme` / Donchian 通道不含当前 bar**，否则等于用今天的最高价决定今天的突破。
5. **确定性**：同一输入两次运行，交易列表与权益曲线逐字节相等。
6. **复盘工具里所有叠加指标只喂已揭示的 bar**，杜绝未来函数。

成本口径：期货按品种乘数/tick/保证金/手续费（平今仓单独计费）；A股 1手=100股、佣金万2.5最低5元、卖出印花税、过户费。

---

## 已知边界（别踩）

- **A股 T+1 与涨跌停板锁尚未实现** —— 当前 A股回测把"涨停买不进/跌停卖不出"当成能成交，那部分数字不能当真。
- **默认策略没有一个是"能赚钱的策略"**。真实数据跑批结论：6 个策略没有一个能稳定跑赢买入持有，最好平均 Sharpe 仅 0.14；参数一调成绩就翻脸（典型过拟合信号）。这个项目的价值在**验证框架**，不在这几个默认参数。
- **新浪期货接口已冻结在 2024-07-17**，只作兜底通道，主源是东方财富。
- 保证金强平只做了底线（权益跌破维持线次根开盘平），完整的逐日盯市/预警线还在计划里。

---

## 许可

MIT —— 详见 `LICENSE`。行情数据版权归各交易所与数据源，本仓库不再分发原始行情。
