# Wickwatch

Wickwatch scans Binance USD-M Futures for closed one-minute candles whose
absolute open-to-close move exceeds your threshold. It can optionally send
market orders to Binance Demo or Live Futures.

## Run locally

Install Node.js 18 or newer, then run:

```powershell
npm start
```

Open `http://127.0.0.1:8000`. The local server serves the dashboard and signs
private Binance requests. Do not serve the page with `file://` or a separate
static web server when using trading.

## Scanner

- Scans active USDT perpetual contracts using Binance's public one-minute
  market stream.
- Records a signal when a closed candle's absolute open-to-close move is
  strictly greater than the configured threshold. Upward moves are LONG signals;
  downward moves are SHORT signals.
- Shows the move, 24-hour change, close price, directional PnL from the signal
  close, candle volume, signal bias, close time, trade status, and a per-row
  CLOSE button when a position is open.
- Keeps the configured number of recent alerts (1–500) and supports CSV export.
- Saves scanner preferences and alert history in browser local storage.

## Binance trading

Trading is disabled by default and starts in **Demo** mode. In Settings:

1. Select Demo or Live. Live mode requires an explicit confirmation.
2. Enter both the API key and secret for the selected Binance environment.
   The password fields are masked. The local server keeps credentials in memory
   only; they are not saved to browser storage and are cleared when it stops.
3. Choose a trade direction, a per-order margin amount, and **Maximum open
   trades** (default 5; configurable from 1 to 100). The cap counts all open
   Binance Futures positions on the selected account, including positions
   opened outside Wickwatch. New orders are rejected when the cap is reached.
   A percentage margin uses available USDT margin; a fixed amount uses USDT.
   Position notional is margin multiplied by **5x leverage**.
4. Save settings, then go to Overview and explicitly press **START TRADING**.
   Saving settings never starts trading. Opening or reloading the dashboard
   stops automatic trading; press START TRADING again when you want to resume.
   New qualifying closed candles can place market orders after setting contract
   leverage to 5x. An existing position for a contract prevents another
   automatic entry. Use **STOP TRADING** to stop new entries; this does not
   close positions that are already open.
5. Use CLOSE beside an open position to send a market close order.

Create separate Demo and Live API keys. Grant only the permissions needed for
Futures trading; withdrawals are not needed. Keep keys private and do not expose
this server beyond the local machine. Live mode can lose funds. The app does not
set stop-loss or take-profit orders; monitor positions and verify fills directly
in Binance. Demo trading uses Binance's separate Futures demo API and credentials.

The market scanner uses public live Binance market data even while orders are
sent to Demo. The local trading server must remain running for automatic orders
and CLOSE actions.
