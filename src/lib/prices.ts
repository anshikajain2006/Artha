/**
 * Client-side price layer.
 *
 * All Yahoo Finance fetches happen server-side via POST /api/prices to avoid
 * CORS restrictions. This module calls that endpoint, caches results, and
 * exposes the same public API the rest of the app uses.
 *
 * For tickers where a live price is unavailable the server echoes back the
 * holding's avgBuyPrice. We store that as a LivePrice (source:'unavailable')
 * so every holding contributes to totalValue (at cost basis, P&L = 0),
 * preventing the ₹0 display when Yahoo Finance can't price some stocks.
 *
 * Cache: module-level Map, 5-minute TTL, cleared on hard page reload.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LivePrice {
  price:         number;   // last traded / regular market price
  changePercent: number;   // 1-day change %
  prevClose:     number;   // previous session close (0 when unavailable)
  symbol:        string;   // ticker as returned by the API
  fetchedAt:     number;   // epoch ms when cached
  source:        'live' | 'unavailable';
}

// ── Input shape ────────────────────────────────────────────────────────────────

// fetchLivePrices accepts either plain ticker strings or holding objects that
// carry avgBuyPrice / avgPrice — both forms used in Dashboard.
type HoldingInput =
  | string
  | { ticker: string; avgBuyPrice?: number; avgPrice?: number };

function normalizeInputs(
  inputs: HoldingInput[],
): Array<{ ticker: string; avgPrice: number }> {
  return inputs.map((h) => {
    if (typeof h === 'string') {
      return { ticker: h.trim().toUpperCase(), avgPrice: 0 };
    }
    return {
      ticker:   h.ticker.trim().toUpperCase(),
      avgPrice: h.avgBuyPrice || h.avgPrice || 0,
    };
  });
}

// ── Internal cache ─────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes

interface CacheEntry {
  data:      LivePrice;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fetch live prices for multiple tickers via the server-side /api/prices proxy.
 * Returns a map of normalised ticker → LivePrice | null.
 *
 * Accepts either ticker strings or holding objects (with avgBuyPrice / avgPrice).
 * When avgBuyPrice is supplied and a live price is unavailable, the returned
 * LivePrice uses the cost basis as price (source:'unavailable'), so the holding
 * still appears in totalValue with P&L = 0 rather than being excluded entirely.
 */
export async function fetchLivePrices(
  inputs: HoldingInput[],
): Promise<Record<string, LivePrice | null>> {
  const normalized = normalizeInputs(inputs);

  // Deduplicate by ticker, keeping the first avgPrice seen
  const seen = new Map<string, number>();
  for (const { ticker, avgPrice } of normalized) {
    if (!seen.has(ticker)) seen.set(ticker, avgPrice);
  }

  const result: Record<string, LivePrice | null> = {};
  const toFetch: Array<{ ticker: string; avgPrice: number }> = [];

  for (const [ticker, avgPrice] of seen) {
    const entry = cache.get(ticker);
    if (entry && Date.now() < entry.expiresAt) {
      result[ticker] = entry.data;
    } else {
      toFetch.push({ ticker, avgPrice });
    }
  }

  if (toFetch.length === 0) return result;

  try {
    const res = await fetch('/api/prices', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        holdings: toFetch.map((h) => ({
          ticker:   h.ticker,
          avgPrice: h.avgPrice,
        })),
      }),
    });

    if (!res.ok) {
      for (const { ticker } of toFetch) result[ticker] = null;
      return result;
    }

    const data = await res.json() as {
      prices: Array<{
        ticker: string;
        price:  number;
        change: number;
        source: 'live' | 'unavailable';
      }>;
    };

    const now = Date.now();
    for (const p of data.prices) {
      const t = p.ticker.trim().toUpperCase();

      if (p.source === 'unavailable') {
        if (p.price > 0) {
          // Server echoed back avgBuyPrice — use it as cost-basis price so the
          // holding still appears in totalValue (P&L will be ₹0 / 0%).
          const lp: LivePrice = {
            price:         p.price,
            changePercent: 0,
            prevClose:     p.price,
            symbol:        t,
            fetchedAt:     now,
            source:        'unavailable',
          };
          cache.set(t, { data: lp, expiresAt: now + CACHE_TTL_MS });
          result[t] = lp;
        } else {
          result[t] = null; // no price at all — exclude from totals
        }
        continue;
      }

      const lp: LivePrice = {
        price:         p.price,
        changePercent: p.change,
        prevClose:     0,
        symbol:        t,
        fetchedAt:     now,
        source:        'live',
      };
      cache.set(t, { data: lp, expiresAt: now + CACHE_TTL_MS });
      result[t] = lp;
    }

    // Any ticker the server didn't mention → null
    for (const { ticker } of toFetch) {
      if (!(ticker in result)) result[ticker] = null;
    }
  } catch {
    for (const { ticker } of toFetch) result[ticker] = null;
  }

  return result;
}

/**
 * Fetch a single ticker's live price.
 */
export async function fetchLivePrice(ticker: string): Promise<LivePrice | null> {
  const map = await fetchLivePrices([ticker]);
  return map[ticker.trim().toUpperCase()] ?? null;
}

/**
 * Evict all cached entries — call before a manual refresh.
 */
export function clearPriceCache(): void {
  cache.clear();
}

/**
 * Read a cached price synchronously without making a network request.
 */
export function getCachedPrice(ticker: string): LivePrice | null {
  const entry = cache.get(ticker.trim().toUpperCase());
  return entry && Date.now() < entry.expiresAt ? entry.data : null;
}
