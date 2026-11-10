function calculateCandleMovePercent({ open, close, high, low }, strategy) {
  if (strategy !== "waley") return ((close - open) / open) * 100;
  return close > open
    ? ((close - low) / low) * 100
    : ((close - high) / high) * 100;
}

if (typeof module === "object" && module.exports) {
  module.exports = { calculateCandleMovePercent };
} else {
  window.calculateCandleMovePercent = calculateCandleMovePercent;
}
