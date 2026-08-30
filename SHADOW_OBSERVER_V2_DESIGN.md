# Shadow Observer V2 — Analytics Workspace

## Product outcome

Shadow Observer V2 changes the V1 telemetry-card dashboard into a read-only prediction-market research workspace. The primary viewport now leads with recorded executable edge over time, followed by edge distribution, the sequential opportunity funnel, and a dense current-opportunity/near-miss table.

The observer remains a presentation layer over the existing Stage B artifacts. It does not submit orders, control strategies, change experiment configuration, infer maker fills, or create a second economics implementation.

## Information architecture

### Overview

- Compact six-field status strip: Stage/state, elapsed/target, pair reliability, fee coverage, current sampled markets, and errors.
- Dominant executable-edge time series with `1h / 6h / 24h` selection.
- Best and median recorded edge plus an interquartile band and zero-edge reference.
- Edge histogram with explicit negative/positive separation.
- True sequential funnel with counts and step conversion.
- Current opportunities/near misses sorted by the strongest recorded executable edge.

### Markets

- Dense sortable table with current sampled markets only.
- Search, category, topology, and minimum/maximum edge filters.
- `$10`, `$100`, and `$500` recorded executable edge columns.
- Compact per-market `$100 / 0ms` trend sparklines.
- Large side drawer for detail instead of a long page navigation.

### Market detail

- Recent recorded `$100 / 0ms` edge timeline.
- Size-ladder attribution chart for `$10 / $25 / $50 / $100 / $250 / $500 / $1000`.
- YES/NO depth visualizations using clearly labelled log-scaled bars; exact raw ladders remain available as secondary disclosure.
- State age, hash activity, topology changes, and recent observer events.
- All fills, VWAP, impacts, fees, safety slippage and final edge come directly from recorder events.

### Analytics

- Edge time series and histogram.
- Near-miss distribution.
- Edge versus position size.
- Category comparison.
- Current topology distribution.
- Book-state-age distribution.
- Hash-change activity.
- Latency survival is hidden unless the recorder contains at least one honest non-zero latency replay observation.

### System

- Run provenance, recorder sequence/cycles and observer cursor diagnostics.
- Network preflight.
- PAPER_ONLY guards and trusted/denied PnL boundary.
- Cumulative book/fee/hash quality.
- Filtered important-event stream.

The global `Safety ✓` disclosure keeps the three safety guards visible without using the primary analytics viewport for large badges.

## Data contract and correctness

- Existing V1 fields and endpoints remain available:
  - `GET /shadow`
  - `GET /shadow/api/snapshot`
  - `GET /shadow/api/market/:marketId`
- V2 adds presentation indexes to the snapshot and detail payloads without changing execution formulas.
- The reference time-series/distribution sample is explicitly labelled `$100 recorded executable economics at 0ms`.
- Time buckets aggregate already-recorded edge values; they do not reprice books.
- Current market count and rows use the latest recorded `sampledMarketIds` batch rather than the number of markets seen anywhere in the tail window.
- Ambiguous categories remain `other`.
- Unknown or missing values remain unavailable; the UI does not substitute midpoint, last trade, Gamma price, or fabricated latency values.

## Performance and isolation

- The first read is bounded by `--tail-mb` (16 MiB by default).
- Later refreshes read only bytes appended after the existing cursor.
- UI refresh remains 3 seconds.
- Cumulative counters continue to come from `manifest.json`.
- Market/time-series indexes are in-memory observer views, not durable storage or a second source of truth.
- The observer never writes to the Stage B run directory.

## Read-only boundary

- Only `GET` and `HEAD` are accepted under the observer prefix.
- Mutating requests return `405 READ_ONLY_OBSERVER`.
- No order, strategy, threshold, wallet, signing, approval, restart, stop, configuration, live-trading, or Slow Brain controls are present.
- Startup requires:

```text
NO_PRIVATE_KEY=true
NO_WALLET=true
NO_LIVE_TRADING=true
```

## Run command

```powershell
$env:NO_PRIVATE_KEY='true'
$env:NO_WALLET='true'
$env:NO_LIVE_TRADING='true'

npm run shadow-observer -- `
  --run-dir "E:\AI\Polymarket Strategy Lab\shadow_runs\long-shadow-v1-stage-b-24h-20260830" `
  --host 127.0.0.1 `
  --port 4312 `
  --tail-mb 16
```

Open `http://127.0.0.1:4312/shadow`.

## Visual evidence

- [Overview](docs/assets/shadow-observer-v2-overview.png)
- [Markets](docs/assets/shadow-observer-v2-markets.png)
- [Analytics](docs/assets/shadow-observer-v2-analytics.png)
- [Market detail](docs/assets/shadow-observer-v2-market-detail.png)
- [System](docs/assets/shadow-observer-v2-system.png)

## Visual QA answers

| Question | Result |
|---|---|
| Is the first viewport dominated by analytics rather than telemetry cards? | Yes. The edge time series is the dominant surface; telemetry is reduced to one compact strip. |
| Can a user identify the strongest current edge/near miss within 5 seconds? | Yes. The current-opportunity table is ordered by best recorded edge and uses economic color semantics. |
| Are time trends visible? | Yes. Overview and market detail provide edge timelines, and market rows provide compact trends. |
| Is market comparison easy? | Yes. The Markets view is dense, sortable, searchable and filterable without oversized rows. |
| Is data quality available without dominating the product? | Yes. It is concentrated in System, with only reliability, fee coverage and errors retained globally on Overview. |
| Has card count materially decreased? | Yes. Eight V1 KPI cards and the card wall were replaced by a single strip and chart/table surfaces; primary-view metric cards were eliminated. |

## Stage B isolation

The V2 implementation and preview run from the separate `CloddsBot-shadow-observer` worktree and `feat/shadow-observer-v2` branch. The running Stage B process remains on frozen commit `59f39c852e4ac93caa821a6246f50f9987dc0a5c`; it was not modified, rebuilt, restarted, stopped, or reconfigured.
