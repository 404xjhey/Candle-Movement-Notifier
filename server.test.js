const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createServer,
  countOpenTrades,
  formatPrice,
  formatQuantity,
  getLimitEntryPrice,
  getRoiTriggerPrice,
  getStopLossPrice,
  getTradeDirection,
  getOpenPositions,
  getStatus,
  hasTradeCapacity,
  validateConfig
} = require("./server");

test("formats market quantities down to Binance step size", () => {
  assert.equal(formatQuantity(1.239, "0.01"), "1.23");
  assert.equal(formatQuantity(0.0019, "0.0001"), "0.0019");
  assert.equal(formatQuantity(5, "1.000"), "5");
});

test("maps candle direction to the selected trading strategy", () => {
  assert.equal(getTradeDirection("LONG", "default"), "LONG");
  assert.equal(getTradeDirection("SHORT", "default"), "SHORT");
  assert.equal(getTradeDirection("LONG", "reverse-call"), "SHORT");
  assert.equal(getTradeDirection("SHORT", "reverse-call"), "LONG");
  assert.equal(getTradeDirection("LONG", "reverse-call-limit"), "SHORT");
  assert.equal(getTradeDirection("SHORT", "reverse-call-limit"), "LONG");
});

test("prices reverse-call limit entries from candle extremes and rounds toward the limit", () => {
  assert.equal(getLimitEntryPrice("LONG", 100, 95, "0.01"), "102.50");
  assert.equal(getLimitEntryPrice("SHORT", 100, 95, "0.01"), "92.62");
  assert.equal(formatPrice(102.501, "0.01", "up"), "102.51");
  assert.equal(formatPrice(92.629, "0.01", "down"), "92.62");
});

test("sets stop triggers at approximately 50% PnL loss using 5x leverage", () => {
  assert.equal(getStopLossPrice("SHORT", 102.5, "0.01"), "112.75");
  assert.equal(getStopLossPrice("LONG", 92.62, "0.01"), "83.36");
});

test("converts positive and negative ROI thresholds to directional mark-price triggers", () => {
  assert.equal(getRoiTriggerPrice("LONG", 100, 30, "0.01"), "106.00");
  assert.equal(getRoiTriggerPrice("LONG", 100, -30, "0.01"), "94.00");
  assert.equal(getRoiTriggerPrice("SHORT", 100, 30, "0.01"), "94.00");
  assert.equal(getRoiTriggerPrice("SHORT", 100, -30, "0.01"), "106.00");
});

test("returns only nonzero positions with a normalized direction", () => {
  const positions = getOpenPositions([
    { symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "0.02", entryPrice: "100", markPrice: "110", unRealizedProfit: "0.2" },
    { symbol: "ETHUSDT", positionSide: "BOTH", positionAmt: "-1", entryPrice: "100", markPrice: "90", unRealizedProfit: "10" },
    { symbol: "BNBUSDT", positionSide: "BOTH", positionAmt: "0", entryPrice: "0", markPrice: "0", unRealizedProfit: "0" }
  ]);
  assert.deepEqual(positions.map(({ symbol, direction }) => [symbol, direction]), [
    ["BTCUSDT", "LONG"],
    ["ETHUSDT", "SHORT"]
  ]);
});

test("enforces a five-position limit including pending entries", () => {
  const positions = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]
    .map((symbol) => ({ symbol }));
  assert.equal(countOpenTrades(positions, new Set(["DOGEUSDT"])), 5);
  assert.equal(countOpenTrades([...positions, { symbol: "DOGEUSDT" }], new Set(["DOGEUSDT"])), 5);
  assert.equal(hasTradeCapacity(positions, new Set(["DOGEUSDT"]), 5), true);
  assert.equal(hasTradeCapacity(positions, new Set(["DOGEUSDT", "ADAUSDT"]), 5), false);
  assert.equal(hasTradeCapacity([...positions, { symbol: "DOGEUSDT" }], new Set(["DOGEUSDT"]), 5), true);
  assert.equal(hasTradeCapacity([...positions, { symbol: "DOGEUSDT" }], new Set(["ADAUSDT"]), 5), false);
});

test("validates the maximum open trade setting", () => {
  const config = {
    mode: "demo",
    direction: "both",
    marginAmount: 1,
    marginUnit: "percent"
  };
  assert.throws(() => validateConfig({ ...config, maxOpenTrades: 0 }), /between 1 and 100/);
  assert.throws(() => validateConfig({ ...config, maxOpenTrades: 101 }), /between 1 and 100/);
  assert.throws(() => validateConfig({ ...config, strategy: "unknown" }), /supported trading strategy/);
  assert.doesNotThrow(() => validateConfig({ ...config, maxOpenTrades: 5 }));
  assert.equal(validateConfig({ ...config, strategy: "reverse-call-limit" }).strategy, "reverse-call-limit");
  assert.equal(validateConfig(config).strategy, "default");
  assert.equal(validateConfig({ ...config, takeProfitRoi: 30, stopLossRoi: -30 }).takeProfitRoi, 30);
  assert.equal(validateConfig({ ...config, takeProfitRoi: "", stopLossRoi: null }).stopLossRoi, null);
  assert.throws(() => validateConfig({ ...config, takeProfitRoi: -30 }), /greater than 0/);
  assert.throws(() => validateConfig({ ...config, stopLossRoi: 30 }), /less than 0/);
  assert.throws(() => validateConfig({ ...config, takeProfitRoi: 500 }), /valid price trigger/);
  assert.throws(() => validateConfig({ ...config, stopLossRoi: -500 }), /valid price trigger/);
});

test("validates margin and paired API credentials when saving trading settings", () => {
  assert.throws(() => validateConfig({
    mode: "demo",
    direction: "both",
    marginUnit: "percent",
    marginAmount: 101,
    maxOpenTrades: 5
  }), /cannot exceed 100%/);
  assert.throws(() => validateConfig({
    mode: "demo",
    direction: "both",
    marginUnit: "percent",
    marginAmount: 5,
    maxOpenTrades: 5,
    apiKey: "demo-key"
  }), /both the Binance API key and secret/);
  assert.doesNotThrow(() => validateConfig({
    mode: "demo",
    direction: "both",
    marginUnit: "percent",
    marginAmount: 5,
    maxOpenTrades: 5,
    apiKey: "demo-key",
    apiSecret: "demo-secret"
  }));
});

test("does not expose Binance secrets in trading status", () => {
  const status = getStatus();
  assert.equal(Object.hasOwn(status, "apiSecret"), false);
  assert.equal(Object.hasOwn(status, "apiKey"), false);
});

test("serves the dashboard locally and rejects foreign origins", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const pageContent = await page.text();
  assert.match(pageContent, /Wickwatch/);
  assert.match(pageContent, /id="max-open-trades-input"[^>]*value="5"/);
  assert.match(pageContent, /id="strategy-input"/);
  assert.match(pageContent, /id="take-profit-roi-input"/);
  assert.match(pageContent, /id="stop-loss-roi-input"/);
  assert.match(pageContent, /value="reverse-call-limit">Reverse call with limit/);

  const rejected = await fetch(`${baseUrl}/api/trading/status`, {
    headers: { Origin: "https://untrusted.example" }
  });
  assert.equal(rejected.status, 403);

  const savedConfig = await fetch(`${baseUrl}/api/trading/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "demo",
      enabled: true,
      strategy: "reverse-call-limit",
      direction: "both",
      marginAmount: 1,
      marginUnit: "percent",
      takeProfitRoi: 30,
      stopLossRoi: -30,
      maxOpenTrades: 5
    })
  });
  assert.equal(savedConfig.status, 200);
  const savedStatus = await savedConfig.json();
  assert.equal(savedStatus.enabled, false);
  assert.equal(savedStatus.strategy, "reverse-call-limit");
  assert.equal(savedStatus.takeProfitRoi, 30);
  assert.equal(savedStatus.stopLossRoi, -30);
  assert.equal(savedStatus.maxOpenTrades, 5);

  const startWithoutCredentials = await fetch(`${baseUrl}/api/trading/start`, { method: "POST" });
  assert.equal(startWithoutCredentials.status, 409);

  const stopped = await fetch(`${baseUrl}/api/trading/stop`, { method: "POST" });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).enabled, false);
});

test("submits small limit prices as tick-formatted decimals", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const originalFetch = global.fetch;
  let submittedOrder;
  const submittedStops = [];
  const activeAlgoOrders = [];
  let positionIsOpen = false;
  let positionMarkPrice = 0.00000052;
  let nextMarketMarkPrice = 0.00000053;
  let rejectTakeProfitOnce = false;

  global.fetch = async (input, options) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "127.0.0.1") return originalFetch(input, options);

    let data;
    if (url.pathname === "/fapi/v3/account") {
      data = { assets: [{ asset: "USDT", availableBalance: "100" }] };
    } else if (url.pathname === "/fapi/v3/positionRisk") {
      data = positionIsOpen
        ? [{
          symbol: "TESTUSDT",
          positionAmt: "10000000",
          positionSide: "BOTH",
          entryPrice: "0.00000052",
          markPrice: String(positionMarkPrice),
          unRealizedProfit: "0"
        }]
        : [];
    } else if (url.pathname === "/fapi/v1/ticker/price") {
      data = { price: "0.00000052" };
    } else if (url.pathname === "/fapi/v1/openOrders") {
      data = [];
    } else if (url.pathname === "/fapi/v1/openAlgoOrders") {
      data = [...activeAlgoOrders];
    } else if (url.pathname === "/fapi/v1/exchangeInfo") {
      data = {
        symbols: [{
          symbol: "TESTUSDT",
          status: "TRADING",
          contractType: "PERPETUAL",
          quoteAsset: "USDT",
          filters: [
            { filterType: "LOT_SIZE", minQty: "1", maxQty: "1000000000", stepSize: "1" },
            { filterType: "MARKET_LOT_SIZE", minQty: "1", maxQty: "1000000000", stepSize: "1" },
            { filterType: "PRICE_FILTER", tickSize: "0.00000001" },
            { filterType: "MIN_NOTIONAL", notional: "5" }
          ]
        }]
      };
    } else if (url.pathname === "/fapi/v1/positionSide/dual") {
      data = { dualSidePosition: false };
    } else if (url.pathname === "/fapi/v1/leverage") {
      data = { leverage: 5 };
    } else if (url.pathname === "/fapi/v1/algoOrder") {
      if (options.method === "DELETE") {
        const index = activeAlgoOrders.findIndex((order) => String(order.algoId) === url.searchParams.get("algoId"));
        if (index >= 0) activeAlgoOrders.splice(index, 1);
        data = {};
      } else {
        const submitted = Object.fromEntries(url.searchParams);
        if (rejectTakeProfitOnce && submitted.type === "TAKE_PROFIT_MARKET") {
          rejectTakeProfitOnce = false;
          return {
            ok: false,
            status: 400,
            json: async () => ({ msg: "Order would immediately trigger", code: -2021 })
          };
        }
        submitted.algoId = submittedStops.length + 123;
        submittedStops.push(submitted);
        activeAlgoOrders.push(submitted);
        data = { algoId: submitted.algoId };
      }
    } else if (url.pathname === "/fapi/v1/order") {
      submittedOrder = Object.fromEntries(url.searchParams);
      if (submittedOrder.reduceOnly === "true") {
        positionIsOpen = false;
      } else if (submittedOrder.type === "MARKET") {
        positionIsOpen = true;
        positionMarkPrice = nextMarketMarkPrice;
      }
      data = { orderId: 456 };
    } else {
      throw new Error(`Unexpected Binance request: ${url.pathname}`);
    }

    return { ok: true, status: 200, json: async () => data };
  };

  context.after(async () => {
    global.fetch = originalFetch;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  const savedConfig = await fetch(`${baseUrl}/api/trading/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "demo",
      strategy: "reverse-call-limit",
      direction: "both",
      marginAmount: 5,
      marginUnit: "usdt",
      maxOpenTrades: 5,
      apiKey: "test-key",
      apiSecret: "test-secret"
    })
  });
  assert.equal(savedConfig.status, 200);

  const started = await fetch(`${baseUrl}/api/trading/start`, { method: "POST" });
  assert.equal(started.status, 200);

  const response = await fetch(`${baseUrl}/api/trading/signal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol: "TESTUSDT",
      direction: "LONG",
      signalId: "small-limit-price",
      candleHigh: 0.0000005,
      candleLow: 0.0000004
    })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "placed");
  assert.equal(submittedOrder.type, "LIMIT");
  assert.equal(submittedOrder.price, "0.00000052");
  assert.equal(submittedStops.length, 0);

  positionIsOpen = true;
  const positionsResponse = await fetch(`${baseUrl}/api/trading/positions`);
  assert.equal(positionsResponse.status, 200);
  assert.equal(submittedStops.length, 1);
  assert.equal(submittedStops[0].type, "STOP_MARKET");
  assert.equal(submittedStops[0].triggerPrice, "0.00000057");

  positionIsOpen = false;
  const orphanCleanup = await fetch(`${baseUrl}/api/trading/positions`);
  assert.equal(orphanCleanup.status, 200);
  assert.equal(activeAlgoOrders.length, 0);

  const defaultConfig = await fetch(`${baseUrl}/api/trading/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "demo",
      strategy: "default",
      direction: "both",
      marginAmount: 5,
      marginUnit: "usdt",
      takeProfitRoi: 30,
      stopLossRoi: -30,
      maxOpenTrades: 5
    })
  });
  assert.equal(defaultConfig.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/trading/start`, { method: "POST" })).status, 200);

  const marketSignal = await fetch(`${baseUrl}/api/trading/signal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol: "TESTUSDT",
      direction: "LONG",
      signalId: "default-roi-exit",
      candleHigh: 0.0000005,
      candleLow: 0.0000004
    })
  });
  assert.equal(marketSignal.status, 200);
  const marketSignalResult = await marketSignal.json();
  assert.equal(marketSignalResult.status, "placed");
  assert.equal(submittedOrder.type, "MARKET");
  assert.equal(marketSignalResult.protectiveOrdersPending, false);
  assert.deepEqual(marketSignalResult.protectiveOrders, [
    { type: "TAKE_PROFIT_MARKET", triggerPrice: 0.00000056 },
    { type: "STOP_MARKET", triggerPrice: 0.00000049 }
  ]);
  assert.equal(submittedStops.length, 3);
  assert.deepEqual(submittedStops.slice(1).map(({ type }) => type), ["TAKE_PROFIT_MARKET", "STOP_MARKET"]);
  assert.deepEqual(submittedStops.slice(1).map(({ triggerPrice }) => triggerPrice), ["0.00000056", "0.00000049"]);
  assert.equal(submittedStops.slice(1).every((order) => order.closePosition === "true"), true);
  assert.equal(submittedStops.slice(1).every((order) => order.workingType === "MARK_PRICE"), true);

  const positionsWithProtection = await fetch(`${baseUrl}/api/trading/positions`);
  assert.equal(positionsWithProtection.status, 200);
  assert.equal((await positionsWithProtection.json()).positions.length, 1);
  assert.equal(activeAlgoOrders.length, 2);

  const stopLossConfig = await fetch(`${baseUrl}/api/trading/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "demo",
      strategy: "default",
      direction: "both",
      marginAmount: 5,
      marginUnit: "usdt",
      takeProfitRoi: null,
      stopLossRoi: -30,
      maxOpenTrades: 5
    })
  });
  assert.equal(stopLossConfig.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/trading/start`, { method: "POST" })).status, 200);
  positionIsOpen = false;
  await fetch(`${baseUrl}/api/trading/positions`);
  nextMarketMarkPrice = 0.00000052;
  const stopLossSignal = await fetch(`${baseUrl}/api/trading/signal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol: "TESTUSDT",
      direction: "LONG",
      signalId: "default-roi-stop-loss",
      candleHigh: 0.0000005,
      candleLow: 0.0000004
    })
  });
  assert.equal(stopLossSignal.status, 200);
  const stopLossResult = await stopLossSignal.json();
  assert.equal(stopLossResult.status, "placed");
  assert.deepEqual(stopLossResult.protectiveOrders, [
    { type: "STOP_MARKET", triggerPrice: 0.00000049 }
  ]);
  assert.equal(submittedStops.at(-1).type, "STOP_MARKET");
  assert.equal(submittedStops.at(-1).triggerPrice, "0.00000049");

  positionIsOpen = false;
  await fetch(`${baseUrl}/api/trading/positions`);
  const bothOrdersConfig = await fetch(`${baseUrl}/api/trading/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "demo",
      strategy: "default",
      direction: "both",
      marginAmount: 5,
      marginUnit: "usdt",
      takeProfitRoi: 30,
      stopLossRoi: -30,
      maxOpenTrades: 5
    })
  });
  assert.equal(bothOrdersConfig.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/trading/start`, { method: "POST" })).status, 200);
  rejectTakeProfitOnce = true;
  const partiallyProtectedSignal = await fetch(`${baseUrl}/api/trading/signal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol: "TESTUSDT",
      direction: "LONG",
      signalId: "default-roi-tp-retry",
      candleHigh: 0.0000005,
      candleLow: 0.0000004
    })
  });
  assert.equal(partiallyProtectedSignal.status, 200);
  const partialResult = await partiallyProtectedSignal.json();
  assert.equal(partialResult.protectiveOrdersPending, true);
  assert.match(partialResult.protectionWarning, /TAKE_PROFIT_MARKET.*immediately trigger/);
  assert.equal(submittedStops.at(-1).type, "STOP_MARKET");

  const retriedOrdersResponse = await fetch(`${baseUrl}/api/trading/positions`);
  assert.equal(retriedOrdersResponse.status, 200);
  const retriedOrders = await retriedOrdersResponse.json();
  assert.equal(retriedOrders.protectionOrders.length, 1);
  assert.equal(retriedOrders.protectionOrders[0].type, "TAKE_PROFIT_MARKET");
  assert.equal(activeAlgoOrders.length, 2);

  positionIsOpen = false;
  await fetch(`${baseUrl}/api/trading/positions`);
  nextMarketMarkPrice = 0.00000057;
  const alreadyReachedSignal = await fetch(`${baseUrl}/api/trading/signal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol: "TESTUSDT",
      direction: "LONG",
      signalId: "default-roi-tp-already-reached",
      candleHigh: 0.0000005,
      candleLow: 0.0000004
    })
  });
  assert.equal(alreadyReachedSignal.status, 200);
  const alreadyReachedResult = await alreadyReachedSignal.json();
  assert.equal(alreadyReachedResult.status, "placed");
  assert.ok(alreadyReachedResult.protectionExit, JSON.stringify(alreadyReachedResult));
  assert.equal(alreadyReachedResult.protectionExit.reason, "Take-profit");
  assert.equal(alreadyReachedResult.protectionExit.roi > 30, true);
  assert.equal(submittedOrder.reduceOnly, "true");
  assert.equal(positionIsOpen, false);
});
