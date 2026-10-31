const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createServer,
  countOpenTrades,
  formatQuantity,
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
  assert.doesNotThrow(() => validateConfig({ ...config, maxOpenTrades: 5 }));
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
      direction: "both",
      marginAmount: 1,
      marginUnit: "percent",
      maxOpenTrades: 5
    })
  });
  assert.equal(savedConfig.status, 200);
  const savedStatus = await savedConfig.json();
  assert.equal(savedStatus.enabled, false);
  assert.equal(savedStatus.maxOpenTrades, 5);

  const startWithoutCredentials = await fetch(`${baseUrl}/api/trading/start`, { method: "POST" });
  assert.equal(startWithoutCredentials.status, 409);

  const stopped = await fetch(`${baseUrl}/api/trading/stop`, { method: "POST" });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).enabled, false);
});
