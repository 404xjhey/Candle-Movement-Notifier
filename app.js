const API_BASE = "https://fapi.binance.com";
const STREAM_BASE = "wss://fstream.binance.com/market/ws";
const SETTINGS_KEY = "wickwatch-settings-v1";
const RECORDS_KEY = "wickwatch-alerts-v2";
const MAX_RECORDS = 20;
const SUBSCRIPTION_BATCH_SIZE = 100;
const SUBSCRIPTION_INTERVAL_MS = 250;

const elements = {
  connectionIndicator: document.querySelector("#connection-indicator"),
  connectionLabel: document.querySelector("#connection-label"),
  connectionMessage: document.querySelector("#connection-message"),
  contractsCount: document.querySelector("#contracts-count"),
  alertsCount: document.querySelector("#alerts-count"),
  thresholdDisplay: document.querySelector("#threshold-display"),
  lastUpdated: document.querySelector("#last-updated"),
  alertsBody: document.querySelector("#alerts-body"),
  emptyState: document.querySelector("#empty-state"),
  emptyTitle: document.querySelector("#empty-title"),
  emptyDescription: document.querySelector("#empty-description"),
  countPill: document.querySelector("#count-pill"),
  clearButton: document.querySelector("#clear-button"),
  settingsForm: document.querySelector("#settings-form"),
  thresholdInput: document.querySelector("#threshold-input"),
  notificationsInput: document.querySelector("#notifications-input"),
  settingsFeedback: document.querySelector("#settings-feedback"),
  toast: document.querySelector("#toast"),
  breadcrumb: document.querySelector("#breadcrumb-current"),
  overviewPage: document.querySelector("#overview-page"),
  settingsPage: document.querySelector("#settings-page")
};

let settings = loadSettings();
let alerts = loadAlerts();
let markets = [];
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
    return {
      threshold: Number.isFinite(threshold) && threshold >= 0.1 && threshold <= 100 ? threshold : 5,
      notifications: saved.notifications === true
    };
  } catch (error) {
    console.warn("Could not read Wickwatch settings from local storage.", error);
    return { threshold: 5, notifications: false };
  }
}

function loadAlerts() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECORDS_KEY) || "[]");
    if (!Array.isArray(saved)) {
      throw new TypeError("Saved alerts must be an array.");
    }
    return saved.filter((alert) =>
      alert &&
      typeof alert.id === "string" &&
      typeof alert.symbol === "string" &&
      Number.isFinite(alert.movePercent) &&
      Number.isFinite(alert.close) &&
      Number.isFinite(alert.quoteVolume) &&
      Number.isFinite(alert.closeTime)
    ).slice(0, MAX_RECORDS);
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
  elements.notificationsInput.checked = settings.notifications;
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
    const contract = document.createElement("div");
    const coinMark = document.createElement("span");
    const symbol = document.createElement("span");
    const quote = document.createElement("span");

    contract.className = "contract-cell";
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
    const rangeTrack = document.createElement("span");
    const rangeFill = document.createElement("span");
    rangeTrack.className = "range-track";
    rangeFill.style.width = `${Math.min((alert.movePercent / Math.max(settings.threshold * 2, 1)) * 100, 100)}%`;
    rangeTrack.append(rangeFill);
    rangeCell.append(rangeTrack);

    addCell(row, "", formatPrice(alert.close));
    addCell(row, "volume-value", formatVolume(alert.quoteVolume));

    const biasCell = document.createElement("td");
    const bias = document.createElement("span");
    bias.className = "bias-pill";
    bias.textContent = "BULLISH";
    biasCell.append(bias);
    row.append(biasCell);

    addCell(row, "closed-time", formatCloseTime(alert.closeTime));
    elements.alertsBody.append(row);
  }

  const hasAlerts = alerts.length > 0;
  elements.emptyState.hidden = hasAlerts;
  elements.alertsBody.closest("table").hidden = !hasAlerts;
  elements.alertsCount.innerHTML = `${alerts.length}<span class="stat-unit"> / ${MAX_RECORDS}</span>`;
  elements.countPill.textContent = String(alerts.length);
  elements.clearButton.disabled = !hasAlerts;
}

function notify(alert) {
  if (!settings.notifications || !("Notification" in window) || Notification.permission !== "granted") return;
  new Notification(`${alert.symbol} candle alert`, {
    body: `Bullish ${alert.movePercent.toFixed(2)}% move | Close ${formatPrice(alert.close)} | ${formatVolume(alert.quoteVolume)} volume`
  });
}

function handleKline(message) {
  const candle = message.k;
  if (!candle || candle.i !== "1m" || candle.x !== true) return;

  const open = Number(candle.o);
  const close = Number(candle.c);
  const quoteVolume = Number(candle.q);
  if (![open, close, quoteVolume].every(Number.isFinite) || open <= 0 || close <= open) return;

  const movePercent = ((close - open) / open) * 100;
  if (movePercent <= settings.threshold) return;

  const id = `${candle.s}:${candle.t}`;
  if (seenCandles.has(id)) return;
  seenCandles.add(id);

  const alert = { id, symbol: candle.s, movePercent, close, quoteVolume, closeTime: candle.T };
  alerts.unshift(alert);
  alerts = alerts.slice(0, MAX_RECORDS);
  saveAlerts();
  renderAlerts();
  elements.lastUpdated.textContent = `Last signal ${formatCloseTime(alert.closeTime)}`;
  notify(alert);
}

function subscribeToMarkets() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const streams = markets.map((symbol) => `${symbol.toLowerCase()}@kline_1m`);
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
      if (payload.data && payload.data.e === "kline") {
        handleKline(payload.data);
      } else if (payload.e === "kline") {
        handleKline(payload);
      } else if (payload.error || (typeof payload.code === "number" && payload.code !== 0)) {
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

elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const threshold = Number(elements.thresholdInput.value);
  if (!Number.isFinite(threshold) || threshold < 0.1 || threshold > 100) {
    elements.thresholdInput.setCustomValidity("Enter a threshold between 0.1 and 100.");
    elements.thresholdInput.reportValidity();
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

  settings = { threshold, notifications };
  if (saveSettings()) {
    renderSettings();
    renderAlerts();
    elements.settingsFeedback.textContent = "Settings saved";
    window.setTimeout(() => { elements.settingsFeedback.textContent = ""; }, 2500);
  }
});

elements.thresholdInput.addEventListener("input", () => {
  elements.thresholdInput.setCustomValidity("");
  elements.settingsFeedback.textContent = "";
});

elements.notificationsInput.addEventListener("change", () => {
  elements.settingsFeedback.textContent = "";
});

renderSettings();
renderAlerts();
loadMarketsAndConnect();
