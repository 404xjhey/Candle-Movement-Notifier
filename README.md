# Wickwatch

A lightweight browser dashboard that watches Binance USD-M Futures and records
closed, bullish one-minute candles whose open-to-close move exceeds your chosen
threshold. The default threshold is 5%; the latest 20 alerts are kept by
default, and the alert limit can be configured in Settings.

## Run locally

Serve this folder over HTTP (the Binance exchange-info request is not available
from a `file://` page), for example:

```powershell
py -m http.server 8000
```

Then open `http://localhost:8000` in your browser. The app uses Binance's public
USD-M Futures exchange-info endpoint and public WebSocket market stream; no API
key or trading permissions are needed.

## Features

- Scans active USDT perpetual contracts on the one-minute interval.
- Records a signal only after a candle closes green and its open-to-close move
  (`(close - open) / open * 100`) is strictly greater than the configured threshold.
- Shows the move percentage, close price, candle quote volume in USDT, bullish
  bias, 24-hour token change, PnL percentage from the signal's close to the
  current token price, and close time for each signal. Only the first signal
  for each token is kept in the current alert list.
- Opens the matching Binance Futures chart in a new tab when a contract is clicked.
- Keeps the configured number of most recent records (1–500), with controls to
  export the history as an Excel-compatible CSV or clear it.
- Saves the threshold, alert limit, notification preference, and alert history
  in browser local storage.
- Paces market subscriptions and shows connected status after Binance confirms
  all subscriptions; reconnects automatically if Binance rejects them or the
  stream disconnects.

Browser notifications are optional and require permission from the browser.
Market data is informational only; Wickwatch does not place trades.
