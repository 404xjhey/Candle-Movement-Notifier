# Wickwatch

Wickwatch scans Binance USD-M Futures for closed candles on a configurable
interval whose absolute open-to-close move exceeds your threshold. It can
optionally send orders to Binance Demo or Live Futures.

## Run locally

Install Node.js 18 or newer, then run:

```powershell
npm start
```

Open `http://127.0.0.1:8000`. The local server serves the dashboard and signs
private Binance requests. Do not serve the page with `file://` or a separate
static web server when using trading.

## Scanner

- Scans active USDT perpetual contracts using Binance's public market stream.
  Choose 1-minute, 5-minute, 15-minute, 1-hour, 4-hour, 8-hour, or 1-day
  candles in Settings; the selected interval is saved in browser storage.
- Records a signal when a closed candle's absolute open-to-close move is
  strictly greater than the configured threshold. Upward moves are LONG signals;
  downward moves are SHORT signals.
- Shows the move, 24-hour change, close price, directional PnL from the signal
  close, candle volume, signal bias, close time, trade status, and a per-row
  CLOSE button when a position is open.
- Removes a token's alert from Latest Alerts after a previously observed
  Binance position for that token is closed. This is detected on the next
  successful position refresh (about every 15 seconds while the dashboard is
  open).
- Keeps the configured number of recent alerts (1–500) and supports CSV export.
- Saves scanner preferences and alert history in browser local storage.

## Binance trading

Trading is disabled by default and starts in **Demo** mode. In Settings:

1. Select Demo or Live. Live mode requires an explicit confirmation.
2. Enter both the API key and secret for the selected Binance environment.
   The password fields are masked. The local server keeps credentials in memory
   only; they are not saved to browser storage and are cleared when it stops.
3. Choose a trading strategy, stop-loss method, allowed trade direction, a per-order margin amount, and **Maximum open
   trades** (default 15; configurable from 1 to 100). The cap counts all open
   Binance Futures positions on the selected account, including positions
   opened outside Wickwatch. Reverse call with limit also counts resting entry
   orders. New orders are rejected when the cap is reached.
   A percentage margin uses available USDT margin; a fixed amount uses USDT.
   Position notional is margin multiplied by **5x leverage**.
   **Default** follows the candle direction (green = long, red = short).
   **Support/resistance (existing)** uses the nearest strong support/resistance
   from 60 completed 1-minute candles for the exchange-hosted stop-loss: support
   for Long, resistance for Short. A strong level requires at least two
   confirmed swing-pivot touches within 0.15%; the stop is placed 0.1% beyond
   the level. **Minimum-move candle** checks the 15 completed candles before
   each signal, using the configured scanner timeframe and minimum-move
   threshold. It picks the oldest candle with the same color as the signal that
   also exceeds the threshold, then uses its low for a Long stop only if it is
   below the signal candle's low, or its high for a Short stop only if it is
   above the signal candle's high. If none qualify or that comparison fails,
   it uses the signal candle's low or high.
   The configured negative **Fallback stop-loss ROI** is used if support/
   resistance has no strong level or the selected candle price is not a valid
   protective trigger for the entry (default `-10`). If Binance cannot provide
   all 15 prior candles for the minimum-move method, no order is submitted.
   Default trades can also use an
   optional positive **Take-profit ROI**. Take-profit ROI is converted to an
   exchange-hosted mark-price trigger at 5x leverage, before fees and funding.
   Wickwatch places protective orders after the entry; the minimum-move candle
   stop price is selected before entry, while support/resistance is calculated
   after entry. There can be a short interval before the stop is active. If
   1-minute support/resistance data is unavailable, the ROI fallback is used
   and a warning is shown. Once placed, Binance keeps these orders active if
   Wickwatch closes. If a stop or
   take-profit is already reached before its order can be placed, Wickwatch
   closes the position immediately. Triggered market orders can slip.
   **Reverse Call** takes the opposite side at market after a qualifying
   candle closes. **Reverse call with limit** places a GTC limit order 2.5%
   beyond the candle high or low. The selected stop-loss method is applied
   after a limit position fills; the minimum-move candle stop remains anchored
   to the original signal candle.
   Stop-market execution can slip, especially in fast markets.
   The trade-direction setting filters the resulting order direction for every
   strategy.
4. Save settings, then go to Overview and explicitly press **START TRADING**.
   Saving settings never starts trading. Opening or reloading the dashboard
   stops automatic trading; press START TRADING again when you want to resume.
   New qualifying closed candles can place orders after setting contract
   leverage to 5x. An existing position or open order for a contract prevents
   another automatic entry. Use **STOP TRADING** to stop new entries; this does
   not close positions that are already open.
5. Use CLOSE beside an open position to send a market close order.

Create separate Demo and Live API keys. Grant only the permissions needed for
Futures trading; withdrawals are not needed. Keep keys private and do not expose
this server beyond the local machine. Live mode can lose funds. Reverse Call
market trades do not set take-profit orders. Their stop-loss uses the selected
stop-loss method. Reverse call with limit sets its protective stop after the
entry fills as described above. Demo trading uses Binance's
separate Futures demo API and credentials.

The market scanner uses public live Binance market data even while orders are
sent to Demo. The local trading server must remain running for automatic orders
and CLOSE actions.
