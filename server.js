const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = __dirname;
const DEFAULT_PORT = 5500;
const LEVERAGE = 5;
const REVERSE_CALL_LIMIT_OFFSET_PERCENT = 2.5;
const STOP_LOSS_PNL_PERCENT = 50;
const REVERSE_CALL_LOOKBACK_MINUTES = 120;
const DEFAULT_MAX_OPEN_TRADES = 15;
const DEFAULT_STOP_LOSS_ROI = -10;
const MAX_OPEN_TRADES = 100;
const STOP_LEVEL_LOOKBACK_CANDLES = 60;
const STOP_LEVEL_PIVOT_WIDTH = 2;
const STOP_LEVEL_CLUSTER_PERCENT = 0.15;
const STOP_LEVEL_BUFFER_PERCENT = 0.1;
const ALLOWED_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]]
]);
const tradingConfig = {
  mode: "demo",
  enabled: false,
  strategy: "default",
  direction: "both",
  marginAmount: null,
  marginUnit: "percent",
  takeProfitRoi: null,
  stopLossRoi: DEFAULT_STOP_LOSS_ROI,
  maxOpenTrades: DEFAULT_MAX_OPEN_TRADES,
  apiKey: "",
  apiSecret: ""
};
const processedSignals = new Map();
const inFlightSignals = new Set();
const inFlightSymbols = new Set();
const inFlightClosures = new Set();
const pendingProtectiveStops = new Map();
const inFlightProtectiveStops = new Set();
let tradingGeneration = 0;
let exchangeInfoCache;

function getApiBase() {
  return tradingConfig.mode === "live"
    ? "https://fapi.binance.com"
    : "https://demo-fapi.binance.com";
}

function getStatus() {
  return {
    mode: tradingConfig.mode,
    enabled: tradingConfig.enabled,
    strategy: tradingConfig.strategy,
    direction: tradingConfig.direction,
    marginAmount: tradingConfig.marginAmount,
    marginUnit: tradingConfig.marginUnit,
    takeProfitRoi: tradingConfig.takeProfitRoi,
    stopLossRoi: tradingConfig.stopLossRoi,
    maxOpenTrades: tradingConfig.maxOpenTrades,
    leverage: LEVERAGE,
    configured: Boolean(tradingConfig.apiKey && tradingConfig.apiSecret),
    apiKeyHint: tradingConfig.apiKey ? `********${tradingConfig.apiKey.slice(-4)}` : ""
  };
}

function validateConfig(body) {
  if (!["demo", "live"].includes(body.mode)) {
    throw new Error("Choose Binance Demo or Live mode.");
  }
  if (!["both", "long", "short"].includes(body.direction)) {
    throw new Error("Choose a supported trade direction.");
  }
  const strategy = body.strategy ?? "default";
  if (!["default", "reverse-call", "reverse-call-limit"].includes(strategy)) {
    throw new Error("Choose a supported trading strategy.");
  }
  if (!["percent", "usdt"].includes(body.marginUnit)) {
    throw new Error("Choose percent or USDT for the order margin.");
  }
  const marginAmount = body.marginAmount === "" || body.marginAmount == null
    ? null
    : Number(body.marginAmount);
  if (marginAmount !== null && (!Number.isFinite(marginAmount) || marginAmount <= 0)) {
    throw new Error("Order margin must be a positive number.");
  }
  if (body.marginUnit === "percent" && marginAmount !== null && marginAmount > 100) {
    throw new Error("Order margin cannot exceed 100% of available margin.");
  }
  const takeProfitRoi = validateRoiSetting(body.takeProfitRoi, "Take-profit ROI", "positive");
  const stopLossRoi = validateRoiSetting(
    body.stopLossRoi === undefined ? tradingConfig.stopLossRoi : body.stopLossRoi,
    "Stop-loss ROI",
    "negative"
  );
  const maxOpenTrades = body.maxOpenTrades == null
    ? tradingConfig.maxOpenTrades
    : Number(body.maxOpenTrades);
  if (!Number.isInteger(maxOpenTrades) || maxOpenTrades < 1 || maxOpenTrades > MAX_OPEN_TRADES) {
    throw new Error(`Maximum open trades must be a whole number between 1 and ${MAX_OPEN_TRADES}.`);
  }
  if (body.mode === "live" && body.liveConfirmed !== true) {
    throw new Error("Confirm live trading before saving Live mode.");
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const apiSecret = typeof body.apiSecret === "string" ? body.apiSecret.trim() : "";
  if (Boolean(apiKey) !== Boolean(apiSecret)) {
    throw new Error("Enter both the Binance API key and secret, or leave both blank.");
  }
  if (apiKey.length > 256 || apiSecret.length > 256) {
    throw new Error("The Binance API key or secret is too long.");
  }
  return { apiKey, apiSecret, marginAmount, maxOpenTrades, strategy, takeProfitRoi, stopLossRoi };
}

function validateRoiSetting(value, label, sign) {
  if (value === "" || value == null) return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${label} must be a number or blank.`);
  }
  const roi = Number(value);
  if (!Number.isFinite(roi) || (sign === "positive" ? roi <= 0 : roi >= 0)) {
    throw new Error(`${label} must be ${sign === "positive" ? "greater than 0" : "less than 0"}, or blank.`);
  }
  if (Math.abs(roi) >= LEVERAGE * 100) {
    throw new Error(`${label} must be between -${LEVERAGE * 100}% and ${LEVERAGE * 100}% to produce a valid price trigger.`);
  }
  return roi;
}

function updateConfig(body) {
  const validated = validateConfig(body);
  const modeChanged = tradingConfig.mode !== body.mode;
  const credentialsChanged = Boolean(validated.apiKey && validated.apiSecret) &&
    (validated.apiKey !== tradingConfig.apiKey || validated.apiSecret !== tradingConfig.apiSecret);
  if (modeChanged) {
    tradingConfig.apiKey = "";
    tradingConfig.apiSecret = "";
    tradingConfig.enabled = false;
    exchangeInfoCache = undefined;
  }
  if (modeChanged || credentialsChanged) {
    pendingProtectiveStops.clear();
  }
  tradingGeneration += 1;
  if (validated.apiKey && validated.apiSecret) {
    tradingConfig.apiKey = validated.apiKey;
    tradingConfig.apiSecret = validated.apiSecret;
  }
  tradingConfig.mode = body.mode;
  tradingConfig.enabled = false;
  tradingConfig.strategy = validated.strategy;
  tradingConfig.direction = body.direction;
  tradingConfig.marginAmount = validated.marginAmount;
  tradingConfig.marginUnit = body.marginUnit;
  tradingConfig.takeProfitRoi = validated.takeProfitRoi;
  tradingConfig.stopLossRoi = validated.stopLossRoi;
  tradingConfig.maxOpenTrades = validated.maxOpenTrades;
  return getStatus();
}

function stopTrading() {
  tradingConfig.enabled = false;
  tradingGeneration += 1;
  return {
    ...getStatus(),
    orderInFlight: inFlightSignals.size > 0
  };
}

async function startTrading() {
  if (!tradingConfig.apiKey || !tradingConfig.apiSecret) {
    throw apiError("Configure Binance API credentials in Settings before starting trading.", 409);
  }
  if (!tradingConfig.marginAmount) {
    throw apiError("Set a positive margin per trade in Settings before starting trading.", 409);
  }
  if (inFlightSignals.size || inFlightClosures.size) {
    throw apiError("A Binance order is still being processed. Try starting again afterward.", 409);
  }

  tradingConfig.enabled = false;
  const generation = ++tradingGeneration;
  try {
    await signedRequest("GET", "/fapi/v3/account");
    if (generation !== tradingGeneration) {
      throw apiError("Trading was stopped while the Binance account was being verified.", 409);
    }
    tradingConfig.enabled = true;
    return getStatus();
  } catch (error) {
    if (generation === tradingGeneration) tradingConfig.enabled = false;
    throw error;
  }
}

async function readJsonBody(request) {
  let content = "";
  for await (const chunk of request) {
    content += chunk;
    if (content.length > 32_768) {
      throw apiError("Request body is too large.", 413);
    }
  }
  try {
    const body = JSON.parse(content || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw apiError("Request body must be a JSON object.", 400);
    }
    return body;
  } catch (error) {
    if (error.statusCode) throw error;
    throw apiError("Request body must be a valid JSON object.", 400);
  }
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

function assertLocalRequest(request, port) {
  const expectedHost = `127.0.0.1:${port}`;
  if (request.headers.host !== expectedHost) {
    throw Object.assign(new Error("This local trading service only accepts loopback requests."), { statusCode: 403 });
  }
  const origin = request.headers.origin;
  if (origin && origin !== `http://${expectedHost}`) {
    throw Object.assign(new Error("Requests from other websites are not allowed."), { statusCode: 403 });
  }
}

function apiError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function signedRequest(method, endpoint, params = {}) {
  if (!tradingConfig.apiKey || !tradingConfig.apiSecret) {
    throw apiError("Configure a Binance API key and secret in Settings first.", 409);
  }
  const query = new URLSearchParams({
    ...params,
    recvWindow: "5000",
    timestamp: String(Date.now())
  }).toString();
  const signature = crypto.createHmac("sha256", tradingConfig.apiSecret).update(query).digest("hex");
  const response = await fetch(`${getApiBase()}${endpoint}?${query}&signature=${signature}`, {
    method,
    headers: { "X-MBX-APIKEY": tradingConfig.apiKey }
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const message = result && typeof result.msg === "string"
      ? `Binance rejected the request: ${result.msg} (${result.code ?? response.status}).`
      : `Binance API request failed (${response.status}).`;
    throw apiError(message, 502);
  }
  return result;
}

async function getExchangeInfo() {
  if (exchangeInfoCache && exchangeInfoCache.expiresAt > Date.now()) {
    return exchangeInfoCache.data;
  }
  const response = await fetch(`${getApiBase()}/fapi/v1/exchangeInfo`);
  if (!response.ok) throw apiError(`Binance exchange information request failed (${response.status}).`, 502);
  const data = await response.json();
  exchangeInfoCache = { data, expiresAt: Date.now() + 10 * 60 * 1000 };
  return data;
}

function formatQuantity(quantity, stepSize) {
  const step = Number(stepSize);
  if (!Number.isFinite(step) || step <= 0) throw apiError("Binance returned an invalid quantity step.", 502);
  const precision = (String(stepSize).split(".")[1] || "").replace(/0+$/, "").length;
  const roundedDown = Math.floor((quantity + step * 1e-10) / step) * step;
  return roundedDown.toFixed(precision);
}

function getOpenPositions(positions) {
  return positions
    .filter((position) => Number(position.positionAmt) !== 0)
    .map((position) => {
      const amount = Number(position.positionAmt);
      const direction = position.positionSide === "LONG" || (position.positionSide === "BOTH" && amount > 0)
        ? "LONG"
        : "SHORT";
      return {
        symbol: position.symbol,
        direction,
        amount: Math.abs(amount),
        entryPrice: Number(position.entryPrice),
        markPrice: Number(position.markPrice),
        unrealizedProfit: Number(position.unRealizedProfit)
      };
    });
}

function getRoiTriggerPrice(direction, entryPrice, roiPercent, tickSize) {
  if (!["LONG", "SHORT"].includes(direction) ||
      !Number.isFinite(entryPrice) || entryPrice <= 0 ||
      !Number.isFinite(roiPercent) || roiPercent === 0) {
    throw apiError("Cannot calculate a protective order from invalid trade or ROI values.");
  }
  const priceMove = roiPercent / (LEVERAGE * 100);
  const triggerPrice = direction === "LONG"
    ? entryPrice * (1 + priceMove)
    : entryPrice * (1 - priceMove);
  if (triggerPrice <= 0) throw apiError("The configured ROI produces an invalid trigger price.");
  return formatPrice(triggerPrice, tickSize, direction === "LONG" ? "up" : "down");
}

function getSupportResistanceStopPrice(candles, direction, entryPrice, tickSize) {
  if (!Array.isArray(candles) || !["LONG", "SHORT"].includes(direction) ||
      !Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw apiError("Cannot calculate a support/resistance stop from invalid candle or trade data.");
  }
  const lows = candles.map((candle) => Number(candle[3]));
  const highs = candles.map((candle) => Number(candle[2]));
  const pivots = [];
  for (let index = STOP_LEVEL_PIVOT_WIDTH; index < candles.length - STOP_LEVEL_PIVOT_WIDTH; index += 1) {
    const values = direction === "LONG" ? lows : highs;
    const pivot = values[index];
    const neighbors = [];
    for (let offset = 1; offset <= STOP_LEVEL_PIVOT_WIDTH; offset += 1) {
      neighbors.push(values[index - offset], values[index + offset]);
    }
    if (!Number.isFinite(pivot) || pivot <= 0 || neighbors.some((value) => !Number.isFinite(value))) continue;
    const isPivot = direction === "LONG"
      ? neighbors.every((value) => pivot <= value) &&
        neighbors.slice(0, STOP_LEVEL_PIVOT_WIDTH).some((value) => pivot < value) &&
        neighbors.slice(STOP_LEVEL_PIVOT_WIDTH).some((value) => pivot < value)
      : neighbors.every((value) => pivot >= value) &&
        neighbors.slice(0, STOP_LEVEL_PIVOT_WIDTH).some((value) => pivot > value) &&
        neighbors.slice(STOP_LEVEL_PIVOT_WIDTH).some((value) => pivot > value);
    if (isPivot) pivots.push(pivot);
  }

  const levels = [];
  for (const pivot of pivots.sort((a, b) => a - b)) {
    const level = levels.find((candidate) =>
      Math.abs(pivot - candidate.average) / candidate.average * 100 <= STOP_LEVEL_CLUSTER_PERCENT
    );
    if (level) {
      level.total += pivot;
      level.touches += 1;
      level.average = level.total / level.touches;
    } else {
      levels.push({ average: pivot, total: pivot, touches: 1 });
    }
  }

  const strongLevels = levels.filter((level) =>
    level.touches >= 2 && (direction === "LONG" ? level.average < entryPrice : level.average > entryPrice)
  );
  const nearestLevel = direction === "LONG"
    ? strongLevels.sort((a, b) => b.average - a.average)[0]
    : strongLevels.sort((a, b) => a.average - b.average)[0];
  if (!nearestLevel) return null;

  const buffer = STOP_LEVEL_BUFFER_PERCENT / 100;
  const stopPrice = direction === "LONG"
    ? nearestLevel.average * (1 - buffer)
    : nearestLevel.average * (1 + buffer);
  return formatPrice(stopPrice, tickSize, direction === "LONG" ? "down" : "up");
}

async function getRecentOneMinuteCandles(symbol) {
  const query = new URLSearchParams({
    symbol,
    interval: "1m",
    limit: String(STOP_LEVEL_LOOKBACK_CANDLES + 1)
  });
  const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?${query}`);
  if (!response.ok) {
    throw apiError(`Could not get ${symbol} 1-minute candles for its stop-loss (${response.status}).`, 502);
  }
  const candles = await response.json();
  if (!Array.isArray(candles) || candles.length < STOP_LEVEL_LOOKBACK_CANDLES + 1) {
    throw apiError(`Binance returned insufficient ${symbol} 1-minute candle history for its stop-loss.`, 502);
  }
  if (candles.some((candle) => !Array.isArray(candle) || candle.length < 7 ||
      ![Number(candle[2]), Number(candle[3])].every((price) => Number.isFinite(price) && price > 0) ||
      Number(candle[2]) < Number(candle[3]))) {
    throw apiError(`Binance returned invalid ${symbol} 1-minute candles for its stop-loss.`, 502);
  }
  return candles.slice(0, -1).slice(-STOP_LEVEL_LOOKBACK_CANDLES);
}

async function resolveLevelStopLoss(order, symbol, position, tickSize) {
  if (!order.levelBased) return;
  if (order.triggerPrice) {
    const stopIsAdverse = position.direction === "LONG"
      ? Number(order.triggerPrice) < position.entryPrice
      : Number(order.triggerPrice) > position.entryPrice;
    if (stopIsAdverse) return;
    order.triggerPrice = undefined;
    order.stopSource = undefined;
  }
  let candles;
  try {
    candles = await getRecentOneMinuteCandles(symbol);
  } catch (error) {
    order.roiPercent = order.fallbackRoiPercent;
    order.stopSource = "ROI fallback (1m data unavailable)";
    if (order.roiPercent == null) throw error;
    return `Could not calculate the 1-minute stop for ${symbol}; using the configured ROI fallback: ${error.message}`;
  }
  const triggerPrice = getSupportResistanceStopPrice(
    candles,
    position.direction,
    position.entryPrice,
    tickSize
  );
  if (triggerPrice) {
    order.triggerPrice = triggerPrice;
    order.stopSource = position.direction === "LONG" ? "support" : "resistance";
  } else {
    order.roiPercent = order.fallbackRoiPercent;
    order.stopSource = "ROI fallback";
    if (order.roiPercent == null) {
      throw apiError(`No strong 1-minute ${position.direction === "LONG" ? "support" : "resistance"} was found, and no ROI stop-loss fallback is configured.`);
    }
  }
}

function getTradeRoiPercent(position) {
  if (!Number.isFinite(position.entryPrice) || position.entryPrice <= 0 ||
      !Number.isFinite(position.markPrice) || position.markPrice <= 0 ||
      !["LONG", "SHORT"].includes(position.direction)) {
    throw apiError("Binance returned an invalid entry or mark price for an open position.", 502);
  }
  const directionMultiplier = position.direction === "LONG" ? 1 : -1;
  return ((position.markPrice - position.entryPrice) / position.entryPrice) *
    directionMultiplier * LEVERAGE * 100;
}

function countOpenTrades(openPositions, reservedSymbols) {
  const openPositionSymbols = new Set(openPositions.map((position) => position.symbol));
  const pendingSymbols = new Set(reservedSymbols);
  const unreflectedReservations = [...pendingSymbols]
    .filter((symbol) => !openPositionSymbols.has(symbol)).length;
  return openPositions.length + unreflectedReservations;
}

function hasTradeCapacity(openPositions, reservedSymbols, maxOpenTrades) {
  return countOpenTrades(openPositions, reservedSymbols) <= maxOpenTrades;
}

async function listPositions() {
  const positions = await signedRequest("GET", "/fapi/v3/positionRisk");
  return getOpenPositions(positions);
}

async function listOpenOrders() {
  const orders = await signedRequest("GET", "/fapi/v1/openOrders");
  if (!Array.isArray(orders)) throw apiError("Binance returned invalid open order data.", 502);
  return orders;
}

async function cleanupOrphanedProtectiveStops(openPositions) {
  const [openOrders, algoOrders] = await Promise.all([
    listOpenOrders(),
    signedRequest("GET", "/fapi/v1/openAlgoOrders", { algoType: "CONDITIONAL" })
  ]);
  if (!Array.isArray(algoOrders)) throw apiError("Binance returned invalid conditional order data.", 502);
  const openPositionSymbols = new Set(openPositions.map((position) => position.symbol));
  const openEntryIds = new Set(openOrders.map((order) => order.clientOrderId));
  const openAlgoIds = new Set(algoOrders.map((order) => order.clientAlgoId));
  const installedOrders = [];
  const closedAtRoi = [];
  const protectionWarnings = [];
  for (const [symbol, protection] of pendingProtectiveStops) {
    if (inFlightProtectiveStops.has(symbol)) continue;
    if (!openPositionSymbols.has(symbol)) {
      const awaitingMarketPosition = protection.waitForPosition &&
        Date.now() - protection.createdAt < 2 * 60 * 1000;
      if (!openEntryIds.has(protection.entryClientOrderId) &&
          !inFlightSymbols.has(symbol) && !awaitingMarketPosition) {
        pendingProtectiveStops.delete(symbol);
      }
      continue;
    }

    inFlightProtectiveStops.add(symbol);
    try {
      const position = openPositions.find((item) => item.symbol === symbol);
      const currentRoi = protection.waitForPosition ? getTradeRoiPercent(position) : null;
      for (const order of protection.orders) {
        if (protection.refreshLevelOnFill && order.levelBased) {
          order.triggerPrice = undefined;
          order.roiPercent = undefined;
          order.stopSource = undefined;
          protection.refreshLevelOnFill = false;
        }
        order.unavailable = false;
        try {
          const warning = await resolveLevelStopLoss(order, symbol, position, protection.tickSize);
          if (warning) protectionWarnings.push({ symbol, type: order.type, message: warning });
        } catch (error) {
          order.unavailable = true;
          protectionWarnings.push({ symbol, type: order.type, message: error.message });
        }
      }
      const reachedOrder = protection.orders.find((order) => {
        if (order.roiPercent != null) {
          return order.roiPercent > 0 ? currentRoi >= order.roiPercent : currentRoi <= order.roiPercent;
        }
        if (order.type !== "STOP_MARKET" || order.triggerPrice == null) return false;
        return protection.direction === "LONG"
          ? position.markPrice <= Number(order.triggerPrice)
          : position.markPrice >= Number(order.triggerPrice);
      });
      if (reachedOrder) {
        const closeResult = await closePosition(symbol, { allowEntryInFlight: true });
        pendingProtectiveStops.delete(symbol);
        closedAtRoi.push({
          symbol,
          reason: reachedOrder.type === "TAKE_PROFIT_MARKET"
            ? "Take-profit"
            : `${reachedOrder.stopSource || "Stop-loss"} stop-loss`,
          roi: currentRoi,
          cleanupWarning: closeResult.cleanupWarning
        });
        continue;
      }

      let allOrdersInstalled = true;
      for (const order of protection.orders) {
        if (order.unavailable) {
          allOrdersInstalled = false;
          continue;
        }
        if (openAlgoIds.has(order.clientAlgoId)) continue;
        const triggerPrice = order.roiPercent == null
          ? order.triggerPrice
          : getRoiTriggerPrice(protection.direction, position.entryPrice, order.roiPercent, protection.tickSize);
        try {
          await signedRequest("POST", "/fapi/v1/algoOrder", {
            algoType: "CONDITIONAL",
            symbol,
            side: protection.direction === "LONG" ? "SELL" : "BUY",
            type: order.type,
            triggerPrice,
            workingType: "MARK_PRICE",
            closePosition: "true",
            clientAlgoId: order.clientAlgoId,
            ...(protection.positionSide ? { positionSide: protection.positionSide } : {})
          });
          openAlgoIds.add(order.clientAlgoId);
          installedOrders.push({
            symbol,
            type: order.type,
            triggerPrice: Number(triggerPrice),
            ...(order.stopSource ? { source: order.stopSource } : {})
          });
          if (protection.lastErrors) delete protection.lastErrors[order.clientAlgoId];
        } catch (error) {
          allOrdersInstalled = false;
          protection.lastErrors ||= {};
          if (protection.lastErrors[order.clientAlgoId] !== error.message) {
            protectionWarnings.push({ symbol, type: order.type, message: error.message });
          }
          protection.lastErrors[order.clientAlgoId] = error.message;
        }
      }
      if (allOrdersInstalled) pendingProtectiveStops.delete(symbol);
    } finally {
      inFlightProtectiveStops.delete(symbol);
    }
  }

  for (const order of algoOrders) {
    if (typeof order.clientAlgoId !== "string" ||
        (!order.clientAlgoId.startsWith("ww_sl_") && !order.clientAlgoId.startsWith("ww_tp_"))) continue;
    const prefix = order.clientAlgoId.startsWith("ww_sl_") ? "ww_sl_" : "ww_tp_";
    const entryClientOrderId = `ww_${order.clientAlgoId.slice(prefix.length)}`;
    if (openPositionSymbols.has(order.symbol) || openEntryIds.has(entryClientOrderId) ||
        inFlightSymbols.has(order.symbol)) continue;
    await signedRequest("DELETE", "/fapi/v1/algoOrder", { algoId: String(order.algoId) });
  }
  return { installedOrders, closedAtRoi, protectionWarnings };
}

async function hasRecentClosingPrice(symbol, price) {
  const now = Date.now();
  const query = new URLSearchParams({
    symbol,
    interval: "1m",
    startTime: String(now - REVERSE_CALL_LOOKBACK_MINUTES * 60 * 1000),
    endTime: String(now - 1),
    limit: String(REVERSE_CALL_LOOKBACK_MINUTES)
  });
  const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?${query}`);
  if (!response.ok) {
    throw apiError(`Could not verify recent candle history (${response.status}); no order was placed.`, 502);
  }
  const candles = await response.json();
  if (!Array.isArray(candles)) {
    throw apiError("Binance returned invalid candle history; no order was placed.", 502);
  }
  return candles.some((candle) => Number(candle[4]) === price);
}

function validateSignal(body) {
  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  const candleDirection = body.direction;
  const signalId = typeof body.signalId === "string" ? body.signalId : "";
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw apiError("Invalid USDT perpetual symbol.");
  if (!["LONG", "SHORT"].includes(candleDirection)) throw apiError("Invalid signal direction.");
  if (!/^[A-Za-z0-9:_-]{1,100}$/.test(signalId)) throw apiError("Invalid signal identifier.");
  const candleHigh = Number(body.candleHigh);
  const candleLow = Number(body.candleLow);
  if (tradingConfig.strategy === "reverse-call-limit" &&
      (!Number.isFinite(candleHigh) || candleHigh <= 0 ||
        !Number.isFinite(candleLow) || candleLow <= 0 || candleHigh < candleLow)) {
    throw apiError("Valid candle high and low prices are required for Reverse call with limit.");
  }
  if (!tradingConfig.enabled) throw apiError("Automatic trading is disabled in Settings.", 409);
  const direction = getTradeDirection(candleDirection, tradingConfig.strategy);
  if (tradingConfig.direction !== "both" && tradingConfig.direction.toUpperCase() !== direction) {
    return { symbol, direction, signalId, candleDirection, candleHigh, candleLow, skipped: true };
  }
  if (!tradingConfig.marginAmount) throw apiError("Set the order margin in Settings before trading.", 409);
  if (!tradingConfig.apiKey || !tradingConfig.apiSecret) {
    throw apiError("Configure a Binance API key and secret in Settings first.", 409);
  }
  return { symbol, direction, signalId, candleDirection, candleHigh, candleLow, skipped: false };
}

function getTradeDirection(candleDirection, strategy) {
  return strategy === "reverse-call" || strategy === "reverse-call-limit"
    ? (candleDirection === "LONG" ? "SHORT" : "LONG")
    : candleDirection;
}

function formatPrice(price, tickSize, rounding = "nearest") {
  const tick = Number(tickSize);
  if (!Number.isFinite(price) || price <= 0 ||
      !Number.isFinite(tick) || tick <= 0) {
    throw apiError("Binance returned an invalid price or price tick size.", 502);
  }
  const precision = (String(tickSize).split(".")[1] || "").replace(/0+$/, "").length;
  const tickCount = price / tick;
  const roundedCount = rounding === "up"
    ? Math.ceil(tickCount - 1e-10)
    : rounding === "down"
      ? Math.floor(tickCount + 1e-10)
      : Math.round(tickCount);
  return (roundedCount * tick).toFixed(precision);
}

function getLimitEntryPrice(candleDirection, candleHigh, candleLow, tickSize) {
  if (!["LONG", "SHORT"].includes(candleDirection)) throw apiError("Invalid candle direction.");
  const isGreenCandle = candleDirection === "LONG";
  const targetPrice = isGreenCandle
    ? candleHigh * (1 + REVERSE_CALL_LIMIT_OFFSET_PERCENT / 100)
    : candleLow * (1 - REVERSE_CALL_LIMIT_OFFSET_PERCENT / 100);
  return formatPrice(targetPrice, tickSize, isGreenCandle ? "up" : "down");
}

function getStopLossPrice(direction, entryPrice, tickSize) {
  if (!["LONG", "SHORT"].includes(direction)) throw apiError("Invalid trade direction.");
  const adverseMove = STOP_LOSS_PNL_PERCENT / (LEVERAGE * 100);
  const isLong = direction === "LONG";
  const triggerPrice = isLong
    ? entryPrice * (1 - adverseMove)
    : entryPrice * (1 + adverseMove);
  return formatPrice(triggerPrice, tickSize, isLong ? "up" : "down");
}

async function placeSignalOrder(body) {
  const signal = validateSignal(body);
  if (signal.skipped) return { status: "skipped", reason: "Direction is disabled in Settings." };
  if (processedSignals.has(signal.signalId)) return processedSignals.get(signal.signalId);
  if (inFlightSignals.has(signal.signalId) || inFlightSymbols.has(signal.symbol) || inFlightClosures.has(signal.symbol)) {
    throw apiError("A signal for this contract is already being processed.", 409);
  }
  inFlightSignals.add(signal.signalId);
  inFlightSymbols.add(signal.symbol);
  try {
    const usesLimitEntry = tradingConfig.strategy === "reverse-call-limit";
    const [positions, openOrders] = await Promise.all([
      listPositions(),
      usesLimitEntry ? listOpenOrders() : Promise.resolve([])
    ]);
    if (positions.some((position) => position.symbol === signal.symbol)) {
      const result = { status: "position_exists", reason: "An open position already exists for this contract." };
      rememberSignal(signal.signalId, result);
      return result;
    }
    const openOrderSymbols = new Set(openOrders.map((order) => order.symbol));
    if (openOrderSymbols.has(signal.symbol)) {
      const result = { status: "order_exists", reason: "An open order already exists for this contract." };
      rememberSignal(signal.signalId, result);
      return result;
    }
    const reservedSymbols = new Set([...inFlightSymbols, ...openOrderSymbols]);
    if (!hasTradeCapacity(positions, reservedSymbols, tradingConfig.maxOpenTrades)) {
      const result = {
        status: "limit_reached",
        limit: tradingConfig.maxOpenTrades,
        openTrades: countOpenTrades(positions, reservedSymbols)
      };
      rememberSignal(signal.signalId, result);
      return result;
    }

    const exchangeInfo = await getExchangeInfo();
    const market = exchangeInfo.symbols.find((item) =>
      item.symbol === signal.symbol &&
      item.status === "TRADING" &&
      item.contractType === "PERPETUAL" &&
      item.quoteAsset === "USDT"
    );
    if (!market) throw apiError("This contract is not an active USDT perpetual.", 400);

    const [account, priceResponse] = await Promise.all([
      signedRequest("GET", "/fapi/v3/account"),
      usesLimitEntry
        ? Promise.resolve(null)
        : fetch(`${getApiBase()}/fapi/v1/ticker/price?symbol=${encodeURIComponent(signal.symbol)}`)
    ]);
    if (priceResponse && !priceResponse.ok) {
      throw apiError(`Could not get the ${signal.symbol} market price (${priceResponse.status}).`, 502);
    }
    const currentPrice = priceResponse ? Number((await priceResponse.json()).price) : null;
    const usdtBalance = account.assets?.find((asset) => asset.asset === "USDT")?.availableBalance;
    const availableBalance = Number(usdtBalance ?? account.availableBalance);
    if ((!usesLimitEntry && (!Number.isFinite(currentPrice) || currentPrice <= 0)) ||
        !Number.isFinite(availableBalance) || availableBalance <= 0) {
      throw apiError("Binance returned an invalid price or available USDT balance.", 502);
    }
    if (tradingConfig.strategy === "reverse-call" && await hasRecentClosingPrice(signal.symbol, currentPrice)) {
      const result = {
        status: "recent_close_price",
        reason: "The current market price appeared as a closing price in the previous 120 minutes."
      };
      rememberSignal(signal.signalId, result);
      return result;
    }
    const margin = tradingConfig.marginUnit === "percent"
      ? availableBalance * tradingConfig.marginAmount / 100
      : tradingConfig.marginAmount;
    if (margin > availableBalance) throw apiError("The configured margin exceeds available USDT.", 400);

    const quantityFilter = market.filters.find((filter) => filter.filterType === "MARKET_LOT_SIZE") ||
      market.filters.find((filter) => filter.filterType === "LOT_SIZE");
    const limitQuantityFilter = market.filters.find((filter) => filter.filterType === "LOT_SIZE");
    const priceFilter = market.filters.find((filter) => filter.filterType === "PRICE_FILTER");
    const notionalFilter = market.filters.find((filter) =>
      filter.filterType === "MIN_NOTIONAL" || filter.filterType === "NOTIONAL"
    );
    if (!quantityFilter || !priceFilter || (usesLimitEntry && !limitQuantityFilter)) {
      throw apiError("Binance did not provide the required quantity or price filters for this contract.", 502);
    }
    const entryPriceText = usesLimitEntry
      ? getLimitEntryPrice(signal.candleDirection, signal.candleHigh, signal.candleLow, priceFilter.tickSize)
      : null;
    const entryPrice = usesLimitEntry ? Number(entryPriceText) : currentPrice;
    const orderQuantityFilter = usesLimitEntry ? limitQuantityFilter : quantityFilter;
    const quantity = formatQuantity((margin * LEVERAGE) / entryPrice, orderQuantityFilter.stepSize);
    const numericQuantity = Number(quantity);
    const minimumNotional = Number(notionalFilter?.notional ?? notionalFilter?.minNotional ?? 0);
    if (numericQuantity < Number(orderQuantityFilter.minQty) ||
        numericQuantity > Number(orderQuantityFilter.maxQty) ||
        numericQuantity * entryPrice < minimumNotional) {
      throw apiError("The configured margin is too small for Binance's minimum order size.", 400);
    }

    if (!tradingConfig.enabled) {
      throw apiError("Automatic trading was disabled before the order could be sent.", 409);
    }
    await signedRequest("POST", "/fapi/v1/leverage", { symbol: signal.symbol, leverage: String(LEVERAGE) });
    const dualSide = await signedRequest("GET", "/fapi/v1/positionSide/dual");
    if (!tradingConfig.enabled) {
      throw apiError("Automatic trading was disabled before the order could be sent.", 409);
    }
    const [latestPositions, latestOpenOrders] = await Promise.all([
      listPositions(),
      usesLimitEntry ? listOpenOrders() : Promise.resolve([])
    ]);
    if (!tradingConfig.enabled) {
      throw apiError("Automatic trading was disabled before the order could be sent.", 409);
    }
    if (latestPositions.some((position) => position.symbol === signal.symbol)) {
      const result = { status: "position_exists", reason: "An open position already exists for this contract." };
      rememberSignal(signal.signalId, result);
      return result;
    }
    const latestOpenOrderSymbols = new Set(latestOpenOrders.map((order) => order.symbol));
    if (latestOpenOrderSymbols.has(signal.symbol)) {
      const result = { status: "order_exists", reason: "An open order already exists for this contract." };
      rememberSignal(signal.signalId, result);
      return result;
    }
    const latestReservedSymbols = new Set([...inFlightSymbols, ...latestOpenOrderSymbols]);
    if (!hasTradeCapacity(latestPositions, latestReservedSymbols, tradingConfig.maxOpenTrades)) {
      const result = {
        status: "limit_reached",
        limit: tradingConfig.maxOpenTrades,
        openTrades: countOpenTrades(latestPositions, latestReservedSymbols)
      };
      rememberSignal(signal.signalId, result);
      return result;
    }
    const positionSide = dualSide.dualSidePosition ? signal.direction : undefined;
    const orderHash = crypto.createHash("sha256").update(signal.signalId).digest("hex").slice(0, 24);
    const clientOrderId = `ww_${orderHash}`;
    const stopLossOrder = {
      type: "STOP_MARKET",
      levelBased: true,
      fallbackRoiPercent: tradingConfig.stopLossRoi,
      clientAlgoId: `ww_sl_${orderHash}`
    };
    if (usesLimitEntry) {
      if (!tradingConfig.enabled) {
        throw apiError("Automatic trading was disabled before the limit order could be sent.", 409);
      }
      const order = await signedRequest("POST", "/fapi/v1/order", {
        symbol: signal.symbol,
        side: signal.direction === "LONG" ? "BUY" : "SELL",
        type: "LIMIT",
        timeInForce: "GTC",
        quantity,
        price: entryPriceText,
        newClientOrderId: clientOrderId,
        ...(positionSide ? { positionSide } : {})
      });
      pendingProtectiveStops.set(signal.symbol, {
        direction: signal.direction,
        tickSize: priceFilter.tickSize,
        orders: [stopLossOrder],
        entryClientOrderId: clientOrderId,
        positionSide,
        waitForPosition: true,
        refreshLevelOnFill: true,
        createdAt: Date.now()
      });
      const result = {
        status: "placed",
        orderType: "LIMIT",
        direction: signal.direction,
        quantity: numericQuantity,
        price: entryPrice,
        leverage: LEVERAGE,
        orderId: order.orderId
      };
      rememberSignal(signal.signalId, result);
      return result;
    }
    const order = await signedRequest("POST", "/fapi/v1/order", {
      symbol: signal.symbol,
      side: signal.direction === "LONG" ? "BUY" : "SELL",
      type: "MARKET",
      quantity,
      newClientOrderId: clientOrderId,
      ...(positionSide ? { positionSide } : {})
    });
    const protectiveOrders = [];
    if (tradingConfig.strategy === "default") {
      if (tradingConfig.takeProfitRoi !== null) {
        protectiveOrders.push({
          type: "TAKE_PROFIT_MARKET",
          roiPercent: tradingConfig.takeProfitRoi,
          clientAlgoId: `ww_tp_${orderHash}`
        });
      }
    }
    protectiveOrders.push(stopLossOrder);
    if (protectiveOrders.length) {
      pendingProtectiveStops.set(signal.symbol, {
        direction: signal.direction,
        tickSize: priceFilter.tickSize,
        orders: protectiveOrders,
        entryClientOrderId: clientOrderId,
        positionSide,
        waitForPosition: true,
        createdAt: Date.now()
      });
    }
    let protectionWarning;
    let activeProtectiveOrders = [];
    let protectionExit;
    let protectionWarnings = [];
    if (protectiveOrders.length) {
      try {
        const openPositions = await listPositions();
        const position = openPositions.find((item) => item.symbol === signal.symbol);
        const protectionResult = await cleanupOrphanedProtectiveStops(openPositions);
        activeProtectiveOrders = protectionResult.installedOrders
          .filter((order) => order.symbol === signal.symbol)
          .map(({ type, triggerPrice, source }) => ({ type, triggerPrice, ...(source ? { source } : {}) }));
        protectionExit = protectionResult.closedAtRoi.find((exit) => exit.symbol === signal.symbol);
        protectionWarnings = protectionResult.protectionWarnings
          .filter((warning) => warning.symbol === signal.symbol);
        if (position && !protectionResult.installedOrders.some((order) => order.symbol === signal.symbol) &&
            !protectionExit && !pendingProtectiveStops.has(signal.symbol)) {
          activeProtectiveOrders = protectiveOrders.map((order) => ({
            type: order.type,
            ...(order.stopSource ? { source: order.stopSource } : {}),
            triggerPrice: Number(order.roiPercent == null
              ? order.triggerPrice
              : getRoiTriggerPrice(signal.direction, position.entryPrice, order.roiPercent, priceFilter.tickSize))
          }));
        }
      } catch (error) {
        protectionWarning = `Entry order was placed, but protective TP/SL orders could not be confirmed: ${error.message}`;
      }
      if (!protectionWarning && protectionWarnings.length) {
        protectionWarning = `Entry was placed, but Binance rejected protective order(s): ${protectionWarnings
          .map(({ type, message }) => `${type}: ${message}`)
          .join("; ")}`;
      }
      if (!protectionWarning && pendingProtectiveStops.has(signal.symbol)) {
        protectionWarning = "Entry order was placed; TP/SL orders are waiting for the open position to appear and will be retried.";
      }
    }
    const result = {
      status: "placed",
      direction: signal.direction,
      quantity: numericQuantity,
      leverage: LEVERAGE,
      orderId: order.orderId,
      ...(protectiveOrders.length ? { protectiveOrders: activeProtectiveOrders } : {}),
      ...(protectionExit ? { protectionExit } : {}),
      ...(protectionWarnings.length ? { protectionWarnings } : {}),
      ...(protectionWarning ? { protectionWarning } : {}),
      ...(protectiveOrders.length ? { protectiveOrdersPending: pendingProtectiveStops.has(signal.symbol) } : {})
    };
    rememberSignal(signal.signalId, result);
    return result;
  } catch (error) {
    rememberSignal(signal.signalId, { status: "failed", reason: error.message });
    throw error;
  } finally {
    inFlightSignals.delete(signal.signalId);
    inFlightSymbols.delete(signal.symbol);
  }
}

function rememberSignal(signalId, result) {
  processedSignals.set(signalId, result);
  if (processedSignals.size > 5000) {
    processedSignals.delete(processedSignals.keys().next().value);
  }
}

async function closePosition(symbol, { allowEntryInFlight = false } = {}) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
    throw apiError("Invalid USDT perpetual symbol.");
  }
  if (!allowEntryInFlight && inFlightSymbols.has(symbol)) {
    throw apiError("An entry order for this contract is being processed.", 409);
  }
  if (inFlightClosures.has(symbol)) throw apiError("A close order for this contract is already being processed.", 409);
  inFlightClosures.add(symbol);
  try {
    const positions = await listPositions();
    const position = positions.find((item) => item.symbol === symbol);
    if (!position) {
      await cleanupOrphanedProtectiveStops(positions);
      return { status: "not_open" };
    }

    const original = (await signedRequest("GET", "/fapi/v3/positionRisk", { symbol }))
      .find((item) => item.symbol === symbol && Number(item.positionAmt) !== 0);
    if (!original) {
      await cleanupOrphanedProtectiveStops(await listPositions());
      return { status: "not_open" };
    }
    const isHedgeMode = original.positionSide !== "BOTH";
    const order = await signedRequest("POST", "/fapi/v1/order", {
      symbol,
      side: position.direction === "LONG" ? "SELL" : "BUY",
      type: "MARKET",
      quantity: original.positionAmt.replace(/^-/, ""),
      ...(isHedgeMode
        ? { positionSide: original.positionSide }
        : { reduceOnly: "true" })
    });
    pendingProtectiveStops.delete(symbol);
    try {
      await cleanupOrphanedProtectiveStops(await listPositions());
      return { status: "closed", orderId: order.orderId };
    } catch (error) {
      return {
        status: "closed",
        orderId: order.orderId,
        cleanupWarning: `Position closed, but a Wickwatch protective stop could not be canceled: ${error.message}`
      };
    }
  } finally {
    inFlightClosures.delete(symbol);
  }
}

async function handleApi(request, response, pathname) {
  if (pathname === "/api/trading/status" && request.method === "GET") {
    sendJson(response, 200, getStatus());
    return;
  }
  if (pathname === "/api/trading/start" && request.method === "POST") {
    sendJson(response, 200, await startTrading());
    return;
  }
  if (pathname === "/api/trading/stop" && request.method === "POST") {
    sendJson(response, 200, stopTrading());
    return;
  }
  if (pathname === "/api/trading/config" && request.method === "PUT") {
    const body = await readJsonBody(request);
    stopTrading();
    if (inFlightSignals.size || inFlightClosures.size) {
      throw apiError("A Binance order is being processed. Trading was stopped; save settings again afterward.", 409);
    }
    updateConfig(body);
    sendJson(response, 200, getStatus());
    return;
  }
  if (pathname === "/api/trading/credentials" && request.method === "DELETE") {
    if (inFlightSignals.size || inFlightClosures.size) {
      throw apiError("A Binance order is being processed. Remove credentials after it completes.", 409);
    }
    tradingConfig.apiKey = "";
    tradingConfig.apiSecret = "";
    tradingConfig.enabled = false;
    pendingProtectiveStops.clear();
    sendJson(response, 200, getStatus());
    return;
  }
  if (pathname === "/api/trading/positions" && request.method === "GET") {
    if (!tradingConfig.apiKey || !tradingConfig.apiSecret) {
      sendJson(response, 200, { positions: [] });
      return;
    }
    const positions = await listPositions();
    const protectionResult = await cleanupOrphanedProtectiveStops(positions);
    sendJson(response, 200, {
      positions,
      protectionOrders: protectionResult.installedOrders,
      protectionExits: protectionResult.closedAtRoi,
      protectionWarnings: protectionResult.protectionWarnings
    });
    return;
  }
  if (pathname === "/api/trading/signal" && request.method === "POST") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await placeSignalOrder(body));
    return;
  }
  if (pathname === "/api/trading/close" && request.method === "POST") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await closePosition(body.symbol));
    return;
  }
  sendJson(response, 404, { error: "Trading API endpoint not found." });
}

function createServer() {
  return http.createServer(async (request, response) => {
    try {
      const port = request.socket.localPort;
      assertLocalRequest(request, port);
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url.pathname);
        return;
      }
      const file = ALLOWED_FILES.get(url.pathname);
      if (!file || request.method !== "GET") {
        sendJson(response, 404, { error: "Not found." });
        return;
      }
      response.writeHead(200, {
        "Content-Type": file[1],
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer"
      });
      fs.createReadStream(path.join(ROOT, file[0])).pipe(response);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error("Wickwatch request failed.", error.message);
      sendJson(response, statusCode, { error: error.message || "Unexpected local server error." });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Wickwatch running at http://127.0.0.1:${port}`);
    console.log("Binance credentials are kept in memory and cleared when the server stops.");
  });
}

module.exports = {
  LEVERAGE,
  createServer,
  formatQuantity,
  countOpenTrades,
  getTradeDirection,
  getOpenPositions,
  getRoiTriggerPrice,
  getSupportResistanceStopPrice,
  getStatus,
  hasTradeCapacity,
  formatPrice,
  getLimitEntryPrice,
  getStopLossPrice,
  validateConfig
};
