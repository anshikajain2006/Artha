import type { VercelRequest, VercelResponse } from '@vercel/node';

const YF_HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];

interface Holding {
  ticker:   string;
  shares:   number;
  buyDate?: string; // ISO date string, e.g. "2023-06-15"
}

interface ChartPoint {
  date:  string;
  value: number;
}

interface RawPoint {
  ts:    number;
  close: number | null;
}

async function fetchYFWeekly(symbol: string, range: string): Promise<RawPoint[]> {
  let lastErr: unknown;
  for (const host of YF_HOSTS) {
    const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1wk&range=${range}&includePrePost=false`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept':     'application/json',
        },
      });
      if (!res.ok) {
        console.log(`[historical-prices] ${host} → HTTP ${res.status} for ${symbol}`);
        lastErr = new Error(`Yahoo Finance HTTP ${res.status} for ${symbol}`);
        continue;
      }

      const body = await res.json() as {
        chart?: {
          result?: Array<{
            timestamp?:  number[];
            indicators?: { quote?: Array<{ close?: (number | null)[] }> };
          }>;
          error?: { description?: string };
        };
      };

      if (body.chart?.error) {
        console.log(`[historical-prices] YF chart error for ${symbol}:`, body.chart.error.description);
        lastErr = new Error(body.chart.error.description ?? 'YF error');
        continue;
      }

      const result     = body.chart?.result?.[0];
      const timestamps = result?.timestamp ?? [];
      const closes     = result?.indicators?.quote?.[0]?.close ?? [];
      console.log(`[historical-prices] ${symbol} → ${timestamps.length} points via ${host}`);
      return timestamps.map((ts, i) => ({ ts, close: closes[i] ?? null }));
    } catch (e) {
      console.log(`[historical-prices] ${host} fetch error for ${symbol}:`, e);
      lastErr = e;
    }
  }
  throw lastErr ?? new Error(`All hosts failed for ${symbol}`);
}

/** Return the last known close at or before targetTs (within a 21-day window). */
function lastPriceBefore(points: RawPoint[], targetTs: number): number | null {
  const WINDOW = 21 * 24 * 3600; // 21 days in seconds
  let best: number | null = null;
  for (const p of points) {
    if (p.close !== null && p.close > 0 && p.ts <= targetTs + WINDOW && p.ts >= targetTs - WINDOW) {
      // Prefer the one closest and before
      if (p.ts <= targetTs) best = p.close;
    }
  }
  return best;
}

function toDateStr(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: '2-digit',
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { holdings, range = '1y' } = req.body as { holdings: Holding[]; range: string };

  if (!Array.isArray(holdings) || holdings.length === 0) {
    return res.status(400).json({ error: 'No holdings provided' });
  }

  try {
    // ── Fetch Nifty 50 ────────────────────────────────────────────────────────
    const niftyRaw = await fetchYFWeekly('^NSEI', range);
    const validNifty = niftyRaw.filter((p): p is RawPoint & { close: number } => p.close !== null && p.close > 0);

    if (validNifty.length < 2) {
      return res.status(200).json({ portfolio: [], nifty: [] });
    }

    // ── Fetch each holding's historical prices ────────────────────────────────
    const tickerData: Record<string, RawPoint[]> = {};

    await Promise.allSettled(
      holdings.map(async ({ ticker }) => {
        if (tickerData[ticker]) return; // already fetched (dedup)
        try {
          tickerData[ticker] = await fetchYFWeekly(`${ticker}.NS`, range);
        } catch {
          try {
            tickerData[ticker] = await fetchYFWeekly(ticker, range);
          } catch {
            tickerData[ticker] = [];
          }
        }
      }),
    );

    // ── Build Nifty series ────────────────────────────────────────────────────
    const niftySeries: ChartPoint[] = validNifty.map((p) => ({
      date:  toDateStr(p.ts),
      value: p.close,
    }));

    // ── Build portfolio series aligned to Nifty timestamps ───────────────────
    const portfolioSeries: ChartPoint[] = [];

    for (const { ts } of validNifty) {
      let total  = 0;
      let priced = 0; // number of holdings we managed to price

      for (const { ticker, shares, buyDate } of holdings) {
        // Skip holdings not yet purchased at this timestamp
        if (buyDate) {
          const buyTs = Math.floor(new Date(buyDate).getTime() / 1000);
          if (buyTs > ts + 7 * 24 * 3600) continue; // not purchased yet
        }

        const price = lastPriceBefore(tickerData[ticker] ?? [], ts);
        if (price !== null) {
          total += shares * price;
          priced++;
        }
      }

      if (priced > 0) {
        portfolioSeries.push({ date: toDateStr(ts), value: total });
      }
    }

    return res.status(200).json({
      portfolio: portfolioSeries,
      nifty:     niftySeries,
    });
  } catch (err) {
    console.error('[historical-prices]', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to fetch historical prices',
    });
  }
}
