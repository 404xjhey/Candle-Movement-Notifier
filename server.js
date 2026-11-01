const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = __dirname;
const DEFAULT_PORT = 8000;
const LEVERAGE = 5;
const REVERSE_CALL_LOOKBACK_MINUTES = 120;
const DEFAULT_MAX_OPEN_TRADES = 5;
const MAX_OPEN_TRADES = 100;
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
  maxOpenTrades: DEFAULT_MAX_OPEN_TRADES,
  apiKey: "",
  apiSecret: ""
};
const processedSignals = new Map();
const inFlightSignals = new Set();
const inFlightSymbols = new Set();
const inFlightClosures = new Set();
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
  if (!["default", "reverse-call"].includes(strategy)) {
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
  return { apiKey, apiSecret, marginAmount, maxOpenTrades, strategy };
}

function updateConfig(body) {
  const validated = validateConfig(body);
  const modeChanged = tradingConfig.mode !== body.mode;
  if (modeChanged) {
    tradingConfig.apiKey = "";
    tradingConfig.apiSecret = "";
    tradingConfig.enabled = false;
    exchangeInfoCache = undefined;
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
  if (!tradingConfig.enabled) throw apiError("Automatic trading is disabled in Settings.", 409);
  const direction = getTradeDirection(candleDirection, tradingConfig.strategy);
  if (tradingConfig.direction !== "both" && tradingConfig.direction.toUpperCase() !== direction) {
    return { symbol, direction, signalId, skipped: true };
  }
  if (!tradingConfig.marginAmount) throw apiError("Set the order margin in Settings before trading.", 409);
  if (!tradingConfig.apiKey || !tradingConfig.apiSecret) {
    throw apiError("Configure a Binance API key and secret in Settings first.", 409);
  }
  return { symbol, direction, signalId, skipped: false };
}

function getTradeDirection(candleDirection, strategy) {
  return strategy === "reverse-call"
    ? (candleDirection === "LONG" ? "SHORT" : "LONG")
    : candleDirection;
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
    const positions = await listPositions();
    if (positions.some((position) => position.symbol === signal.symbol)) {
      const result = { status: "position_exists", reason: "An open position already exists for this contract." };
      rememberSignal(signal.signalId, result);
      return result;
    }
    if (!hasTradeCapacity(positions, inFlightSymbols, tradingConfig.maxOpenTrades)) {
      const result = {
        status: "limit_reached",
        limit: tradingConfig.maxOpenTrades,
        openTrades: countOpenTrades(positions, inFlightSymbols)
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
      fetch(`${getApiBase()}/fapi/v1/ticker/price?symbol=${encodeURIComponent(signal.symbol)}`)
    ]);
    if (!priceResponse.ok) throw apiError(`Could not get the ${signal.symbol} market price (${priceResponse.status}).`, 502);
    const currentPrice = Number((await priceResponse.json()).price);
    const usdtBalance = account.assets?.find((asset) => asset.asset === "USDT")?.availableBalance;
    const availableBalance = Number(usdtBalance ?? account.availableBalance);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0 ||
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
    const notionalFilter = market.filters.find((filter) =>
      filter.filterType === "MIN_NOTIONAL" || filter.filterType === "NOTIONAL"
    );
    if (!quantityFilter) throw apiError("Binance did not provide a quantity filter for this contract.", 502);
    const quantity = formatQuantity((margin * LEVERAGE) / currentPrice, quantityFilter.stepSize);
    const numericQuantity = Number(quantity);
    const minimumNotional = Number(notionalFilter?.notional ?? notionalFilter?.minNotional ?? 0);
    if (numericQuantity < Number(quantityFilter.minQty) ||
        numericQuantity > Number(quantityFilter.maxQty) ||
        numericQuantity * currentPrice < minimumNotional) {
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
    const latestPositions = await listPositions();
    if (!tradingConfig.enabled) {
      throw apiError("Automatic trading was disabled before the order could be sent.", 409);
    }
    if (latestPositions.some((position) => position.symbol === signal.symbol)) {
      const result = { status: "position_exists", reason: "An open position already exists for this contract." };
      rememberSignal(signal.signalId, result);
      return result;
    }
    if (!hasTradeCapacity(latestPositions, inFlightSymbols, tradingConfig.maxOpenTrades)) {
      const result = {
        status: "limit_reached",
        limit: tradingConfig.maxOpenTrades,
        openTrades: countOpenTrades(latestPositions, inFlightSymbols)
      };
      rememberSignal(signal.signalId, result);
      return result;
    }
    const positionSide = dualSide.dualSidePosition ? signal.direction : undefined;
    const clientOrderId = `ww_${crypto.createHash("sha256").update(signal.signalId).digest("hex").slice(0, 28)}`;
    const order = await signedRequest("POST", "/fapi/v1/order", {
      symbol: signal.symbol,
      side: signal.direction === "LONG" ? "BUY" : "SELL",
      type: "MARKET",
      quantity,
      newClientOrderId: clientOrderId,
      ...(positionSide ? { positionSide } : {})
    });
    const result = {
      status: "placed",
      direction: signal.direction,
      quantity: numericQuantity,
      leverage: LEVERAGE,
      orderId: order.orderId
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

async function closePosition(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
    throw apiError("Invalid USDT perpetual symbol.");
  }
  if (inFlightSymbols.has(symbol)) throw apiError("An entry order for this contract is being processed.", 409);
  if (inFlightClosures.has(symbol)) throw apiError("A close order for this contract is already being processed.", 409);
  inFlightClosures.add(symbol);
  try {
    const positions = await listPositions();
    const position = positions.find((item) => item.symbol === symbol);
    if (!position) return { status: "not_open" };

    const original = (await signedRequest("GET", "/fapi/v3/positionRisk", { symbol }))
      .find((item) => item.symbol === symbol && Number(item.positionAmt) !== 0);
    if (!original) return { status: "not_open" };
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
    return { status: "closed", orderId: order.orderId };
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
    sendJson(response, 200, getStatus());
    return;
  }
  if (pathname === "/api/trading/positions" && request.method === "GET") {
    if (!tradingConfig.apiKey || !tradingConfig.apiSecret) {
      sendJson(response, 200, { positions: [] });
      return;
    }
    sendJson(response, 200, { positions: await listPositions() });
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
  getStatus,
  hasTradeCapacity,
  validateConfig
};
