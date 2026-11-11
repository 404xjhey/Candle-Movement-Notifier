const API_BASE = "https://fapi.binance.com";
const STREAM_BASE = "wss://fstream.binance.com/market/ws";
const SETTINGS_KEY = "wickwatch-settings-v1";
const RECORDS_KEY = "wickwatch-alerts-v2";
const DEFAULT_ALERT_LIMIT = 20;
const MAX_ALERT_LIMIT = 500;
const DEFAULT_MAX_OPEN_TRADES = 15;
const MAX_OPEN_TRADES = 100;
const DEFAULT_STOP_LOSS_ROI = -10;
const DEFAULT_CHANGE_MIN = -10;
const DEFAULT_CHANGE_MAX = 10;
const SUBSCRIPTION_BATCH_SIZE = 100;
const SUBSCRIPTION_INTERVAL_MS = 250;
const REVERSE_CALL_LOOKBACK_MINUTES = 120;
const TIMEFRAMES = ["1m", "3m", "5m", "15m", "1h", "4h", "8h", "1d"];

const elements = {
  connectionIndicator: document.querySelector("#connection-indicator"),
  connectionLabel: document.querySelector("#connection-label"),
  connectionMessage: document.querySelector("#connection-message"),
  contractsCount: document.querySelector("#contracts-count"),
  alertsCount: document.querySelector("#alerts-count"),
  alertLimitDisplay: document.querySelector("#alert-limit-display"),
  thresholdDisplay: document.querySelector("#threshold-display"),
  moveMetricLabel: document.querySelector("#move-metric-label"),
  alertsSubtitle: document.querySelector("#alerts-subtitle"),
  scannerDescription: document.querySelector("#scanner-description"),
  emptyDescription: document.querySelector("#empty-description"),
  marketCoverageDescription: document.querySelector("#market-coverage-description"),
  thresholdDescription: document.querySelector("#threshold-description"),
  thresholdNote: document.querySelector("#threshold-note"),
  strategyDescription: document.querySelector("#strategy-description"),
  timeframeInput: document.querySelector("#timeframe-input"),
  timeframeBadgeLabel: document.querySelector("#timeframe-badge-label"),
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
  changeMinInput: document.querySelector("#change-min-input"),
  changeMaxInput: document.querySelector("#change-max-input"),
  maxOpenTradesInput: document.querySelector("#max-open-trades-input"),
  notificationsInput: document.querySelector("#notifications-input"),
  strategyInput: document.querySelector("#strategy-input"),
  tradeDirectionInput: document.querySelector("#trade-direction-input"),
  marginAmountInput: document.querySelector("#margin-amount-input"),
  marginUnitInput: document.querySelector("#margin-unit-input"),
  takeProfitRoiInput: document.querySelector("#take-profit-roi-input"),
  stopLossRoiInput: document.querySelector("#stop-loss-roi-input"),
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
const jMinuteCandidates = new Map();
let socket;
let reconnectTimer;
let subscriptionTimer;
let positionRefreshTimer;
let toastTimer;
let subscriptionIdsAwaitingAck = new Set();
let allMarketsSubmitted = false;
let settingsRevision = 0;
const seenCandles = new Set(alerts.map((alert) => alert.id));

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const threshold = Number(saved.threshold);
    const alertLimit = Number(saved.alertLimit);
    const maxOpenTrades = Number(saved.maxOpenTrades);
    const changeMin = Number(saved.changeMin);
    const changeMax = Number(saved.changeMax);
    return {
      timeframe: TIMEFRAMES.includes(saved.timeframe) ? saved.timeframe : "1m",
      threshold: Number.isFinite(threshold) && threshold >= 0.1 && threshold <= 100 ? threshold : 5,
      alertLimit: Number.isInteger(alertLimit) && alertLimit >= 1 && alertLimit <= MAX_ALERT_LIMIT
        ? alertLimit
        : DEFAULT_ALERT_LIMIT,
      maxOpenTrades: Number.isInteger(maxOpenTrades) && maxOpenTrades >= 1 && maxOpenTrades <= MAX_OPEN_TRADES
        ? maxOpenTrades
        : DEFAULT_MAX_OPEN_TRADES,
      changeMin: Number.isFinite(changeMin) && changeMin >= -100 && changeMin <= 100
        ? changeMin
        : DEFAULT_CHANGE_MIN,
      changeMax: Number.isFinite(changeMax) && changeMax >= -100 && changeMax <= 100
        ? changeMax
        : DEFAULT_CHANGE_MAX,
      notifications: saved.notifications === true,
      tradeMode: saved.tradeMode === "live" ? "live" : "demo",
      strategy: ["default", "waley", "reverse-call", "reverse-call-limit", "j-minute-rule"].includes(saved.strategy)
        ? saved.strategy
        : "default",
      tradeDirection: ["both", "long", "short"].includes(saved.tradeDirection) ? saved.tradeDirection : "both",
      marginAmount: Number.isFinite(Number(saved.marginAmount)) && Number(saved.marginAmount) > 0
        ? Number(saved.marginAmount)
        : "",
      marginUnit: saved.marginUnit === "usdt" ? "usdt" : "percent",
      takeProfitRoi: loadRoiSetting(saved.takeProfitRoi, "positive"),
      stopLossRoi: saved.stopLossRoi === undefined
        ? DEFAULT_STOP_LOSS_ROI
        : loadRoiSetting(saved.stopLossRoi, "negative"),
      tradingEnabled: false
    };
  } catch (error) {
    console.warn("Could not read Wickwatch settings from local storage.", error);
    return {
      timeframe: "1m",
      threshold: 5,
      alertLimit: DEFAULT_ALERT_LIMIT,
      maxOpenTrades: DEFAULT_MAX_OPEN_TRADES,
      changeMin: DEFAULT_CHANGE_MIN,
      changeMax: DEFAULT_CHANGE_MAX,
      notifications: false,
      tradeMode: "demo",
      strategy: "default",
      tradeDirection: "both",
      marginAmount: "",
      marginUnit: "percent",
      takeProfitRoi: "",
      stopLossRoi: DEFAULT_STOP_LOSS_ROI,
      tradingEnabled: false
    };
  }
}

function loadRoiSetting(value, sign) {
  const text = value == null ? "" : String(value).trim();
  if (!text) return "";
  const roi = Number(text);
  if (!Number.isFinite(roi) || (sign === "positive" ? roi <= 0 : roi >= 0)) return "";
  return roi;
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
      timeframe: TIMEFRAMES.includes(alert.timeframe) ? alert.timeframe : "1m",
      takerBuyQuoteVolume: Number.isFinite(alert.takerBuyQuoteVolume) &&
        alert.takerBuyQuoteVolume >= 0 && alert.takerBuyQuoteVolume <= alert.quoteVolume
        ? alert.takerBuyQuoteVolume
        : null,
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
  const timeframeLabel = getTimeframeLabel(settings.timeframe);
  const isWaley = settings.strategy === "waley";
  const isJMinuteRule = settings.strategy === "j-minute-rule";
  elements.thresholdDisplay.innerHTML = `${settings.threshold.toFixed(1)}<span class="stat-unit">%</span>`;
  elements.timeframeInput.value = settings.timeframe;
  elements.timeframeBadgeLabel.textContent = `${settings.timeframe.toUpperCase()} TIMEFRAME`;
  elements.scannerDescription.textContent = isJMinuteRule
    ? `J-minute-Rule waits for a confirming ${timeframeLabel} candle and filters by EMA 200 and 24-hour change.`
    : isWaley
      ? `Live ${timeframeLabel} candle moves across Binance USD-M perpetuals.`
      : `Large ${timeframeLabel} moves across Binance USD-M perpetuals.`;
  elements.emptyDescription.textContent = isJMinuteRule
    ? `A qualifying move must be followed by a completed candle and pass the EMA 200 and 24-hour change filters.`
    : isWaley
      ? `Alerts will appear when a ${timeframeLabel} candle moves beyond your threshold, even before it closes.`
      : `Alerts will appear here when a ${timeframeLabel} candle moves up or down beyond your threshold.`;
  elements.marketCoverageDescription.textContent =
    `All active Binance USD-M USDT perpetual contracts, streamed on the ${timeframeLabel} interval. Scanner preferences and alert history are saved in this browser; trading requires the local server.`;
  elements.moveMetricLabel.textContent = isWaley ? "Low/high-to-current move" : "Open-to-close move";
  elements.alertsSubtitle.textContent = isJMinuteRule
    ? "Minimum-move candles shown only after the next candle and filters qualify"
    : isWaley
      ? "Live candles that meet your low/high-to-current move threshold"
      : "Closed candles that meet your open-to-close move threshold";
  elements.thresholdDescription.textContent = isWaley
    ? "For a green candle, measure the rise from its low to its current price; for a red candle, measure the drop from its high."
    : "Measured from the candle open to its close. Upward and downward moves can trigger alerts.";
  elements.thresholdNote.textContent = isJMinuteRule
    ? "J-minute-Rule waits for the next selected-interval candle to close. Long entry/stop use the next candle low and trigger candle low; Short uses the two highs."
    : isWaley
      ? "Waley signals as soon as the selected candle's low-to-current rise or high-to-current drop exceeds the threshold; the candle need not be complete."
      : "A 5% threshold can trigger on a candle closing at least 5% above or below its open.";
  elements.strategyDescription.textContent = isJMinuteRule
    ? "J-minute-Rule places a limit entry at the next candle's low for Long or high for Short, with a stop at the qualifying candle's low/high. Long requires price above EMA 200; Short requires price below EMA 200. Only the configured 24-hour change range qualifies."
    : "Default and Waley trades require buy-initiated volume to exceed sell-initiated volume for a Long, or sell-initiated volume to exceed buy-initiated volume for a Short. Reverse Call strategies trade the opposite direction without this volume filter.";
  elements.thresholdInput.value = String(settings.threshold);
  elements.alertLimitInput.value = String(settings.alertLimit);
  elements.maxOpenTradesInput.value = String(settings.maxOpenTrades);
  elements.changeMinInput.value = String(settings.changeMin);
  elements.changeMaxInput.value = String(settings.changeMax);
  elements.notificationsInput.checked = settings.notifications;
  elements.strategyInput.value = settings.strategy;
  elements.tradeDirectionInput.value = settings.tradeDirection;
  elements.marginAmountInput.value = settings.marginAmount === "" ? "" : String(settings.marginAmount);
  elements.marginUnitInput.value = settings.marginUnit;
  elements.takeProfitRoiInput.value = settings.takeProfitRoi === "" ? "" : String(settings.takeProfitRoi);
  elements.stopLossRoiInput.value = settings.stopLossRoi === "" ? "" : String(settings.stopLossRoi);
  elements.tradeModeInput.value = settings.tradeMode;
  toggleDefaultRoiSettings();
  renderTradingSession();
}

function toggleDefaultRoiSettings() {
  const isDefault = ["default", "waley"].includes(elements.strategyInput.value);
  document.querySelectorAll(".default-roi-setting").forEach((setting) => {
    setting.hidden = !isDefault;
  });
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

function getTimeframeLabel(timeframe) {
  return ({
    "1m": "1-minute",
    "3m": "3-minute",
    "5m": "5-minute",
    "15m": "15-minute",
    "1h": "1-hour",
    "4h": "4-hour",
    "8h": "8-hour",
    "1d": "1-day"
  })[timeframe] || "1-minute";
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

    addCell(row, "timeframe-value", alert.timeframe || "1m");
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
    const sellQuoteVolume = alert.quoteVolume > 0 && Number.isFinite(alert.takerBuyQuoteVolume)
      ? Math.max(alert.quoteVolume - alert.takerBuyQuoteVolume, 0)
      : null;
    const volumeCell = addCell(row, "volume-value", Number.isFinite(sellQuoteVolume)
      ? `Buy ${((alert.takerBuyQuoteVolume / alert.quoteVolume) * 100).toFixed(0)}% / Sell ${((sellQuoteVolume / alert.quoteVolume) * 100).toFixed(0)}%`
      : "N/A");
    if (Number.isFinite(sellQuoteVolume)) {
      volumeCell.title =
        `Buy ${formatVolume(alert.takerBuyQuoteVolume)} / Sell ${formatVolume(sellQuoteVolume)} ` +
        `(total ${formatVolume(alert.quoteVolume)})`;
    }

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
  const headers = ["Contract", "Timeframe", "Candle Move", "24h Change", "Close Price", "PnL %", "Candle Volume (USDT)", "Buy Volume (USDT)", "Sell Volume (USDT)", "Bias", "Alert Time", "Trade Status"];
  const rows = alerts.map((alert) => [
    alert.symbol,
    alert.timeframe || "1m",
    `${alert.movePercent.toFixed(2)}%`,
    formatChangePercent(tickerChanges.get(alert.symbol) ?? alert.changePercent),
    String(alert.close),
    formatChangePercent(getPnlPercent(alert)),
    String(alert.quoteVolume),
    alert.quoteVolume > 0 && Number.isFinite(alert.takerBuyQuoteVolume) ? String(alert.takerBuyQuoteVolume) : "",
    alert.quoteVolume > 0 && Number.isFinite(alert.takerBuyQuoteVolume)
      ? String(alert.quoteVolume - alert.takerBuyQuoteVolume)
      : "",
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
  new Notification(`${alert.symbol} ${alert.timeframe} candle alert`, {
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
  const isWaley = settings.strategy === "waley";
  const isJMinuteRule = settings.strategy === "j-minute-rule";
  if (!candle || candle.i !== settings.timeframe ||
      (!isWaley && candle.x !== true) || (isJMinuteRule && candle.x !== true)) return;

  const open = Number(candle.o);
  const close = Number(candle.c);
  const high = Number(candle.h);
  const low = Number(candle.l);
  const quoteVolume = Number(candle.q);
  const takerBuyQuoteVolume = Number(candle.Q);
  if (![open, close, high, low, quoteVolume, takerBuyQuoteVolume].every(Number.isFinite) ||
      open <= 0 || high <= 0 || low <= 0 || high < low || close === open ||
      quoteVolume <= 0 || takerBuyQuoteVolume < 0 || takerBuyQuoteVolume > quoteVolume) return;

  const movePercent = window.calculateCandleMovePercent({ open, close, high, low }, settings.strategy);
  const id = `${candle.s}:${settings.timeframe}:${candle.t}`;
  if (isJMinuteRule) {
    const pending = jMinuteCandidates.get(candle.s);
    if (pending) {
      jMinuteCandidates.delete(candle.s);
      if (candle.t === pending.openTime + getTimeframeMilliseconds(settings.timeframe)) {
        void qualifyJMinuteCandidate(pending, {
          openTime: candle.t,
          closeTime: candle.T,
          open,
          close,
          high,
          low,
          quoteVolume,
          takerBuyQuoteVolume
        });
      } else if (candle.t < pending.openTime + getTimeframeMilliseconds(settings.timeframe)) {
        jMinuteCandidates.set(candle.s, pending);
      }
    }
    if (Math.abs(movePercent) > settings.threshold && !seenCandles.has(id)) {
      seenCandles.add(id);
      jMinuteCandidates.set(candle.s, {
        id,
        symbol: candle.s,
        timeframe: settings.timeframe,
        movePercent,
        direction: movePercent > 0 ? "LONG" : "SHORT",
        high,
        low,
        openTime: candle.t,
        close,
        quoteVolume,
        takerBuyQuoteVolume,
        closeTime: candle.T
      });
    }
    return;
  }
  if (Math.abs(movePercent) <= settings.threshold) return;
  if (alerts.some((alert) => alert.symbol === candle.s)) return;

  if (seenCandles.has(id)) return;
  seenCandles.add(id);

  const alert = {
    id,
    symbol: candle.s,
    timeframe: settings.timeframe,
    movePercent,
    direction: movePercent > 0 ? "LONG" : "SHORT",
    high,
    low,
    tradeStatus: "not-traded",
    changePercent: tickerChanges.get(candle.s) ?? null,
    openTime: candle.t,
    close,
    quoteVolume,
    takerBuyQuoteVolume,
    closeTime: candle.x ? candle.T : Date.now()
  };
  alerts.unshift(alert);
  alerts = alerts.slice(0, settings.alertLimit);
  saveAlerts();
  renderAlerts();
  elements.lastUpdated.textContent = `Last signal ${formatCloseTime(alert.closeTime)}`;
  notify(alert);
  if (settings.tradingEnabled) void executeSignal(alert);
}

function getTimeframeMilliseconds(timeframe) {
  const units = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  const value = Number.parseInt(timeframe, 10);
  const unit = timeframe.slice(-1);
  return value * units[unit];
}

async function qualifyJMinuteCandidate(candidate, confirmation) {
  const revision = settingsRevision;
  const changeMin = settings.changeMin;
  const changeMax = settings.changeMax;
  const removeExistingAlert = () => {
    const previousCount = alerts.length;
    alerts = alerts.filter((alert) => alert.symbol !== candidate.symbol);
    if (alerts.length !== previousCount) {
      saveAlerts();
      renderAlerts();
    }
  };
  try {
    let changePercent = tickerChanges.get(candidate.symbol);
    if (!Number.isFinite(changePercent)) {
      const tickerUrl = new URL(`${API_BASE}/fapi/v1/ticker/24hr`);
      tickerUrl.searchParams.set("symbol", candidate.symbol);
      const tickerResponse = await fetch(tickerUrl);
      if (!tickerResponse.ok) throw new Error(`24-hour ticker request failed (${tickerResponse.status}).`);
      const ticker = await tickerResponse.json();
      changePercent = Number(ticker.priceChangePercent);
    }
    if (revision !== settingsRevision || settings.strategy !== "j-minute-rule") return;
    const candleUrl = new URL(`${API_BASE}/fapi/v1/klines`);
    candleUrl.search = new URLSearchParams({
      symbol: candidate.symbol,
      interval: candidate.timeframe,
      endTime: String(confirmation.openTime - 1),
      limit: "250"
    });
    const candleResponse = await fetch(candleUrl);
    if (!candleResponse.ok) throw new Error(`EMA 200 candle history request failed (${candleResponse.status}).`);
    const history = await candleResponse.json();
    if (!Array.isArray(history) || history.length < 200 ||
        history.some((row) => !Array.isArray(row) || !Number.isFinite(Number(row[4])) || Number(row[4]) <= 0)) {
      throw new Error("Binance returned insufficient or invalid candle history for EMA 200.");
    }
    if (revision !== settingsRevision || settings.strategy !== "j-minute-rule") return;
    const ema = window.calculateEma(
      [...history.slice(-250).map((row) => Number(row[4])), confirmation.close],
      200
    );
    if (!Number.isFinite(changePercent) || changePercent < changeMin || changePercent > changeMax ||
        !Number.isFinite(ema) ||
        (candidate.direction === "LONG" ? confirmation.close <= ema : confirmation.close >= ema)) {
      removeExistingAlert();
      return;
    }

    const entryPrice = candidate.direction === "LONG" ? confirmation.low : confirmation.high;
    const stopLossPrice = candidate.direction === "LONG" ? candidate.low : candidate.high;
    if (candidate.direction === "LONG" ? stopLossPrice >= entryPrice : stopLossPrice <= entryPrice) {
      removeExistingAlert();
      return;
    }
    removeExistingAlert();
    const alert = {
      ...candidate,
      high: confirmation.high,
      low: confirmation.low,
      close: confirmation.close,
      quoteVolume: confirmation.quoteVolume,
      takerBuyQuoteVolume: confirmation.takerBuyQuoteVolume,
      changePercent,
      ema200: ema,
      entryPrice,
      stopLossPrice,
      confirmationOpenTime: confirmation.openTime,
      closeTime: confirmation.closeTime,
      tradeStatus: "not-traded"
    };
    alerts.unshift(alert);
    alerts = alerts.slice(0, settings.alertLimit);
    saveAlerts();
    renderAlerts();
    elements.lastUpdated.textContent = `J-minute-Rule signal ${formatCloseTime(alert.closeTime)}`;
    notify(alert);
    if (settings.tradingEnabled) void executeSignal(alert);
  } catch (error) {
    if (revision !== settingsRevision || settings.strategy !== "j-minute-rule") return;
    removeExistingAlert();
    console.error(`Could not qualify J-minute-Rule signal for ${candidate.symbol}.`, error);
    showToast(`J-minute-Rule skipped ${candidate.symbol}: ${error.message}`);
  }
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
    "buy-volume-not-strong": "BUY VOLUME NOT STRONG",
    "sell-volume-not-strong": "SELL VOLUME NOT STRONG",
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
  const updatedPositions = new Map(result.positions.map((position) => [position.symbol, position]));
  const closedSymbols = [...positions.keys()].filter((symbol) => !updatedPositions.has(symbol));
  if (closedSymbols.length) {
    const closedSymbolSet = new Set(closedSymbols);
    const previousAlertCount = alerts.length;
    alerts = alerts.filter((alert) => !closedSymbolSet.has(alert.symbol));
    if (alerts.length !== previousAlertCount) {
      saveAlerts();
      showToast(`${closedSymbols.join(", ")} position closed on Binance; removed from Latest Alerts.`);
    }
  }
  positions = updatedPositions;
  for (const exit of result.protectionExits || []) {
    showToast(
      `${exit.reason} ROI was already reached for ${exit.symbol}; the position was closed at ${exit.roi.toFixed(1)}% ROI.` +
      (exit.cleanupWarning ? ` ${exit.cleanupWarning}` : "")
    );
  }
  for (const warning of result.protectionWarnings || []) {
    showToast(`${warning.symbol} ${warning.type} protection warning: ${warning.message}`);
  }
  if (Array.isArray(result.protectionOrders) && result.protectionOrders.length) {
    const ordersBySymbol = new Map();
    for (const order of result.protectionOrders) {
      const orders = ordersBySymbol.get(order.symbol) || [];
      orders.push(`${order.type === "TAKE_PROFIT_MARKET" ? "TP" : "SL"} at ${formatPrice(order.triggerPrice)}`);
      ordersBySymbol.set(order.symbol, orders);
    }
    showToast([...ordersBySymbol]
      .map(([symbol, orders]) => `${symbol}: ${orders.join(" and ")} exchange orders set.`)
      .join(" "));
  }
  renderAlerts();
  renderTradingSession();
}

function startPositionRefresh() {
  if (positionRefreshTimer) return;
  positionRefreshTimer = window.setInterval(() => {
    refreshPositions().catch((error) => {
      console.error("Could not refresh Binance positions.", error);
      elements.credentialStatus.textContent = `Position refresh failed: ${error.message}`;
    });
  }, 15000);
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
    settings.takeProfitRoi = tradingStatus.takeProfitRoi ?? "";
    settings.stopLossRoi = tradingStatus.stopLossRoi ?? "";
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
    if (tradingStatus.configured) startPositionRefresh();
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
    settings.takeProfitRoi = tradingStatus.takeProfitRoi ?? "";
    settings.stopLossRoi = tradingStatus.stopLossRoi ?? "";
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
        candleLow: alert.low,
        entryPrice: alert.entryPrice,
        stopLossPrice: alert.stopLossPrice,
        quoteVolume: alert.quoteVolume,
        takerBuyQuoteVolume: alert.takerBuyQuoteVolume
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
            : result.status === "skipped"
              ? result.reason
              : "direction-disabled";
    if (result.status === "placed") {
      let message;
      if (result.protectionWarning) {
        message = result.protectionWarning;
      } else if (result.protectionExit) {
        message = `${result.protectionExit.reason} ROI was already reached for ${alert.symbol}; the position was closed at ${result.protectionExit.roi.toFixed(1)}% ROI.`;
      } else if (result.orderType === "LIMIT") {
        message = `${result.direction} limit order placed for ${alert.symbol} at ${formatPrice(result.price)}; its 1-minute stop-loss will be calculated and set after it fills.`;
      } else if (result.protectionWarnings?.length) {
        message = result.protectionWarnings
          .map(({ type, message: errorMessage }) => `${alert.symbol} ${type} protection warning: ${errorMessage}`)
          .join(" ");
      } else if (result.protectiveOrdersPending) {
        message = `${result.direction || tradeDirection} market order placed for ${alert.symbol}; TP/SL orders are waiting for the position to appear.`;
      } else if (result.protectiveOrders?.length) {
        const orderSummary = result.protectiveOrders
          .map((order) => `${order.type === "TAKE_PROFIT_MARKET" ? "TP" : "SL"} at ${formatPrice(order.triggerPrice)}${order.source ? ` (${order.source})` : ""}`)
          .join(" and ");
        message = `${result.direction || tradeDirection} market order placed for ${alert.symbol}; ${orderSummary} exchange orders set.`;
      } else {
        message = `${result.direction || tradeDirection} market order placed for ${alert.symbol} at 5x.`;
      }
      showToast(message);
    } else if (result.status === "limit_reached") {
      showToast(`Trade limit reached (${result.openTrades}/${result.limit}). No order was placed for ${alert.symbol}.`);
    } else if (result.status === "order_exists") {
      showToast(`Reverse call with limit skipped for ${alert.symbol}: an open order already exists.`);
    } else if (result.status === "recent_close_price") {
      showToast(`Reverse Call skipped for ${alert.symbol}: the current price appeared in the previous 120 minutes.`);
    } else if (result.status === "skipped" && result.reason === "buy-volume-not-strong") {
      showToast(`Trade skipped for ${alert.symbol}: buy-initiated volume did not exceed sell-initiated volume.`);
    } else if (result.status === "skipped" && result.reason === "sell-volume-not-strong") {
      showToast(`Trade skipped for ${alert.symbol}: sell-initiated volume did not exceed buy-initiated volume.`);
    }
    saveAlerts();
    try {
      await refreshPositions();
    } catch (error) {
      console.error(`Could not refresh positions after placing the ${tradeDirection} order for ${alert.symbol}.`, error);
      elements.credentialStatus.textContent = `Position refresh failed: ${error.message}`;
    }
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
  const streams = [...markets.map((symbol) => `${symbol.toLowerCase()}@kline_${settings.timeframe}`), "!ticker@arr"];
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
        elements.lastUpdated.textContent =
          `Watching ${markets.length.toLocaleString("en-US")} markets on ${settings.timeframe}`;
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

function reconnectMarketStream() {
  window.clearTimeout(reconnectTimer);
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    socket.close();
  } else if (socket?.readyState !== WebSocket.CLOSING && markets.length > 0) {
    connectSocket();
  }
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
  jMinuteCandidates.clear();
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

  const changeMin = Number(elements.changeMinInput.value);
  const changeMax = Number(elements.changeMaxInput.value);
  if (!Number.isFinite(changeMin) || !Number.isFinite(changeMax) ||
      changeMin < -100 || changeMin > 100 || changeMax < -100 || changeMax > 100 ||
      changeMin >= changeMax) {
    elements.changeMinInput.setCustomValidity("Set a 24-hour change range from -100% to 100%, with the minimum below the maximum.");
    elements.changeMinInput.reportValidity();
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
  const takeProfitText = elements.takeProfitRoiInput.value.trim();
  const takeProfitRoi = takeProfitText ? Number(takeProfitText) : null;
  if (takeProfitRoi !== null &&
      (!Number.isFinite(takeProfitRoi) || takeProfitRoi <= 0 || takeProfitRoi >= 500)) {
    elements.takeProfitRoiInput.setCustomValidity("Enter a take-profit ROI greater than 0% and less than 500%, or leave it blank.");
    elements.takeProfitRoiInput.reportValidity();
    return;
  }
  const stopLossText = elements.stopLossRoiInput.value.trim();
  const stopLossRoi = stopLossText ? Number(stopLossText) : null;
  if (stopLossRoi !== null &&
      (!Number.isFinite(stopLossRoi) || stopLossRoi >= 0 || stopLossRoi <= -500)) {
    elements.stopLossRoiInput.setCustomValidity("Enter a stop-loss ROI less than 0% and greater than -500%, or leave it blank.");
    elements.stopLossRoiInput.reportValidity();
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

  const previousTimeframe = settings.timeframe;
  settings = {
    timeframe: elements.timeframeInput.value,
    threshold,
    alertLimit,
    maxOpenTrades,
    changeMin,
    changeMax,
    notifications,
    tradeMode,
    strategy: elements.strategyInput.value,
    tradeDirection: elements.tradeDirectionInput.value,
    marginAmount: marginAmount ?? "",
    marginUnit,
    takeProfitRoi: takeProfitRoi ?? "",
    stopLossRoi: stopLossRoi ?? "",
    tradingEnabled: false
  };
  settingsRevision += 1;
  jMinuteCandidates.clear();
  if (saveSettings()) {
    alerts = alerts.slice(0, settings.alertLimit);
    saveAlerts();
    renderSettings();
    renderAlerts();
    if (previousTimeframe !== settings.timeframe) reconnectMarketStream();
    try {
      const tradingPayload = {
        mode: tradeMode,
        strategy: settings.strategy,
        direction: settings.tradeDirection,
        marginAmount,
        marginUnit,
        takeProfitRoi,
        stopLossRoi,
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
      if (tradingStatus.configured) startPositionRefresh();
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
        settings.takeProfitRoi = tradingStatus.takeProfitRoi ?? "";
        settings.stopLossRoi = tradingStatus.stopLossRoi ?? "";
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

for (const input of [elements.changeMinInput, elements.changeMaxInput]) {
  input.addEventListener("input", () => {
    elements.changeMinInput.setCustomValidity("");
    elements.changeMaxInput.setCustomValidity("");
    elements.settingsFeedback.textContent = "";
  });
}

elements.notificationsInput.addEventListener("change", () => {
  elements.settingsFeedback.textContent = "";
});

elements.marginAmountInput.addEventListener("input", () => {
  elements.marginAmountInput.setCustomValidity("");
  elements.settingsFeedback.textContent = "";
});

for (const input of [elements.takeProfitRoiInput, elements.stopLossRoiInput]) {
  input.addEventListener("input", () => {
    input.setCustomValidity("");
    elements.settingsFeedback.textContent = "";
  });
}

elements.strategyInput.addEventListener("change", toggleDefaultRoiSettings);

for (const input of [
  elements.timeframeInput,
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
