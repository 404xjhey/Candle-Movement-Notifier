function calculateCandleMovePercent({ open, close, high, low }, strategy) {
  if (strategy !== "waley") return ((close - open) / open) * 100;
  return close > open
    ? ((close - low) / low) * 100
    : ((close - high) / high) * 100;
}

function calculateEma(values, period) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period < 1 ||
      values.length < period || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return null;
  }
  const smoothing = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) {
    ema = value * smoothing + ema * (1 - smoothing);
  }
  return ema;
}

if (typeof module === "object" && module.exports) {
  module.exports = { calculateCandleMovePercent, calculateEma };
} else {
  window.calculateCandleMovePercent = calculateCandleMovePercent;
  window.calculateEma = calculateEma;
}
