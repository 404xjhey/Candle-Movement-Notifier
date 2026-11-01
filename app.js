const API_BASE = "https://fapi.binance.com";
const STREAM_BASE = "wss://fstream.binance.com/market/ws";
const SETTINGS_KEY = "wickwatch-settings-v1";
const RECORDS_KEY = "wickwatch-alerts-v2";
const DEFAULT_ALERT_LIMIT = 20;
const MAX_ALERT_LIMIT = 500;
const DEFAULT_MAX_OPEN_TRADES = 5;
const MAX_OPEN_TRADES = 100;
const SUBSCRIPTION_BATCH_SIZE = 100;
const SUBSCRIPTION_INTERVAL_MS = 250;
const REVERSE_CALL_LOOKBACK_MINUTES = 120;

const elements = {
  connectionIndicator: document.querySelector("#connection-indicator"),
  connectionLabel: document.querySelector("#connection-label"),
  connectionMessage: document.querySelector("#connection-message"),
  contractsCount: document.querySelector("#contracts-count"),
  alertsCount: document.querySelector("#alerts-count"),
  alertLimitDisplay: document.querySelector("#alert-limit-display"),
  thresholdDisplay: document.querySelector("#threshold-display"),
  lastUpdated: document.querySelector("#last-updated"),
  alertsBody: document.querySelector("#alerts-body"),
  emptyState: document.querySelector("#empty-state"),
  emptyTitle: document.querySelector("#empty-title"),
  emptyDescription: document.querySelector("#empty-description"),
  countPill: document.querySelector("#count-pill"),
  clearButton: document.querySelector("#clear-button"),
  exportButton: document.querySelector("#export-button"),
  settingsForm: document.querySelector("#settings-form"),
  thresholdInput: document.querySelector("#threshold-input"),
  alertLimitInput: document.querySelector("#alert-limit-input"),
  maxOpenTradesInput: document.querySelector("#max-open-trades-input"),
  notificationsInput: document.querySelector("#notifications-input"),
  strategyInput: document.querySelector("#strategy-input"),
  tradeDirectionInput: document.querySelector("#trade-direction-input"),
  marginAmountInput: document.querySelector("#margin-amount-input"),
  marginUnitInput: document.querySelector("#margin-unit-input"),
  tradeModeInput: document.querySelector("#trade-mode-input"),
  tradingSessionButton: document.querySelector("#trading-session-button"),
  tradingSessionStatus: document.querySelector("#trading-session-status"),
  tradingSettingsStatus: document.querySelector("#trading-settings-status"),
  tradingSettingsState: document.querySelector("#trading-settings-state"),
  apiKeyInput: document.querySelector("#api-key-input"),
  apiSecretInput: document.querySelector("#api-secret-input"),
  credentialStatus: document.querySelector("#credential-status"),
  removeCredentialsButton: document.querySelector("#remove-credentials-button"),
  settingsFeedback: document.querySelector("#settings-feedback"),
  toast: document.querySelector("#toast"),
  breadcrumb: document.querySelector("#breadcrumb-current"),
  overviewPage: document.querySelector("#overview-page"),
  settingsPage: document.querySelector("#settings-page")
};

let settings = loadSettings();
let alerts = loadAlerts();
let markets = [];
let tradingStatus = null;
let tradingServiceAvailable = false;
let tradingSessionBusy = false;
let positions = new Map();
let openPositionCount = 0;
const closingSymbols = new Set();
const tickerChanges = new Map();
const tickerPrices = new Map();
let socket;
let reconnectTimer;
let subscriptionTimer;
let toastTimer;
let subscriptionIdsAwaitingAck = new Set();
let allMarketsSubmitted = false;
const seenCandles = new Set(alerts.map((alert) => alert.id));

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const threshold = Number(saved.threshold);
    const alertLimit = Number(saved.alertLimit);
    const maxOpenTrades = Number(saved.maxOpenTrades);
    return {
      threshold: Number.isFinite(threshold) && threshold >= 0.1 && threshold <= 100 ? threshold : 5,
      alertLimit: Number.isInteger(alertLimit) && alertLimit >= 1 && alertLimit <= MAX_ALERT_LIMIT
        ? alertLimit
        : DEFAULT_ALERT_LIMIT,
      maxOpenTrades: Number.isInteger(maxOpenTrades) && maxOpenTrades >= 1 && maxOpenTrades <= MAX_OPEN_TRADES
        ? maxOpenTrades
        : DEFAULT_MAX_OPEN_TRADES,
      notifications: saved.notifications === true,
      tradeMode: saved.tradeMode === "live" ? "live" : "demo",
      strategy: ["default", "reverse-call", "reverse-call-limit"].includes(saved.strategy)
        ? saved.strategy
        : "default",
      tradeDirection: ["both", "long", "short"].includes(saved.tradeDirection) ? saved.tradeDirection : "both",
      marginAmount: Number.isFinite(Number(saved.marginAmount)) && Number(saved.marginAmount) > 0
        ? Number(saved.marginAmount)
        : "",
      marginUnit: saved.marginUnit === "usdt" ? "usdt" : "percent",
      tradingEnabled: false
    };
  } catch (error) {
    console.warn("Could not read Wickwatch settings from local storage.", error);
    return {
      threshold: 5,
      alertLimit: DEFAULT_ALERT_LIMIT,
      maxOpenTrades: DEFAULT_MAX_OPEN_TRADES,
      notifications: false,
      tradeMode: "demo",
      strategy: "default",
      tradeDirection: "both",
      marginAmount: "",
      marginUnit: "percent",
      tradingEnabled: false
    };
  }
}

function loadAlerts() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECORDS_KEY) || "[]");
    if (!Array.isArray(saved)) {
      throw new TypeError("Saved alerts must be an array.");
    }
    const validAlerts = saved.filter((alert) =>
      alert &&
      typeof alert.id === "string" &&
      typeof alert.symbol === "string" &&
      Number.isFinite(alert.movePercent) &&
      Number.isFinite(alert.close) &&
      Number.isFinite(alert.quoteVolume) &&
      Number.isFinite(alert.closeTime)
    ).map((alert) => ({
      ...alert,
      changePercent: Number.isFinite(alert.changePercent) ? alert.changePercent : null,
      direction: alert.direction === "SHORT" ? "SHORT" : "LONG",
      tradeStatus: typeof alert.tradeStatus === "string" ? alert.tradeStatus : "not-traded"
    }));
    const seenSymbols = new Set();
    return validAlerts
      .sort((a, b) => a.closeTime - b.closeTime)
      .filter((alert) => {
        if (seenSymbols.has(alert.symbol)) return false;
        seenSymbols.add(alert.symbol);
        return true;
      })
      .sort((a, b) => b.closeTime - a.closeTime)
      .slice(0, settings.alertLimit);
  } catch (error) {
    console.warn("Could not read Wickwatch alerts from local storage.", error);
    return [];
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch (error) {
    console.error("Could not save Wickwatch settings.", error);
    showToast("Settings could not be saved in this browser.");
    return false;
  }
}

function saveAlerts() {
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(alerts));
    return true;
  } catch (error) {
    console.error("Could not save Wickwatch alerts.", error);
    showToast("Alert history could not be saved in this browser.");
    return false;
  }
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 3500);
}

function setConnection(state, message = "") {
  elements.connectionIndicator.classList.toggle("connected", state === "connected");
  elements.connectionIndicator.classList.toggle("error", state === "error");
  elements.connectionLabel.textContent = {
    connected: "CONNECTED",
    connecting: "CONNECTING",
    reconnecting: "RECONNECTING",
    error: "CONNECTION ERROR"
  }[state];
  elements.connectionMessage.textContent = message;
  elements.connectionMessage.hidden = !message;
}

function renderSettings() {
  elements.thresholdDisplay.innerHTML = `${settings.threshold.toFixed(1)}<span class="stat-unit">%</span>`;
  elements.thresholdInput.value = String(settings.threshold);
  elements.alertLimitInput.value = String(settings.alertLimit);
  elements.maxOpenTradesInput.value = String(settings.maxOpenTrades);
  elements.notificationsInput.checked = settings.notifications;
  elements.strategyInput.value = settings.strategy;
  elements.tradeDirectionInput.value = settings.tradeDirection;
  elements.marginAmountInput.value = settings.marginAmount === "" ? "" : String(settings.marginAmount);
  elements.marginUnitInput.value = settings.marginUnit;
  elements.tradeModeInput.value = settings.tradeMode;
  renderTradingSession();
}

function renderTradingSession() {
  const active = tradingStatus?.enabled === true;
  const canStart = tradingServiceAvailable && tradingStatus?.configured === true &&
    Number(tradingStatus.marginAmount ?? settings.marginAmount) > 0;
  elements.tradingSessionButton.disabled = tradingSessionBusy || (!active && !canStart);
  elements.tradingSessionButton.textContent = tradingSessionBusy
    ? "PLEASE WAIT..."
    : active
      ? "STOP TRADING"
      : "START TRADING";
  elements.tradingSessionButton.classList.toggle("stop-session", active);
  elements.tradingSessionStatus.textContent = active
    ? `TRADING ACTIVE - ${tradingStatus.mode.toUpperCase()} - ${openPositionCount}/${tradingStatus.maxOpenTrades} OPEN`
    : tradingServiceAvailable
      ? "TRADING STOPPED"
      : "LOCAL TRADING SERVER OFFLINE";
  elements.tradingSessionStatus.classList.toggle("session-active", active);
  elements.tradingSettingsStatus.textContent = active ? "ACTIVE" : "STOPPED";
  elements.tradingSettingsStatus.classList.toggle("session-active", active);
  elements.tradingSettingsState.textContent = active
    ? "Automatic trading is active. Use Stop Trading on Overview to pause new entries."
    : "Trading is stopped. Opening or reloading the dashboard always stops automatic trading.";
}

function formatPrice(value) {
  const digits = value >= 1000 ? 2 : value >= 1 ? 4 : value >= 0.01 ? 6 : 8;
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function formatVolume(value) {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function formatCloseTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatChangePercent(value) {
  if (!Number.isFinite(value)) return "N/A";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function getPnlPercent(alert) {
  const currentPrice = tickerPrices.get(alert.symbol);
  return Number.isFinite(currentPrice)
    ? ((currentPrice - alert.close) / alert.close) * 100 * (alert.direction === "SHORT" ? -1 : 1)
    : null;
}

function addCell(row, className, text) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = text;
  row.append(cell);
  return cell;
}

function renderAlerts() {
  elements.alertsBody.replaceChildren();
  for (const alert of alerts) {
    const row = document.createElement("tr");
    const contractCell = document.createElement("td");
    const contract = document.createElement("a");
    const coinMark = document.createElement("span");
    const symbol = document.createElement("span");
    const quote = document.createElement("span");

    contract.className = "contract-cell";
    contract.href = `https://www.binance.com/en/futures/${encodeURIComponent(alert.symbol)}`;
    contract.target = "_blank";
    contract.rel = "noopener noreferrer";
    contract.setAttribute("aria-label", `Open ${alert.symbol} chart on Binance Futures in a new tab`);
    coinMark.className = "coin-mark";
    coinMark.textContent = alert.symbol.slice(0, 1);
    symbol.className = "contract-name";
    symbol.textContent = alert.symbol.replace(/USDT$/, "");
    quote.className = "contract-quote";
    quote.textContent = "/ USDT";
    contract.append(coinMark, symbol, quote);
    contractCell.append(contract);
    row.append(contractCell);

    const rangeCell = addCell(row, "range-value", `${alert.movePercent.toFixed(2)}%`);
    rangeCell.classList.toggle("negative", alert.movePercent < 0);
    const rangeTrack = document.createElement("span");
    const rangeFill = document.createElement("span");
    rangeTrack.className = "range-track";
    rangeFill.style.width = `${Math.min((Math.abs(alert.movePercent) / Math.max(settings.threshold * 2, 1)) * 100, 100)}%`;
    rangeTrack.append(rangeFill);
    rangeCell.append(rangeTrack);

    const changePercent = tickerChanges.get(alert.symbol) ?? alert.changePercent;
    const changeCell = addCell(row, "change-value", formatChangePercent(changePercent));
    changeCell.classList.toggle("negative", Number.isFinite(changePercent) && changePercent < 0);

    addCell(row, "", formatPrice(alert.close));
    const pnlPercent = getPnlPercent(alert);
    const pnlCell = addCell(row, "pnl-value", formatChangePercent(pnlPercent));
    pnlCell.classList.toggle("negative", Number.isFinite(pnlPercent) && pnlPercent < 0);
    addCell(row, "volume-value", formatVolume(alert.quoteVolume));

    const biasCell = document.createElement("td");
    const bias = document.createElement("span");
    bias.className = "bias-pill";
    const isShortSignal = alert.direction === "SHORT";
    bias.classList.toggle("short-bias", isShortSignal);
    bias.textContent = isShortSignal ? "BEARISH" : "BULLISH";
    biasCell.append(bias);
    row.append(biasCell);

    addCell(row, "closed-time", formatCloseTime(alert.closeTime));
    const closeCell = document.createElement("td");
    closeCell.className = "trade-cell";
    const position = positions.get(alert.symbol);
    if (position) {
      const closeButton = document.createElement("button");
      closeButton.className = "close-trade-button";
      closeButton.type = "button";
      closeButton.textContent = "CLOSE";
      closeButton.disabled = closingSymbols.has(alert.symbol) || !tradingServiceAvailable;
      closeButton.setAttribute("aria-label", `Close ${position.direction.toLowerCase()} position for ${alert.symbol}`);
      closeButton.addEventListener("click", () => closeTrade(alert.symbol));
      closeCell.append(closeButton);
      const positionLabel = document.createElement("span");
      positionLabel.className = "trade-status";
      positionLabel.textContent = `${position.direction} ${formatPrice(position.amount)}`;
      closeCell.append(positionLabel);
    } else {
      const tradeStatus = document.createElement("span");
      tradeStatus.className = `trade-status trade-status-${alert.tradeStatus}`;
      tradeStatus.textContent = getTradeStatusLabel(alert.tradeStatus);
      if (alert.tradeError) tradeStatus.title = alert.tradeError;
      closeCell.append(tradeStatus);
    }
    row.append(closeCell);
    elements.alertsBody.append(row);
  }

  const hasAlerts = alerts.length > 0;
  elements.emptyState.hidden = hasAlerts;
  elements.alertsBody.closest("table").hidden = !hasAlerts;
  elements.alertsCount.innerHTML = `${alerts.length}<span class="stat-unit"> / ${settings.alertLimit}</span>`;
  elements.countPill.textContent = String(alerts.length);
  elements.alertLimitDisplay.textContent = String(settings.alertLimit);
  elements.clearButton.disabled = !hasAlerts;
  elements.exportButton.disabled = !hasAlerts;
}

function handleTickers(tickers) {
  const alertSymbols = new Set(alerts.map((alert) => alert.symbol));
  let shouldRender = false;
  for (const ticker of tickers) {
    if (typeof ticker.s !== "string") continue;
    const currentPrice = Number(ticker.c);
    if (Number.isFinite(currentPrice) && currentPrice > 0) {
      tickerPrices.set(ticker.s, currentPrice);
      if (alertSymbols.has(ticker.s)) shouldRender = true;
    }

    const changePercent = Number(ticker.P);
    if (Number.isFinite(changePercent)) {
      tickerChanges.set(ticker.s, changePercent);
      if (alertSymbols.has(ticker.s)) shouldRender = true;
    }
  }
  if (shouldRender) renderAlerts();
}

function exportAlerts() {
  const headers = ["Contract", "Candle Move", "24h Change", "Close Price", "PnL %", "1m Volume (USDT)", "Bias", "Closed At", "Trade Status"];
  const rows = alerts.map((alert) => [
    alert.symbol,
    `${alert.movePercent.toFixed(2)}%`,
    formatChangePercent(tickerChanges.get(alert.symbol) ?? alert.changePercent),
    String(alert.close),
    formatChangePercent(getPnlPercent(alert)),
    String(alert.quoteVolume),
    alert.direction === "SHORT" ? "Bearish" : "Bullish",
    new Date(alert.closeTime).toISOString(),
    alert.tradeStatus
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `wickwatch-alerts-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function notify(alert) {
  if (!settings.notifications || !("Notification" in window) || Notification.permission !== "granted") return;
  new Notification(`${alert.symbol} candle alert`, {
    body: `${alert.direction === "SHORT" ? "Bearish" : "Bullish"} ${Math.abs(alert.movePercent).toFixed(2)}% move | Close ${formatPrice(alert.close)} | ${formatVolume(alert.quoteVolume)} volume`
  });
}

async function hasRecentClosingPrice(alert) {
  const url = new URL(`${API_BASE}/fapi/v1/klines`);
  url.search = new URLSearchParams({
    symbol: alert.symbol,
    interval: "1m",
    startTime: String(alert.openTime - REVERSE_CALL_LOOKBACK_MINUTES * 60 * 1000),
    endTime: String(alert.openTime - 1),
    limit: String(REVERSE_CALL_LOOKBACK_MINUTES)
  });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Binance candle history request failed (${response.status}).`);
  }
  const candles = await response.json();
  if (!Array.isArray(candles)) {
    throw new Error("Binance returned invalid candle history.");
  }
  return candles.some((candle) => Number(candle[4]) === alert.close);
}

function handleKline(message) {
  const candle = message.k;
  if (!candle || candle.i !== "1m" || candle.x !== true) return;

  const open = Number(candle.o);
  const close = Number(candle.c);
  const high = Number(candle.h);
  const low = Number(candle.l);
  const quoteVolume = Number(candle.q);
  if (![open, close, high, low, quoteVolume].every(Number.isFinite) ||
      open <= 0 || high <= 0 || low <= 0 || high < low || close === open) return;

  const movePercent = ((close - open) / open) * 100;
  if (Math.abs(movePercent) <= settings.threshold) return;
  if (alerts.some((alert) => alert.symbol === candle.s)) return;

  const id = `${candle.s}:${candle.t}`;
  if (seenCandles.has(id)) return;
  seenCandles.add(id);

  const alert = {
    id,
    symbol: candle.s,
    movePercent,
    direction: movePercent > 0 ? "LONG" : "SHORT",
    high,
    low,
    tradeStatus: "not-traded",
    changePercent: tickerChanges.get(candle.s) ?? null,
    openTime: candle.t,
    close,
    quoteVolume,
    closeTime: candle.T
  };
  alerts.unshift(alert);
  alerts = alerts.slice(0, settings.alertLimit);
  saveAlerts();
  renderAlerts();
  elements.lastUpdated.textContent = `Last signal ${formatCloseTime(alert.closeTime)}`;
  notify(alert);
  if (settings.tradingEnabled) void executeSignal(alert);
}

function getTradeStatusLabel(status) {
  return {
    "not-traded": "NOT TRADED",
    submitting: "SENDING ORDER",
    placed: "ORDER PLACED",
    "limit-order-placed": "LIMIT ORDER PLACED",
    failed: "ORDER FAILED",
    "position-exists": "POSITION ALREADY OPEN",
    "order-exists": "OPEN ORDER ALREADY EXISTS",
    "limit-reached": "OPEN TRADE LIMIT REACHED",
    "direction-disabled": "DIRECTION DISABLED",
    "recent-close-price": "RECENT CLOSE PRICE",
    "history-check-failed": "HISTORY CHECK FAILED"
  }[status] || String(status).replace(/-/g, " ").toUpperCase();
}

async function requestTradingApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 405 && path.startsWith("/api/trading/")) {
      throw new Error(
        "This page is being served by a static or outdated server. Stop that server, run `npm start` in the Wickwatch folder, and open http://127.0.0.1:8000."
      );
    }
    throw new Error(result.error || `Local trading service request failed (${response.status}).`);
  }
  return result;
}

function renderCredentialStatus() {
  if (!tradingServiceAvailable) {
    elements.credentialStatus.textContent = "Local trading service unavailable. Start Wickwatch with node server.js.";
    elements.removeCredentialsButton.hidden = true;
    return;
  }
  if (!tradingStatus?.configured) {
    elements.credentialStatus.textContent = "No API credentials loaded. Enter a key and secret to configure trading.";
    elements.removeCredentialsButton.hidden = true;
    return;
  }
  const environment = tradingStatus.mode === "live" ? "Live" : "Demo";
  elements.credentialStatus.textContent = `${environment} credentials loaded (${tradingStatus.apiKeyHint}).`;
  elements.removeCredentialsButton.hidden = false;
}

async function refreshPositions() {
  if (!tradingStatus?.configured) {
    positions = new Map();
    openPositionCount = 0;
    renderAlerts();
    renderTradingSession();
    return;
  }
  const result = await requestTradingApi("/api/trading/positions");
  openPositionCount = result.positions.length;
  positions = new Map(result.positions.map((position) => [position.symbol, position]));
  renderAlerts();
  renderTradingSession();
}

async function loadTradingStatus() {
  try {
    await requestTradingApi("/api/trading/stop", { method: "POST" });
    tradingStatus = await requestTradingApi("/api/trading/status");
    tradingServiceAvailable = true;
    settings.tradingEnabled = false;
    settings.tradeMode = tradingStatus.mode;
    settings.strategy = tradingStatus.strategy;
    settings.tradeDirection = tradingStatus.direction;
    settings.marginAmount = tradingStatus.marginAmount ?? settings.marginAmount;
    settings.marginUnit = tradingStatus.marginUnit;
    settings.maxOpenTrades = tradingStatus.maxOpenTrades;
    saveSettings();
    renderSettings();
    renderCredentialStatus();
    try {
      await refreshPositions();
    } catch (error) {
      console.error("Could not load Binance positions.", error);
      elements.credentialStatus.textContent = `Position refresh failed: ${error.message}`;
    }
    if (tradingStatus.configured) {
      window.setInterval(() => {
        refreshPositions().catch((error) => {
          console.error("Could not refresh Binance positions.", error);
          elements.credentialStatus.textContent = `Position refresh failed: ${error.message}`;
        });
      }, 15000);
    }
  } catch (error) {
    tradingServiceAvailable = false;
    settings.tradingEnabled = false;
    console.error("Could not connect to the local trading service.", error);
    renderCredentialStatus();
    renderTradingSession();
  }
}

async function toggleTradingSession() {
  if (!tradingServiceAvailable || tradingSessionBusy) return;
  const isActive = tradingStatus?.enabled === true;
  if (isActive) {
    tradingSessionBusy = true;
    tradingStatus.enabled = false;
    settings.tradingEnabled = false;
    renderTradingSession();
    try {
      tradingStatus = await requestTradingApi("/api/trading/stop", { method: "POST" });
      settings.tradingEnabled = false;
      saveSettings();
      showToast("Trading stopped. Open positions remain open; close them individually.");
    } catch (error) {
      console.error("Could not stop Binance automatic trading.", error);
      showToast(`Could not stop trading: ${error.message}`);
      try {
        tradingStatus = await requestTradingApi("/api/trading/status");
        settings.tradingEnabled = tradingStatus.enabled;
      } catch (statusError) {
        tradingServiceAvailable = false;
        console.error("Could not refresh trading session status.", statusError);
      }
    } finally {
      tradingSessionBusy = false;
      renderTradingSession();
    }
    return;
  }

  if (!tradingStatus?.configured) {
    showToast("Save Binance API credentials in Settings before starting trading.");
    return;
  }
  if (Number(tradingStatus.marginAmount ?? settings.marginAmount) <= 0) {
    showToast("Set a positive margin per trade in Settings before starting trading.");
    return;
  }
  if (tradingStatus.mode === "live" &&
      !window.confirm("Live trading places real Binance Futures orders using real funds. Start live trading?")) {
    return;
  }

  tradingSessionBusy = true;
  renderTradingSession();
  try {
    tradingStatus = await requestTradingApi("/api/trading/start", { method: "POST" });
    settings.tradingEnabled = tradingStatus.enabled;
    settings.tradeMode = tradingStatus.mode;
    settings.strategy = tradingStatus.strategy;
    settings.tradeDirection = tradingStatus.direction;
    settings.marginAmount = tradingStatus.marginAmount ?? settings.marginAmount;
    settings.marginUnit = tradingStatus.marginUnit;
    saveSettings();
    showToast(`Trading started in ${tradingStatus.mode.toUpperCase()} mode. New qualifying candles can place orders.`);
  } catch (error) {
    console.error("Could not start Binance automatic trading.", error);
    showToast(`Trading did not start: ${error.message}`);
    try {
      tradingStatus = await requestTradingApi("/api/trading/status");
      settings.tradingEnabled = tradingStatus.enabled;
    } catch (statusError) {
      tradingServiceAvailable = false;
      console.error("Could not refresh trading session status.", statusError);
    }
  } finally {
    tradingSessionBusy = false;
    renderSettings();
    renderCredentialStatus();
  }
}

async function executeSignal(alert) {
  if (!settings.tradingEnabled) return;
  const isReverseStrategy = settings.strategy === "reverse-call" || settings.strategy === "reverse-call-limit";
  const tradeDirection = isReverseStrategy
    ? (alert.direction === "LONG" ? "SHORT" : "LONG")
    : alert.direction;
  if (settings.tradeDirection !== "both" && settings.tradeDirection.toUpperCase() !== tradeDirection) {
    alert.tradeStatus = "direction-disabled";
    saveAlerts();
    renderAlerts();
    return;
  }
  if (settings.strategy === "reverse-call") {
    try {
      if (await hasRecentClosingPrice(alert)) {
        alert.tradeStatus = "recent-close-price";
        saveAlerts();
        renderAlerts();
        showToast(`Reverse Call skipped for ${alert.symbol}: this close price appeared in the previous 120 minutes.`);
        return;
      }
    } catch (error) {
      alert.tradeStatus = "history-check-failed";
      alert.tradeError = error.message;
      saveAlerts();
      renderAlerts();
      console.error(`Could not verify recent candle history for ${alert.symbol}.`, error);
      showToast(`Reverse Call skipped for ${alert.symbol}: recent price history could not be verified.`);
      return;
    }
  }
  alert.tradeStatus = "submitting";
  saveAlerts();
  renderAlerts();
  try {
    const result = await requestTradingApi("/api/trading/signal", {
      method: "POST",
      body: JSON.stringify({
        symbol: alert.symbol,
        direction: alert.direction,
        signalId: alert.id,
        candleHigh: alert.high,
        candleLow: alert.low
      })
    });
    alert.tradeStatus = result.status === "placed"
      ? result.orderType === "LIMIT"
        ? "limit-order-placed"
        : "placed"
      : result.status === "position_exists"
        ? "position-exists"
        : result.status === "order_exists"
          ? "order-exists"
        : result.status === "limit_reached"
          ? "limit-reached"
          : result.status === "recent_close_price"
            ? "recent-close-price"
            : "direction-disabled";
    if (result.status === "placed") {
      showToast(result.orderType === "LIMIT"
        ? `${result.direction} limit order placed for ${alert.symbol} at ${formatPrice(result.price)}; stop-loss at ${formatPrice(result.stopLossPrice)} (~-50% PnL at 5x).`
        : `${result.direction || tradeDirection} market order placed for ${alert.symbol} at 5x.`);
    } else if (result.status === "limit_reached") {
      showToast(`Trade limit reached (${result.openTrades}/${result.limit}). No order was placed for ${alert.symbol}.`);
    } else if (result.status === "order_exists") {
      showToast(`Reverse call with limit skipped for ${alert.symbol}: an open order already exists.`);
    } else if (result.status === "recent_close_price") {
      showToast(`Reverse Call skipped for ${alert.symbol}: the current price appeared in the previous 120 minutes.`);
    }
    saveAlerts();
    await refreshPositions();
  } catch (error) {
    alert.tradeStatus = "failed";
    alert.tradeError = error.message;
    console.error(`Could not place the ${tradeDirection} order for ${alert.symbol}.`, error);
    showToast(`Trade failed for ${alert.symbol}: ${error.message}`);
    saveAlerts();
    renderAlerts();
  }
}

async function closeTrade(symbol) {
  if (!window.confirm(`Send a market order to close the open ${symbol} position?`)) return;
  closingSymbols.add(symbol);
  renderAlerts();
  try {
    const result = await requestTradingApi("/api/trading/close", {
      method: "POST",
      body: JSON.stringify({ symbol })
    });
    showToast(result.cleanupWarning ||
      (result.status === "closed"
        ? `Close order sent for ${symbol}.`
        : `No open ${symbol} position was found.`));
    await refreshPositions();
  } catch (error) {
    console.error(`Could not close the ${symbol} position.`, error);
    showToast(`Could not close ${symbol}: ${error.message}`);
  } finally {
    closingSymbols.delete(symbol);
    renderAlerts();
  }
}

function subscribeToMarkets() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const streams = [...markets.map((symbol) => `${symbol.toLowerCase()}@kline_1m`), "!ticker@arr"];
  let offset = 0;
  let requestId = 1;

  window.clearInterval(subscriptionTimer);
  subscriptionIdsAwaitingAck = new Set();
  allMarketsSubmitted = false;
  subscriptionTimer = window.setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) {
      window.clearInterval(subscriptionTimer);
      return;
    }
    if (offset >= streams.length) {
      window.clearInterval(subscriptionTimer);
      allMarketsSubmitted = true;
      if (subscriptionIdsAwaitingAck.size === 0) {
        setConnection("connected");
        elements.lastUpdated.textContent = `Watching ${markets.length.toLocaleString("en-US")} markets`;
      }
      return;
    }
    const id = requestId++;
    subscriptionIdsAwaitingAck.add(id);
    socket.send(JSON.stringify({
      method: "SUBSCRIBE",
      params: streams.slice(offset, offset + SUBSCRIPTION_BATCH_SIZE),
      id
    }));
    offset += SUBSCRIPTION_BATCH_SIZE;
  }, SUBSCRIPTION_INTERVAL_MS);
}

function connectSocket() {
  window.clearTimeout(reconnectTimer);
  setConnection("connecting");

  try {
    socket = new WebSocket(STREAM_BASE);
  } catch (error) {
    console.error("Could not open Binance Futures WebSocket.", error);
    setConnection("error", "Could not open the Binance Futures stream. Retrying shortly.");
    reconnectTimer = window.setTimeout(connectSocket, 5000);
    return;
  }

  socket.addEventListener("open", () => {
    setConnection("connecting", "Connected to Binance. Subscribing to markets...");
    elements.lastUpdated.textContent = `Subscribing to ${markets.length.toLocaleString("en-US")} markets`;
    subscribeToMarkets();
  });

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      const events = Array.isArray(payload)
        ? payload
        : Array.isArray(payload.data)
          ? payload.data
          : [payload.data || payload];
      const tickerBatch = events.filter((data) => data.e === "24hrTicker");
      if (tickerBatch.length > 0) handleTickers(tickerBatch);

      for (const data of events) {
        if (data.e === "kline") {
          handleKline(data);
        }
      }
      if (payload.error || (typeof payload.code === "number" && payload.code !== 0)) {
        console.error("Binance Futures stream subscription error.", payload.error || payload);
        setConnection("error", "Binance rejected a market subscription. Reconnecting automatically.");
        socket.close();
      } else if (
        payload.result === null &&
        subscriptionIdsAwaitingAck.delete(payload.id) &&
        allMarketsSubmitted &&
        subscriptionIdsAwaitingAck.size === 0
      ) {
        setConnection("connected");
        elements.lastUpdated.textContent = `Watching ${markets.length.toLocaleString("en-US")} markets`;
      }
    } catch (error) {
      console.error("Could not read a Binance Futures stream message.", error);
    }
  });

  socket.addEventListener("error", () => {
    setConnection("error", "The Binance Futures stream encountered an error. Reconnecting automatically.");
  });

  socket.addEventListener("close", () => {
    window.clearInterval(subscriptionTimer);
    subscriptionIdsAwaitingAck.clear();
    allMarketsSubmitted = false;
    setConnection("reconnecting", "The market stream disconnected. Reconnecting automatically.");
    reconnectTimer = window.setTimeout(connectSocket, 3000);
  });
}

async function loadMarketsAndConnect() {
  setConnection("connecting");
  try {
    const response = await fetch(`${API_BASE}/fapi/v1/exchangeInfo`);
    if (!response.ok) {
      throw new Error(`Binance exchange information request failed (${response.status}).`);
    }
    const exchangeInfo = await response.json();
    markets = exchangeInfo.symbols
      .filter((market) =>
        market.status === "TRADING" &&
        market.contractType === "PERPETUAL" &&
        market.quoteAsset === "USDT"
      )
      .map((market) => market.symbol);

    if (markets.length === 0) {
      throw new Error("Binance returned no active USDT perpetual contracts.");
    }
    elements.contractsCount.textContent = markets.length.toLocaleString("en-US");
    connectSocket();
  } catch (error) {
    console.error("Could not load Binance Futures markets.", error);
    const message = error instanceof Error ? error.message : "Could not load Binance Futures markets.";
    setConnection("error", `${message} Retrying in 10 seconds.`);
    reconnectTimer = window.setTimeout(loadMarketsAndConnect, 10000);
  }
}

function switchPage(pageName) {
  const isSettings = pageName === "settings";
  elements.overviewPage.hidden = isSettings;
  elements.settingsPage.hidden = !isSettings;
  elements.overviewPage.classList.toggle("active", !isSettings);
  elements.settingsPage.classList.toggle("active", isSettings);
  elements.breadcrumb.textContent = isSettings ? "Settings" : "Overview";
  document.querySelectorAll("[data-page-link]").forEach((link) => {
    link.classList.toggle("active", link.dataset.pageLink === pageName && link.classList.contains("nav-link"));
  });
}

document.querySelectorAll("[data-page-link]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    switchPage(link.dataset.pageLink);
  });
});

elements.clearButton.addEventListener("click", () => {
  if (alerts.length === 0) return;
  alerts = [];
  seenCandles.clear();
  saveAlerts();
  renderAlerts();
  elements.lastUpdated.textContent = markets.length ? "Watching for new alerts" : "Waiting for market data";
});

elements.exportButton.addEventListener("click", () => {
  try {
    exportAlerts();
  } catch (error) {
    console.error("Could not export Wickwatch alerts.", error);
    showToast("Alert history could not be exported.");
  }
});

elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const threshold = Number(elements.thresholdInput.value);
  if (!Number.isFinite(threshold) || threshold < 0.1 || threshold > 100) {
    elements.thresholdInput.setCustomValidity("Enter a threshold between 0.1 and 100.");
    elements.thresholdInput.reportValidity();
    return;
  }

  const alertLimit = Number(elements.alertLimitInput.value);
  if (!Number.isInteger(alertLimit) || alertLimit < 1 || alertLimit > MAX_ALERT_LIMIT) {
    elements.alertLimitInput.setCustomValidity("Enter a whole number between 1 and 500.");
    elements.alertLimitInput.reportValidity();
    return;
  }

  const maxOpenTrades = Number(elements.maxOpenTradesInput.value);
  if (!Number.isInteger(maxOpenTrades) || maxOpenTrades < 1 || maxOpenTrades > MAX_OPEN_TRADES) {
    elements.maxOpenTradesInput.setCustomValidity("Enter a whole number between 1 and 100.");
    elements.maxOpenTradesInput.reportValidity();
    return;
  }

  const marginText = elements.marginAmountInput.value.trim();
  const marginAmount = marginText ? Number(marginText) : null;
  const marginUnit = elements.marginUnitInput.value;
  if (marginAmount !== null &&
      (!Number.isFinite(marginAmount) || marginAmount <= 0 ||
        (marginUnit === "percent" && marginAmount > 100))) {
    elements.marginAmountInput.setCustomValidity(
      marginUnit === "percent"
        ? "Enter a margin above 0 and no greater than 100%."
        : "Enter a positive USDT margin amount."
    );
    elements.marginAmountInput.reportValidity();
    return;
  }
  const apiKey = elements.apiKeyInput.value.trim();
  const apiSecret = elements.apiSecretInput.value.trim();
  if (Boolean(apiKey) !== Boolean(apiSecret)) {
    const invalidInput = apiKey ? elements.apiSecretInput : elements.apiKeyInput;
    invalidInput.setCustomValidity("Enter both API credentials, or leave both blank.");
    invalidInput.reportValidity();
    return;
  }
  const tradeMode = elements.tradeModeInput.value;
  const liveNeedsConfirmation = tradeMode === "live" && tradingStatus?.mode !== "live";
  if (liveNeedsConfirmation &&
      !window.confirm("Live trading places real Binance Futures orders using real funds. Continue with Live mode?")) {
    return;
  }

  const wantsNotifications = elements.notificationsInput.checked;
  let notifications = false;
  if (wantsNotifications && "Notification" in window) {
    try {
      const permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
      notifications = permission === "granted";
      if (!notifications) {
        elements.notificationsInput.checked = false;
        showToast("Browser notifications were not enabled. Check your browser permissions.");
      }
    } catch (error) {
      console.error("Could not request browser notification permission.", error);
      elements.notificationsInput.checked = false;
      showToast("Browser notification permission could not be requested.");
    }
  } else if (wantsNotifications) {
    elements.notificationsInput.checked = false;
    showToast("This browser does not support desktop notifications.");
  }

  settings = {
    threshold,
    alertLimit,
    maxOpenTrades,
    notifications,
    tradeMode,
    strategy: elements.strategyInput.value,
    tradeDirection: elements.tradeDirectionInput.value,
    marginAmount: marginAmount ?? "",
    marginUnit,
    tradingEnabled: false
  };
  if (saveSettings()) {
    alerts = alerts.slice(0, settings.alertLimit);
    saveAlerts();
    renderSettings();
    renderAlerts();
    try {
      const tradingPayload = {
        mode: tradeMode,
        strategy: settings.strategy,
        direction: settings.tradeDirection,
        marginAmount,
        marginUnit,
        maxOpenTrades,
        liveConfirmed: tradeMode === "live" && (liveNeedsConfirmation || tradingStatus?.mode === "live")
      };
      if (apiKey && apiSecret) {
        tradingPayload.apiKey = apiKey;
        tradingPayload.apiSecret = apiSecret;
      }
      tradingStatus = await requestTradingApi("/api/trading/config", {
        method: "PUT",
        body: JSON.stringify(tradingPayload)
      });
      tradingServiceAvailable = true;
      settings.tradingEnabled = false;
      elements.apiKeyInput.value = "";
      elements.apiSecretInput.value = "";
      saveSettings();
      renderSettings();
      renderCredentialStatus();
      try {
        await refreshPositions();
      } catch (error) {
        console.error("Could not refresh Binance positions after saving settings.", error);
        elements.credentialStatus.textContent = `Position refresh failed: ${error.message}`;
      }
      elements.settingsFeedback.textContent = "Settings saved";
    } catch (error) {
      settings.tradingEnabled = false;
      saveSettings();
      console.error("Could not save Binance trading settings.", error);
      elements.settingsFeedback.textContent = `Scanner settings saved; trading settings were not applied: ${error.message}`;
      showToast(`Trading settings were not saved: ${error.message}`);
      try {
        tradingStatus = await requestTradingApi("/api/trading/status");
        tradingServiceAvailable = true;
        settings.tradingEnabled = false;
        settings.tradeMode = tradingStatus.mode;
        settings.strategy = tradingStatus.strategy;
        settings.tradeDirection = tradingStatus.direction;
        settings.marginAmount = tradingStatus.marginAmount ?? settings.marginAmount;
        settings.marginUnit = tradingStatus.marginUnit;
        settings.maxOpenTrades = tradingStatus.maxOpenTrades;
        saveSettings();
      } catch (statusError) {
        tradingServiceAvailable = false;
        console.error("Could not refresh local trading service status.", statusError);
      }
      renderSettings();
      renderCredentialStatus();
    }
    window.setTimeout(() => { elements.settingsFeedback.textContent = ""; }, 2500);
  }
});

elements.thresholdInput.addEventListener("input", () => {
  elements.thresholdInput.setCustomValidity("");
  elements.settingsFeedback.textContent = "";
});

elements.alertLimitInput.addEventListener("input", () => {
  elements.alertLimitInput.setCustomValidity("");
  elements.settingsFeedback.textContent = "";
});

elements.maxOpenTradesInput.addEventListener("input", () => {
  elements.maxOpenTradesInput.setCustomValidity("");
  elements.settingsFeedback.textContent = "";
});

elements.notificationsInput.addEventListener("change", () => {
  elements.settingsFeedback.textContent = "";
});

elements.marginAmountInput.addEventListener("input", () => {
  elements.marginAmountInput.setCustomValidity("");
  elements.settingsFeedback.textContent = "";
});

for (const input of [
  elements.strategyInput,
  elements.tradeDirectionInput,
  elements.marginUnitInput,
  elements.tradeModeInput,
  elements.apiKeyInput,
  elements.apiSecretInput
]) {
  input.addEventListener("input", () => {
    input.setCustomValidity("");
    elements.settingsFeedback.textContent = "";
  });
  input.addEventListener("change", () => { elements.settingsFeedback.textContent = ""; });
}

elements.removeCredentialsButton.addEventListener("click", async () => {
  if (!window.confirm("Remove the API credentials from this local server? This does not close open Binance positions.")) {
    return;
  }
  try {
    tradingStatus = await requestTradingApi("/api/trading/credentials", { method: "DELETE" });
    settings.tradingEnabled = false;
    positions = new Map();
    saveSettings();
    renderSettings();
    renderCredentialStatus();
    renderAlerts();
    showToast("API credentials removed. Any open positions remain on Binance.");
  } catch (error) {
    console.error("Could not remove Binance API credentials.", error);
    showToast(`Could not remove credentials: ${error.message}`);
  }
});

renderSettings();
renderAlerts();
elements.tradingSessionButton.addEventListener("click", () => { void toggleTradingSession(); });
void loadTradingStatus();
loadMarketsAndConnect();
