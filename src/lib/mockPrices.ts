/**
 * Mock current prices by ticker symbol.
 * Replace this map with a live market data API call later.
 * Prices are in USD for US tickers, INR for Indian tickers.
 */
export const MOCK_PRICES: Record<string, number> = {
  // US equities
  AAPL: 213.49,
  MSFT: 415.26,
  GOOGL: 175.84,
  AMZN: 196.41,
  NVDA: 875.4,
  META: 527.19,
  TSLA: 174.92,
  BRK: 415600,
  JPM: 201.35,
  V: 277.64,
  // Indian equities (NSE symbols, prices in INR)
  RELIANCE: 2912.5,
  TCS: 3847.2,
  INFY: 1782.6,
  HDFCBANK: 1623.4,
  WIPRO: 462.8,
  ICICIBANK: 1102.3,
  HINDUNILVR: 2489.7,
  BAJFINANCE: 7312.4,
  SBIN: 784.6,
  ADANIENT: 2341.5,
};

/**
 * Returns the mock current price for a ticker, or null if unknown.
 * A null means we'll show "—" in the UI and exclude the stock from P&L totals.
 */
export function getMockPrice(ticker: string): number | null {
  const normalized = ticker.trim().toUpperCase();
  return MOCK_PRICES[normalized] ?? null;
}
