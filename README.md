# Polymarket BTC Up/Down 5m streak backtest

## What it checks
For each round i:
- Look back N rounds (i-N ... i-1).
- If they are all Up, predict Down for round i.
- If they are all Down, predict Up for round i.
- Otherwise: no signal.

Backtests N = 3 .. 8 over the last 100 slugs (5-minute stepping by timestamp in the slug).

## Data sources
- Gamma API market metadata:
  - https://gamma-api.polymarket.com/markets/slug/{slug}
- CLOB price history:
  - https://clob.polymarket.com/prices-history?tokenId=...
The script infers each roundâ€™s resolved outcome by grabbing the final observed prices for the Up/Down tokens and picking the one closest to 1.0.

## Run
\\\ash
npm run start -- --baseSlug "btc-updown-5m-1771290300" --count 100 --minStreak 3 --maxStreak 8 --roundSeconds 300
\\\

## Outputs
- out/rounds.csv one row per slug with inferred outcome + final token prices
- out/signals.csv one row per triggered signal (N, prediction, actual, correct)
- out/summary.json aggregated win rates and helpful counts
- out/summary.md human-readable summary

> Not financial advice; this is a simple pattern backtest.