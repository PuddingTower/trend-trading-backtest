# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

China-market self-directed retail traders and learners who want to study price action and test trading ideas without risking money: futures (工业品/农产品/贵金属/股指) and A-shares/ETFs. They are technically comfortable (arriving from an open-source GitHub repo), often study in the evening on a laptop or tablet, and want hands-on replay rather than a marketing dashboard.

## Product Purpose

A pure-local K-line replay and strategy-backtest learning tool with two separate workbenches: futures and A-shares. Each entry point owns its own symbol universe, order panel, and market rules; below them, manual replay and automated backtesting share the same matching, conditional-order, and cost logic — one execution engine driven two ways (human keypresses vs strategy signals). Success means a learner can replay real history, place and manage trades by hand, then run a strategy over the same engine and trust that the fills follow identical rules, without ever confusing a leveraged futures account with a T+1 stock account.

## Positioning

One shared core, two market workbenches. Futures and A-shares must not share one order form: futures has T+0, margin, leverage, daily mark-to-market and liquidation; A-shares has T+1, long-only, 100-share lots, full cash, price-limit boards and stamp duty. A neighboring toy chart app or a black-box backtester cannot truthfully claim that the manual replay path and the automated backtest path run through the exact same order/fill/cost/settlement code. The online build also runs on static GitHub Pages against real market data with no token and no backend, while the local build adds a proxy, cache, and fixtures.

## Operating Context

- **Online (GitHub Pages):** static hosting, browser connects directly to 东财 for real bars; no backend; skips the `/api/kline` proxy channel instead of generating 404s.
- **Local (`python start.py`):** adds `/api/kline` proxy + IndexedDB cache, fixture top-up, and prefers local rapidocr for image import; otherwise the same features.
- Study rituals: scrubbing history bar by bar, drawing lines, marking entries/exits, running parameter sweeps and walk-forward, comparing strategies, exporting an HTML/CSV/Markdown review.
- iPad/tablet use: pointer/touch pan and pinch-zoom, drawer trade panel in portrait, 16px inputs to avoid iOS zoom.

## Capabilities and Constraints

Confirmed capabilities (see README feature table): separate futures and A-share workbenches; real 期货+A股 bars with period/adjustment; A-share manual replay with T+1, long-only, 100-share lots, full-cash sizing, price-limit boards and commission/stamp duty; futures manual replay with margin, two-way trading and daily mark-to-market; overlays (volume profile, Supertrend, pivots, patterns, supply/demand); conditional orders (stop/target/trailing/bracket/partial close/add); 9 built-in strategies on the shared rule/cost engine; parameter optimization with neighborhood robustness and heatmap; walk-forward; portfolio backtest (independent and shared-margin); strategy comparison with correlation and equal-weight blend; position sizing (ATR risk budget / notional / vol target / half-Kelly / risk parity); Monte Carlo; cost sensitivity; market scanner; momentum rotation; data-quality checks (halts, adjustment continuity, daily mark-to-market); advanced reports and export; blind replay; trade journal; watchlist; symbol name resolution; OCR screenshot import (browser tesseract.js online, rapidocr local); CSV/paste import; HTML/CSV/Markdown export.

Constraints: no broker/live/real-time/tick-HFT; static hosting has no backend; fixtures are not committed (regenerable); no secrets in repo; data from 东财/新浪. Terminology is Chinese. Not for backend-only work.

## Brand Commitments

Product name: 烛台簿 / CANDLE LEDGER (lightning-bolt mark ⚡ is retained as the small "spark" motif). The application UI is a Material Design 3 dark scheme with a blue seed and a documented data palette (up/down). Treat the app's dark M3 world as incumbent and do not replace it during refinement.

## Evidence on Hand

- `README.md`: feature-by-feature online/local comparison and usage notes (authoritative capability list).
- `src/` modules: `core/backtestEngine.js`, `core/orders.js`, `core/portfolio*.js`, `core/sizing.js`, `report/*`, `strategy/library.js`, `markets/*`, `data/*` — the real engine and rules.
- `tests/` and `npm test` (`tests/run.js`) exercise modules.
- `assets/theme.css`: the app's M3 token system (semantic tokens, `--data-*` palette).
- No customer testimonials, benchmarks, pricing, or third-party endorsements exist; future work must not fabricate any.

## Product Principles

1. One engine, two drivers — never fork manual and automated fill logic.
2. Data fidelity over convenience: no virtual candles, real settlement and adjustment, honest gaps.
3. Run anywhere: the online static build must work without a backend or token.
4. Learn by doing: replay, mark, and measure rather than present a black-box score.
5. Local-first and private: no broker connection, no upload of user images or trades.

## Accessibility & Inclusion

Keyboard-operable app with documented shortcuts; touch targets and 16px inputs for iPad Safari; content must stay readable at desktop and mobile widths. No formal WCAG level was specified.
