/**
 * Computes the structural difference between two portfolio snapshots.
 */

export type PortfolioChangeType = 'added' | 'removed' | 'increased' | 'decreased' | 'goal_set';

export interface PortfolioChange {
  type:            PortfolioChangeType;
  stockName:       string;
  ticker:          string;
  previousShares?: number;
  newShares?:      number;
  previousWeight?: number;
  newWeight?:      number;
}

interface MinimalHolding {
  ticker:    string;
  name:      string;
  shares:    number;
  weight?:   number;
}

/**
 * Compare two holdings arrays and return a list of changes.
 * Weights are optional — pass them when available for richer diffs.
 */
export function diffPortfolios(
  previous: MinimalHolding[],
  current:  MinimalHolding[],
): PortfolioChange[] {
  const changes: PortfolioChange[] = [];

  const prevMap = new Map(previous.map((h) => [h.ticker, h]));
  const currMap = new Map(current.map((h) => [h.ticker, h]));

  // Removed holdings
  for (const [ticker, prev] of prevMap) {
    if (!currMap.has(ticker)) {
      changes.push({
        type:            'removed',
        stockName:       prev.name,
        ticker,
        previousShares:  prev.shares,
        previousWeight:  prev.weight,
      });
    }
  }

  // Added holdings
  for (const [ticker, curr] of currMap) {
    if (!prevMap.has(ticker)) {
      changes.push({
        type:       'added',
        stockName:  curr.name,
        ticker,
        newShares:  curr.shares,
        newWeight:  curr.weight,
      });
    }
  }

  // Changed share counts
  for (const [ticker, curr] of currMap) {
    const prev = prevMap.get(ticker);
    if (!prev) continue;
    if (curr.shares !== prev.shares) {
      changes.push({
        type:            curr.shares > prev.shares ? 'increased' : 'decreased',
        stockName:       curr.name,
        ticker,
        previousShares:  prev.shares,
        newShares:       curr.shares,
        previousWeight:  prev.weight,
        newWeight:       curr.weight,
      });
    }
  }

  return changes;
}

/** Build a human-readable one-liner for each change. */
export function describeChange(c: PortfolioChange): string {
  switch (c.type) {
    case 'added':     return `Added ${c.stockName} (${c.ticker})`;
    case 'removed':   return `Removed ${c.stockName} (${c.ticker})`;
    case 'increased': return `Increased ${c.stockName} (${c.ticker}) from ${c.previousShares} to ${c.newShares} shares`;
    case 'decreased': return `Reduced ${c.stockName} (${c.ticker}) from ${c.previousShares} to ${c.newShares} shares`;
    case 'goal_set':  return `Set new goal: ${c.stockName}`;
  }
}
